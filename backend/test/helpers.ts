/** Shared test helpers: config, in-memory database, fake fetch, HTTP client. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { createLogger, type Logger } from "../src/logger.ts";
import { createMemoryDatabase, type Database } from "../src/store/database.ts";
import { createApp, type App } from "../src/api/app.ts";
import { MODELS_FILE } from "../src/models/registry.ts";

export const TEST_JWT_SECRET = "test-jwt-secret-that-is-definitely-long-enough-1234";

export interface TestConfigOverrides {
  env?: NodeJS.ProcessEnv;
  databaseDir?: string;
  githubApiBaseUrl?: string;
  providerBaseUrls?: Record<string, string>;
  providerApiKeys?: Record<string, string | undefined>;
  adminBootstrapToken?: string;
  githubServiceToken?: string;
  githubTokenEncryptionKey?: string;
  requestsPerMinute?: number;
  authAttemptsPerMinute?: number;
  attachmentMaxBytes?: number;
}

export function testConfig(overrides: TestConfigOverrides = {}): Config {
  const base = loadConfig({
    NODE_ENV: "test",
    OPENCODE_JWT_SECRET: TEST_JWT_SECRET,
    PORT: "8080",
    DATABASE_DIR: overrides.databaseDir ?? "./data-test",
    LOG_LEVEL: "silent",
    ...overrides.env,
  });
  return {
    ...base,
    env: "test",
    requestsPerMinute: overrides.requestsPerMinute ?? 10_000,
    authAttemptsPerMinute: overrides.authAttemptsPerMinute ?? 1_000,
    attachmentMaxBytes: overrides.attachmentMaxBytes ?? base.attachmentMaxBytes,
    adminBootstrapToken: overrides.adminBootstrapToken ?? "",
    githubServiceToken: overrides.githubServiceToken,
    githubTokenEncryptionKey: overrides.githubTokenEncryptionKey ?? "a".repeat(64),
    ...(overrides.githubApiBaseUrl ? { githubApiBaseUrl: overrides.githubApiBaseUrl } : {}),
    ...(overrides.providerBaseUrls ? { providerBaseUrls: { ...base.providerBaseUrls, ...overrides.providerBaseUrls } } : {}),
    ...(overrides.providerApiKeys ? { providerApiKeys: { ...base.providerApiKeys, ...overrides.providerApiKeys } } : {}),
  };
}

export const silentLogger: Logger = createLogger({ level: "silent" });

export interface TestApp {
  app: App;
  database: Database;
  baseUrl: string;
  close(): Promise<void>;
  /** Removes the on-disk database directory, if any. */
  cleanup(): Promise<void>;
}

export async function startTestApp(
  options: { config?: Config; overrides?: TestConfigOverrides; database?: Database; logger?: Logger; fetchImpl?: typeof fetch } = {},
): Promise<TestApp> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-test-"));
  const config =
    options.config ??
    testConfig({ ...options.overrides, databaseDir: options.overrides?.databaseDir ?? directory });
  const app = await createApp({
    config,
    logger: options.logger ?? silentLogger,
    ...(options.database ? { database: options.database } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    modelsFile: MODELS_FILE,
  });
  const { port } = await app.listen(0, "127.0.0.1");
  return {
    app,
    database: app.database,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await app.close();
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface RequestOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: string;
  signal?: AbortSignal;
}

export async function request<T = any>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.raw !== undefined) body = options.raw;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    ...(body === undefined ? {} : { body }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, headers: response.headers, body: parsed as T, text };
}

export interface Account {
  token: string;
  refreshToken: string;
  userId: string;
  username: string;
}

export async function registerAccount(baseUrl: string, username: string, password = "Str0ngPassphrase!"): Promise<Account> {
  const response = await request<{ accessToken: string; refreshToken: string; user: { id: string; username: string } }>(
    baseUrl,
    "/v1/auth/register",
    { body: { username, password, deviceName: "test-device" } },
  );
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`register failed: ${response.status} ${response.text}`);
  }
  return {
    token: response.body.accessToken,
    refreshToken: response.body.refreshToken,
    userId: response.body.user.id,
    username: response.body.user.username,
  };
}

/** Minimal PNG (1x1) for attachment tests. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function sseChunks(events: { event: string; data: unknown }[], chunkSize = 17): string[] {
  const body = events
    .map((event) => `event: ${event.event}\ndata: ${typeof event.data === "string" ? event.data : JSON.stringify(event.data)}\n\n`)
    .join("");
  const chunks: string[] = [];
  for (let index = 0; index < body.length; index += chunkSize) {
    chunks.push(body.slice(index, index + chunkSize));
  }
  return chunks;
}

/** Collects SSE frames from a live streaming response. */
export async function readSse(
  response: Response,
  onEvent?: (event: string, data: string) => void,
): Promise<{ event: string; data: string }[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  const collected: { event: string; data: string }[] = [];
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const eventLine = raw.split("\n").find((line) => line.startsWith("event: "));
      const dataLines = raw
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
      if (eventLine) {
        const entry = { event: eventLine.slice(7), data: dataLines.join("\n") };
        collected.push(entry);
        onEvent?.(entry.event, entry.data);
      }
      separator = buffer.indexOf("\n\n");
    }
  }
  return collected;
}
