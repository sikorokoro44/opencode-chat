/**
 * Scriptable fake `fetch` for provider and GitHub tests.
 *
 * Responses are queued per URL prefix; every request is recorded so tests can
 * assert on headers (including that credentials are sent) and on request bodies.
 */

import { ReadableStream } from "node:stream/web";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /**
   * Streams the body in chunks with optional delays, for SSE tests. A chunk may
   * carry `error` to simulate a connection that dies mid-response.
   */
  chunks?: { text?: string; delayMs?: number; error?: string }[];
}

type Handler = (request: RecordedRequest, index: number) => FakeResponse | Promise<FakeResponse>;

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly handlers = new Map<string, Handler>();
  private fallback: Handler | undefined;

  /** Registers a handler for URLs containing `match`. Later registrations win. */
  on(match: string, handler: Handler | FakeResponse): this {
    this.handlers.set(match, typeof handler === "function" ? handler : () => handler);
    return this;
  }

  onAny(handler: Handler | FakeResponse): this {
    this.fallback = typeof handler === "function" ? handler : () => handler;
    return this;
  }

  /**
   * Routes by the `model` field of the JSON request body. Provider URLs are
   * identical for every model, so the model id can only be matched in the body.
   */
  onModel(modelId: string, handler: Handler | FakeResponse): this {
    const wrapped: Handler = (request, index) => {
      const body = request.body as { model?: string } | undefined;
      if (body?.model !== modelId) {
        return { status: 404, body: JSON.stringify({ error: { message: `unhandled model ${body?.model ?? "none"}` } }) };
      }
      return typeof handler === "function" ? handler(request, index) : handler;
    };
    this.handlers.set(`model:${modelId}`, wrapped);
    return this;
  }

  /**
   * Counts requests matching `match`, which is either a URL fragment or a model
   * id (`model:` prefix omitted for readability — model ids are matched directly).
   */
  countFor(match: string): number {
    return this.requests.filter((entry) => matches(entry, match)).length;
  }

  lastRequest(match: string): RecordedRequest | undefined {
    return [...this.requests].reverse().find((entry) => matches(entry, match));
  }

  readonly fetch: typeof fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const recorded: RecordedRequest = { url, method, headers, body };
    this.requests.push(recorded);

    let handler: Handler | undefined;
    for (const [match, candidate] of this.handlers) {
      if (match.startsWith("model:")) {
        // Model-scoped handlers always win over URL-scoped ones.
        const body = recorded.body as { model?: string } | undefined;
        if (body?.model === match.slice("model:".length)) handler = candidate;
      } else if (url.includes(match)) {
        handler = candidate;
      }
    }
    handler ??= this.fallback;
    if (!handler) {
      return new Response(JSON.stringify({ error: { message: `no fake handler for ${url}` } }), { status: 501 });
    }

    const result = await handler(recorded, this.requests.length - 1);
    const status = result.status ?? 200;
    const responseHeaders = new Headers(result.headers ?? {});
    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", result.chunks ? "text/event-stream" : "application/json");
    }

    if (result.chunks) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of result.chunks ?? []) {
            if (chunk.delayMs) await sleep(chunk.delayMs);
            if (chunk.error !== undefined) {
              controller.error(new Error(chunk.error));
              return;
            }
            controller.enqueue(encoder.encode(chunk.text ?? ""));
          }
          controller.close();
        },
      });
      return new Response(stream, { status, headers: responseHeaders });
    }

    const bodyless = status === 204 || status === 304;
    return new Response(bodyless ? null : result.body ?? "", { status, headers: responseHeaders });
  };
}

/** A request matches a URL fragment or, when `match` is a known model id, the body's `model`. */
function matches(entry: RecordedRequest, match: string): boolean {
  if (entry.url.includes(match)) return true;
  const body = entry.body as { model?: unknown } | undefined;
  return typeof body?.model === "string" && body.model === match;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds an OpenAI-compatible SSE stream that emits the given token chunks. */
export function openAiStreamChunks(tokens: string[], options: { usage?: { prompt: number; completion: number }; finishReason?: string } = {}): {
  text: string;
  delayMs?: number;
}[] {
  const chunks: { text: string; delayMs?: number }[] = tokens.map((token, index) => ({
    text: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: token } }] })}\n\n`,
    delayMs: index === 0 ? 0 : 1,
  }));
  if (options.usage) {
    chunks.push({
      text: `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {} }],
        usage: { prompt_tokens: options.usage.prompt, completion_tokens: options.usage.completion },
      })}\n\n`,
    });
  }
  chunks.push({
    text: `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: options.finishReason ?? "stop" }],
    })}\n\n`,
  });
  chunks.push({ text: "data: [DONE]\n\n" });
  return chunks;
}
