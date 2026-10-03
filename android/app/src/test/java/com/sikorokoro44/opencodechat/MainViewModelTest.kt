package com.sikorokoro44.opencodechat

import com.sikorokoro44.opencodechat.data.model.MessageDto
import com.sikorokoro44.opencodechat.ui.MainViewModel
import com.sikorokoro44.opencodechat.ui.adoptServerMessageId
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
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
        val messages = listOf(
            MessageDto(id = "u1", role = "user", content = "hi"),
            MessageDto(id = "local-assistant-1", role = "assistant", content = "Hello"),
        )

        val adopted = adoptServerMessageId(messages, "local-assistant-1", "srv-1")
        assertEquals("srv-1", adopted.last().id)
        assertEquals("Hello", adopted.last().content)
        assertEquals("u1", adopted.first().id)
    }

    @Test
    fun `an unusable server message id leaves the bubble alone`() {
        val messages = listOf(MessageDto(id = "local-assistant-1", role = "assistant", content = "Hello"))

        // Missing, blank, unchanged or already-taken ids must not rewrite anything.
        assertEquals(messages, adoptServerMessageId(messages, "local-assistant-1", null))
        assertEquals(messages, adoptServerMessageId(messages, "local-assistant-1", ""))
        assertEquals(messages, adoptServerMessageId(messages, "local-assistant-1", "local-assistant-1"))
        assertEquals(messages, adoptServerMessageId(messages, "missing-local", "srv-1"))
        val taken = listOf(MessageDto(id = "srv-1", role = "user", content = "earlier"))
        assertEquals(taken, adoptServerMessageId(taken, "local-assistant-1", "srv-1"))
    }
}
