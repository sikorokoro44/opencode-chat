package com.sikorokoro44.opencodechat.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.sikorokoro44.opencodechat.data.auth.AuthTokens
import com.sikorokoro44.opencodechat.data.model.AgentActionDto
import com.sikorokoro44.opencodechat.data.model.AgentRunRequest
import com.sikorokoro44.opencodechat.data.model.AttachmentDto
import com.sikorokoro44.opencodechat.data.model.BranchDto
import com.sikorokoro44.opencodechat.data.model.ChatDto
import com.sikorokoro44.opencodechat.data.model.ChatStreamEvent
import com.sikorokoro44.opencodechat.data.model.MemorySessionDto
import com.sikorokoro44.opencodechat.data.model.MessageDto
import com.sikorokoro44.opencodechat.data.model.ModelInfoDto
import com.sikorokoro44.opencodechat.data.model.RepoDto
import com.sikorokoro44.opencodechat.data.model.UpdateChatRequest
import com.sikorokoro44.opencodechat.data.remote.ApiResult
import com.sikorokoro44.opencodechat.di.AppContainer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong

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
    val pendingAttachments: List<AttachmentDto> = emptyList(),
    val uploadingAttachment: Boolean = false,
    val githubConnected: Boolean = false,
    val githubLogin: String? = null,
    val githubRepos: List<RepoDto> = emptyList(),
    val githubBranches: List<BranchDto> = emptyList(),
    val githubOpen: Boolean = false,
    val githubBusy: Boolean = false,
    val githubSessions: List<MemorySessionDto> = emptyList(),
    val agentRunning: Boolean = false,
    val agentOutput: String? = null,
    val agentActions: List<AgentActionDto> = emptyList(),
    val projectRepository: String? = null,
    val projectBranch: String? = null,
    val projectPath: String? = null,
)

class MainViewModel(private val container: AppContainer) : ViewModel() {
    private val auth = container.authRepository
    private val chats = container.chatRepository
    private val github = container.githubRepository

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var streamJob: Job? = null
    private var lastSend: Pair<String, List<String>>? = null

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
            stopInternal()
            auth.logout()
            _state.value = UiState(booting = false, baseUrl = auth.baseUrl())
        }
    }

    fun dismissError() {
        _state.update { it.copy(error = null) }
    }

    fun newChat() {
        viewModelScope.launch { runNewChat(null, null, null) }
    }

    fun newChatWithProject(repository: String?, branch: String?, projectPath: String?) {
        viewModelScope.launch { runNewChat(repository, branch, projectPath) }
    }

    private suspend fun runNewChat(repository: String?, branch: String?, projectPath: String?) {
        val trimmedRepository = repository?.trim()?.ifBlank { null }
        if (trimmedRepository != null) {
            val parts = trimmedRepository.split('/', limit = 2)
            if (parts.size != 2 || parts.any { it.isBlank() }) {
                setError("Repository must look like owner/name")
                return
            }
        }
        val trimmedPath = try {
            normalizeProjectPath(projectPath)
        } catch (invalid: IllegalArgumentException) {
            setError(invalid.message ?: "Invalid path")
            return
        }
        when (val result = chats.createChat(
            title = null,
            repository = trimmedRepository,
            branch = branch?.trim()?.ifBlank { null },
            projectPath = trimmedPath,
            modelId = _state.value.selectedModelId,
        )) {
            is ApiResult.Success -> _state.update {
                it.copy(
                    activeChatId = result.value.id,
                    messages = emptyList(),
                    chats = listOf(result.value) + it.chats,
                    projectRepository = result.value.repository,
                    projectBranch = result.value.branch,
                    projectPath = result.value.projectPath,
                )
            }

            is ApiResult.Failure -> setError(result.message)
        }
    }

    fun openChat(chatId: String) {
        _state.update { it.copy(activeChatId = chatId, messages = emptyList(), agentOutput = null, agentActions = emptyList()) }
        viewModelScope.launch {
            when (val result = chats.getChat(chatId)) {
                is ApiResult.Success -> _state.update {
                    if (it.activeChatId == chatId) {
                        it.copy(
                            messages = result.value.messages,
                            projectRepository = result.value.chat.repository,
                            projectBranch = result.value.chat.branch,
                            projectPath = result.value.chat.projectPath,
                        )
                    } else {
                        it
                    }
                }

                is ApiResult.Failure -> setError(result.message)
            }
        }
    }

    fun closeChat() {
        stopInternal()
        _state.update { it.copy(activeChatId = null, messages = emptyList(), pendingAttachments = emptyList()) }
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

    // ------------------------------------------------------------------ chat

    fun send(content: String) {
        val trimmed = content.trim()
        if (trimmed.isEmpty() || _state.value.streaming) return
        val attachmentIds = _state.value.pendingAttachments.map { it.id }.take(8)
        lastSend = trimmed to attachmentIds
        viewModelScope.launch { runSend(trimmed, attachmentIds) }
    }

    fun stop() {
        val job = streamJob
        streamJob = null
        job?.cancel()
        _state.update { it.copy(streaming = false) }
        val chatId = _state.value.activeChatId
        if (chatId != null) {
            viewModelScope.launch {
                refreshActiveChat(chatId)
                loadChats()
            }
        }
    }

    fun retry() {
        regenerate()
    }

    fun regenerate() {
        val chatId = _state.value.activeChatId ?: return
        if (_state.value.streaming) return
        val trimmed = _state.value.messages.dropLastWhile { it.role != "user" }
        if (trimmed.isEmpty()) {
            val last = lastSend ?: return
            viewModelScope.launch { runSend(last.first, last.second) }
            return
        }
        val assistantId = localId("assistant")
        _state.update {
            it.copy(
                streaming = true,
                error = null,
                messages = trimmed + MessageDto(id = assistantId, role = "assistant", content = ""),
            )
        }
        streamJob = viewModelScope.launch {
            collectEvents(chatId, assistantId, chats.regenerate(chatId, _state.value.selectedModelId))
        }
    }

    private suspend fun runSend(content: String, attachmentIds: List<String>) {
        val chatId = _state.value.activeChatId ?: when (val created = chats.createChat(
            title = null,
            repository = _state.value.projectRepository,
            branch = _state.value.projectBranch,
            projectPath = _state.value.projectPath,
            modelId = _state.value.selectedModelId,
        )) {
            is ApiResult.Success -> {
                _state.update { it.copy(activeChatId = created.value.id, chats = listOf(created.value) + it.chats) }
                created.value.id
            }

            is ApiResult.Failure -> {
                setError(created.message)
                return
            }
        }

        val attachments = _state.value.pendingAttachments
        val userMessage = MessageDto(
            id = localId("user"),
            role = "user",
            content = content,
            attachments = attachments,
        )
        val assistantId = localId("assistant")
        _state.update {
            it.copy(
                streaming = true,
                error = null,
                pendingAttachments = emptyList(),
                messages = it.messages + userMessage + MessageDto(id = assistantId, role = "assistant", content = ""),
            )
        }

        streamJob = viewModelScope.launch {
            collectEvents(chatId, assistantId, chats.stream(chatId, content, _state.value.selectedModelId, attachmentIds))
        }
    }

    private suspend fun collectEvents(chatId: String, assistantId: String, flow: kotlinx.coroutines.flow.Flow<ChatStreamEvent>) {
        try {
            flow.collect { event -> handleStreamEvent(assistantId, event) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            setError(error.message ?: "stream failed")
        } finally {
            _state.update { current ->
                current.copy(
                    streaming = false,
                    messages = current.messages.map { message ->
                        if (message.id == assistantId && message.content.isEmpty() && message.errorCode == null) {
                            message.copy(content = "(no response)")
                        } else {
                            message
                        }
                    },
                )
            }
            streamJob = null
            withContext(NonCancellable) {
                refreshActiveChat(chatId)
                loadChats()
            }
        }
    }

    private fun handleStreamEvent(assistantId: String, event: ChatStreamEvent) {
        when (event.type) {
            "delta" -> event.text?.let { text ->
                _state.update { current ->
                    current.copy(messages = current.messages.map { message ->
                        if (message.id == assistantId) message.copy(content = message.content + text) else message
                    })
                }
            }

            // Adopt the server-assigned id so a reload reconciles with this bubble.
            "meta", "done" -> {
                val serverId = event.messageId
                if (!serverId.isNullOrBlank() && serverId != assistantId) {
                    _state.update { current ->
                        if (current.messages.any { it.id == serverId }) {
                            current
                        } else {
                            current.copy(messages = current.messages.map { message ->
                                if (message.id == assistantId) message.copy(id = serverId) else message
                            })
                        }
                    }
                }
            }

            "error" -> setError(event.message ?: event.code ?: "stream failed")
            else -> Unit
        }
    }

    // ----------------------------------------------------------- attachments

    fun attach(data: ByteArray, mimeType: String, fileName: String?) {
        viewModelScope.launch {
            _state.update { it.copy(uploadingAttachment = true) }
            when (val result = chats.uploadAttachment(data, mimeType, fileName, _state.value.activeChatId)) {
                is ApiResult.Success -> _state.update {
                    it.copy(pendingAttachments = (it.pendingAttachments + result.value).take(8), uploadingAttachment = false)
                }

                is ApiResult.Failure -> {
                    _state.update { it.copy(uploadingAttachment = false) }
                    setError(result.message)
                }
            }
        }
    }

    fun removeAttachment(id: String) {
        _state.update { it.copy(pendingAttachments = it.pendingAttachments.filterNot { attachment -> attachment.id == id }) }
    }

    // ---------------------------------------------------------------- github

    fun openGithub() {
        _state.update { it.copy(githubOpen = true) }
        viewModelScope.launch { loadGithub() }
    }

    fun closeGithub() {
        _state.update { it.copy(githubOpen = false) }
    }

    fun connectGithub(githubToken: String) {
        viewModelScope.launch {
            _state.update { it.copy(githubBusy = true) }
            when (val result = github.connect(githubToken)) {
                is ApiResult.Success -> {
                    _state.update { it.copy(githubBusy = false, error = null) }
                    loadGithub()
                }

                is ApiResult.Failure -> {
                    _state.update { it.copy(githubBusy = false) }
                    setError(result.message)
                }
            }
        }
    }

    fun disconnectGithub() {
        viewModelScope.launch {
            _state.update { it.copy(githubBusy = true) }
            when (val result = github.disconnect()) {
                is ApiResult.Success -> _state.update {
                    it.copy(githubBusy = false, githubConnected = false, githubLogin = null, githubRepos = emptyList(), githubBranches = emptyList())
                }

                is ApiResult.Failure -> {
                    _state.update { it.copy(githubBusy = false) }
                    setError(result.message)
                }
            }
        }
    }

    private suspend fun loadGithub() {
        when (val status = github.status()) {
            is ApiResult.Success -> _state.update {
                it.copy(githubConnected = status.value.connected, githubLogin = status.value.login)
            }

            is ApiResult.Failure -> {
                setError(status.message)
                return
            }
        }
        if (!_state.value.githubConnected) return

        when (val repos = github.repos()) {
            is ApiResult.Success -> _state.update { it.copy(githubRepos = repos.value) }
            is ApiResult.Failure -> setError(repos.message)
        }
    }

    fun selectRepository(repo: RepoDto) {
        val owner = repo.owner.ifBlank { repo.fullName.substringBefore('/') }
        val name = repo.name.ifBlank { repo.fullName.substringAfter('/') }
        val fullName = repo.fullName.ifBlank { "$owner/$name" }
        if (owner.isBlank() || name.isBlank()) {
            setError("That repository entry is missing an owner or name")
            return
        }
        _state.update {
            it.copy(projectRepository = fullName, projectBranch = repo.defaultBranch, githubBranches = emptyList())
        }
        viewModelScope.launch {
            when (val branches = github.branches(owner, name)) {
                is ApiResult.Success -> _state.update { it.copy(githubBranches = branches.value) }
                is ApiResult.Failure -> Unit
            }
        }
    }

    fun setProjectBranch(branch: String) {
        _state.update { it.copy(projectBranch = branch) }
    }

    fun setProjectPath(path: String) {
        _state.update { it.copy(projectPath = path.ifBlank { null }) }
    }

    /**
     * Mirrors the server's `assertSafeRepoPath` so the user sees the problem
     * before a round trip instead of an opaque rejection.
     */
    private fun normalizeProjectPath(raw: String?): String? {
        val value = raw?.trim().orEmpty()
        if (value.isEmpty()) return null
        if (value.length > MAX_PROJECT_PATH) throw IllegalArgumentException("Path is too long")
        if (value.startsWith("/")) throw IllegalArgumentException("Path must be relative to the repository root")
        if (value.contains("..")) throw IllegalArgumentException("Path must not traverse upwards")
        if (value.contains("\\")) throw IllegalArgumentException("Path must use forward slashes")
        if (value.any { it.isISOControl() }) throw IllegalArgumentException("Path must not contain control characters")
        return value.trimEnd('/')
    }

    /** Persists repository/branch/project path onto the active chat. */
    fun applyProjectState() {
        val projectPath = try {
            normalizeProjectPath(_state.value.projectPath)
        } catch (invalid: IllegalArgumentException) {
            setError(invalid.message ?: "Invalid path")
            return
        }
        val chatId = _state.value.activeChatId ?: return
        val repository = _state.value.projectRepository
        val branch = _state.value.projectBranch
        viewModelScope.launch {
            when (val result = chats.updateChat(
                chatId,
                UpdateChatRequest(repository = repository, branch = branch, projectPath = projectPath),
            )) {
                is ApiResult.Success -> _state.update { current ->
                    current.copy(
                        chats = current.chats.map { if (it.id == chatId) result.value else it },
                        projectPath = projectPath,
                    )
                }

                is ApiResult.Failure -> setError(result.message)
            }
        }
    }

    fun runAgent(prompt: String) {
        val repository = _state.value.projectRepository
        if (repository.isNullOrBlank()) {
            setError("Select a repository first")
            return
        }
        val trimmed = prompt.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            _state.update { it.copy(agentRunning = true, agentOutput = "", agentActions = emptyList(), error = null) }
            val request = AgentRunRequest(
                repository = repository,
                prompt = trimmed,
                branch = _state.value.projectBranch,
                modelId = _state.value.selectedModelId,
                chatId = _state.value.activeChatId,
            )
            when (val result = github.runAgent(request)) {
                is ApiResult.Success -> _state.update {
                    it.copy(agentRunning = false, agentOutput = result.value.text, agentActions = result.value.agentActions)
                }

                is ApiResult.Failure -> {
                    _state.update { it.copy(agentRunning = false) }
                    setError(result.message)
                }
            }
        }
    }

    fun recordSession() {
        val repository = _state.value.projectRepository ?: return
        val chatId = _state.value.activeChatId ?: return
        val parts = repository.split("/", limit = 2)
        if (parts.size != 2) {
            setError("Repository must look like owner/name")
            return
        }
        val messages = _state.value.messages
        val summary = messages.takeLast(20).joinToString("\n") { "${it.role}: ${it.content}" }.take(16_000)
        if (summary.isBlank()) {
            setError("Nothing to record yet")
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(githubBusy = true) }
            val branch = _state.value.projectBranch ?: "main"
            val title = _state.value.chats
                .firstOrNull { it.id == chatId }
                ?.title
                ?.takeIf { it.isNotBlank() }
                ?: "Chat $chatId"
            val result = github.recordSession(
                parts[0],
                parts[1],
                branch,
                chatId,
                title,
                summary,
                messages.size,
            )
            when (result) {
                is ApiResult.Success -> {
                    _state.update { it.copy(githubBusy = false) }
                    // `stored` is false when the commit did not land: do not present an
                    // unrecorded session as saved.
                    if (!result.value.stored) setError("Session could not be written to GitHub")
                    else loadSessions()
                }

                is ApiResult.Failure -> {
                    _state.update { it.copy(githubBusy = false) }
                    setError(result.message)
                }
            }
        }
    }

    private suspend fun loadSessions() {
        val repository = _state.value.projectRepository ?: return
        val parts = repository.split("/", limit = 2)
        if (parts.size != 2) return
        when (val result = github.sessions(parts[0], parts[1])) {
            is ApiResult.Success -> _state.update { it.copy(githubSessions = result.value) }
            is ApiResult.Failure -> Unit
        }
    }

    // --------------------------------------------------------------- helpers

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

    private fun stopInternal() {
        streamJob?.cancel()
        streamJob = null
    }

    private fun setError(message: String) {
        _state.update { it.copy(error = message) }
    }

    /** Unique per ViewModel: list keys must never collide, even within one millisecond. */
    private fun localId(role: String): String {
        val sequence = localIdSequence.incrementAndGet()
        return "local-$role-${System.currentTimeMillis()}-$sequence"
    }

    private val localIdSequence = AtomicLong(0)

    private companion object {
        /** Matches the server limit for a repository-relative path. */
        const val MAX_PROJECT_PATH = 1024
    }

    class Factory(private val container: AppContainer) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = MainViewModel(container) as T
    }
}
