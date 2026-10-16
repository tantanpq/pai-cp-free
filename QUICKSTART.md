# PAI CP quickstart

## Prerequisites

- Git and Node >= 22.5 (with npm).
- Chrome/Chromium for browser planes; set `CHROME_PATH` if discovery fails.
- Windows for `msi-cp`, `home-cp`, and `rea-cp`'s current CLI route.
- For a real GitHub action, your own GitHub account and permission to comment.

Doctor and quickstart are verified on Windows and Linux. Installation
checks need no account; sign into GitHub for the real action below.

## Path A: install with your AI agent

```text
Set up PAI CP for me: clone https://github.com/tantanpq/pai-cp-free.git into ./pai-cp-free, then read and follow ./pai-cp-free/AGENT_INSTALL.md exactly.
```

The agent runs `install.mjs`; success is its final `PAI_CP_INSTALL_RESULT` line containing `"ok":true`.

## Path B: manual installation

```sh
git clone https://github.com/tantanpq/pai-cp-free.git ./pai-cp-free
cd ./pai-cp-free
npm install
node tools/doctor.mjs
```

Doctor prints seven checks (SKIP is not counted in the summary):

- `node-version`: requires Node >= 22.5.
- `playwright-core`: checks that the dependency resolves.
- `syntax`: runs Node syntax checks on the listed files that are present.
- `contract-probes`: checks present CPs return a structured unknown-action error; none present is a failure.
- `seed-tests`: runs the bundled executor-pin/seed suite, expecting 9/9.
- `chrome`: looks for Chrome/Chromium, including `CHROME_PATH`; missing is WARN.
- `cdp`: probes `PAI_CP_CDP_URL` if set; otherwise SKIP.

With Chrome found and the optional CDP probe unset, expect `DOCTOR_RESULT PASS=6 WARN=0 FAIL=0`.

Run `node tools/quickstart.mjs` next. It performs these steps:

- `deps`: checks `playwright-core` before proceeding.
- `doctor`: runs the package checks again.
- `seed-demo`: encodes, decodes, and prepares a candidate-only seed with a fingerprint.
- `gateway-smoke`: starts an isolated gateway; checks initialize, tools/list, chief_status, unknown-tool refusal, and health.
- `browser-sample`: launches a fresh headless Chrome profile and runs GitHub `session.check`.
- `windows-bonus`: checks `msi-cp` process enumeration on Windows; skips elsewhere.
- Cleanup stops child processes and removes temporary data; success prints `QUICKSTART OK`.

On a fresh Chrome profile, `browser-sample` **PASSES via the session gate**:
the CP refuses because nobody is signed in. That refusal verifies the
browser path and is expected. No Chrome means this step is SKIP instead.

## First real action: GitHub

Start Chrome with a dedicated profile and local debugging port. PowerShell (adjust the path if needed):

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9336 --user-data-dir="$env:LOCALAPPDATA\pai-cp-chrome" https://github.com
```

Linux (use your installed Chromium executable if different):

```sh
google-chrome --remote-debugging-port=9336 --user-data-dir="$HOME/.pai-cp-chrome" https://github.com
```

Sign into github.com yourself and clear any challenge. From the repository root, in PowerShell:

```powershell
$env:GITHUB_CP_CDP='http://127.0.0.1:9336'
$env:GITHUB_CP_DIR=Join-Path (Get-Location) '.pai-cp/github'
'{"action":"session.check"}' | node core/github-cp/proto/run-action.mjs
```

POSIX shell:

```sh
export GITHUB_CP_CDP=http://127.0.0.1:9336
export GITHUB_CP_DIR="$PWD/.pai-cp/github"
echo '{"action":"session.check"}' | node core/github-cp/proto/run-action.mjs
```

Expected shape (values shown are placeholders):

```json
{"ok":true,"data":{"loggedIn":true,"user":"YOUR_USER","url":"https://github.com/","challenge":false},"evidence_dir":"RUN_DIRECTORY"}
```

**This next command posts a real comment.** Replace owner, repo, issue
number, and body with a target you intend to write to. This PowerShell
example uses a top-level idempotency key; reuse it only for the same request.

```powershell
'{"action":"issue.comment","idempotency_key":"first-comment-001","params":{"owner":"YOUR_OWNER","repo":"YOUR_REPO","issue_number":123,"body":"Hello from my local PAI CP."}}' | node core/github-cp/proto/run-action.mjs
```

On POSIX, prefix the same single-quoted JSON with `echo` before the pipe.
Evidence lands in `.pai-cp/github/evidence/<run-id>/`: screenshots,
`steps.jsonl`, `run.log`, `run.json`, and `result.json`. The success reply
includes the exact `evidence_dir`; a replay returns the recorded result.

## Gateway quick run

In a POSIX terminal at the repository root:

```sh
PORT=8899 CHIEF_BRIDGE_DB_PATH="$PWD/pai-cp-demo.sqlite" CHIEF_MCP_PUBLIC_PROFILE=READ_ONLY node gateway/server.standalone.cjs
```

PowerShell equivalent: set `$env:PORT='8899'`,
`$env:CHIEF_BRIDGE_DB_PATH=Join-Path (Get-Location) 'pai-cp-demo.sqlite'`,
and `$env:CHIEF_MCP_PUBLIC_PROFILE='READ_ONLY'`; then run
`node gateway/server.standalone.cjs`. Leave it running and use another terminal:

```sh
curl http://127.0.0.1:8899/health
curl -i -X POST http://127.0.0.1:8899/mcp -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"pai-cp-demo","version":"1.0.0"}}}'
```

Use `curl.exe` in PowerShell. Health reports `status: "READY"`; initialize returns an MCP result and a session header for subsequent calls.
Profiles are `READ_ONLY`, `GOVERNED_RW` (default), and `FEDERATION_RW`.
V1 does not strictly enforce per-tool argument schemas: use `READ_ONLY`
for untrusted callers. [Gateway scope](gateway/README.md#scope-in-v1) is partial.

## Troubleshooting

- Missing dependencies: run `npm install`; missing Chrome: set `CHROME_PATH`.
- Session refusal: sign into the dedicated Chrome profile and clear challenges.
- `LEASE_HELD`: wait for the other CP run to finish, then retry.
- See [AGENT_INSTALL.md's troubleshooting table](AGENT_INSTALL.md#if-the-verdict-is-okfalse) for install failures; include the doctor result when reporting a bug, without credentials/cookies.
