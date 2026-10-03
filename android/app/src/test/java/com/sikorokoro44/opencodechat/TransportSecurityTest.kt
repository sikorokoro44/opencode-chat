package com.sikorokoro44.opencodechat

import com.sikorokoro44.opencodechat.data.auth.AuthTokens
import com.sikorokoro44.opencodechat.data.model.ChatStreamEvent
import com.sikorokoro44.opencodechat.data.remote.ApiResult
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Records every request the app attempts, so "no token or password reached the
 * wire" is an assertion rather than a claim.
 */
private class RecordingEngine {
    val paths = mutableListOf<String>()
    val authorization = mutableListOf<String?>()

    val engine = MockEngine { request ->
        val path = request.url.encodedPath
        paths += path
        authorization += request.headers[HttpHeaders.Authorization]
        val body = if (path == "/v1/models") {
            """{"primaryModelId":"m","models":[]}"""
        } else {
            """{"accessToken":"a","refreshToken":"r","user":{"id":"u","username":"n"}}"""
        }
        respond(
            content = body,
            status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }
}

private val signedIn = AuthTokens(
    accessToken = "access-secret",
    refreshToken = "refresh-secret",
    userId = "u",
    username = "n",
)

class TransportSecurityTest {
    private val remoteHttp = "http://192.168.1.50:3000"

    @Test
    fun `login does not send a password to a remote http backend without an opt-in`() = runTest {
        val recorder = RecordingEngine()
        val container = testContainer(recorder.engine, tokens = null, baseUrl = remoteHttp)

        val result = container.authRepository.login("user", "hunter2")

        assertEquals("insecure_transport", (result as ApiResult.Failure).code)
        assertTrue("no request may be attempted", recorder.paths.isEmpty())
        assertNull("login must not appear to have succeeded", container.tokenStore.read())
    }

    @Test
    fun `authenticated calls never attach a token to a blocked http backend`() = runTest {
        val recorder = RecordingEngine()
        val container = testContainer(recorder.engine, tokens = signedIn, baseUrl = remoteHttp)

        val result = container.chatRepository.models()

        assertEquals("insecure_transport", (result as ApiResult.Failure).code)
        assertTrue("no request may be attempted", recorder.paths.isEmpty())
    }

    @Test
    fun `streaming never attaches a token to a blocked http backend`() = runTest {
        val recorder = RecordingEngine()
        val container = testContainer(recorder.engine, tokens = signedIn, baseUrl = remoteHttp)

        val events: List<ChatStreamEvent> = container.chatRepository
            .stream(chatId = "c1", content = "hello", modelId = null)
            .toList()

        assertEquals(1, events.size)
        assertEquals("error", events.single().type)
        assertEquals("insecure_transport", events.single().code)
        assertTrue("no request may be attempted", recorder.paths.isEmpty())
    }

    @Test
    fun `regenerate never attaches a token to a blocked http backend`() = runTest {
        val recorder = RecordingEngine()
        val container = testContainer(recorder.engine, tokens = signedIn, baseUrl = remoteHttp)

        val events = container.chatRepository.regenerate(chatId = "c1", modelId = null).toList()

        assertEquals("insecure_transport", events.single().code)
        assertTrue(recorder.paths.isEmpty())
    }

    @Test
    fun `logout clears local tokens even when cleartext is refused`() = runTest {
        val recorder = RecordingEngine()
        val container = testContainer(recorder.engine, tokens = signedIn, baseUrl = remoteHttp)

        val result = container.authRepository.logout()

        assertEquals("insecure_transport", (result as ApiResult.Failure).code)
        assertTrue("refresh token must never be sent", recorder.paths.isEmpty())
        assertNull("token must not be left on the device", container.tokenStore.read())
    }

    @Test
    fun `a backend saved by an older release is not trusted until the user confirms`() = runTest {
        val recorder = RecordingEngine()
        // The v1.0.0 upgrade path: a plain-HTTP URL already in preferences, with
        // no record of any opt-in because that release had none.
        val container = testContainer(recorder.engine, tokens = signedIn, baseUrl = remoteHttp)

        assertFalse(container.settingsStore.allowInsecureHttp())
        assertTrue(recorder.paths.isEmpty())
    }

    @Test
    fun `the opt-in is ignored for https and retracted when the backend becomes secure`() = runTest {
        val recorder = RecordingEngine()
        val container = testContainer(recorder.engine, baseUrl = "https://example.test")

        container.settingsStore.setAllowInsecureHttp(true)
        assertFalse("consent is meaningless for https", container.settingsStore.allowInsecureHttp())

        container.settingsStore.setBaseUrl(remoteHttp)
        container.settingsStore.setAllowInsecureHttp(true)
        assertTrue(container.settingsStore.allowInsecureHttp())

        container.settingsStore.setBaseUrl("https://example.test")
        assertFalse("consent must not outlive its purpose", container.settingsStore.allowInsecureHttp())
        assertTrue(recorder.paths.isEmpty())
    }

    @Test
    fun `https sends the bearer token as before`() = runTest {
        val recorder = RecordingEngine()
        val container = testContainer(recorder.engine, tokens = signedIn, baseUrl = "https://example.test")

        val result = container.chatRepository.models()

        assertTrue(result is ApiResult.Success)
        assertEquals(listOf("/v1/models"), recorder.paths)
        assertEquals("Bearer access-secret", recorder.authorization.single())
    }

    @Test
    fun `loopback http is allowed without an opt-in`() = runTest {
        val recorder = RecordingEngine()
        val container = testContainer(recorder.engine, tokens = signedIn, baseUrl = "http://127.0.0.1:3000")

        val result = container.chatRepository.models()

        assertTrue(result is ApiResult.Success)
        assertEquals("Bearer access-secret", recorder.authorization.single())
    }

    @Test
    fun `an explicit opt-in permits a remote http backend`() = runTest {
        val recorder = RecordingEngine()
        val container = testContainer(recorder.engine, tokens = signedIn, baseUrl = remoteHttp)
        container.settingsStore.setAllowInsecureHttp(true)

        val result = container.chatRepository.models()

        assertTrue(result is ApiResult.Success)
        assertEquals("Bearer access-secret", recorder.authorization.single())
    }
}