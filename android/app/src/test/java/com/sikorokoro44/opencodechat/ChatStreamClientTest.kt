package com.sikorokoro44.opencodechat

import com.sikorokoro44.opencodechat.data.remote.ChatStreamClient
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatStreamClientTest {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    private fun client(engine: MockEngine): ChatStreamClient {
        val http = HttpClient(engine) { expectSuccess = false }
        return ChatStreamClient(http, json)
    }

    @Test
    fun `decodes meta delta fallback and done frames`() = runTest {
        val sse = buildString {
            append("event: meta\n")
            append("data: {\"chatId\":\"c1\",\"messageId\":\"m1\",\"model\":\"big-pickle\"}\n\n")
            append(": heartbeat\n\n")
            append("event: fallback\n")
            append("data: {\"from\":\"big-pickle\",\"to\":\"free-small\",\"reason\":\"rate limited\"}\n\n")
            append("event: delta\n")
            append("data: {\"text\":\"Hel\"}\n\n")
            append("event: delta\n")
            append("data: {\"text\":\"lo\"}\n\n")
            append("event: done\n")
            append("data: {\"messageId\":\"m1\",\"model\":\"big-pickle\",\"finishReason\":\"stop\"}\n\n")
        }
        val engine = MockEngine {
            respond(
                content = sse,
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "text/event-stream"),
            )
        }
        val events = client(engine).stream("https://example.test", "token", "c1", "hi", "big-pickle").toList()
        assertEquals(listOf("meta", "fallback", "delta", "delta", "done"), events.map { it.type })
        assertEquals("Hello", events.filter { it.type == "delta" }.joinToString("") { it.text ?: "" })
        assertEquals("c1", events.first().chatId)
        assertEquals("free-small", events.first { it.type == "fallback" }.text)
    }

    @Test
    fun `attachment ids are encoded into the stream query`() = runTest {
        var url = ""
        val engine = MockEngine { request ->
            url = request.url.toString()
            respond(
                content = "event: done\ndata: {\"messageId\":\"m\"}\n\n",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "text/event-stream"),
            )
        }
        client(engine)
            .stream("https://example.test", "token", "c1", "hi there", null, listOf("att-1", "att-2"))
            .toList()
        assertTrue(url.contains("content=hi%20there") || url.contains("content=hi+there"))
        assertTrue(url.contains("attachmentIds=att-1"))
        assertTrue(url.contains("attachmentIds=att-2"))
    }

    @Test
    fun `regenerate targets the regenerate route`() = runTest {
        var url = ""
        val engine = MockEngine { request ->
            url = request.url.toString()
            respond(
                content = "event: done\ndata: {}\n\n",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "text/event-stream"),
            )
        }
        client(engine).regenerate("https://example.test", "token", "c1", "big-pickle").toList()
        assertTrue(url.contains("/v1/chats/c1/regenerate"))
        assertTrue(url.contains("modelId=big-pickle"))
    }

    @Test
    fun `error frames surface codes`() = runTest {
        val engine = MockEngine {
            respond(
                content = "event: error\ndata: {\"code\":\"provider_error\",\"message\":\"boom\",\"retryable\":true}\n\n",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "text/event-stream"),
            )
        }
        val events = client(engine).stream("https://example.test", "token", "c1", "hi", null).toList()
        val error = events.first { it.type == "error" }
        assertEquals("provider_error", error.code)
        assertEquals(true, error.retryable)
    }
}
