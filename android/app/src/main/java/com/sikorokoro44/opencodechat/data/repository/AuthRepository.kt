package com.sikorokoro44.opencodechat.data.repository

import com.sikorokoro44.opencodechat.data.auth.AuthTokens
import com.sikorokoro44.opencodechat.data.auth.TokenStore
import com.sikorokoro44.opencodechat.data.model.AuthResponse
import com.sikorokoro44.opencodechat.data.prefs.SettingsStore
import com.sikorokoro44.opencodechat.data.remote.ApiResult
import com.sikorokoro44.opencodechat.data.remote.BackendUrlPolicy
import com.sikorokoro44.opencodechat.data.remote.OpenCodeApi

/** Owns sign-in/out and transparently refreshes expired access tokens. */
class AuthRepository(
    private val api: OpenCodeApi,
    private val tokenStore: TokenStore,
    private val settingsStore: SettingsStore,
    private val deviceName: String,
) {
    suspend fun register(username: String, password: String): ApiResult<AuthTokens> {
        val baseUrl = settingsStore.baseUrl()
        insecureTransport(baseUrl)?.let { return it }
        return persist(api.register(baseUrl, username, password, deviceName))
    }

    suspend fun login(username: String, password: String): ApiResult<AuthTokens> {
        val baseUrl = settingsStore.baseUrl()
        insecureTransport(baseUrl)?.let { return it }
        return persist(api.login(baseUrl, username, password, deviceName))
    }

    suspend fun logout(): ApiResult<Unit> {
        val current = tokenStore.read()
        val result = if (current == null) {
            ApiResult.Success(Unit)
        } else {
            val baseUrl = settingsStore.baseUrl()
            insecureTransport(baseUrl) ?: api.logout(baseUrl, current.refreshToken)
        }
        // Sign out locally even when the backend is unreachable or refusing
        // cleartext, so a token is never left sitting on the device.
        tokenStore.clear()
        return result
    }

    suspend fun currentTokens(): AuthTokens? = tokenStore.read()

    suspend fun baseUrl(): String = settingsStore.baseUrl()

    suspend fun allowInsecureHttp(): Boolean = settingsStore.allowInsecureHttp()

    /**
     * Failure describing why [baseUrl] may not carry credentials, or null when
     * it may. Every path that puts a password, access token or refresh token on
     * the wire checks this first.
     */
    suspend fun insecureTransport(baseUrl: String): ApiResult.Failure? {
        val allowed = settingsStore.allowInsecureHttp()
        if (BackendUrlPolicy.permitsCredentials(baseUrl, allowed)) return null
        return ApiResult.Failure(
            code = "insecure_transport",
            message = BackendUrlPolicy.explain(baseUrl, allowed)
                ?: "Refusing to send credentials over an unencrypted connection.",
        )
    }

    /** Runs [block] with a live access token, refreshing once on a 401. */
    suspend fun <T> withValidToken(block: suspend (baseUrl: String, token: String) -> ApiResult<T>): ApiResult<T> {
        val baseUrl = settingsStore.baseUrl()
        insecureTransport(baseUrl)?.let { return it }
        val current = tokenStore.read()
            ?: return ApiResult.Failure("unauthorized", "not signed in", status = 401)
        val first = block(baseUrl, current.accessToken)
        if (first !is ApiResult.Failure || first.status != 401) return first

        return when (val refreshed = api.refresh(baseUrl, current.refreshToken)) {
            is ApiResult.Success -> {
                tokenStore.save(refreshed.value.toTokens())
                block(baseUrl, refreshed.value.accessToken)
            }

            is ApiResult.Failure -> {
                tokenStore.clear()
                first
            }
        }
    }

    private suspend fun persist(result: ApiResult<AuthResponse>): ApiResult<AuthTokens> = when (result) {
        is ApiResult.Success -> {
            val tokens = result.value.toTokens()
            tokenStore.save(tokens)
            ApiResult.Success(tokens)
        }

        is ApiResult.Failure -> result
    }
}

fun AuthResponse.toTokens(): AuthTokens = AuthTokens(
    accessToken = accessToken,
    refreshToken = refreshToken,
    userId = user.id,
    username = user.username,
)
