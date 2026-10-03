package com.sikorokoro44.opencodechat.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class UserDto(
    val id: String,
    val username: String,
    val createdAt: String? = null,
)

@Serializable
data class AuthResponse(
    val accessToken: String,
    val refreshToken: String,
    val user: UserDto,
)

@Serializable
data class GithubStatusDto(
    val connected: Boolean = false,
    val login: String? = null,
    val scopes: List<String> = emptyList(),
)

@Serializable
data class LimitsDto(
    val requestsPerMinute: Int? = null,
    val attachmentMaxBytes: Long? = null,
)

@Serializable
data class MeResponse(
    val user: UserDto,
    val github: GithubStatusDto = GithubStatusDto(),
    val limits: LimitsDto = LimitsDto(),
)

@Serializable
data class ModelInfoDto(
    val id: String,
    val displayName: String? = null,
    val provider: String? = null,
    val capabilities: List<String> = emptyList(),
    val contextWindow: Int? = null,
    val maxOutputTokens: Int? = null,
    val priority: Int? = null,
    val fallbackOnly: Boolean = false,
    val healthy: Boolean = true,
    val cooldownSeconds: Int? = null,
)

@Serializable
data class ModelsResponse(
    val primaryModelId: String,
    val maxFallbackDepth: Int = 0,
    val models: List<ModelInfoDto> = emptyList(),
)

@Serializable
data class UsageDto(
    val promptTokens: Int? = null,
    val completionTokens: Int? = null,
    val totalTokens: Int? = null,
)

@Serializable
data class AttachmentDto(
    val id: String,
    val mimeType: String,
    val sizeBytes: Long = 0,
    val kind: String = "file",
    val fileName: String? = null,
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class MessageDto(
    val id: String,
    val role: String,
    val content: String,
    val createdAt: String? = null,
    val modelId: String? = null,
    val parentId: String? = null,
    val attachments: List<AttachmentDto> = emptyList(),
    val usage: UsageDto? = null,
    val errorCode: String? = null,
)

@Serializable
data class ChatDto(
    val id: String,
    val title: String = "",
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val pinned: Boolean = false,
    val messageCount: Int = 0,
    val lastMessagePreview: String? = null,
    val repository: String? = null,
    val branch: String? = null,
    val projectPath: String? = null,
    val modelId: String? = null,
)

@Serializable
data class ChatListResponse(
    val chats: List<ChatDto> = emptyList(),
)

@Serializable
data class ChatDetailResponse(
    val chat: ChatDto,
    val messages: List<MessageDto> = emptyList(),
)

@Serializable
data class CreateChatRequest(
    val title: String? = null,
    val repository: String? = null,
    val branch: String? = null,
    val projectPath: String? = null,
    val modelId: String? = null,
)

@Serializable
data class SendMessageResponse(
    val userMessage: MessageDto,
    val assistantMessage: MessageDto,
    val fallbackChain: List<String> = emptyList(),
)

@Serializable
data class UpdateChatRequest(
    val title: String? = null,
    val pinned: Boolean? = null,
    val repository: String? = null,
    val branch: String? = null,
    val projectPath: String? = null,
    val modelId: String? = null,
)

@Serializable
data class UploadAttachmentRequest(
    val data: String,
    val mimeType: String,
    val fileName: String? = null,
    val chatId: String? = null,
)

@Serializable
data class RepoDto(
    val fullName: String = "",
    val name: String = "",
    val owner: String = "",
    val private: Boolean = false,
    val defaultBranch: String? = null,
    val description: String? = null,
    val updatedAt: String? = null,
    val language: String? = null,
)

@Serializable
data class RepoListResponse(
    val repos: List<RepoDto> = emptyList(),
)

@Serializable
data class BranchDto(
    val name: String = "",
    val sha: String? = null,
)

@Serializable
data class BranchListResponse(
    val branches: List<BranchDto> = emptyList(),
)

@Serializable
data class ContentEntryDto(
    val path: String = "",
    val name: String = "",
    val type: String = "file",
    val size: Long = 0,
    val sha: String? = null,
)

@Serializable
data class ContentsResponse(
    val path: String = "",
    val ref: String = "",
    val entries: List<ContentEntryDto> = emptyList(),
)

@Serializable
data class FileResponse(
    val path: String = "",
    val ref: String = "",
    val sha: String? = null,
    val size: Long = 0,
    val truncated: Boolean = false,
    val content: String = "",
    val encoding: String? = null,
)

@Serializable
data class MemoryResponse(
    val exists: Boolean = false,
    val path: String = "",
    val content: String = "",
    val updatedAt: String? = null,
)

@Serializable
data class WriteMemoryRequest(
    val owner: String,
    val repo: String,
    val branch: String,
    val content: String,
    val commitMessage: String? = null,
)

@Serializable
data class WriteMemoryResponse(
    val path: String = "",
    val sha: String? = null,
    val branch: String = "",
)

@Serializable
data class MemorySessionDto(
    val chatId: String = "",
    val title: String = "",
    val updatedAt: String = "",
    val messageCount: Int = 0,
)

@Serializable
data class MemorySessionsResponse(
    val sessions: List<MemorySessionDto> = emptyList(),
)

@Serializable
data class RecordSessionRequest(
    val owner: String,
    val repo: String,
    val branch: String,
    val chatId: String,
    val title: String,
    val summary: String,
    val messageCount: Int? = null,
)

@Serializable
data class RecordSessionResponse(
    val stored: Boolean = false,
    val path: String = "",
    val branch: String = "",
)

@Serializable
data class AgentActionDto(
    val type: String = "",
    val summary: String? = null,
    val path: String? = null,
    val repository: String? = null,
    val branch: String? = null,
    val url: String? = null,
    val status: String? = null,
)

@Serializable
data class AgentFileRequest(
    val path: String,
    val content: String,
    val message: String? = null,
)

@Serializable
data class AgentCommitRequest(
    val owner: String,
    val repo: String,
    val baseBranch: String,
    val branch: String? = null,
    val commitMessage: String,
    val createPullRequest: Boolean = false,
    val pullRequestTitle: String? = null,
    val pullRequestBody: String? = null,
    val files: List<AgentFileRequest> = emptyList(),
)

@Serializable
data class AgentCommitResponse(
    val branch: String = "",
    val baseBranch: String = "",
    val commitSha: String? = null,
    val prUrl: String? = null,
    val files: List<String> = emptyList(),
    val actions: List<AgentActionDto> = emptyList(),
)

@Serializable
data class AgentRunRequest(
    val repository: String,
    val prompt: String,
    val branch: String? = null,
    val modelId: String? = null,
    val chatId: String? = null,
    val allowWrites: Boolean = false,
)

@Serializable
data class AgentRunResponse(
    val modelId: String? = null,
    val text: String = "",
    val steps: Int = 0,
    val agentActions: List<AgentActionDto> = emptyList(),
    val usage: UsageDto? = null,
    val charactersStreamed: Int = 0,
)

@Serializable
data class ErrorEnvelope(
    val error: ErrorBody? = null,
)

@Serializable
data class ErrorBody(
    val code: String = "error",
    val message: String = "request failed",
    val retryable: Boolean = false,
)

/** One frame of the `/v1/chats/{id}/stream` SSE feed. */
data class ChatStreamEvent(
    val type: String,
    val text: String? = null,
    val chatId: String? = null,
    val messageId: String? = null,
    val model: String? = null,
    val requestedModel: String? = null,
    val fallbackDepth: Int? = null,
    val code: String? = null,
    val message: String? = null,
    val retryable: Boolean? = null,
)

@Serializable
data class StreamMetaDto(
    val chatId: String? = null,
    val messageId: String? = null,
    val model: String? = null,
    val requestedModel: String? = null,
    val fallbackDepth: Int? = null,
)

@Serializable
data class StreamDeltaDto(val text: String? = null)

@Serializable
data class StreamFallbackDto(val from: String? = null, val to: String? = null, val reason: String? = null)

@Serializable
data class StreamDoneDto(
    val messageId: String? = null,
    val model: String? = null,
    val finishReason: String? = null,
    val usage: UsageDto? = null,
)

@Serializable
data class StreamErrorDto(
    val code: String? = null,
    val message: String? = null,
    val retryable: Boolean? = null,
)
