package com.sikorokoro44.opencodechat.data.remote

import com.sikorokoro44.opencodechat.data.model.AuthResponse
import com.sikorokoro44.opencodechat.data.model.ChatDetailResponse
import com.sikorokoro44.opencodechat.data.model.ChatDto
import com.sikorokoro44.opencodechat.data.model.ChatListResponse
import com.sikorokoro44.opencodechat.data.model.CreateChatRequest
import com.sikorokoro44.opencodechat.data.model.ErrorEnvelope
import com.sikorokoro44.opencodechat.data.model.GithubStatusDto
import com.sikorokoro44.opencodechat.data.model.MeResponse
import com.sikorokoro44.opencodechat.data.model.ModelsResponse
import com.sikorokoro44.opencodechat.data.model.SendMessageResponse
import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.decodeFromString

@Serializable
private data class CredentialsRequest(
    val username: String,
    val password: String,
    val deviceName: String? = null,
)

@Serializable
private data class RefreshRequest(val refreshToken: String)

@Serializable
private data class MessageRequest(
    val content: String,
    val modelId: String? = null,
)

@Serializable
private data class ConnectRequest(val token: String)

/**
 * Thin typed wrapper over the backend REST API. All methods return [ApiResult]
 * so callers never see a raw exception (except cancellation, which propagates).
 */
class OpenCodeApi(
    private val client: HttpClient,
    internal val json: Json,
) {
    suspend fun register(baseUrl: String, username: String, password: String, deviceName: String?): ApiResult<AuthResponse> =
        call(AuthResponse.serializer()) {
            client.post("$baseUrl/v1/auth/register") {
                contentType(ContentType.Application.Json)
                setBody(CredentialsRequest(username, password, deviceName))
            }
        }

    suspend fun login(baseUrl: String, username: String, password: String, deviceName: String?): ApiResult<AuthResponse> =
        call(AuthResponse.serializer()) {
            client.post("$baseUrl/v1/auth/login") {
                contentType(ContentType.Application.Json)
                setBody(CredentialsRequest(username, password, deviceName))
            }
        }

    suspend fun refresh(baseUrl: String, refreshToken: String): ApiResult<AuthResponse> =
        call(AuthResponse.serializer()) {
            client.post("$baseUrl/v1/auth/refresh") {
                contentType(ContentType.Application.Json)
                setBody(RefreshRequest(refreshToken))
            }
        }

    suspend fun logout(baseUrl: String, refreshToken: String): ApiResult<Unit> =
        callNoContent {
            client.post("$baseUrl/v1/auth/logout") {
                contentType(ContentType.Application.Json)
                setBody(RefreshRequest(refreshToken))
            }
        }

    suspend fun me(baseUrl: String, token: String): ApiResult<MeResponse> =
        call(MeResponse.serializer()) { client.get("$baseUrl/v1/me") { bearer(token) } }

    suspend fun models(baseUrl: String, token: String): ApiResult<ModelsResponse> =
        call(ModelsResponse.serializer()) { client.get("$baseUrl/v1/models") { bearer(token) } }

    suspend fun listChats(baseUrl: String, token: String): ApiResult<ChatListResponse> =
        call(ChatListResponse.serializer()) { client.get("$baseUrl/v1/chats") { bearer(token) } }

    suspend fun createChat(baseUrl: String, token: String, request: CreateChatRequest): ApiResult<ChatDto> =
        call(ChatDto.serializer()) {
            client.post("$baseUrl/v1/chats") {
                bearer(token)
                contentType(ContentType.Application.Json)
                setBody(request)
            }
        }

    suspend fun getChat(baseUrl: String, token: String, chatId: String): ApiResult<ChatDetailResponse> =
        call(ChatDetailResponse.serializer()) {
            client.get("$baseUrl/v1/chats/$chatId?messageLimit=200") { bearer(token) }
        }

    suspend fun deleteChat(baseUrl: String, token: String, chatId: String): ApiResult<Unit> =
        callNoContent { client.delete("$baseUrl/v1/chats/$chatId") { bearer(token) } }

    suspend fun sendMessage(
        baseUrl: String,
        token: String,
        chatId: String,
        content: String,
        modelId: String?,
    ): ApiResult<SendMessageResponse> =
        call(SendMessageResponse.serializer()) {
            client.post("$baseUrl/v1/chats/$chatId/messages") {
                bearer(token)
                contentType(ContentType.Application.Json)
                setBody(MessageRequest(content = content, modelId = modelId))
            }
        }

    suspend fun githubStatus(baseUrl: String, token: String): ApiResult<GithubStatusDto> =
        call(GithubStatusDto.serializer()) { client.get("$baseUrl/v1/github/status") { bearer(token) } }

    suspend fun connectGithub(baseUrl: String, token: String, githubToken: String): ApiResult<Unit> =
        callNoContent {
            client.post("$baseUrl/v1/github/connect") {
                bearer(token)
                contentType(ContentType.Application.Json)
                setBody(ConnectRequest(githubToken))
            }
        }

    suspend fun disconnectGithub(baseUrl: String, token: String): ApiResult<Unit> =
        callNoContent { client.delete("$baseUrl/v1/github/connect") { bearer(token) } }

    private fun HttpRequestBuilder.bearer(token: String) {
        header(HttpHeaders.Authorization, "Bearer $token")
    }

    internal suspend fun <T> call(
        strategy: DeserializationStrategy<T>,
        block: suspend () -> HttpResponse,
    ): ApiResult<T> {
        return try {
            val response = block()
            val text = response.bodyAsText()
            if (response.status.isSuccess()) {
                ApiResult.Success(json.decodeFromString(strategy, text))
            } else {
                failure(response.status.value, text)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            ApiResult.Failure("network_error", error.message ?: "network error", retryable = true)
        }
    }

    internal suspend fun callNoContent(block: suspend () -> HttpResponse): ApiResult<Unit> {
        return try {
            val response = block()
            if (response.status.isSuccess()) {
                ApiResult.Success(Unit)
            } else {
                failure(response.status.value, response.bodyAsText())
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            ApiResult.Failure("network_error", error.message ?: "network error", retryable = true)
        }
    }

    private fun failure(status: Int, text: String): ApiResult.Failure {
        val body = runCatching { json.decodeFromString(ErrorEnvelope.serializer(), text).error }.getOrNull()
        return ApiResult.Failure(
            code = body?.code ?: "http_error",
            message = body?.message ?: "request failed",
            retryable = body?.retryable ?: false,
            status = status,
        )
    }
}
