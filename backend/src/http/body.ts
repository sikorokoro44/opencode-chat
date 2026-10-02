/** Body reading with hard size limits, plus JSON parsing that never throws raw errors. */

import type { IncomingMessage } from "node:http";
import { badRequest, payloadTooLarge } from "./errors.ts";

export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const contentLength = Number.parseInt(req.headers["content-length"] ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      reject(payloadTooLarge("payload_too_large", `request body exceeds ${maxBytes} bytes`));
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(() => {
          req.pause();
          reject(payloadTooLarge("payload_too_large", `request body exceeds ${maxBytes} bytes`));
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", (error: Error) => finish(() => reject(error)));
    req.on("aborted", () => finish(() => reject(badRequest("client_aborted", "request aborted"))));
  });
}

export function parseJson(text: string): unknown {
  if (text.trim() === "") {
    throw badRequest("invalid_body", "request body must be valid JSON");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("invalid_json", "request body must be valid JSON");
  }
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return parseJson(await readBody(req, maxBytes));
}
