/**
 * Attachment ingestion.
 *
 * Uploads arrive as base64 inside a JSON body (mobile-friendly). The declared
 * MIME type is never trusted: the bytes are sniffed, and only allow-listed image and
 * text types are accepted. Everything is capped in size and served with
 * `X-Content-Type-Options: nosniff` and a restrictive CSP.
 */

import { newId, nowIso } from "../ids.ts";
import { badRequest, payloadTooLarge } from "../http/errors.ts";
import { writeBlob } from "../store/database.ts";
import type { AttachmentRecord } from "../store/records.ts";

const IMAGE_SNIFFS: { mime: string; magic: number[]; extension: string }[] = [
  { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47], extension: "png" },
  { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff], extension: "jpg" },
  { mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38], extension: "gif" },
];

const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "application/x-yaml",
  "text/yaml",
  "text/x-diff",
  "text/x-log",
]);

export interface AttachmentLimits {
  maxBytes: number;
  maxImageBytes: number;
  /** Attachments are only useful as context for the reply that follows. */
  ttlMs?: number;
}

export interface StoreAttachmentInput {
  userId: string;
  mimeType: string;
  fileName?: string;
  data: Buffer;
  chatId?: string;
  directory: string;
}

/** PNG/JPEG/GIF header dimensions, or undefined when not parseable. */
export function imageDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.subarray(1, 4).toString("latin1") === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1] as number;
      const length = buffer.readUInt16BE(offset + 2);
      // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return undefined;
  }
  if (buffer.length >= 10 && buffer.subarray(0, 4).toString("latin1") === "GIF8") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  return undefined;
}

export function detectMimeType(buffer: Buffer, declared: string): string {
  for (const sniff of IMAGE_SNIFFS) {
    if (sniff.magic.every((byte, index) => buffer[index] === byte)) return sniff.mime;
  }
  const normalized = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  if (TEXT_MIMES.has(normalized) && isProbablyText(buffer)) return normalized;
  return normalized === "" ? "application/octet-stream" : normalized;
}

function isProbablyText(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 4096);
  for (let index = 0; index < limit; index += 1) {
    const byte = buffer[index] as number;
    if (byte === 0) return false;
    // Control characters other than tab/newline/carriage return.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

export function decodeBase64Strict(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length === 0 || compact.length % 4 !== 0) {
    throw badRequest("invalid_base64", "attachment data must be base64 encoded");
  }
  const buffer = Buffer.from(compact, "base64");
  if (buffer.length === 0) {
    throw badRequest("invalid_base64", "attachment data must not be empty");
  }
  return buffer;
}

export function attachmentKind(mimeType: string): "image" | "text" | "binary" {
  if (mimeType.startsWith("image/")) return "image";
  if (TEXT_MIMES.has(mimeType)) return "text";
  return "binary";
}

/** Validates and stores an upload, returning the persisted record. */
export async function storeAttachment(input: StoreAttachmentInput, limits: AttachmentLimits): Promise<AttachmentRecord> {
  const bytes = input.data;
  if (bytes.length === 0) {
    throw badRequest("empty_attachment", "attachment must not be empty");
  }
  if (bytes.length > limits.maxBytes) {
    throw payloadTooLarge("attachment_too_large", `attachments are limited to ${limits.maxBytes} bytes`);
  }

  const mimeType = detectMimeType(bytes, input.mimeType);
  const kind = attachmentKind(mimeType);
  if (kind === "binary") {
    throw badRequest("unsupported_media_type", `unsupported attachment type: ${mimeType}`);
  }
  if (kind === "image" && bytes.length > limits.maxImageBytes) {
    throw payloadTooLarge("image_too_large", `images are limited to ${limits.maxImageBytes} bytes`);
  }

  const id = newId("att");
  await writeBlob(input.directory, id, bytes);
  const dimensions = kind === "image" ? imageDimensions(bytes) : undefined;

  const record: AttachmentRecord = {
    id,
    userId: input.userId,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    mimeType,
    sizeBytes: bytes.length,
    kind,
    ...(input.fileName ? { fileName: input.fileName.slice(0, 128) } : {}),
    ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + (limits.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString(),
  };
  return record;
}

/** Headers used when serving attachment bytes. */
export function attachmentResponseHeaders(mimeType: string): Record<string, string> {
  return {
    "content-type": mimeType,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, max-age=300",
    "content-disposition": "inline",
  };
}
