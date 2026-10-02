/**
 * HTTP routes.
 *
 * One file so the whole API surface is readable at a glance; `shared/openapi.json`
 * is the machine-checked contract and a test asserts the two stay in sync.
 */

import { badRequest, forbidden, notFound, tooManyRequests, unauthorized } from "../http/errors.ts";
import { SseWriter } from "../http/sse.ts";
import { readBlob } from "../store/database.ts";
import { attachmentResponseHeaders, decodeBase64Strict, storeAttachment } from "../chat/attachments.ts";
import { toAttachment, toMessage } from "../chat/chat-service.ts";
import { streamCompletion } from "../models/completion.ts";
import { GitHubApiError } from "../github/github-client.ts";
import { clientIdentity, writeJson, writeNoContent } from "../http/respond.ts";
import type { RequestContext, Router } from "../http/router.ts";
import type { RouteDependencies } from "./dependencies.ts";
import type { UserRecord } from "../store/records.ts";
import { asObject, bool, int, objArray, repoPath, str, strArray } from "../validate.ts";
import type { ChatStreamEvent } from "../api/types.ts";

export type { RouteDependencies };

/**
 * Active streams keyed by user+chat so a client can cancel and a second send
 * supersedes the first instead of interleaving tokens into one message.
 */
export class StreamRegistry {
  private readonly active = new Map<string, AbortController>();

  key(userId: string, chatId: string): string {
    return `${userId}:${chatId}`;
  }

  start(userId: string, chatId: string): { key: string; controller: AbortController } {
    const key = this.key(userId, chatId);
    this.active.get(key)?.abort();
    const controller = new AbortController();
    this.active.set(key, controller);
    return { key, controller };
  }

  finish(key: string): void {
    this.active.delete(key);
  }

  cancel(userId: string, chatId: string): boolean {
    const key = this.key(userId, chatId);
    const controller = this.active.get(key);
    if (!controller) return false;
    controller.abort();
    this.active.delete(key);
    return true;
  }

  get size(): number {
    return this.active.size;
  }
}

export function registerRoutes(router: Router, deps: RouteDependencies): void {
  const streams = new StreamRegistry();

  const principalOf = (ctx: RequestContext) => {
    if (!ctx.principal) throw unauthorized();
    return ctx.principal;
  };
  const userOf = (ctx: RequestContext): UserRecord => {
    const user = deps.auth.findUserById(principalOf(ctx).userId);
    if (!user) throw unauthorized("account no longer exists");
    return user;
  };
  const agentToken = (ctx: RequestContext): string | undefined => {
    const header = ctx.headers["x-opencode-agent-token"];
    const raw = Array.isArray(header) ? header[0] : header;
    return typeof raw === "string" && raw !== "" ? raw : undefined;
  };
  const queryString = (ctx: RequestContext, key: string): string => ctx.query.get(key) ?? "";
  const queryInt = (ctx: RequestContext, key: string, fallback: number, min: number, max: number): number =>
    int(asObject({ [key]: queryString(ctx, key) }), key, { fallback, min, max });

  const guardAuthRate = (ctx: RequestContext, extra = ""): void => {
    const bucket = deps.authRateLimiter.take(`${clientIdentity(ctx.req)}:${extra}`);
    if (!bucket.allowed) throw tooManyRequests(bucket.retryAfterMs / 1000);
  };

  // ------------------------------------------------------------------ health

  router.get(
    "/health",
    () => ({
      status: "ok",
      version: "1.0.0",
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      modelsAvailable: deps.registry.all().length,
    }),
    { public: true },
  );

  // -------------------------------------------------------------------- auth

  router.post(
    "/v1/auth/register",
    async (ctx) => {
      const body = asObject(await ctx.json());
      guardAuthRate(ctx);
      return deps.auth.register({
        username: str(body, "username", { min: 3, max: 32 }),
        password: str(body, "password", { min: 1, max: 512, trim: false }),
        deviceName: str(body, "deviceName", { optional: true, max: 64 }),
      });
    },
    { public: true },
  );

  router.post(
    "/v1/auth/login",
    async (ctx) => {
      const body = asObject(await ctx.json());
      const username = str(body, "username", { min: 1, max: 64 });
      guardAuthRate(ctx, username.toLowerCase());
      try {
        const tokens = await deps.auth.login({
          username,
          password: str(body, "password", { min: 1, max: 512, trim: false }),
          deviceName: str(body, "deviceName", { optional: true, max: 64 }),
        });
        deps.authDelay.recordSuccess(`${clientIdentity(ctx.req)}:${username.toLowerCase()}`);
        return tokens;
      } catch (error) {
        const delay = deps.authDelay.recordFailure(`${clientIdentity(ctx.req)}:${username.toLowerCase()}`);
        if (delay > 0) await sleep(delay);
        throw error;
      }
    },
    { public: true },
  );

  router.post(
    "/v1/auth/refresh",
    async (ctx) => {
      const body = asObject(await ctx.json());
      guardAuthRate(ctx);
      return deps.auth.refresh(str(body, "refreshToken", { min: 10, max: 4096, trim: false }));
    },
    { public: true },
  );

  router.post(
    "/v1/auth/logout",
    async (ctx) => {
      const body = asObject(await ctx.json());
      await deps.auth.logout(str(body, "refreshToken", { min: 10, max: 4096, trim: false }));
      writeNoContent(ctx.res);
      return undefined;
    },
    { public: true },
  );

  router.get("/v1/me", (ctx) => {
    const user = userOf(ctx);
    return {
      user: { id: user.id, username: user.username, createdAt: user.createdAt },
      github: deps.github.connectionStatus(user),
      limits: {
        requestsPerMinute: deps.config.requestsPerMinute,
        attachmentMaxBytes: deps.config.attachmentMaxBytes,
      },
    };
  });

  router.get("/v1/models", () => ({
    primaryModelId: deps.registry.primaryModelId,
    maxFallbackDepth: deps.registry.maxFallbackDepth,
    models: deps.registry.publicInfo(),
  }));

  // ------------------------------------------------------------------- chats

  router.get("/v1/chats", (ctx) => ({
    chats: deps.chats.listChats(principalOf(ctx).userId, queryInt(ctx, "limit", 100, 1, 500)),
  }));

  router.post("/v1/chats", async (ctx) => {
    const body = asObject(await ctx.json());
    const chat = deps.chats.createChat(principalOf(ctx).userId, {
      title: str(body, "title", { optional: true, max: 200 }),
      repository: str(body, "repository", { optional: true, max: 200 }),
      branch: str(body, "branch", { optional: true, max: 200 }),
      projectPath: str(body, "projectPath", { optional: true, max: 512 }),
      modelId: str(body, "modelId", { optional: true, max: 64 }),
    });
    writeJson(ctx.res, 201, chat);
    return undefined;
  });

  router.get("/v1/chats/{chatId}", (ctx) => {
    const userId = principalOf(ctx).userId;
    const chatId = str(ctx.params, "chatId", { min: 1, max: 128 });
    const record = deps.chats.requireChat(userId, chatId);
    const messages = deps.chats.listMessages(userId, chatId, queryInt(ctx, "messageLimit", 0, 0, 500));
    const last = messages[messages.length - 1];
    return {
      chat: {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        pinned: record.pinned,
        messageCount: messages.length,
        lastMessagePreview: last ? last.content.replace(/\s+/g, " ").slice(0, 117) : null,
        repository: record.repository ?? null,
        branch: record.branch ?? null,
        projectPath: record.projectPath ?? null,
        modelId: record.modelId ?? null,
      },
      messages,
    };
  });

  router.patch("/v1/chats/{chatId}", async (ctx) => {
    const body = asObject(await ctx.json());
    return deps.chats.updateChat(principalOf(ctx).userId, str(ctx.params, "chatId", { min: 1, max: 128 }), {
      ...(body["title"] === undefined ? {} : { title: str(body, "title", { max: 200 }) }),
      ...(body["pinned"] === undefined ? {} : { pinned: bool(body, "pinned") }),
      ...(body["modelId"] === undefined ? {} : { modelId: str(body, "modelId", { max: 64 }) }),
      ...(body["branch"] === undefined ? {} : { branch: str(body, "branch", { max: 200 }) }),
    });
  });

  router.delete("/v1/chats/{chatId}", (ctx) => {
    const userId = principalOf(ctx).userId;
    const chatId = str(ctx.params, "chatId", { min: 1, max: 128 });
    streams.cancel(userId, chatId);
    deps.chats.deleteChat(userId, chatId);
    writeNoContent(ctx.res);
    return undefined;
  });

  router.post("/v1/chats/{chatId}/messages", async (ctx) => {
    const userId = principalOf(ctx).userId;
    const chatId = str(ctx.params, "chatId", { min: 1, max: 128 });
    const body = asObject(await ctx.json());
    const content = str(body, "content", { min: 1, max: 32_000 });
    const attachmentIds = strArray(body, "attachmentIds", { max: 8 });
    const requestedModel = str(body, "modelId", { optional: true, max: 64 });
    const chat = deps.chats.requireChat(userId, chatId);

    const modelId = requestedModel !== "" ? requestedModel : chat.modelId;
    const registryModel = deps.registry.require(modelId ?? deps.registry.primaryModelId);
    const userMessage = deps.chats.appendMessage(userId, chatId, { role: "user", content, attachmentIds });
    const providerMessages = deps.chats.buildProviderMessages(chatId, { content, attachmentIds }, registryModel);
    const inlined = await deps.chats.inlineAttachments(providerMessages, userId);

    try {
      const result = await streamCompletion(
        {
          registry: deps.registry,
          provider: deps.provider,
          logger: deps.logger,
          baseUrlFor: deps.baseUrlFor,
          apiKeyFor: deps.apiKeyFor,
          timeoutMs: deps.config.providerTimeoutMs,
          signal: AbortSignal.timeout(deps.config.providerTimeoutMs * 2),
        },
        {
          messages: inlined,
          ...(modelId === undefined ? {} : { requestedModelId: modelId }),
          onDelta: () => undefined,
        },
      );
      const assistant = deps.chats.appendMessage(userId, chatId, {
        role: "assistant",
        content: result.text,
        modelId: result.modelId,
        usage: result.usage,
        ...(result.fallbackDepth > 0 ? { fallbackFrom: result.requestedModelId } : {}),
      });
      return {
        userMessage: toMessage(userMessage, []),
        assistantMessage: toMessage(assistant, []),
        fallbackChain: result.fallbackChain,
      };
    } catch (error) {
      deps.chats.appendMessage(userId, chatId, {
        role: "assistant",
        content: `⚠️ ${error instanceof Error ? error.message : "model request failed"}`,
        errorCode: "completion_failed",
      });
      throw error;
    }
  });

  /**
   * Streams one assistant completion into an already-open SSE response and
   * persists the result. Shared by `/stream` (new turn) and `/regenerate`
   * (replace the previous answer) so both behave identically.
   */
  const runAssistantStream = async (args: {
    ctx: RequestContext;
    userId: string;
    chatId: string;
    content: string;
    attachmentIds: string[];
    requestedModel: string;
    appendUserMessage: boolean;
  }): Promise<void> => {
    const { ctx, userId, chatId } = args;
    const sse = new SseWriter({ res: ctx.res, heartbeatMs: deps.config.streamHeartbeatMs });
    const { key, controller } = streams.start(userId, chatId);
    const onClientGone = () => controller.abort();
    ctx.req.on("aborted", onClientGone);
    ctx.req.on("close", onClientGone);

    sse.start();
    const send = (event: ChatStreamEvent): void => {
      if (!sse.isClosed) sse.sendNamed(event.type, event);
    };

    try {
      const chat = deps.chats.requireChat(userId, chatId);
      const modelId = args.requestedModel !== "" ? args.requestedModel : chat.modelId;
      const registryModel = deps.registry.require(modelId ?? deps.registry.primaryModelId);
      // Built before the assistant row so history is exactly the turns so far.
      const providerMessages = deps.chats.buildProviderMessages(
        chatId,
        { content: args.content, attachmentIds: args.attachmentIds },
        registryModel,
      );
      const inlined = await deps.chats.inlineAttachments(providerMessages, userId);

      if (args.appendUserMessage) {
        deps.chats.appendMessage(userId, chatId, {
          role: "user",
          content: args.content,
          attachmentIds: args.attachmentIds,
        });
      }

      // The assistant row is created up front so the client has a stable id and
      // can persist partial output if the connection drops.
      const assistant = deps.chats.appendMessage(userId, chatId, {
        role: "assistant",
        content: "",
        modelId: registryModel.id,
      });

      let assistantText = "";
      let lastFlush = Date.now();

      const result = await streamCompletion(
        {
          registry: deps.registry,
          provider: deps.provider,
          logger: deps.logger,
          baseUrlFor: deps.baseUrlFor,
          apiKeyFor: deps.apiKeyFor,
          timeoutMs: deps.config.providerTimeoutMs,
          signal: controller.signal,
        },
        {
          messages: inlined,
          ...(modelId === undefined ? {} : { requestedModelId: modelId }),
          onStart: (activeModel, fallbackDepth) => {
            assistant.modelId = activeModel;
            send({
              type: "meta",
              chatId,
              messageId: assistant.id,
              model: activeModel,
              requestedModel: modelId ?? deps.registry.primaryModelId,
              fallbackDepth,
            });
          },
          onDelta: (text) => {
            assistantText += text;
            send({ type: "delta", text });
            // Bound disk churn: persist at most twice a second on long replies.
            const now = Date.now();
            if (now - lastFlush > 500) {
              lastFlush = now;
              assistant.content = assistantText;
              deps.chats.updateMessage(assistant);
            }
          },
          onFallback: (from, to, reason) => send({ type: "fallback", from, to, reason }),
        },
      );

      assistant.content = result.text;
      assistant.modelId = result.modelId;
      if (result.usage.promptTokens !== undefined) assistant.promptTokens = result.usage.promptTokens;
      if (result.usage.completionTokens !== undefined) assistant.completionTokens = result.usage.completionTokens;
      if (result.usage.totalTokens !== undefined) assistant.totalTokens = result.usage.totalTokens;
      if (result.fallbackDepth > 0) assistant.fallbackFrom = result.requestedModelId;
      deps.chats.updateMessage(assistant);
      await deps.database.flush();

      send({
        type: "done",
        messageId: assistant.id,
        model: result.modelId,
        finishReason: result.finishReason,
        usage: result.usage,
        agentActions: [],
      });
    } catch (error) {
      const wire = toStreamError(error);
      send({ type: "error", code: wire.code, message: wire.message, retryable: wire.retryable });
    } finally {
      streams.finish(key);
      ctx.req.removeListener("aborted", onClientGone);
      ctx.req.removeListener("close", onClientGone);
      sse.close();
    }
  };

  router.get("/v1/chats/{chatId}/stream", async (ctx) => {
    const userId = principalOf(ctx).userId;
    const chatId = str(ctx.params, "chatId", { min: 1, max: 128 });
    deps.chats.requireChat(userId, chatId);

    const content = str(asObject(queryObject(ctx.query)), "content", { min: 1, max: 32_000 });
    const requestedModel = ctx.query.get("modelId") ?? "";
    const attachmentIds = ctx.query.getAll("attachmentIds").filter((id) => id !== "").slice(0, 8);

    await runAssistantStream({
      ctx,
      userId,
      chatId,
      content,
      attachmentIds,
      requestedModel,
      appendUserMessage: true,
    });
    return undefined;
  });

  router.get("/v1/chats/{chatId}/regenerate", async (ctx) => {
    const userId = principalOf(ctx).userId;
    const chatId = str(ctx.params, "chatId", { min: 1, max: 128 });
    // Removes the previous answer (and any tool turns) before streaming a new one.
    const lastUser = deps.chats.resetToLastUserTurn(userId, chatId);
    if (!lastUser) throw badRequest("no_user_message", "there is no user message to regenerate from");

    const requestedModel = ctx.query.get("modelId") ?? "";
    await runAssistantStream({
      ctx,
      userId,
      chatId,
      content: lastUser.content,
      attachmentIds: lastUser.attachmentIds,
      requestedModel,
      appendUserMessage: false,
    });
    return undefined;
  });

  router.delete("/v1/chats/{chatId}/stream", (ctx) => {
    const cancelled = streams.cancel(principalOf(ctx).userId, str(ctx.params, "chatId", { min: 1, max: 128 }));
    if (!cancelled) throw notFound("no_active_stream", "there is no active stream for this chat");
    writeNoContent(ctx.res);
    return undefined;
  });

  // ------------------------------------------------------------- attachments

  router.post("/v1/attachments", async (ctx) => {
    const user = userOf(ctx);
    const body = asObject(await ctx.json());
    const data = decodeBase64Strict(str(body, "data", { min: 4, max: 40_000_000, trim: false }));
    const fileName = str(body, "fileName", { optional: true, max: 128 });
    const chatId = str(body, "chatId", { optional: true, max: 128 });
    if (chatId !== "") deps.chats.requireChat(user.id, chatId);

    const record = await storeAttachment(
      {
        userId: user.id,
        mimeType: str(body, "mimeType", { min: 1, max: 128 }),
        ...(fileName === "" ? {} : { fileName }),
        ...(chatId === "" ? {} : { chatId }),
        data,
        directory: deps.database.directory,
      },
      { maxBytes: deps.config.attachmentMaxBytes, maxImageBytes: deps.config.attachmentMaxImageBytes },
    );
    deps.chats.attachAttachment(record);
    writeJson(ctx.res, 201, toAttachment(record));
    return undefined;
  });

  router.get("/v1/attachments/{attachmentId}", async (ctx) => {
    const user = userOf(ctx);
    const record = deps.chats.findAttachment(user.id, str(ctx.params, "attachmentId", { min: 1, max: 128 }));
    const blob = await readBlob(deps.database.directory, record.id);
    if (!blob) throw notFound("attachment_not_found", "attachment content is no longer available");
    for (const [key, value] of Object.entries(attachmentResponseHeaders(record.mimeType))) {
      ctx.res.setHeader(key, value);
    }
    ctx.res.setHeader("content-length", blob.length);
    ctx.res.writeHead(200);
    ctx.res.end(blob);
    return undefined;
  });

  // ------------------------------------------------------------------ github

  router.get("/v1/github/status", async (ctx) => {
    const user = userOf(ctx);
    const status = deps.github.connectionStatus(user);
    if (!status.connected) return { connected: false, login: null, scopes: [] };
    try {
      const { login } = await deps.github.currentLogin(user, agentToken(ctx));
      return { connected: true, login, scopes: ["repo", "read:user"] };
    } catch (error) {
      if (error instanceof GitHubApiError) {
        return { connected: false, login: null, scopes: [], error: error.message };
      }
      throw error;
    }
  });

  router.post("/v1/github/connect", async (ctx) => {
    const user = userOf(ctx);
    const body = asObject(await ctx.json());
    const result = await deps.github.connectToken(user, str(body, "token", { min: 20, max: 255, trim: false }));
    deps.database.users.put(user);
    await deps.database.flush();
    return { connected: true, login: result.login, connectedAt: result.connectedAt };
  });

  router.delete("/v1/github/connect", async (ctx) => {
    const user = userOf(ctx);
    deps.github.disconnectToken(user);
    deps.database.users.put(user);
    await deps.database.flush();
    writeNoContent(ctx.res);
    return undefined;
  });

  router.get("/v1/github/repos", async (ctx) => {
    const user = userOf(ctx);
    const { repos } = await deps.github.listRepos(user, queryInt(ctx, "limit", 100, 1, 200), agentToken(ctx));
    return { repos };
  });

  router.get("/v1/github/repos/{owner}/{repo}/branches", async (ctx) => {
    const user = userOf(ctx);
    return {
      branches: await deps.github.listBranches(
        user,
        str(ctx.params, "owner", { min: 1, max: 100 }),
        str(ctx.params, "repo", { min: 1, max: 100 }),
        agentToken(ctx),
      ),
    };
  });

  router.get("/v1/github/repos/{owner}/{repo}/contents", async (ctx) => {
    const user = userOf(ctx);
    const path = repoPath(asObject(queryObject(ctx.query)), "path", { optional: true });
    const ref = ctx.query.get("ref") ?? "";
    return deps.github.listContents(
      user,
      str(ctx.params, "owner", { min: 1, max: 100 }),
      str(ctx.params, "repo", { min: 1, max: 100 }),
      path,
      ref,
      agentToken(ctx),
    );
  });

  router.get("/v1/github/repos/{owner}/{repo}/file", async (ctx) => {
    const user = userOf(ctx);
    const owner = str(ctx.params, "owner", { min: 1, max: 100 });
    const repo = str(ctx.params, "repo", { min: 1, max: 100 });
    const path = repoPath(asObject(queryObject(ctx.query)), "path");
    const ref = ctx.query.get("ref") ?? "";
    const resolvedRef = ref === "" ? await deps.github.defaultBranch(user, owner, repo, agentToken(ctx)) : ref;
    const file = await deps.github.readFile(user, owner, repo, path, resolvedRef, agentToken(ctx));
    return { ...file, encoding: "utf-8" as const };
  });

  router.get("/v1/github/repos/{owner}/{repo}/search", async (ctx) => {
    const user = userOf(ctx);
    const results = await deps.github.search(
      user,
      str(ctx.params, "owner", { min: 1, max: 100 }),
      str(ctx.params, "repo", { min: 1, max: 100 }),
      str(asObject(queryObject(ctx.query)), "q", { min: 1, max: 256 }),
      agentToken(ctx),
    );
    return { results };
  });

  router.post("/v1/github/agent/commit", async (ctx) => {
    const user = userOf(ctx);
    const body = asObject(await ctx.json());
    const createPullRequest = bool(body, "createPullRequest", false);
    if (createPullRequest && !deps.github.writesEnabled) {
      throw forbidden("github_writes_disabled", "server is not configured for repository writes");
    }
    const result = await deps.github.commitFiles({
      user,
      owner: str(body, "owner", { min: 1, max: 100 }),
      repo: str(body, "repo", { min: 1, max: 100 }),
      baseBranch: str(body, "baseBranch", { min: 1, max: 200 }),
      branch: str(body, "branch", { optional: true, max: 200 }),
      commitMessage: str(body, "commitMessage", { min: 1, max: 400 }),
      createPullRequest,
      pullRequestTitle: str(body, "pullRequestTitle", { optional: true, max: 200 }),
      pullRequestBody: str(body, "pullRequestBody", { optional: true, max: 8_000 }),
      files: objArray(body, "files", {
        max: 20,
        optional: false,
        parse: (item) => ({
          path: str(item, "path", { min: 1, max: 1024 }),
          content: str(item, "content", { min: 0, max: 400_000, trim: false }),
          ...(item["message"] === undefined ? {} : { message: str(item, "message", { max: 400 }) }),
        }),
      }),
    });
    writeJson(ctx.res, 201, result);
    return undefined;
  });

  router.post("/v1/github/agent/run", async (ctx) => {
    const user = userOf(ctx);
    const body = asObject(await ctx.json());
    const [owner = "", repo = ""] = str(body, "repository", { min: 3, max: 200 }).split("/", 2);
    if (owner === "" || repo === "") throw badRequest("invalid_repository", "repository must look like owner/name");

    const token = agentToken(ctx);
    const allowWrites = bool(body, "allowWrites", false) && deps.github.writesEnabled;
    const branch = str(body, "branch", { optional: true, max: 200 });
    const ref = branch === "" ? await deps.github.defaultBranch(user, owner, repo, token) : branch;
    const modelId = str(body, "modelId", { optional: true, max: 64 });
    const chatId = str(body, "chatId", { optional: true, max: 128 });

    const messages = deps.chats.buildProviderMessages(
      chatId,
      { content: str(body, "prompt", { min: 1, max: 16_000 }), attachmentIds: [] },
      deps.registry.require(modelId === "" ? deps.registry.primaryModelId : modelId),
    );

    const controller = new AbortController();
    ctx.req.on("aborted", () => controller.abort());
    const chunks: string[] = [];

    const result = await deps.agent.run({
      ...(modelId === "" ? {} : { modelId }),
      messages,
      tools: { user, owner, repo, ref, allowWrites, ...(token === undefined ? {} : { bootstrapToken: token }) },
      signal: controller.signal,
      onDelta: (text) => {
        chunks.push(text);
      },
    });

    return {
      modelId: result.modelId,
      text: result.text,
      steps: result.steps,
      agentActions: result.actions,
      usage: result.usage,
      charactersStreamed: chunks.reduce((total, chunk) => total + chunk.length, 0),
    };
  });

  router.get("/v1/github/memory", async (ctx) => {
    const user = userOf(ctx);
    const query = asObject(queryObject(ctx.query));
    const owner = str(query, "owner", { min: 1, max: 100 });
    const repo = str(query, "repo", { min: 1, max: 100 });
    const ref = queryStringOf(query, "ref");
    const token = agentToken(ctx);
    const resolvedRef = ref === "" ? await deps.github.defaultBranch(user, owner, repo, token) : ref;
    return deps.github.readMemory(user, owner, repo, resolvedRef, deps.github.memoryFilePath, token);
  });

  router.put("/v1/github/memory", async (ctx) => {
    const user = userOf(ctx);
    const body = asObject(await ctx.json());
    const token = agentToken(ctx);
    const result = await deps.github.writeMemory(user, {
      owner: str(body, "owner", { min: 1, max: 100 }),
      repo: str(body, "repo", { min: 1, max: 100 }),
      branch: str(body, "branch", { min: 1, max: 200 }),
      content: str(body, "content", { min: 1, max: 400_000, trim: false }),
      commitMessage: str(body, "commitMessage", { optional: true, max: 400 }) || "chore: update project memory",
      ...(token === undefined ? {} : { bootstrapToken: token }),
    });
    return result;
  });

  router.get("/v1/github/memory/sessions", async (ctx) => {
    const user = userOf(ctx);
    const query = asObject(queryObject(ctx.query));
    const owner = str(query, "owner", { min: 1, max: 100 });
    const repo = str(query, "repo", { min: 1, max: 100 });
    const ref = queryStringOf(query, "ref");
    const token = agentToken(ctx);
    const resolvedRef = ref === "" ? await deps.github.defaultBranch(user, owner, repo, token) : ref;
    return { sessions: await deps.github.listMemorySessions(user, owner, repo, resolvedRef, token) };
  });

  router.post("/v1/github/memory/sessions", async (ctx) => {
    const user = userOf(ctx);
    const body = asObject(await ctx.json());
    const token = agentToken(ctx);
    await deps.github.recordSessionMemory(user, {
      owner: str(body, "owner", { min: 1, max: 100 }),
      repo: str(body, "repo", { min: 1, max: 100 }),
      branch: str(body, "branch", { min: 1, max: 200 }),
      chatId: str(body, "chatId", { min: 1, max: 128 }),
      title: str(body, "title", { min: 1, max: 200 }),
      summary: str(body, "summary", { min: 1, max: 16_000, trim: false }),
      ...(token === undefined ? {} : { bootstrapToken: token }),
    });
    writeJson(ctx.res, 201, { stored: true });
    return undefined;
  });
}

/** Optional query parameter as a plain string (empty when absent). */
function queryStringOf(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/** Query parameters are copied into an object for the validator. */
function queryObject(query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of query.entries()) out[key] = value;
  return out;
}

function toStreamError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error && typeof error === "object" && "code" in error) {
    const record = error as { code: string; message?: string; retryable?: boolean };
    return {
      code: record.code,
      message: (record.message ?? "request failed").slice(0, 300),
      retryable: record.retryable ?? true,
    };
  }
  return { code: "completion_failed", message: "model request failed", retryable: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
