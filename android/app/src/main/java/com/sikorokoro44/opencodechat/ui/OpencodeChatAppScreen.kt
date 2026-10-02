package com.sikorokoro44.opencodechat.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.sikorokoro44.opencodechat.OpencodeChatApp
import com.sikorokoro44.opencodechat.ui.auth.LoginScreen
import com.sikorokoro44.opencodechat.ui.chat.ChatScreen
import com.sikorokoro44.opencodechat.ui.chat.ChatsScreen

@Composable
fun OpencodeChatAppScreen() {
    val context = LocalContext.current
    val container = remember(context) { (context.applicationContext as OpencodeChatApp).container }
    val viewModel: MainViewModel = viewModel(factory = MainViewModel.Factory(container))
    val state by viewModel.state.collectAsState()

    Box(modifier = Modifier.fillMaxSize()) {
        when {
            state.booting -> Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }

            state.tokens == null -> LoginScreen(
                state = state,
                onBaseUrlChange = viewModel::setBaseUrl,
                onLogin = viewModel::login,
                onRegister = viewModel::register,
            )

            state.activeChatId == null -> ChatsScreen(
                state = state,
                onNewChat = viewModel::newChat,
                onOpenChat = viewModel::openChat,
                onDeleteChat = viewModel::deleteChat,
                onLogout = viewModel::logout,
            )

            else -> {
                BackHandler { viewModel.closeChat() }
                ChatScreen(
                    state = state,
                    onBack = viewModel::closeChat,
                    onSend = viewModel::send,
                    onSelectModel = viewModel::selectModel,
                )
            }
        }

        state.error?.let { message ->
            Snackbar(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(16.dp)
                    .clickable { viewModel.dismissError() },
                containerColor = MaterialTheme.colorScheme.errorContainer,
                contentColor = MaterialTheme.colorScheme.onErrorContainer,
            ) {
                Text(message)
            }
        }
    }
}
