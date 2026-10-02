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
owner-scoped and `nosniff`.

## GitHub coding agent

`/v1/github/*` exposes connection status, repository/branch/content browsing and
the agent commit/run endpoints. Privileged writes additionally require the
operator-configured bootstrap token; user tokens are encrypted at rest and used
only to call GitHub on that user's behalf.
