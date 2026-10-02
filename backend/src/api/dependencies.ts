/** Service handles every route handler needs, assembled once in `createApp`. */

import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { AuthService } from "../auth/auth-service.ts";
import type { ChatService } from "../chat/chat-service.ts";
import type { ModelRegistry } from "../models/registry.ts";
import type { ProviderClient } from "../models/provider.ts";
import type { GitHubService } from "../github/github-service.ts";
import type { CodingAgent } from "../github/coding-agent.ts";
import type { Database } from "../store/database.ts";
import type { AuthDelay, RateLimiter } from "../http/rate-limit.ts";

export interface RouteDependencies {
  readonly config: Config;
  readonly logger: Logger;
  readonly database: Database;
  readonly auth: AuthService;
  readonly chats: ChatService;
  readonly registry: ModelRegistry;
  readonly provider: ProviderClient;
  readonly github: GitHubService;
  readonly agent: CodingAgent;
  readonly rateLimiter: RateLimiter;
  readonly authRateLimiter: RateLimiter;
  readonly authDelay: AuthDelay;
  readonly baseUrlFor: (model: { provider: string }) => string;
  readonly apiKeyFor: (model: { provider: string }) => string | undefined;
  readonly maxRequestBodyBytes: number;
  readonly startedAt: number;
}
