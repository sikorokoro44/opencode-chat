package com.sikorokoro44.opencodechat.data.prefs

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.sikorokoro44.opencodechat.data.remote.BackendUrlPolicy
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** Non-secret settings such as the backend base URL. */
interface SettingsStore {
    val baseUrlFlow: Flow<String>
    suspend fun baseUrl(): String
    suspend fun setBaseUrl(value: String)

    /**
     * Explicit consent to send credentials to an `http://` backend that is not
     * on loopback. Defaults to false and is never inferred from the URL, so an
     * existing cleartext setting from an older release cannot silently keep
     * receiving tokens after an upgrade.
     */
    val allowInsecureHttpFlow: Flow<Boolean>
    suspend fun allowInsecureHttp(): Boolean
    suspend fun setAllowInsecureHttp(value: Boolean)

    companion object {
        /**
         * A fresh install has no server configured.
         *
         * There is deliberately no fabricated default here: pre-filling a
         * placeholder host sent the user to a domain that cannot resolve
         * ("Unable to resolve host"). The field starts empty and the app asks
         * for a URL before it touches the network.
         */
        const val DEFAULT_BASE_URL = ""
    }
}

private val Context.settingsDataStore by preferencesDataStore(name = "settings")

/** Preferences-DataStore implementation used by the app. */
class DataStoreSettingsStore(private val context: Context) : SettingsStore {
    private val baseUrlKey = stringPreferencesKey("base_url")
    private val allowInsecureHttpKey = booleanPreferencesKey("allow_insecure_http")

    override val baseUrlFlow: Flow<String> = context.settingsDataStore.data.map { preferences ->
        // configured() maps an absent, blank or retired-placeholder value to "",
        // so upgrading from v1.0.1 cannot resurrect its unresolvable default.
        BackendUrlPolicy.configured(preferences[baseUrlKey])
    }

    override val allowInsecureHttpFlow: Flow<Boolean> = context.settingsDataStore.data.map { preferences ->
        preferences[allowInsecureHttpKey] ?: false
    }

    override suspend fun baseUrl(): String = baseUrlFlow.first()

    override suspend fun setBaseUrl(value: String) {
        val normalized = normalize(value)
        context.settingsDataStore.edit { preferences ->
            preferences[baseUrlKey] = normalized
            // An opt-in only applies to a cleartext remote URL. Retract it as soon as
            // the backend is HTTPS or loopback so it cannot outlive its purpose.
            if (!BackendUrlPolicy.isCleartextRemote(normalized)) {
                preferences[allowInsecureHttpKey] = false
            }
        }
    }

    override suspend fun allowInsecureHttp(): Boolean = allowInsecureHttpFlow.first()

    override suspend fun setAllowInsecureHttp(value: Boolean) {
        // Read the base URL before opening the edit transaction: reading the same
        // DataStore from inside it would contend on its own write lock.
        val effective = value && BackendUrlPolicy.isCleartextRemote(baseUrlFlow.first())
        context.settingsDataStore.edit { preferences ->
            preferences[allowInsecureHttpKey] = effective
        }
    }
}

/** In-memory implementation so ViewModels and repositories can be tested on the JVM. */
class InMemorySettingsStore(initial: String = SettingsStore.DEFAULT_BASE_URL) : SettingsStore {
    private val state = MutableStateFlow(BackendUrlPolicy.configured(initial))
    private val allowInsecure = MutableStateFlow(false)

    override val baseUrlFlow: Flow<String> = state

    override val allowInsecureHttpFlow: Flow<Boolean> = allowInsecure

    override suspend fun baseUrl(): String = state.value

    override suspend fun setBaseUrl(value: String) {
        // configured() mirrors the DataStore read path, so this store reports ""
        // for an empty field and for the retired v1.0.1 placeholder alike.
        val normalized = BackendUrlPolicy.configured(value)
        state.value = normalized
        if (!BackendUrlPolicy.isCleartextRemote(normalized)) allowInsecure.value = false
    }

    override suspend fun allowInsecureHttp(): Boolean = allowInsecure.value

    override suspend fun setAllowInsecureHttp(value: Boolean) {
        allowInsecure.value = value && BackendUrlPolicy.isCleartextRemote(state.value)
    }
}

/**
 * Stores what the user configured and nothing else: a missing scheme becomes
 * https://, and an empty field stays empty instead of reverting to a default.
 */
private fun normalize(value: String): String = BackendUrlPolicy.normalize(value)
