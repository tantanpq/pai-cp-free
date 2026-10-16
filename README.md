# PAI CP

PAI CP is a set of local control planes that let an AI agent operate real
apps: your own signed-in Chrome and your own PC, through one strict JSON
command contract, with session gates, idempotency, and evidence for every
run. It is for people who drive agents such as Claude Code, Codex, or
ChatGPT and want those agents to do verified things in real apps.

## Install with your AI agent

Give your agent this instruction:

```text
Set up PAI CP for me: clone https://github.com/tantanpq/pai-cp.git into ./pai-cp, then read and follow ./pai-cp/AGENT_INSTALL.md exactly.
```

Or use the manual three-command path:

```sh
git clone https://github.com/tantanpq/pai-cp.git ./pai-cp && cd ./pai-cp
npm install
node tools/doctor.mjs && node tools/quickstart.mjs
```

Requires Git, Node >= 22.5, and Chrome/Chromium for browser planes.
Windows is required for `msi-cp`, `home-cp`, and `rea-cp`'s current CLI route.
Doctor and quickstart have been verified on Windows and Linux.

See [QUICKSTART.md](QUICKSTART.md) for Chrome setup and a first GitHub action.
[AGENT_INSTALL.md](AGENT_INSTALL.md) defines the automated install procedure;
`install.mjs` runs dependency setup, doctor, and quickstart and prints a
`PAI_CP_INSTALL_RESULT` verdict.

## How it works

Each CP CLI reads one JSON command from stdin and prints exactly one JSON
line on stdout. Exit code is 0 for `ok:true`, 1 for `ok:false`.

```text
AI agent -> JSON stdin -> app CP -> your Chrome / Windows PC
         <- JSON stdout <- result + local evidence directory
```

For example, after configuring GitHub's CDP endpoint and data directory:

```sh
echo '{"action":"session.check"}' | node core/github-cp/proto/run-action.mjs
```

Browser actions attach over CDP to Chrome that you run and sign into.
A cross-process lease prevents two CP runs from sharing one browser.
Before dispatch, a watchdog refuses actions when the session is signed out
or a Cloudflare challenge is present. `rea-cp` only blocks on Cloudflare;
it can scan public pages without a login.

Side-effecting actions accept an `idempotency_key`; replaying the same
request returns its recorded result. The GitHub sample requires a key for
every write. Use a new key for each new intended operation.

Runs write screenshots and a steps log into the CP's evidence directory.
Set `<NAME>_CP_DIR` to choose the data directory and `<NAME>_CP_CDP` to
choose Chrome's CDP endpoint, for example `GITHUB_CP_DIR` and `GITHUB_CP_CDP`.
Evidence lands under `<CP dir>/evidence`; successful replies include
`evidence_dir` for the run.

## What's in the free tier

The public repository ships the FREE tier:

| Component | Scope |
| --- | --- |
| `core/browser-control-plane-core` | Shared runner with the JSON contract, browser lease, session gates, idempotency, and evidence. |
| `core/github-cp` | Sample pack: `session.check`, `issue.comment`, `issue.create`, `discussion.comment`; writes require an idempotency key. |
| `seed/` | Candidate-only structured work orders from a chat AI to the local gateway. |
| `gateway/` | Partial phase-1 MCP server over HTTP `POST /mcp`; execution and session storage are wired, other services are stubbed. |
| `core/rea-cp` | `map.scan` invokes a separate `rea-agents` CLI via `npx`; `map.diff` compares snapshots. |
| `core/msi-cp` | Windows PC plane: `sys.exec`, `sys.processes`, `sys.tasks`, `sys.files`, `sys.screenshot`. |
| `core/home-cp` | Windows PC plane with the same `sys.*` action family. |
| `tools/doctor.mjs`, `tools/quickstart.mjs`, `install.mjs` | Package checks, an end-to-end walkthrough, and agent installation tooling. |

The GitHub sample has comment/create scope only: no merge or push powers.
The PC planes operate on your Windows machine; review commands before
authorizing an agent to use `sys.exec`.

The seed kit encodes `PAI-SEED-V1` work orders with a tamper-evident SHA-256
fingerprint. It validates the target executor constraint before dispatch.
Importing a seed produces a candidate; execution needs a local
human-confirmed submit.

The gateway exposes profiles `READ_ONLY`, `GOVERNED_RW`, and `FEDERATION_RW`.
See [gateway/README.md](gateway/README.md#scope-in-v1) for its wired and
blocked services.

## How this differs from Playwright MCP / browser-use

Playwright MCP and browser-use are excellent, free, general-purpose browser
drivers. PAI CP uses per-app packs with fixed action catalogs —
postconditions, session gating, idempotency, and evidence — and states each
pack's verification status per pack (see the status table below). It also
includes Windows PC planes and the seed/gateway handoff.

PAI CP trades generality for verified, repeatable operations on specific
apps. An app's supported action catalog defines what its pack can do;
the status and limitations below still apply.

## Safety model

PAI CP is local-first. Your accounts stay in your own browser profile;
nothing phones home as package telemetry. App actions still contact the
apps you operate, and `rea-cp`'s scan route invokes an external CLI via `npx`.
You provide and sign into Chrome yourself.

Session gates and the browser lease govern browser dispatch. Idempotency
receipts let agents replay recorded operations, and local evidence lets
you inspect what happened.

The PC planes' destructive-command denylist is a guardrail, not a security
boundary. Give agents only the host access you intend them to have.

In the standalone gateway, the mind gate returns `MIND_GATE_NOT_CONFIGURED` metadata and does not enforce doctrine preflight for `chief_turn`.
Memory rooms are absent: `chief_turn` receives null room context and `pai_get_context_pack` fails closed with `BLOCKED` / `MEMORY_ROOM_OWNER_UNAVAILABLE`.
Behavioral memory is absent: `chief_turn` has no behavioral recall or capture, and status reports it unavailable.
Prompt evidence is absent: prompt tools are not exposed and direct calls to them fail closed with `CHIEF_BRIDGE_DENIED`.
`pai_resume` returns continuity metadata (degraded when its source is unavailable); it does not require these three services.
The semantic catalog is empty, and the full upstream server is not included.

The gateway defaults to `GOVERNED_RW`; select `READ_ONLY` for untrusted
callers. In v1 it does not strictly enforce per-tool argument schemas.
The RW profiles expose execution capabilities; choose a profile deliberately.

Seeds remain candidate-only until a local human confirms submission.
The SHA-256 fingerprint detects tampering; it does not replace that review.

## Beyond the free tier

Additional app packs (ChatGPT first — 9/10 flows verified; the
resume-after-timeout case RB-12 is still open and gates any sale of that
pack), per-case custom builds, and the PAI CP Builder are offered
separately. The Builder is an advanced
addon for web apps that generates CANDIDATE packs until exercised live;
it is not integrated into the core. `chatgpt-cp`, `grok-cp`, `suno-cp`, and
the Builder are excluded from the free repository. `suno-cp` is not offered.

| Paid pack | Status |
| --- | --- |
| `chatgpt-cp` | 9/10 flows verified; the resume-after-timeout case (RB-12) is still open and gates any sale |

## Status & known limitations

Version **1.0.0**. Packaging checks verified on Windows and Linux:
doctor `PASS=6 WARN=0 FAIL=0`, seed suite **9/9**, gateway smoke PASS,
and on a fresh Chrome profile the browser sample PASSES via the session gate:
the CP refuses because nobody is signed in; that refusal is the verified
behavior. `install.mjs` returned `ok:true`, including from a fresh tree.

- Gateway phase 1 is partial: live sessions, federation execution including
  `pai_action_run`, and Task Box-backed delegation admission are wired;
  mind gate, rooms, behavioral memory, and prompt evidence remain stubbed.
- GitHub writes are limited to comments and issue creation, with required
  idempotency keys. It cannot merge or push.
- `github-cp`: the login case was never confirmed (RB-15);
  `session.check` reports signed-out state honestly.
- `home-cp`: the packaged workspace copy and the live deployment have
  drifted in places; where they differ, the deployed behavior is the
  operational truth (see [PACKAGE_MANIFEST.md](PACKAGE_MANIFEST.md)).
- Browser planes need the signed-in Chrome session you provide.
- `rea-cp` currently needs Windows and the separate `rea-agents` CLI route.
- For completeness, outside the free tier: `chatgpt-cp` has one upstream
  resume-after-timeout case still unverified; `grok-cp` selectors have not
  been re-verified after the last UI change, and `video.create` uses quota.
- `suno-cp` is an undeployed B1 candidate with a self-contradictory
  `session.check`; it is not offered.
- Builder verification covers web apps only: its own QA recorded 62/62
  tests and 8 real operations. (62/62 tests and 8 real operations were recorded against the frozen house install; the portable package combination has not been re-qualified - see addons/pai-cp-builder/README.md.) Native apps and 3D/canvas are out of scope.

[PACKAGE_MANIFEST.md](PACKAGE_MANIFEST.md) is the full packaging verification
register, including historical records for components outside the free tier.
Its earlier 7/9 seed result predates the fixes recorded in
[CHANGELOG.md](CHANGELOG.md); the current bundled suite passes 9/9.

## License

[PolyForm Shield 1.0.0](LICENSE).

## Support

[GitHub Issues](https://github.com/tantanpq/pai-cp/issues), best effort,
no SLA. Include the doctor result line and relevant evidence file names;
do not paste credentials or cookies.

Built by Tan Ho and Leona AI
