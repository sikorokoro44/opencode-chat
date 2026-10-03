package com.sikorokoro44.opencodechat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Guards the shipped `network_security_config.xml`.
 *
 * The Kotlin policy in `BackendUrlPolicy` can refuse to build a request, but
 * the platform rule is the backstop: even if some future code path attaches an
 * `Authorization` header by mistake, Android must still refuse to put it on a
 * cleartext socket. These assertions fail if that backstop is weakened.
 */
class NetworkSecurityConfigTest {
    private data class ParsedConfig(
        val baseCleartext: String,
        val cleartextDomains: Set<String>,
    )

    private fun parse(vararg path: String): ParsedConfig {
        val file = locate(*path)
        val document = DocumentBuilderFactory.newInstance()
            .newDocumentBuilder()
            .parse(file)

        val base = document.getElementsByTagName("base-config").item(0) as Element
        val cleartextDomains = mutableSetOf<String>()
        val configs = document.getElementsByTagName("domain-config")
        for (index in 0 until configs.length) {
            val config = configs.item(index) as Element
            if (config.getAttribute("cleartextTrafficPermitted") != "true") continue
            val domains = config.getElementsByTagName("domain")
            for (domainIndex in 0 until domains.length) {
                cleartextDomains += (domains.item(domainIndex) as Element).textContent.trim()
            }
        }
        return ParsedConfig(base.getAttribute("cleartextTrafficPermitted"), cleartextDomains)
    }

    private fun locate(vararg path: String): File {
        var directory: File? = File("").absoluteFile
        while (directory != null) {
            val candidate = File(directory, path.joinToString("/"))
            if (candidate.isFile) return candidate
            directory = directory.parentFile
        }
        throw AssertionError("could not locate ${path.joinToString("/")} from ${File("").absolutePath}")
    }

    private fun release() = parse("src", "main", "res", "xml", "network_security_config.xml")

    private fun debug() = parse("src", "debug", "res", "xml", "network_security_config.xml")

    @Test
    fun `release refuses cleartext for every host by default`() {
        assertEquals(
            "v1.0.0 shipped cleartextTrafficPermitted=\"true\" globally",
            "false",
            release().baseCleartext,
        )
    }

    @Test
    fun `release permits cleartext only on loopback`() {
        assertEquals(setOf("localhost", "127.0.0.1"), release().cleartextDomains)
    }

    @Test
    fun `the emulator host alias never reaches a release build`() {
        assertFalse(
            "10.0.2.2 is routable in 10.0.0.0/8 and must be debug-only",
            release().cleartextDomains.contains("10.0.2.2"),
        )
    }

    @Test
    fun `the debug override adds the emulator alias without weakening the default`() {
        val debug = debug()
        assertEquals("false", debug.baseCleartext)
        assertTrue(debug.cleartextDomains.containsAll(release().cleartextDomains))
        assertTrue(debug.cleartextDomains.contains("10.0.2.2"))
    }
}