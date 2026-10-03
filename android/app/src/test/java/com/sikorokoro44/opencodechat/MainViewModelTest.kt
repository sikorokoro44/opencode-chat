package com.sikorokoro44.opencodechat

import com.sikorokoro44.opencodechat.data.auth.AuthTokens
import com.sikorokoro44.opencodechat.data.model.MessageDto
import com.sikorokoro44.opencodechat.ui.MainViewModel
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    private fun viewModel(): MainViewModel =
        MainViewModel(testContainer(MockEngine { respond("{}", HttpStatusCode.OK) }))

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `a blank message is ignored`() {
        val model = viewModel()
        model.send("   ")
        assertFalse(model.state.value.streaming)
        assertTrue(model.state.value.messages.isEmpty())
    }

    @Test
    fun `selectModel updates the selection`() {
        val model = viewModel()
        model.selectModel("big-pickle")
        assertEquals("big-pickle", model.state.value.selectedModelId)
    }

    @Test
    fun `github and project state are tracked`() {
        val model = viewModel()
        model.openGithub()
        assertTrue(model.state.value.githubOpen)
        model.closeGithub()
        assertFalse(model.state.value.githubOpen)

        model.setProjectBranch("release")
        model.setProjectPath("src/main")
        assertEquals("release", model.state.value.projectBranch)
        assertEquals("src/main", model.state.value.projectPath)
    }

    @Test
    fun `an unsafe project path is rejected without a request`() {
        val model = viewModel()
        for (path in listOf("/etc/passwd", "../secrets", "src\\main", "src\u0001main")) {
            model.setProjectPath(path)
            model.applyProjectState()
            assertNotNull("expected $path to be rejected", model.state.value.error)
        }
    }

    @Test
    fun `a malformed repository is rejected without a request`() = runTest(dispatcher) {
        val model = viewModel()
        model.newChatWithProject("not-a-repo", null, null)
        advanceUntilIdle()
        assertEquals("Repository must look like owner/name", model.state.value.error)
        assertNull(model.state.value.activeChatId)
    }

    @Test
    fun `the assistant bubble adopts the server message id`() {
        val sse = buildString {
            append("event: meta\n")
            append("data: {\"chatId\":\"c1\",\"messageId\":\"srv-1\",\"model\":\"big-pickle\"}\n\n")
            append("event: delta\n")
            append("data: {\"text\":\"Hel\"}\n\n")
            append("event: delta\n")
            append("data: {\"text\":\"lo\"}\n\n")
            append("event: done\n")
            append("data: {\"messageId\":\"srv-1\"}\n\n")
        }
        val engine = MockEngine { request ->
            when {
                request.url.encodedPath == "/v1/chats" ->
                    respond(
                        """{"id":"c1","title":"t"}""",
                        HttpStatusCode.Created,
                        headersOf(HttpHeaders.ContentType, "application/json"),
                    )

                request.url.encodedPath.endsWith("/stream") ->
                    respond(sse, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))

                // The reload fails on purpose: only the streamed id can label the bubble.
                request.url.encodedPath == "/v1/chats/c1" ->
                    respond("""{"error":{"code":"boom"}}""", HttpStatusCode.InternalServerError)

                else ->
                    respond(
                        """{"chats":[]}""",
                        HttpStatusCode.OK,
                        headersOf(HttpHeaders.ContentType, "application/json"),
                    )
            }
        }
        Dispatchers.setMain(UnconfinedTestDispatcher())
        try {
            val model = MainViewModel(testContainer(engine, AuthTokens("access", "refresh", "u1", "tester")))
            model.send("hi")
            val assistant = runBlocking {
                withTimeout(20_000) {
                    var found: MessageDto? = null
                    while (found == null) {
                        found = model.state.value.messages.lastOrNull { it.role == "assistant" && it.id == "srv-1" }
                        if (found == null) delay(10)
                    }
                    requireNotNull(found)
                }
            }
            assertEquals("Hello", assistant.content)
        } finally {
            Dispatchers.resetMain()
        }
    }
}
