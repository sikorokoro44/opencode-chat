/**
 * Free-model registry.
 *
 * `shared/models.json` is the single source of truth. This module loads it, keeps
 * an in-memory index, exposes live health, and produces the ordered candidate list
 * used by the fallback runner. Anything not in the allow-list can never be called,
 * which is what makes the "free models only" guarantee enforceable rather than aspirational.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../ids.ts";
import type { ModelInfo } from "../api/types.ts";

export interface RegistryModel {
  id: string;
  displayName: string;
  provider: string;
  endpoint: string;
  capabilities: string[];
  contextWindow: number;
  maxOutputTokens: number;
  priority: number;
  fallbackOnly: boolean;
}

export interface ModelRegistrySnapshot {
  version: number;
  primaryModelId: string;
  maxFallbackDepth: number;
  models: RegistryModel[];
}

export class ModelRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRegistryError";
  }
}

const here = dirname(fileURLToPath(import.meta.url));
/** backend/src/models -> repository root. */
export const MODELS_FILE = join(here, "..", "..", "..", "shared", "models.json");

/** Model ids are lowercase slugs; dots are allowed (e.g. gemini-2.5-flash-lite). */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isValidModelId = (id: string): boolean =>
  ID_PATTERN.test(id) && !id.includes("..") && !id.endsWith(".") && !id.endsWith("-");
const PROVIDERS = new Set(["opencode-zen", "openrouter", "custom"]);
const CAPABILITIES = new Set(["text", "vision", "tools", "streaming"]);

export function parseModelRegistry(raw: string): ModelRegistrySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelRegistryError("model registry is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ModelRegistryError("model registry must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const version = record["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ModelRegistryError("model registry version must be a positive integer");
  }
  const primaryModelId = record["primaryModelId"];
  if (primaryModelId !== "big-pickle") {
    throw new ModelRegistryError('model registry primaryModelId must be "big-pickle"');
  }
  const maxFallbackDepth = record["maxFallbackDepth"];
  if (typeof maxFallbackDepth !== "number" || !Number.isInteger(maxFallbackDepth) || maxFallbackDepth < 1 || maxFallbackDepth > 8) {
    throw new ModelRegistryError("maxFallbackDepth must be an integer between 1 and 8");
  }
  if (!Array.isArray(record["models"]) || record["models"].length < 2) {
    throw new ModelRegistryError("model registry must contain at least two models");
  }

  const models: RegistryModel[] = [];
  const seen = new Set<string>();
  for (const entry of record["models"] as unknown[]) {
    const model = parseModel(entry);
    if (seen.has(model.id)) {
      throw new ModelRegistryError(`duplicate model id ${model.id}`);
    }
    seen.add(model.id);
    models.push(model);
  }

  models.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

  const primary = models.find((model) => model.id === primaryModelId);
  if (!primary) {
    throw new ModelRegistryError("primary model big-pickle is missing from the registry");
  }
  if (primary.priority !== 0) {
    throw new ModelRegistryError("the primary model must have priority 0");
  }
  if (primary.fallbackOnly) {
    throw new ModelRegistryError("the primary model must be directly selectable");
  }
  if (!models.some((model) => model.fallbackOnly)) {
    throw new ModelRegistryError("the registry must define at least one fallback-only model");
  }

  return { version, primaryModelId, maxFallbackDepth, models };
}

function parseModel(entry: unknown): RegistryModel {
  if (typeof entry !== "object" || entry === null) {
    throw new ModelRegistryError("each model must be an object");
  }
  const record = entry as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || !isValidModelId(id)) {
    throw new ModelRegistryError(`invalid model id: ${String(id)}`);
  }
  const provider = record["provider"];
  if (typeof provider !== "string" || !PROVIDERS.has(provider)) {
    throw new ModelRegistryError(`model ${id} has an unknown provider`);
  }
  const endpoint = record["endpoint"];
  if (typeof endpoint !== "string" || !endpoint.startsWith("/") || endpoint.includes("..")) {
    throw new ModelRegistryError(`model ${id} endpoint must be a relative path`);
  }
  const capabilities = record["capabilities"];
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new ModelRegistryError(`model ${id} must declare capabilities`);
  }
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !CAPABILITIES.has(capability)) {
      throw new ModelRegistryError(`model ${id} has an unknown capability`);
    }
  }
  const contextWindow = record["contextWindow"];
  const maxOutputTokens = record["maxOutputTokens"];
  const priority = record["priority"];
  if (typeof contextWindow !== "number" || contextWindow < 1024) {
    throw new ModelRegistryError(`model ${id} contextWindow is invalid`);
  }
  if (typeof maxOutputTokens !== "number" || maxOutputTokens < 16) {
    throw new ModelRegistryError(`model ${id} maxOutputTokens is invalid`);
  }
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 100) {
    throw new ModelRegistryError(`model ${id} priority is invalid`);
  }
  const displayName = record["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0 || displayName.length > 64) {
    throw new ModelRegistryError(`model ${id} displayName is invalid`);
  }
  const fallbackOnly = record["fallbackOnly"] ?? false;
  if (typeof fallbackOnly !== "boolean") {
    throw new ModelRegistryError(`model ${id} fallbackOnly must be a boolean`);
  }

  return {
    id,
    displayName,
    provider,
    endpoint,
    capabilities: capabilities as string[],
    contextWindow,
    maxOutputTokens,
    priority,
    fallbackOnly,
  };
}

export interface HealthSnapshot {
  healthy: boolean;
  cooldownSeconds: number;
  failures: number;
  successes: number;
}

export interface ModelRegistryOptions {
  snapshot: ModelRegistrySnapshot;
  now?: () => number;
  /** Consecutive failures before a model is put into cooldown. */
  failureThreshold?: number;
  /** Cooldown length in milliseconds. */
  cooldownMs?: number;
}

export class ModelRegistry {
  readonly snapshot: ModelRegistrySnapshot;
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly state = new Map<string, { failures: number; successes: number; cooldownUntil: number }>();

  constructor(options: ModelRegistryOptions) {
    this.snapshot = options.snapshot;
    this.now = options.now ?? (() => Date.now());
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    for (const model of this.snapshot.models) {
      this.state.set(model.id, { failures: 0, successes: 0, cooldownUntil: 0 });
    }
  }

  static fromFile(path = MODELS_FILE): ModelRegistry {
    return new ModelRegistry({ snapshot: parseModelRegistry(readFileSync(path, "utf8")) });
  }

  get primaryModelId(): string {
    return this.snapshot.primaryModelId;
  }

  get maxFallbackDepth(): number {
    return this.snapshot.maxFallbackDepth;
  }

  all(): RegistryModel[] {
    return [...this.snapshot.models];
  }

  find(id: string): RegistryModel | undefined {
    return this.snapshot.models.find((model) => model.id === id);
  }

  require(id: string): RegistryModel {
    const model = this.find(id);
    if (!model) {
      const error = new Error(`model ${id} is not in the free-model allow-list`);
      (error as Error & { code?: string }).code = "unknown_model";
      throw error;
    }
    return model;
  }

  /** Models the user may pick directly, primary first. */
  selectable(): RegistryModel[] {
    return this.snapshot.models.filter((model) => !model.fallbackOnly);
  }

  supports(modelId: string, capability: string): boolean {
    return this.require(modelId).capabilities.includes(capability);
  }

  health(modelId: string): HealthSnapshot {
    const entry = this.state.get(modelId) ?? { failures: 0, successes: 0, cooldownUntil: 0 };
    const remainingMs = Math.max(0, entry.cooldownUntil - this.now());
    return {
      healthy: remainingMs === 0,
      cooldownSeconds: Math.ceil(remainingMs / 1000),
      failures: entry.failures,
      successes: entry.successes,
    };
  }

  recordSuccess(modelId: string): void {
    const entry = this.entry(modelId);
    entry.successes += 1;
    entry.failures = 0;
    entry.cooldownUntil = 0;
  }

  recordFailure(modelId: string): void {
    const entry = this.entry(modelId);
    entry.failures += 1;
    if (entry.failures >= this.failureThreshold) {
      // Exponential backoff, capped at 5 minutes, so a dead provider is retried rarely.
      const backoff = Math.min(this.cooldownMs * 2 ** (entry.failures - this.failureThreshold), 300_000);
      entry.cooldownUntil = this.now() + backoff;
    }
  }

  /**
   * Candidate chain for a request.
   *  - an explicitly requested model is tried first (when it is healthy),
   *  - then the primary model (Big Pickle),
   *  - then fallback-only models by priority, skipping unhealthy ones.
   */
  candidates(requestedModelId?: string): RegistryModel[] {
    const chain: RegistryModel[] = [];
    const push = (model: RegistryModel | undefined) => {
      if (model && !chain.some((existing) => existing.id === model.id)) chain.push(model);
    };

    if (requestedModelId && requestedModelId !== this.snapshot.primaryModelId) {
      const requested = this.find(requestedModelId);
      if (requested && !this.health(requested.id).healthy) {
        push(undefined);
      } else {
        push(requested);
      }
    }
    push(this.find(this.snapshot.primaryModelId));

    const healthyFallbacks = this.snapshot.models.filter(
      (model) => model.fallbackOnly && this.health(model.id).healthy,
    );
    // If every fallback is in cooldown, still offer one so the request can succeed.
    const fallbacks = healthyFallbacks.length > 0
      ? healthyFallbacks
      : this.snapshot.models.filter((model) => model.fallbackOnly);
    for (const model of fallbacks) push(model);

    return chain.slice(0, this.snapshot.maxFallbackDepth + 1);
  }

  publicInfo(): ModelInfo[] {
    return this.all().map((model) => {
      const health = this.health(model.id);
      return {
        id: model.id,
        displayName: model.displayName,
        provider: model.provider,
        capabilities: model.capabilities,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        priority: model.priority,
        fallbackOnly: model.fallbackOnly,
        healthy: health.healthy,
        cooldownSeconds: health.cooldownSeconds,
      };
    });
  }

  private entry(modelId: string): { failures: number; successes: number; cooldownUntil: number } {
    let entry = this.state.get(modelId);
    if (!entry) {
      entry = { failures: 0, successes: 0, cooldownUntil: 0 };
      this.state.set(modelId, entry);
    }
    return entry;
  }
}

/** Correlation id attached to every provider attempt. */
export const newAttemptId = (): string => newId("att");
