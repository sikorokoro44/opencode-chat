package com.sikorokoro44.opencodechat.data.prefs

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** Non-secret settings such as the backend base URL. */
interface SettingsStore {
    val baseUrlFlow: Flow<String>
    suspend fun baseUrl(): String
    suspend fun setBaseUrl(value: String)

    companion object {
        const val DEFAULT_BASE_URL = "https://opencode-chat.example.com"
    }
}

private val Context.settingsDataStore by preferencesDataStore(name = "settings")

/** Preferences-DataStore implementation used by the app. */
class DataStoreSettingsStore(private val context: Context) : SettingsStore {
    private val baseUrlKey = stringPreferencesKey("base_url")

    override val baseUrlFlow: Flow<String> = context.settingsDataStore.data.map { preferences ->
        preferences[baseUrlKey]?.takeIf { it.isNotBlank() } ?: SettingsStore.DEFAULT_BASE_URL
    }

    override suspend fun baseUrl(): String = baseUrlFlow.first()

    override suspend fun setBaseUrl(value: String) {
        context.settingsDataStore.edit { preferences ->
            preferences[baseUrlKey] = normalize(value)
        }
    }
}

/** In-memory implementation so ViewModels and repositories can be tested on the JVM. */
class InMemorySettingsStore(initial: String = SettingsStore.DEFAULT_BASE_URL) : SettingsStore {
    private val state = MutableStateFlow(normalize(initial))

    override val baseUrlFlow: Flow<String> = state

    override suspend fun baseUrl(): String = state.value

    override suspend fun setBaseUrl(value: String) {
        state.value = normalize(value)
    }
}

private fun normalize(value: String): String = value.trim().trimEnd('/')
