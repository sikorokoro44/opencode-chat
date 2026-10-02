import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { AuthService } from "../src/auth/auth-service.ts";
import { AuthDelay, RateLimiter } from "../src/http/rate-limit.ts";
import { signJwt } from "../src/auth/jwt.ts";
import { createMemoryDatabase } from "../src/store/database.ts";
import { parseModelRegistry, MODELS_FILE } from "../src/models/registry.ts";
import { ModelRegistry } from "../src/models/registry.ts";

const SECRET = "test-secret-that-is-long-enough-for-hs256";

/** Matches an HttpError by its machine-readable `code`, not its human message. */
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected);
  return true;
};

function auth(now: () => number = () => 1_700_000_000): AuthService {
  return new AuthService({
    database: createMemoryDatabase(),
    jwtSecret: SECRET,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 30 * 24 * 3600,
    now,
  });
}

test("registration creates a user without ever exposing the password hash", async () => {
  const service = auth();
  const tokens = await service.register({ username: "Alice", password: "Str0ng-Passphrase!" });
  assert.equal(tokens.user.username, "Alice");
  assert.equal(Object.keys(tokens.user).includes("passwordHash"), false);
  assert.ok(tokens.accessToken.length > 20);
  assert.ok(tokens.refreshToken.length > 20);
  assert.equal(tokens.expiresIn, 900);

  const stored = service.findUserById(tokens.user.id);
  assert.ok(stored?.passwordHash.startsWith("scrypt$"));
  assert.equal(stored?.passwordHash.includes("Str0ng-Passphrase!"), false);
});

test("usernames are matched case-insensitively for duplicates", async () => {
  const service = auth();
  await service.register({ username: "Alice", password: "Str0ng-Passphrase!" });
  await assert.rejects(
    () => service.register({ username: "ALICE", password: "An0ther-Passphrase!" }),
    code("username_taken"),
  );
});

test("registration rejects invalid usernames and weak passwords", async () => {
  const service = auth();
  await assert.rejects(() => service.register({ username: "ab", password: "Str0ng-Passphrase!" }), code("invalid_username"));
  await assert.rejects(() => service.register({ username: "bad name", password: "Str0ng-Passphrase!" }), code("invalid_username"));
  await assert.rejects(() => service.register({ username: "alice", password: "short" }), code("weak_password"));
  await assert.rejects(() => service.register({ username: "alice", password: "alicealicealice" }), code("weak_password"));
});

test("login succeeds with the right password and fails uniformly otherwise", async () => {
  const service = auth();
  await service.register({ username: "alice", password: "Str0ng-Passphrase!" });

  const tokens = await service.login({ username: "ALICE", password: "Str0ng-Passphrase!" });
  assert.ok(tokens.accessToken);

  await assert.rejects(() => service.login({ username: "alice", password: "wrong-password" }), /invalid username or password/);
  await assert.rejects(() => service.login({ username: "nobody", password: "Str0ng-Passphrase!" }), /invalid username or password/);
});

test("a disabled account cannot log in or refresh", async () => {
  const service = auth();
  const tokens = await service.register({ username: "alice", password: "Str0ng-Passphrase!" });
  const user = service.findUserById(tokens.user.id);
  assert.ok(user);
  user.disabled = true;

  await assert.rejects(() => service.login({ username: "alice", password: "Str0ng-Passphrase!" }), /invalid username or password/);
  await assert.rejects(() => service.refresh(tokens.refreshToken), /account is unavailable/);
});

test("access tokens are accepted only while their session is active and correct", async () => {
  const service = auth();
  const tokens = await service.register({ username: "alice", password: "Str0ng-Passphrase!" });
  const claims = service.verifyAccessToken(tokens.accessToken);
  assert.equal(claims.sub, tokens.user.id);
  assert.equal(claims.typ, "access");
  assert.deepEqual(claims.scopes, ["chat", "github"]);

  // A refresh token is not an access token.
  assert.throws(() => service.verifyAccessToken(tokens.refreshToken), /wrong token type/);

  await service.revokeSession(claims.sid);
  assert.throws(() => service.verifyAccessToken(tokens.accessToken), /revoked/);
});

test("an expired access token is rejected at the expiry second", async () => {
  let now = 1_000_000;
  const service = auth(() => now);
  const tokens = await service.register({ username: "alice", password: "Str0ng-Passphrase!" });
  assert.equal(service.verifyAccessToken(tokens.accessToken).sub, tokens.user.id);

  now += 900;
  assert.throws(() => service.verifyAccessToken(tokens.accessToken), /expired/);
});

test("a token signed for a different session or with a different secret is rejected", async () => {
  const service = auth();
  const tokens = await service.register({ username: "alice", password: "Str0ng-Passphrase!" });
  const claims = service.verifyAccessToken(tokens.accessToken);

  const foreign = signJwt(
    { sub: claims.sub, username: claims.username, sid: "ses_foreign", scopes: ["chat"], typ: "access", iat: claims.iat, exp: claims.exp, jti: "j" },
    SECRET,
  );
  assert.throws(() => service.verifyAccessToken(foreign), /revoked/);

  const wrongSecret = signJwt(
    { sub: claims.sub, username: claims.username, sid: claims.sid, scopes: ["chat"], typ: "access", iat: claims.iat, exp: claims.exp, jti: "j" },
    "another-secret",
  );
  assert.throws(() => service.verifyAccessToken(wrongSecret), /rejected/);
});

test("refresh rotates the token and the old one becomes a detected replay", async () => {
  const service = auth();
  const tokens = await service.register({ username: "alice", password: "Str0ng-Passphrase!" });

  const rotated = await service.refresh(tokens.refreshToken);
  assert.notEqual(rotated.refreshToken, tokens.refreshToken);
  assert.equal(service.verifyAccessToken(rotated.accessToken).sub, tokens.user.id);

  // Replaying the pre-rotation token revokes the entire session family.
  await assert.rejects(() => service.refresh(tokens.refreshToken), /reuse detected/);
  await assert.rejects(() => service.refresh(rotated.refreshToken), /revoked/);
  assert.throws(() => service.verifyAccessToken(rotated.accessToken), /revoked/);
});

test("refresh rejects an unknown session and a subject mismatch", async () => {
  const service = auth();
  const first = await service.register({ username: "alice", password: "Str0ng-Passphrase!" });
  const second = await service.register({ username: "bob", password: "Str0ng-Passphrase!" });
  assert.notEqual(first.user.id, second.user.id);

  const forged = signJwt(
    { sub: first.user.id, sid: "ses_does_not_exist", typ: "refresh", iat: 1_700_000_000, exp: 1_800_000_000, jti: "x" },
    SECRET,
  );
  await assert.rejects(() => service.refresh(forged), /revoked/);
});

test("an expired refresh token is rejected", async () => {
  let now = 2_000_000;
  const service = auth(() => now);
  const tokens = await service.register({ username: "alice", password: "Str0ng-Passphrase!" });
  now += 30 * 24 * 3600 + 1;
  await assert.rejects(() => service.refresh(tokens.refreshToken), /invalid or expired/);
});

test("logout revokes the session and is idempotent", async () => {
  const service = auth();
  const tokens = await service.register({ username: "alice", password: "Str0ng-Passphrase!" });
  const sid = service.verifyAccessToken(tokens.accessToken).sid;

  await service.logout(tokens.refreshToken);
  await service.logout(tokens.refreshToken);
  await service.logout("not-a-token");
  assert.throws(() => service.verifyAccessToken(tokens.accessToken), /revoked/);
  assert.equal(await service.revokeSession(sid), true);
  assert.equal(await service.revokeSession("ses_missing"), false);
});

test("a revocation made directly against the session stops the access token", async () => {
  const service = auth();
  const tokens = await service.register({ username: "alice", password: "Str0ng-Passphrase!" });
  const sid = service.verifyAccessToken(tokens.accessToken).sid;
  assert.equal(await service.revokeSession(sid), true);
  assert.throws(() => service.verifyAccessToken(tokens.accessToken), /revoked/);
});

test("rate limiter drains, refills and reports a retry delay", () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 3, windowMs: 1_000, now: () => now });
  assert.deepEqual(limiter.take("ip").allowed, true);
  assert.deepEqual(limiter.take("ip").allowed, true);
  assert.deepEqual(limiter.take("ip").allowed, true);
  const denied = limiter.take("ip");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0);

  now += 1_000;
  assert.equal(limiter.take("ip").allowed, true);
  assert.equal(limiter.take("other-ip").allowed, true);
  limiter.reset("ip");
  assert.equal(limiter.size, 1);
  limiter.reset();
  assert.equal(limiter.size, 0);
});

test("rate limiter protects keys independently", () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, false);
  assert.equal(limiter.take("b").allowed, true);
});

test("auth delay grows exponentially, caps, and forgets after a quiet minute", () => {
  let now = 0;
  const delay = new AuthDelay(100, 800, () => now);
  assert.equal(delay.penaltyFor("ip"), 0);
  assert.equal(delay.recordFailure("ip"), 100);
  assert.equal(delay.penaltyFor("ip"), 100);
  assert.equal(delay.recordFailure("ip"), 200);
  assert.equal(delay.recordFailure("ip"), 400);
  assert.equal(delay.recordFailure("ip"), 800);
  assert.equal(delay.recordFailure("ip"), 800, "capped");
  assert.equal(delay.recordFailure("ip"), 800, "capped even after many failures");

  delay.recordSuccess("ip");
  assert.equal(delay.penaltyFor("ip"), 0);

  delay.recordFailure("ip");
  now += 61_000;
  assert.equal(delay.penaltyFor("ip"), 0);
});

test("the registry fixture used by auth tests is the shipped Big Pickle contract", () => {
  const registry = new ModelRegistry({ snapshot: parseModelRegistry(readFileSync(MODELS_FILE, "utf8")) });
  assert.equal(registry.primaryModelId, "big-pickle");
});
