/**
 * Completion orchestration: Big Pickle first, automatic free-model fallback.
 *
 * `streamCompletion` walks the registry's candidate chain. A model is abandoned
 * when it fails *before any token was emitted* (transport error, HTTP error, empty
 * stream) or when it trips the circuit breaker. Once text has reached the user the
 * answer is continued on the next model with an explicit notice, because silently
 * restarting mid-sentence would be worse than a visible seam.
 */

import type { Logger } from "../logger.ts";
import { AllModelsFailedError, ProviderError } from "./errors.ts";
import type { ProviderClient, ProviderEvent, ProviderMessage, ProviderRequest } from "./provider.ts";
import type { ModelRegistry, RegistryModel } from "./registry.ts";
import type { ProviderUsage } from "./provider.ts";

export interface CompletionOptions {
  registry: ModelRegistry;
  provider: ProviderClient;
  logger: Logger;
  baseUrlFor: (model: RegistryModel) => string;
  apiKeyFor: (model: RegistryModel) => string | undefined;
  timeoutMs: number;
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export interface CompletionRequest {
  messages: ProviderMessage[];
  requestedModelId?: string;
  /** Clamped down to the model's own limit by the runner. */
  maxOutputTokensOverride?: number;
  /** Emitted as soon as the first token of the winning model arrives. */
  onStart?: (modelId: string, fallbackDepth: number) => void;
  onDelta: (text: string) => void | Promise<void>;
  onFallback?: (from: string, to: string, reason: string) => void | Promise<void>;
}

export interface CompletionResult {
  modelId: string;
  requestedModelId: string;
  fallbackDepth: number;
  text: string;
  finishReason: string | null;
  usage: ProviderUsage;
  fallbackChain: string[];
}

export async function streamCompletion(
  options: CompletionOptions,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const candidates = options.registry.candidates(request.requestedModelId);
  if (candidates.length === 0) {
    throw new AllModelsFailedError([]);
  }

  const fallbackChain: string[] = [];
  const attempts: { modelId: string; code: string; retryable: boolean }[] = [];

  for (let depth = 0; depth < candidates.length; depth += 1) {
    const model = candidates[depth] as RegistryModel;
    if (options.signal.aborted) {
      throw new ProviderError("cancelled", 499, model.id, false);
    }

    const providerRequest: ProviderRequest = {
      model,
      messages: request.messages,
      baseUrl: options.baseUrlFor(model),
      apiKey: options.apiKeyFor(model),
      maxOutputTokens: Math.min(request.maxOutputTokensOverride ?? model.maxOutputTokens, model.maxOutputTokens),
      temperature: options.temperature,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      stream: true,
    };

    let emitted = "";
    let started = false;
    try {
      const iterator = options.provider.stream(providerRequest, depth + 1);
      let finishReason: string | null = null;
      let usage: ProviderUsage = {};

      for await (const event of iterator as AsyncIterable<ProviderEvent>) {
        if (event.type === "delta") {
          if (!started) {
            started = true;
            fallbackChain.push(model.id);
            request.onStart?.(model.id, depth);
          }
          emitted += event.text;
          await request.onDelta(event.text);
        } else {
          finishReason = event.finishReason;
          usage = event.usage;
        }
      }

      if (!started) {
        throw new ProviderError("provider_returned_no_tokens", 502, model.id, true);
      }

      options.registry.recordSuccess(model.id);
      return {
        modelId: model.id,
        requestedModelId: request.requestedModelId ?? options.registry.primaryModelId,
        fallbackDepth: depth,
        text: emitted,
        finishReason,
        usage,
        fallbackChain,
      };
    } catch (error) {
      if (options.signal.aborted) {
        throw new ProviderError("cancelled", 499, model.id, false);
      }
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError("provider_error", 502, model.id, true, String((error as Error)?.message ?? error));

      options.registry.recordFailure(model.id);
      attempts.push({ modelId: model.id, code: providerError.code, retryable: providerError.retryable });
      options.logger.warn("model attempt failed", {
        model: model.id,
        code: providerError.code,
        emittedChars: emitted.length,
        fallbackDepth: depth,
      });

      const hasNext = depth + 1 < candidates.length;
      if (!hasNext) break;

      const next = candidates[depth + 1] as RegistryModel;
      const notice = started
        ? `\n\n_(continuing on ${next.displayName} after ${model.displayName} failed mid-response)_\n\n`
        : "";
      if (notice !== "") {
        await request.onDelta(notice);
        emitted += notice;
      }
      await request.onFallback?.(model.id, next.id, providerError.code);
    }
  }

  throw new AllModelsFailedError(attempts);
}

export type { ProviderMessage };
