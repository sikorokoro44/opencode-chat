package com.sikorokoro44.opencodechat.data.repository

import com.sikorokoro44.opencodechat.data.model.AttachmentDto
import com.sikorokoro44.opencodechat.data.model.ChatDetailResponse
import com.sikorokoro44.opencodechat.data.model.ChatDto
import com.sikorokoro44.opencodechat.data.model.ChatStreamEvent
import com.sikorokoro44.opencodechat.data.model.CreateChatRequest
import com.sikorokoro44.opencodechat.data.model.GithubStatusDto
import com.sikorokoro44.opencodechat.data.model.MeResponse
import com.sikorokoro44.opencodechat.data.model.ModelsResponse
import com.sikorokoro44.opencodechat.data.model.UpdateChatRequest
import com.sikorokoro44.opencodechat.data.model.UploadAttachmentRequest
import com.sikorokoro44.opencodechat.data.remote.ApiResult
import com.sikorokoro44.opencodechat.data.remote.ChatStreamClient
import com.sikorokoro44.opencodechat.data.remote.OpenCodeApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/** Chat, model, profile and attachment operations on behalf of the signed-in user. */
class ChatRepository(
    private val api: OpenCodeApi,
    private val streamClient: ChatStreamClient,
    private val auth: AuthRepository,
) {
    suspend fun listChats(): ApiResult<List<ChatDto>> =
        auth.withValidToken { base, token -> api.listChats(base, token) }
            .let { result -> when (result) {
                is ApiResult.Success -> ApiResult.Success(result.value.chats)
                is ApiResult.Failure -> result
            } }

    suspend fun createChat(
        title: String? = null,
        repository: String? = null,
        branch: String? = null,
        projectPath: String? = null,
        modelId: String? = null,
    ): ApiResult<ChatDto> =
        auth.withValidToken { base, token ->
            api.createChat(
                base,
                token,
                CreateChatRequest(
                    title = title,
                    repository = repository,
                    branch = branch,
                    projectPath = projectPath,
                    modelId = modelId,
                ),
            )
        }

    suspend fun getChat(chatId: String): ApiResult<ChatDetailResponse> =
        auth.withValidToken { base, token -> api.getChat(base, token, chatId) }

    suspend fun updateChat(chatId: String, request: UpdateChatRequest): ApiResult<ChatDto> =
        auth.withValidToken { base, token -> api.updateChat(base, token, chatId, request) }

    suspend fun deleteChat(chatId: String): ApiResult<Unit> =
        auth.withValidToken { base, token -> api.deleteChat(base, token, chatId) }

    suspend fun models(): ApiResult<ModelsResponse> =
        auth.withValidToken { base, token -> api.models(base, token) }

    suspend fun profile(): ApiResult<MeResponse> =
        auth.withValidToken { base, token -> api.me(base, token) }

    suspend fun githubStatus(): ApiResult<GithubStatusDto> =
        auth.withValidToken { base, token -> api.githubStatus(base, token) }

    @OptIn(ExperimentalEncodingApi::class)
    suspend fun uploadAttachment(
        data: ByteArray,
        mimeType: String,
        fileName: String?,
        chatId: String? = null,
    ): ApiResult<AttachmentDto> {
        val encoded = Base64.encode(data)
        return auth.withValidToken { base, token ->
            api.uploadAttachment(base, token, UploadAttachmentRequest(encoded, mimeType, fileName, chatId))
        }
    }

    /** Streaming is cold: collection starts the request and can be cancelled. */
    fun stream(
        chatId: String,
        content: String,
        modelId: String?,
        attachmentIds: List<String> = emptyList(),
    ): Flow<ChatStreamEvent> = flow {
        val base = auth.baseUrl()
        auth.insecureTransport(base)?.let { blocked ->
            emit(blocked.toStreamEvent())
            return@flow
        }
        val tokens = auth.currentTokens()
        if (tokens == null) {
            emit(ChatStreamEvent(type = "error", code = "unauthorized", message = "not signed in"))
            return@flow
        }
        emitAll(streamClient.stream(base, tokens.accessToken, chatId, content, modelId, attachmentIds))
    }

    /** Re-runs the last user turn, replacing the previous answer. */
    fun regenerate(chatId: String, modelId: String?): Flow<ChatStreamEvent> = flow {
        val base = auth.baseUrl()
        auth.insecureTransport(base)?.let { blocked ->
            emit(blocked.toStreamEvent())
            return@flow
        }
        val tokens = auth.currentTokens()
        if (tokens == null) {
            emit(ChatStreamEvent(type = "error", code = "unauthorized", message = "not signed in"))
            return@flow
        }
        emitAll(streamClient.regenerate(base, tokens.accessToken, chatId, modelId))
    }

    private fun ApiResult.Failure.toStreamEvent(): ChatStreamEvent =
        ChatStreamEvent(type = "error", code = code, message = message)
}
