import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig, redact } from "../src/config.ts";
import { sanitizeFields, createLogger } from "../src/logger.ts";

const MINIMAL = { NODE_ENV: "test", OPENCODE_JWT_SECRET: "x".repeat(40) };

test("config requires a signing secret in production", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), ConfigError);
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", OPENCODE_JWT_SECRET: "dev-only-insecure-jwt-secret-do-not-use-in-production" }),
    /overridden in production/,
  );
});

test("config rejects short signing secrets", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production", OPENCODE_JWT_SECRET: "short" }), /at least 32/);
});

test("config rejects malformed encryption keys", () => {
  assert.throws(
    () => loadConfig({ ...MINIMAL, OPENCODE_GITHUB_TOKEN_ENCRYPTION_KEY: "not-hex" }),
    /64 hex characters/,
  );
  assert.doesNotThrow(() => loadConfig({ ...MINIMAL, OPENCODE_GITHUB_TOKEN_ENCRYPTION_KEY: "b".repeat(64) }));
});

test("config validates numeric bounds", () => {
  assert.throws(() => loadConfig({ ...MINIMAL, PORT: "99999" }), /PORT/);
  assert.throws(() => loadConfig({ ...MINIMAL, ATTACHMENT_MAX_BYTES: "10" }), /ATTACHMENT_MAX_BYTES/);
  assert.throws(() => loadConfig({ ...MINIMAL, MAX_FALLBACK_DEPTH: "99" }), /MAX_FALLBACK_DEPTH/);
  assert.throws(() => loadConfig({ ...MINIMAL, LOG_LEVEL: "loud" }), /LOG_LEVEL/);
});

test("config applies safe defaults and never ships a provider key by default", () => {
  const config = loadConfig(MINIMAL);
  assert.equal(config.port, 8080);
  assert.equal(config.providerApiKeys["opencode-zen"], undefined);
  assert.equal(config.githubApiBaseUrl, "https://api.github.com");
  assert.ok(config.jwtSecret.length >= 32);
  assert.equal(config.providerBaseUrls["opencode-zen"], "https://opencode.ai/zen/v1");
});

test("config reads provider credentials from the environment only", () => {
  const config = loadConfig({ ...MINIMAL, OPENCODE_ZEN_API_KEY: "zen-key", OPENCODE_OPENROUTER_API_KEY: "or-key" });
  assert.equal(config.providerApiKeys["opencode-zen"], "zen-key");
  assert.equal(config.providerApiKeys.openrouter, "or-key");
});

test("redact never reveals the middle of a secret", () => {
  assert.equal(redact(undefined), "<unset>");
  assert.equal(redact("short"), "<redacted>");
  const redacted = redact("super-secret-value-1234");
  assert.ok(redacted.startsWith("sup"));
  assert.ok(!redacted.includes("secret-value"));
  assert.match(redacted, /23 chars/);
});

test("logger redacts secret-looking fields", () => {
  const sanitized = sanitizeFields({
    accessToken: "abc",
    apiKey: "abc",
    password: "abc",
    authorization: "Bearer abc",
    cookie: "abc",
    safe: "value",
  });
  assert.deepEqual(sanitized, {
    accessToken: "[redacted]",
    apiKey: "[redacted]",
    password: "[redacted]",
    authorization: "[redacted]",
    cookie: "[redacted]",
    safe: "value",
  });
});

test("logger respects level filtering and writes to the injected sink", () => {
  const lines: string[] = [];
  const logger = createLogger({ level: "warn", sink: (line) => lines.push(line) });
  logger.debug("hidden");
  logger.info("hidden");
  logger.warn("visible", { token: "leak", count: 2 });
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /visible/);
  assert.match(lines[0] as string, /token="\[redacted\]"/);
  assert.match(lines[0] as string, /count=2/);
});

test("logger does not print nested objects that could hide secrets", () => {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
  logger.debug("payload", { body: { accessToken: "leak" } });
  assert.match(lines[0] as string, /body="\[object\]"/);
  assert.ok(!(lines[0] as string).includes("leak"));
});

test("logger truncates very long strings", () => {
  const sanitized = sanitizeFields({ note: "x".repeat(1000) });
  assert.ok(((sanitized.note as string).length) < 600);
});
