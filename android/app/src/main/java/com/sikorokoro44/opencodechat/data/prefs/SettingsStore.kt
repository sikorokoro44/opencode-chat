package com.sikorokoro44.opencodechat.data.prefs

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.settingsDataStore by preferencesDataStore(name = "settings")

/** Non-secret settings such as the backend base URL. */
class SettingsStore(private val context: Context) {
    private val baseUrlKey = stringPreferencesKey("base_url")

    val baseUrlFlow: Flow<String> = context.settingsDataStore.data.map { preferences ->
        preferences[baseUrlKey]?.takeIf { it.isNotBlank() } ?: DEFAULT_BASE_URL
    }

    suspend fun baseUrl(): String = baseUrlFlow.first()

    suspend fun setBaseUrl(value: String) {
        context.settingsDataStore.edit { preferences ->
            preferences[baseUrlKey] = normalize(value)
        }
    }

    private fun normalize(value: String): String = value.trim().trimEnd('/')

    companion object {
        const val DEFAULT_BASE_URL = "https://opencode-chat.example.com"
    }
}
