package com.sikorokoro44.opencodechat.data.remote

/** A completed server-sent-event frame: the event name plus joined data lines. */
data class SseFrame(val event: String, val data: String)

/**
 * Incremental SSE parser. Feed it one line at a time (without the trailing
 * newline); it returns a frame when a blank line completes an event. Pure Kotlin
 * so it is covered by fast JVM unit tests instead of device tests.
 */
class SseParser {
    private val data = StringBuilder()
    private var eventName: String? = null

    fun feed(line: String): SseFrame? {
        if (line.isEmpty()) return dispatch()
        if (line.startsWith(":")) return null // comment / heartbeat
        val separator = line.indexOf(':')
        val field = if (separator == -1) line else line.substring(0, separator)
        val rawValue = if (separator == -1) "" else line.substring(separator + 1)
        val value = if (rawValue.startsWith(" ")) rawValue.substring(1) else rawValue
        when (field) {
            "event" -> eventName = value
            "data" -> {
                if (data.isNotEmpty()) data.append('\n')
                data.append(value)
            }
        }
        return null
    }

    /** Flushes a pending frame when the connection closes without a blank line. */
    fun flush(): SseFrame? = dispatch()

    fun reset() {
        data.setLength(0)
        eventName = null
    }

    private fun dispatch(): SseFrame? {
        if (data.isEmpty() && eventName == null) return null
        val frame = SseFrame(eventName ?: "message", data.toString())
        reset()
        return frame
    }
}
