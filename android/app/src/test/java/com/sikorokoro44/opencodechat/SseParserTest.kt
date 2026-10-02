package com.sikorokoro44.opencodechat

import com.sikorokoro44.opencodechat.data.remote.SseParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SseParserTest {
    @Test
    fun `joins multiple data lines and dispatches on a blank line`() {
        val parser = SseParser()
        assertNull(parser.feed("event: delta"))
        assertNull(parser.feed("data: first"))
        assertNull(parser.feed("data: second"))
        val frame = parser.feed("")
        assertEquals("delta", frame?.event)
        assertEquals("first\nsecond", frame?.data)
        assertNull(parser.feed(""))
    }

    @Test
    fun `defaults the event name to message`() {
        val parser = SseParser()
        parser.feed("data: hello")
        assertEquals("message", parser.feed("")?.event)
    }

    @Test
    fun `ignores comments and heartbeats`() {
        val parser = SseParser()
        assertNull(parser.feed(": keep-alive"))
        assertNull(parser.feed("data: real"))
        assertEquals("real", parser.feed("")?.data)
    }

    @Test
    fun `flush emits a frame with no trailing blank line`() {
        val parser = SseParser()
        parser.feed("event: done")
        parser.feed("data: {}")
        val frame = parser.flush()
        assertEquals("done", frame?.event)
        assertNull(parser.flush())
    }
}
