/**
 * Client-identity tests: rate-limit buckets must key on something a caller cannot
 * choose for itself, and the limiter state must stay bounded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { clientAddress, clientIdentity } from "../src/http/respond.ts";
import { AuthDelay, RateLimiter } from "../src/http/rate-limit.ts";
import { registerAccount, request, startTestApp } from "./helpers.ts";
import { FakeFetch } from "./fakes.ts";

function req(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

test("the socket address is the identity unless a proxy is explicitly trusted", () => {
  assert.equal(clientIdentity(req("10.0.0.5", { "x-forwarded-for": "203.0.113.9" })), "10.0.0.5");
  assert.equal(clientIdentity(req("10.0.0.5", { "x-forwarded-for": "203.0.113.9" }), true), "203.0.113.9");
});

test("an untrusted X-Forwarded-For header cannot mint new rate-limit buckets", async () => {
  // One limit, two claimed client addresses: a caller rotating the header must
  // still share the socket bucket and be throttled.
  const app = await startTestApp({ fetchImpl: new FakeFetch().fetch, overrides: { requestsPerMinute: 2 } });
  try {
    const account = await registerAccount(app.baseUrl, "mallory");
    assert.equal((await request(app.baseUrl, "/v1/models", { token: account.token })).status, 200);
    assert.equal((await request(app.baseUrl, "/v1/models", { token: account.token })).status, 200);
    const rotated = await request(app.baseUrl, "/v1/models", {
      token: account.token,
      headers: { "x-forwarded-for": "198.51.100.77" },
    });
    assert.equal(rotated.status, 429, "a rotating spoofed header must not reset the bucket");
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("a trusted proxy honours the forwarded address and ignores non-IP junk", () => {
  const trusted = { "x-forwarded-for": "not-an-ip" };
  assert.equal(clientIdentity(req("10.0.0.5", trusted), true), "10.0.0.5");
  // Only the first hop is honoured: a caller-supplied chain cannot prepend itself.
  assert.equal(clientIdentity(req("10.0.0.5", { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), true), "203.0.113.9");
  assert.equal(clientIdentity(req("10.0.0.5", { "x-forwarded-for": "::ffff:203.0.113.9" }), true), "203.0.113.9");
  assert.equal(clientIdentity(req("10.0.0.5", { "x-forwarded-for": "" }), true), "10.0.0.5");
});

test("one client cannot hold two buckets through IPv4-mapped IPv6", () => {
  assert.equal(clientAddress(req("::ffff:1.2.3.4")), "1.2.3.4");
  assert.equal(clientIdentity(req("1.2.3.4"), true), "1.2.3.4");
  assert.equal(clientAddress(req("2001:db8::1")), "2001:db8::1");
  assert.equal(clientIdentity(req("2001:db8::1"), true), "2001:db8::1");
});

test("rate-limit bucket state is bounded so header spoofing cannot exhaust memory", () => {
  const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, maxBuckets: 10 });
  for (let index = 0; index < 500; index += 1) limiter.take(`203.0.113.${index}`);
  assert.ok(limiter.size <= 10, `the bucket map must stay capped, saw ${limiter.size}`);
  // A capped map still rate-limits correctly for the identities it still tracks.
  assert.equal(limiter.take("203.0.113.0", 1).allowed, true);
  for (let index = 0; index < 4; index += 1) limiter.take("203.0.113.0", 1);
  assert.equal(limiter.take("203.0.113.0", 1).allowed, false);

  const delay = new AuthDelay(250, 8_000, () => Date.now(), 8);
  for (let index = 0; index < 200; index += 1) delay.recordFailure(`key-${index}`);
  assert.equal(delay.size, 8);
});

test("the authentication back-off grows, is capped, and expires", () => {
  let now = 1_000;
  const delay = new AuthDelay(250, 8_000, () => now);
  const penalties: number[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) penalties.push(delay.recordFailure("k"));
  assert.deepEqual(penalties, [250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000], "capped at maxMs");
  assert.equal(delay.penaltyFor("k"), 8_000);

  // The count is bounded so a long-lived attacker cannot inflate the multiplier.
  for (let attempt = 0; attempt < 50; attempt += 1) delay.recordFailure("k");
  assert.equal(delay.penaltyFor("k"), 8_000);

  now += 60_001;
  assert.equal(delay.penaltyFor("k"), 0, "an inactive identity stops being penalised");
  delay.recordSuccess("k");
  assert.equal(delay.penaltyFor("k"), 0);
  assert.equal(delay.size, 0);
});

test("a failed login is refused without locking the account out", async () => {
  const app = await startTestApp({ fetchImpl: new FakeFetch().fetch, overrides: { authAttemptsPerMinute: 1_000 } });
  try {
    const account = await registerAccount(app.baseUrl, "oscar");
    const failed = await request(app.baseUrl, "/v1/auth/login", {
      body: { username: account.username, password: "Wr0ngPassphrase!" },
    });
    assert.equal(failed.status, 401);
    // The penalty is a delay only: a correct password still works, so the response
    // never reveals that failures were recorded.
    const good = await request(app.baseUrl, "/v1/auth/login", {
      body: { username: account.username, password: "Str0ngPassphrase!" },
    });
    assert.equal(good.status, 200);
  } finally {
    await app.close();
    await app.cleanup();
  }
});

test("the app binds an ephemeral port that clients reach over the loopback interface", async () => {
  const app = await startTestApp({ fetchImpl: new FakeFetch().fetch });
  try {
    const address = app.app.server.address();
    assert.ok(address && typeof address !== "string", "the test app must listen on a port");
    assert.equal((address as AddressInfo).address, "127.0.0.1");
    assert.equal((await request(app.baseUrl, "/health")).status, 200);
  } finally {
    await app.close();
    await app.cleanup();
  }
});
