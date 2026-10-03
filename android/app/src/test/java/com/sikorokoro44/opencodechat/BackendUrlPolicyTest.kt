package com.sikorokoro44.opencodechat

import com.sikorokoro44.opencodechat.data.remote.BackendUrlPolicy
import com.sikorokoro44.opencodechat.data.remote.TransportVerdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackendUrlPolicyTest {
    @Test
    fun `https is secure and may carry credentials`() {
        assertEquals(TransportVerdict.SECURE, BackendUrlPolicy.verdict("https://chat.example.com", false))
        assertTrue(BackendUrlPolicy.permitsCredentials("https://chat.example.com", false))
        assertNull(BackendUrlPolicy.explain("https://chat.example.com", false))
    }

    @Test
    fun `a url without a scheme defaults to https`() {
        assertEquals("https://chat.example.com", BackendUrlPolicy.normalize("chat.example.com"))
        assertTrue(BackendUrlPolicy.isHttps("chat.example.com"))
        assertEquals(
            TransportVerdict.SECURE,
            BackendUrlPolicy.verdict("chat.example.com", allowInsecureHttp = false),
        )
    }

    @Test
    fun `normalization trims whitespace and trailing slashes`() {
        assertEquals("https://chat.example.com", BackendUrlPolicy.normalize("  https://chat.example.com///  "))
        assertEquals("http://127.0.0.1:3000", BackendUrlPolicy.normalize("http://127.0.0.1:3000/"))
    }

    @Test
    fun `http on loopback is permitted without an opt-in`() {
        listOf("http://localhost:3000", "http://127.0.0.1:3000", "http://127.0.0.2:8080").forEach { url ->
            assertEquals(url, TransportVerdict.LOOPBACK, BackendUrlPolicy.verdict(url, false))
            assertTrue(url, BackendUrlPolicy.permitsCredentials(url, false))
        }
    }

    @Test
    fun `http to a remote host is refused until the user opts in`() {
        val url = "http://192.168.1.50:3000"
        assertEquals(TransportVerdict.INSECURE_BLOCKED, BackendUrlPolicy.verdict(url, false))
        assertFalse(BackendUrlPolicy.permitsCredentials(url, false))
        assertNotNull(BackendUrlPolicy.explain(url, false))
    }

    @Test
    fun `http to a remote host is permitted once the user opts in`() {
        val url = "http://192.168.1.50:3000"
        assertEquals(TransportVerdict.INSECURE_ALLOWED, BackendUrlPolicy.verdict(url, true))
        assertTrue(BackendUrlPolicy.permitsCredentials(url, true))
        assertTrue(BackendUrlPolicy.isCleartextRemote(url))
    }

    @Test
    fun `the opt-in does not apply to https or loopback`() {
        assertFalse(BackendUrlPolicy.isCleartextRemote("https://chat.example.com"))
        assertFalse(BackendUrlPolicy.isCleartextRemote("http://localhost:3000"))
        assertFalse(BackendUrlPolicy.isCleartextRemote("http://127.0.0.1:3000"))
    }

    @Test
    fun `non http schemes never carry credentials`() {
        listOf("ftp://files.example.com", "ws://chat.example.com", "", "   ").forEach { url ->
            assertEquals(url, TransportVerdict.INSECURE_BLOCKED, BackendUrlPolicy.verdict(url, true))
            assertFalse(url, BackendUrlPolicy.permitsCredentials(url, true))
        }
    }

    @Test
    fun `an unparseable host fails closed`() {
        // URI.host is null for authorities it cannot parse, so this must not slip
        // through as loopback or secure.
        assertFalse(BackendUrlPolicy.permitsCredentials("http://bad_host_", true))
    }

    @Test
    fun `loopback detection ignores case and ipv6 brackets`() {
        assertTrue(BackendUrlPolicy.isLoopback("http://LOCALHOST:3000"))
        assertTrue(BackendUrlPolicy.isLoopback("http://[::1]:3000"))
        assertFalse(BackendUrlPolicy.isLoopback("http://192.168.1.50:3000"))
    }
}