package com.sikorokoro44.opencodechat.data.auth

import kotlinx.serialization.Serializable

@Serializable
data class AuthTokens(
    val accessToken: String,
    val refreshToken: String,
    val userId: String,
    val username: String,
)

/** Persists the signed-in session so the app can restart without logging in again. */
interface TokenStore {
    suspend fun read(): AuthTokens?
    suspend fun save(tokens: AuthTokens)
    suspend fun clear()
}
