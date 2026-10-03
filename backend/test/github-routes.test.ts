/**
 * Security tests for the GitHub HTTP surface.
 *
 * Every case here is an authorisation or input-validation boundary: a rejection must
 * happen before any GitHub call and before any provider call, so a caller cannot use
 * the API to reach another account's repository or to spend quota on a run that
 * could not do anything.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { registerAccount, request, startTestApp, type TestConfigOverrides, type TestApp } from "./helpers.ts";
import { FakeFetch } from "./fakes.ts";

const GITHUB_PATHS: [string, string][] = [
  ["GET", "/v1/github/status"],
  ["POST", "/v1/github/connect"],
  ["DELETE", "/v1/github/connect"],
  ["GET", "/v1/github/repos"],
  ["GET", "/v1/github/repos/o/r/branches"],
  ["GET", "/v1/github/repos/o/r/contents?path=src&ref=main"],
  ["GET", "/v1/github/repos/o/r/file?path=src/a.ts&ref=main"],
  ["GET", "/v1/github/repos/o/r/search?q=main"],
  ["GET", "/v1/github/memory?owner=o&repo=r&ref=main"],
  ["PUT", "/v1/github/memory"],
  ["GET", "/v1/github/memory/sessions?owner=o&repo=r&ref=main"],
  ["POST", "/v1/github/memory/sessions"],
  ["POST", "/v1/github/agent/commit"],
  ["POST", "/v1/github/agent/run"],
];

async function boot(fake: FakeFetch, overrides: TestConfigOverrides = {}): Promise<TestApp> {
  return startTestApp({
    fetchImpl: fake.fetch,
    overrides: {
      githubApiBaseUrl: "http://github.test",
      providerBaseUrls: { "opencode-zen": "http://provider.test/v1", openrouter: "http://provider.test/v1" },
      providerApiKeys: { "opencode-zen": "test-key", openrouter: "test-key" },
      ...overrides,
    },
  });
}

/** A GitHub that answers every call, so any call that happens is visible in `fake.requests`. */
function permissiveGitHub(): FakeFetch {
  const fake = new FakeFetch();
  // One handler for everything: `FakeFetch.on` lets a later registration shadow an
  // earlier one for the same URL, so splitting these would drop the `/user` answer.
  fake.on("github.test", (entry) => {
    if (entry.url.endsWith("/github.test/user") || entry.url.endsWith("/user")) {
      return { body: JSON.stringify({ login: "octocat" }) };
    }
    if (entry.url.endsWith("/git/ref/heads/main")) return { body: JSON.stringify({ object: { sha: "basesha" } }) };
    if (entry.url.includes("/contents/")) {
      if (entry.method === "PUT") return { body: JSON.stringify({ commit: { sha: "s1" } }) };
      if (entry.method === "GET") return { status: 404, body: '{"message":"nf"}' };
    }
    return { body: "{}" };
  });
  return fake;
}

const CONNECT = { token: "ghp_abcdefghijklmnopqrstuvwxyz012345" };

test("every GitHub route requires a bearer token", async () => {
  const app = await boot(new FakeFetch());
  try {
    for (const [method, path] of GITHUB_PATHS) {
      const response = await request(app.baseUrl, path, { method });
      assert.equal(response.status, 401, `${method} ${path} must be authenticated`);
      assert.equal(response.body.error.code, "unauthorized");
    }
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("an agent run without a connected GitHub account is refused before any provider call", async () => {
  const fake = permissiveGitHub();
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "dana");
    const response = await request(app.baseUrl, "/v1/github/agent/run", {
      method: "POST",
      token: account.token,
      body: { repository: "octocat/hello-world", prompt: "summarise the repo" },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "github_not_connected");
    // The point of the early gate: no quota is spent on a run that cannot work.
    assert.equal(fake.countFor("provider.test"), 0, "no provider request may be made");
    assert.equal(fake.countFor("github.test/repos"), 0, "no GitHub request may be made");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("a malformed repository is rejected before the credential and agent are used", async () => {
  const fake = permissiveGitHub();
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "erin");
    await request(app.baseUrl, "/v1/github/connect", { token: account.token, body: CONNECT });
    const before = fake.requests.length;
    for (const repository of ["octocat/hello-world/extra", "octocat/../etc", "octocat", "/", "a/"]) {
      const response = await request(app.baseUrl, "/v1/github/agent/run", {
        method: "POST",
        token: account.token,
        body: { repository, prompt: "go" },
      });
      assert.equal(response.status, 400, `"${repository}" must be rejected`);
    }
    assert.equal(fake.countFor("provider.test"), 0);
    assert.equal(fake.requests.length, before, "validation must precede every outbound call");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("an agent run cannot seed its prompt with another account's chat", async () => {
  const fake = permissiveGitHub();
  const app = await boot(fake);
  try {
    const owner = await registerAccount(app.baseUrl, "frank");
    const victim = await registerAccount(app.baseUrl, "gail");
    const chat = await request<{ id: string }>(app.baseUrl, "/v1/chats", {
      token: victim.token,
      body: { title: "victim secret" },
    });
    await request(app.baseUrl, "/v1/chats/chat1", { token: victim.token });
    await request(app.baseUrl, "/v1/github/connect", { token: owner.token, body: CONNECT });

    const response = await request(app.baseUrl, "/v1/github/agent/run", {
      method: "POST",
      token: owner.token,
      body: { repository: "octocat/hello-world", prompt: "go", chatId: chat.body.id, branch: "main" },
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "chat_not_found");
    assert.equal(fake.countFor("provider.test"), 0, "another account's history must never reach the model");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("session memory cannot be written for another account's chat or through a path", async () => {
  const fake = permissiveGitHub();
  const app = await boot(fake);
  try {
    const owner = await registerAccount(app.baseUrl, "hana");
    const victim = await registerAccount(app.baseUrl, "ivan");
    const chat = await request<{ id: string }>(app.baseUrl, "/v1/chats", {
      token: victim.token,
      body: { title: "victim" },
    });
    await request(app.baseUrl, "/v1/github/connect", { token: owner.token, body: CONNECT });
    const before = fake.requests.length;

    const foreign = await request(app.baseUrl, "/v1/github/memory/sessions", {
      method: "POST",
      token: owner.token,
      body: { owner: "octocat", repo: "hello-world", branch: "main", chatId: chat.body.id, title: "t", summary: "s" },
    });
    assert.equal(foreign.status, 404, "an unowned chatId must be refused");

    for (const chatId of ["../escape", "a/b", "..", "with space", ""]) {
      const response = await request(app.baseUrl, "/v1/github/memory/sessions", {
        method: "POST",
        token: owner.token,
        body: { owner: "octocat", repo: "hello-world", branch: "main", chatId, title: "t", summary: "s" },
      });
      assert.equal(response.status, 400, `chatId "${chatId}" must be rejected`);
    }
    assert.equal(fake.requests.length, before, "no GitHub call may follow a rejected request");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("agent commit validates the repository before touching GitHub and honours the write switch", async () => {
  const fake = permissiveGitHub();
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "jane");
    await request(app.baseUrl, "/v1/github/connect", { token: account.token, body: CONNECT });
    const before = fake.requests.length;

    const malformed = await request(app.baseUrl, "/v1/github/agent/commit", {
      method: "POST",
      token: account.token,
      body: { owner: "octocat", repo: "../evil", baseBranch: "main", commitMessage: "x", files: [] },
    });
    assert.equal(malformed.status, 400);

    // No service or bootstrap token is configured in tests, so writes are off.
    const writesOff = await request(app.baseUrl, "/v1/github/agent/commit", {
      method: "POST",
      token: account.token,
      body: {
        owner: "octocat",
        repo: "hello-world",
        baseBranch: "main",
        commitMessage: "x",
        createPullRequest: true,
        files: [{ path: "a.md", content: "x" }],
      },
    });
    assert.equal(writesOff.status, 403);
    assert.equal(writesOff.body.error.code, "github_writes_disabled");
    assert.equal(fake.requests.length, before);
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("repository paths that escape the repository are rejected", async () => {
  const fake = permissiveGitHub();
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "kyle");
    await request(app.baseUrl, "/v1/github/connect", { token: account.token, body: CONNECT });
    const before = fake.requests.length;

    for (const path of ["../../etc/passwd", "/abs", "src/../../out", "a\nb"]) {
      const file = await request(app.baseUrl, `/v1/github/repos/octocat/hello-world/file?ref=main&path=${encodeURIComponent(path)}`, {
        token: account.token,
      });
      const contents = await request(
        app.baseUrl,
        `/v1/github/repos/octocat/hello-world/contents?ref=main&path=${encodeURIComponent(path)}`,
        { token: account.token },
      );
      assert.ok(file.status === 400 || contents.status === 400, `path "${path}" must be rejected`);
    }
    assert.equal(fake.requests.length, before, "no GitHub call may follow a rejected path");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("a GitHub failure surfaces as a typed error without leaking the token", async () => {
  const fake = new FakeFetch();
  fake.on("github.test/user", () => ({ body: JSON.stringify({ login: "octocat" }) }));
  fake.on("github.test/user/repos", () => ({
    status: 401,
    body: '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest/overview"}',
  }));
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "liam");
    await request(app.baseUrl, "/v1/github/connect", { token: account.token, body: CONNECT });
    const response = await request(app.baseUrl, "/v1/github/repos", { token: account.token });
    // An upstream 401 is not a status the client may act on, so it is reported as an
    // upstream failure rather than forwarded verbatim.
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, "github_401");
    assert.equal(response.body.error.retryable, false);
    assert.ok(!response.text.includes("ghp_"), "the stored token must never appear in a response");
    assert.ok(!response.text.includes("docs.github.com"), "the raw upstream body must not be echoed");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("GitHub read routes are served through the connected account's credential", async () => {
  const fake = new FakeFetch();
  fake.on("github.test/user", () => ({ body: JSON.stringify({ login: "octocat" }) }));
  fake.on("github.test/repos/octocat/hello-world/branches", () => ({ body: JSON.stringify([{ name: "main", commit: { sha: "abc" } }]) }));
  fake.on("github.test/search/code", () => ({ body: JSON.stringify({ items: [{ path: "src/a.ts", sha: "1" }] }) }));
  fake.on("github.test/repos/octocat/hello-world/contents/src", () => ({ body: JSON.stringify([{ path: "src/a.ts", name: "a.ts", type: "file", size: 3, sha: "1" }]) }));
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "mia");
    await request(app.baseUrl, "/v1/github/connect", { token: account.token, body: CONNECT });

    const branches = await request<{ branches: { name: string }[] }>(app.baseUrl, "/v1/github/repos/octocat/hello-world/branches", {
      token: account.token,
    });
    assert.equal(branches.status, 200);
    assert.equal(branches.body.branches[0]?.name, "main");

    const contents = await request<{ entries: { path: string }[] }>(
      app.baseUrl,
      "/v1/github/repos/octocat/hello-world/contents?path=src&ref=main",
      { token: account.token },
    );
    assert.equal(contents.status, 200);
    assert.equal(contents.body.entries[0]?.path, "src/a.ts");

    const search = await request<{ results: { path: string }[] }>(app.baseUrl, "/v1/github/repos/octocat/hello-world/search?q=parse", {
      token: account.token,
    });
    assert.equal(search.status, 200);
    assert.equal(search.body.results[0]?.path, "src/a.ts");

    // Every call carried the caller's own credential, and the malformed shape of
    // `/search` responses can no longer crash the route.
    for (const entry of fake.requests.filter((request) => request.url.includes("github.test"))) {
      assert.equal(entry.headers.authorization, `Bearer ${CONNECT.token}`);
    }
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("a malformed GitHub payload cannot crash a read route", async () => {
  const fake = new FakeFetch();
  fake.on("github.test", () => ({ body: "not json at all" }));
  const app = await boot(fake);
  try {
    const account = await registerAccount(app.baseUrl, "noah");
    // A `/user` body with no login is not a usable credential: the connect is refused
    // with a typed error instead of crashing on a missing field.
    const connect = await request(app.baseUrl, "/v1/github/connect", { token: account.token, body: CONNECT });
    assert.notEqual(connect.status, 500, "an unparseable GitHub body must not become an internal error");
    assert.ok(connect.status >= 400);

    const status = await request(app.baseUrl, "/v1/github/status", { token: account.token });
    assert.notEqual(status.status, 500);
    assert.equal(status.body.connected, false, "an unusable credential is never reported as connected");

    // With a usable `/user` but an unparseable listing, the read route degrades to empty.
    fake.on("github.test/user", () => ({ body: JSON.stringify({ login: "octocat" }) }));
    const reconnected = await request(app.baseUrl, "/v1/github/connect", { token: account.token, body: CONNECT });
    assert.equal(reconnected.status, 200);
    const repos = await request(app.baseUrl, "/v1/github/repos", { token: account.token });
    assert.equal(repos.status, 200);
    assert.deepEqual(repos.body.repos, [], "an unparseable listing is empty, not a 500");
  } finally {
    await app.close();
    await app.cleanup();
  }
});
