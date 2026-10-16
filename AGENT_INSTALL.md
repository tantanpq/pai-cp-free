# Install PAI CP as an AI agent

Use this file to install PAI CP on your user's machine. Define success ONLY by the final `PAI_CP_INSTALL_RESULT` verdict line printed by `install.mjs` containing `"ok":true`.

Follow the sections in order: prerequisites, then clone/update, then install. Nothing after the verdict — including the optional first action at the end of this file — is part of installation.

## Before you start

Verify prerequisites yourself: run `git --version`, `node --version`, and `npm --version`. Require Node >= 22.5. npm is a hard prerequisite — `install.mjs` uses it to install dependencies; it ships with Node, so if `node` works but `npm` is missing, reinstall Node (below) instead of proceeding.

If Git is missing, you MUST install it yourself: on Windows, run `winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements`; on macOS, run `brew install git` or install Xcode Command Line Tools; on Linux, use the distro package manager. Re-run `git --version` to verify, then continue. Stop only if the install command itself fails, and report the exact blocker to your user.

If Node is missing or too old, you MUST install Node >= 22.5 LTS yourself: on Windows, run `winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements`; on macOS, run `brew install node@22`; on Linux, use NodeSource. Re-run `node --version` to verify, then continue. Stop only if the install command itself fails, and report the exact blocker to your user.

## Install

If `./pai-cp` does not exist, run:

```sh
git clone https://github.com/tantanpq/pai-cp.git pai-cp
```

If `./pai-cp` exists and is this repository, update in place; installation is idempotent:

```sh
git -C pai-cp pull --ff-only
```

Before updating an existing directory, verify it is this repository: run `git -C pai-cp remote get-url origin` — it must print `https://github.com/tantanpq/pai-cp.git` (or the SSH form `git@github.com:tantanpq/pai-cp.git`). If it prints anything else, that directory is unrelated: preserve it untouched and clone into a different parent directory instead.

Then run:

```sh
cd pai-cp && node install.mjs
```

The install normally finishes within a few minutes; the dependency download is the slow part, and step diagnostics print as it goes. If 10 minutes pass with no verdict line, treat the run as stuck: stop, keep the last diagnostic lines, and report them to your user.

Read the final verdict line. If it contains `"ok":true`, finish and report the verified doctor result and QUICKSTART OK summary to your user.

## If the verdict is ok:false

Use the failing step and the preceding diagnostic lines:

| Step | Meaning | What you may do yourself |
| --- | --- | --- |
| `node` | Node too old/missing | Install Node >= 22.5 LTS, then re-run. If Node is missing, handle the prerequisite before expecting a verdict. |
| `deps` + `npm not found` | npm missing | Reinstall Node (bundles npm), then re-run. |
| `deps` (npm exited non-zero) | Registry/network or permissions | Check network, then re-run once; do NOT edit `package.json` or `package-lock.json`. |
| `doctor` FAIL line `playwright-core` | Dependencies incomplete | Run `npm install`, then `node install.mjs` again. |
| `doctor` FAIL `contract-probes` naming a CP | A control plane failed to load | Report the FAIL line verbatim to your user; do not patch source. |
| `doctor` FAIL `seed-tests` | Bundled seed suite regression | Report the FAIL line verbatim to your user; do not patch source. |
| `quickstart` `session check failed` text inside a PASS line | EXPECTED on a fresh Chrome profile (nobody signed in yet); it is a pass, not an error | Do nothing. |
| `quickstart` browser step SKIP | No Chrome/Chromium found | Install Chrome, or set `CHROME_PATH` to a Chromium binary, then re-run. |
| `LEASE_HELD` anywhere | Another CP run holds the browser lease | Wait for it to finish (leases expire in <= 15 min), then re-run. |
| (after install) first action returns `CDP_UNREACHABLE` | The user's Chrome with CDP is not running | NOT an install failure — the verdict already completed. See "After install": stop and report. |

After applying a fix, re-run `node install.mjs` at most 2 more times. If it still fails, report the failing step and the verbatim error line to your user and stop. For source regressions above, report immediately without patching or retrying unchanged code.

## Rules

- Never edit package source files to make a check pass.
- Never skip doctor or quickstart.
- Install without credentials, API keys, or accounts. If anything asks for one, stop and report it.
- Run everything on the user's machine and keep everything there.

## After install

Installation is already complete at this point — the verdict line above is the finish line, and nothing below is required for a successful install. What follows is an optional first real action (a smoke check, not an install step). Unlike the install, it needs the user's own Chrome already running and signed in, with CDP available at `http://127.0.0.1:9336`. Run the commands from the root of the clone (`./pai-cp`) — the paths below are relative to it.

Run a first real action through a CP CLI: send one JSON command on stdin and read one JSON line on stdout.

On Windows PowerShell:

```powershell
$env:GITHUB_CP_CDP='http://127.0.0.1:9336'; '{"action":"session.check"}' | node core/github-cp/proto/run-action.mjs
```

On POSIX:

```sh
echo '{"action":"session.check"}' | GITHUB_CP_CDP=http://127.0.0.1:9336 node core/github-cp/proto/run-action.mjs
```

If the action returns an error containing `CDP_UNREACHABLE` (or a connection refusal to `127.0.0.1:9336`), the user's Chrome with CDP is not running. This is NOT an install failure. Stop: do not retry in a loop, and do not launch or reconfigure the user's Chrome yourself. Report to your user that installation completed and verified (`ok:true`), and that running a first real action needs their signed-in Chrome running with CDP on port 9336.

Use each CP's own environment prefix: `<NAME>_CP_CDP` / `<NAME>_CP_DIR`. Find per-action evidence in `<CP dir>/evidence`. On Linux/macOS, set `<NAME>_CP_DIR` to a POSIX path first (for example `export GITHUB_CP_DIR="$HOME/.pai-cp/github-cp"`): without it, the evidence and idempotency paths default to a Windows location (`C:\temp\<name>-cp`) relative to your working directory. Point your user at `README.md` and `QUICKSTART.md` for the human-oriented tour.
