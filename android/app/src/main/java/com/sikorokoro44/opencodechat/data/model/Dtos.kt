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
