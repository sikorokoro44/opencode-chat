/** Wire-level DTOs shared by the HTTP layer and documented in `shared/openapi.json`. */

export interface User {
  id: string;
  username: string;
  createdAt: string;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type AttachmentKind = "image" | "text" | "binary";

export interface Attachment {
  id: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  fileName?: string | null;
  width?: number | null;
  height?: number | null;
  url: string;
}

export type AgentActionType =
  | "read_file"
  | "write_file"
  | "list_dir"
  | "search"
  | "commit"
  | "pull_request"
  | "memory_write";

export interface AgentActionSummary {
  type: AgentActionType;
  summary: string;
  path?: string | null;
  repository?: string | null;
  branch?: string | null;
  url?: string | null;
  status: "ok" | "failed";
}

export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  modelId?: string | null;
  parentId?: string | null;
  attachments: Attachment[];
  agentActions: AgentActionSummary[];
  usage?: Usage | null;
  errorCode?: string | null;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  messageCount: number;
  lastMessagePreview?: string | null;
  repository?: string | null;
  branch?: string | null;
  projectPath?: string | null;
  modelId?: string | null;
}

/** Events emitted on `/v1/chats/{chatId}/stream`. */
export type ChatStreamEvent =
  | {
      type: "meta";
      chatId: string;
      messageId: string;
      model: string;
      requestedModel: string;
      fallbackDepth: number;
    }
  | { type: "delta"; text: string }
  | { type: "fallback"; from: string; to: string; reason: string }
  | { type: "usage"; usage: Usage }
  | {
      type: "done";
      messageId: string;
      model: string;
      finishReason: string | null;
      usage: Usage;
      agentActions: AgentActionSummary[];
    }
  | { type: "error"; code: string; message: string; retryable: boolean };

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  capabilities: string[];
  contextWindow: number;
  maxOutputTokens: number;
  priority: number;
  fallbackOnly: boolean;
  /** Populated from live health state. */
  healthy: boolean;
  /** Set when the model is currently tripping the circuit breaker. */
  cooldownSeconds?: number;
}

export interface Repo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch?: string | null;
  description?: string | null;
  updatedAt?: string | null;
  language?: string | null;
}

export interface RepoEntry {
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
  sha: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}
