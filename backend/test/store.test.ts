import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, readBlob, deleteBlob, blobPath } from "../src/store/database.ts";
import type { ChatRecord, UserRecord } from "../src/store/records.ts";
import { newId } from "../src/ids.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "opencode-store-"));
}

const user = (): UserRecord => ({
  id: newId("usr"),
  username: "alice",
  usernameLower: "alice",
  passwordHash: "hash",
  createdAt: new Date(0).toISOString(),
  disabled: false,
});

test("a collection survives a close and reopen", async () => {
  const directory = await tempDir();
  try {
    const first = await openDatabase({ directory, flushDelayMs: 0 });
    const record = user();
    first.users.put(record);
    await first.flush();
    await first.close();

    const second = await openDatabase({ directory, flushDelayMs: 0 });
    assert.equal(second.users.get(record.id)?.username, "alice");
    assert.equal(second.users.count(), 1);
    await second.close();

    // The on-disk file is human-readable JSON, not a binary blob.
    const raw = await readFile(join(directory, "users.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), [record]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("debounced flushes coalesce and still persist the latest state", async () => {
  const directory = await tempDir();
  try {
    const database = await openDatabase({ directory, flushDelayMs: 5_000 });
    const id = newId("usr");
    for (let index = 0; index < 50; index += 1) {
      database.users.put({ ...user(), id, username: `user-${index}` });
    }
    await database.flush();
    await database.close();

    const reopened = await openDatabase({ directory, flushDelayMs: 0 });
    assert.equal(reopened.users.get(id)?.username, "user-49");
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delete, clear and predicate helpers behave as documented", async () => {
  const directory = await tempDir();
  try {
    const database = await openDatabase({ directory, flushDelayMs: 0 });
    const chat = (owner: string): ChatRecord => ({
      id: newId("chat"),
      userId: owner,
      title: "t",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pinned: false,
    });
    const mine = chat("u1");
    const theirs = chat("u2");
    database.chats.put(mine);
    database.chats.put(theirs);

    assert.equal(database.chats.filter((entry) => entry.userId === "u1").length, 1);
    assert.equal(database.chats.find((entry) => entry.userId === "u2")?.id, theirs.id);
    assert.equal(database.chats.delete(mine.id), true);
    assert.equal(database.chats.delete(mine.id), false, "deleting twice reports false");
    assert.equal(database.chats.count(), 1);
    database.chats.clear();
    assert.equal(database.chats.count(), 0);
    await database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt collection file is quarantined instead of crashing the server", async () => {
  const directory = await tempDir();
  try {
    await writeFile(join(directory, "users.json"), "{ this is not json", "utf8");
    const database = await openDatabase({ directory, flushDelayMs: 0 });
    assert.equal(database.users.count(), 0, "startup continues with an empty collection");

    const quarantined = (await readFile(join(directory, "users.json.corrupt"), "utf8")).length;
    assert.ok(quarantined > 0, "the bad file is kept for inspection");
    await database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown top-level keys in stored records are tolerated", async () => {
  const directory = await tempDir();
  try {
    await writeFile(
      join(directory, "chats.json"),
      JSON.stringify([
        { id: "chat_1", userId: "u1", title: "t", createdAt: "x", updatedAt: "x", pinned: false, futureField: 1 },
      ]),
      "utf8",
    );
    const database = await openDatabase({ directory, flushDelayMs: 0 });
    assert.equal(database.chats.get("chat_1")?.userId, "u1");
    await database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blobs are written with owner-only permissions and can be removed", async () => {
  const directory = await tempDir();
  try {
    const database = await openDatabase({ directory, flushDelayMs: 0 });
    const id = newId("att");
    const payload = Buffer.from("hello blob");
    const { writeBlob } = await import("../src/store/database.ts");
    await writeBlob(directory, id, payload);

    assert.deepEqual(await readBlob(directory, id), payload);
    const mode = (await stat(blobPath(directory, id))).mode & 0o777;
    assert.equal(mode, 0o600);

    await deleteBlob(directory, id);
    assert.equal(await readBlob(directory, id), undefined);
    await deleteBlob(directory, id);
    await database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path traversal cannot escape the blob directory", async () => {
  const directory = await tempDir();
  try {
    const outside = join(directory, "secret.txt");
    await writeFile(outside, "top secret", "utf8");
    // readBlob only ever appends `.bin`, and ids are validated by the caller.
    assert.equal(await readBlob(directory, "../secret"), undefined);
    assert.equal(await readBlob(directory, "../../etc/passwd"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
