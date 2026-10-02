package com.sikorokoro44.opencodechat.di

import android.content.Context
import android.os.Build
import com.sikorokoro44.opencodechat.data.auth.KeystoreTokenStore
import com.sikorokoro44.opencodechat.data.auth.TokenStore
import com.sikorokoro44.opencodechat.data.prefs.SettingsStore
import com.sikorokoro44.opencodechat.data.remote.ChatStreamClient
import com.sikorokoro44.opencodechat.data.remote.OpenCodeApi
import com.sikorokoro44.opencodechat.data.repository.AuthRepository
import com.sikorokoro44.opencodechat.data.repository.ChatRepository
import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

class DefaultAppContainer(private val context: Context) : AppContainer {
    override val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }

    override val httpClient: HttpClient by lazy {
        val mediaType = this.json
        HttpClient(Android) {
            expectSuccess = false
            install(ContentNegotiation) { json(mediaType) }
            install(HttpTimeout) {
                requestTimeoutMillis = STREAM_TIMEOUT_MS
                connectTimeoutMillis = CONNECT_TIMEOUT_MS
                socketTimeoutMillis = STREAM_TIMEOUT_MS
            }
        }
    }

    override val tokenStore: TokenStore by lazy { KeystoreTokenStore(context, json) }

    override val settingsStore: SettingsStore by lazy { SettingsStore(context) }

    override val api: OpenCodeApi by lazy { OpenCodeApi(httpClient, json) }

    private val streamClient: ChatStreamClient by lazy { ChatStreamClient(httpClient, json) }

    override val authRepository: AuthRepository by lazy {
        AuthRepository(api, tokenStore, settingsStore, "${Build.MANUFACTURER} ${Build.MODEL}".trim())
    }

    override val chatRepository: ChatRepository by lazy {
        ChatRepository(api, streamClient, authRepository)
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 15_000L
        const val STREAM_TIMEOUT_MS = 300_000L
    }
}
