/**
 * GitHub service: token resolution, repository reads, agent writes, and the
 * GitHub-first project/session memory.
 *
 * Token resolution order (first match wins):
 *  1. the server service-account token, only when the caller presents the
 *     bootstrap token (`X-Opencode-Agent-Token`);
 *  2. the caller's own linked GitHub token, decrypted at rest.
 */

import { newId, nowIso } from "../ids.ts";
import { HttpError, badRequest, conflict, forbidden, unavailable } from "../http/errors.ts";
import { ID_TOKEN, assertRepoName, assertSafeRepoPath } from "../validate.ts";
import { EtagCache, GitHubApiError, GitHubClient } from "./github-client.ts";
import { SecretStore } from "./secret-box.ts";
import type { AgentActionSummary, Repo, RepoEntry } from "../api/types.ts";
import type { UserRecord } from "../store/records.ts";

export interface GitHubServiceOptions {
  baseUrl: string;
  serviceToken?: string;
  bootstrapToken: string;
  secretStore: SecretStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  memoryPath: string;
  defaultWriteBranchPrefix?: string;
}

export type GitHubCredential = "service-account" | "user";

export interface CommitFilesInput {
  user: UserRecord;
  owner: string;
  repo: string;
  baseBranch: string;
  branch?: string;
  commitMessage: string;
  files: { path: string; content: string }[];
  createPullRequest: boolean;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  bootstrapToken?: string;
  now?: () => number;
}

export interface CommitFilesResult {
  branch: string;
  baseBranch: string;
  commitSha: string | null;
  prUrl: string | null;
  files: string[];
  actions: AgentActionSummary[];
}

const MAX_WRITE_BYTES = 400_000;
const MAX_FILES_PER_COMMIT = 20;
/** Upper bound on documents read when listing session memory for one repository. */
const MAX_LISTED_SESSIONS = 50;
const MAX_SESSION_BYTES = 64 * 1024;

/** File-name convention shared by the write and the read side of session memory. */
const SESSION_PREFIX = "session-";
const SESSION_FILE = /^session-[A-Za-z0-9_-]{1,64}\.md$/;

/**
 * Session-document metadata keys. `renderSessionDocument` writes exactly these and
 * `parseSessionDocument` reads exactly these, so a recorded session always lists with
 * the metadata it was written with.
 */
const META = { chat: "chat", updated: "updated", messages: "messages" } as const;

function assertSessionId(chatId: string): string {
  if (!ID_TOKEN.test(chatId)) {
    throw badRequest("invalid_field", "chatId must be a single path-safe token");
  }
  return chatId;
}

function renderSessionDocument(input: {
  chatId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  summary: string;
}): string {
  return [
    `# ${input.title.replace(/\s+/g, " ").trim().slice(0, 200)}`,
    "",
    `${META.chat}: ${input.chatId}`,
    `${META.updated}: ${input.updatedAt}`,
    `${META.messages}: ${input.messageCount}`,
    "",
    input.summary,
    "",
  ].join("\n");
}

/**
 * Reads back the metadata written by `renderSessionDocument`. Unknown or hand-edited
 * documents degrade to empty values rather than failing the listing.
 */
function parseSessionDocument(content: string): { title: string; updatedAt: string; messageCount: number } {
  const result = { title: "", updatedAt: "", messageCount: 0 };
  const lines = content.split(/\r?\n/);
  const heading = lines[0] ?? "";
  if (heading.startsWith("# ")) result.title = heading.slice(2).trim();
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator <= 0) break; // metadata block ended: the summary follows
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === META.updated) result.updatedAt = value;
    else if (key === META.messages) result.messageCount = Number.parseInt(value, 10) || 0;
  }
  return result;
}

export class GitHubService {
  private readonly baseUrl: string;
  private readonly serviceToken: string | undefined;
  private readonly bootstrapToken: string;
  private readonly secretStore: SecretStore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly memoryPath: string;
  private readonly branchPrefix: string;
  /** Shared ETag cache so a busy instance issues far fewer GitHub reads. */
  private readonly sharedCache = new EtagCache();

  constructor(options: GitHubServiceOptions) {
    this.baseUrl = options.baseUrl;
    this.serviceToken = options.serviceToken;
    this.bootstrapToken = options.bootstrapToken;
    this.secretStore = options.secretStore;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.memoryPath = options.memoryPath;
    this.branchPrefix = options.defaultWriteBranchPrefix ?? "opencode-agent";
  }

  get memoryFilePath(): string {
    return this.memoryPath;
  }

  get hasServiceToken(): boolean {
    return Boolean(this.serviceToken);
  }

  get writesEnabled(): boolean {
    return this.bootstrapToken !== "" || this.serviceToken !== undefined;
  }

  /** Resolves the token for a call. Returns undefined when GitHub is unavailable. */
  credentialFor(user: UserRecord, presentedBootstrapToken?: string): { token: string; source: GitHubCredential } {
    const serviceAllowed =
      this.bootstrapToken !== "" && this.serviceToken !== undefined && presentedBootstrapToken !== undefined
        ? timingSafeEqualString(presentedBootstrapToken, this.bootstrapToken)
        : false;

    if (serviceAllowed) {
      return { token: this.serviceToken as string, source: "service-account" };
    }
    if (user.githubTokenCipher) {
      return { token: this.secretStore.open(user.githubTokenCipher, user.id), source: "user" };
    }
    throw forbidden("github_not_connected", "connect a GitHub token before using agent operations");
  }

  /**
   * Authorisation gate for agent entry points: resolves the caller's credential and
   * fails fast when there is none. Called before any model or GitHub work so an
   * unconnected account can neither reach another account's repository nor spend
   * provider quota on a run that could not do anything.
   */
  requireCredential(user: UserRecord, presentedBootstrapToken?: string): GitHubCredential {
    return this.credentialFor(user, presentedBootstrapToken).source;
  }

  private client(token: string): GitHubClient {
    return new GitHubClient({
      token,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      cache: this.sharedCache,
    });
  }

  async currentLogin(user: UserRecord, bootstrapToken?: string): Promise<{ login: string; source: GitHubCredential }> {
    const credential = this.credentialFor(user, bootstrapToken);
    const login = await this.client(credential.token).currentLogin();
    return { login, source: credential.source };
  }

  async listRepos(user: UserRecord, limit: number, bootstrapToken?: string): Promise<{ repos: Repo[]; credential: GitHubCredential }> {
    const credential = this.credentialFor(user, bootstrapToken);
    // Conditional GETs keep this hot path cheap for the mobile client.
    return { repos: await this.client(credential.token).listRepos(limit), credential: credential.source };
  }

  async listBranches(user: UserRecord, owner: string, repo: string, bootstrapToken?: string): Promise<{ name: string; sha: string }[]> {
    assertRepoName(owner, repo);
    const credential = this.credentialFor(user, bootstrapToken);
    return this.client(credential.token).listBranches(owner, repo);
  }

  async listContents(
    user: UserRecord,
    owner: string,
    repo: string,
    path: string,
    ref: string,
    bootstrapToken?: string,
  ): Promise<{ path: string; ref: string; entries: RepoEntry[] }> {
    assertRepoName(owner, repo);
    assertSafeRepoPath(path);
    const credential = this.credentialFor(user, bootstrapToken);
    return this.client(credential.token).listContents(owner, repo, path, ref);
  }

  async readFile(
    user: UserRecord,
    owner: string,
    repo: string,
    path: string,
    ref: string,
    bootstrapToken?: string,
  ): Promise<{ path: string; ref: string; sha: string; size: number; truncated: boolean; content: string; encoding: "utf-8" }> {
    assertRepoName(owner, repo);
    assertSafeRepoPath(path);
    const credential = this.credentialFor(user, bootstrapToken);
    const file = await this.client(credential.token).readTextFile(owner, repo, path, ref);
    return { ...file, encoding: "utf-8" as const };
  }

  async search(user: UserRecord, owner: string, repo: string, query: string, bootstrapToken?: string): Promise<RepoEntry[]> {
    assertRepoName(owner, repo);
    if (query.trim() === "") throw badRequest("invalid_field", "query must not be empty");
    const credential = this.credentialFor(user, bootstrapToken);
    return this.client(credential.token).searchCode(owner, repo, query.slice(0, 256));
  }

  async defaultBranch(user: UserRecord, owner: string, repo: string, bootstrapToken?: string): Promise<string> {
    assertRepoName(owner, repo);
    const credential = this.credentialFor(user, bootstrapToken);
    return this.client(credential.token).defaultBranch(owner, repo);
  }

  /**
   * Creates a branch off `baseBranch`, writes the files and optionally opens a PR.
   * Every step is recorded as an agent action so the client can render an audit trail.
   */
  async commitFiles(input: CommitFilesInput): Promise<CommitFilesResult> {
    assertRepoName(input.owner, input.repo);
    if (!this.writesEnabled) {
      throw unavailable("github_writes_disabled", "server is not configured for repository writes");
    }
    if (input.files.length === 0) {
      throw badRequest("no_files", "at least one file must be supplied");
    }
    if (input.files.length > MAX_FILES_PER_COMMIT) {
      throw badRequest("too_many_files", `at most ${MAX_FILES_PER_COMMIT} files per commit`);
    }

    const actions: AgentActionSummary[] = [];
    const branch = input.branch ?? `${this.branchPrefix}/${newId("b").slice(2, 10)}`;
    for (const file of input.files) {
      assertSafeRepoPath(file.path);
      if (Buffer.byteLength(file.content, "utf8") > MAX_WRITE_BYTES) {
        throw badRequest("file_too_large", `${file.path} exceeds ${MAX_WRITE_BYTES} bytes`);
      }
    }

    const credential = this.credentialFor(input.user, input.bootstrapToken);
    const client = this.client(credential.token);

    try {
      await client.createBranch(input.owner, input.repo, branch, input.baseBranch);
      actions.push({
        type: "write_file",
        summary: `created branch ${branch} from ${input.baseBranch}`,
        repository: `${input.owner}/${input.repo}`,
        branch,
        status: "ok",
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.githubStatus === 422) {
        throw conflictWithBranch(branch);
      }
      throw error;
    }

    const result = await client.commitFiles(input.owner, input.repo, branch, input.files, input.commitMessage);
    for (const file of result.committed) {
      actions.push({
        type: "write_file",
        summary: `wrote ${file}`,
        path: file,
        repository: `${input.owner}/${input.repo}`,
        branch,
        status: "ok",
      });
    }

    let prUrl: string | null = null;
    if (input.createPullRequest) {
      const pr = await client.openPullRequest(input.owner, input.repo, {
        title: input.pullRequestTitle ?? input.commitMessage.slice(0, 120),
        head: branch,
        base: input.baseBranch,
        body:
          input.pullRequestBody ??
          `Opened by opencode-chat coding agent on branch \`${branch}\`.\n\nFiles:\n${result.committed
            .map((file) => `- \`${file}\``)
            .join("\n")}`,
      });
      prUrl = pr.url;
      actions.push({
        type: "pull_request",
        summary: `opened pull request #${pr.number}`,
        url: pr.url,
        repository: `${input.owner}/${input.repo}`,
        branch,
        status: "ok",
      });
    }

    actions.push({
      type: "commit",
      summary: result.commitSha ? `committed ${result.committed.length} file(s)` : "no changes to commit",
      repository: `${input.owner}/${input.repo}`,
      branch,
      status: result.commitSha ? "ok" : "failed",
    });

    return {
      branch,
      baseBranch: input.baseBranch,
      commitSha: result.commitSha,
      prUrl,
      files: result.committed,
      actions,
    };
  }

  // ---------------------------------------------------------------- memory

  /**
   * Directory that holds the memory documents: the directory of `memoryPath`, so
   * project memory and session memory always live together. Both the read and the
   * write side derive their paths from here, which is what keeps them consistent.
   */
  sessionDirectory(): string {
    const separator = this.memoryPath.lastIndexOf("/");
    return separator === -1 ? "" : this.memoryPath.slice(0, separator);
  }

  /** Canonical file name for one chat's session document. */
  sessionPath(chatId: string): string {
    const directory = this.sessionDirectory();
    const name = `session-${assertSessionId(chatId)}.md`;
    return directory === "" ? name : `${directory}/${name}`;
  }

  /** Reads the GitHub-first project memory document. */
  async readMemory(
    user: UserRecord,
    owner: string,
    repo: string,
    ref: string,
    path = this.memoryPath,
    bootstrapToken?: string,
  ): Promise<{ exists: boolean; path: string; content: string; updatedAt: string | null }> {
    assertRepoName(owner, repo);
    assertSafeRepoPath(path);
    const credential = this.credentialFor(user, bootstrapToken);
    try {
      const file = await this.client(credential.token).readTextFile(owner, repo, path, ref, 256 * 1024);
      return {
        exists: true,
        path: file.path,
        content: file.content,
        updatedAt: commitTimestamp(file.sha),
      };
    } catch (error) {
      if (error instanceof GitHubApiError && error.githubStatus === 404) {
        return { exists: false, path, content: "", updatedAt: null };
      }
      throw error;
    }
  }

  /** Writes project memory back to GitHub, creating the branch when required. */
  async writeMemory(
    user: UserRecord,
    input: {
      owner: string;
      repo: string;
      branch: string;
      content: string;
      commitMessage: string;
      bootstrapToken?: string;
    },
  ): Promise<{ path: string; sha: string | null; branch: string; action: AgentActionSummary }> {
    assertRepoName(input.owner, input.repo);
    const path = this.memoryPath;
    assertSafeRepoPath(path);
    if (Buffer.byteLength(input.content, "utf8") > MAX_WRITE_BYTES) {
      throw badRequest("file_too_large", "project memory is too large");
    }

    const credential = this.credentialFor(user, input.bootstrapToken);
    const client = this.client(credential.token);
    const { branch, created } = await this.resolveMemoryBranch(client, input.owner, input.repo, input.branch);

    const result = await client.commitFiles(input.owner, input.repo, branch, [{ path, content: input.content }], input.commitMessage);
    const action: AgentActionSummary = {
      type: "memory_write",
      summary: `${created ? `created ${branch} and stored` : "stored"} project memory at ${path}`,
      path,
      repository: `${input.owner}/${input.repo}`,
      branch,
      status: result.commitSha ? "ok" : "failed",
    };
    return { path, sha: result.commitSha, branch, action };
  }

  /** Session memory lives next to project memory, one document per chat. */
  async listMemorySessions(
    user: UserRecord,
    owner: string,
    repo: string,
    ref: string,
    bootstrapToken?: string,
  ): Promise<{ chatId: string; title: string; updatedAt: string; messageCount: number }[]> {
    assertRepoName(owner, repo);
    const directory = this.sessionDirectory();
    assertSafeRepoPath(directory);
    const credential = this.credentialFor(user, bootstrapToken);
    const client = this.client(credential.token);
    let entries: RepoEntry[];
    try {
      const listing = await client.listContents(owner, repo, directory, ref);
      entries = listing.entries.filter((entry) => entry.type === "file" && SESSION_FILE.test(entry.name));
    } catch (error) {
      if (error instanceof GitHubApiError && error.githubStatus === 404) return [];
      throw error;
    }

    // Bounded so a repository with thousands of session documents cannot turn one
    // request into thousands of GitHub reads; ETag caching makes the repeat cheap.
    const page = entries.slice(0, MAX_LISTED_SESSIONS);
    const sessions = await Promise.all(
      page.map(async (entry) => {
        const chatId = entry.name.slice(SESSION_PREFIX.length, -".md".length);
        const base = { chatId, title: entry.name, updatedAt: "", messageCount: 0 };
        try {
          const document = await client.readTextFile(owner, repo, this.sessionPath(chatId), ref, MAX_SESSION_BYTES);
          return { ...base, ...parseSessionDocument(document.content) };
        } catch (error) {
          // A document that cannot be read is still listed; metadata stays empty.
          if (error instanceof GitHubApiError) return base;
          throw error;
        }
      }),
    );
    return sessions;
  }

  /** Stores an encrypted copy of the user's GitHub token after validating it. */
  async connectToken(user: UserRecord, token: string): Promise<{ login: string; connectedAt: string }> {
    const trimmed = token.trim();
    if (trimmed.length < 20 || trimmed.length > 255 || /\s/.test(trimmed)) {
      throw badRequest("invalid_token", "that does not look like a GitHub token");
    }
    const login = await this.client(trimmed).currentLogin();
    const connectedAt = nowIso();
    user.githubTokenCipher = this.secretStore.seal(trimmed, user.id);
    user.githubLogin = login;
    user.githubConnectedAt = connectedAt;
    return { login, connectedAt };
  }

  disconnectToken(user: UserRecord): void {
    delete user.githubTokenCipher;
    delete user.githubLogin;
    delete user.githubConnectedAt;
  }

  connectionStatus(user: UserRecord): { connected: boolean; login: string | null; connectedAt?: string } {
    return {
      connected: Boolean(user.githubTokenCipher),
      login: user.githubLogin ?? null,
      ...(user.githubConnectedAt ? { connectedAt: user.githubConnectedAt } : {}),
    };
  }

  /**
   * Stores one session document. Writes to the same path `listMemorySessions` reads
   * and in the same document format, so a recorded session is always listable.
   * Best-effort: a GitHub failure never fails the chat, but the reported result says
   * what actually happened.
   */
  async recordSessionMemory(
    user: UserRecord,
    input: {
      owner: string;
      repo: string;
      branch: string;
      chatId: string;
      title: string;
      summary: string;
      messageCount?: number;
      bootstrapToken?: string;
    },
  ): Promise<{ path: string; branch: string; stored: boolean }> {
    assertRepoName(input.owner, input.repo);
    const path = this.sessionPath(input.chatId);
    assertSafeRepoPath(path);
    const credential = this.credentialFor(user, input.bootstrapToken);
    const client = this.client(credential.token);
    const content = renderSessionDocument({
      chatId: input.chatId,
      title: input.title,
      updatedAt: nowIso(),
      messageCount: input.messageCount ?? 0,
      summary: input.summary,
    });

    let branch = input.branch;
    try {
      // Session memory is written to a branch the caller named, so the branch has to
      // exist; creating it from the default branch keeps the write from being
      // silently dropped (the previous hard-coded path never existed at all).
      const resolved = await this.resolveMemoryBranch(client, input.owner, input.repo, input.branch);
      branch = resolved.branch;
      const result = await client.commitFiles(
        input.owner,
        input.repo,
        branch,
        [{ path, content }],
        `memory: session ${input.chatId}`,
      );
      return { path, branch, stored: result.commitSha !== null };
    } catch (error) {
      if (error instanceof GitHubApiError) {
        // Memory is advisory; surface nothing about GitHub to the chat user.
        return { path, branch, stored: false };
      }
      throw error;
    }
  }

  /**
   * Returns the branch when it exists, otherwise creates `prefix/memory-<id>` from the
   * repository default branch. Shared by project memory and session memory so both
   * land on a branch that really exists.
   */
  private async resolveMemoryBranch(
    client: GitHubClient,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ branch: string; created: boolean }> {
    try {
      await client.getRef(owner, repo, branch);
      return { branch, created: false };
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.githubStatus !== 404) throw error;
      const base = await client.defaultBranch(owner, repo);
      const created = `${this.branchPrefix}/memory-${newId("m").slice(2, 8)}`;
      await client.createBranch(owner, repo, created, base);
      return { branch: created, created: true };
    }
  }
}

function conflictWithBranch(branch: string): HttpError {
  return conflict("branch_exists", `branch ${branch} already exists; choose another name`);
}

function commitTimestamp(sha: string): string | null {
  // The contents API returns a blob sha, which is not a timestamp; callers only use
  // it to know whether the document exists.
  return sha === "" ? null : new Date().toISOString();
}

export function timingSafeEqualString(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

