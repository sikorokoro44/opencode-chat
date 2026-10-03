package com.sikorokoro44.opencodechat.data.remote

import java.net.URI
import java.net.URISyntaxException

/**
 * How the configured backend URL may be used.
 *
 * [INSECURE_BLOCKED] is the only verdict that forbids credentials.
 */
enum class TransportVerdict(val permitsCredentials: Boolean) {
    /** https:// — the secure default. */
    SECURE(true),

    /** http:// to a loopback address, where traffic never leaves the device. */
    LOOPBACK(true),

    /** http:// to a remote host, which the user has explicitly allowed. */
    INSECURE_ALLOWED(true),

    /** Anything else: plain HTTP to a remote host without an explicit opt-in. */
    INSECURE_BLOCKED(false),
}

/**
 * Transport rules for the user-supplied backend URL.
 *
 * HTTPS is the default: a URL typed without a scheme is normalised to
 * `https://`. Plain HTTP is only tolerated for the loopback interface, or for
 * a remote host once the user has explicitly opted in. Callers must consult
 * [verdict] before attaching an access token, a refresh token or a password,
 * so credentials never reach an unencrypted socket by accident.
 *
 * The platform enforces its own half of this rule: the shipped
 * `network_security_config.xml` refuses cleartext for every host except
 * loopback. This policy is the application-layer guard that runs first and
 * explains the refusal to the user.
 *
 * There is no default server: [configured] returns "" until the user supplies
 * one, and [SERVER_URL_EXAMPLE] exists purely as hint text. Nothing here
 * resolves a host, so an unconfigured app fails closed with a message instead
 * of attempting DNS for a host that does not exist.
 */
object BackendUrlPolicy {
    private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.\\-]*://")

    /**
     * Shape of the URL to suggest, shown only as placeholder text in the
     * Server URL field. It is never stored, never defaulted to and never
     * dialled: a fabricated host must not become something the app talks to.
     * It is `https://` so the suggestion keeps the secure transport.
     */
    const val SERVER_URL_EXAMPLE = "https://chat.example.com"

    /** Told to the user instead of a DNS error when no server is configured yet. */
    const val MISSING_URL_MESSAGE = "Enter your server URL, for example $SERVER_URL_EXAMPLE"

    /**
     * The placeholder that shipped as the v1.0.1 default. It is under a
     * reserved documentation domain and never resolved, so wherever it was
     * persisted it counts as "no server configured" rather than as a host to
     * dial on upgrade.
     */
    const val RETIRED_PLACEHOLDER_URL = "https://opencode-chat.example.com"

    /** Trims, drops trailing slashes and defaults a missing scheme to https. */
    fun normalize(raw: String): String {
        val trimmed = raw.trim().trimEnd('/')
        if (trimmed.isEmpty()) return ""
        return if (SCHEME.containsMatchIn(trimmed)) trimmed else "https://$trimmed"
    }

    /**
     * The URL to actually use, or "" when nothing usable was configured.
     *
     * First run therefore has no server at all: callers see an empty string and
     * ask the user for one instead of resolving a host that does not exist.
     */
    fun configured(raw: String?): String {
        val normalized = normalize(raw.orEmpty())
        val retired = normalized.equals(RETIRED_PLACEHOLDER_URL, ignoreCase = true)
        return if (normalized.isEmpty() || retired) "" else normalized
    }

    fun verdict(raw: String, allowInsecureHttp: Boolean): TransportVerdict {
        val uri = parse(raw) ?: return TransportVerdict.INSECURE_BLOCKED
        return when (uri.scheme?.lowercase()) {
            "https" -> TransportVerdict.SECURE
            "http" -> when {
                isLoopbackHost(uri.host) -> TransportVerdict.LOOPBACK

                // An authority we cannot parse is never trusted, even with consent.
                uri.host.isNullOrEmpty() -> TransportVerdict.INSECURE_BLOCKED
                allowInsecureHttp -> TransportVerdict.INSECURE_ALLOWED
                else -> TransportVerdict.INSECURE_BLOCKED
            }

            else -> TransportVerdict.INSECURE_BLOCKED
        }
    }

    fun permitsCredentials(raw: String, allowInsecureHttp: Boolean): Boolean =
        verdict(raw, allowInsecureHttp).permitsCredentials

    /** True when the URL points at the loopback interface (127.0.0.0/8 or localhost). */
    fun isLoopback(raw: String): Boolean = parse(raw)?.let { isLoopbackHost(it.host) } ?: false

    fun isHttps(raw: String): Boolean = parse(raw)?.scheme?.lowercase() == "https"

    /**
     * True for `http://` URLs off loopback, which is the only case where
     * [allowInsecureHttp] can change the outcome.
     */
    fun isCleartextRemote(raw: String): Boolean {
        val uri = parse(raw) ?: return false
        if (uri.scheme?.lowercase() != "http") return false
        val host = uri.host
        return !host.isNullOrEmpty() && !isLoopbackHost(host)
    }

    /**
     * Message shown when the configured URL cannot carry credentials, or null
     * when the URL is fine as configured.
     */
    fun explain(raw: String, allowInsecureHttp: Boolean): String? = when (verdict(raw, allowInsecureHttp)) {
        TransportVerdict.SECURE, TransportVerdict.LOOPBACK -> null
        TransportVerdict.INSECURE_ALLOWED ->
            "This server uses unencrypted HTTP. Your password and tokens are being sent in the clear on this network."

        TransportVerdict.INSECURE_BLOCKED -> when {
            // Nothing has been entered yet, so say what is missing instead of
            // letting the request fail later with a DNS error.
            configured(raw).isEmpty() -> MISSING_URL_MESSAGE

            parse(raw) == null ->
                "Enter a valid server URL, for example $SERVER_URL_EXAMPLE"

            else ->
                "Refusing to send credentials over unencrypted HTTP. Use an https:// server URL, " +
                    "or tick \"Allow unencrypted HTTP\" if you fully trust this network."
        }
    }

    private fun parse(raw: String): URI? {
        val normalized = normalize(raw)
        if (normalized.isEmpty()) return null
        return try {
            URI(normalized)
        } catch (invalid: URISyntaxException) {
            null
        }
    }

    /** URI.host is null for authorities it cannot parse, which fails closed. */
    private fun isLoopbackHost(host: String?): Boolean {
        val name = host?.lowercase()?.removePrefix("[")?.removeSuffix("]") ?: return false
        return name == "localhost" || name == "::1" || name.startsWith("127.")
    }
}