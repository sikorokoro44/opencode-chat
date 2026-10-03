import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";

import { ChatService } from "../src/chat/chat-service.ts";
import { decodeBase64Strict, detectMimeType, imageDimensions, storeAttachment } from "../src/chat/attachments.ts";
import { createMemoryDatabase } from "../src/store/database.ts";
import { ModelRegistry, parseModelRegistry, MODELS_FILE } from "../src/models/registry.ts";
import type { AttachmentRecord } from "../src/store/records.ts";

const registry = new ModelRegistry({ snapshot: parseModelRegistry(readFileSync(MODELS_FILE, "utf8")) });

function service(now?: () => number): ChatService {
  return new ChatService({ database: createMemoryDatabase(), registry, ...(now ? { now } : {}) });
}

function png(width = 2, height = 3): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "opencode-chat-"));
}

test("a created chat has safe defaults and is scoped to its owner", () => {
  const chat = service().createChat("u1");
  assert.equal(chat.title, "New chat");
  assert.equal(chat.messageCount, 0);
  assert.equal(chat.lastMessagePreview, null);
  assert.equal(chat.pinned, false);
  assert.equal(chat.repository, null);
});

test("the first user message names the chat and whitespace is collapsed", () => {
  const chats = service();
  const chat = chats.createChat("u1");
  chats.appendMessage("u1", chat.id, { role: "user", content: "  Fix   the\n\nlogin bug please  " });
  const [listed] = chats.listChats("u1");
  assert.equal(listed?.title, "Fix the login bug please");
  assert.equal(listed?.messageCount, 1);
  assert.equal(listed?.lastMessagePreview, "Fix the login bug please");
});

test("an explicit title is preserved and never overwritten by messages", () => {
  const chats = service();
  const chat = chats.createChat("u1", { title: "Release prep" });
  chats.appendMessage("u1", chat.id, { role: "user", content: "something else entirely" });
  assert.equal(chats.listChats("u1")[0]?.title, "Release prep");
});

test("chat listing is pinned-first then most-recently-updated", () => {
  let now = 0;
  const chats = new ChatService({
    database: createMemoryDatabase(),
    registry,
    now: () => now,
  });
  const first = chats.createChat("u1", { title: "first" });
  now = 1_000;
  const second = chats.createChat("u1", { title: "second" });
  now = 2_000;
  const third = chats.createChat("u1", { title: "third" });
  chats.updateChat("u1", first.id, { pinned: true });

  const ordered = chats.listChats("u1").map((chat) => chat.title);
  assert.deepEqual(ordered, ["first", "third", "second"]);
  assert.notEqual(third.id, second.id);
});

test("another user's chat is reported as missing, never as forbidden", () => {
  const chats = service();
  const chat = chats.createChat("u1");
  assert.throws(() => chats.requireChat("u2", chat.id), /chat not found/);
  assert.throws(() => chats.listMessages("u2", chat.id), /chat not found/);
  assert.equal(chats.listChats("u2").length, 0);
});

test("the repository context the client sets on a chat is persisted", () => {
  // The Android app sends repository/branch/projectPath through PATCH /v1/chats/{chatId};
  // dropping them would silently lose the context the user picked.
  const chats = service();
  const chat = chats.createChat("u1");
  const updated = chats.updateChat("u1", chat.id, {
    repository: "octocat/hello-world",
    branch: "main",
    projectPath: "app/src",
  });
  assert.equal(updated.repository, "octocat/hello-world");
  assert.equal(updated.branch, "main");
  assert.equal(updated.projectPath, "app/src");
  // Persisted, not just returned.
  assert.equal(chats.requireChat("u1", chat.id).repository, "octocat/hello-world");
  assert.equal(chats.requireChat("u1", chat.id).projectPath, "app/src");
});

test("updating a chat rejects an unknown model and accepts an allow-listed one", () => {
  const chats = service();
  const chat = chats.createChat("u1");
  assert.throws(() => chats.updateChat("u1", chat.id, { modelId: "gpt-4o" }), /allow-list/);

  const allowed = registry.selectable().find((model) => model.id !== "big-pickle");
  assert.ok(allowed);
  const updated = chats.updateChat("u1", chat.id, { modelId: allowed.id, branch: "feature/x" });
  assert.equal(updated.modelId, allowed.id);
  assert.equal(updated.branch, "feature/x");
});

test("deleting a chat removes its messages and attachments but not other chats", () => {
  const chats = service();
  const doomed = chats.createChat("u1");
  const kept = chats.createChat("u1");
  const attachment: AttachmentRecord = {
    id: "att_1",
    userId: "u1",
    mimeType: "text/plain",
    sizeBytes: 1,
    kind: "text",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  chats.attachAttachment(attachment);
  chats.appendMessage("u1", doomed.id, { role: "user", content: "bye", attachmentIds: [attachment.id] });
  chats.appendMessage("u1", kept.id, { role: "user", content: "stay" });

  chats.deleteChat("u1", doomed.id);
  assert.equal(chats.listChats("u1").length, 1);
  assert.equal(chats.listChats("u1")[0]?.id, kept.id);
  assert.equal(chats.listMessages("u1", kept.id).length, 1);
  assert.throws(() => chats.findAttachment("u1", attachment.id), /attachment not found/);
});

test("message usage, error codes and fallback source are surfaced", () => {
  const chats = service();
  const chat = chats.createChat("u1");
  chats.appendMessage("u1", chat.id, {
    role: "assistant",
    content: "hi",
    modelId: "big-pickle",
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    errorCode: "provider_http_429",
    fallbackFrom: "big-pickle",
  });
  const [message] = chats.listMessages("u1", chat.id);
  assert.deepEqual(message?.usage, { promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  assert.equal(message?.errorCode, "provider_http_429");
  assert.equal(message?.modelId, "big-pickle");
});

test("provider history trims old turns but always keeps the newest user turn", () => {
  const chats = new ChatService({ database: createMemoryDatabase(), registry, charsPerToken: 1 });
  const chat = chats.createChat("u1");
  const model = registry.require("big-pickle");
  for (let index = 0; index < 40; index += 1) {
    chats.appendMessage("u1", chat.id, { role: index % 2 === 0 ? "user" : "assistant", content: "x".repeat(2_000) });
  }
  const messages = chats.buildProviderMessages(chat.id, { content: "latest question", attachmentIds: [] }, model);
  const totalChars = messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);
  assert.ok(totalChars < 25_000, `expected a trimmed history, got ${totalChars} chars`);
  const last = messages[messages.length - 1];
  assert.equal(last?.role, "user");
  assert.equal(last?.content, "latest question");
});

test("an image attachment is inlined as image_url for vision models and noted otherwise", () => {
  const chats = service();
  const chat = chats.createChat("u1");
  const attachment: AttachmentRecord = {
    id: "att_img",
    userId: "u1",
    mimeType: "image/png",
    sizeBytes: 4,
    kind: "image",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  chats.attachAttachment(attachment);

  const visionModel = registry.selectable().find((model) => model.capabilities.includes("vision"));
  assert.ok(visionModel);
  const withVision = chats.buildProviderMessages(chat.id, { content: "look", attachmentIds: [attachment.id] }, visionModel);
  const parts = withVision[withVision.length - 1]?.content;
  assert.ok(Array.isArray(parts));
  assert.ok(parts.some((part) => part.type === "image_url" && part.imageUrl?.url === "attachment://att_img"));

  const blindModel = registry.selectable().find((model) => !model.capabilities.includes("vision"));
  if (blindModel) {
    const withoutVision = chats.buildProviderMessages(chat.id, { content: "look", attachmentIds: [attachment.id] }, blindModel);
    const blindParts = withoutVision[withoutVision.length - 1]?.content;
    assert.ok(Array.isArray(blindParts));
    assert.ok(blindParts.some((part) => part.type === "text" && /image omitted/.test(part.text ?? "")));
  }
});

test("inlineAttachments converts placeholders to data URLs and blocks other users", async () => {
  const directory = await tempDir();
  try {
    const { openDatabase } = await import("../src/store/database.ts");
    const database = await openDatabase({ directory, flushDelayMs: 0 });
    const record = await storeAttachment(
      { userId: "u1", mimeType: "image/png", data: png(), directory },
      { maxBytes: 1_000_000, maxImageBytes: 1_000_000, ttlMs: 60_000 },
    );
    const chats = new ChatService({ database, registry });
    chats.attachAttachment({ ...record, userId: "u1" });

    const mine = await chats.inlineAttachments(
      [{ role: "user", content: [{ type: "image_url", imageUrl: { url: `attachment://${record.id}` } }] }],
      "u1",
    );
    const part = Array.isArray(mine[0]?.content) ? mine[0].content[0] : undefined;
    assert.equal(part?.type, "image_url");
    assert.ok(part?.imageUrl?.url.startsWith("data:image/png;base64,"));

    const theirs = await chats.inlineAttachments(
      [{ role: "user", content: [{ type: "image_url", imageUrl: { url: `attachment://${record.id}` } }] }],
      "u2",
    );
    const blocked = Array.isArray(theirs[0]?.content) ? theirs[0].content[0] : undefined;
    assert.equal(blocked?.type, "text");
    assert.equal(blocked?.text, "[image unavailable]");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired attachments are purged and fresh ones survive", () => {
  const now = 1_000;
  const chats = new ChatService({ database: createMemoryDatabase(), registry, now: () => now });
  const base = {
    userId: "u1",
    mimeType: "text/plain",
    sizeBytes: 1,
    kind: "text" as const,
    createdAt: new Date(0).toISOString(),
  };
  chats.attachAttachment({ ...base, id: "old", expiresAt: new Date(now - 1).toISOString() });
  chats.attachAttachment({ ...base, id: "fresh", expiresAt: new Date(now + 10_000).toISOString() });
  assert.equal(chats.purgeExpiredAttachments(), 1);
  assert.throws(() => chats.findAttachment("u1", "old"), /attachment not found/);
  assert.ok(chats.findAttachment("u1", "fresh"));
});

test("base64 decoding is strict about padding and content", () => {
  assert.deepEqual(decodeBase64Strict("aGVsbG8="), Buffer.from("hello"));
  assert.throws(() => decodeBase64Strict("not base64!!"), /base64/);
  assert.throws(() => decodeBase64Strict("aGVsbG8"), /base64/);
  assert.throws(() => decodeBase64Strict(""), /base64/);
});

test("mime sniffing trusts bytes over the declared type", () => {
  assert.equal(detectMimeType(png(), "text/plain"), "image/png");
  assert.equal(detectMimeType(Buffer.from("plain text"), "text/plain"), "text/plain");
  assert.equal(detectMimeType(Buffer.from([0x00, 0x01, 0x02]), "text/plain"), "text/plain");
  assert.equal(detectMimeType(Buffer.from("%PDF-1.7"), "application/pdf"), "application/pdf");
});

test("image dimensions are read from PNG, GIF and JPEG headers", () => {
  assert.deepEqual(imageDimensions(png(7, 9)), { width: 7, height: 9 });
  const gif = Buffer.alloc(10);
  gif.write("GIF89a", 0, "latin1");
  gif.writeUInt16LE(5, 6);
  gif.writeUInt16LE(6, 8);
  assert.deepEqual(imageDimensions(gif), { width: 5, height: 6 });
  assert.equal(imageDimensions(Buffer.from("not an image")), undefined);
});

test("storeAttachment rejects oversized, empty and binary payloads", async () => {
  const directory = await tempDir();
  try {
    const limits = { maxBytes: 100, maxImageBytes: 50, ttlMs: 60_000 };
    await assert.rejects(
      () => storeAttachment({ userId: "u1", mimeType: "text/plain", data: Buffer.alloc(0), directory }, limits),
      /must not be empty/,
    );
    await assert.rejects(
      () => storeAttachment({ userId: "u1", mimeType: "text/plain", data: Buffer.alloc(200, 0x61), directory }, limits),
      /limited to 100 bytes/,
    );
    await assert.rejects(
      () =>
        storeAttachment(
          { userId: "u1", mimeType: "image/png", data: Buffer.concat([png(), Buffer.alloc(200)]), directory },
          { maxBytes: 10_000, maxImageBytes: 50, ttlMs: 60_000 },
        ),
      /images are limited to 50 bytes/,
    );
    await assert.rejects(
      () => storeAttachment({ userId: "u1", mimeType: "application/octet-stream", data: Buffer.from([1, 2, 3]), directory }, limits),
      /unsupported attachment type/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stored text attachment is persisted with metadata", async () => {
  const directory = await tempDir();
  try {
    const record = await storeAttachment(
      { userId: "u1", mimeType: "text/plain", fileName: "notes.txt", data: Buffer.from("hello"), directory, chatId: "chat_1" },
      { maxBytes: 1_000, maxImageBytes: 1_000, ttlMs: 60_000 },
    );
    assert.equal(record.kind, "text");
    assert.equal(record.mimeType, "text/plain");
    assert.equal(record.fileName, "notes.txt");
    assert.equal(record.chatId, "chat_1");
    assert.equal(record.sizeBytes, 5);
    assert.ok(Date.parse(record.expiresAt) > Date.now());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tool messages are replayed to the provider as assistant turns", () => {
  const chats = service();
  const chat = chats.createChat("u1");
  const model = registry.require("big-pickle");
  chats.appendMessage("u1", chat.id, { role: "user", content: "read it" });
  chats.appendMessage("u1", chat.id, { role: "tool", content: "file contents", modelId: model.id });
  const providerMessages = chats.buildProviderMessages(chat.id, { content: "now summarize", attachmentIds: [] }, model);
  assert.equal(providerMessages[1]?.role, "assistant");
  assert.equal(providerMessages[1]?.content, "file contents");
});

test("message records are returned in chronological order", () => {
  let now = 0;
  const chats = new ChatService({ database: createMemoryDatabase(), registry, now: () => now });
  const chat = chats.createChat("u1");
  for (let index = 0; index < 5; index += 1) {
    now = index;
    chats.appendMessage("u1", chat.id, { role: "user", content: String(index) });
  }
  const contents = chats.listMessages("u1", chat.id).map((message) => message.content);
  assert.deepEqual(contents, ["0", "1", "2", "3", "4"]);
});

test("a user turn that is already persisted is not sent to the provider twice", () => {
  const chats = service();
  const chat = chats.createChat("u1");
  const model = registry.require("big-pickle");
  chats.appendMessage("u1", chat.id, { role: "user", content: "only once" });

  const messages = chats.buildProviderMessages(chat.id, { content: "only once", attachmentIds: [] }, model);
  const userTurns = messages.filter((message) => message.role === "user" && message.content === "only once");
  assert.equal(userTurns.length, 1);
  assert.equal(messages.at(-1)?.role, "user");
  assert.equal(messages.at(-1)?.content, "only once");
});

test("resetToLastUserTurn drops the previous answer and keeps the question", () => {
  const chats = service();
  const chat = chats.createChat("u1");
  chats.appendMessage("u1", chat.id, { role: "user", content: "question" });
  chats.appendMessage("u1", chat.id, { role: "assistant", content: "first answer" });
  chats.appendMessage("u1", chat.id, { role: "tool", content: "tool output" });

  const lastUser = chats.resetToLastUserTurn("u1", chat.id);
  assert.equal(lastUser?.content, "question");
  assert.deepEqual(
    chats.listMessages("u1", chat.id).map((message) => message.content),
    ["question"],
  );
});

test("resetToLastUserTurn returns null when there is no user turn", () => {
  const chats = service();
  const chat = chats.createChat("u1");
  chats.appendMessage("u1", chat.id, { role: "assistant", content: "unsolicited" });
  assert.equal(chats.resetToLastUserTurn("u1", chat.id), null);
});
