# opencode-chat

Android app (Kotlin/Jetpack Compose) + TypeScript backend that provide a ChatGPT-style streaming
chat experience with a coding agent that operates on GitHub.

## Principles

- **Free models only.** Big Pickle is the primary model. Every request transparently falls back to
  other free models when a provider is rate limited, unhealthy, or errors. Model policy lives in
  [`shared/models.json`](shared/models.json) and is enforced server-side.
- **No secrets in the client.** The APK contains no API keys, no GitHub tokens and no signing
  secrets. Provider keys and GitHub tokens are held by the backend, which is the only component
  that talks to model providers or the GitHub API.
- **GitHub is the source of truth** for project and session memory
  ([`shared/openapi.json`](shared/openapi.json) documents the contract). Chat history is also
  cached server-side for fast offline rendering.
- **GitHub Actions is the authoritative build/test environment.** Nothing large is installed on a
  phone: no JDK, no Android SDK, no Gradle daemon work locally. CI runs backend tests, Android
  unit/UI tests, lint, and both debug and release builds, and uploads verified artifacts.
- **Low RAM.** No heavyweight DI framework, a hand-written SSE reader over Ktor, a single small
  DataStore, encrypted token storage in the Android Keystore, no unbounded caches, and Compose
  lists with stable keys.

## Layout

| Path        | Contents                                                          |
| ----------- | ----------------------------------------------------------------- |
| `backend/`  | Node 22+ + TypeScript API: auth, model proxy, chat persistence, GitHub agent |
| `shared/`   | API contract (`openapi.json`) and model registry (`models.json`)  |
| `android/`  | Gradle project for the Compose app, its unit/UI tests and lint    |
| `docs/`     | Architecture, protocol and security notes                        |

## Local development

No local Android toolchain is needed or wanted. Useful commands:

```bash
# Backend: typecheck, test, run (Node 22.6+, matching `engines`; CI uses Node 24)
cd backend && npm ci && npm run typecheck && npm test && npm run dev

# Android: everything runs in CI
open .github/workflows/ci.yml
open .github/workflows/android-build.yml
```

## Configuration

All backend secrets come from the environment; nothing is baked into images or source.
See [`backend/.env.example`](backend/.env.example) and
[`docs/security.md`](docs/security.md).

| Variable                            | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `OPENCODE_JWT_SECRET`               | HMAC secret for access/refresh tokens          |
| `OPENCODE_ADMIN_BOOTSTRAP_TOKEN`    | One-time token that authorises agent writes    |
| `OPENCODE_GITHUB_TOKEN`             | Server-side GitHub token (agent operations)    |
| `OPENCODE_GITHUB_TOKEN_ENCRYPTION_KEY` | 32-byte key (hex) encrypting stored GitHub tokens |
| `OPENCODE_ZEN_API_KEY`              | OpenCode Zen provider key                      |
| `OPENCODE_OPENROUTER_API_KEY`       | OpenRouter provider key                        |
| `DATABASE_DIR`                      | Chat/attachment data directory                 |
| `PORT`                              | HTTP port (default 8080)                       |
| `TRUST_PROXY`                       | Honour `X-Forwarded-For` for rate limiting (default `false`) |