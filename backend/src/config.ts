/**
 * Runtime configuration.
 *
 * Every secret is read from the environment, validated, and held in memory only.
 * Nothing in this file may be serialised into a response body or a log line.
 */

export type NodeEnv = "production" | "staging" | "development" | "test";

export interface Config {
  readonly env: NodeEnv;
  readonly port: number;
  readonly host: string;
  readonly jwtSecret: string;
  /** access-token lifetime in seconds (default 15 minutes) */
  readonly accessTokenTtlSeconds: number;
  /** refresh-token lifetime in seconds (default 30 days) */
  readonly refreshTokenTtlSeconds: number;
  readonly databaseDir: string;
  readonly attachmentMaxBytes: number;
  readonly attachmentMaxImageBytes: number;
  readonly requestsPerMinute: number;
  readonly authAttemptsPerMinute: number;
  /** Bootstrap token required for privileged coding-agent writes. Empty disables the API. */
  readonly adminBootstrapToken: string;
  /** Hex encoded 32 byte key used to encrypt stored GitHub tokens at rest. */
  readonly githubTokenEncryptionKey: string;
  /** Service-account GitHub token used for privileged agent writes. */
  readonly githubServiceToken: string | undefined;
  readonly githubApiBaseUrl: string;
  readonly githubMemoryPath: string;
  readonly providerBaseUrls: Readonly<Record<string, string>>;
  readonly providerApiKeys: Readonly<Record<string, string | undefined>>;
  readonly providerTimeoutMs: number;
  readonly maxFallbackDepth: number;
  readonly streamHeartbeatMs: number;
  readonly maxRequestBodyBytes: number;
  readonly logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEV_JWT_SECRET = "dev-only-insecure-jwt-secret-do-not-use-in-production";

function readString(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`missing required environment variable ${key}`);
  }
  return raw;
}

function readOptional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseNodeEnv(value: string | undefined): NodeEnv {
  switch ((value ?? "development").toLowerCase()) {
    case "production":
    case "prod":
      return "production";
    case "staging":
      return "staging";
    case "test":
      return "test";
    default:
      return "development";
  }
}

function isHexKey(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/** Production must never run with the development signing key. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const isProduction = nodeEnv === "production";

  const jwtSecret = readString(env, "OPENCODE_JWT_SECRET", isProduction ? undefined : DEV_JWT_SECRET);
  if (jwtSecret.length < 32) {
    throw new ConfigError("OPENCODE_JWT_SECRET must be at least 32 characters");
  }
  if (isProduction && jwtSecret === DEV_JWT_SECRET) {
    throw new ConfigError("OPENCODE_JWT_SECRET must be overridden in production");
  }

  const githubKey = readOptional(env, "OPENCODE_GITHUB_TOKEN_ENCRYPTION_KEY");
  if (githubKey !== undefined && !isHexKey(githubKey)) {
    throw new ConfigError("OPENCODE_GITHUB_TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }

  const logLevel = (readOptional(env, "LOG_LEVEL") ?? (isProduction ? "info" : "debug")) as Config["logLevel"];
  if (!["debug", "info", "warn", "error", "silent"].includes(logLevel)) {
    throw new ConfigError("LOG_LEVEL must be one of debug, info, warn, error, silent");
  }

  const providerTimeoutMs = readInt(env, "PROVIDER_TIMEOUT_MS", 60_000, 1_000, 600_000);
  const maxFallbackDepth = readInt(env, "MAX_FALLBACK_DEPTH", 4, 1, 8);

  return {
    env: nodeEnv,
    port: readInt(env, "PORT", 8080, 1, 65_535),
    host: readOptional(env, "HOST") ?? "0.0.0.0",
    jwtSecret,
    accessTokenTtlSeconds: readInt(env, "ACCESS_TOKEN_TTL_SECONDS", 900, 60, 86_400),
    refreshTokenTtlSeconds: readInt(env, "REFRESH_TOKEN_TTL_SECONDS", 2_592_000, 300, 31_536_000),
    databaseDir: readOptional(env, "DATABASE_DIR") ?? "./data",
    attachmentMaxBytes: readInt(env, "ATTACHMENT_MAX_BYTES", 5 * 1024 * 1024, 1024, 25 * 1024 * 1024),
    attachmentMaxImageBytes: readInt(env, "ATTACHMENT_MAX_IMAGE_BYTES", 3 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    requestsPerMinute: readInt(env, "REQUESTS_PER_MINUTE", 120, 1, 100_000),
    authAttemptsPerMinute: readInt(env, "AUTH_ATTEMPTS_PER_MINUTE", 10, 1, 10_000),
    adminBootstrapToken: readOptional(env, "OPENCODE_ADMIN_BOOTSTRAP_TOKEN") ?? "",
    githubTokenEncryptionKey: githubKey ?? "",
    githubServiceToken: readOptional(env, "OPENCODE_GITHUB_TOKEN"),
    githubApiBaseUrl: readOptional(env, "OPENCODE_GITHUB_API_BASE_URL") ?? "https://api.github.com",
    githubMemoryPath: readOptional(env, "OPENCODE_GITHUB_MEMORY_PATH") ?? ".opencode/PROJECT_MEMORY.md",
    providerBaseUrls: {
      "opencode-zen": readOptional(env, "OPENCODE_ZEN_BASE_URL") ?? "https://opencode.ai/zen/v1",
      openrouter: readOptional(env, "OPENCODE_OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
      custom: readOptional(env, "OPENCODE_CUSTOM_BASE_URL") ?? "http://127.0.0.1:11434/v1",
    },
    providerApiKeys: {
      "opencode-zen": readOptional(env, "OPENCODE_ZEN_API_KEY"),
      openrouter: readOptional(env, "OPENCODE_OPENROUTER_API_KEY"),
      custom: readOptional(env, "OPENCODE_CUSTOM_API_KEY"),
    },
    providerTimeoutMs,
    maxFallbackDepth,
    streamHeartbeatMs: readInt(env, "STREAM_HEARTBEAT_MS", 15_000, 1_000, 120_000),
    maxRequestBodyBytes: readInt(env, "MAX_REQUEST_BODY_BYTES", 12 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    logLevel,
  };
}

/** Redacts a secret for safe logging: only a short fingerprint remains. */
export function redact(secret: string | undefined): string {
  if (!secret) return "<unset>";
  if (secret.length <= 8) return "<redacted>";
  return `${secret.slice(0, 3)}…(${secret.length} chars)`;
}
