/** Provider-side failures with enough structure for the fallback runner to act on. */

export class ProviderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly modelId: string;
  /** Whether trying a different free model could plausibly succeed. */
  readonly retryable: boolean;

  constructor(code: string, status: number, modelId: string, retryable: boolean, detail?: string) {
    super(detail ? `${code} (${modelId}): ${detail}` : `${code} (${modelId})`);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.modelId = modelId;
    this.retryable = retryable;
  }
}

export class AllModelsFailedError extends Error {
  readonly attempts: { modelId: string; code: string; retryable: boolean }[];

  constructor(attempts: { modelId: string; code: string; retryable: boolean }[]) {
    super(`all candidate models failed (${attempts.length} attempt(s))`);
    this.name = "AllModelsFailedError";
    this.attempts = attempts;
  }
}
