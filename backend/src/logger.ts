/** Minimal structured logger that never accepts secret-bearing objects. */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const SENSITIVE_KEY = /(token|secret|password|authorization|api[-_]?key|cookie|credential|bearer)/i;
const REDACTED = "[redacted]";

/** Defence in depth: even if a caller passes a token by mistake it is not printed. */
export function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof value === "string") {
      out[key] = value.length > 512 ? `${value.slice(0, 512)}…[truncated]` : value;
    } else if (value === null || typeof value !== "object") {
      out[key] = value;
    } else {
      out[key] = "[object]";
    }
  }
  return out;
}

export interface LoggerOptions {
  level: LogLevel;
  base?: Record<string, unknown>;
  /** Injectable sink keeps logger tests deterministic. */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, base = {}, sink } = options;
  const write = sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (entryLevel: Exclude<LogLevel, "silent">, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] > ORDER[entryLevel]) return;
    const payload = { ...sanitizeFields(base), ...sanitizeFields(fields) };
    const parts = Object.entries(payload).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    write(`${new Date().toISOString()} ${entryLevel.toUpperCase()} ${message}${parts.length ? ` ${parts.join(" ")}` : ""}`);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

export const nullLogger: Logger = createLogger({ level: "silent" });
