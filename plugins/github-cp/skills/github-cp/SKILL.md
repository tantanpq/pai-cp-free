---
name: github-cp
description: Use when driving GitHub through the local PAI CP github-cp pack to check the session, create issues, comment on issues, or comment on discussions.
---

# GitHub through the local PAI CP

This pack is a local control plane (CLI) that drives the user's own Chrome
over CDP, signed in to the user's own GitHub account. It runs as the user,
on the user's machine. There is no hosted server, no telemetry, and no
credentials stored by the pack. The browser contacts GitHub for app actions.

## Prerequisites

1. Locate the installed pai-cp-free package root: a directory containing
   `core/github-cp/proto/run-action.mjs`. This plugin provides guidance and
   discovery; runtime code stays in `core/github-cp/` of the package.
   Never copy that code into the plugin. If the package is missing, give
   the agent the package README's one-line install instruction below and
   stop GitHub actions until installation is complete:

   ```text
   Set up PAI CP for me: clone https://github.com/tantanpq/pai-cp-free.git into ./pai-cp-free, then read and follow ./pai-cp-free/AGENT_INSTALL.md exactly.
   ```

2. Require Node >= 22.5.
3. The user must start their own Chrome with `--remote-debugging-port=9336`
   and a dedicated `--user-data-dir`, then personally sign in to github.com
   and clear any challenge. Follow the installed package's `QUICKSTART.md`
   for platform-specific Chrome commands.
4. Work from the package root. Set `GITHUB_CP_DIR=<package root>/.pai-cp/github`.
   `GITHUB_CP_CDP` defaults to `http://127.0.0.1:9336`. In PowerShell:

   ```powershell
   $env:GITHUB_CP_CDP='http://127.0.0.1:9336'
   $env:GITHUB_CP_DIR=Join-Path (Get-Location) '.pai-cp/github'
   ```

## Command contract and session gate

Send one JSON command, as an argv string or via stdin, to
`node core/github-cp/proto/run-action.mjs`. It emits exactly one JSON line.
Exit 0 means `ok:true`; exit 1 means `ok:false`.

```json
{"action":"...","params":{},"idempotency_key":"..."}
```

`idempotency_key` is TOP-LEVEL, never inside `params`.

ALWAYS run `session.check` first, before every intended run. If it reports
not logged in or a challenge, STOP and report it. Never log in for the user
or bypass a challenge.

| Action | Params | Idempotency key |
| --- | --- | --- |
| `session.check` | None | None |
| `issue.create` | `owner`, `repo`, `title`, `body` | REQUIRED |
| `issue.comment` | `owner`, `repo`, `issue_number`, `body` | REQUIRED |
| `discussion.comment` | `owner`, `repo`, `discussion_number`, `body` | REQUIRED |

Do not send a write without an idempotency key. Generate a fresh,
intent-specific key for each intended write. Replaying the same key returns
the recorded result instead of duplicating the write; reuse a key only for
the same request.

## Examples

These are the PowerShell stdin-pipe examples from `QUICKSTART.md`. Run from
the package root with the environment above configured.

```powershell
'{"action":"session.check"}' | node core/github-cp/proto/run-action.mjs
```

The next command posts a real comment. Replace the target and body with the
user's intended write, and choose a fresh key for that intent.

```powershell
'{"action":"issue.comment","idempotency_key":"first-comment-001","params":{"owner":"YOUR_OWNER","repo":"YOUR_REPO","issue_number":123,"body":"Hello from my local PAI CP."}}' | node core/github-cp/proto/run-action.mjs
```

## Evidence and safety

Every run writes an evidence record (steps log + run result) into
`$GITHUB_CP_DIR/evidence/<run-id>/`. Screenshots are captured for runs that
reach the browser. A run rejected at the session gate (signed out or a
challenge) stops before any browser action, so it has no screenshot; its
evidence record is still written. The quickstart documents `steps.jsonl`,
`run.log`, `run.json`, and `result.json` there. Cite the reply's
`evidence_dir` when reporting results.

Never ask for a GitHub password or token; this pack needs neither.
Do not invent actions beyond the four listed above. Scope is comment/create
only: no merge or push powers. An `ok:false` reply means stop and report,
not retry with changed code. Report the package's known limitation honestly:
the signed-in login case has not been confirmed (RB-15); signed-out
session refusal is verified.

Sources: the installed package's `QUICKSTART.md`, `core/github-cp/README.md`,
and the root README's safety model and limitations.
