/** Deterministic RFC4122-ish identifiers and time helpers (no external deps). */

import { randomBytes, randomUUID } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Short, URL-safe, non-guessable identifier. 128 bits of entropy from the CSPRNG.
 * Used for chat/message/attachment ids so that guessing another user's resource is infeasible.
 */
export function newId(prefix: string): string {
  const bytes = randomBytes(16);
  let out = "";
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length];
  }
  return `${prefix}_${out}`;
}

export function newUuid(): string {
  return randomUUID();
}

/** URL-safe high-entropy token for refresh tokens and bootstrap secrets. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
