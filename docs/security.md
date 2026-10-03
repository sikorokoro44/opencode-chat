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

### Client transport

The Android client treats the configured server URL as untrusted input and
refuses to put a credential on an unencrypted socket:

- `network_security_config.xml` sets `cleartextTrafficPermitted="false"` for every
  host, so the platform refuses plain HTTP even if a request were built with a
  token attached. Cleartext is permitted only for `localhost` and `127.0.0.1`,
  where traffic never leaves the device; debug builds additionally allow
  `10.0.2.2`, the emulator's alias for the host machine.
- `BackendUrlPolicy` is the application-layer guard that runs first. A URL typed
  without a scheme becomes `https://`.
- Every path that carries a password, access token or refresh token checks the
  policy before building a request and fails closed with `insecure_transport` if
  the transport is not allowed.
- Plain HTTP to a remote host is possible only after the user ticks "Allow
  unencrypted HTTP" for that server. The consent is not inferred from the URL,
  defaults to off, and is retracted automatically when the URL returns to HTTPS or
  loopback — so a cleartext URL saved by an older release stops receiving tokens
  after an upgrade until it is reconfirmed.

**Self-hosting:** expose the backend over TLS (for example with a reverse proxy in
front of it) and use the `https://` URL in the app. `adb reverse` and on-device
development over loopback HTTP keep working without TLS.

## Abuse controls

- A global per-client rate limiter (`REQUESTS_PER_MINUTE`) guards non-public
  routes; the health check is exempt.
- Auth endpoints use a separate, stricter limiter (`AUTH_ATTEMPTS_PER_MINUTE`) and
  an exponential failure delay keyed by client + username.
- Request bodies are capped at `MAX_REQUEST_BODY_BYTES`; attachments and images
  have their own limits. Base64 input is validated before decoding.

### Client identity (`TRUST_PROXY`)

Rate-limit buckets are keyed on an address the caller cannot choose, so the
identity rule is security-relevant rather than cosmetic:

- **Default (`TRUST_PROXY=false`).** The bucket key is the socket address.
  `X-Forwarded-For` is ignored entirely.
- **`TRUST_PROXY=true`.** Only the **first** entry of `X-Forwarded-For` is used,
  and only when it parses as a literal IP address (`node:net.isIP`); anything else
  falls back to the socket address. Only the first hop is honoured so a
  caller-supplied chain cannot prepend itself ahead of the proxy's own entry.
- IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is normalised to `1.2.3.4`, so one client
  cannot hold two buckets by switching address family.

Set `TRUST_PROXY=true` **only** when a proxy you control terminates every request
and overwrites `X-Forwarded-For`. If clients can reach the backend directly, or
the proxy appends to the header instead of replacing it, a caller can forge an
address and mint unlimited buckets. Both maps are additionally capped
(`RateLimiter.maxBuckets`, `AuthDelay.maxEntries`) and evicted, so a spoofed flood
cannot grow process memory without bound even in a misconfigured deployment.

## Repository authorisation

- Every GitHub route resolves the **caller's own** credential. A caller-supplied
  bootstrap token only selects the service account, and only on a timing-safe
  match.
- `repository` is parsed strictly as exactly `owner/name`; both halves must be
  valid GitHub names. A value like `victim/repo/extra` is rejected rather than
  silently addressing `victim/repo`.
- `POST /v1/github/agent/run` resolves the credential **before** any provider call,
  so an unconnected account can neither reach a repository nor burn quota on a run
  that could not read anything. Its optional `chatId` must name a chat owned by the
  caller, so agent prompts cannot be seeded with another account's history.
- `chatId` values that become GitHub file names (`POST
  /v1/github/memory/sessions`) must be a single path-safe token, and the chat must
  be owned by the caller.
- Repository-relative paths reject absolute paths, `..`, backslashes and control
  characters; control characters are refused because the value also reaches commit
  messages and log lines.
- Repository context stored on a chat (`repository`, `projectPath`) is validated on
  the way in, so a stored value can never become a traversal once something acts
  on it.

## Upstream response handling

- GitHub responses are decoded defensively: a 2xx body missing an expected field is
  reported as an unexpected response rather than dereferenced, so a malformed or
  truncated upstream reply cannot become an unhandled crash.
- An empty body is never cached against an ETag, so a later `304` cannot resolve to
  no content. A `304` with nothing usable cached is retried once unconditionally
  and then reported as an upstream failure; a raw `304` is never placed on the wire,
  which is not a valid response status.
- Upstream error messages are truncated and never include the raw body, a token, or
  GitHub's documentation URL.

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
payloads, rate-limit evasion via forged `X-Forwarded-For`, cross-account access to
another account's chats or GitHub credential, path traversal in repository paths and
stored file names, SSRF via user-controlled URLs (provider/GitHub base URLs are
operator-controlled configuration only), and log leakage of secrets.

Out of scope: an attacker with read access to the environment (they already have
the keys), and side channels in the host operating system.
