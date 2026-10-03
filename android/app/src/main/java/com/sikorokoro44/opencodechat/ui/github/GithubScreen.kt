package com.sikorokoro44.opencodechat.ui.github

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sikorokoro44.opencodechat.data.model.RepoDto
import com.sikorokoro44.opencodechat.ui.UiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GithubScreen(
    state: UiState,
    onBack: () -> Unit,
    onConnect: (String) -> Unit,
    onDisconnect: () -> Unit,
    onSelectRepository: (RepoDto) -> Unit,
    onProjectBranch: (String) -> Unit,
    onProjectPath: (String) -> Unit,
    onApplyProject: () -> Unit,
    onRecordSession: () -> Unit,
    onRunAgent: (String) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("GitHub") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        if (!state.githubConnected) {
            Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
                Text(
                    text = "Connect a GitHub personal access token to use repository memory and the coding agent.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                GithubTokenForm(busy = state.githubBusy, onConnect = onConnect)
            }
            return@Scaffold
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            item {
                ListItem(
                    headlineContent = { Text("Connected as ${state.githubLogin ?: "GitHub"}") },
                    trailingContent = {
                        TextButton(onClick = onDisconnect, enabled = !state.githubBusy) { Text("Disconnect") }
                    },
                )
            }

            item {
                ProjectCard(
                    state = state,
                    onProjectBranch = onProjectBranch,
                    onProjectPath = onProjectPath,
                    onApplyProject = onApplyProject,
                    onRecordSession = onRecordSession,
                )
            }

            item {
                Text(
                    text = "Repositories",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(16.dp),
                )
            }
            itemsIndexed(state.githubRepos, key = { index, repo -> "repo-$index-${repo.fullName}" }) { _, repo ->
                ListItem(
                    headlineContent = { Text(repo.fullName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = {
                        Text(
                            text = repo.description ?: (repo.language ?: "repository"),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    modifier = Modifier.clickable { onSelectRepository(repo) },
                )
            }

            if (state.githubBranches.isNotEmpty()) {
                item {
                    Text(
                        text = "Branches",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(16.dp),
                    )
                }
                itemsIndexed(state.githubBranches, key = { index, branch -> "branch-$index-${branch.name}" }) { _, branch ->
                    ListItem(
                        headlineContent = { Text(branch.name) },
                        modifier = Modifier.clickable { onProjectBranch(branch.name) },
                    )
                }
            }

            if (state.githubSessions.isNotEmpty()) {
                item {
                    Text(
                        text = "Recorded sessions",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(16.dp),
                    )
                }
                itemsIndexed(state.githubSessions, key = { index, session -> "session-$index-${session.chatId}" }) { _, session ->
                    ListItem(
                        headlineContent = { Text(session.title.ifBlank { session.chatId }) },
                        supportingContent = { Text("${session.messageCount} messages · ${session.updatedAt}") },
                    )
                }
            }

            item {
                HorizontalDivider()
                AgentPanel(
                    state = state,
                    onRunAgent = onRunAgent,
                )
            }
        }
    }
}

@Composable
private fun GithubTokenForm(busy: Boolean, onConnect: (String) -> Unit) {
    var token by remember { mutableStateOf("") }
    OutlinedTextField(
        value = token,
        onValueChange = { token = it },
        label = { Text("Personal access token") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
    )
    Button(
        onClick = {
            onConnect(token)
            token = ""
        },
        enabled = !busy && token.isNotBlank(),
        modifier = Modifier.padding(top = 12.dp),
    ) {
        Text("Connect")
    }
}

@Composable
private fun ProjectCard(
    state: UiState,
    onProjectBranch: (String) -> Unit,
    onProjectPath: (String) -> Unit,
    onApplyProject: () -> Unit,
    onRecordSession: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = "Active project",
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                text = state.projectRepository ?: "No repository selected",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 4.dp),
            )
            OutlinedTextField(
                value = state.projectBranch ?: "",
                onValueChange = onProjectBranch,
                label = { Text("Branch") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            OutlinedTextField(
                value = state.projectPath ?: "",
                onValueChange = onProjectPath,
                label = { Text("Project path") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            Row(modifier = Modifier.padding(top = 8.dp)) {
                Button(
                    onClick = onApplyProject,
                    enabled = state.activeChatId != null && !state.githubBusy,
                ) {
                    Text("Apply to chat")
                }
                OutlinedButton(
                    onClick = onRecordSession,
                    enabled = state.activeChatId != null && state.projectRepository != null && !state.githubBusy,
                    modifier = Modifier.padding(start = 8.dp),
                ) {
                    Text("Record session")
                }
            }
        }
    }
}

@Composable
private fun AgentPanel(state: UiState, onRunAgent: (String) -> Unit) {
    var prompt by remember { mutableStateOf("") }
    Column(modifier = Modifier.padding(16.dp)) {
        Text(text = "Coding agent", style = MaterialTheme.typography.titleSmall)
        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it },
            label = { Text("Ask the agent to inspect or change the repo") },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            maxLines = 4,
        )
        Button(
            onClick = {
                onRunAgent(prompt)
                prompt = ""
            },
            enabled = !state.agentRunning && state.projectRepository != null,
            modifier = Modifier.padding(top = 8.dp),
        ) {
            Text(if (state.agentRunning) "Running…" else "Run agent")
        }
        state.agentOutput?.let { output ->
            Text(
                text = output,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 12.dp),
            )
        }
        state.agentActions.forEach { action ->
            Text(
                text = "• ${action.summary ?: action.type}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
