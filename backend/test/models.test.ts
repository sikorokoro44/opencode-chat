import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { ModelRegistry, ModelRegistryError, MODELS_FILE, parseModelRegistry } from "../src/models/registry.ts";
import { ProviderClient } from "../src/models/provider.ts";
import { streamCompletion } from "../src/models/completion.ts";
import { AllModelsFailedError, ProviderError } from "../src/models/errors.ts";
import { nullLogger } from "../src/logger.ts";
import { FakeFetch, openAiStreamChunks } from "./fakes.ts";

const raw = readFileSync(MODELS_FILE, "utf8");

function registry(overrides: { failureThreshold?: number; cooldownMs?: number; now?: () => number } = {}): ModelRegistry {
  return new ModelRegistry({ snapshot: parseModelRegistry(raw), ...overrides });
}

test("the shipped registry is valid and puts Big Pickle first", () => {
  const snapshot = parseModelRegistry(raw);
  assert.equal(snapshot.primaryModelId, "big-pickle");
  assert.ok(snapshot.models.length >= 3);
  assert.equal(snapshot.models[0]?.id, "big-pickle");
  assert.equal(snapshot.models[0]?.priority, 0);
  assert.ok(snapshot.models.some((model) => model.fallbackOnly));
});

test("registry rejects a document without the Big Pickle primary model", () => {
  const broken = JSON.parse(raw) as Record<string, unknown>;
  broken["primaryModelId"] = "some-other-model";
  assert.throws(() => parseModelRegistry(JSON.stringify(broken)), /primaryModelId/);

  const noPrimary = JSON.parse(raw) as { models: { id: string }[] };
  noPrimary.models = noPrimary.models.filter((model) => model.id !== "big-pickle");
  assert.throws(() => parseModelRegistry(JSON.stringify(noPrimary)), /missing from the registry/);
});

test("registry rejects unknown providers, capabilities and endpoints", () => {
  const mutate = (fn: (doc: Record<string, unknown>) => void): void => {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    fn(doc);
    assert.throws(() => parseModelRegistry(JSON.stringify(doc)), ModelRegistryError);
  };
  mutate((doc) => {
    (doc["models"] as Record<string, unknown>[])[0]!["provider"] = "skynet";
  });
  mutate((doc) => {
    (doc["models"] as Record<string, unknown>[])[0]!["capabilities"] = ["telepathy"];
  });
  mutate((doc) => {
    (doc["models"] as Record<string, unknown>[])[0]!["endpoint"] = "https://evil.example/v1";
  });
  mutate((doc) => {
    (doc["models"] as Record<string, unknown>[])[0]!["contextWindow"] = 8;
  });
  mutate((doc) => {
    doc["maxFallbackDepth"] = 99;
  });
});

test("registry rejects duplicates and a primary that is not priority 0", () => {
  const duplicated = JSON.parse(raw) as Record<string, unknown>;
  const models = duplicated["models"] as Record<string, unknown>[];
  duplicated["models"] = [...models, { ...models[1] }];
  assert.throws(() => parseModelRegistry(JSON.stringify(duplicated)), /duplicate model id/);

  const wrongPriority = JSON.parse(raw) as Record<string, unknown>;
  (wrongPriority["models"] as Record<string, unknown>[])[0]!["priority"] = 4;
  assert.throws(() => parseModelRegistry(JSON.stringify(wrongPriority)), /priority 0/);
});

test("registry rejects invalid JSON and non-objects", () => {
  assert.throws(() => parseModelRegistry("{not json"), /not valid JSON/);
  assert.throws(() => parseModelRegistry("[]"), /JSON object/);
});

test("candidate chain starts at Big Pickle and appends healthy fallbacks", () => {
  const reg = registry();
  const chain = reg.candidates().map((model) => model.id);
  assert.equal(chain[0], "big-pickle");
  assert.ok(chain.length >= 2);
  // Fallback-only models never lead the chain.
  for (const model of reg.all().filter((entry) => entry.fallbackOnly)) {
    assert.ok(chain.indexOf(model.id) > 0);
  }
});

test("an explicit model request is honoured ahead of the primary", () => {
  const reg = registry();
  const requested = reg.selectable().find((model) => model.id !== "big-pickle");
  assert.ok(requested);
  const chain = reg.candidates(requested.id).map((model) => model.id);
  assert.equal(chain[0], requested.id);
  assert.equal(chain[1], "big-pickle");
});

test("an unhealthy explicit model is skipped in favour of the primary", () => {
  const reg = registry({ failureThreshold: 1, cooldownMs: 60_000 });
  const requested = reg.selectable().find((model) => model.id !== "big-pickle");
  assert.ok(requested);
  reg.recordFailure(requested.id);
  assert.equal(reg.health(requested.id).healthy, false);
  const chain = reg.candidates(requested.id).map((model) => model.id);
  assert.equal(chain[0], "big-pickle");
  assert.ok(!chain.includes(requested.id));
});

test("repeated failures trip a cooldown that expires and clears the failures", () => {
  let now = 1_000;
  const reg = registry({ failureThreshold: 2, cooldownMs: 500, now: () => now });
  reg.recordFailure("big-pickle");
  assert.equal(reg.health("big-pickle").healthy, true, "one failure is not enough");
  reg.recordFailure("big-pickle");
  assert.equal(reg.health("big-pickle").healthy, false);
  assert.equal(reg.health("big-pickle").cooldownSeconds, 1);

  now += 600;
  assert.equal(reg.health("big-pickle").healthy, true);

  reg.recordFailure("big-pickle");
  reg.recordSuccess("big-pickle");
  assert.equal(reg.health("big-pickle").healthy, true);
  assert.equal(reg.health("big-pickle").failures, 0);
});

test("an unknown model id can never be served", () => {
  const reg = registry();
  assert.throws(() => reg.require("gpt-4o"), /allow-list/);
  assert.equal(reg.find("gpt-4o"), undefined);
  assert.equal(reg.supports("big-pickle", "vision"), true);
});

test("publicInfo exposes health without leaking provider configuration", () => {
  const info = registry().publicInfo();
  const primary = info.find((model) => model.id === "big-pickle");
  assert.ok(primary);
  assert.equal(primary.healthy, true);
  assert.equal(Object.keys(primary).includes("endpoint"), false);
  assert.equal(Object.keys(primary).includes("apiKey"), false);
});

interface StubOptions {
  fetchImpl: typeof fetch;
  modelId?: string;
}

async function completeWithStub(reg: ModelRegistry, fetchImpl: typeof fetch, modelId?: string) {
  const provider = new ProviderClient({ fetchImpl });
  const chunks: string[] = [];
  const fallbackChain: string[] = [];
  const result = await streamCompletion(
    {
      registry: reg,
      provider,
      logger: nullLogger,
      baseUrlFor: () => "https://provider.test/v1",
      apiKeyFor: () => "server-side-key",
      timeoutMs: 2_000,
      signal: AbortSignal.timeout(10_000),
    },
    {
      messages: [{ role: "user", content: "hello" }],
      ...(modelId === undefined ? {} : { requestedModelId: modelId }),
      onStart: (active) => fallbackChain.push(active),
      onDelta: (text) => {
        chunks.push(text);
      },
    },
  );
  return { result, text: chunks.join(""), fallbackChain };
}

test("streamCompletion streams deltas from Big Pickle without falling back", async () => {
  const fake = new FakeFetch().on("provider.test", { chunks: openAiStreamChunks(["Hel", "lo ", "there"]) });
  const { result, text, fallbackChain } = await completeWithStub(registry(), fake.fetch);
  assert.equal(text, "Hello there");
  assert.equal(result.modelId, "big-pickle");
  assert.equal(result.fallbackDepth, 0);
  assert.deepEqual(fallbackChain, ["big-pickle"]);
});

test("provider credentials are sent as a bearer header and never in the URL", async () => {
  const fake = new FakeFetch().on("provider.test", { chunks: openAiStreamChunks(["ok"]) });
  await completeWithStub(registry(), fake.fetch);
  const recorded = fake.lastRequest("provider.test");
  assert.equal(recorded?.headers["authorization"], "Bearer server-side-key");
  assert.ok(!(recorded?.url ?? "").includes("server-side-key"));
});

test("a rate-limited primary transparently falls back to the next free model", async () => {
  const fake = new FakeFetch();
  fake.onModel("big-pickle", { status: 429, body: '{"error":{"message":"slow down"}}' });
  fake.onAny({ chunks: openAiStreamChunks(["fallback ", "answer"]) });

  const { result, text } = await completeWithStub(registry(), fake.fetch);
  assert.equal(text, "fallback answer");
  assert.notEqual(result.modelId, "big-pickle");
  assert.equal(result.fallbackDepth, 1);
  // The chain records the models that actually produced output.
  assert.deepEqual(result.fallbackChain, [result.modelId]);
  assert.equal(fake.countFor("big-pickle"), 1);
  assert.ok(fake.requests.length >= 2, "the failed primary attempt is still recorded");
});

test("a mid-response failure continues on a fallback and marks the seam", async () => {
  const fake = new FakeFetch();
  fake.onModel("big-pickle", {
    // The primary starts answering, then the connection dies before [DONE].
    chunks: [
      { text: 'data: {"choices":[{"delta":{"content":"Partial "}}]}\n\n' },
      // The delay lets the consumer drain the queued delta before the stream dies:
      // `ReadableStreamDefaultController.error()` discards anything still queued.
      { error: "socket hang up", delayMs: 20 },
    ],
  });
  fake.onAny({ chunks: openAiStreamChunks(["rest of it"]) });

  const deltas: string[] = [];
  const fallbackEvents: { from: string; to: string; reason: string }[] = [];
  const provider = new ProviderClient({ fetchImpl: fake.fetch });
  const reg = registry();
  const result = await streamCompletion(
    {
      registry: reg,
      provider,
      logger: nullLogger,
      baseUrlFor: () => "https://provider.test/v1",
      apiKeyFor: () => undefined,
      timeoutMs: 2_000,
      signal: AbortSignal.timeout(10_000),
    },
    {
      messages: [{ role: "user", content: "hi" }],
      onDelta: (text) => {
        deltas.push(text);
      },
      onFallback: (from, to, reason) => {
        fallbackEvents.push({ from, to, reason });
      },
    },
  );

  const text = deltas.join("");
  assert.ok(text.startsWith("Partial "));
  assert.ok(text.endsWith("rest of it"));
  assert.ok(text.includes("continuing on"));
  assert.equal(fallbackEvents.length, 1);
  assert.equal(fallbackEvents[0]?.from, "big-pickle");
  assert.notEqual(fallbackEvents[0]?.to, "big-pickle");
  assert.equal(result.fallbackDepth, 1);
});

test("every free model failing produces a typed, retryable error", async () => {
  const fake = new FakeFetch().onAny({ status: 500, body: "boom" });
  await assert.rejects(
    () => completeWithStub(registry(), fake.fetch),
    (error: unknown) => {
      assert.ok(error instanceof AllModelsFailedError);
      assert.ok(error.attempts.length >= 2);
      assert.ok(error.attempts.every((attempt) => attempt.modelId !== undefined));
      return true;
    },
  );
});

test("an empty provider stream counts as a failure and triggers fallback", async () => {
  const fake = new FakeFetch();
  fake.onModel("big-pickle", { chunks: [{ text: "data: [DONE]\n\n" }] });
  fake.onAny({ chunks: openAiStreamChunks(["real output"]) });
  const { result } = await completeWithStub(registry(), fake.fetch);
  assert.notEqual(result.modelId, "big-pickle");
});

test("usage reported by the provider is carried through to the result", async () => {
  const fake = new FakeFetch().on("provider.test", {
    chunks: openAiStreamChunks(["hi"], { usage: { prompt: 11, completion: 3 } }),
  });
  const { result } = await completeWithStub(registry(), fake.fetch);
  assert.equal(result.usage.promptTokens, 11);
  assert.equal(result.usage.completionTokens, 3);
  assert.equal(result.usage.totalTokens, 14);
  assert.equal(result.finishReason, "stop");
});

test("a provider HTTP error becomes a retryable ProviderError", async () => {
  const provider = new ProviderClient({ fetchImpl: new FakeFetch().onAny({ status: 503 }).fetch });
  await assert.rejects(
    () =>
      provider.complete({
        model: registry().require("big-pickle"),
        messages: [{ role: "user", content: "hi" }],
        baseUrl: "https://provider.test/v1",
        signal: AbortSignal.timeout(5_000),
        timeoutMs: 1_000,
        maxOutputTokens: 100,
        stream: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "provider_http_503");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("a provider 400 is treated as non-retryable but still surfaces the model id", async () => {
  const provider = new ProviderClient({ fetchImpl: new FakeFetch().onAny({ status: 400 }).fetch });
  await assert.rejects(
    () =>
      provider.complete({
        model: registry().require("big-pickle"),
        messages: [],
        baseUrl: "https://provider.test/v1",
        signal: AbortSignal.timeout(5_000),
        timeoutMs: 1_000,
        maxOutputTokens: 10,
        stream: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "provider_http_400");
      assert.equal(error.retryable, false);
      assert.ok(error.message.includes("big-pickle"));
      return true;
    },
  );
});

test("a non-streaming completion extracts content, usage and tool calls", async () => {
  const fake = new FakeFetch().onAny({
    body: JSON.stringify({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.kt"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }),
  });
  const provider = new ProviderClient({ fetchImpl: fake.fetch });
  const result = await provider.complete({
    model: registry().require("big-pickle"),
    messages: [],
    baseUrl: "https://provider.test/v1",
    signal: AbortSignal.timeout(5_000),
    timeoutMs: 1_000,
    maxOutputTokens: 100,
    stream: false,
    tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
    toolChoice: "auto",
  });
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.toolCalls[0]?.name, "read_file");
  assert.equal(result.toolCalls[0]?.arguments, '{"path":"a.kt"}');
  const body = fake.lastRequest("provider.test")?.body as Record<string, unknown>;
  assert.ok(Array.isArray(body["tools"]));
  assert.equal(body["tool_choice"], "auto");
});

test("tool-call arguments streamed in fragments are reassembled", async () => {
  const fake = new FakeFetch().onAny({
    chunks: [
      {
        text:
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
      },
      { text: 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a\\"}"}}]}}]}\n\n' },
      { text: 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' },
      { text: "data: [DONE]\n\n" },
    ],
  });
  const provider = new ProviderClient({ fetchImpl: fake.fetch });
  const events: unknown[] = [];
  for await (const event of provider.stream({
    model: registry().require("big-pickle"),
    messages: [],
    baseUrl: "https://provider.test/v1",
    signal: AbortSignal.timeout(5_000),
    timeoutMs: 1_000,
    maxOutputTokens: 100,
    stream: true,
  })) {
    events.push(event);
  }
  const done = events[events.length - 1] as { toolCalls: { name: string; arguments: string }[] };
  assert.equal(done.toolCalls[0]?.name, "read_file");
  assert.equal(done.toolCalls[0]?.arguments, '{"path":"a"}');
});

test("an in-stream provider error is reported as a ProviderError", async () => {
  const fake = new FakeFetch().onAny({
    chunks: [{ text: 'data: {"error":{"message":"model overloaded"}}\n\n' }],
  });
  const provider = new ProviderClient({ fetchImpl: fake.fetch });
  await assert.rejects(
    async () => {
      for await (const _event of provider.stream({
        model: registry().require("big-pickle"),
        messages: [],
        baseUrl: "https://provider.test/v1",
        signal: AbortSignal.timeout(5_000),
        timeoutMs: 1_000,
        maxOutputTokens: 10,
        stream: true,
      })) {
        void _event;
      }
    },
    (error: unknown) => error instanceof ProviderError,
  );
});

test("aborting a stream stops delivery and reports cancellation", async () => {
  const fake = new FakeFetch().onAny({
    chunks: [
      { text: 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' },
      { text: 'data: {"choices":[{"delta":{"content":"b"}}]}\n\n', delayMs: 300 },
      { text: 'data: {"choices":[{"delta":{"content":"c"}}]}\n\n', delayMs: 300 },
    ],
  });
  const provider = new ProviderClient({ fetchImpl: fake.fetch });
  const controller = new AbortController();
  const deltas: string[] = [];
  await assert.rejects(
    async () => {
      for await (const event of provider.stream({
        model: registry().require("big-pickle"),
        messages: [],
        baseUrl: "https://provider.test/v1",
        signal: controller.signal,
        timeoutMs: 5_000,
        maxOutputTokens: 10,
        stream: true,
      })) {
        if (event.type === "delta") {
          deltas.push(event.text);
          controller.abort();
        }
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "cancelled");
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(deltas.length, 1, "the consumer sees the first delta and then nothing more");
});

test("streamCompletion surfaces cancellation as a non-retryable ProviderError", async () => {
  const fake = new FakeFetch().onAny({
    chunks: [
      { text: 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' },
      { text: 'data: {"choices":[{"delta":{"content":"b"}}]}\n\n', delayMs: 200 },
    ],
  });
  const provider = new ProviderClient({ fetchImpl: fake.fetch });
  const controller = new AbortController();
  await assert.rejects(
    () =>
      streamCompletion(
        {
          registry: registry(),
          provider,
          logger: nullLogger,
          baseUrlFor: () => "https://provider.test/v1",
          apiKeyFor: () => undefined,
          timeoutMs: 5_000,
          signal: controller.signal,
        },
        {
          messages: [{ role: "user", content: "hi" }],
          onDelta: () => {
            controller.abort();
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "cancelled");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});
