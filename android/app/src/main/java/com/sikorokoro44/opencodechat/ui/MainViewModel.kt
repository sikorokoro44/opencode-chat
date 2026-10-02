package com.sikorokoro44.opencodechat.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.sikorokoro44.opencodechat.data.auth.AuthTokens
import com.sikorokoro44.opencodechat.data.model.ChatDto
import com.sikorokoro44.opencodechat.data.model.MessageDto
import com.sikorokoro44.opencodechat.data.model.ModelInfoDto
import com.sikorokoro44.opencodechat.data.remote.ApiResult
import com.sikorokoro44.opencodechat.di.AppContainer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class UiState(
    val booting: Boolean = true,
    val tokens: AuthTokens? = null,
    val baseUrl: String = "",
    val chats: List<ChatDto> = emptyList(),
    val activeChatId: String? = null,
    val messages: List<MessageDto> = emptyList(),
    val models: List<ModelInfoDto> = emptyList(),
    val selectedModelId: String? = null,
    val streaming: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
)

class MainViewModel(private val container: AppContainer) : ViewModel() {
    private val auth = container.authRepository
    private val chats = container.chatRepository

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val baseUrl = auth.baseUrl()
            val tokens = auth.currentTokens()
            _state.update { it.copy(booting = false, baseUrl = baseUrl, tokens = tokens) }
            if (tokens != null) refreshOverview()
        }
    }

    fun setBaseUrl(value: String) {
        _state.update { it.copy(baseUrl = value) }
        viewModelScope.launch { container.settingsStore.setBaseUrl(value) }
    }

    fun login(username: String, password: String) {
        viewModelScope.launch { authenticate { auth.login(username, password) } }
    }

    fun register(username: String, password: String) {
        viewModelScope.launch { authenticate { auth.register(username, password) } }
    }

    fun logout() {
        viewModelScope.launch {
            auth.logout()
            _state.value = UiState(booting = false, baseUrl = auth.baseUrl())
        }
    }

    fun dismissError() {
        _state.update { it.copy(error = null) }
    }

    fun newChat() {
        viewModelScope.launch {
            when (val result = chats.createChat(title = null)) {
                is ApiResult.Success -> {
                    _state.update {
                        it.copy(
                            activeChatId = result.value.id,
                            messages = emptyList(),
                            chats = listOf(result.value) + it.chats,
                        )
                    }
                }

                is ApiResult.Failure -> setError(result.message)
            }
        }
    }

    fun openChat(chatId: String) {
        _state.update { it.copy(activeChatId = chatId, messages = emptyList()) }
        viewModelScope.launch {
            when (val result = chats.getChat(chatId)) {
                is ApiResult.Success -> _state.update {
                    if (it.activeChatId == chatId) it.copy(messages = result.value.messages) else it
                }

                is ApiResult.Failure -> setError(result.message)
            }
        }
    }

    fun closeChat() {
        _state.update { it.copy(activeChatId = null, messages = emptyList()) }
    }

    fun deleteChat(chatId: String) {
        viewModelScope.launch {
            when (val result = chats.deleteChat(chatId)) {
                is ApiResult.Success -> _state.update { current ->
                    current.copy(
                        chats = current.chats.filterNot { it.id == chatId },
                        activeChatId = if (current.activeChatId == chatId) null else current.activeChatId,
                        messages = if (current.activeChatId == chatId) emptyList() else current.messages,
                    )
                }

                is ApiResult.Failure -> setError(result.message)
            }
        }
    }

    fun selectModel(modelId: String) {
        _state.update { it.copy(selectedModelId = modelId) }
    }

    fun send(content: String) {
        val trimmed = content.trim()
        if (trimmed.isEmpty() || _state.value.streaming) return
        viewModelScope.launch { runSend(trimmed) }
    }

    private suspend fun runSend(content: String) {
        val chatId = _state.value.activeChatId ?: when (val created = chats.createChat(title = null)) {
            is ApiResult.Success -> {
                _state.update { it.copy(activeChatId = created.value.id, chats = listOf(created.value) + it.chats) }
                created.value.id
            }

            is ApiResult.Failure -> {
                setError(created.message)
                return
            }
        }

        val userMessage = MessageDto(id = "local-user-${System.currentTimeMillis()}", role = "user", content = content)
        val assistantId = "local-assistant-${System.currentTimeMillis()}"
        _state.update {
            it.copy(
                streaming = true,
                error = null,
                messages = it.messages + userMessage + MessageDto(id = assistantId, role = "assistant", content = ""),
            )
        }

        val modelId = _state.value.selectedModelId
        try {
            chats.stream(chatId, content, modelId).collect { event ->
                when (event.type) {
                    "delta" -> event.text?.let { text ->
                        _state.update { current ->
                            current.copy(messages = current.messages.map { message ->
                                if (message.id == assistantId) message.copy(content = message.content + text) else message
                            })
                        }
                    }

                    "error" -> setError(event.message ?: event.code ?: "stream failed")
                    else -> Unit
                }
            }
        } catch (error: Exception) {
            setError(error.message ?: "stream failed")
        } finally {
            _state.update { it.copy(streaming = false) }
            refreshActiveChat(chatId)
            loadChats()
        }
    }

    private suspend fun authenticate(block: suspend () -> ApiResult<AuthTokens>) {
        when (val result = block()) {
            is ApiResult.Success -> {
                _state.update { it.copy(tokens = result.value, error = null) }
                refreshOverview()
            }

            is ApiResult.Failure -> setError(result.message)
        }
    }

    private suspend fun refreshOverview() {
        loadChats()
        when (val result = chats.models()) {
            is ApiResult.Success -> _state.update { current ->
                val primary = result.value.primaryModelId
                current.copy(
                    models = result.value.models,
                    selectedModelId = current.selectedModelId ?: primary,
                )
            }

            is ApiResult.Failure -> setError(result.message)
        }
    }

    private suspend fun loadChats() {
        when (val result = chats.listChats()) {
            is ApiResult.Success -> _state.update { it.copy(chats = result.value) }
            is ApiResult.Failure -> setError(result.message)
        }
    }

    private suspend fun refreshActiveChat(chatId: String) {
        when (val result = chats.getChat(chatId)) {
            is ApiResult.Success -> _state.update { current ->
                if (current.activeChatId == chatId) current.copy(messages = result.value.messages) else current
            }

            is ApiResult.Failure -> Unit
        }
    }

    private fun setError(message: String) {
        _state.update { it.copy(error = message) }
    }

    class Factory(private val container: AppContainer) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = MainViewModel(container) as T
    }
}
