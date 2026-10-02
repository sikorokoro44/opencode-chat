/**
 * Token-bucket rate limiting.
 *
 * One bucket per (subject, route-class) pair. Cheap enough to run per request and
 * precise enough to blunt credential stuffing and provider-quota abuse.
 */

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** Returns the remaining allowance and the wait before one more token is available. */
  take(key: string, cost = 1): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const timestamp = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.limit, updatedAt: timestamp };
    const elapsed = timestamp - bucket.updatedAt;
    const refillRate = this.limit / this.windowMs;
    const replenished = Math.min(this.limit, bucket.tokens + (elapsed / this.windowMs) * this.limit);
    const tokens = Math.max(0, replenished - cost);
    this.buckets.set(key, { tokens, updatedAt: timestamp });

    if (replenished >= cost) {
      return { allowed: true, remaining: Math.floor(replenished - cost), retryAfterMs: 0 };
    }
    const deficit = cost - replenished;
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(deficit / refillRate) };
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Progressively slower failure signal for repeated authentication failures.
 * Keeps a password-spraying attacker slower without ever revealing that it happened.
 */
export class AuthDelay {
  private readonly failures = new Map<string, { count: number; lastAt: number }>();
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;

  constructor(baseMs = 250, maxMs = 8_000, now: () => number = () => Date.now()) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.now = now;
  }

  /** Milliseconds the caller should wait before responding. */
  penaltyFor(key: string): number {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    const since = this.now() - entry.lastAt;
    if (since > 60_000) {
      this.failures.delete(key);
      return 0;
    }
    return Math.min(this.baseMs * 2 ** (entry.count - 1), this.maxMs);
  }

  recordFailure(key: string): number {
    const entry = this.failures.get(key) ?? { count: 0, lastAt: this.now() };
    entry.count = Math.min(entry.count + 1, 10);
    entry.lastAt = this.now();
    this.failures.set(key, entry);
    return Math.min(this.baseMs * 2 ** (entry.count - 1), this.maxMs);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  get size(): number {
    return this.failures.size;
  }
}
