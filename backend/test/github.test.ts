import assert from "node:assert/strict";
import { test } from "node:test";

import { createSecretBox, SecretBoxError, SecretStore } from "../src/github/secret-box.ts";
import { EtagCache, GitHubApiError, GitHubClient } from "../src/github/github-client.ts";
import { GitHubService, timingSafeEqualString } from "../src/github/github-service.ts";
import { FakeFetch } from "./fakes.ts";
import type { UserRecord } from "../src/store/records.ts";

const KEY = "a".repeat(64);

/** Matches an HttpError by its machine-readable `code`. */
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected);
  return true;
};
const HOST = "api.github.test";
const BASE = `https://${HOST}`;

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "usr_1",
    username: "alice",
    usernameLower: "alice",
    passwordHash: "hash",
    createdAt: new Date(0).toISOString(),
    disabled: false,
    ...overrides,
  };
}

function service(fetchImpl: typeof fetch, options: { serviceToken?: string; bootstrapToken?: string } = {}): GitHubService {
  return new GitHubService({
    baseUrl: BASE,
    serviceToken: options.serviceToken,
    bootstrapToken: options.bootstrapToken ?? "",
    secretStore: new SecretStore(KEY),
    fetchImpl,
    memoryPath: ".opencode/memory.md",
    timeoutMs: 2_000,
  });
}

// ----------------------------------------------------------------- secret box

test("secrets round-trip and are bound to their associated data", () => {
  const box = createSecretBox(KEY);
  const sealed = box.seal("ghp_supersecrettoken", "usr_1");
  assert.equal(box.open(sealed, "usr_1"), "ghp_supersecrettoken");
  assert.equal(sealed.includes("ghp_supersecrettoken"), false);
  assert.ok(sealed.startsWith("v1."));
});

test("two seals of the same secret differ (random IV)", () => {
  const box = createSecretBox(KEY);
  assert.notEqual(box.seal("same", "aad"), box.seal("same", "aad"));
});

test("a sealed secret cannot be opened under different AAD", () => {
  const box = createSecretBox(KEY);
  const sealed = box.seal("token", "usr_1");
  assert.throws(() => box.open(sealed, "usr_2"), SecretBoxError);
});

test("tampered or malformed ciphertext is rejected", () => {
  const box = createSecretBox(KEY);
  const sealed = box.seal("token", "aad");
  const parts = sealed.split(".");
  assert.throws(() => box.open(`v1.${parts[1]}.${parts[2]}.AAAA`, "aad"), SecretBoxError);
  assert.throws(() => box.open("not-a-ciphertext", "aad"), SecretBoxError);
  assert.throws(() => box.open("v2.a.b.c", "aad"), SecretBoxError);
});

test("the encryption key must be 64 hex characters", () => {
  assert.throws(() => createSecretBox("too-short"), /64 hex/);
  assert.throws(() => createSecretBox("z".repeat(64)), /64 hex/);
  assert.ok(createSecretBox("f".repeat(64)));
});

test("a disabled secret store refuses to seal or open", () => {
  const store = new SecretStore("");
  assert.equal(store.enabled, false);
  assert.throws(() => store.seal("x", "aad"), /not configured/);
  assert.throws(() => store.open("x", "aad"), /not configured/);
});

// -------------------------------------------------------------- github client

test("the client authenticates with a bearer token and pinned API version", async () => {
  const fake = new FakeFetch().on(HOST, { body: JSON.stringify({ login: "alice" }) });
  const client = new GitHubClient({ token: "ghp_secret", baseUrl: BASE, fetchImpl: fake.fetch });
  assert.equal(await client.currentLogin(), "alice");

  const request = fake.lastRequest(HOST);
  assert.equal(request?.headers["authorization"], "Bearer ghp_secret");
  assert.equal(request?.headers["x-github-api-version"], "2022-11-28");
  assert.ok((request?.headers["user-agent"] ?? "").length > 0);
  assert.equal(request?.url.includes("ghp_secret"), false);
});

test("conditional GETs reuse an ETag and fall back to the cached body on 304", async () => {
  let calls = 0;
  const fake = new FakeFetch().on(HOST, () => {
    calls += 1;
    return calls === 1
      ? { body: JSON.stringify({ ok: true }), headers: { etag: '"abc"' } }
      : { status: 304, body: "" };
  });
  const client = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: fake.fetch });
  const first = await client.request<{ ok: boolean }>("/thing");
  assert.equal(first.notModified, false);
  const second = await client.request<{ ok: boolean }>("/thing");
  assert.equal(second.notModified, true);
  assert.deepEqual(second.data, { ok: true });
  assert.equal(fake.lastRequest(HOST)?.headers["if-none-match"], '"abc"');
});

test("noCache bypasses the conditional cache", async () => {
  const fake = new FakeFetch().on(HOST, { body: JSON.stringify({ n: 1 }), headers: { etag: '"e"' } });
  const client = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: fake.fetch });
  await client.request("/thing");
  await client.request("/thing", { noCache: true });
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1]?.headers["if-none-match"], undefined);
});

test("an empty body is never cached, so a later 304 cannot resolve to nothing", async () => {
  const fake = new FakeFetch().on(HOST, (_request, index) => {
    if (index === 0) return { body: "", headers: { etag: '"empty"' } };
    if (index === 1) return { body: JSON.stringify({ late: true }) };
    return { status: 304, body: "" };
  });
  const client = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: fake.fetch });
  const first = await client.request<Record<string, unknown>>("/thing");
  assert.equal(first.data, undefined, "an empty body has no content to serve");
  const second = await client.request<Record<string, unknown>>("/thing");
  // Nothing was cached, so the conditional request is dropped and the resource is
  // fetched again rather than served as an empty 304 body.
  assert.equal(fake.requests[1]?.headers["if-none-match"], undefined);
  assert.deepEqual(second.data, { late: true });
  assert.equal(second.notModified, false);
});

test("a cached raw file body survives a 304 without a JSON parse", async () => {
  // The contents API answers `vnd.github.raw` with plain text, so the cached body is
  // not JSON and must not go through `JSON.parse`.
  const fake = new FakeFetch().on(HOST, (request) => {
    if (request.headers["if-none-match"] === undefined) return { body: "# hello\nnot json", headers: { etag: '"raw"' } };
    return { status: 304, body: "" };
  });
  const client = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: fake.fetch });
  await client.request("/file", { accept: "application/vnd.github.raw+json" });
  const second = await client.request<string>("/file", { accept: "application/vnd.github.raw+json" });
  assert.equal(second.notModified, true);
  assert.equal(second.data, "# hello\nnot json");
});

test("a 304 with nothing cached retries unconditionally and then fails as an upstream error", async () => {
  const fake = new FakeFetch().on(HOST, { status: 304, body: "" });
  const client = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: fake.fetch, maxRetries: 0 });
  await assert.rejects(
    () => client.request("/thing"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal((error as { status?: number }).status, 502, "a bare 304 must never reach the wire as 304");
      return true;
    },
  );
  // One conditional attempt plus exactly one unconditional retry, then it gives up.
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1]?.headers["if-none-match"], undefined);
});

test("an expired cache entry is dropped so a 304 can no longer resolve to a stale body", async () => {
  let now = 1_000;
  const cache = new EtagCache(8, 60_000, () => now);
  const fake = new FakeFetch().on(HOST, { body: JSON.stringify({ n: 1 }), headers: { etag: '"e"' } });
  const client = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: fake.fetch, cache });
  await client.request("/thing");
  const conditional = () => fake.lastRequest(HOST)?.headers["if-none-match"];

  await client.request("/thing");
  assert.equal(conditional(), '"e"', "a live entry is reused");

  now += 60_001;
  await client.request("/thing");
  assert.equal(
    conditional(),
    undefined,
    "an expired entry must not be sent, or a 304 would serve a stale body",
  );
});

test("GitHub errors are mapped to safe internal statuses", async () => {
  const notFound = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: new FakeFetch().on(HOST, { status: 404, body: '{"message":"Not Found"}' }).fetch });
  await assert.rejects(
    () => notFound.request("/missing"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.githubStatus, 404);
      assert.equal((error as { status?: number }).status, 404);
      return true;
    },
  );

  const validation = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: new FakeFetch().on(HOST, { status: 422, body: '{"message":"Bad"}' }).fetch });
  await assert.rejects(
    () => validation.request("/bad"),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 400, "422 becomes a 400");
      return true;
    },
  );

  const server = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: new FakeFetch().on(HOST, { status: 500, body: "boom" }).fetch });
  await assert.rejects(
    () => server.request("/oops"),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 502, "5xx becomes a 502");
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    },
  );
});

test("rate limiting is reported without leaking the token", async () => {
  const fake = new FakeFetch().on(HOST, {
    status: 403,
    body: '{"message":"API rate limit exceeded"}',
    headers: { "x-ratelimit-remaining": "0" },
  });
  const client = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: fake.fetch, maxRetries: 0 });
  await assert.rejects(
    () => client.request("/user/repos"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.ok(!String((error as Error).message).includes("ghp_"));
      assert.match((error as Error).message, /rate limit|denied/i);
      return true;
    },
  );
});

test("commitFiles writes base64 content and returns the commit sha", async () => {
  const fake = new FakeFetch().on("/contents/", (request) => {
    if (request.method === "GET") return { status: 404, body: '{"message":"Not Found"}' };
    return { body: JSON.stringify({ commit: { sha: "commit_1" } }) };
  });
  const client = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: fake.fetch });
  const result = await client.commitFiles("octo", "repo", "feature", [{ path: "src/a.kt", content: "fun main() {}" }], "change");
  assert.equal(result.commitSha, "commit_1");
  assert.deepEqual(result.committed, ["src/a.kt"]);

  const put = fake.requests.find((entry) => entry.method === "PUT");
  const body = put?.body as { content: string; branch: string; sha?: string };
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "fun main() {}");
  assert.equal(body.branch, "feature");
  assert.equal(body.sha, undefined, "new files omit sha");
});

// ------------------------------------------------------------- github service

test("credential resolution prefers the user token and never returns it in the clear", () => {
  const store = new SecretStore(KEY);
  const linked = user({ githubTokenCipher: store.seal("ghp_user", "usr_1") });
  const svc = service(async () => new Response(""), { serviceToken: "ghp_service", bootstrapToken: "bootstrap" });

  const resolved = svc.credentialFor(linked);
  assert.equal(resolved.token, "ghp_user");
  assert.equal(resolved.source, "user");

  const withBootstrap = svc.credentialFor(linked, "bootstrap");
  assert.equal(withBootstrap.source, "service-account");
  assert.equal(withBootstrap.token, "ghp_service");

  // A wrong bootstrap token falls back to the user's own credential.
  assert.equal(svc.credentialFor(linked, "guess").source, "user");
});

test("a user without a token and no valid bootstrap is refused", () => {
  const svc = service(async () => new Response(""), { serviceToken: "ghp_service", bootstrapToken: "bootstrap" });
  assert.throws(() => svc.credentialFor(user()), code("github_not_connected"));
  assert.throws(() => svc.credentialFor(user(), "wrong"), code("github_not_connected"));
});

test("repository and path validation blocks traversal and injection", async () => {
  const svc = service(new FakeFetch().fetch, { serviceToken: "t" });
  const linked = user({ githubTokenCipher: new SecretStore(KEY).seal("ghp", "usr_1") });
  await assert.rejects(() => svc.listBranches(linked, "octo", "../etc"), code("invalid_repo"));
  await assert.rejects(() => svc.listContents(linked, "octo", "repo", "../../secret", "main"), code("invalid_path"));
  await assert.rejects(() => svc.readFile(linked, "octo", "repo", "a\\b", "main"), code("invalid_path"));
  await assert.rejects(() => svc.listContents(linked, "octo", "repo", "/abs", "main"), code("invalid_path"));
});

test("commitFiles requires writes to be enabled and validates inputs", async () => {
  const locked = service(new FakeFetch().fetch);
  const writable = service(new FakeFetch().on(HOST, { body: "{}" }).fetch, { serviceToken: "t" });
  const linked = user({ githubTokenCipher: new SecretStore(KEY).seal("ghp", "usr_1") });

  await assert.rejects(
    () => locked.commitFiles({ user: linked, owner: "o", repo: "r", baseBranch: "main", commitMessage: "m", files: [{ path: "a", content: "b" }], createPullRequest: false }),
    code("github_writes_disabled"),
  );
  await assert.rejects(
    () => writable.commitFiles({ user: linked, owner: "o", repo: "r", baseBranch: "main", commitMessage: "m", files: [], createPullRequest: false }),
    code("no_files"),
  );
  await assert.rejects(
    () =>
      writable.commitFiles({
        user: linked,
        owner: "o",
        repo: "r",
        baseBranch: "main",
        commitMessage: "m",
        files: [{ path: "../escape", content: "x" }],
        createPullRequest: false,
      }),
    code("invalid_path"),
  );
});

test("commitFiles creates a branch, writes files and opens a pull request", async () => {
  const calls: string[] = [];
  const fake = new FakeFetch();
  fake.on(HOST, (request) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url.endsWith("/git/ref/heads/main")) return { body: JSON.stringify({ object: { sha: "basesha" } }) };
    if (request.url.endsWith("/git/refs")) return { body: JSON.stringify({ ref: "refs/heads/x" }) };
    if (request.url.includes("/contents/") && request.method === "GET") return { status: 404, body: '{"message":"nf"}' };
    if (request.url.includes("/contents/")) return { body: JSON.stringify({ commit: { sha: "sha1" } }) };
    if (request.url.endsWith("/pulls")) return { body: JSON.stringify({ number: 7, html_url: "https://github.test/o/r/pull/7" }) };
    return { body: "{}" };
  });
  const svc = service(fake.fetch, { serviceToken: "t" });
  const linked = user({ githubTokenCipher: new SecretStore(KEY).seal("ghp", "usr_1") });

  const result = await svc.commitFiles({
    user: linked,
    owner: "octo",
    repo: "repo",
    baseBranch: "main",
    branch: "agent/fix",
    commitMessage: "fix things",
    files: [{ path: "src/a.kt", content: "code" }],
    createPullRequest: true,
    pullRequestTitle: "Fix",
  });

  assert.equal(result.branch, "agent/fix");
  assert.equal(result.commitSha, "sha1");
  assert.equal(result.prUrl, "https://github.test/o/r/pull/7");
  assert.deepEqual(result.files, ["src/a.kt"]);
  assert.ok(calls.some((entry) => entry.endsWith("/git/refs")));
  assert.ok(calls.some((entry) => entry.endsWith("/pulls")));
  assert.ok(result.actions.some((action) => action.type === "pull_request"));
});

test("readMemory returns a missing document on 404 and content otherwise", async () => {
  const missing = service(new FakeFetch().on(HOST, { status: 404, body: '{"message":"nf"}' }).fetch, { serviceToken: "t" });
  const linked = user({ githubTokenCipher: new SecretStore(KEY).seal("ghp", "usr_1") });
  assert.deepEqual(await missing.readMemory(linked, "o", "r", "main"), {
    exists: false,
    path: ".opencode/memory.md",
    content: "",
    updatedAt: null,
  });

  const present = service(new FakeFetch().on(HOST, { body: "# memory\nnotes" }).fetch, { serviceToken: "t" });
  const found = await present.readMemory(linked, "o", "r", "main");
  assert.equal(found.exists, true);
  assert.match(found.content, /notes/);
});

test("writeMemory creates a branch when the target ref is missing", async () => {
  let refReads = 0;
  const fake = new FakeFetch();
  fake.on(HOST, (request) => {
    if (request.url.endsWith("/git/ref/heads/main")) {
      refReads += 1;
      // First read is the requested target ref (missing); the second resolves the
      // base ref used to create the memory branch.
      return refReads === 1
        ? { status: 404, body: '{"message":"nf"}' }
        : { body: JSON.stringify({ object: { sha: "basesha" } }) };
    }
    if (request.url.endsWith("/repos/o/r")) return { body: JSON.stringify({ default_branch: "main" }) };
    if (request.url.endsWith("/git/refs")) return { body: JSON.stringify({ ref: "refs/heads/b" }) };
    if (request.url.includes("/contents/") && request.method === "GET") return { status: 404, body: '{"message":"nf"}' };
    if (request.url.includes("/contents/")) return { body: JSON.stringify({ commit: { sha: "mem_sha" } }) };
    return { body: "{}" };
  });
  const svc = service(fake.fetch, { serviceToken: "t" });
  const linked = user({ githubTokenCipher: new SecretStore(KEY).seal("ghp", "usr_1") });
  const result = await svc.writeMemory(linked, { owner: "o", repo: "r", branch: "main", content: "memory", commitMessage: "m" });
  assert.equal(result.sha, "mem_sha");
  assert.equal(result.action.type, "memory_write");
  assert.match(result.branch, /memory-/);
});

test("connectToken validates the token, stores it encrypted and supports disconnect", async () => {
  const fake = new FakeFetch().on(HOST, { body: JSON.stringify({ login: "alice" }) });
  const svc = service(fake.fetch);
  const account = user();
  const connected = await svc.connectToken(account, "ghp_valid_token_value");
  assert.equal(connected.login, "alice");
  assert.ok(account.githubTokenCipher);
  assert.equal(account.githubTokenCipher.includes("ghp_valid_token_value"), false);
  assert.equal(svc.connectionStatus(account).connected, true);

  svc.disconnectToken(account);
  assert.equal(svc.connectionStatus(account).connected, false);
});

test("connectToken rejects malformed tokens before calling GitHub", async () => {
  let called = false;
  const svc = service(async () => {
    called = true;
    return new Response("{}");
  });
  await assert.rejects(() => svc.connectToken(user(), "short"), /does not look like/);
  await assert.rejects(() => svc.connectToken(user(), "has spaces in it here"), /does not look like/);
  assert.equal(called, false);
});

test("listMemorySessions surfaces only session documents", async () => {
  const listing = [
    { path: ".opencode/session-abc.md", name: "session-abc.md", type: "file", size: 1, sha: "1" },
    { path: ".opencode/readme.md", name: "readme.md", type: "file", size: 1, sha: "2" },
    { path: ".opencode/sub", name: "sub", type: "dir", size: 0, sha: "3" },
  ];
  const svc = service(new FakeFetch().on(HOST, { body: JSON.stringify(listing) }).fetch, { serviceToken: "t" });
  const linked = user({ githubTokenCipher: new SecretStore(KEY).seal("ghp", "usr_1") });
  const sessions = await svc.listMemorySessions(linked, "o", "r", "main");
  assert.deepEqual(
    sessions.map((session) => session.chatId),
    ["abc"],
  );
});

test("a session recorded through the service is readable from the same path and format", async () => {
  const stored = new Map<string, string>();
  const fake = new FakeFetch();
  fake.on(HOST, (request) => {
    if (request.url.endsWith("/git/ref/heads/main")) return { body: JSON.stringify({ object: { sha: "basesha" } }) };
    const path = decodeURIComponent(new URL(request.url).pathname).split("/contents/")[1] ?? "";
    if (request.method === "PUT" && request.url.includes("/contents/")) {
      const body = request.body as { content: string };
      stored.set(path, Buffer.from(body.content, "base64").toString("utf8"));
      return { body: JSON.stringify({ commit: { sha: "s1" } }) };
    }
    // A directory listing is derived from the stored documents, exactly like GitHub.
    const document = stored.get(path);
    if (document !== undefined) return { body: document, headers: { etag: '"doc"' } };
    const directory = path.replace(/\/[^/]*$/, "");
    const entries = [...stored.keys()]
      .filter((key) => key.startsWith(directory === "" ? "" : `${directory}/`) && !key.slice(directory.length + 1).includes("/"))
      .map((key) => {
        const name = key.split("/").pop() ?? key;
        return { path: key, name, type: "file", size: 1, sha: "x" };
      });
    if (entries.length === 0) return { status: 404, body: '{"message":"nf"}' };
    return { body: JSON.stringify(entries), headers: { etag: '"listing"' } };
  });

  const svc = service(fake.fetch, { serviceToken: "t" });
  const linked = user({ githubTokenCipher: new SecretStore(KEY).seal("ghp", "usr_1") });
  const result = await svc.recordSessionMemory(linked, {
    owner: "o",
    repo: "r",
    branch: "main",
    chatId: "chat_abc",
    title: "Refactor the parser",
    summary: "what happened",
    messageCount: 7,
  });
  assert.equal(result.stored, true);
  assert.equal(result.branch, "main");
  // Write and read must agree on the path, otherwise a stored session is invisible.
  assert.equal(result.path, ".opencode/session-chat_abc.md");
  assert.deepEqual([...stored.keys()], [".opencode/session-chat_abc.md"]);

  const listed = await svc.listMemorySessions(linked, "o", "r", "main");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.chatId, "chat_abc");
  assert.equal(listed[0]?.title, "Refactor the parser");
  assert.equal(listed[0]?.messageCount, 7);
  assert.match(listed[0]?.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("session memory defaults to the memory directory when the path has none", () => {
  const svc = new GitHubService({
    baseUrl: BASE,
    bootstrapToken: "",
    secretStore: new SecretStore(KEY),
    memoryPath: "PROJECT_MEMORY.md",
  });
  assert.equal(svc.sessionDirectory(), "");
  assert.equal(svc.sessionPath("chat_1"), "session-chat_1.md");
  assert.throws(() => svc.sessionPath("../escape"), /path-safe token/);
  assert.throws(() => svc.sessionPath("a/b"), /path-safe token/);
});

test("recordSessionMemory reports stored:false when GitHub fails and still resolves a branch", async () => {
  let refReads = 0;
  const fake = new FakeFetch();
  fake.on(HOST, (request) => {
    if (request.url.endsWith("/git/ref/heads/main")) {
      refReads += 1;
      // Missing on the first probe so the memory branch is created from the default.
      return refReads === 1
        ? { status: 404, body: '{"message":"nf"}' }
        : { body: JSON.stringify({ object: { sha: "basesha" } }) };
    }
    if (request.url.endsWith("/repos/o/r")) return { body: JSON.stringify({ default_branch: "main" }) };
    if (request.url.endsWith("/git/refs")) return { body: JSON.stringify({ ref: "refs/heads/b" }) };
    return { body: "{}" };
  });
  const svc = service(fake.fetch, { serviceToken: "t" });
  const linked = user({ githubTokenCipher: new SecretStore(KEY).seal("ghp", "usr_1") });

  const result = await svc.recordSessionMemory(linked, {
    owner: "o",
    repo: "r",
    branch: "main",
    chatId: "chat_1",
    title: "t",
    summary: "s",
  });
  assert.equal(result.stored, false, "nothing was committed, so nothing may be claimed as stored");
  assert.match(result.branch, /memory-/);
});

test("a malformed GitHub write response is reported, never dereferenced", async () => {
  // A 2xx with no `commit` object used to crash commitFiles with a TypeError.
  const fake = new FakeFetch();
  fake.on(HOST, (request) => {
    if (request.url.endsWith("/git/ref/heads/main")) return { body: JSON.stringify({ object: { sha: "basesha" } }) };
    if (request.url.includes("/contents/") && request.method === "GET") return { status: 404, body: '{"message":"nf"}' };
    return { body: "{}" };
  });
  const client = new GitHubClient({ token: "t", baseUrl: BASE, fetchImpl: fake.fetch });
  const result = await client.commitFiles("o", "r", "main", [{ path: "a.md", content: "x" }], "m");
  assert.equal(result.commitSha, null);
  assert.deepEqual(result.committed, []);
  assert.deepEqual(result.skipped, ["a.md"]);
});

test("recordSessionMemory commits one session document and is best-effort", async () => {
  const fake = new FakeFetch();
  let putBody: unknown;
  fake.on(HOST, (request) => {
    if (request.url.endsWith("/git/ref/heads/main")) return { body: JSON.stringify({ object: { sha: "basesha" } }) };
    if (request.url.includes("/contents/") && request.method === "GET") {
      return { status: 404, body: '{"message":"nf"}' };
    }
    if (request.url.includes("/contents/")) {
      putBody = request.body;
      return { body: JSON.stringify({ commit: { sha: "s1" } }) };
    }
    return { body: "{}" };
  });
  const svc = service(fake.fetch, { serviceToken: "t" });
  const linked = user({ githubTokenCipher: new SecretStore(KEY).seal("ghp", "usr_1") });
  await svc.recordSessionMemory(linked, {
    owner: "o",
    repo: "r",
    branch: "main",
    chatId: "abc",
    title: "Session title",
    summary: "what happened",
  });
  const written = JSON.stringify(putBody);
  assert.match(written, /memory: session abc/);
  const body = putBody as { content: string };
  assert.match(Buffer.from(body.content, "base64").toString("utf8"), /# Session title/);

  const failing = service(
    new FakeFetch().on(HOST, { status: 500, body: '{"message":"boom"}' }).fetch,
    { serviceToken: "t" },
  );
  await assert.doesNotReject(() =>
    failing.recordSessionMemory(linked, {
      owner: "o",
      repo: "r",
      branch: "main",
      chatId: "abc",
      title: "Session title",
      summary: "what happened",
    }),
  );
});

test("timingSafeEqualString compares without short-circuiting on content", () => {
  assert.equal(timingSafeEqualString("abcdef", "abcdef"), true);
  assert.equal(timingSafeEqualString("abcdef", "abcdeg"), false);
  assert.equal(timingSafeEqualString("abc", "abcd"), false);
  assert.equal(timingSafeEqualString("", ""), true);
});

test("the ETag cache evicts the oldest entry past its bound", () => {
  const cache = new EtagCache(2, 60_000, () => 0);
  cache.set("a", "1", "{}");
  cache.set("b", "2", "{}");
  cache.set("c", "3", "{}");
  assert.equal(cache.get("a"), undefined);
  assert.ok(cache.get("b"));
  assert.ok(cache.get("c"));
});
