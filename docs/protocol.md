# API and streaming protocol

The machine-readable contract is [`shared/openapi.json`](../shared/openapi.json).
This note describes the parts that are easy to get wrong from a client.

## Authentication

1. `POST /v1/auth/register` or `POST /v1/auth/login` returns
   `{ accessToken, refreshToken, user }`.
2. Send `Authorization: Bearer <accessToken>` on every other call.
3. Access tokens are short-lived. On `401`, call `POST /v1/auth/refresh` with the
   refresh token, then retry once. A rotated refresh token invalidates the old
   one, so always persist the new value.
4. `POST /v1/auth/logout` revokes the session.

Errors are always `{ "error": { "code", "message", "retryable" } }`.

## Streaming a completion

```
GET /v1/chats/{chatId}/stream?content=<text>&modelId=<optional>
Accept: text/event-stream
Authorization: Bearer <accessToken>
```

The server appends the user message, reserves an assistant message id, and
emits named SSE events:

| event      | data                                                         |
| ---------- | ------------------------------------------------------------ |
| `meta`     | `{ chatId, messageId, model, requestedModel, fallbackDepth }` |
| `delta`    | `{ text }` — append to the current assistant turn             |
| `fallback` | `{ from, to, reason }` — a provider failed, retrying another  |
| `done`     | `{ messageId, model, finishReason, usage }`                   |
| `error`    | `{ code, message, retryable }`                                |

`:`-prefixed comment lines are heartbeats and must be ignored. Cancel a running
stream with `DELETE /v1/chats/{chatId}/stream`.

For non-streaming clients, `POST /v1/chats/{chatId}/messages` performs the same
completion and returns `{ userMessage, assistantMessage, fallbackChain }`.

## Model policy

`GET /v1/models` returns `{ primaryModelId, maxFallbackDepth, models }`. `models`
includes `capabilities`, `fallbackOnly`, `healthy` and `cooldownSeconds`. The
server always enforces the free-model allow-list; an unknown `modelId` is a
`400 unknown_model`. Clients should not assume that requesting a model means it
was used — read the `model` field of `meta`/`done` and the `fallback` events.

## Attachments

Upload base64 with `POST /v1/attachments` (`data`, `mimeType`, optional
`fileName`, `chatId`) and reference the returned `id` in `attachmentIds` when
sending a message. Fetch bytes with `GET /v1/attachments/{id}`; responses are
owner-scoped and `nosniff`. `ATTACHMENT_MAX_BYTES` (5 MiB by default, 25 MiB
maximum) bounds the decoded payload, so clients should not buffer more than that
before uploading.

## Repository context

`repository` is always exactly `owner/name`, and `projectPath` is a path relative
to the repository root. Both are accepted on chat creation and `PATCH
/v1/chats/{chatId}`, are validated and persisted, and are rejected with
`400 invalid_path` when the path is absolute, traverses upwards, contains a
backslash or a control character, or exceeds 1024 characters. Clients should
apply the same rules locally so an invalid value never needs a round trip.

## GitHub coding agent

`/v1/github/*` exposes connection status, repository/branch/content browsing and
the agent commit/run endpoints. Privileged writes additionally require the
operator-configured bootstrap token; user tokens are encrypted at rest and used
only to call GitHub on that user's behalf.

| Route | Purpose |
| --- | --- |
| `GET /v1/github/status` | Whether a token is connected, plus the login and scopes |
| `POST`/`DELETE /v1/github/connect` | Store (validated) or forget the account's token |
| `GET /v1/github/repos` | Repositories the account can reach |
| `GET /v1/github/repos/{owner}/{repo}/branches` | Branch names and head shas |
| `GET /v1/github/repos/{owner}/{repo}/contents` | Directory listing (`path`, `ref`) |
| `GET /v1/github/repos/{owner}/{repo}/file` | Text file (`path`, `ref`; `ref` defaults to the default branch) |
| `GET /v1/github/repos/{owner}/{repo}/search` | Code search scoped to one repository (`q`) |
| `POST /v1/github/agent/commit` | Branch, commit files, optionally open a pull request |
| `POST /v1/github/agent/run` | Agent tool loop over one repository |
| `GET`/`PUT /v1/github/memory` | Read and write the project memory document |
| `GET`/`POST /v1/github/memory/sessions` | List and record session memory documents |

`POST /v1/github/agent/run` refuses with `github_not_connected` **before** any
provider call when the account has no GitHub credential, so an unconnected
account spends no quota; its optional `chatId` must be a chat the caller owns.

`POST /v1/github/memory/sessions` is best-effort: it answers `201` with
`{ stored, path, branch }`, where `stored` is `false` when the commit did not
succeed. `chatId` becomes part of the document name, so it must be a single
path-safe token owned by the caller. Reads and writes share the same path and the
same metadata block, so a recorded session is immediately visible in
`GET /v1/github/memory/sessions`.
