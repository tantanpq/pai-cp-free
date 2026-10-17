# GitHub CP plugin

## What this plugin is

This is the Claude Code wrapper for the free-tier GitHub sample pack in
[pai-cp-free](https://github.com/tantanpq/pai-cp-free). Its skill teaches an
agent to drive the canonical pack in `core/github-cp/` of your local
package install. The control-plane code is not duplicated here.

The CLI operates your own Chrome over CDP (Chrome DevTools Protocol),
signed in to your own GitHub account, as you, on your machine. Chrome
contacts GitHub for app actions.

## What you get

- `session.check` to check your GitHub session.
- `issue.create` to create an issue.
- `issue.comment` to post an issue comment.
- `discussion.comment` to post a discussion comment.
- A session gate before every run and required idempotency keys on writes.

Every run writes an evidence record (steps log + run result) into
`$GITHUB_CP_DIR/evidence/<run-id>/`. Screenshots are captured for runs that
reach the browser. A run rejected at the session gate (signed out or a
challenge) stops before any browser action, so it has no screenshot; its
evidence record is still written.

The package records a limitation: the signed-in login case has not been
confirmed (RB-15); signed-out session refusal is verified. See the package
README and `QUICKSTART.md` for verification status and setup.

## Prerequisites

Install pai-cp-free locally first; locate its root by
`core/github-cp/proto/run-action.mjs`. Node >= 22.5 is required.
Start your own Chrome with `--remote-debugging-port=9336` and a dedicated
`--user-data-dir`, and sign in to github.com yourself. Set
`GITHUB_CP_DIR=<package root>/.pai-cp/github`;
`GITHUB_CP_CDP` defaults to `http://127.0.0.1:9336`.
Follow the package README's agent install instruction and `QUICKSTART.md`.

## Install

In Claude Code:

```text
/plugin marketplace add tantanpq/pai-cp-free
/plugin install github-cp@pai-cp
```

Or clone the repository; `plugins/github-cp/` is part of it. The plugin
provides guidance and discovery and still requires the local package
installation.

## What it does not do

There is no telemetry or hosted service. The pack never handles your GitHub
credentials or stores them; you sign in personally in Chrome. It cannot
merge or push: the GitHub sample has comment/create scope only, matching the
package README's limitation. It does not log in for you or bypass challenges.

## License

[PolyForm Shield 1.0.0](LICENSE). This directory's LICENSE is a verbatim,
byte-identical copy of the repository LICENSE. Source-available, not open
source. Required Notice: Copyright 2026 Tan Ho.
