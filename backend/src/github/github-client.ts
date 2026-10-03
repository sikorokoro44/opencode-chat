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
    // Only a status a client can act on is forwarded; anything else (notably 304,
    // which is not a valid error response) becomes a retryable 502 so it can never
    // reach the wire as an unexpected status line.
    const wire =
      status === 404 ? 404 : status === 422 ? 400 : status === 403 || status === 429 ? status : status >= 500 ? 502 : 502;
    super(wire, `github_${status}`, message, { retryable, headers });
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

  /** Drops one entry, used when a 304 turns out to have nothing to serve. */
  delete(key: string): void {
    this.entries.delete(key);
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
    const conditional = method === "GET" && !options.noCache;
    const cached = conditional ? this.cache.get(cacheKey) : undefined;
    // A conditional GET is only worth sending when a usable body was cached with the
    // ETag; otherwise GitHub answers 304 and there is nothing to serve.
    const useConditional = cached !== undefined;
    // Bounded: a GitHub/proxy that keeps answering 304 must not spin forever.
    let unconditionalRetries = 0;

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

      if (response.status === 304) {
        if (useConditional && cached) {
          // The cached body may be raw file text (the contents API is asked for
          // `vnd.github.raw` on file reads), so it must go through the same
          // tolerant parse as a live 200 rather than a bare `JSON.parse`.
          const data = parseBody(cached.body);
          if (data !== undefined) return { data: data as T, status: 304, etag: cached.etag, notModified: true };
        }
        // 304 with nothing to serve: ask for the resource unconditionally rather than
        // handing callers an empty body (or a 304, which is not a valid error).
        if (conditional && unconditionalRetries === 0) {
          unconditionalRetries += 1;
          this.cache.delete(cacheKey);
          try {
            return await this.request<T>(path, { ...options, noCache: true });
          } catch (error) {
            // A second unconditional attempt answers 304 again: surface it as an
            // upstream failure rather than looping.
            if (error instanceof GitHubApiError && error.githubStatus === 304) break;
            throw error;
          }
        }
        break;
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
      const data = parseBody(text);
      const etag = response.headers.get("etag") ?? undefined;
      // An empty body is never cached: a later 304 would then resolve to no content at
      // all and every caller of the cached body would have to defend against it.
      if (etag !== undefined && conditional && text !== "") {
        this.cache.set(cacheKey, etag, text);
      }
      return { data: data as T, status: response.status, etag, notModified: false };
    }

    throw new GitHubApiError(304, "GitHub answered 304 Not Modified without a cached response");
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
    const { data } = await this.request<{ login?: string }>("/user", { noCache: true });
    const login = asObject(data).login;
    if (typeof login !== "string" || login === "") {
      throw new GitHubApiError(502, "GitHub returned an unexpected response for /user");
    }
    return login;
  }

  async listRepos(limit = 100): Promise<Repo[]> {
    const capped = Math.min(Math.max(limit, 1), 200);
    const { data } = await this.request<GitHubRepo[]>(`/user/repos?per_page=${capped}&sort=updated&affiliation=owner,collaborator,organization_member`);
    return asArray(data).map((repo) => toRepo(repo as GitHubRepo));
  }

  async listBranches(owner: string, repo: string): Promise<{ name: string; sha: string }[]> {
    const { data } = await this.request<{ name?: string; commit?: { sha?: string } }[]>(
      `/repos/${owner}/${repo}/branches?per_page=100`,
    );
    return asArray(data).map((branch) => {
      const record = asObject(branch);
      const name = record.name;
      const sha = asObject(record.commit).sha;
      if (typeof name !== "string" || typeof sha !== "string") {
        throw new GitHubApiError(502, "GitHub returned an unexpected branch listing");
      }
      return { name, sha };
    });
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
    const rawContent = asObject(data).content;
    const base64 = (typeof rawContent === "string" ? rawContent : "").replace(/\n/g, "");
    const buffer = Buffer.from(base64, "base64");
    const truncated = buffer.length > maxBytes;
    const record = asObject(data);
    return {
      path: typeof record.path === "string" ? record.path : path,
      ref,
      sha: typeof record.sha === "string" ? record.sha : "",
      size: buffer.length,
      truncated,
      content: buffer.subarray(0, maxBytes).toString("utf8"),
    };
  }

  /** Creates a branch at `baseRef`'s head sha. Returns the new branch name. */
  async createBranch(owner: string, repo: string, branch: string, baseRef: string): Promise<string> {
    const { data } = await this.request<{ object?: { sha?: string } }>(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseRef)}`,
      { noCache: true },
    );
    const sha = asObject(asObject(data).object).sha;
    if (typeof sha !== "string" || sha === "") {
      throw new GitHubApiError(502, `GitHub returned no head sha for ${baseRef}`);
    }
    await this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha },
    });
    return branch;
  }

  async getRef(owner: string, repo: string, branch: string): Promise<string | undefined> {
    const result = await this.request<{ object?: { sha?: string } }>(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { noCache: true },
    );
    const sha = asObject(asObject(result.data).object).sha;
    return typeof sha === "string" ? sha : undefined;
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
        if (typeof existing.data !== "string") {
          const existingSha = asObject(existing.data).sha;
          if (typeof existingSha === "string") sha = existingSha;
        }
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
      const written = asObject(asObject(data).commit).sha;
      // A 2xx without a commit sha is not a successful write: report it as failed
      // instead of dereferencing it and crashing with a TypeError.
      if (typeof written !== "string" || written === "") {
        skipped.push(file.path);
        continue;
      }
      commitSha = written;
      committed.push(file.path);
    }

    return { commitSha, committed, skipped };
  }

  async openPullRequest(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const { data } = await this.request<{ number?: number; html_url?: string }>(
      `/repos/${owner}/${repo}/pulls`,
      { method: "POST", body: input },
    );
    const record = asObject(data);
    if (typeof record.number !== "number" || typeof record.html_url !== "string") {
      throw new GitHubApiError(502, "GitHub returned an unexpected pull request response");
    }
    return { number: record.number, url: record.html_url };
  }

  async defaultBranch(owner: string, repo: string): Promise<string> {
    const { data } = await this.request<{ default_branch?: string }>(`/repos/${owner}/${repo}`, { noCache: true });
    const branch = asObject(data).default_branch;
    if (typeof branch !== "string" || branch === "") {
      throw new GitHubApiError(502, "GitHub returned no default branch for this repository");
    }
    return branch;
  }

  async searchCode(owner: string, repo: string, query: string, limit = 20): Promise<RepoEntry[]> {
    const q = `repo:${owner}/${repo} ${query}`;
    const { data } = await this.request<{ items?: { path?: string; sha?: string }[] }>(
      `/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 50)}`,
    );
    const items = asObject(data).items;
    const entries: RepoEntry[] = [];
    for (const raw of Array.isArray(items) ? items : []) {
      const item = asObject(raw);
      if (typeof item.path !== "string") continue;
      entries.push({
        path: item.path,
        name: item.path.split("/").pop() ?? item.path,
        type: "file",
        size: 0,
        sha: typeof item.sha === "string" ? item.sha : "",
      });
    }
    return entries;
  }
}

/** Narrows an unknown decoded body to a record without ever throwing. */
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
  const record = asObject(repo);
  const fullName = typeof record.full_name === "string" ? record.full_name : "";
  const name = typeof record.name === "string" ? record.name : fullName.split("/")[1] ?? fullName;
  const slash = fullName.indexOf("/");
  const ownerLogin = asObject(record.owner).login;
  return {
    fullName,
    name,
    owner: slash === -1 ? (typeof ownerLogin === "string" ? ownerLogin : "") : fullName.slice(0, slash),
    private: Boolean(record.private),
    defaultBranch: (record.default_branch as string | undefined) ?? null,
    description: (record.description as string | null | undefined) ?? null,
    updatedAt: (record.updated_at as string | undefined) ?? null,
    language: (record.language as string | null | undefined) ?? null,
  };
}

export function toEntry(entry: GitHubContent): RepoEntry {
  const record = asObject(entry);
  const path = typeof record.path === "string" ? record.path : "";
  return {
    path,
    name: typeof record.name === "string" ? record.name : (path.split("/").pop() ?? path),
    type: record.type === "dir" ? "dir" : "file",
    size: typeof record.size === "number" ? record.size : 0,
    sha: typeof record.sha === "string" ? record.sha : "",
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

/**
 * Decodes a GitHub response body. The contents API answers with raw file text when
 * `vnd.github.raw` is requested, so a body that is not JSON is returned verbatim.
 */
function parseBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
