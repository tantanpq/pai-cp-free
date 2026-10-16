# PAI Chief Chat Bridge V1

Private `tool-only` MCP bridge for `pai-tan-chief-main`. The governed-RW plane includes `chief_resume`, `chief_status`, `chief_turn`, `chief_prepare_handoff`, and `chief_correct_memory`. The read/knowledge plane provides `pai_resume`, `pai_get_pulse`, `pai_get_context_pack`, `pai_get_recent_intent`, `pai_get_work_item`, `pai_get_result_event`, `pai_get_host_capabilities`, plus Company Knowledge-compatible `search` and `fetch`.

R1.3 adds the prompt-continuity plane: `pai_record_user_prompt`, `pai_commit_prompt_bundle`, `pai_get_prompt_bundle`, `pai_get_user_profile`, and `pai_flush_prompt_bundle_archive`. It stores exact user-role evidence in local SQLite, binds bundle reads to an exact thread, attaches only bundle pointers/hashes to handoffs, derives candidate-only weighted behavioral cards, and writes privacy-filtered cold archives through a retryable outbox to `CHIEF_PROMPT_ARCHIVE_ROOT`.

The bridge still has no raw SQL, filesystem, shell, generic executor, Governor claim, Task Box claim, canonical-memory write, or `TAN_DIRECT_*` minting surface. `chief_turn` COMMIT remains request-only; it does not automatically call admission.

## Binding and execution

Set `CHIEF_BRIDGE_USER_ID`, `CHIEF_BRIDGE_PAI_ID`, and `CHIEF_BRIDGE_PROJECT_ID`; never place credentials in this project or tool arguments. The server refuses any other `userId`, resolves only `pai-tan-chief-main`, validates every input, rate-limits calls, applies revision fencing, and emits deterministic idempotency/audit receipts. Tool text is bounded and prompt-injection patterns fail closed. The server listens only on `127.0.0.1:8787` and serves Streamable HTTP MCP at `POST /mcp`; `npm test` is its local test transport.

`chief_turn` emits only a Governor request for delegated intent. The candidate `chief-delegation-admission` module is an explicit future-consumer seam: after a consumer verifies bound-user provenance, matching PREVIEW/COMMIT identity/hash/revision, allowed intent, and one bounded mutable scope, it can materialize one idempotent immutable `DISPATCH_DRAFT_CANDIDATE_ONLY` artifact under its caller-supplied candidate Task Box root. It never claims, writes PostgreSQL, runs a resident, or starts a refill loop.

## R2 read and knowledge plane

The six historical `pai_*` contracts are retained, but their old operating-pulse/SQLite placeholders are not reused. Their adapters are injected from current owners: Chief continuity; JIT QCHECK plus sanitized Claim projection; existing Memory Room context or explicit `BLOCKED`; authoritative lifecycle plus immutable Task Box/HANDOFF evidence; and signed/observed capability evidence. Missing owners return an explicit bounded failure class rather than guessed parity or a fabricated result.

`search({query})` returns one text item containing `{results:[{id,title,url,...}]}`. `fetch({id})` returns one text item containing `{id,title,text,url,metadata}`. Objects are curated and bounded; metadata distinguishes `STATIC_SEMANTIC` fixed-provenance material from `JIT_RUNTIME` operational material, including freshness and authority. Neither API accepts paths, commands, credentials, SQL, or claim controls.

## Protocol compatibility

The candidate retains the deployed JSON-RPC Streamable HTTP shape and declares `2025-03-26`, because this bridge does not currently use the MCP SDK and the existing Secure MCP Tunnel client behavior is anchored to that version. Tool discovery is available through `initialize` and cacheable `tools/list`; requests have no authority-bearing private session state. A full `2026-07-28` switch, server discovery extensions, and MRTR/tasks extensions are deferred until the actual SDK/tunnel runtime is upgraded and canary evidence proves client compatibility. No protocol upgrade is implied by this source candidate.

## Historical endpoints

The prior multi-host gateway's `127.0.0.1:8791` service is historical and must not be started by this candidate. `MSI:8765` and other legacy ports are historical unless fresh runtime evidence from their owning service proves otherwise. The only referenced live bridge endpoint remains the already-owned loopback `127.0.0.1:8787/mcp`; this candidate does not start, stop, bind, tunnel, or modify it.

## Secure MCP Tunnel setup contract

ChatGPT cannot reach this localhost server directly. Use the OpenAI Secure MCP Tunnel workflow to publish a temporary authenticated HTTPS path to `http://127.0.0.1:8787/mcp`, then connect that HTTPS `/mcp` endpoint in ChatGPT Developer Mode as a private app. The tunnel is the only network exposure: do not bind this server to `0.0.0.0`, open a router port, use an unauthenticated public tunnel, or put tunnel credentials in source, prompts, or tool calls. Start/revoke the tunnel outside this repository and rotate its connection material according to the tunnel provider's controls.

Current ChatGPT plan support must be confirmed in the product UI: full write MCP support requires ChatGPT Business, Enterprise, or Edu; Pro may be restricted to read/fetch tool use. Where mutations are unavailable, use the fallback below.

## Universal API/local fallback

Any local PAI Chief chat surface or OpenAI API orchestration may call the same governed tools through the local MCP transport (or invoke `createBridge(...).rpc()`); it must retain `requestId` on retries and pass the latest `expectedRevision` for Chief session mutations. Transport identity remains server-bound and is not a public tool field. This is an adapter, not a parallel Chief implementation: it preserves the same identity binding, fixed session ID, validation, receipts, revision fences, candidate-only memory behavior, and fail-closed denials. It does not require an API key unless the caller itself makes OpenAI API requests.

## Validation

Run `npm test` here, plus the existing `chief_live_session_v1` and `pai_chief_v1` suites. Prompt-continuity coverage verifies single-event and bundle idempotency, conflict rejection, exact-thread denial, restricted-text redaction, weighted candidate activation, outbox/Drive projection, and raw-free handoff pointers.

## Docs used

- https://developers.openai.com/apps-sdk/build/mcp-server
- https://developers.openai.com/apps-sdk/plan/tools
- https://developers.openai.com/apps-sdk/quickstart
- https://developers.openai.com/apps-sdk/deploy
