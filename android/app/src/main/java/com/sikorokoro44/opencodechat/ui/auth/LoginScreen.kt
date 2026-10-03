package com.sikorokoro44.opencodechat.ui.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.sikorokoro44.opencodechat.data.remote.BackendUrlPolicy
import com.sikorokoro44.opencodechat.data.remote.TransportVerdict
import com.sikorokoro44.opencodechat.ui.UiState

@Composable
fun LoginScreen(
    state: UiState,
    onBaseUrlChange: (String) -> Unit,
    onAllowInsecureHttpChange: (Boolean) -> Unit,
    onLogin: (String, String) -> Unit,
    onRegister: (String, String) -> Unit,
) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var registering by remember { mutableStateOf(false) }

    val verdict = remember(state.baseUrl, state.allowInsecureHttp) {
        BackendUrlPolicy.verdict(state.baseUrl, state.allowInsecureHttp)
    }
    val cleartextRemote = remember(state.baseUrl) {
        BackendUrlPolicy.isCleartextRemote(state.baseUrl)
    }
    // False until the user names a real server; the field ships empty.
    val configured = remember(state.baseUrl) {
        BackendUrlPolicy.configured(state.baseUrl).isNotEmpty()
    }
    val transportWarning = BackendUrlPolicy.explain(state.baseUrl, state.allowInsecureHttp)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "opencode-chat",
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            text = "Free streaming models with a GitHub coding agent",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
        )

        OutlinedTextField(
            value = state.baseUrl,
            onValueChange = onBaseUrlChange,
            label = { Text("Server URL") },
            // Hint text only: the app never stores or dials this example.
            placeholder = { Text(BackendUrlPolicy.SERVER_URL_EXAMPLE) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            supportingText = {
                Text(
                    when {
                        // Ask for the URL up front rather than letting a request
                        // fail with an unresolvable-host error.
                        !configured -> BackendUrlPolicy.MISSING_URL_MESSAGE
                        verdict == TransportVerdict.SECURE -> "Secured with https://"
                        verdict == TransportVerdict.LOOPBACK -> "http:// on this device only"
                        else -> "Unencrypted http:// — not safe for real credentials"
                    },
                )
            },
            isError = !configured || verdict == TransportVerdict.INSECURE_BLOCKED,
            modifier = Modifier.fillMaxWidth(),
        )

        if (cleartextRemote) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Checkbox(
                    checked = state.allowInsecureHttp,
                    onCheckedChange = onAllowInsecureHttpChange,
                )
                Text(
                    text = "Allow unencrypted HTTP for this server",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (transportWarning != null) {
                Text(
                    text = transportWarning,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
        }

        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("Username") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(20.dp))

        Button(
            onClick = { if (registering) onRegister(username, password) else onLogin(username, password) },
            enabled = !state.busy && username.isNotBlank() && password.isNotEmpty() && configured,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (registering) "Create account" else "Sign in")
        }
        TextButton(onClick = { registering = !registering }) {
            Text(if (registering) "I already have an account" else "Create a new account")
        }

        state.error?.let { message ->
            Text(
                text = message,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}
