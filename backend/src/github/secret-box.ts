/**
 * Encryption for GitHub tokens at rest.
 *
 * AES-256-GCM with a key derived from the configured 32-byte secret. Tokens are
 * never written to disk or logged in plaintext, and AAD binds a ciphertext to a
 * user id so a record cannot be copied between accounts.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { forbidden } from "../http/errors.ts";

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

export interface SecretBox {
  seal(plaintext: string, aad: string): string;
  open(ciphertext: string, aad: string): string;
}

const VERSION = "v1";

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** `v1.<iv-b64>.<tag-b64>.<ciphertext-b64>` */
export function createSecretBox(secret: string): SecretBox {
  if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
    throw new SecretBoxError("encryption key must be 64 hex characters");
  }
  const key = deriveKey(secret);

  return {
    seal(plaintext: string, aad: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
    },
    open(ciphertext: string, aad: string): string {
      const parts = ciphertext.split(".");
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new SecretBoxError("ciphertext format is not recognised");
      }
      const iv = Buffer.from(parts[1] as string, "base64url");
      const tag = Buffer.from(parts[2] as string, "base64url");
      const payload = Buffer.from(parts[3] as string, "base64url");
      if (iv.length !== 12 || tag.length !== 16) {
        throw new SecretBoxError("ciphertext is malformed");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretBoxError("ciphertext failed authentication");
      }
    },
  };
}

export class SecretStore {
  private readonly box: SecretBox | undefined;

  constructor(encryptionKey: string) {
    this.box = encryptionKey ? createSecretBox(encryptionKey) : undefined;
  }

  get enabled(): boolean {
    return this.box !== undefined;
  }

  seal(plaintext: string, aad: string): string {
    if (!this.box) {
      throw forbidden("secret_storage_disabled", "server is not configured to store credentials");
    }
    return this.box.seal(plaintext, aad);
  }

  open(ciphertext: string, aad: string): string {
    if (!this.box) {
      throw forbidden("secret_storage_disabled", "server is not configured to read stored credentials");
    }
    return this.box.open(ciphertext, aad);
  }
}
