/** HTTP response helpers shared by the app pipeline and the route handlers. */

import type { ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { HttpError } from "./errors.ts";
import { AllModelsFailedError, ProviderError } from "../models/errors.ts";
import type { Logger } from "../logger.ts";

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function writeNoContent(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

export function writeError(res: ServerResponse, error: HttpError, logger: Logger, requestId?: string): void {
  if (res.writableEnded) return;
  const level = error.status >= 500 ? "error" : "warn";
  logger[level]("request rejected", { requestId, status: error.status, code: error.code });
  for (const [key, value] of Object.entries(error.headers)) res.setHeader(key, value);
  writeJson(res, error.status, { error: error.toWire() });
}

/** Normalises anything thrown in a handler into a safe HTTP error. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof AllModelsFailedError) {
    const last = error.attempts[error.attempts.length - 1];
    return new HttpError(502, "all_models_failed", `every free model failed; last error: ${last?.code ?? "unknown"}`, {
      retryable: true,
    });
  }
  if (error instanceof ProviderError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502;
    return new HttpError(status, error.code, error.message, { retryable: error.retryable });
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "unknown_model") return new HttpError(400, code, message);
  return new HttpError(500, "internal_error", message);
}

export function clientAddress(req: IncomingMessage): string {
  const socket: Socket | undefined = req.socket;
  const address = socket?.remoteAddress ?? "unknown";
  // Collapse IPv4-mapped IPv6 so one client cannot get two rate-limit buckets.
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/** Best-effort client identity for auth throttling, honouring one proxy hop. */
export function clientIdentity(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === "string" && raw !== "") return raw.split(",")[0]?.trim() ?? raw;
  return clientAddress(req);
}
