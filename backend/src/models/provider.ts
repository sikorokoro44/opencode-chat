/**
 * OpenAI-compatible provider client.
 *
 * Speaks plain `fetch` + the SSE frame parser so that streaming works identically
 * for every free provider and so tests can drive it with a local HTTP server.
 * Provider credentials are only ever read from server configuration.
 */

import { SseParser, parseOpenAiChunk } from "../http/sse-parser.ts";
import { ProviderError } from "./errors.ts";
import type { RegistryModel } from "./registry.ts";
import type { Usage } from "../api/types.ts";

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  /** Assistant tool calls, echoed back to the provider on the next turn. */
  toolCalls?: { id: string; name: string; arguments: string }[];
  /** For `role: "tool"`: the id of the call this result answers. */
  toolCallId?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  imageUrl?: { url: string };
}

export interface ProviderRequest {
  model: RegistryModel;
  messages: ProviderMessage[];
  baseUrl: string;
  apiKey?: string;
  maxOutputTokens: number;
  temperature?: number;
  signal: AbortSignal;
  timeoutMs: number;
  /** Provider-reported usage is optional; many free endpoints omit it. */
  stream: boolean;
  /** OpenAI-compatible function-calling declarations (agent mode). */
  tools?: Record<string, unknown>[];
  toolChoice?: "auto" | "none" | "required";
}

export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the provider; parsed by the agent. */
  arguments: string;
}

export type ProviderEvent =
  | { type: "delta"; text: string }
  | { type: "done"; finishReason: string | null; usage: ProviderUsage; toolCalls: ToolCall[] };

export interface ProviderResult {
  text: string;
  finishReason: string | null;
  usage: ProviderUsage;
  toolCalls: ToolCall[];
}

export type ProviderFrameEvent =
  | { type: "delta"; text: string }
  | { type: "toolCalls"; toolCalls: RawToolCallDelta[] }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "done"; finishReason: string | null }
  | { type: "noop" };

export interface RawToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argsDelta?: string;
}

export interface ProviderClientOptions {
  fetchImpl?: typeof fetch;
  /** Called with request metadata for observability; never receives the API key. */
  onRequest?: (info: { modelId: string; provider: string; attempt: number }) => void;
}

export class ProviderClient {
  private readonly fetchImpl: typeof fetch;
  private readonly onRequest: ProviderClientOptions["onRequest"];

  constructor(options: ProviderClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onRequest = options.onRequest;
  }

  /** Yields text deltas as they arrive from the provider. */
  async *stream(request: ProviderRequest, attempt = 1): AsyncGenerator<ProviderEvent> {
    this.onRequest?.({ modelId: request.model.id, provider: request.model.provider, attempt });

    const response = await this.send(request, true);
    const body = response.body;
    if (!body) {
      throw new ProviderError("provider_returned_empty_body", 502, request.model.id, true);
    }

    const parser = new SseParser();
    const decoder = new TextDecoder();
    let text = "";
    let finishReason: string | null = null;
    const usage: ProviderUsage = {};
    const toolCalls = new Map<number, ToolCall>();

    const reader = body.getReader();
    const abortHandler = () => {
      void reader.cancel().catch(() => undefined);
    };
    request.signal.addEventListener("abort", abortHandler, { once: true });

    try {
      const self = this;
      function* consume(frames: { data: string }[]): Generator<ProviderEvent> {
        for (const frame of frames) {
          const event = self.handleFrame(frame, request.model.id);
          switch (event.type) {
            case "delta":
              text += event.text;
              yield event;
              break;
            case "toolCalls":
              for (const delta of event.toolCalls) mergeToolCall(toolCalls, delta);
              break;
            case "usage":
              Object.assign(usage, event.usage);
              break;
            case "done":
              if (event.finishReason) finishReason = event.finishReason;
              break;
            default:
              break;
          }
        }
      }

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        yield* consume(parser.push(decoder.decode(value, { stream: true })));
      }
      yield* consume(parser.flush());
      if (request.signal.aborted) {
        // The consumer hung up (client disconnect or cancelled chat): surface it
        // explicitly so the caller neither falls back nor retries.
        throw new ProviderError("cancelled", 499, request.model.id, false, "stream cancelled by client");
      }
    } finally {
      request.signal.removeEventListener("abort", abortHandler);
      reader.releaseLock?.();
    }

    yield { type: "done", finishReason, usage, toolCalls: [...toolCalls.values()] };
  }

  /** Non-streaming variant used by tests and by the non-streaming endpoint. */
  async complete(request: ProviderRequest): Promise<ProviderResult> {
    this.onRequest?.({ modelId: request.model.id, provider: request.model.provider, attempt: 1 });
    const response = await this.send(request, false);
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderError("provider_returned_invalid_json", 502, request.model.id, true);
    }
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const choices = record["choices"];
    const message =
      Array.isArray(choices) && choices.length > 0
        ? ((choices[0] as Record<string, unknown>)["message"] as Record<string, unknown> | undefined)
        : undefined;
    const content = message?.["content"];
    if (typeof content !== "string") {
      throw new ProviderError("provider_returned_no_content", 502, request.model.id, true);
    }
    const rawUsage = record["usage"];
    const usage: ProviderUsage =
      typeof rawUsage === "object" && rawUsage !== null
        ? toUsage(rawUsage as Record<string, unknown>)
        : {};
    const finishReason =
      Array.isArray(choices) && choices.length > 0
        ? ((choices[0] as Record<string, unknown>)["finish_reason"] as string | null) ?? null
        : null;
    const toolCalls = normaliseToolCalls(
      Array.isArray(message?.["tool_calls"]) ? (message["tool_calls"] as unknown[]) : [],
    );
    return { text: content, finishReason, usage, toolCalls };
  }

  private handleFrame(frame: { data: string }, modelId: string): ProviderFrameEvent {
    if (frame.data === "" || frame.data === "[DONE]") {
      return { type: "done", finishReason: null };
    }
    let json: unknown;
    try {
      json = JSON.parse(frame.data);
    } catch {
      return { type: "noop" };
    }
    if (typeof json === "object" && json !== null && typeof (json as Record<string, unknown>)["error"] === "object") {
      const error = (json as Record<string, unknown>)["error"] as Record<string, unknown>;
      throw new ProviderError(
        typeof error["message"] === "string" ? "provider_error" : "provider_error",
        502,
        modelId,
        true,
        typeof error["message"] === "string" ? error["message"] : "provider returned an error",
      );
    }
    const chunk = parseOpenAiChunk(json);
    if (chunk.toolCalls && chunk.toolCalls.length > 0) return { type: "toolCalls", toolCalls: chunk.toolCalls };
    if (chunk.text !== undefined && chunk.text !== "") return { type: "delta", text: chunk.text };
    if (chunk.finishReason) return { type: "done", finishReason: chunk.finishReason };
    if (chunk.promptTokens !== undefined || chunk.completionTokens !== undefined) {
      return { type: "usage", usage: toUsage({ prompt_tokens: chunk.promptTokens, completion_tokens: chunk.completionTokens }) };
    }
    return { type: "noop" };
  }

  private async send(request: ProviderRequest, stream: boolean): Promise<Response> {
    const url = `${trimTrailingSlash(request.baseUrl)}${request.model.endpoint}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "user-agent": "opencode-chat-backend/1.0",
    };
    if (request.apiKey) {
      headers["authorization"] = `Bearer ${request.apiKey}`;
    }

    const body = {
      model: request.model.id,
      messages: request.messages.map(toWireMessage),
      max_tokens: request.maxOutputTokens,
      stream,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(request.toolChoice && (request.tools && request.tools.length > 0) ? { tool_choice: request.toolChoice } : {}),
    };

    const timeout = AbortSignal.timeout(request.timeoutMs);
    const combined = AbortSignal.any([request.signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      if (request.signal.aborted) {
        throw new ProviderError("cancelled", 499, request.model.id, false, String((error as Error)?.message ?? error));
      }
      const code = (error as { name?: string }).name;
      throw new ProviderError(
        code === "TimeoutError" || code === "AbortError" ? "provider_timeout" : "provider_unreachable",
        504,
        request.model.id,
        true,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(
        response.status === 429 ? "provider_rate_limited" : `provider_http_${response.status}`,
        response.status,
        request.model.id,
        retryable,
      );
    }
    return response;
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toWireMessage(message: ProviderMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content as unknown };
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    wire["tool_calls"] = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
    // OpenAI-compatible APIs reject an assistant turn that has neither content
    // nor tool_calls; when the turn was tool-only the content must be null.
    if (message.content === "") wire["content"] = null;
  }
  if (message.role === "tool" && message.toolCallId !== undefined) {
    wire["tool_call_id"] = message.toolCallId;
  }
  return wire;
}

function toUsage(record: { prompt_tokens?: unknown; completion_tokens?: unknown }): ProviderUsage {
  const prompt = typeof record.prompt_tokens === "number" ? record.prompt_tokens : undefined;
  const completion = typeof record.completion_tokens === "number" ? record.completion_tokens : undefined;
  const usage: ProviderUsage = {};
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (completion !== undefined) usage.completionTokens = completion;
  if (prompt !== undefined || completion !== undefined) {
    usage.totalTokens = (prompt ?? 0) + (completion ?? 0);
  }
  return usage;
}

export const emptyUsage = (): Usage => ({});

function mergeToolCall(into: Map<number, ToolCall>, delta: RawToolCallDelta): void {
  const existing = into.get(delta.index) ?? { id: "", name: "", arguments: "" };
  if (delta.id !== undefined) existing.id = delta.id;
  if (delta.name !== undefined) existing.name = delta.name;
  if (delta.argsDelta !== undefined) existing.arguments += delta.argsDelta;
  into.set(delta.index, existing);
}

function normaliseToolCalls(calls: unknown[]): ToolCall[] {
  const out: ToolCall[] = [];
  calls.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const record = entry as Record<string, unknown>;
    const fn = typeof record["function"] === "object" && record["function"] !== null
      ? (record["function"] as Record<string, unknown>)
      : {};
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (name === "") return;
    out.push({
      id: typeof record["id"] === "string" ? record["id"] : `call_${index}`,
      name,
      arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : "",
    });
  });
  return out;
}
