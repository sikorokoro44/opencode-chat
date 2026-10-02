package com.sikorokoro44.opencodechat.data.repository

import com.sikorokoro44.opencodechat.data.model.ChatDetailResponse
import com.sikorokoro44.opencodechat.data.model.ChatDto
import com.sikorokoro44.opencodechat.data.model.ChatStreamEvent
import com.sikorokoro44.opencodechat.data.model.CreateChatRequest
import com.sikorokoro44.opencodechat.data.model.GithubStatusDto
import com.sikorokoro44.opencodechat.data.model.MeResponse
import com.sikorokoro44.opencodechat.data.model.ModelsResponse
import com.sikorokoro44.opencodechat.data.remote.ApiResult
import com.sikorokoro44.opencodechat.data.remote.ChatStreamClient
import com.sikorokoro44.opencodechat.data.remote.OpenCodeApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow

/** Chat, model, profile and GitHub operations on behalf of the signed-in user. */
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

    suspend fun createChat(title: String?): ApiResult<ChatDto> =
        auth.withValidToken { base, token ->
            api.createChat(base, token, CreateChatRequest(title = title))
        }

    suspend fun getChat(chatId: String): ApiResult<ChatDetailResponse> =
        auth.withValidToken { base, token -> api.getChat(base, token, chatId) }

    suspend fun deleteChat(chatId: String): ApiResult<Unit> =
        auth.withValidToken { base, token -> api.deleteChat(base, token, chatId) }

    suspend fun models(): ApiResult<ModelsResponse> =
        auth.withValidToken { base, token -> api.models(base, token) }

    suspend fun profile(): ApiResult<MeResponse> =
        auth.withValidToken { base, token -> api.me(base, token) }

    suspend fun githubStatus(): ApiResult<GithubStatusDto> =
        auth.withValidToken { base, token -> api.githubStatus(base, token) }

    suspend fun connectGithub(githubToken: String): ApiResult<Unit> =
        auth.withValidToken { base, token -> api.connectGithub(base, token, githubToken) }

    suspend fun disconnectGithub(): ApiResult<Unit> =
        auth.withValidToken { base, token -> api.disconnectGithub(base, token) }

    /** Streaming is cold: collection starts the request and can be cancelled. */
    fun stream(chatId: String, content: String, modelId: String?): Flow<ChatStreamEvent> = flow {
        val tokens = auth.currentTokens()
        if (tokens == null) {
            emit(ChatStreamEvent(type = "error", code = "unauthorized", message = "not signed in"))
            return@flow
        }
        emitAll(streamClient.stream(auth.baseUrl(), tokens.accessToken, chatId, content, modelId))
    }
}
