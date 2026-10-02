package com.sikorokoro44.opencodechat.data.remote

import com.sikorokoro44.opencodechat.data.model.ChatStreamEvent
import com.sikorokoro44.opencodechat.data.model.StreamDeltaDto
import com.sikorokoro44.opencodechat.data.model.StreamDoneDto
import com.sikorokoro44.opencodechat.data.model.StreamErrorDto
import com.sikorokoro44.opencodechat.data.model.StreamFallbackDto
import com.sikorokoro44.opencodechat.data.model.StreamMetaDto
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.HttpHeaders
import io.ktor.http.encodeURLParameter
import io.ktor.http.isSuccess
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.Json
import kotlinx.serialization.decodeFromString

class StreamException(
    val code: String,
    override val message: String,
    val retryable: Boolean,
) : Exception(message)

/** Streams assistant output from `/v1/chats/{id}/stream` as decoded events. */
class ChatStreamClient(
    private val client: HttpClient,
    private val json: Json,
) {
    fun stream(
        baseUrl: String,
        token: String,
        chatId: String,
        content: String,
        modelId: String?,
    ): Flow<ChatStreamEvent> = flow {
        val url = buildString {
            append(baseUrl)
            append("/v1/chats/")
            append(chatId)
            append("/stream?content=")
            append(content.encodeURLParameter())
            if (!modelId.isNullOrBlank()) {
                append("&modelId=")
                append(modelId.encodeURLParameter())
            }
        }
        client.prepareGet(url) {
            header(HttpHeaders.Authorization, "Bearer $token")
            header(HttpHeaders.Accept, "text/event-stream")
        }.execute { response ->
            if (!response.status.isSuccess()) {
                throw StreamException("http_${response.status.value}", "stream rejected (${response.status.value})", response.status.value >= 500)
            }
            val channel = response.bodyAsChannel()
            val parser = SseParser()
            while (true) {
                val line = channel.readUTF8Line() ?: break
                parser.feed(line)?.let { emit(it.toEvent()) }
            }
            parser.flush()?.let { emit(it.toEvent()) }
        }
    }.flowOn(Dispatchers.IO)

    private fun SseFrame.toEvent(): ChatStreamEvent = when (event) {
        "meta" -> json.decodeFromString(StreamMetaDto.serializer(), data).let {
            ChatStreamEvent(
                type = "meta",
                chatId = it.chatId,
                messageId = it.messageId,
                model = it.model,
                requestedModel = it.requestedModel,
                fallbackDepth = it.fallbackDepth,
            )
        }

        "delta" -> ChatStreamEvent(type = "delta", text = json.decodeFromString(StreamDeltaDto.serializer(), data).text)

        "fallback" -> json.decodeFromString(StreamFallbackDto.serializer(), data).let {
            ChatStreamEvent(type = "fallback", text = it.to, requestedModel = it.from, message = it.reason)
        }

        "done" -> json.decodeFromString(StreamDoneDto.serializer(), data).let {
            ChatStreamEvent(type = "done", messageId = it.messageId, model = it.model)
        }

        "error" -> json.decodeFromString(StreamErrorDto.serializer(), data).let {
            ChatStreamEvent(type = "error", code = it.code, message = it.message, retryable = it.retryable)
        }

        else -> ChatStreamEvent(type = event, text = data.ifBlank { null })
    }
}
