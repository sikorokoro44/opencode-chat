package com.sikorokoro44.opencodechat.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sikorokoro44.opencodechat.data.model.ChatDto
import com.sikorokoro44.opencodechat.ui.UiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatsScreen(
    state: UiState,
    onNewChat: () -> Unit,
    onNewChatWithProject: (String?, String?, String?) -> Unit,
    onOpenChat: (String) -> Unit,
    onDeleteChat: (String) -> Unit,
    onOpenGithub: () -> Unit,
    onLogout: () -> Unit,
) {
    var setupOpen by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Chats") },
                actions = {
                    TextButton(onClick = onNewChat) { Text("Quick chat") }
                    TextButton(onClick = onOpenGithub) { Text("GitHub") }
                    TextButton(onClick = onLogout) { Text("Sign out") }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { setupOpen = true }) {
                Icon(Icons.Default.Add, contentDescription = "New chat")
            }
        },
    ) { padding ->
        if (state.chats.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Text("No chats yet. Tap + to start one.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize().padding(padding)) {
                items(state.chats, key = { it.id }) { chat ->
                    ChatRow(
                        chat = chat,
                        onOpen = { onOpenChat(chat.id) },
                        onDelete = { onDeleteChat(chat.id) },
                    )
                }
            }
        }
    }

    if (setupOpen) {
        ProjectSetupDialog(
            onDismiss = { setupOpen = false },
            onCreate = { repository, branch, path ->
                setupOpen = false
                onNewChatWithProject(repository, branch, path)
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatRow(chat: ChatDto, onOpen: () -> Unit, onDelete: () -> Unit) {
    ListItem(
        headlineContent = {
            Text(chat.title.ifBlank { "New chat" }, maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        supportingContent = {
            val project = chat.repository?.takeIf { it.isNotBlank() }
            Text(
                text = project?.let { repo -> buildString {
                    append(repo)
                    chat.branch?.takeIf { it.isNotBlank() }?.let { append(" · "); append(it) }
                } } ?: (chat.lastMessagePreview ?: "${chat.messageCount} messages"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        trailingContent = {
            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, contentDescription = "Delete chat")
            }
        },
        modifier = Modifier.clickable(onClick = onOpen),
    )
}

@Composable
private fun ProjectSetupDialog(
    onDismiss: () -> Unit,
    onCreate: (String?, String?, String?) -> Unit,
) {
    var repository by remember { mutableStateOf("") }
    var branch by remember { mutableStateOf("") }
    var projectPath by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Start a project chat") },
        text = {
            Column {
                Text(
                    text = "Optionally attach a GitHub repository. Repository must look like owner/name.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
                OutlinedTextField(
                    value = repository,
                    onValueChange = { repository = it },
                    label = { Text("Repository (owner/name)") },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = branch,
                    onValueChange = { branch = it },
                    label = { Text("Branch") },
                    singleLine = true,
                    modifier = Modifier.padding(top = 8.dp),
                )
                OutlinedTextField(
                    value = projectPath,
                    onValueChange = { projectPath = it },
                    label = { Text("Project path") },
                    singleLine = true,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onCreate(
                    repository.trim().ifBlank { null },
                    branch.trim().ifBlank { null },
                    projectPath.trim().ifBlank { null },
                )
            }) { Text("Create") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
