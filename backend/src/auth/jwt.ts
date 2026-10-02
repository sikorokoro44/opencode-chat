/**
 * HS256 JSON Web Tokens implemented directly on node:crypto.
 *
 * Verification is constant-time, fails closed on any structural surprise
 * (bad algorithm, unknown `typ`, oversized input) and never logs token material.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type JwtScope = "chat" | "github" | "admin";

export interface AccessTokenClaims {
  sub: string;
  username: string;
  sid: string;
  scopes: JwtScope[];
  /** token type guard: refresh tokens must never be accepted where access tokens are expected */
  typ: "access";
  iat: number;
  exp: number;
  jti: string;
}

export interface RefreshTokenClaims {
  sub: string;
  sid: string;
  typ: "refresh";
  iat: number;
  exp: number;
  jti: string;
}

export type Claims = AccessTokenClaims | RefreshTokenClaims;

export type VerifyResult<T> = { ok: true; claims: T } | { ok: false; reason: string };

const MAX_TOKEN_LENGTH = 8 * 1024;

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export type SignableClaims =
  | (Omit<AccessTokenClaims, "iat" | "exp"> & { iat: number; exp: number })
  | (Omit<RefreshTokenClaims, "iat" | "exp"> & { iat: number; exp: number });

export function signJwt(claims: SignableClaims, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = base64UrlEncode(createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

export function verifyJwt<T extends Claims>(token: string, secret: string, nowSeconds: number): VerifyResult<T> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, signature] = parts as [string, string, string];

  let headerJson: unknown;
  let payloadJson: unknown;
  try {
    headerJson = JSON.parse(base64UrlDecode(header).toString("utf8"));
    payloadJson = JSON.parse(base64UrlDecode(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof headerJson !== "object" || headerJson === null) return { ok: false, reason: "malformed" };
  const alg = (headerJson as Record<string, unknown>).alg;
  // Reject "none" and any asymmetric algorithm substitution outright.
  if (alg !== "HS256") return { ok: false, reason: "bad_algorithm" };

  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const provided = base64UrlDecode(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  if (typeof payloadJson !== "object" || payloadJson === null) return { ok: false, reason: "malformed" };
  const claims = payloadJson as Record<string, unknown>;
  if (typeof claims.sub !== "string" || typeof claims.typ !== "string" || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (claims.typ !== "access" && claims.typ !== "refresh") return { ok: false, reason: "bad_type" };
  // Expiry comparison is inclusive-free: a token is invalid the instant it expires.
  if (nowSeconds >= claims.exp) return { ok: false, reason: "expired" };

  return { ok: true, claims: claims as unknown as T };
}

/** Short, non-reversible fingerprint for correlating logs without exposing tokens. */
export function tokenFingerprint(token: string): string {
  return createHmac("sha256", "fingerprint").update(token).digest("hex").slice(0, 12);
}
