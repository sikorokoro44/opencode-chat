# Architecture

```
Android app (Kotlin/Compose)          Backend (Node 20, TypeScript, zero deps)
  │                                       │
  │  HTTPS + SSE ───────────────────────►│  node:http router
  │                                        │   ├─ auth (scrypt, HS256 JWT, sessions)
  │  bearer access token                  │   ├─ models (fallback orchestration → providers)
  │                                        │   ├─ chat (JSON collections + attachment blobs)
  │                                        │   └─ github (REST client + coding agent)
  │  persisted cache ◄────────────────────┘
```

## Backend

- **No runtime dependencies.** Everything is built on Node's standard library:
  `node:http`, `node:crypto`, `node:fs/promises`, `node:stream/web`. This keeps CI
  installs fast and the attack surface small.
- `src/api/app.ts` is the composition root. `createApp()` wires services into a
  `Router` and returns the `http.Server` plus handles used by tests. It reads no
  `process.env` itself; `src/config.ts` is the only place that does.
- `src/http/router.ts` matches method + path templates (`/v1/chats/{chatId}`) and
  knows which routes are public.
- A request passes through: rate limiting → bearer authentication (unless public)
  → handler. Errors thrown anywhere are normalised by `toHttpError()` into a safe
  `{ error: { code, message, retryable } }` body.
- **Storage** is one JSON document per collection (`users`, `chats`, `messages`,
  `attachments`, `sessions`) plus binary blobs for attachments. Writes are
  debounced and atomic (write a temp file, then rename). Corrupt files are
  quarantined as `*.corrupt` instead of crashing the server.
- **Model calls** go through `src/models/provider.ts`, which streams
  OpenAI-compatible chat completions. `src/models/completion.ts` tries the
  requested/primary model first and falls back through the ordered allow-list on
  rate limits or provider errors, emitting fallback events as it goes.
- **GitHub** access is via `src/github/github-client.ts` (REST, ETag caching) and
  `src/github/github-service.ts` (per-user encrypted tokens). The coding agent
  (`src/github/coding-agent.ts`) runs a tool loop over the model provider.
- **GitHub responses are decoded defensively.** `github-client.ts` narrows every
  decoded body through small accessors, so a truncated or unexpected upstream reply
  becomes a typed error instead of an unhandled `TypeError`. Empty bodies are never
  cached against an ETag, and a `304` with nothing usable cached is retried once
  unconditionally and then reported as an upstream failure.
- **Session memory** (`github-service.ts`) keeps one canonical path helper shared by
  reads and writes: a session is `<directory of the memory file>/session-<chatId>.md`.
  Rendering and parsing live next to each other, so the listing cannot disagree
  with what was written. `chatId` is validated as a single path-safe token before it
  reaches that path.
- **Identity for abuse controls** comes from `clientIdentity` in
  `src/http/respond.ts`, which keys on the socket address unless `TRUST_PROXY` is
  set. See [`docs/security.md`](security.md).
- `shared/openapi.json` is enforced against the served routes by
  `backend/test/openapi-parity.test.ts`, so a route cannot be added or documented
  without the other.

## Android

- Kotlin + Jetpack Compose, Material 3, single-module app.
- Ktor client for HTTP and a hand-written SSE parser (no heavyweight streaming
  library, low memory). The parser is pure Kotlin and unit-tested on the JVM.
- Auth tokens are encrypted with a hardware-backed AES/GCM key from the Android
  Keystore; only ciphertext reaches SharedPreferences (excluded from backups).
  The server URL lives in a single small Preferences DataStore.
- No DI framework: a small hand-written `AppContainer` graph keeps the APK small
  and startup fast on low-RAM devices.

## Why GitHub Actions is authoritative

The project is developed from a phone with no local JDK/Android SDK/Gradle. CI is
the only place a real Android build and the full backend test suite run, so a
change is not considered done until the workflows are green.
