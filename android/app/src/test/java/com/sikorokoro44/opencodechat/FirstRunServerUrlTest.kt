package com.sikorokoro44.opencodechat

import com.sikorokoro44.opencodechat.data.auth.AuthTokens
import com.sikorokoro44.opencodechat.data.model.ChatStreamEvent
import com.sikorokoro44.opencodechat.data.prefs.InMemorySettingsStore
import com.sikorokoro44.opencodechat.data.prefs.SettingsStore
import com.sikorokoro44.opencodechat.data.remote.ApiResult
import com.sikorokoro44.opencodechat.data.remote.BackendUrlPolicy
import com.sikorokoro44.opencodechat.data.remote.TransportVerdict
import com.sikorokoro44.opencodechat.data.repository.AuthRepository
import com.sikorokoro44.opencodechat.ui.MainViewModel
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * First-run server configuration.
 *
 * v1.0.1 pre-filled `https://opencode-chat.example.com`, a reserved
 * documentation domain that cannot resolve, so a fresh install failed with
 * "Unable to resolve host" before the user had done anything. The app must ship
 * with no server at all, ask for one, and stay off the network until then.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FirstRunServerUrlTest {
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /** Records every request the app attempts, so "no traffic" is an assertion. */
    private class UrlRecordingEngine {
        val paths = mutableListOf<String>()

        val engine = MockEngine { request ->
            paths += request.url.encodedPath
            respond(
                content = """{"primaryModelId":"m","models":[]}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
    }

    private val storedTokens = AuthTokens(
        accessToken = "access-secret",
        refreshToken = "refresh-secret",
        userId = "u",
        username = "n",
    )

    // --- no default server is shipped -------------------------------------

    @Test
    fun `a fresh install ships no server url`() = runTest {
        assertEquals("no host may be defaulted", "", SettingsStore.DEFAULT_BASE_URL)

        val store = InMemorySettingsStore()
        assertEquals("", store.baseUrl())
        assertEquals("", store.baseUrlFlow.first())
        assertFalse("first run grants no transport exception", store.allowInsecureHttp())
    }

    @Test
    fun `the example url is placeholder text and never a stored value`() = runTest {
        // The hint is https, so showing it never nudges the user off the secure
        // transport...
        assertTrue(BackendUrlPolicy.SERVER_URL_EXAMPLE.startsWith("https://"))
        assertEquals(
            TransportVerdict.SECURE,
            BackendUrlPolicy.verdict(BackendUrlPolicy.SERVER_URL_EXAMPLE, allowInsecureHttp = false),
        )

        // ...but no shipped default names a host at all, and a fresh install is
        // still empty rather than pre-filled with the hint.
        assertNotEquals(BackendUrlPolicy.SERVER_URL_EXAMPLE, SettingsStore.DEFAULT_BASE_URL)
        val store = InMemorySettingsStore()
        assertEquals("", store.baseUrl())
        assertNotEquals(BackendUrlPolicy.SERVER_URL_EXAMPLE, store.baseUrl())

        // It is only stored once the user types it.
        store.setBaseUrl(BackendUrlPolicy.SERVER_URL_EXAMPLE)
        assertEquals(BackendUrlPolicy.SERVER_URL_EXAMPLE, store.baseUrl())
    }

    @Test
    fun `the retired v1_0_1 placeholder counts as no server configured`() = runTest {
        assertEquals("https://opencode-chat.example.com", BackendUrlPolicy.RETIRED_PLACEHOLDER_URL)
        assertEquals("", BackendUrlPolicy.configured(BackendUrlPolicy.RETIRED_PLACEHOLDER_URL))
        assertEquals("", BackendUrlPolicy.configured("  HTTPS://OpenCode-Chat.Example.com/  "))

        // An install that stored the placeholder before upgrading must not
        // resurrect the unresolvable host.
        assertEquals("", InMemorySettingsStore(BackendUrlPolicy.RETIRED_PLACEHOLDER_URL).baseUrl())

        val store = InMemorySettingsStore()
        store.setBaseUrl(BackendUrlPolicy.RETIRED_PLACEHOLDER_URL)
        assertEquals("", store.baseUrl())
    }

    // --- URL validation ----------------------------------------------------

    @Test
    fun `an empty url is reported as a missing server url, not a dns error`() {
        val message = BackendUrlPolicy.explain("", allowInsecureHttp = false)

        assertTrue("got: $message", message.orEmpty().contains("Enter your server URL"))
        assertFalse(
            "must not leak a resolver error: $message",
            message.orEmpty().contains("Unable to resolve host", ignoreCase = true),
        )
        assertEquals("", BackendUrlPolicy.configured(""))
        assertEquals("", BackendUrlPolicy.configured("   "))
        assertEquals("", BackendUrlPolicy.configured(null))
    }

    @Test
    fun `an empty url never carries credentials, even with the http opt-in`() {
        for (allowed in listOf(false, true)) {
            assertEquals(
                TransportVerdict.INSECURE_BLOCKED,
                BackendUrlPolicy.verdict("", allowInsecureHttp = allowed),
            )
            assertFalse(BackendUrlPolicy.permitsCredentials("", allowInsecureHttp = allowed))
        }
        assertFalse(BackendUrlPolicy.isCleartextRemote(""))
    }

    @Test
    fun `the loopback and http policy is unchanged by an empty url`() = runTest {
        // An empty URL inherits nothing: it is not treated as loopback.
        assertFalse(BackendUrlPolicy.isLoopback(""))
        val store = InMemorySettingsStore()
        store.setAllowInsecureHttp(true)
        assertFalse(store.allowInsecureHttp())

        // Explicit loopback still works with no opt-in.
        assertEquals(TransportVerdict.LOOPBACK, BackendUrlPolicy.verdict("http://127.0.0.1:3000", false))
        val loopback = InMemorySettingsStore()
        loopback.setBaseUrl("http://127.0.0.1:3000")
        loopback.setAllowInsecureHttp(true)
        assertEquals("http://127.0.0.1:3000", loopback.baseUrl())
        assertEquals(TransportVerdict.LOOPBACK, BackendUrlPolicy.verdict(loopback.baseUrl(), false))
    }

    @Test
    fun `a configured url is still required before anything is accepted`() {
        assertEquals("https://chat.example.org", BackendUrlPolicy.configured("chat.example.org"))
        assertEquals("https://chat.example.org", BackendUrlPolicy.configured("  https://chat.example.org/  "))
        assertEquals(
            TransportVerdict.INSECURE_BLOCKED,
            BackendUrlPolicy.verdict("http://192.168.1.50:3000", allowInsecureHttp = false),
        )
    }

    // --- no network access before configuration ---------------------------

    @Test
    fun `no request is attempted while no server is configured`() = runTest {
        val recorder = UrlRecordingEngine()
        val container = testContainer(recorder.engine, tokens = storedTokens, baseUrl = "")

        val failures = listOf(
            container.authRepository.login("user", "hunter2"),
            container.authRepository.register("user", "hunter2"),
            container.chatRepository.models(),
        ).map { it as ApiResult.Failure }

        failures.forEach { failure ->
            assertEquals(AuthRepository.MISSING_SERVER_URL, failure.code)
            assertTrue("got: ${failure.message}", failure.message.contains("Enter your server URL"))
        }

        val events: List<ChatStreamEvent> = container.chatRepository
            .stream(chatId = "c1", content = "hello", modelId = null)
            .toList()
        assertEquals(1, events.size)
        assertEquals("error", events.single().type)
        assertEquals(AuthRepository.MISSING_SERVER_URL, events.single().code)

        assertEquals("nothing may reach the network", emptyList<String>(), recorder.paths)
    }

    @Test
    fun `signing out with no server configured sends nothing and clears tokens`() = runTest {
        val recorder = UrlRecordingEngine()
        val container = testContainer(recorder.engine, tokens = storedTokens, baseUrl = "")

        val result = container.authRepository.logout()

        assertEquals(AuthRepository.MISSING_SERVER_URL, (result as ApiResult.Failure).code)
        assertEquals(emptyList<String>(), recorder.paths)
        assertNull("the refresh token must not be left on the device", container.tokenStore.read())
    }

    @Test
    fun `first run makes no request and shows an empty server url`() = runTest(dispatcher) {
        val recorder = UrlRecordingEngine()
        val container = testContainer(recorder.engine, tokens = null, baseUrl = "")

        val model = MainViewModel(container)
        advanceUntilIdle()

        assertFalse(model.state.value.booting)
        assertEquals("", model.state.value.baseUrl)
        assertNull(model.state.value.tokens)
        assertEquals("first run must not touch the network", emptyList<String>(), recorder.paths)
    }

    @Test
    fun `stored tokens without a server url do not trigger a startup request`() = runTest(dispatcher) {
        val recorder = UrlRecordingEngine()
        val container = testContainer(recorder.engine, tokens = storedTokens, baseUrl = "")

        val model = MainViewModel(container)
        advanceUntilIdle()

        assertEquals("", model.state.value.baseUrl)
        assertEquals("nothing may be requested before a server is configured", emptyList<String>(), recorder.paths)
    }

    @Test
    fun `a configured server url is still loaded on startup`() = runTest(dispatcher) {
        val recorder = UrlRecordingEngine()
        val container = testContainer(recorder.engine, tokens = storedTokens, baseUrl = "https://example.test")

        val model = MainViewModel(container)
        advanceUntilIdle()

        assertFalse(model.state.value.booting)
        assertEquals("https://example.test", model.state.value.baseUrl)
        assertNotNull(model.state.value.tokens)
    }

    @Test
    fun `a configured server still receives requests`() = runTest {
        val recorder = UrlRecordingEngine()
        val container = testContainer(recorder.engine, tokens = storedTokens, baseUrl = "https://example.test")

        val result = container.chatRepository.models()

        assertTrue("existing functionality must be preserved", result is ApiResult.Success)
        assertEquals(listOf("/v1/models"), recorder.paths)
    }
}