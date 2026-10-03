/**
 * Small, explicit request validator.
 *
 * Every handler validates its own inputs through these helpers so that untrusted
 * payloads never reach domain code, and so error codes stay predictable for the client.
 */

import { badRequest } from "./http/errors.ts";

export type Json = Record<string, unknown>;

export function asObject(value: unknown, code = "invalid_body"): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(code, "request body must be a JSON object");
  }
  return value as Json;
}

export interface StringOptions {
  min?: number;
  max?: number;
  pattern?: RegExp;
  trim?: boolean;
  optional?: boolean;
  fallback?: string;
}

export function str(source: Json, key: string, options: StringOptions = {}): string {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (options.optional) return options.fallback ?? "";
    if (options.fallback !== undefined) return options.fallback;
    throw badRequest("invalid_field", `${key} is required`);
  }
  if (typeof raw !== "string") {
    throw badRequest("invalid_field", `${key} must be a string`);
  }
  const value = options.trim === false ? raw : raw.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 4096;
  if (value.length < min) {
    throw badRequest("invalid_field", `${key} must be at least ${min} characters`);
  }
  if (value.length > max) {
    throw badRequest("invalid_field", `${key} must be at most ${max} characters`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw badRequest("invalid_field", `${key} has an invalid format`);
  }
  return value;
}

export interface IntOptions {
  min?: number;
  max?: number;
  optional?: boolean;
  fallback?: number;
}

export function int(source: Json, key: string, options: IntOptions = {}): number {
  const raw = source[key];
  if (raw === undefined || raw === null || raw === "") {
    if (options.fallback !== undefined) return options.fallback;
    if (options.optional) return 0;
    throw badRequest("invalid_field", `${key} is required`);
  }
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw badRequest("invalid_field", `${key} must be an integer`);
  }
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) {
    throw badRequest("invalid_field", `${key} must be between ${min} and ${max}`);
  }
  return value;
}

export function bool(source: Json, key: string, fallback?: boolean): boolean {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest("invalid_field", `${key} is required`);
  }
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw badRequest("invalid_field", `${key} must be a boolean`);
}

export function strArray(
  source: Json,
  key: string,
  options: { max?: number; itemMax?: number; optional?: boolean } = {},
): string[] {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (options.optional === false) throw badRequest("invalid_field", `${key} is required`);
    return [];
  }
  if (!Array.isArray(raw)) {
    throw badRequest("invalid_field", `${key} must be an array`);
  }
  const max = options.max ?? 32;
  const itemMax = options.itemMax ?? 256;
  if (raw.length > max) {
    throw badRequest("invalid_field", `${key} must contain at most ${max} items`);
  }
  return raw.map((item, index) => {
    if (typeof item !== "string") {
      throw badRequest("invalid_field", `${key}[${index}] must be a string`);
    }
    const value = item.trim();
    if (value.length === 0 || value.length > itemMax) {
      throw badRequest("invalid_field", `${key}[${index}] must be 1..${itemMax} characters`);
    }
    return value;
  });
}

export function objArray<T>(
  source: Json,
  key: string,
  options: { max?: number; parse: (item: Json, index: number) => T; optional?: boolean },
): T[] {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (options.optional === false) throw badRequest("invalid_field", `${key} is required`);
    return [];
  }
  if (!Array.isArray(raw)) {
    throw badRequest("invalid_field", `${key} must be an array`);
  }
  const max = options.max ?? 64;
  if (raw.length > max) {
    throw badRequest("invalid_field", `${key} must contain at most ${max} items`);
  }
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw badRequest("invalid_field", `${key}[${index}] must be an object`);
    }
    return options.parse(item as Json, index);
  });
}

export function oneOf<T extends string>(source: Json, key: string, allowed: readonly T[], fallback?: T): T {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest("invalid_field", `${key} is required`);
  }
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    throw badRequest("invalid_field", `${key} must be one of ${allowed.join(", ")}`);
  }
  return raw as T;
}

/** GitHub owner/repo name rules; blocks path traversal and shell-hostile input. */
export const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/**
 * Opaque resource id (chat, session) that is safe to use as a single path segment.
 * Chat ids become GitHub file names, so a `/` or `..` in caller-supplied input must
 * never be able to steer the write somewhere else in the repository.
 */
export const ID_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

export function idToken(source: Json, key: string): string {
  const value = str(source, key, { min: 1, max: 64 });
  if (!ID_TOKEN.test(value)) {
    throw badRequest("invalid_field", `${key} must be a single path-safe token`);
  }
  return value;
}

/**
 * Repository-relative file path: no absolute paths, no traversal, no control
 * characters. Control characters are rejected too: the value reaches commit
 * messages and log lines, where a newline would forge a second line of output.
 */
export function repoPath(source: Json, key: string, options: { optional?: boolean } = {}): string {
  const value = str(source, key, { optional: true, max: 1024, trim: true });
  if (value === "") {
    if (options.optional) return "";
    throw badRequest("invalid_field", `${key} is required`);
  }
  return assertSafeRepoPath(value);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function assertSafeRepoPath(value: string): string {
  if (value.startsWith("/") || value.includes("..") || value.includes("\\")) {
    throw badRequest("invalid_path", "path must be relative and must not traverse upwards");
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw badRequest("invalid_path", "path must not contain control characters");
  }
  if (value.length > 1024) {
    throw badRequest("invalid_path", "path is too long");
  }
  return value;
}

export function assertRepoName(owner: string, repo: string): void {
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo) || repo === "." || repo === "..") {
    throw badRequest("invalid_repo", "owner or repository name is invalid");
  }
}
