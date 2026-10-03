/**
 * Application composition root.
 *
 * `createApp` wires every service, builds the router and returns an `http.Server`
 * plus the handles tests need. Nothing here reads `process.env` except the default
 * `loadConfig()` call, so tests inject a deterministic config and a fake `fetch`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { loadConfig, type Config } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { newId } from "../ids.ts";
import { parseJson, readBody } from "../http/body.ts";
import { HttpError, notFound, tooManyRequests, unauthorized } from "../http/errors.ts";
import { clientIdentity, toHttpError, writeError, writeJson } from "../http/respond.ts";
import { Router, type Principal, type RequestContext } from "../http/router.ts";
import { AuthDelay, RateLimiter } from "../http/rate-limit.ts";
import { AuthService } from "../auth/auth-service.ts";
import { ChatService } from "../chat/chat-service.ts";
import { ModelRegistry } from "../models/registry.ts";
import { ProviderClient } from "../models/provider.ts";
import { AllModelsFailedError, ProviderError } from "../models/errors.ts";
import { GitHubService } from "../github/github-service.ts";
import { SecretStore } from "../github/secret-box.ts";
import { CodingAgent } from "../github/coding-agent.ts";
import { openDatabase, type Database } from "../store/database.ts";
import { registerRoutes } from "./routes.ts";
import type { RouteDependencies } from "./dependencies.ts";

export interface App {
  server: Server;
  router: Router;
  config: Config;
  logger: Logger;
  database: Database;
  auth: AuthService;
  chats: ChatService;
  registry: ModelRegistry;
  provider: ProviderClient;
  github: GitHubService;
  agent: CodingAgent;
  rateLimiter: RateLimiter;
  listen(port?: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

export interface CreateAppOptions {
  config?: Config;
  logger?: Logger;
  database?: Database;
  fetchImpl?: typeof fetch;
  /** Overrides the file holding the free-model allow-list (used by tests). */
  modelsFile?: string;
}

export async function createApp(options: CreateAppOptions = {}): Promise<App> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const registry = ModelRegistry.fromFile(options.modelsFile);

  const database =
    options.database ??
    (await openDatabase({ directory: config.databaseDir, flushDelayMs: 25, logger }));

  const auth = new AuthService({
    database,
    jwtSecret: config.jwtSecret,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
  });

  const chats = new ChatService({ database, registry });
  const provider = new ProviderClient({ fetchImpl: options.fetchImpl });
  const github = new GitHubService({
    baseUrl: config.githubApiBaseUrl,
    serviceToken: config.githubServiceToken,
    bootstrapToken: config.adminBootstrapToken,
    secretStore: new SecretStore(config.githubTokenEncryptionKey),
    fetchImpl: options.fetchImpl,
    memoryPath: config.githubMemoryPath,
  });

  const agent = new CodingAgent({
    registry,
    provider,
    github,
    logger,
    baseUrlFor: (model) => config.providerBaseUrls[model.provider] ?? "",
    apiKeyFor: (model) => config.providerApiKeys[model.provider],
    timeoutMs: config.providerTimeoutMs,
  });

  const rateLimiter = new RateLimiter({ limit: config.requestsPerMinute, windowMs: 60_000 });
  const dependencies: RouteDependencies = {
    config,
    logger,
    database,
    auth,
    chats,
    registry,
    provider,
    github,
    agent,
    rateLimiter,
    authRateLimiter: new RateLimiter({ limit: config.authAttemptsPerMinute, windowMs: 60_000 }),
    authDelay: new AuthDelay(),
    baseUrlFor: (model) => config.providerBaseUrls[model.provider] ?? "",
    apiKeyFor: (model) => config.providerApiKeys[model.provider],
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    startedAt: Date.now(),
  };

  const router = new Router();
  registerRoutes(router, dependencies);

  const server = createServer((req, res) => {
    void handleRequest(req, res, { router, dependencies, logger, rateLimiter }).catch((error: unknown) => {
      logger.error("unhandled request failure", { error: String(error) });
      if (!res.headersSent) writeError(res, new HttpError(500, "internal_error", "internal server error"), logger);
      else res.end();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  // Streaming responses are long-lived by design, so no global request timeout.
  server.requestTimeout = 0;

  return {
    server,
    router,
    config,
    logger,
    database,
    auth,
    chats,
    registry,
    provider,
    github,
    agent,
    rateLimiter,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.removeListener("error", onError);
          const address = server.address();
          const actualPort = typeof address === "object" && address !== null ? address.port : port;
          resolve({ port: actualPort, host });
        });
      });
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      await database.close();
    },
  };
}

interface RequestPipeline {
  router: Router;
  dependencies: RouteDependencies;
  logger: Logger;
  rateLimiter: RateLimiter;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pipeline: RequestPipeline,
): Promise<void> {
  const { router, dependencies, logger, rateLimiter } = pipeline;
  const requestId = newId("req");
  const startedAt = Date.now();
  res.setHeader("x-request-id", requestId);

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = router.match(req.method ?? "GET", url.pathname);

  if (match === null) {
    writeError(res, notFound("route_not_found", `no route for ${req.method ?? "GET"} ${url.pathname}`), logger, requestId);
    return;
  }
  if ("allowed" in match) {
    res.setHeader("allow", match.allowed.join(", "));
    writeError(res, new HttpError(405, "method_not_allowed", "method not allowed"), logger, requestId);
    return;
  }

  const { route, params } = match;
  const isHealthCheck = route.segments.length === 1 && route.segments[0] === "health";
  if (!isHealthCheck && !route.public) {
    // Same server-side identity the auth limiter uses, so a forged
    // `X-Forwarded-For` cannot buy extra buckets here either.
    const bucket = rateLimiter.take(
      `${clientIdentity(req, dependencies.config.trustProxy)}:${route.method}:${route.segments.length}`,
    );
    if (!bucket.allowed) {
      const error = tooManyRequests(bucket.retryAfterMs / 1000);
      writeError(res, error, logger, requestId);
      return;
    }
  }

  const ctx = createContext(req, res, url, params, dependencies.maxRequestBodyBytes);
  try {
    if (!route.public) {
      ctx.setPrincipal(authenticate(ctx, dependencies.auth));
    }
    const result = await route.handler(ctx);
    if (result === undefined || res.writableEnded) return; // handler wrote the response itself
    writeJson(res, 200, result);
  } catch (error) {
    writeError(res, toHttpError(error), logger, requestId);
  } finally {
    logger.debug("request handled", {
      requestId,
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  }
}

function createContext(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  params: Record<string, string>,
  maxBodyBytes: number,
): RequestContext {
  let bodyPromise: Promise<string> | undefined;
  const context: RequestContext = {
    req,
    res,
    method: req.method ?? "GET",
    url,
    path: url.pathname,
    params,
    query: url.searchParams,
    headers: req.headers,
    body() {
      bodyPromise ??= readBody(req, maxBodyBytes);
      return bodyPromise;
    },
    async json<T>(): Promise<T> {
      return parseJson(await context.body()) as T;
    },
    setPrincipal(principal: Principal) {
      context.principal = principal;
    },
  };
  return context;
}

function authenticate(ctx: RequestContext, auth: AuthService): Principal {
  const header = ctx.headers["authorization"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string" || !raw.toLowerCase().startsWith("bearer ")) {
    throw unauthorized("missing bearer token");
  }
  const claims = auth.verifyAccessToken(raw.slice(7).trim());
  return { userId: claims.sub, username: claims.username, sessionId: claims.sid, scopes: claims.scopes };
}
