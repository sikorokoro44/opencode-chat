/**
 * Password hashing with scrypt from Node's bundled crypto (no native dependencies).
 *
 * Stored format: `scrypt$N$r$p$<salt-b64>$<hash-b64>` so parameters can be raised
 * later without invalidating existing hashes.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Deliberately expensive defaults; ~100ms on a modern server core. */
export const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 } as const;

export async function hashPassword(password: string, params = SCRYPT_PARAMS): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number.parseInt(parts[1] as string, 10);
  const r = Number.parseInt(parts[2] as string, 10);
  const p = Number.parseInt(parts[3] as string, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  // Refuse absurd work factors from a tampered record (hash-DoS protection).
  if (N > 1_048_576 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, "base64");
    expected = Buffer.from(parts[5] as string, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Opaque 12-bit-ish intensity estimate used to steer users towards stronger passphrases. */
export function passwordProblems(password: string, username: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push("password_too_short");
  if (password.length > 512) problems.push("password_too_long");
  if (!/[a-z]/.test(password)) problems.push("missing_lowercase");
  if (!/[A-Z0-9]/.test(password)) problems.push("missing_uppercase_or_digit");
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    problems.push("contains_username");
  }
  return problems;
}
