/**
 * Tiny path router with parameter extraction.
 *
 * Hand-rolled to keep the backend dependency-free, which keeps the CI install
 * step fast and removes supply-chain risk from the credential-handling path.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | string[] | undefined>;
  body(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  principal?: Principal;
  /** Set by the auth middleware. */
  setPrincipal(principal: Principal): void;
}

export interface Principal {
  userId: string;
  username: string;
  /** Session id so a single device can be revoked. */
  sessionId: string;
  scopes: readonly string[];
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

interface CompiledRoute {
  method: string;
  segments: string[];
  handler: Handler;
  /** Routes without this flag require an authenticated principal. */
  public: boolean;
  scopes: readonly string[];
}

export interface RouteOptions {
  public?: boolean;
  scopes?: readonly string[];
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(method: string, pattern: string, handler: Handler, options: RouteOptions = {}): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(pattern),
      handler,
      public: options.public ?? false,
      scopes: options.scopes ?? [],
    });
    return this;
  }

  get(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add("GET", pattern, handler, options);
  }

  post(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add("POST", pattern, handler, options);
  }

  put(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add("PUT", pattern, handler, options);
  }

  patch(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add("PATCH", pattern, handler, options);
  }

  delete(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add("DELETE", pattern, handler, options);
  }

  /** Registered route patterns, used by the OpenAPI contract test. */
  routeSignatures(): string[] {
    return this.routes.map((route) => `${route.method} /${route.segments.join("/")}`);
  }

  match(
    method: string,
    path: string,
  ): { route: CompiledRoute; params: Record<string, string> } | { allowed: string[] } | null {
    const segments = splitPath(path);
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (params === null) continue;
      if (route.method !== method.toUpperCase()) {
        allowed.add(route.method);
        continue;
      }
      return { route, params };
    }
    if (allowed.size > 0) return { allowed: [...allowed].sort() };
    return null;
  }
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    const received = actual[index] as string;
    if (expected.startsWith("{") && expected.endsWith("}")) {
      const decoded = safeDecode(received);
      if (decoded === null) return null;
      params[expected.slice(1, -1)] = decoded;
    } else if (expected !== received) {
      return null;
    }
  }
  return params;
}

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    // Reject decoded control characters and traversal segments.
    if (/[\u0000-\u001f]/.test(decoded)) return null;
    if (decoded === "." || decoded === ".." || decoded.includes("/")) return null;
    return decoded;
  } catch {
    return null;
  }
}
