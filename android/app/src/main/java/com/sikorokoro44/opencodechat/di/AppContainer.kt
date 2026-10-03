package com.sikorokoro44.opencodechat.di

import com.sikorokoro44.opencodechat.data.auth.TokenStore
import com.sikorokoro44.opencodechat.data.prefs.SettingsStore
import com.sikorokoro44.opencodechat.data.remote.OpenCodeApi
import com.sikorokoro44.opencodechat.data.repository.AuthRepository
import com.sikorokoro44.opencodechat.data.repository.ChatRepository
import com.sikorokoro44.opencodechat.data.repository.GithubRepository
import io.ktor.client.HttpClient
import kotlinx.serialization.json.Json

/** Hand-written dependency graph: no DI framework on low-RAM devices. */
interface AppContainer {
    val json: Json
    val httpClient: HttpClient
    val tokenStore: TokenStore
    val settingsStore: SettingsStore
    val api: OpenCodeApi
    val authRepository: AuthRepository
    val chatRepository: ChatRepository
    val githubRepository: GithubRepository
}
