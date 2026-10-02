import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword, passwordProblems, verifyPassword } from "../src/auth/password.ts";
import { signJwt, tokenFingerprint, verifyJwt, type AccessTokenClaims } from "../src/auth/jwt.ts";

const SECRET = "unit-test-secret-value-0123456789";

test("password hashes are salted, verifiable and never plaintext", async () => {
  const hash = await hashPassword("Str0ngPassphrase!");
  assert.ok(hash.startsWith("scrypt$16384$8$1$"));
  assert.ok(!hash.includes("Str0ngPassphrase!"));
  assert.equal(await verifyPassword("Str0ngPassphrase!", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
});

test("two hashes of the same password differ (random salt)", async () => {
  const first = await hashPassword("same-password-1");
  const second = await hashPassword("same-password-1");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("same-password-1", first), true);
  assert.equal(await verifyPassword("same-password-1", second), true);
});

test("verifyPassword rejects malformed or tampered records", async () => {
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
  assert.equal(await verifyPassword("x", "scrypt$16384$8$1$"), false);
  assert.equal(await verifyPassword("x", "scrypt$abc$8$1$c2FsdA==$aGFzaA=="), false);
  // Absurd work factors must be refused so a stolen record cannot DoS the server.
  assert.equal(await verifyPassword("x", `scrypt$99999999$8$1$${'A'.repeat(8)}=$${'A'.repeat(8)}=`), false);
  assert.equal(await verifyPassword("x", ""), false);
});

test("password problems drive registration policy", () => {
  assert.deepEqual(passwordProblems("Str0ngPassphrase!", "bob"), []);
  assert.ok(passwordProblems("short1A", "bob").includes("password_too_short"));
  assert.ok(passwordProblems("alllowercasepass", "bob").includes("missing_uppercase_or_digit"));
  assert.equal(passwordProblems("alllowercase1", "bob").includes("missing_uppercase_or_digit"), false);
  assert.ok(passwordProblems("MySuperPassword", "mysuper").includes("contains_username"));
});

const claims: Omit<AccessTokenClaims, "iat" | "exp"> & { iat: number; exp: number } = {
  sub: "usr_1",
  username: "alice",
  sid: "ses_1",
  scopes: ["chat"],
  typ: "access",
  iat: 1_000,
  exp: 2_000,
  jti: "jti-1",
};

test("JWT round-trips and validates claims", () => {
  const token = signJwt(claims, SECRET);
  const result = verifyJwt<AccessTokenClaims>(token, SECRET, 1_500);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.sub, "usr_1");
    assert.equal(result.claims.typ, "access");
    assert.deepEqual(result.claims.scopes, ["chat"]);
  }
});

test("JWT rejects expiry exactly at the expiry second", () => {
  const token = signJwt(claims, SECRET);
  const stillValid = verifyJwt(token, SECRET, 1_999);
  assert.equal(stillValid.ok, true);
  const expired = verifyJwt(token, SECRET, 2_000);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, "expired");
});

test("JWT rejects a wrong secret, a tampered payload and a mangled token", () => {
  const token = signJwt(claims, SECRET);
  assert.equal(verifyJwt(token, "other-secret-value-0123456789", 1_500).ok, false);

  const [header, , signature] = token.split(".") as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: "usr_admin" })).toString("base64url");
  const forgedResult = verifyJwt(`${header}.${forged}.${signature}`, SECRET, 1_500);
  assert.equal(forgedResult.ok, false);
  if (!forgedResult.ok) assert.equal(forgedResult.reason, "bad_signature");

  assert.equal(verifyJwt("not.a.jwt", SECRET, 1_500).ok, false);
  assert.equal(verifyJwt("onlyonepart", SECRET, 1_500).ok, false);
  assert.equal(verifyJwt("", SECRET, 1_500).ok, false);
});

test("JWT refuses the 'alg: none' downgrade and any non-HS256 algorithm", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const result = verifyJwt(`${header}.${payload}.`, SECRET, 1_500);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_algorithm");

  const rsHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const rsResult = verifyJwt(`${rsHeader}.${payload}.sig`, SECRET, 1_500);
  assert.equal(rsResult.ok, false);
  if (!rsResult.ok) assert.equal(rsResult.reason, "bad_algorithm");
});

test("JWT rejects oversized tokens before doing any work", () => {
  assert.equal(verifyJwt("a".repeat(9000), SECRET, 1_500).ok, false);
});

test("token fingerprints are stable but not reversible", () => {
  const fingerprint = tokenFingerprint("sensitive-token-value");
  assert.equal(fingerprint, tokenFingerprint("sensitive-token-value"));
  assert.equal(fingerprint.length, 12);
  assert.ok(!fingerprint.includes("sensitive"));
  assert.notEqual(fingerprint, tokenFingerprint("other-token"));
});
