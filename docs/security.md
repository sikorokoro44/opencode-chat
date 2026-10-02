# Security model

The backend is the only component that holds secrets or talks to model
providers and GitHub. The Android APK ships **no** API keys, **no** GitHub
tokens and **no** signing secrets.

## Secret handling

- Everything secret is read from the environment at startup by
  `backend/src/config.ts` and held in memory only.
- `OPENCODE_JWT_SECRET` must be at least 32 characters. In `NODE_ENV=production`
  the server refuses to start with the built-in development secret.
- `OPENCODE_GITHUB_TOKEN_ENCRYPTION_KEY` must be 64 hex characters (32 bytes).
- `config.redact()` produces a short fingerprint (`abc…(48 chars)`) for logs;
  full secret values are never logged. The logger also drops known-sensitive
  keys.
- CI runs with throwaway values; no production secret is ever stored in the
  repository.

## Authentication

- Passwords are hashed with **scrypt** (`node:crypto`, no native dependency) using
  a random 16-byte salt per user. Stored format carries its parameters so they can
  be raised later:
  `scrypt$N$r$p$<salt-b64>$<hash-b64>`.
- Verification uses `timingSafeEqual`. Unknown users are still compared against a
  dummy hash so response timing does not reveal whether a username exists.
- Access tokens are **HS256** JWTs signed with `OPENCODE_JWT_SECRET`. Only HS256 is
  accepted; `alg: none` and algorithm-confusion attempts are rejected before any
  signature work, and oversized tokens are rejected before hashing.
- Refresh tokens are random 256-bit values. Only a fingerprint is stored; on
  refresh the token is rotated, and replaying a rotated token revokes the session.
- Sessions are checked on every access token: deleting a session invalidates its
  access token before its expiry.

## Transport and headers

- All state-changing endpoints require a bearer access token.
- JSON responses are `cache-control: no-store` and `x-content-type-options:
  nosniff`.
- `Authorization` is never echoed back, and request logs record only method, path,
  status and duration.

## Abuse controls

- A global per-client rate limiter (`REQUESTS_PER_MINUTE`) guards non-public
  routes; the health check is exempt.
- Auth endpoints use a separate, stricter limiter (`AUTH_ATTEMPTS_PER_MINUTE`) and
  an exponential failure delay keyed by client + username.
- Request bodies are capped at `MAX_REQUEST_BODY_BYTES`; attachments and images
  have their own limits. Base64 input is validated before decoding.

## GitHub tokens

- User-supplied GitHub tokens are validated against the GitHub API, then encrypted
  at rest with **AES-256-GCM**. A random 12-byte IV is generated per record; the
  GCM authentication tag protects integrity.
- The encryption key is derived from `OPENCODE_GITHUB_TOKEN_ENCRYPTION_KEY` and is
  scoped per user, so a leaked ciphertext cannot be decrypted without the key.
- Disconnecting deletes the stored ciphertext; backups exclude the auth
  preferences file on Android.

## Attachments

- Attachment blobs are stored outside the JSON collections, written under mode
  `0600`, and served only to the owning user with `nosniff`.
- MIME type is validated against an allow-list; image size has a tighter limit
  than generic attachments.

## Threat model scope

In scope: credential stuffing, token replay, auth-token theft from disk, oversized
payloads, SSRF via user-controlled URLs (provider/GitHub base URLs are
operator-controlled configuration only), and log leakage of secrets.

Out of scope: an attacker with read access to the environment (they already have
the keys), and side channels in the host operating system.
