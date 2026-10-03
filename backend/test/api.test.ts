/**
 * End-to-end HTTP integration tests: the real `http.Server`, real router,
 * auth, persistence and SSE streaming, with only outbound `fetch` faked.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TINY_PNG_BASE64,
  readSse,
  registerAccount,
  request,
  startTestApp,
  type TestConfigOverrides,
} from "./helpers.ts";
import { FakeFetch, openAiStreamChunks } from "./fakes.ts";

interface Harness {
  baseUrl: string;
  fake: FakeFetch;
  close(): Promise<void>;
  cleanup(): Promise<void>;
}

async function boot(fake: FakeFetch, overrides: TestConfigOverrides = {}): Promise<Harness> {
  const app = await startTestApp({
    fetchImpl: fake.fetch,
    overrides: {
      githubApiBaseUrl: "http://github.test",
      providerBaseUrls: {
        "opencode-zen": "http://provider.test/v1",
        openrouter: "http://provider.test/v1",
      },
      providerApiKeys: { "opencode-zen": "test-key", openrouter: "test-key" },
      ...overrides,
    },
  });
  return { baseUrl: app.baseUrl, fake, close: () => app.close(), cleanup: () => app.cleanup() };
}

function withCompletion(fake: FakeFetch, tokens: string[] = ["Hello", " there"]): void {
  fake.on("provider.test", () => ({
    chunks: openAiStreamChunks(tokens, { usage: { prompt: 5, completion: 3 } }),
  }));
}

test("health is public and responses carry security headers", async () => {
  const app = await boot(new FakeFetch());
  try {
    const response = await request(app.baseUrl, "/health");
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "ok");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(response.headers.get("x-request-id"));

    const missing = await request(app.baseUrl, "/nope");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "route_not_found");

    const wrongMethod = await request(app.baseUrl, "/health", { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("authentication lifecycle: register, duplicate, login, refresh, logout", async () => {
  const app = await boot(new FakeFetch());
  try {
    const account = await registerAccount(app.baseUrl, "alice");
    assert.ok(account.token.length > 20);

    const duplicate = await request(app.baseUrl, "/v1/auth/register", {
      body: { username: "alice", password: "Str0ngPassphrase!" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "username_taken");

    const badLogin = await request(app.baseUrl, "/v1/auth/login", {
      body: { username: "alice", password: "wrong-password" },
    });
    assert.equal(badLogin.status, 401);

    const login = await request<{ refreshToken: string }>(app.baseUrl, "/v1/auth/login", {
      body: { username: "alice", password: "Str0ngPassphrase!" },
    });
    assert.equal(login.status, 200);

    const rotated = await request<{ refreshToken: string }>(app.baseUrl, "/v1/auth/refresh", {
      body: { refreshToken: login.body.refreshToken },
    });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.refreshToken, login.body.refreshToken);

    const replayed = await request(app.baseUrl, "/v1/auth/refresh", {
      body: { refreshToken: login.body.refreshToken },
    });
    assert.equal(replayed.status, 401);

    const logout = await request(app.baseUrl, "/v1/auth/logout", {
      body: { refreshToken: rotated.body.refreshToken },
    });
    assert.equal(logout.status, 204);

    const afterLogout = await request(app.baseUrl, "/v1/auth/refresh", {
      body: { refreshToken: rotated.body.refreshToken },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("protected routes reject missing and invalid bearer tokens", async () => {
  const app = await boot(new FakeFetch());
  try {
    const anonymous = await request(app.baseUrl, "/v1/me");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, "unauthorized");

    const bogus = await request(app.baseUrl, "/v1/me", { token: "not-a-real-jwt" });
    assert.equal(bogus.status, 401);
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("identifies the caller and lists models", async () => {
  const app = await boot(new FakeFetch());
  try {
    const account = await registerAccount(app.baseUrl, "bob");
    const me = await request<{ user: { username: string }; github: { connected: boolean } }>(app.baseUrl, "/v1/me", {
      token: account.token,
    });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, "bob");
    assert.equal(me.body.github.connected, false);

    const models = await request<{ primaryModelId: string; models: { id: string }[] }>(app.baseUrl, "/v1/models", {
      token: account.token,
    });
    assert.equal(models.status, 200);
    assert.equal(models.body.primaryModelId, "big-pickle");
    assert.ok(models.body.models.some((model) => model.id === "big-pickle"));
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("chat CRUD is scoped to the owning user", async () => {
  const app = await boot(new FakeFetch());
  try {
    const alice = await registerAccount(app.baseUrl, "carol");
    const bob = await registerAccount(app.baseUrl, "dave");

    const created = await request<{ id: string; title: string }>(app.baseUrl, "/v1/chats", {
      token: alice.token,
      body: { title: "First chat" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.title, "First chat");

    const list = await request<{ chats: { id: string }[] }>(app.baseUrl, "/v1/chats", { token: alice.token });
    assert.equal(list.body.chats.length, 1);
    assert.equal(list.body.chats[0]?.id, created.body.id);

    const patched = await request<{ title: string; pinned: boolean }>(
      app.baseUrl,
      `/v1/chats/${created.body.id}`,
      { method: "PATCH", token: alice.token, body: { title: "Renamed", pinned: true } },
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.title, "Renamed");
    assert.equal(patched.body.pinned, true);

    const foreign = await request(app.baseUrl, `/v1/chats/${created.body.id}`, { token: bob.token });
    assert.equal(foreign.status, 404);

    const deleted = await request(app.baseUrl, `/v1/chats/${created.body.id}`, {
      method: "DELETE",
      token: alice.token,
    });
    assert.equal(deleted.status, 204);
    assert.equal((await request(app.baseUrl, `/v1/chats/${created.body.id}`, { token: alice.token })).status, 404);
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("non-streaming message returns and persists the assistant reply", async () => {
  const fake = new FakeFetch();
  withCompletion(fake, ["Hi", " pickle"]);
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "erin");
    const chat = await request<{ id: string }>(app.baseUrl, "/v1/chats", {
      token: account.token,
      body: { title: "Completion" },
    });

    const reply = await request<{
      userMessage: { content: string; role: string };
      assistantMessage: { content: string; role: string; modelId: string };
      fallbackChain: unknown[];
    }>(app.baseUrl, `/v1/chats/${chat.body.id}/messages`, {
      token: account.token,
      body: { content: "hello", modelId: "big-pickle" },
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.assistantMessage.content, "Hi pickle");
    assert.equal(reply.body.assistantMessage.role, "assistant");
    assert.equal(reply.body.assistantMessage.modelId, "big-pickle");
    assert.ok(Array.isArray(reply.body.fallbackChain));

    const detail = await request<{ messages: { role: string; content: string }[] }>(
      app.baseUrl,
      `/v1/chats/${chat.body.id}?messageLimit=10`,
      { token: account.token },
    );
    assert.deepEqual(
      detail.body.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(detail.body.messages[1]?.content, "Hi pickle");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("unknown requested model is rejected before any provider call", async () => {
  const fake = new FakeFetch();
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "frank");
    const chat = await request<{ id: string }>(app.baseUrl, "/v1/chats", {
      token: account.token,
      body: { title: "Bad model" },
    });
    const failed = await request(app.baseUrl, `/v1/chats/${chat.body.id}/messages`, {
      token: account.token,
      body: { content: "hello", modelId: "not-a-real-model" },
    });
    assert.equal(failed.status, 400);
    assert.equal(failed.body.error.code, "unknown_model");
    assert.equal(fake.countFor("provider.test"), 0);
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("streams meta/delta/done over SSE and persists the reply", async () => {
  const fake = new FakeFetch();
  withCompletion(fake, ["strea", "med"]);
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "grace");
    const chat = await request<{ id: string }>(app.baseUrl, "/v1/chats", {
      token: account.token,
      body: { title: "Stream" },
    });

    const response = await fetch(`${app.baseUrl}/v1/chats/${chat.body.id}/stream?content=hello&modelId=big-pickle`, {
      headers: { authorization: `Bearer ${account.token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = await readSse(response);
    const names = events.map((event) => event.event);
    assert.ok(names.includes("meta"));
    assert.ok(names.includes("delta"));
    assert.ok(names.includes("done"));

    const deltas = events.filter((event) => event.event === "delta").map((event) => JSON.parse(event.data).text);
    assert.equal(deltas.join(""), "streamed");
    const done = JSON.parse(events.find((event) => event.event === "done")?.data ?? "{}");
    assert.equal(done.model, "big-pickle");

    const providerBody = fake.lastRequest("provider.test")?.body as
      | { messages?: { role: string; content: unknown }[] }
      | undefined;
    assert.deepEqual(
      (providerBody?.messages ?? []).map((message) => [message.role, message.content]),
      [["user", "hello"]],
    );

    const detail = await request<{ messages: { role: string; content: string }[] }>(
      app.baseUrl,
      `/v1/chats/${chat.body.id}?messageLimit=10`,
      { token: account.token },
    );
    assert.equal(detail.body.messages.at(-1)?.content, "streamed");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("regenerate replaces the previous answer instead of stacking a second one", async () => {
  const fake = new FakeFetch();
  withCompletion(fake, ["first"]);
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "judy");
    const chat = await request<{ id: string }>(app.baseUrl, "/v1/chats", {
      token: account.token,
      body: { title: "Regen" },
    });

    const first = await fetch(`${app.baseUrl}/v1/chats/${chat.body.id}/stream?content=hi&modelId=big-pickle`, {
      headers: { authorization: `Bearer ${account.token}` },
    });
    await readSse(first);

    withCompletion(fake, ["second"]);
    const regen = await fetch(`${app.baseUrl}/v1/chats/${chat.body.id}/regenerate?modelId=big-pickle`, {
      headers: { authorization: `Bearer ${account.token}` },
    });
    assert.equal(regen.status, 200);
    assert.match(regen.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = await readSse(regen);
    const deltas = events.filter((event) => event.event === "delta").map((event) => JSON.parse(event.data).text);
    assert.equal(deltas.join(""), "second");

    const detail = await request<{ messages: { role: string; content: string }[] }>(
      app.baseUrl,
      `/v1/chats/${chat.body.id}?messageLimit=10`,
      { token: account.token },
    );
    assert.deepEqual(
      detail.body.messages.map((message) => message.content),
      ["hi", "second"],
    );
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("regenerate without a user turn is rejected", async () => {
  const app = await boot(new FakeFetch());
  try {
    const account = await registerAccount(app.baseUrl, "karl");
    const chat = await request<{ id: string }>(app.baseUrl, "/v1/chats", {
      token: account.token,
      body: { title: "Empty" },
    });
    const regen = await request(app.baseUrl, `/v1/chats/${chat.body.id}/regenerate`, { token: account.token });
    assert.equal(regen.status, 400);
    assert.equal(regen.body.error.code, "no_user_message");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("cancelling a stream that is not running is a 404", async () => {
  const app = await boot(new FakeFetch());
  try {
    const account = await registerAccount(app.baseUrl, "heidi");
    const chat = await request<{ id: string }>(app.baseUrl, "/v1/chats", {
      token: account.token,
      body: { title: "Cancel" },
    });
    const cancel = await request(app.baseUrl, `/v1/chats/${chat.body.id}/stream`, {
      method: "DELETE",
      token: account.token,
    });
    assert.equal(cancel.status, 404);
    assert.equal(cancel.body.error.code, "no_active_stream");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("attachments round-trip through storage", async () => {
  const app = await boot(new FakeFetch());
  try {
    const account = await registerAccount(app.baseUrl, "ivan");
    const created = await request<{ id: string; mimeType: string }>(app.baseUrl, "/v1/attachments", {
      token: account.token,
      body: { data: TINY_PNG_BASE64, mimeType: "image/png", fileName: "pixel.png" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.mimeType, "image/png");

    const downloaded = await fetch(`${app.baseUrl}/v1/attachments/${created.body.id}`, {
      headers: { authorization: `Bearer ${account.token}` },
    });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(TINY_PNG_BASE64, "base64"));
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("attachments over the configured size limit are rejected", async () => {
  const app = await boot(new FakeFetch(), { attachmentMaxBytes: 32 });
  try {
    const account = await registerAccount(app.baseUrl, "judy");
    const tooBig = await request(app.baseUrl, "/v1/attachments", {
      token: account.token,
      body: { data: TINY_PNG_BASE64, mimeType: "image/png" },
    });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error.code, "attachment_too_large");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("oversized request bodies are rejected with 413", async () => {
  const app = await boot(new FakeFetch(), { env: { MAX_REQUEST_BODY_BYTES: "1024" } });
  try {
    const huge = "x".repeat(4000);
    const response = await request(app.baseUrl, "/v1/auth/register", {
      raw: JSON.stringify({ username: "karl", password: huge }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "payload_too_large");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("global rate limiting returns 429 with retry-after", async () => {
  const app = await boot(new FakeFetch(), { requestsPerMinute: 2 });
  try {
    const account = await registerAccount(app.baseUrl, "laura");
    assert.equal((await request(app.baseUrl, "/v1/models", { token: account.token })).status, 200);
    assert.equal((await request(app.baseUrl, "/v1/models", { token: account.token })).status, 200);
    const limited = await request(app.baseUrl, "/v1/models", { token: account.token });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("chat repository context is validated on create and update", async () => {
  const app = await boot(new FakeFetch());
  try {
    const account = await registerAccount(app.baseUrl, "oscar");

    const created = await request<{ id: string; repository: string; projectPath: string }>(app.baseUrl, "/v1/chats", {
      token: account.token,
      body: { title: "ctx", repository: "octocat/hello-world", projectPath: "app/src" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.repository, "octocat/hello-world");
    assert.equal(created.body.projectPath, "app/src");

    // The Android client sets this through PATCH; it must be stored, not dropped.
    const patched = await request<{ repository: string; branch: string; projectPath: string }>(
      app.baseUrl,
      `/v1/chats/${created.body.id}`,
      {
        method: "PATCH",
        token: account.token,
        body: { repository: "octocat/other-repo", branch: "main", projectPath: "app" },
      },
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.repository, "octocat/other-repo");
    assert.equal(patched.body.branch, "main");

    const reread = await request<{ chat: { repository: string; projectPath: string } }>(
      app.baseUrl,
      `/v1/chats/${created.body.id}`,
      { token: account.token },
    );
    assert.equal(reread.body.chat.repository, "octocat/other-repo");
    assert.equal(reread.body.chat.projectPath, "app");

    for (const repository of ["octocat/hello-world/extra", "octocat/../etc", "just-a-name"]) {
      const rejected = await request(app.baseUrl, `/v1/chats/${created.body.id}`, {
        method: "PATCH",
        token: account.token,
        body: { repository },
      });
      assert.equal(rejected.status, 400, `repository "${repository}" must be rejected`);
    }
    for (const projectPath of ["../../etc", "/abs"]) {
      const rejected = await request(app.baseUrl, `/v1/chats/${created.body.id}`, {
        method: "PATCH",
        token: account.token,
        body: { projectPath },
      });
      assert.equal(rejected.status, 400, `projectPath "${projectPath}" must be rejected`);
    }
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("GitHub connect, status, repos and disconnect", async () => {
  const fake = new FakeFetch();
  fake.on("github.test/user", () => ({ body: JSON.stringify({ login: "octocat" }) }));
  fake.on("github.test/user/repos", () => ({
    body: JSON.stringify([{ full_name: "octocat/hello-world", default_branch: "main", private: false }]),
  }));
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "mike");

    const disconnected = await request<{ connected: boolean }>(app.baseUrl, "/v1/github/status", {
      token: account.token,
    });
    assert.equal(disconnected.body.connected, false);

    const connect = await request<{ connected: boolean; login: string }>(app.baseUrl, "/v1/github/connect", {
      token: account.token,
      body: { token: "ghp_abcdefghijklmnopqrstuvwxyz012345" },
    });
    assert.equal(connect.status, 200);
    assert.equal(connect.body.login, "octocat");
    assert.equal(connect.body.connected, true);

    const status = await request<{ connected: boolean; login: string }>(app.baseUrl, "/v1/github/status", {
      token: account.token,
    });
    assert.equal(status.body.connected, true);
    assert.equal(status.body.login, "octocat");

    const repos = await request<{ repos: { fullName: string }[] }>(app.baseUrl, "/v1/github/repos", {
      token: account.token,
    });
    assert.equal(repos.status, 200);
    assert.equal(repos.body.repos[0]?.fullName, "octocat/hello-world");

    const disconnect = await request(app.baseUrl, "/v1/github/connect", {
      method: "DELETE",
      token: account.token,
    });
    assert.equal(disconnect.status, 204);

    const after = await request<{ connected: boolean }>(app.baseUrl, "/v1/github/status", {
      token: account.token,
    });
    assert.equal(after.body.connected, false);
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("POST /v1/github/memory/sessions stores one session document", async () => {
  const fake = new FakeFetch();
  fake.on("github.test", (request) => {
    if (request.url.endsWith("/git/ref/heads/main")) return { body: JSON.stringify({ object: { sha: "basesha" } }) };
    if (request.url.includes("/contents/") && request.method === "GET") {
      return { status: 404, body: '{"message":"nf"}' };
    }
    if (request.url.includes("/contents/")) return { body: JSON.stringify({ commit: { sha: "s1" } }) };
    return { body: "{}" };
  });
  fake.on("github.test/user", () => ({ body: JSON.stringify({ login: "octocat" }) }));
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "nina");
    const chat = await request<{ id: string }>(app.baseUrl, "/v1/chats", {
      token: account.token,
      body: { title: "Session" },
    });
    await request(app.baseUrl, "/v1/github/connect", {
      token: account.token,
      body: { token: "ghp_abcdefghijklmnopqrstuvwxyz012345" },
    });

    const stored = await request<{ stored: boolean; path: string; branch: string }>(
      app.baseUrl,
      "/v1/github/memory/sessions",
      {
        method: "POST",
        token: account.token,
        body: {
          owner: "octocat",
          repo: "hello-world",
          branch: "main",
          chatId: chat.body.id,
          title: "Session",
          summary: "what happened",
          messageCount: 4,
        },
      },
    );
    assert.equal(stored.status, 201);
    assert.equal(stored.body.stored, true);
    // The write must use the same path the listing reads, otherwise it is invisible.
    assert.equal(stored.body.path, `.opencode/session-${chat.body.id}.md`);
    assert.equal(stored.body.branch, "main");
    const put = fake.requests.find((entry) => entry.method === "PUT" && entry.url.includes("/contents/"));
    assert.ok(put && put.url.includes(`session-${chat.body.id}.md`));
  } finally {
    await app.close();
    await app.cleanup();
  }
});
