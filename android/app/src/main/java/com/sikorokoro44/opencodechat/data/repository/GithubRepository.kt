package com.sikorokoro44.opencodechat.data.repository

import com.sikorokoro44.opencodechat.data.model.AgentCommitRequest
import com.sikorokoro44.opencodechat.data.model.AgentCommitResponse
import com.sikorokoro44.opencodechat.data.model.AgentRunRequest
import com.sikorokoro44.opencodechat.data.model.AgentRunResponse
import com.sikorokoro44.opencodechat.data.model.BranchDto
import com.sikorokoro44.opencodechat.data.model.ContentsResponse
import com.sikorokoro44.opencodechat.data.model.FileResponse
import com.sikorokoro44.opencodechat.data.model.GithubStatusDto
import com.sikorokoro44.opencodechat.data.model.MemoryResponse
import com.sikorokoro44.opencodechat.data.model.MemorySessionDto
import com.sikorokoro44.opencodechat.data.model.RecordSessionRequest
import com.sikorokoro44.opencodechat.data.model.RecordSessionResponse
import com.sikorokoro44.opencodechat.data.model.RepoDto
import com.sikorokoro44.opencodechat.data.model.WriteMemoryRequest
import com.sikorokoro44.opencodechat.data.model.WriteMemoryResponse
import com.sikorokoro44.opencodechat.data.remote.ApiResult
import com.sikorokoro44.opencodechat.data.remote.OpenCodeApi

/** GitHub-first project memory and coding-agent operations. */
class GithubRepository(
    private val api: OpenCodeApi,
    private val auth: AuthRepository,
) {
    suspend fun status(): ApiResult<GithubStatusDto> =
        auth.withValidToken { base, token -> api.githubStatus(base, token) }

    suspend fun connect(githubToken: String): ApiResult<Unit> =
        auth.withValidToken { base, token -> api.connectGithub(base, token, githubToken) }

    suspend fun disconnect(): ApiResult<Unit> =
        auth.withValidToken { base, token -> api.disconnectGithub(base, token) }

    suspend fun repos(limit: Int = 100): ApiResult<List<RepoDto>> =
        auth.withValidToken { base, token -> api.githubRepos(base, token, limit) }.asList { it.repos }

    suspend fun branches(owner: String, repo: String): ApiResult<List<BranchDto>> =
        auth.withValidToken { base, token -> api.githubBranches(base, token, owner, repo) }.asList { it.branches }

    suspend fun contents(owner: String, repo: String, path: String, ref: String?): ApiResult<ContentsResponse> =
        auth.withValidToken { base, token -> api.githubContents(base, token, owner, repo, path, ref) }

    suspend fun file(owner: String, repo: String, path: String, ref: String?): ApiResult<FileResponse> =
        auth.withValidToken { base, token -> api.githubFile(base, token, owner, repo, path, ref) }

    suspend fun memory(owner: String, repo: String): ApiResult<MemoryResponse> =
        auth.withValidToken { base, token -> api.readMemory(base, token, owner, repo) }

    suspend fun writeMemory(
        owner: String,
        repo: String,
        branch: String,
        content: String,
        commitMessage: String,
    ): ApiResult<WriteMemoryResponse> =
        auth.withValidToken { base, token ->
            api.writeMemory(base, token, WriteMemoryRequest(owner, repo, branch, content, commitMessage))
        }

    suspend fun sessions(owner: String, repo: String): ApiResult<List<MemorySessionDto>> =
        auth.withValidToken { base, token -> api.listMemorySessions(base, token, owner, repo) }
            .asList { it.sessions }

    suspend fun recordSession(
        owner: String,
        repo: String,
        branch: String,
        chatId: String,
        title: String,
        summary: String,
        messageCount: Int? = null,
    ): ApiResult<RecordSessionResponse> =
        auth.withValidToken { base, token ->
            api.recordMemorySession(
                base,
                token,
                RecordSessionRequest(owner, repo, branch, chatId, title, summary, messageCount),
            )
        }

    suspend fun runAgent(request: AgentRunRequest): ApiResult<AgentRunResponse> =
        auth.withValidToken { base, token -> api.runAgent(base, token, request) }

    suspend fun commit(request: AgentCommitRequest): ApiResult<AgentCommitResponse> =
        auth.withValidToken { base, token -> api.commitAgent(base, token, request) }

    private inline fun <T, R> ApiResult<T>.asList(transform: (T) -> List<R>): ApiResult<List<R>> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(value))
            is ApiResult.Failure -> this
        }
}
