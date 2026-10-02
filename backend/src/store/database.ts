/**
 * Durable JSON collections with atomic writes and debounced flushing.
 *
 * Chosen deliberately over a SQL dependency: the write volume is low (chat
 * messages and agent commits), reads dominate, and a single JSON document per
 * collection keeps the resident set small and the CI install step dependency-free.
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger, nullLogger, type Logger } from "../logger.ts";
import type {
  AttachmentRecord,
  ChatRecord,
  MessageRecord,
  SessionRecord,
  UserRecord,
} from "./records.ts";

export interface Collection<T extends { id: string }> {
  get(id: string): T | undefined;
  put(value: T): T;
  putMany(values: readonly T[]): void;
  delete(id: string): boolean;
  values(): IterableIterator<T>;
  filter(predicate: (value: T) => boolean): T[];
  find(predicate: (value: T) => boolean): T | undefined;
  count(predicate?: (value: T) => boolean): number;
  clear(): void;
  readonly size: number;
}

export interface JsonCollectionOptions {
  /** Persist at most this long after a mutation (ms). */
  flushDelayMs?: number;
  logger?: Logger;
  /** When false the collection only lives in memory (used by tests). */
  persist?: boolean;
}

export class JsonCollection<T extends { id: string }> implements Collection<T> {
  private readonly items = new Map<string, T>();
  private readonly file: string;
  private readonly flushDelayMs: number;
  private readonly logger: Logger;
  private readonly persist: boolean;
  private flushTimer: NodeJS.Timeout | undefined;
  private pendingFlush: Promise<void> | undefined;
  private flushSeq = 0;
  private dirty = false;

  constructor(directory: string, name: string, options: JsonCollectionOptions = {}) {
    this.file = join(directory, `${name}.json`);
    this.flushDelayMs = options.flushDelayMs ?? 50;
    this.logger = options.logger ?? createLogger({ level: "silent" });
    this.persist = options.persist ?? true;
  }

  get size(): number {
    return this.items.size;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.logger.debug("collection missing, starting empty", { file: this.file });
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // A truncated or corrupted file must not take down the whole server: keep
      // it for forensics and continue with an empty collection.
      const quarantine = `${this.file}.corrupt`;
      await rename(this.file, quarantine).catch(() => undefined);
      this.logger.error("collection file was corrupt and has been quarantined", {
        file: this.file,
        quarantine,
        message: String((error as Error)?.message ?? error),
      });
      return;
    }

    if (!Array.isArray(parsed)) {
      this.logger.warn("collection file is not an array; ignoring its contents", { file: this.file });
      return;
    }
    for (const item of parsed) {
      if (item && typeof item.id === "string") this.items.set(item.id, item);
    }
    this.logger.debug("collection loaded", { file: this.file, rows: this.items.size });
  }

  get(name: string): T | undefined {
    return this.items.get(name);
  }

  put(value: T): T {
    this.items.set(value.id, value);
    this.scheduleFlush();
    return value;
  }

  putMany(values: readonly T[]): void {
    for (const value of values) this.items.set(value.id, value);
    this.scheduleFlush();
  }

  delete(name: string): boolean {
    const removed = this.items.delete(name);
    if (removed) this.scheduleFlush();
    return removed;
  }

  values(): IterableIterator<T> {
    return this.items.values();
  }

  filter(predicate: (value: T) => boolean): T[] {
    const out: T[] = [];
    for (const value of this.items.values()) {
      if (predicate(value)) out.push(value);
    }
    return out;
  }

  find(predicate: (value: T) => boolean): T | undefined {
    for (const value of this.items.values()) {
      if (predicate(value)) return value;
    }
    return undefined;
  }

  count(predicate?: (value: T) => boolean): number {
    if (!predicate) return this.items.size;
    let total = 0;
    for (const value of this.items.values()) {
      if (predicate(value)) total += 1;
    }
    return total;
  }

  clear(): void {
    this.items.clear();
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  /** Atomic: write to a sibling temp file then rename. */
  async flush(): Promise<void> {
    if (!this.persist) return;
    // Wait for an in-flight flush even when nothing is dirty: `close()` relies on
    // this to avoid deleting the database directory mid-rename.
    if (this.pendingFlush) {
      await this.pendingFlush;
      return this.flush();
    }
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot = JSON.stringify([...this.items.values()], null, 2);
    this.pendingFlush = (async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${(this.flushSeq += 1)}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.file);
    })();
    try {
      await this.pendingFlush;
    } catch (error) {
      this.logger.error("collection flush failed", { file: this.file, error: String(error) });
      this.dirty = true;
      throw error;
    } finally {
      this.pendingFlush = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }
}

export interface DatabaseOptions {
  directory: string;
  flushDelayMs?: number;
  logger?: Logger;
}

export interface Database {
  readonly directory: string;
  users: Collection<UserRecord>;
  chats: Collection<ChatRecord>;
  messages: Collection<MessageRecord>;
  attachments: Collection<AttachmentRecord>;
  sessions: Collection<SessionRecord>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export async function openDatabase(options: DatabaseOptions): Promise<Database> {
  const directory = options.directory;
  const logger = options.logger ?? nullLogger;
  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, "blobs"), { recursive: true });

  const make = <T extends { id: string }>(name: string): JsonCollection<T> =>
    new JsonCollection<T>(directory, name, { flushDelayMs: options.flushDelayMs, logger });

  const users = make<UserRecord>("users");
  const chats = make<ChatRecord>("chats");
  const messages = make<MessageRecord>("messages");
  const attachments = make<AttachmentRecord>("attachments");
  const sessions = make<SessionRecord>("sessions");

  await Promise.all([
    users.load(),
    chats.load(),
    messages.load(),
    attachments.load(),
    sessions.load(),
  ]);

  return {
    directory,
    users,
    chats,
    messages,
    attachments,
    sessions,
    flush: async () => {
      await Promise.all([
        users.flush(),
        chats.flush(),
        messages.flush(),
        attachments.flush(),
        sessions.flush(),
      ]);
    },
    close: async () => {
      await Promise.all([
        users.close(),
        chats.close(),
        messages.close(),
        attachments.close(),
        sessions.close(),
      ]);
    },
  };
}

/** In-memory database used by tests. */
export function createMemoryDatabase(): Database {
  const make = <T extends { id: string }>(name: string): JsonCollection<T> =>
    new JsonCollection<T>("/nonexistent", name, { flushDelayMs: 0, logger: nullLogger, persist: false });
  return {
    directory: "/nonexistent",
    users: make<UserRecord>("users"),
    chats: make<ChatRecord>("chats"),
    messages: make<MessageRecord>("messages"),
    attachments: make<AttachmentRecord>("attachments"),
    sessions: make<SessionRecord>("sessions"),
    flush: async () => {},
    close: async () => {},
  };
}

export const blobPath = (directory: string, id: string): string => join(directory, "blobs", `${id}.bin`);

export async function writeBlob(directory: string, id: string, data: Buffer): Promise<void> {
  const target = blobPath(directory, id);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, target);
}

export async function readBlob(directory: string, id: string): Promise<Buffer | undefined> {
  try {
    await access(blobPath(directory, id), constants.R_OK);
    return await readFile(blobPath(directory, id));
  } catch {
    return undefined;
  }
}

export async function deleteBlob(directory: string, id: string): Promise<void> {
  try {
    await unlink(blobPath(directory, id));
  } catch {
    // Deleting a missing blob is not an error.
  }
}
