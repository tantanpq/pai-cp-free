---
name: Pack breakage
about: Report an app UI change or a failing pack action
title: "[Pack] "
labels: bug
---

Do not paste credentials, cookies, tokens, or private session data.
Review logs and screenshots for sensitive content before sharing.

## Pack and action

- Pack:
- Action:
- PAI CP version:
- Operating system and Chrome/Chromium version:

## What the app UI shows now

Describe the current screen, changed controls, and expected behavior.
Include a screenshot description; attach a redacted screenshot if useful.

## Reproduction

List the steps or command with sensitive values removed. State whether
the action produced a real side effect before it failed.

## Doctor output line

Paste the final `DOCTOR_RESULT PASS=... WARN=... FAIL=...` line from
`node tools/doctor.mjs`, plus any relevant FAIL/WARN line.

## Evidence file names

List the run directory and evidence file names (screenshots, `steps.jsonl`,
or `run.log`) that show the failure. Share only reviewed, redacted content.
