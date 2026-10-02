/**
 * Authentication service: registration, login, refresh with rotation + replay
 * detection, logout and revocation.
 *
 * Security properties:
 *  - passwords are scrypt-hashed, never logged, never returned;
 *  - refresh tokens are single-use: presenting a rotated token revokes the whole
 *    session family (a stolen-and-replayed token cannot silently mint new tokens);
 *  - access tokens are short-lived and carry a `typ` guard.
 */

import { hashPassword, passwordProblems, verifyPassword } from "./password.ts";
import { signJwt, verifyJwt, type AccessTokenClaims, type RefreshTokenClaims } from "./jwt.ts";
import { newId, newToken, nowIso } from "../ids.ts";
import { badRequest, conflict, unauthorized } from "../http/errors.ts";
import type { Database } from "../store/database.ts";
import type { SessionRecord, UserRecord } from "../store/records.ts";
import type { Tokens, User } from "../api/types.ts";

const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;

export interface AuthServiceOptions {
  database: Database;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  now?: () => number;
}

export interface RegisterInput {
  username: string;
  password: string;
  deviceName?: string;
}

export interface LoginInput {
  username: string;
  password: string;
  deviceName?: string;
}

export class AuthService {
  private readonly database: Database;
  private readonly jwtSecret: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly now: () => number;

  constructor(options: AuthServiceOptions) {
    this.database = options.database;
    this.jwtSecret = options.jwtSecret;
    this.accessTtl = options.accessTokenTtlSeconds;
    this.refreshTtl = options.refreshTokenTtlSeconds;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async register(input: RegisterInput): Promise<Tokens> {
    const username = input.username.trim();
    if (!USERNAME_PATTERN.test(username)) {
      throw badRequest("invalid_username", "username must be 3-32 characters of letters, digits, dot, dash or underscore");
    }
    const problems = passwordProblems(input.password, username);
    if (problems.length > 0) {
      throw badRequest("weak_password", `password rejected: ${problems.join(", ")}`);
    }
    const usernameLower = username.toLowerCase();
    if (this.findUserByName(usernameLower)) {
      throw conflict("username_taken", "that username is already registered");
    }

    const record: UserRecord = {
      id: newId("usr"),
      username,
      usernameLower,
      passwordHash: await hashPassword(input.password),
      createdAt: nowIso(),
      disabled: false,
    };
    this.database.users.put(record);
    // Users are small and rarely written; persist eagerly so a crash cannot lose the account.
    await this.database.flush();

    return this.issueTokens(record, input.deviceName ?? "unknown");
  }

  async login(input: LoginInput): Promise<Tokens> {
    const record = this.findUserByName(input.username.trim().toLowerCase());
    // Always run a hash comparison so that a missing user and a wrong password
    // take a similar amount of time.
    const stored = record?.passwordHash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const ok = await verifyPassword(input.password, stored);
    if (!record || !ok || record.disabled) {
      throw unauthorized("invalid username or password");
    }
    return this.issueTokens(record, input.deviceName ?? "unknown");
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    const result = verifyJwt<RefreshTokenClaims>(refreshToken, this.jwtSecret, this.now());
    if (!result.ok || result.claims.typ !== "refresh") {
      throw unauthorized("refresh token is invalid or expired");
    }
    const session = this.database.sessions.get(result.claims.sid);
    if (!session || session.revokedAt) {
      throw unauthorized("session has been revoked");
    }
    if (session.userId !== result.claims.sub) {
      throw unauthorized("refresh token subject mismatch");
    }
    if (session.refreshJti !== result.claims.jti) {
      // A rotated token came back: assume compromise and kill the session family.
      session.revokedAt = nowIso();
      this.database.sessions.put(session);
      await this.database.flush();
      throw unauthorized("refresh token reuse detected; session revoked");
    }

    const user = this.database.users.get(result.claims.sub);
    if (!user || user.disabled) {
      throw unauthorized("account is unavailable");
    }

    session.refreshJti = newToken(18);
    session.lastUsedAt = nowIso();
    this.database.sessions.put(session);

    return this.buildTokens(user, session);
  }

  async logout(refreshToken: string): Promise<void> {
    const result = verifyJwt<RefreshTokenClaims>(refreshToken, this.jwtSecret, this.now());
    if (!result.ok || result.claims.typ !== "refresh") return;
    const session = this.database.sessions.get(result.claims.sid);
    if (!session || session.revokedAt) return;
    session.revokedAt = nowIso();
    this.database.sessions.put(session);
    await this.database.flush();
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const session = this.database.sessions.get(sessionId);
    if (!session) return false;
    session.revokedAt = nowIso();
    this.database.sessions.put(session);
    await this.database.flush();
    return true;
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    const result = verifyJwt<AccessTokenClaims>(token, this.jwtSecret, this.now());
    if (!result.ok || result.claims.typ !== "access") {
      throw unauthorized(result.ok ? "wrong token type" : `access token rejected: ${result.reason}`);
    }
    const session = this.database.sessions.get(result.claims.sid);
    if (!session || session.revokedAt) {
      throw unauthorized("session has been revoked");
    }
    if (session.userId !== result.claims.sub) {
      throw unauthorized("token subject mismatch");
    }
    const user = this.database.users.get(result.claims.sub);
    if (!user || user.disabled) {
      throw unauthorized("account is unavailable");
    }
    return result.claims;
  }

  findUserById(userId: string): UserRecord | undefined {
    return this.database.users.get(userId);
  }

  private findUserByName(usernameLower: string): UserRecord | undefined {
    return this.database.users.find((candidate) => candidate.usernameLower === usernameLower);
  }

  private async issueTokens(user: UserRecord, deviceName: string): Promise<Tokens> {
    const session: SessionRecord = {
      id: newId("ses"),
      userId: user.id,
      refreshJti: newToken(18),
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
      expiresAt: new Date((this.now() + this.refreshTtl) * 1000).toISOString(),
      deviceName: deviceName.slice(0, 64),
      reuseCount: 0,
    };
    this.database.sessions.put(session);
    return this.buildTokens(user, session);
  }

  private buildTokens(user: UserRecord, session: SessionRecord): Tokens {
    const issuedAt = this.now();
    const accessToken = signJwt(
      {
        sub: user.id,
        username: user.username,
        sid: session.id,
        scopes: ["chat", "github"],
        typ: "access",
        iat: issuedAt,
        exp: issuedAt + this.accessTtl,
        jti: newToken(12),
      },
      this.jwtSecret,
    );
    const refreshToken = signJwt(
      {
        sub: user.id,
        sid: session.id,
        typ: "refresh",
        iat: issuedAt,
        exp: issuedAt + this.refreshTtl,
        jti: session.refreshJti,
      },
      this.jwtSecret,
    );
    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtl,
      user: toUser(user),
    };
  }
}

export function toUser(record: UserRecord): User {
  return { id: record.id, username: record.username, createdAt: record.createdAt };
}

export const validateUsername = (username: string): boolean => USERNAME_PATTERN.test(username);
