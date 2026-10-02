/**
 * GitHub REST client.
 *
 * Responsibilities kept deliberately narrow: authenticated requests, ETags for
 * conditional reads, bounded retries with jitter for secondary rate limits, and
 * errors that never leak the token. All agent operations are built on top of this.
 */

import { sleep } from "../ids.ts";
import { HttpError } from "../http/errors.ts";
import type { Repo, RepoEntry } from "../api/types.ts";

export interface GitHubClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
  /** Share an ETag cache across clients so conditional reads are reused. */
  cache?: EtagCache;
  /** Injectable clock/random keeps retry tests deterministic. */
  now?: () => number;
  random?: () => number;
}

export interface GitHubRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  accept?: string;
  etag?: string;
  /** Bypasses the conditional-GET cache. */
  noCache?: boolean;
}

export interface GitHubResponse<T> {
  data: T;
  status: number;
  etag?: string;
  /** True when the server answered 304 and `data` came from the local cache. */
  notModified: boolean;
}

export class GitHubApiError extends HttpError {
  readonly githubStatus: number;
  readonly documentationUrl?: string;

  constructor(status: number, message: string, documentationUrl?: string, headers?: Record<string, string>) {
    const retryable = status === 403 || status === 429 || status >= 500;
    super(status === 404 ? 404 : status === 422 ? 400 : status >= 500 ? 502 : status, `github_${status}`, message, {
      retryable,
      headers,
    });
    this.githubStatus = status;
    this.documentationUrl = documentationUrl;
  }
}

/** Small LRU of ETag -> body used for cheap conditional reads. */
export class EtagCache {
  private readonly entries = new Map<string, { etag: string; body: string; storedAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(maxEntries = 256, ttlMs = 60_000, now: () => number = () => Date.now()) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string): { etag: string; body: string } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { etag: entry.etag, body: entry.body };
  }

  set(key: string, etag: string, body: string): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { etag, body, storedAt: this.now() });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export class GitHubClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly cache: EtagCache;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.userAgent = options.userAgent ?? "opencode-chat-backend/1.0";
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.cache = options.cache ?? new EtagCache();
  }

  get etagCache(): EtagCache {
    return this.cache;
  }



  async request<T>(path: string, options: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    const method = options.method ?? "GET";
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const cacheKey = `${method} ${url}`;
    const cached = method === "GET" && !options.noCache ? this.cache.get(cacheKey) : undefined;
    const useConditional = cached !== undefined && method === "GET" && !options.noCache;

    let attempt = 0;
    for (;;) {
      const headers: Record<string, string> = {
        accept: options.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": this.userAgent,
        authorization: `Bearer ${this.token}`,
      };
      if (method !== "GET" && method !== "DELETE" && options.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (useConditional && cached) headers["if-none-match"] = cached.etag;

      const signal = AbortSignal.timeout(this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(options.body !== undefined && method !== "GET" && method !== "DELETE"
            ? { body: JSON.stringify(options.body) }
            : {}),
          signal,
        });
      } catch (error) {
        const timedOut = (error as { name?: string }).name === "TimeoutError" || (error as { name?: string }).name === "AbortError";
        if (attempt < this.maxRetries && timedOut) {
          attempt += 1;
          await sleep(this.backoffMs(attempt), undefined);
          continue;
        }
        throw new GitHubApiError(504, timedOut ? "GitHub request timed out" : "GitHub is unreachable");
      }

      if (response.status === 304 && cached) {
        return { data: JSON.parse(cached.body) as T, status: 304, etag: cached.etag, notModified: true };
      }

      if (response.status === 403 || response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        if (attempt < this.maxRetries && Number.isFinite(retryAfter) && retryAfter <= 5) {
          attempt += 1;
          await sleep(retryAfter * 1000, undefined);
          continue;
        }
        const remaining = response.headers.get("x-ratelimit-remaining");
        if (remaining === "0" && attempt < this.maxRetries) {
          attempt += 1;
          await sleep(this.backoffMs(attempt), undefined);
          continue;
        }
        throw new GitHubApiError(response.status, this.describeLimit(response.status));
      }

      if (!response.ok) {
        const detail = await readErrorMessage(response);
        throw new GitHubApiError(response.status, detail.message, detail.documentationUrl);
      }

      const text = await response.text();
      // The contents API returns raw file text for `vnd.github.raw`; only attempt
      // JSON parsing and otherwise hand the body back verbatim.
      let data: unknown;
      if (text === "") {
        data = undefined;
      } else {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      const etag = response.headers.get("etag") ?? undefined;
      if (etag && method === "GET" && typeof text === "string") {
        this.cache.set(cacheKey, etag, text);
      }
      return { data: data as T, status: response.status, etag, notModified: false };
    }
  }

  private backoffMs(attempt: number): number {
    const base = 250 * 2 ** (attempt - 1);
    return Math.min(base + Math.floor(this.random() * 100), 4_000);
  }

  private describeLimit(status: number): string {
    return status === 429
      ? "GitHub rate limit exceeded; try again shortly"
      : "GitHub denied the request (rate limit or insufficient scope)";
  }

  async currentLogin(): Promise<string> {
    const { data } = await this.request<{ login: string }>("/user", { noCache: true });
    return data.login;
  }

  async listRepos(limit = 100): Promise<Repo[]> {
    const capped = Math.min(Math.max(limit, 1), 200);
    const { data } = await this.request<GitHubRepo[]>(`/user/repos?per_page=${capped}&sort=updated&affiliation=owner,collaborator,organization_member`);
    return data.map(toRepo);
  }

  async listBranches(owner: string, repo: string): Promise<{ name: string; sha: string }[]> {
    const { data } = await this.request<{ name: string; commit: { sha: string } }[]>(
      `/repos/${owner}/${repo}/branches?per_page=100`,
    );
    return data.map((branch) => ({ name: branch.name, sha: branch.commit.sha }));
  }

  async listContents(owner: string, repo: string, path: string, ref?: string): Promise<{ path: string; ref: string; entries: RepoEntry[] }> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const pathPart = path === "" ? "" : `/${path.split("/").map(encodeURIComponent).join("/")}`;
    const { data } = await this.request<GitHubContent[]>(`/repos/${owner}/${repo}/contents${pathPart}${query}`);
    const entries = (Array.isArray(data) ? data : [data]).map(toEntry);
    entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === "dir" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return { path, ref: ref ?? "", entries };
  }

  async readTextFile(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    maxBytes = 512 * 1024,
  ): Promise<{ path: string; ref: string; sha: string; size: number; truncated: boolean; content: string }> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const { data } = await this.request<GitHubContent>(
      `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      { accept: "application/vnd.github.raw+json" },
    );
    if (typeof data === "string") {
      const truncated = Buffer.byteLength(data, "utf8") > maxBytes;
      return {
        path,
        ref,
        sha: "",
        size: Buffer.byteLength(data, "utf8"),
        truncated,
        content: truncated ? Buffer.from(data, "utf8").subarray(0, maxBytes).toString("utf8") : data,
      };
    }
    const base64 = (data.content ?? "").replace(/\n/g, "");
    const buffer = Buffer.from(base64, "base64");
    const truncated = buffer.length > maxBytes;
    return {
      path: data.path,
      ref,
      sha: data.sha,
      size: buffer.length,
      truncated,
      content: buffer.subarray(0, maxBytes).toString("utf8"),
    };
  }

  /** Creates a branch at `baseRef`'s head sha. Returns the new branch name. */
  async createBranch(owner: string, repo: string, branch: string, baseRef: string): Promise<string> {
    const { data } = await this.request<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseRef)}`,
      { noCache: true },
    );
    await this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: data.object.sha },
    });
    return branch;
  }

  async getRef(owner: string, repo: string, branch: string): Promise<string | undefined> {
    const result = await this.request<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { noCache: true },
    );
    return result.data.object.sha;
  }

  /** Writes files to a branch through the contents API, one request per file. */
  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    files: { path: string; content: string; message?: string }[],
    commitMessage: string,
  ): Promise<{ commitSha: string | null; committed: string[]; skipped: string[] }> {
    const committed: string[] = [];
    const skipped: string[] = [];
    let commitSha: string | null = null;

    for (const file of files) {
      const encoded = file.path.split("/").map(encodeURIComponent).join("/");
      let sha: string | undefined;
      try {
        const existing = await this.request<GitHubContent>(
          `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
          { noCache: true },
        );
        if (typeof existing.data !== "string") sha = existing.data.sha;
      } catch (error) {
        if (error instanceof GitHubApiError && error.githubStatus !== 404) throw error;
      }

      const message = `${commitMessage}\n\n${file.message ?? `Update ${file.path}`}`;
      const { data } = await this.request<GitHubCommitResult>(
        `/repos/${owner}/${repo}/contents/${encoded}`,
        {
          method: "PUT",
          body: {
            message,
            content: Buffer.from(file.content, "utf8").toString("base64"),
            branch,
            ...(sha ? { sha } : {}),
          },
        },
      );
      commitSha = data.commit.sha;
      committed.push(file.path);
      void skipped;
    }

    return { commitSha, committed, skipped };
  }

  async openPullRequest(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const { data } = await this.request<{ number: number; html_url: string }>(
      `/repos/${owner}/${repo}/pulls`,
      { method: "POST", body: input },
    );
    return { number: data.number, url: data.html_url };
  }

  async defaultBranch(owner: string, repo: string): Promise<string> {
    const { data } = await this.request<{ default_branch: string }>(`/repos/${owner}/${repo}`, { noCache: true });
    return data.default_branch;
  }

  async searchCode(owner: string, repo: string, query: string, limit = 20): Promise<RepoEntry[]> {
    const q = `repo:${owner}/${repo} ${query}`;
    const { data } = await this.request<{ items?: { path: string; sha: string }[] }>(
      `/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 50)}`,
    );
    return (data.items ?? []).map((item) => ({
      path: item.path,
      name: item.path.split("/").pop() ?? item.path,
      type: "file" as const,
      size: 0,
      sha: item.sha,
    }));
  }
}

interface GitHubRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch?: string;
  description?: string | null;
  updated_at?: string;
  language?: string | null;
}

interface GitHubContent {
  type: string;
  path: string;
  name: string;
  sha: string;
  size: number;
  content?: string;
}

interface GitHubCommitResult {
  commit: { sha: string };
}

export function toRepo(repo: GitHubRepo): Repo {
  const slash = repo.full_name.indexOf("/");
  return {
    fullName: repo.full_name,
    name: repo.name,
    owner: slash === -1 ? repo.owner.login : repo.full_name.slice(0, slash),
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch ?? null,
    description: repo.description ?? null,
    updatedAt: repo.updated_at ?? null,
    language: repo.language ?? null,
  };
}

export function toEntry(entry: GitHubContent): RepoEntry {
  return {
    path: entry.path,
    name: entry.name,
    type: entry.type === "dir" ? "dir" : "file",
    size: entry.size,
    sha: entry.sha,
  };
}

async function readErrorMessage(response: Response): Promise<{ message: string; documentationUrl?: string }> {
  try {
    const text = await response.text();
    const json = safeJson(text) as { message?: string; documentation_url?: string; errors?: { message?: string }[] } | undefined;
    const message =
      json?.message ??
      json?.errors?.map((entry) => entry.message ?? "").filter(Boolean).join("; ") ??
      `GitHub request failed with status ${response.status}`;
    return {
      // Never echo the raw body: it can contain repository names or token hints.
      message: message.slice(0, 300),
      ...(json?.documentation_url ? { documentationUrl: json.documentation_url } : {}),
    };
  } catch {
    return { message: `GitHub request failed with status ${response.status}` };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
