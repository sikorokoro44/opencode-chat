/** Persisted record shapes. Wire types live in `src/api/types.ts`. */

import type { AgentActionSummary } from "../api/types.ts";

export interface UserRecord {
  id: string;
  username: string;
  usernameLower: string;
  passwordHash: string;
  createdAt: string;
  disabled: boolean;
  /** Encrypted GitHub token, if the user linked a GitHub account. */
  githubTokenCipher?: string;
  githubLogin?: string;
  githubConnectedAt?: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  /** jti of the current refresh token; rotation invalidates the previous one. */
  refreshJti: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  deviceName: string;
  revokedAt?: string;
  /** Incremented whenever a token is reused after rotation (refresh-token replay). */
  reuseCount: number;
}

export interface AttachmentRecord {
  id: string;
  userId: string;
  chatId?: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "text" | "binary";
  fileName?: string;
  width?: number;
  height?: number;
  createdAt: string;
  /** Images are kept short-lived; they are only useful as context for a reply. */
  expiresAt: string;
}

export interface ChatRecord {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  repository?: string;
  branch?: string;
  projectPath?: string;
  modelId?: string;
}

export interface MessageRecord {
  id: string;
  chatId: string;
  userId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  modelId?: string;
  parentId?: string;
  attachmentIds: string[];
  agentActions: AgentActionSummary[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  errorCode?: string;
  /** Model actually used, which may differ from the requested model after fallback. */
  fallbackFrom?: string;
}
