/**
 * Coding agent.
 *
 * A bounded tool-calling loop over the free models:
 *   model -> tool_call -> GitHub operation -> tool result -> model -> ...
 *
 * Safety properties that matter more than cleverness here:
 *  - every tool argument is validated before it reaches GitHub (paths, repo names,
 *    payload sizes, allowed tool names);
 *  - read tools are always available, write tools only when the caller explicitly
 *    enables writes *and* the server holds a GitHub credential;
 *  - the loop is capped by `maxSteps` and by a wall-clock budget, so a confused
 *    model cannot spend unbounded provider quota or GitHub calls;
 *  - every executed step is recorded as an `AgentActionSummary` for the audit trail.
 */

import { assertSafeRepoPath } from "../validate.ts";
import { AllModelsFailedError, ProviderError } from "../models/errors.ts";
import type { ProviderClient, ProviderMessage, ProviderUsage } from "../models/provider.ts";
import type { ModelRegistry, RegistryModel } from "../models/registry.ts";
import type { GitHubService } from "../github/github-service.ts";
import type { AgentActionSummary } from "../api/types.ts";
import type { Logger } from "../logger.ts";
import type { UserRecord } from "../store/records.ts";

export interface AgentToolContext {
  user: UserRecord;
  owner: string;
  repo: string;
  ref: string;
  allowWrites: boolean;
  bootstrapToken?: string;
}

export interface AgentEvent {
  type: "delta" | "action" | "tool";
  text?: string;
  action?: AgentActionSummary;
  tool?: { name: string; ok: boolean; summary: string };
}

export interface CodingAgentOptions {
  registry: ModelRegistry;
  provider: ProviderClient;
  github: GitHubService;
  logger: Logger;
  baseUrlFor: (model: RegistryModel) => string;
  apiKeyFor: (model: RegistryModel) => string | undefined;
  timeoutMs: number;
  maxSteps?: number;
  maxToolOutputChars?: number;
  now?: () => number;
}

export interface AgentRunInput {
  modelId?: string;
  messages: ProviderMessage[];
  tools: AgentToolContext;
  signal: AbortSignal;
  onDelta: (text: string) => void | Promise<void>;
}

export interface AgentRunResult {
  modelId: string;
  text: string;
  actions: AgentActionSummary[];
  steps: number;
  usage: ProviderUsage;
}

const SYSTEM_PROMPT = [
  "You are the opencode-chat coding agent. You help the user understand and change a GitHub repository.",
  "Use the provided tools to read the repository before making claims about it; never invent file contents.",
  "Prefer small, reviewable changes. When you propose an edit, describe exactly which paths change and why.",
  "Answer in Markdown. Reference files as `path/to/file.kt`.",
].join(" ");

export class CodingAgent {
  private readonly registry: ModelRegistry;
  private readonly provider: ProviderClient;
  private readonly github: GitHubService;
  private readonly logger: Logger;
  private readonly baseUrlFor: (model: RegistryModel) => string;
  private readonly apiKeyFor: (model: RegistryModel) => string | undefined;
  private readonly timeoutMs: number;
  private readonly maxSteps: number;
  private readonly maxToolOutputChars: number;
  private readonly now: () => number;

  constructor(options: CodingAgentOptions) {
    this.registry = options.registry;
    this.provider = options.provider;
    this.github = options.github;
    this.logger = options.logger;
    this.baseUrlFor = options.baseUrlFor;
    this.apiKeyFor = options.apiKeyFor;
    this.timeoutMs = options.timeoutMs;
    this.maxSteps = options.maxSteps ?? 6;
    this.maxToolOutputChars = options.maxToolOutputChars ?? 8_000;
    this.now = options.now ?? (() => Date.now());
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = this.now();
    const model = input.modelId ? this.registry.require(input.modelId) : this.registry.require(this.registry.primaryModelId);
    const supportsTools = model.capabilities.includes("tools");

    const messages: ProviderMessage[] = [
      { role: "system", content: this.systemPrompt(input.tools, supportsTools) },
      ...input.messages,
    ];

    const actions: AgentActionSummary[] = [];
    const usage: ProviderUsage = {};
    let text = "";
    let steps = 0;

    if (!supportsTools) {
      // Free models without tool support still get a useful, grounded answer.
      const result = await this.answerWithoutTools(model, messages, input.signal);
      text = result.text;
      Object.assign(usage, result.usage);
      await input.onDelta(text);
      return { modelId: model.id, text, actions, steps, usage };
    }

    for (; steps < this.maxSteps; steps += 1) {
      if (input.signal.aborted) throw new ProviderError("cancelled", 499, model.id, false);
      if (this.now() - startedAt > this.timeoutMs * this.maxSteps) {
        actions.push({
          type: "search",
          summary: "stopped: agent step budget exhausted",
          status: "failed",
        });
        break;
      }

      const turn = await this.provider.complete({
        model,
        messages,
        baseUrl: this.baseUrlFor(model),
        apiKey: this.apiKeyFor(model),
        maxOutputTokens: Math.min(model.maxOutputTokens, 4096),
        signal: input.signal,
        timeoutMs: this.timeoutMs,
        stream: false,
        tools: toolSchemas(input.tools.allowWrites),
        toolChoice: "auto",
      });
      Object.assign(usage, turn.usage);

      if (turn.toolCalls.length === 0) {
        text = turn.text;
        if (text !== "") await input.onDelta(text);
        break;
      }

      const calls = turn.toolCalls.map((call, index) => ({
        ...call,
        // Some free providers omit ids; synthesise a stable one so the tool
        // result can be correlated on the next turn.
        id: call.id === "" ? `call_${steps}_${index}` : call.id,
      }));
      messages.push({ role: "assistant", content: turn.text, toolCalls: calls });
      for (const call of calls) {
        const outcome = await this.executeTool(call.name, call.arguments, input.tools, actions, input.signal);
        messages.push({
          role: "tool",
          content: JSON.stringify(outcome).slice(0, this.maxToolOutputChars),
          toolCallId: call.id,
        });
      }
    }

    if (text === "" && actions.length > 0) {
      // A tool-only run still needs a human-readable summary.
      text = summarize(actions);
      await input.onDelta(text);
    }

    return { modelId: model.id, text, actions, steps, usage };
  }

  private async answerWithoutTools(
    model: RegistryModel,
    messages: ProviderMessage[],
    signal: AbortSignal,
  ): Promise<{ text: string; usage: ProviderUsage }> {
    const result = await this.provider.complete({
      model,
      messages,
      baseUrl: this.baseUrlFor(model),
      apiKey: this.apiKeyFor(model),
      maxOutputTokens: Math.min(model.maxOutputTokens, 2048),
      signal,
      timeoutMs: this.timeoutMs,
      stream: false,
    });
    return { text: result.text, usage: result.usage };
  }

  private systemPrompt(tools: AgentToolContext, supportsTools: boolean): string {
    const lines = [SYSTEM_PROMPT];
    lines.push(`Repository: ${tools.owner}/${tools.repo} (ref \`${tools.ref}\`).`);
    if (!supportsTools) {
      lines.push("You cannot call tools in this mode, so answer from the conversation and ask the user to paste files you need.");
    } else if (tools.allowWrites) {
      lines.push("You may propose edits. The user reviews the diff before anything is written.");
    } else {
      lines.push("You are in read-only mode: use read tools only and never suggest that you changed a file.");
    }
    return lines.join(" ");
  }

  private async executeTool(
    name: string,
    rawArguments: string,
    context: AgentToolContext,
    actions: AgentActionSummary[],
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new ProviderError("cancelled", 499, "agent", false);

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
      args = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return fail(actions, "search", `tool ${name} received malformed JSON arguments`, null);
    }

    try {
      switch (name) {
        case "list_dir": {
          const path = readPath(args, "path");
          const result = await this.github.listContents(context.user, context.owner, context.repo, path, context.ref, context.bootstrapToken);
          actions.push({
            type: "list_dir",
            summary: `listed ${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"} in ${path || "/"}`,
            path,
            repository: `${context.owner}/${context.repo}`,
            status: "ok",
          });
          return {
            ok: true,
            entries: result.entries.slice(0, 200).map((entry) => `${entry.type === "dir" ? "d" : "-"} ${entry.path}`),
          };
        }
        case "read_file": {
          const path = readPath(args, "path", true);
          const file = await this.github.readFile(
            context.user,
            context.owner,
            context.repo,
            path,
            context.ref,
            context.bootstrapToken,
          );
          actions.push({
            type: "read_file",
            summary: `read ${path}`,
            path,
            repository: `${context.owner}/${context.repo}`,
            status: "ok",
          });
          return {
            ok: true,
            path: file.path,
            truncated: file.truncated,
            size: file.size,
            content: file.content.slice(0, this.maxToolOutputChars),
          };
        }
        case "search": {
          const query = typeof args["query"] === "string" ? (args["query"] as string).slice(0, 256) : "";
          if (query === "") return fail(actions, "search", "search requires a query", null);
          const hits = await this.github.search(context.user, context.owner, context.repo, query, context.bootstrapToken);
          actions.push({
            type: "search",
            summary: `searched for "${query}" (${hits.length} hit${hits.length === 1 ? "" : "s"})`,
            repository: `${context.owner}/${context.repo}`,
            status: "ok",
          });
          return { ok: true, paths: hits.slice(0, 50).map((hit) => hit.path) };
        }
        case "propose_changes": {
          if (!context.allowWrites) {
            return fail(actions, "write_file", "writes are disabled for this session", null);
          }
          const files = parseFiles(args["files"]);
          if (files.length === 0) {
            return fail(actions, "write_file", "propose_changes requires a non-empty files array", null);
          }
          const summary = typeof args["summary"] === "string" ? (args["summary"] as string).slice(0, 400) : "";
          actions.push({
            type: "write_file",
            summary: `proposed ${files.length} file change${files.length === 1 ? "" : "s"}${summary === "" ? "" : `: ${summary}`}`,
            repository: `${context.owner}/${context.repo}`,
            branch: context.ref,
            status: "ok",
          });
          // Proposed changes are surfaced to the user; nothing is written by the model.
          return {
            ok: true,
            proposed: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8") })),
            note: "Proposals shown to the user. Apply them from the Changes panel to commit.",
          };
        }
        default:
          return fail(actions, "search", `unknown tool ${name}`, null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : "tool execution failed";
      return fail(actions, "search", `tool ${name} failed: ${message}`, null);
    }
  }
}

function fail(actions: AgentActionSummary[], type: AgentActionSummary["type"], summary: string, path: string | null): Record<string, unknown> {
  actions.push({ type, summary, path, status: "failed" });
  return { ok: false, error: summary };
}

function readPath(args: Record<string, unknown>, key: string, required = false): string {
  const raw = args[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    if (required) throw new Error(`${key} is required`);
    return "";
  }
  return assertSafeRepoPath(raw.trim());
}

function parseFiles(value: unknown): { path: string; content: string }[] {
  if (!Array.isArray(value)) return [];
  const files: { path: string; content: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record["path"] === "string" ? assertSafeRepoPath(record["path"]) : "";
    const content = typeof record["content"] === "string" ? record["content"] : "";
    if (path === "" || content === "") continue;
    if (Buffer.byteLength(content, "utf8") > 200_000) continue;
    files.push({ path, content });
    if (files.length >= 20) break;
  }
  return files;
}

function summarize(actions: AgentActionSummary[]): string {
  const lines = actions.map((action) => `- ${action.status === "ok" ? "✅" : "❌"} ${action.summary}`);
  return `## Repository work\n\n${lines.join("\n")}`;
}

/** OpenAI-compatible tool declarations. */
export function toolSchemas(allowWrites: boolean): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files and directories at a repository-relative path.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory path; empty string means the root." } },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file from the repository.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File path relative to the repository root." } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search",
        description: "Search the repository for code matching a query.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
  ];

  if (allowWrites) {
    tools.push({
      type: "function",
      function: {
        name: "propose_changes",
        description: "Propose file edits for the user to review. Does not write to the repository.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string" },
            files: {
              type: "array",
              items: {
                type: "object",
                properties: { path: { type: "string" }, content: { type: "string" } },
                required: ["path", "content"],
              },
            },
          },
          required: ["files"],
        },
      },
    });
  }

  return tools;
}

export { AllModelsFailedError };
