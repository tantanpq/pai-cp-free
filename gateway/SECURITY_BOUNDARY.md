# Standalone gateway security boundary

This contract applies to `server.standalone.cjs`, the distributable composition
root. It does not retrofit upstream embedding APIs or other PAI services.

## Supported clients and transport evidence

- The root accepts JSON HTTP `POST /mcp` and serves JSON health/discovery on
  `GET`/`HEAD /health` and `/mcp`. Its executable entry point binds only
  `127.0.0.1`. There is no stdio or SSE transport in this root.
- `chief_chat_bridge_v1/src/federation-bridge.js` and the root negotiate
  `2026-07-28`, `2025-03-26`, and `2024-11-05`; legacy session headers and
  `pai_terminal`/`pai-terminal` tool namespaces remain supported. Advertised
  task/subscription extensions are JSON RPC handlers, not streaming sessions.
- `chief_chat_bridge_v1/src/seed-cli.js` and `../seed/seed-cli.js` are direct loopback JSON clients.
  Both send the configured bearer on their submit/status/result/wait calls.
- `chief_chat_bridge_v1/README.md` describes a ChatGPT Developer Mode client
  through an authenticated HTTPS MCP tunnel. The tunnel must forward or inject
  the standalone bearer and preserve a permitted Host, or use an exact Host
  override. Tunnel reachability and MCP session IDs confer no gateway authority.
- `chief_chat_bridge_v1/package.json` still points `start` at the absent
  upstream `src/server.js`; use the standalone entry point above. Its test
  script also targets the full upstream tree. `src/chatgpt-web-config.js`
  configures an outbound browser/CDP provider, not an inbound MCP listener.
  No inbound client-registration/OAuth configuration is shipped under `gateway/`.

## Threat model

| Source or attack | Boundary and remaining trust |
| --- | --- |
| Malicious browser Origin reaching localhost | Every supplied Origin must exactly match an explicit allowlist, including on health and OPTIONS. `null` is refused. Only permitted origins receive CORS echo; there are no wildcard origins or headers. |
| DNS rebinding or forged proxy headers | Host must exactly match a configured authority. Defaults are `127.0.0.1:PORT`, `localhost:PORT`, `[::1]:PORT` using the actual listening port. Forwarded headers never establish trust; duplicate security headers are refused. |
| CSRF/simple requests and forged preflight | RPC accepts POST with media type `application/json` (parameters permitted). Other RPC verbs receive 405; wrong media types receive 415. Preflight permits only the endpoint's methods and a fixed header list. GET/HEAD only return health metadata and cannot dispatch RPC. |
| Direct local client without Origin | Host validation and bearer authorization still apply. A local process that can read the operator's credentials or alter the server remains trusted at the OS boundary. |
| Loopback/tunnel/reverse proxy | Binding stays on loopback. A proxy is a trusted credential holder and must enforce authenticated external access, protect transport with TLS, and preserve the gateway restrictions. No automatic proxy or IP trust is added. |
| Bearer or session replay | Session IDs are compatibility metadata, never authorization. The configured bearer is reusable and authorizes one bound gateway identity. A stolen valid bearer can be replayed until rotation/restart; no expiry, nonce service, or per-client scopes are implemented. Existing request IDs, receipt hashes and revision fencing still apply. |
| Hidden tools, aliases, unknown/rejected RPC | A closed public-tool set gates calls before bridge dispatch, including canonical execution aliases. Unknown methods are rejected without dispatch. `tasks/get`, `tasks/update`, `tasks/cancel` and subscriptions require bearer too; task mutation additionally requires a write profile. Denials do not reach session/receipt/idempotency code. |

The execution boundary is configuration plus bearer authorization, not the
host-control regex denylist. READ_ONLY preserves the existing two-tool catalog;
it means no exposed write/exec capability, not that startup/session bookkeeping
never writes SQLite. Open discovery includes profile, session ID and schemas.
Synchronous session tools use a SQLite savepoint so an argument/revision error
also rolls back lazy session creation, audit rows and receipts. The savepoint
is released before any asynchronous RPC await; it cannot undo external effects
after authorized execution or admission starts. Existing in-memory rate-limit
accounting for dispatched calls is unchanged.

## Environment contract

| Variable | Default and validation |
| --- | --- |
| `CHIEF_MCP_PUBLIC_PROFILE` | `READ_ONLY`. Explicit `GOVERNED_RW` or `FEDERATION_RW` enables the existing governed write tools and requires a configured token at startup. Neither profile alone enables execution. |
| `CHIEF_MCP_BEARER_TOKEN` | Unset. A 32–4096 character bearer value using letters, digits, `.`, `_`, `~`, `+`, `/`, `-`, and optional trailing `=`. Generate at least 32 random bytes; length validation cannot establish entropy. Never put a token in a URL or CLI argument. |
| `CHIEF_MCP_BEARER_TOKEN_FILE` | Unset. Alternative to the token environment variable, never both. UTF-8 local regular file, at most 4098 bytes; one final LF/CRLF is allowed. File failures and invalid values abort startup with generic error codes. Restrict file access to the service owner. |
| `CHIEF_MCP_ALLOW_EXEC` | `0`/unset. Only `1` enables execution-capable `pai_action_run` (all terminal/admin/host-control aliases) and `pai_cognition_run`. Requires a write profile and token. Unknown values abort startup. A closed non-execution catalog excludes unclassified tools while this flag is off. |
| `CHIEF_MCP_ALLOWED_HOSTS` | Unset uses the three loopback authorities with the actual bound port. Override is a comma-separated list of exact lowercase `host:port` authorities, IPv6 in brackets, explicit ports 1–65535. It replaces defaults. No schemes, paths, credentials or wildcard. |
| `CHIEF_MCP_ALLOWED_ORIGINS` | Unset allows no browser Origin. Override is a comma-separated list of exact serialized HTTP/HTTPS origins, such as `https://client.example`. No path, trailing slash, wildcard, opaque `null` or empty entry. |
| `PORT` | Existing default 8787, integer 0–65535; 0 selects an ephemeral port. Existing canary database/port isolation rules remain. |

Token files must be regular files, not symlinks or reparse points. The reader
checks with `lstat` before opening and uses `O_NOFOLLOW` where available. On
POSIX, any group/other permission bits (`mode & 0o077`) are refused, including
on the opened file. On Windows, operators must provision an ACL restricting
the file to the service owner and trusted administrators/SYSTEM; the gateway
does not inspect Windows ACLs or invoke `icacls`. Keep the file and its parent
directories under trusted owner control.

Tokens are loaded at startup, retained by the server only as a SHA-256 digest,
and compared using `crypto.timingSafeEqual` on fixed-length digests. The
composition root deletes `process.env.CHIEF_MCP_BEARER_TOKEN` after hashing and
never logs the token. Execution-fabric children inherit neither bearer variable,
including values supplied through session environment overrides. The CLI reads
the same token sources for each HTTP request and never prints them. Missing configuration leaves
READ_ONLY discovery usable, but every `tools/call` returns 401. There is no
unauthenticated compatibility switch. Tool/profile denials use JSON-RPC errors;
HTTP authentication failures use 401, transport-policy failures use 403.

## Internal caller migration

1. Provision a high-entropy token using the operator's secret mechanism. Set
   `CHIEF_MCP_BEARER_TOKEN_FILE` to its local file path in the server environment
   and in the bundled CLI environment (or set `CHIEF_MCP_BEARER_TOKEN`). Do not
   commit the file. Reload the server through the operator's normal lifecycle.
2. Each tool call must send `Authorization: Bearer <configured-value>`.
   `initialize`, `server/discover`, `tools/list` and `tools/get` remain available
   without bearer subject to Host/Origin policy. Legacy session headers do not
   replace the bearer. Task reads, mutations and subscriptions require bearer.
3. For authorized internal writes, explicitly set
   `CHIEF_MCP_PUBLIC_PROFILE=GOVERNED_RW` (or `FEDERATION_RW`). For the previous
   execution-capable catalog also set `CHIEF_MCP_ALLOW_EXEC=1`. Existing bridge
   identity binding, admission, authority, revision and receipt rules still run.
4. Browser clients additionally need their exact Origin in
   `CHIEF_MCP_ALLOWED_ORIGINS`. A proxy that changes Host needs its exact
   authority in `CHIEF_MCP_ALLOWED_HOSTS`. Grant only the intended client;
   these settings are operator trust decisions, never inferred from traffic.

## Verification and rollback

Run from the repository root:

```text
node gateway/tests/run-offline.cjs
node gateway/tests/run-offline.cjs --security
```

The runner supplies a fresh environment and redirects temporary/home-derived
fixtures under `gateway/.offline-fixtures`. Security tests bind port 0 on
`127.0.0.1` and use separate SQLite/data roots under `.security-fixtures`.
Execution-positive tests use inert in-process spies, never a real terminal,
provider, Claim Service, or live gateway. The offline runner excludes upstream
suites whose packages or fixture trees are absent from this public subset; the
full upstream npm command can fail on those imports. TAP totals count legacy
assertion scripts as one file-level test.

Rollback by reverting this change's commit. That restores the older unsafe
transport defaults, so use only in a trusted internal deployment. To restore
the prior tool catalog while keeping the new boundary, configure a token,
explicit write profile and `CHIEF_MCP_ALLOW_EXEC=1`; this does not restore
wildcard CORS or unauthenticated calls. No runtime/database migration is needed.

Residual scope: no OAuth, bearer expiry, TLS listener, per-client identities,
OS sandbox, rate-limit redesign, or downstream execution-policy rewrite. A
valid authorized exec client retains the existing powerful execution surface.
