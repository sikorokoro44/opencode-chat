import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { CodingAgent, toolSchemas } from "../src/github/coding-agent.ts";
import { GitHubService } from "../src/github/github-service.ts";
import { SecretStore } from "../src/github/secret-box.ts";
import { ModelRegistry, parseModelRegistry, MODELS_FILE } from "../src/models/registry.ts";
import { nullLogger } from "../src/logger.ts";
import { FakeFetch } from "./fakes.ts";
import type { ProviderClient, ProviderRequest, ProviderResult } from "../src/models/provider.ts";
import type { UserRecord } from "../src/store/records.ts";

const registry = new ModelRegistry({ snapshot: parseModelRegistry(readFileSync(MODELS_FILE, "utf8")) });
const KEY = "a".repeat(64);
const HOST = "api.github.test";

class FakeProvider {
  readonly requests: ProviderRequest[] = [];
  readonly turns: ProviderResult[];

  constructor(turns: ProviderResult[]) {
    this.turns = turns;
  }

  async complete(request: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(request);
    return (
      this.turns.shift() ?? { text: "all done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 }, toolCalls: [] }
    );
  }
}

function result(partial: Partial<ProviderResult> & Pick<ProviderResult, "text">): ProviderResult {
  return { finishReason: "stop", usage: {}, toolCalls: [], ...partial };
}

function user(): UserRecord {
  return {
    id: "usr_1",
    username: "alice",
    usernameLower: "alice",
    passwordHash: "h",
    createdAt: new Date(0).toISOString(),
    disabled: false,
    githubTokenCipher: new SecretStore(KEY).seal("ghp_token_value_1234567890", "usr_1"),
  };
}

function agent(provider: FakeProvider, fetchImpl: typeof fetch, options: { maxSteps?: number } = {}): CodingAgent {
  const github = new GitHubService({
    baseUrl: `https://${HOST}`,
    secretStore: new SecretStore(KEY),
    bootstrapToken: "",
    fetchImpl,
    memoryPath: ".opencode/memory.md",
    timeoutMs: 2_000,
  });
  return new CodingAgent({
    registry,
    provider: provider as unknown as ProviderClient,
    github,
    logger: nullLogger,
    baseUrlFor: () => `https://${HOST}/v1`,
    apiKeyFor: () => undefined,
    timeoutMs: 5_000,
    now: () => 0,
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
  });
}

const context = { user: user(), owner: "octo", repo: "repo", ref: "main", allowWrites: false };

test("toolSchemas exposes read tools always and write tools only when allowed", () => {
  const read = toolSchemas(false).map((tool) => (tool.function as { name: string }).name);
  assert.deepEqual(read, ["list_dir", "read_file", "search"]);
  const write = toolSchemas(true).map((tool) => (tool.function as { name: string }).name);
  assert.ok(write.includes("propose_changes"));
});

test("a model without tool support answers directly from the conversation", async () => {
  const noTools = registry.all().find((model) => !model.capabilities.includes("tools"));
  assert.ok(noTools, "fixture must contain a tool-less model");
  const provider = new FakeProvider([result({ text: "Here is what I know." })]);
  const chunks: string[] = [];
  const run = await agent(provider, new FakeFetch().fetch).run({
    modelId: noTools.id,
    messages: [{ role: "user", content: "hi" }],
    tools: { ...context },
    signal: AbortSignal.timeout(5_000),
    onDelta: (text) => void chunks.push(text),
  });
  assert.equal(run.text, "Here is what I know.");
  assert.deepEqual(run.actions, []);
  assert.equal(provider.requests[0]?.tools, undefined, "no tools offered without tool support");
});

test("the agent executes a read tool and feeds the result back to the model", async () => {
  const listing = [
    { path: "src/Main.kt", name: "Main.kt", type: "file", size: 3, sha: "1" },
    { path: "src/util", name: "util", type: "dir", size: 0, sha: "2" },
  ];
  const fake = new FakeFetch().on(HOST, { body: JSON.stringify(listing) });
  const provider = new FakeProvider([
    result({
      text: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "list_dir", arguments: '{"path":"src"}' }],
    }),
    result({ text: "There are two entries." }),
  ]);

  const chunks: string[] = [];
  const run = await agent(provider, fake.fetch).run({
    modelId: "big-pickle",
    messages: [{ role: "user", content: "what is in src?" }],
    tools: { ...context },
    signal: AbortSignal.timeout(5_000),
    onDelta: (text) => void chunks.push(text),
  });

  assert.equal(run.steps, 1);
  assert.equal(run.text, "There are two entries.");
  assert.ok(run.actions.some((action) => action.type === "list_dir" && action.status === "ok"));
  assert.equal(fake.requests.length, 1, "the GitHub contents API was queried once");

  // The second model turn must carry the assistant tool call and the tool result
  // with a matching id, otherwise OpenAI-compatible providers reject the turn.
  const followUp = provider.requests[1]?.messages ?? [];
  const assistant = followUp.find((message) => message.role === "assistant" && message.toolCalls);
  assert.ok(assistant);
  assert.equal(assistant.toolCalls?.[0]?.id, "call_1");
  const toolMessage = followUp.find((message) => message.role === "tool");
  assert.equal(toolMessage?.toolCallId, "call_1");
  assert.match(String(toolMessage?.content), /Main\.kt/);
});

test("tool-call ids are synthesised when the provider omits them", async () => {
  const fake = new FakeFetch().on(HOST, { body: "{}" });
  const provider = new FakeProvider([
    result({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "", name: "list_dir", arguments: "{}" }] }),
    result({ text: "done" }),
  ]);
  await agent(provider, fake.fetch).run({
    modelId: "big-pickle",
    messages: [{ role: "user", content: "go" }],
    tools: { ...context },
    signal: AbortSignal.timeout(5_000),
    onDelta: () => {},
  });
  const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
  assert.match(String(toolMessage?.toolCallId), /^call_/);
});

test("a path traversal attempt is rejected as a failed tool action", async () => {
  const fake = new FakeFetch();
  const provider = new FakeProvider([
    result({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "read_file", arguments: '{"path":"../../etc/passwd"}' }] }),
    result({ text: "I could not read that." }),
  ]);
  const run = await agent(provider, fake.fetch).run({
    modelId: "big-pickle",
    messages: [{ role: "user", content: "read secrets" }],
    tools: { ...context },
    signal: AbortSignal.timeout(5_000),
    onDelta: () => {},
  });
  assert.ok(run.actions.some((action) => action.status === "failed"));
  assert.equal(fake.requests.length, 0, "GitHub is never asked for a traversing path");
});

test("malformed tool arguments fail without calling GitHub", async () => {
  const fake = new FakeFetch();
  const provider = new FakeProvider([
    result({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "search", arguments: "{not json" }] }),
    result({ text: "sorry" }),
  ]);
  const run = await agent(provider, fake.fetch).run({
    modelId: "big-pickle",
    messages: [{ role: "user", content: "go" }],
    tools: { ...context },
    signal: AbortSignal.timeout(5_000),
    onDelta: () => {},
  });
  assert.ok(run.actions.some((action) => /malformed JSON/.test(action.summary)));
  assert.equal(fake.requests.length, 0);
});

test("unknown tools are refused", async () => {
  const provider = new FakeProvider([
    result({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "delete_everything", arguments: "{}" }] }),
    result({ text: "no" }),
  ]);
  const run = await agent(provider, new FakeFetch().fetch).run({
    modelId: "big-pickle",
    messages: [{ role: "user", content: "go" }],
    tools: { ...context },
    signal: AbortSignal.timeout(5_000),
    onDelta: () => {},
  });
  assert.ok(run.actions.some((action) => /unknown tool/.test(action.summary)));
});

test("propose_changes is rejected in read-only mode and accepted when writes are enabled", async () => {
  const file = { path: "src/a.kt", content: "fun main() {}" };
  const readOnlyProvider = new FakeProvider([
    result({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "propose_changes", arguments: JSON.stringify({ files: [file] }) }] }),
    result({ text: "read only" }),
  ]);
  const readOnly = await agent(readOnlyProvider, new FakeFetch().fetch).run({
    modelId: "big-pickle",
    messages: [{ role: "user", content: "edit" }],
    tools: { ...context, allowWrites: false },
    signal: AbortSignal.timeout(5_000),
    onDelta: () => {},
  });
  assert.ok(readOnly.actions.some((action) => /writes are disabled/.test(action.summary)));

  const writableProvider = new FakeProvider([
    result({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "propose_changes", arguments: JSON.stringify({ files: [file] }) }] }),
    result({ text: "proposed" }),
  ]);
  const writable = await agent(writableProvider, new FakeFetch().fetch).run({
    modelId: "big-pickle",
    messages: [{ role: "user", content: "edit" }],
    tools: { ...context, allowWrites: true },
    signal: AbortSignal.timeout(5_000),
    onDelta: () => {},
  });
  assert.ok(writable.actions.some((action) => action.type === "write_file" && action.status === "ok"));
});

test("the step budget stops a tool-call loop and returns a summary", async () => {
  const alwaysCalling = new FakeProvider([]);
  const fake = new FakeFetch().on(HOST, { body: "{}" });
  // Turn the fake provider into one that always asks for another tool call.
  (alwaysCalling as unknown as { turns: ProviderResult[] }).turns = [];
  const provider = alwaysCalling;
  (provider as unknown as { complete: (request: ProviderRequest) => Promise<ProviderResult> }).complete = async (request) => {
    provider.requests.push(request);
    return result({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "list_dir", arguments: "{}" }] });
  };

  const chunks: string[] = [];
  const run = await agent(provider, fake.fetch, { maxSteps: 3 }).run({
    modelId: "big-pickle",
    messages: [{ role: "user", content: "loop" }],
    tools: { ...context },
    signal: AbortSignal.timeout(5_000),
    onDelta: (text) => void chunks.push(text),
  });
  assert.equal(run.steps, 3);
  assert.ok(run.text.includes("Repository work"), "a tool-only run still yields a summary");
});
