/** Typed HTTP errors and the single place that maps them to wire responses. */

export interface WireError {
  code: string;
  message: string;
  retryable: boolean;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryable?: boolean; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.headers = options.headers ?? {};
  }

  toWire(): WireError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export const badRequest = (code: string, message: string): HttpError => new HttpError(400, code, message);
export const unauthorized = (message = "authentication required"): HttpError =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (code: string, message: string): HttpError => new HttpError(403, code, message);
export const notFound = (code: string, message: string): HttpError => new HttpError(404, code, message);
export const conflict = (code: string, message: string): HttpError => new HttpError(409, code, message);
export const payloadTooLarge = (code: string, message: string): HttpError =>
  new HttpError(413, code, message);
export const tooManyRequests = (retryAfterSeconds: number): HttpError =>
  new HttpError(429, "rate_limited", "too many requests", {
    retryable: true,
    headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
export const unavailable = (code: string, message: string): HttpError =>
  new HttpError(503, code, message, { retryable: true });
