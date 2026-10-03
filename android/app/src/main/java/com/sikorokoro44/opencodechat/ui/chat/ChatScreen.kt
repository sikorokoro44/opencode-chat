package com.sikorokoro44.opencodechat.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.sikorokoro44.opencodechat.data.model.MessageDto
import com.sikorokoro44.opencodechat.ui.UiState
import java.io.ByteArrayOutputStream
import java.io.InputStream

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    state: UiState,
    onBack: () -> Unit,
    onSend: (String) -> Unit,
    onSelectModel: (String) -> Unit,
    onStop: () -> Unit,
    onRegenerate: () -> Unit,
    onAttach: (ByteArray, String, String?) -> Unit,
    onRemoveAttachment: (String) -> Unit,
) {
    var input by remember { mutableStateOf("") }
    var attachError by remember { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            val resolver = context.contentResolver
            val mimeType = resolver.getType(uri) ?: "application/octet-stream"
            // The server rejects anything larger, so never buffer more than its ceiling.
            val bytes = runCatching { readBounded(resolver.openInputStream(uri), MAX_ATTACHMENT_BYTES) }.getOrNull()
            if (bytes == null) {
                attachError = "Attachment is too large or unreadable"
            } else {
                attachError = null
                onAttach(bytes, mimeType, uri.lastPathSegment)
            }
        }
    }

    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.chats.firstOrNull { it.id == state.activeChatId }?.title ?: "Chat") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (!state.streaming && state.messages.any { it.role == "assistant" }) {
                        IconButton(onClick = onRegenerate) {
                            Icon(Icons.Default.Refresh, contentDescription = "Regenerate")
                        }
                    }
                    ModelMenu(state = state, onSelectModel = onSelectModel)
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.messages, key = { it.id }) { message -> MessageBubble(message) }
            }

            if (state.streaming) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Generating…",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = onStop) {
                        Icon(Icons.Default.Close, contentDescription = "Stop")
                    }
                }
            }

            if (state.pendingAttachments.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    state.pendingAttachments.forEach { attachment ->
                        AssistChip(
                            onClick = { onRemoveAttachment(attachment.id) },
                            label = { Text(attachment.fileName ?: attachment.mimeType) },
                        )
                    }
                }
            }

            attachError?.let { problem ->
                Text(
                    text = problem,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(
                    onClick = { picker.launch("image/*") },
                    enabled = !state.streaming && !state.uploadingAttachment,
                ) {
                    Icon(Icons.Default.Add, contentDescription = "Attach image")
                }
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text("Message…") },
                    modifier = Modifier.weight(1f),
                    maxLines = 4,
                )
                IconButton(
                    onClick = {
                        onSend(input)
                        input = ""
                    },
                    enabled = input.isNotBlank() && !state.streaming,
                ) {
                    Icon(Icons.Default.Send, contentDescription = "Send")
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(message: MessageDto) {
    val fromUser = message.role == "user"
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (fromUser) Arrangement.End else Arrangement.Start,
    ) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = if (fromUser) {
                    MaterialTheme.colorScheme.primaryContainer
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
            ),
            modifier = Modifier.fillMaxWidth(0.9f),
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Text(
                    text = if (fromUser) "You" else (message.modelId ?: "Assistant"),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = message.content.ifEmpty { "…" },
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 4.dp),
                )
                if (message.attachments.isNotEmpty()) {
                    Text(
                        text = message.attachments.joinToString { it.fileName ?: it.mimeType },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelMenu(state: UiState, onSelectModel: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    IconButton(onClick = { expanded = true }) {
        Icon(Icons.Default.MoreVert, contentDescription = "Choose model")
    }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        state.models.forEach { model ->
            DropdownMenuItem(
                text = {
                    Text(
                        text = model.displayName ?: model.id,
                        textAlign = TextAlign.Start,
                    )
                },
                onClick = {
                    onSelectModel(model.id)
                    expanded = false
                },
            )
        }
    }
}

/** Matches the server's hard ceiling so oversized picks fail instead of exhausting memory. */
private const val MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** Reads at most [limit] bytes, or returns null when the stream is larger or unreadable. */
private fun readBounded(stream: InputStream?, limit: Int): ByteArray? {
    if (stream == null) return null
    return stream.use { source ->
        val buffer = ByteArray(8 * 1024)
        val collected = ByteArrayOutputStream()
        while (true) {
            val read = source.read(buffer)
            if (read < 0) break
            if (collected.size() + read > limit) return null
            collected.write(buffer, 0, read)
        }
        collected.toByteArray()
    }
}
