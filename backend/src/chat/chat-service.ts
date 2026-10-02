/**
 * Chat persistence and message assembly.
 *
 * Responsibilities:
 *  - own the chat/message lifecycle (create, rename, delete, append);
 *  - build the provider message list from history, trimming to a token budget;
 *  - never let one account read or mutate another account's chats.
 */

import { newId } from "../ids.ts";
import { notFound } from "../http/errors.ts";
import type { Database } from "../store/database.ts";
import type { AttachmentRecord, ChatRecord, MessageRecord } from "../store/records.ts";
import type { Attachment, Chat, Message } from "../api/types.ts";
import type { ContentPart, ProviderMessage } from "../models/provider.ts";
import type { ModelRegistry, RegistryModel } from "../models/registry.ts";

export interface ChatServiceOptions {
  database: Database;
  registry: ModelRegistry;
  /** Approximate characters-per-token ratio used for trimming (4 is the common value). */
  charsPerToken?: number;
  now?: () => number;
}

const DEFAULT_TITLE = "New chat";
const HISTORY_BUDGET_TOKENS = 24_000;
const VISION_CAPABLE = "vision";

export class ChatService {
  private readonly database: Database;
  private readonly registry: ModelRegistry;
  private readonly charsPerToken: number;
  private readonly now: () => number;

  constructor(options: ChatServiceOptions) {
    this.database = options.database;
    this.registry = options.registry;
    this.charsPerToken = options.charsPerToken ?? 4;
    this.now = options.now ?? (() => Date.now());
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  createChat(
    userId: string,
    input: { title?: string; repository?: string; branch?: string; projectPath?: string; modelId?: string } = {},
  ): Chat {
    const timestamp = this.timestamp();
    const record: ChatRecord = {
      id: newId("chat"),
      userId,
      title: sanitizeTitle(input.title) || DEFAULT_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      pinned: false,
      ...(input.repository ? { repository: input.repository } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      ...(input.modelId && this.registry.find(input.modelId) ? { modelId: input.modelId } : {}),
    };
    this.database.chats.put(record);
    return toChat(record, 0, null);
  }

  listChats(userId: string, limit = 100): Chat[] {
    const capped = Math.min(Math.max(limit, 1), 500);
    const chats = this.database.chats.filter((chat) => chat.userId === userId);
    chats.sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
    return chats.slice(0, capped).map((chat) => {
      const messages = this.messagesOf(chat.id);
      const last = messages[messages.length - 1];
      return toChat(chat, messages.length, last ? preview(last.content) : null);
    });
  }

  requireChat(userId: string, chatId: string): ChatRecord {
    const chat = this.database.chats.get(chatId);
    if (!chat || chat.userId !== userId) {
      throw notFound("chat_not_found", "chat not found");
    }
    return chat;
  }

  listMessages(userId: string, chatId: string, messageLimit?: number): Message[] {
    this.requireChat(userId, chatId);
    const messages = this.messagesOf(chatId);
    const limited =
      messageLimit && messageLimit > 0 && messages.length > messageLimit
        ? messages.slice(messages.length - messageLimit)
        : messages;
    return limited.map((record) => toMessage(record, this.attachmentsOf(record.attachmentIds)));
  }

  updateChat(
    userId: string,
    chatId: string,
    patch: { title?: string; pinned?: boolean; modelId?: string; branch?: string },
  ): Chat {
    const chat = this.requireChat(userId, chatId);
    if (patch.title !== undefined) {
      const title = sanitizeTitle(patch.title);
      if (title === "") throw notFound("invalid_title", "title must not be empty");
      chat.title = title;
    }
    if (patch.pinned !== undefined) chat.pinned = patch.pinned;
    if (patch.modelId !== undefined) {
      if (!this.registry.find(patch.modelId)) {
        const error = new Error(`model ${patch.modelId} is not in the free-model allow-list`);
        (error as Error & { code?: string }).code = "unknown_model";
        throw error;
      }
      chat.modelId = patch.modelId;
    }
    if (patch.branch !== undefined) chat.branch = patch.branch;
    chat.updatedAt = this.timestamp();
    this.database.chats.put(chat);
    const messages = this.messagesOf(chat.id);
    const last = messages[messages.length - 1];
    return toChat(chat, messages.length, last ? preview(last.content) : null);
  }

  deleteChat(userId: string, chatId: string): void {
    const chat = this.requireChat(userId, chatId);
    for (const message of this.messagesOf(chatId)) {
      this.database.messages.delete(message.id);
      for (const attachmentId of message.attachmentIds) {
        const attachment = this.database.attachments.get(attachmentId);
        if (attachment && attachment.userId === userId) this.database.attachments.delete(attachmentId);
      }
    }
    this.database.chats.delete(chat.id);
  }

  appendMessage(
    userId: string,
    chatId: string,
    input: {
      role: MessageRecord["role"];
      content: string;
      modelId?: string;
      attachmentIds?: string[];
      parentId?: string;
      agentActions?: MessageRecord["agentActions"];
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      errorCode?: string;
      fallbackFrom?: string;
    },
  ): MessageRecord {
    const chat = this.requireChat(userId, chatId);
    const record: MessageRecord = {
      id: newId("msg"),
      chatId,
      userId,
      role: input.role,
      content: input.content,
      createdAt: this.timestamp(),
      attachmentIds: input.attachmentIds ?? [],
      agentActions: input.agentActions ?? [],
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.usage ? { ...input.usage } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.fallbackFrom ? { fallbackFrom: input.fallbackFrom } : {}),
    };
    this.database.messages.put(record);

    // First user message names the chat when the user did not.
    if (chat.title === DEFAULT_TITLE && input.role === "user" && record.content.trim() !== "") {
      chat.title = sanitizeTitle(record.content).slice(0, 80) || DEFAULT_TITLE;
    }
    chat.updatedAt = record.createdAt;
    this.database.chats.put(chat);
    return record;
  }

  updateMessage(record: MessageRecord): MessageRecord {
    this.database.messages.put(record);
    return record;
  }

  /** Keeps the newest messages that fit the history token budget. */
  private selectHistory(history: MessageRecord[]): MessageRecord[] {
    const budgetChars = HISTORY_BUDGET_TOKENS * this.charsPerToken;
    const selected: MessageRecord[] = [];
    let used = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index] as MessageRecord;
      const cost = message.content.length;
      if (selected.length > 0 && used + cost > budgetChars) break;
      used += cost;
      selected.unshift(message);
    }
    return selected;
  }

  /**
   * Drops assistant/tool messages that follow the last user turn and returns that
   * user message, so a regenerate streams a replacement answer rather than
   * stacking a second reply.
   */
  resetToLastUserTurn(userId: string, chatId: string): MessageRecord | null {
    this.requireChat(userId, chatId);
    const messages = this.messagesOf(chatId);
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if ((messages[index] as MessageRecord).role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex === -1) return null;
    for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
      this.database.messages.delete((messages[index] as MessageRecord).id);
    }
    return messages[lastUserIndex] as MessageRecord;
  }

  messagesOf(chatId: string): MessageRecord[] {
    const messages = this.database.messages.filter((message) => message.chatId === chatId);
    // `Array.prototype.sort` is stable, so equal timestamps keep insertion order
    // instead of shuffling on random ids.
    messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return messages;
  }

  private attachmentsOf(attachmentIds: string[]): Attachment[] {
    const out: Attachment[] = [];
    for (const id of attachmentIds) {
      const record = this.database.attachments.get(id);
      if (record) out.push(toAttachment(record));
    }
    return out;
  }

  /**
   * Builds the provider message list for a new assistant turn.
   * Older turns are dropped once the budget is exceeded, but the most recent
   * user turn is always kept so the model has something to answer.
   */
  buildProviderMessages(
    chatId: string,
    pendingUserMessage: { content: string; attachmentIds: string[] },
    model: RegistryModel,
  ): ProviderMessage[] {
    const selected = this.selectHistory(this.messagesOf(chatId));
    // Callers may persist the user turn before building history; drop a trailing
    // duplicate so the model never receives the same question twice.
    const trailing = selected[selected.length - 1];
    if (trailing && trailing.role === "user" && trailing.content === pendingUserMessage.content) {
      selected.pop();
    }

    const supportsVision = model.capabilities.includes(VISION_CAPABLE);
    const messages: ProviderMessage[] = [];
    for (const message of selected) {
      messages.push({
        role: message.role === "tool" ? "assistant" : message.role,
        content: message.content,
      });
    }

    const pendingParts: ContentPart[] = [];
    const pendingText = pendingUserMessage.content;
    if (pendingText !== "") pendingParts.push({ type: "text", text: pendingText });
    for (const attachmentId of pendingUserMessage.attachmentIds) {
      const attachment = this.database.attachments.get(attachmentId);
      if (!attachment || attachment.kind !== "image") continue;
      if (!supportsVision) {
        // Fall back to a textual note rather than failing the whole request.
        pendingParts.push({
          type: "text",
          text: `[image omitted: ${attachment.fileName ?? attachment.mimeType} (model cannot read images)]`,
        });
        continue;
      }
      pendingParts.push({
        type: "image_url",
        imageUrl: { url: `attachment://${attachment.id}` },
      });
    }

    messages.push({
      role: "user",
      content: pendingParts.length === 1 && pendingParts[0]?.type === "text" ? pendingText : pendingParts,
    });
    return messages;
  }

  /** Replaces `attachment://<id>` placeholders with inline data URLs. */
  async inlineAttachments(messages: ProviderMessage[], userId: string): Promise<ProviderMessage[]> {
    const { readBlob } = await import("../store/database.ts");
    const out: ProviderMessage[] = [];
    for (const message of messages) {
      if (typeof message.content === "string") {
        out.push(message);
        continue;
      }
      const parts: ContentPart[] = [];
      for (const part of message.content) {
        if (part.type === "text" || !part.imageUrl) {
          parts.push(part);
          continue;
        }
        const match = /^attachment:\/\/([A-Za-z0-9_-]+)$/.exec(part.imageUrl.url);
        const record = match ? this.database.attachments.get(match[1] as string) : undefined;
        if (!record || record.userId !== userId) {
          parts.push({ type: "text", text: "[image unavailable]" });
          continue;
        }
        const blob = await readBlob(this.database.directory, record.id);
        if (!blob) {
          parts.push({ type: "text", text: "[image unavailable]" });
          continue;
        }
        parts.push({
          type: "image_url",
          imageUrl: { url: `data:${record.mimeType};base64,${blob.toString("base64")}` },
        });
      }
      out.push({ role: message.role, content: parts });
    }
    return out;
  }

  findAttachment(userId: string, attachmentId: string): AttachmentRecord {
    const record = this.database.attachments.get(attachmentId);
    if (!record || record.userId !== userId) {
      throw notFound("attachment_not_found", "attachment not found");
    }
    return record;
  }

  attachAttachment(record: AttachmentRecord): void {
    this.database.attachments.put(record);
  }

  purgeExpiredAttachments(nowMs = this.now()): number {
    const expired = this.database.attachments.filter((attachment) => Date.parse(attachment.expiresAt) <= nowMs);
    for (const attachment of expired) this.database.attachments.delete(attachment.id);
    return expired.length;
  }
}

export function toChat(record: ChatRecord, messageCount: number, lastMessagePreview: string | null): Chat {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    pinned: record.pinned,
    messageCount,
    lastMessagePreview,
    repository: record.repository ?? null,
    branch: record.branch ?? null,
    projectPath: record.projectPath ?? null,
    modelId: record.modelId ?? null,
  };
}

export function toMessage(record: MessageRecord, attachments: Attachment[]): Message {
  return {
    id: record.id,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
    modelId: record.modelId ?? null,
    parentId: record.parentId ?? null,
    attachments,
    agentActions: record.agentActions,
    usage:
      record.promptTokens === undefined && record.completionTokens === undefined
        ? null
        : {
            promptTokens: record.promptTokens,
            completionTokens: record.completionTokens,
            totalTokens: record.totalTokens,
          },
    errorCode: record.errorCode ?? null,
  };
}

export function toAttachment(record: AttachmentRecord): Attachment {
  return {
    id: record.id,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    kind: record.kind,
    fileName: record.fileName ?? null,
    width: record.width ?? null,
    height: record.height ?? null,
    url: `/v1/attachments/${record.id}`,
  };
}

function sanitizeTitle(title: string | undefined): string {
  if (!title) return "";
  return title.replace(/\s+/g, " ").trim().slice(0, 200);
}

function preview(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}
