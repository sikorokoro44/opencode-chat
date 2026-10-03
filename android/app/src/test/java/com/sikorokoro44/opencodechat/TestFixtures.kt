package com.sikorokoro44.opencodechat

import com.sikorokoro44.opencodechat.data.auth.AuthTokens
import com.sikorokoro44.opencodechat.data.auth.TokenStore
import com.sikorokoro44.opencodechat.data.prefs.InMemorySettingsStore
import com.sikorokoro44.opencodechat.data.prefs.SettingsStore
import com.sikorokoro44.opencodechat.data.remote.ChatStreamClient
import com.sikorokoro44.opencodechat.data.remote.OpenCodeApi
import com.sikorokoro44.opencodechat.data.repository.AuthRepository
import com.sikorokoro44.opencodechat.data.repository.ChatRepository
import com.sikorokoro44.opencodechat.data.repository.GithubRepository
import com.sikorokoro44.opencodechat.di.AppContainer
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import kotlinx.serialization.json.Json

/** In-memory token store so repositories and ViewModels are testable without Android. */
class InMemoryTokenStore(initial: AuthTokens? = null) : TokenStore {
    private var tokens: AuthTokens? = initial

    override suspend fun read(): AuthTokens? = tokens

    override suspend fun save(tokens: AuthTokens) {
        this.tokens = tokens
    }

    override suspend fun clear() {
        tokens = null
    }
}

/** Hand-wired dependency graph backed by a MockEngine. */
class FakeAppContainer(
    override val json: Json,
    override val httpClient: HttpClient,
    override val tokenStore: TokenStore,
    override val settingsStore: SettingsStore,
    override val api: OpenCodeApi,
    override val authRepository: AuthRepository,
    override val chatRepository: ChatRepository,
    override val githubRepository: GithubRepository,
) : AppContainer

fun testJson(): Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

fun testContainer(engine: MockEngine, tokens: AuthTokens? = null): AppContainer {
    val json = testJson()
    val client = HttpClient(engine) { expectSuccess = false }
    val api = OpenCodeApi(client, json)
    val tokenStore = InMemoryTokenStore(tokens)
    val settingsStore = InMemorySettingsStore("https://example.test")
    val authRepository = AuthRepository(api, tokenStore, settingsStore, "test-device")
    val streamClient = ChatStreamClient(client, json)
    val chatRepository = ChatRepository(api, streamClient, authRepository)
    val githubRepository = GithubRepository(api, authRepository)
    return FakeAppContainer(
        json = json,
        httpClient = client,
        tokenStore = tokenStore,
        settingsStore = settingsStore,
        api = api,
        authRepository = authRepository,
        chatRepository = chatRepository,
        githubRepository = githubRepository,
    )
}
