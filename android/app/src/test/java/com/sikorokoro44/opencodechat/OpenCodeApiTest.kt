package com.sikorokoro44.opencodechat

import com.sikorokoro44.opencodechat.data.model.UpdateChatRequest
import com.sikorokoro44.opencodechat.data.model.UploadAttachmentRequest
import com.sikorokoro44.opencodechat.data.remote.ApiResult
import com.sikorokoro44.opencodechat.data.remote.OpenCodeApi
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenCodeApiTest {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    private fun api(engine: MockEngine): OpenCodeApi {
        val client = HttpClient(engine) {
            expectSuccess = false
            install(ContentNegotiation) { json(json) }
        }
        return OpenCodeApi(client, json)
    }

    @Test
    fun `login decodes the auth response`() = runTest {
        val engine = MockEngine { request ->
            assertEquals("/v1/auth/login", request.url.encodedPath)
            respond(
                content = """{"accessToken":"a","refreshToken":"r","user":{"id":"u","username":"n"}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val result = api(engine).login("https://example.test", "n", "password", null)
        assertTrue(result is ApiResult.Success)
        assertEquals("r", (result as ApiResult.Success).value.refreshToken)
    }

    @Test
    fun `error envelopes become failures with the server code`() = runTest {
        val engine = MockEngine {
            respond(
                content = """{"error":{"code":"unauthorized","message":"bad token","retryable":false}}""",
                status = HttpStatusCode.Unauthorized,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val result = api(engine).me("https://example.test", "expired")
        assertTrue(result is ApiResult.Failure)
        val failure = result as ApiResult.Failure
        assertEquals("unauthorized", failure.code)
        assertEquals(401, failure.status)
    }

    @Test
    fun `network exceptions are reported as retryable failures`() = runTest {
        val engine = MockEngine { throw RuntimeException("boom") }
        val result = api(engine).models("https://example.test", "token")
        assertTrue(result is ApiResult.Failure)
        assertEquals("network_error", (result as ApiResult.Failure).code)
    }

    @Test
    fun `updateChat uses PATCH and decodes the chat`() = runTest {
        var path = ""
        var method = ""
        val engine = MockEngine { request ->
            path = request.url.encodedPath
            method = request.method.value
            respond(
                content = """{"id":"c1","title":"Renamed","messageCount":2}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val result = api(engine).updateChat(
            "https://example.test",
            "token",
            "c1",
            UpdateChatRequest(repository = "octocat/hello-world", branch = "main"),
        )
        assertTrue(result is ApiResult.Success)
        assertEquals("/v1/chats/c1", path)
        assertEquals("PATCH", method)
        assertEquals("Renamed", (result as ApiResult.Success).value.title)
    }

    @Test
    fun `uploadAttachment posts and decodes the attachment`() = runTest {
        var path = ""
        var method = ""
        val engine = MockEngine { request ->
            path = request.url.encodedPath
            method = request.method.value
            respond(
                content = """{"id":"a1","mimeType":"image/png","sizeBytes":12,"kind":"image","fileName":"x.png"}""",
                status = HttpStatusCode.Created,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val result = api(engine).uploadAttachment(
            "https://example.test",
            "token",
            UploadAttachmentRequest(data = "AAAA", mimeType = "image/png", fileName = "x.png"),
        )
        assertTrue(result is ApiResult.Success)
        assertEquals("/v1/attachments", path)
        assertEquals("POST", method)
        assertEquals("a1", (result as ApiResult.Success).value.id)
    }

    @Test
    fun `githubRepos decodes the repository list`() = runTest {
        val engine = MockEngine { request ->
            assertEquals("/v1/github/repos", request.url.encodedPath)
            respond(
                content = """{"repos":[{"fullName":"octocat/hello-world","name":"hello-world","owner":"octocat","defaultBranch":"main"}]}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val result = api(engine).githubRepos("https://example.test", "token")
        assertTrue(result is ApiResult.Success)
        assertEquals("octocat/hello-world", (result as ApiResult.Success).value.repos.first().fullName)
    }
}
