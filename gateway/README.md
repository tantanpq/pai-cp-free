# Chief MCP Gateway — phase-1 standalone packaging

The gateway is the MCP layer of PAI: an MCP server (`POST /mcp` on
127.0.0.1) that gives an external chat/agent a governed surface over PAI —
session resume/status, context reads, and a federation plane whose
`pai_action_run` tool executes through the computer execution fabric
(persistent terminal sessions). Upstream source: repo `pai-core-private`,
`src/one_pai/chief/CORE/chief_chat_bridge_v1/`, snapshotted at commit
`7ccb92bf` (2026-10-13). The packaging survey was performed against the same
tree (file-level dependency map in `docs/PAI_CP_PACKAGE_SURVEY_2026-10-15.md`).

## What is in this folder

| Path | Origin |
|---|---|
| `chief_chat_bridge_v1/` | Full upstream package (src, contracts, tests, docs) **except `src/server.js`** — see below. |
| `chief_live_session_v1/` | Upstream, unmodified. The SQLite session store (hard dependency: the bridge does not load without it). |
| `computer_execution_fabric_v1/` | Upstream, unmodified. The execution fabric behind `pai_action_run`. |
| `role_jd_s0_v1/` | Upstream, unmodified. Carries `chief_contract_v1`, required by the session store. |
| `vendor/prompt-evidence-ledger/` | The single ledger file from upstream `06_STATE/…` — carried for phase 2, **not wired** in phase 1. |
| `server.standalone.cjs` | **New phase-1 composition root** written for this package. |

The relative layout of the upstream tree is preserved on purpose: the bridge
resolves its siblings (`../../chief_live_session_v1`,
`../../computer_execution_fabric_v1`, `../../role_jd_s0_v1`) by relative
path, and they resolve inside this folder.

## Why `src/server.js` is not here

The upstream composition root hard-requires ten sibling packages (mind,
continuity runtime, memory rooms, learning, cognitive lifecycle, knowledge
room, domain, chief, …) and embeds deployment-specific values (session/user
ids, a semantic catalog of fixed Drive document ids, ProgramData runtime
paths, a local Claim Service default). Shipping it would either break on
load or leak one deployment's configuration. `server.standalone.cjs`
replaces it for phase 1 and documents every substitution in its header.

## Phase-1 scope — wired vs stubbed

**Wired for real**

- MCP protocol surface (initialize / tools/list / tools/call, protocol
  versions 2026-07-28 + legacy 2025-03-26 / 2024-11-05, header audits,
  tool-name normalization) — same handler logic as upstream.
- `chief_resume` / `chief_status` on the real SQLite session store.
- All six federation tools, including `pai_action_run`, through the real
  execution fabric.
- Read-gateway owners backed by the canonical-truth adapter and the real
  readers (Claim Service, Task Box, current pointer) **when the matching
  env vars point at live services**; otherwise each owner answers with the
  bridge's own BLOCKED code — the same fail-honest behaviour as upstream.
- Delegation admission for the RW profiles (Task Box root via env).

**Stubbed / not wired (by design, phase 1)**

- PAI Mind gate → stub receipts (`MIND_GATE_NOT_CONFIGURED`). Consequence:
  doctrine preflight is not enforced for `chief_turn`.
- Continuity runtime, context gateway (memory rooms), behavioral memory,
  prompt-evidence hook → `null`. Consequence: `pai_resume` fails closed with
  `CHIEF_BRIDGE_DENIED`; `chief_turn` has null room context and no behavioral
  recall or capture; recent-intent owner reports unavailable.
- Prompt tools are **removed from the public tool list** (without the
  prompt-evidence hook the bridge refuses to expose them — fail-closed).
- Accepted composition (cognitive lifecycle / learning gate / domain
  intelligence / knowledge room) → `null`; their advisory policies are
  absent, which the bridge treats as "no advisory", not as an error.
- Semantic catalog → empty. `search`/`fetch` return no semantic entries
  until an operator supplies their own catalog.

Phase 2 (not in this package): memory rooms + control plane + continuity
runtime + mind; phase 3 (to be weighed): the pai-chief/run-loop chain.

## Run

```bash
cd gateway
node server.standalone.cjs            # 127.0.0.1:8787, profile GOVERNED_RW
PORT=8899 PAI_GATEWAY_CANARY=1 CHIEF_BRIDGE_DB_PATH=/path/to/isolated.sqlite node server.standalone.cjs
```

Requires Node ≥ 22.5 (`node:sqlite`). Configuration is env-only — the full
list is in the header of `server.standalone.cjs`. State lives under
`PAI_GATEWAY_DATA` (default `~/.pai-chief-gateway`). There is no HTTP auth
by design: the security boundary is loopback binding + the bridge's own
identity/session binding, rate limiting and revision fencing, exactly as
upstream. Do not expose the port beyond loopback/a tunnel you control.
`pai_action_run` executes real commands on the host through the fabric —
treat running this server as handing the terminal to whoever can reach it.

## Verification performed for this packaging (2026-10-15)

- Boot smoke on a clean data dir: `GET /health` → READY; `initialize`
  (2025-03-26) → valid MCP result; `tools/list` → canonical bootstrap
  catalog; `chief_status` → live session state from SQLite with continuity
  honestly DEGRADED (no canonical-truth source configured);
  `pai_capabilities` → real federation capability cards; a malformed
  `pai_action_run` → FAIL receipt, nothing executed.
- `node --check` passes on the composition root and on every patched file.
- The bridge's bundled `test/seed-uplink.test.js` runs **in this layout**:
  7/9 pass — identical to the pristine upstream clone at the same commit
  (the 2 failures are in the executor-pin path and pre-date this
  packaging; they are not caused by it).
- The upstream test suite under `chief_chat_bridge_v1/tests/` targets the
  full PAI tree (it imports the original `server.js` and sibling packages)
  and is **not** expected to run in this phase-1 layout; it is carried
  as-is for reference and for phase 2.

## Patches applied to the packaged bridge copy

Upstream files are byte-identical except these four, parameterized so no
deployment-specific value ships (each patch is also listed in
`../PACKAGE_MANIFEST.md`):

1. `src/provider-result-envelope.js` — prompt-archive fallback root:
   user-profile Drive path → `~/.pai-chief-gateway/…` (env
   `CHIEF_PROMPT_ARCHIVE_ROOT` still wins).
2. `src/turn-call-usage.js` — same fallback change.
3. `src/executor-router.js` — Antigravity/Grok CLI paths derived from the
   current user's home, overridable via `PAI_AGY_CLI_PATH` /
   `PAI_GROK_CLI_PATH`.
4. `src/host-control-adapter.js` — allowed/forbidden filesystem roots that
   named one user's profile are now derived from `os.homedir()`
   (semantics unchanged: the current user's home, `My Drive`, `.gemini`,
   `.grok`, `.ssh`, `.aws`, `.azure`).

Test files keep their original fixture literals; they describe the
original deployment's fixtures and are not part of the runtime.

## Scope in v1

This is a partial phase-1 gateway: an MCP server over HTTP `POST /mcp`
with `READ_ONLY`, `GOVERNED_RW`, and `FEDERATION_RW` profiles. The full
upstream server is not included.

- **Wired:** live session store, federation execution including
  `pai_action_run`, and delegation admission backed by a configured Task Box.
- In the standalone gateway, the mind gate returns `MIND_GATE_NOT_CONFIGURED` metadata and does not enforce doctrine preflight for `chief_turn`.
- Memory rooms are absent: `chief_turn` receives null room context and `pai_get_context_pack` fails closed with `BLOCKED` / `MEMORY_ROOM_OWNER_UNAVAILABLE`.
- Behavioral memory is absent: `chief_turn` has no behavioral recall or capture, and status reports it unavailable.
- Prompt evidence is absent: prompt tools are not exposed and direct calls to them fail closed with `CHIEF_BRIDGE_DENIED`.
- `pai_resume` returns continuity metadata (degraded when its source is unavailable); it does not require these three services.
- **Empty:** semantic catalog; no semantic entries are supplied.

V1 does not strictly enforce per-tool argument schemas. Operators should
use `READ_ONLY` for untrusted callers; the default is `GOVERNED_RW`.

The earlier 7/9 seed result above is a historical packaging record. After
the executor-pin validation fixes, the bundled suite now passes **9/9**.
Doctor and quickstart have been verified on Windows and Linux, including
a passing gateway smoke check. See [CHANGELOG.md](../CHANGELOG.md).
