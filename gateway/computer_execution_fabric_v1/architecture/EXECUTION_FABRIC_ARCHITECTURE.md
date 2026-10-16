# Execution Fabric Architecture R1

## Decision

Keep one governed PAI execution path. The Computer Execution Fabric is an internal Host Control capability below existing admission, not a public raw-shell MCP plane.

```text
Tân / ChatGPT / Grok / Anti
        |
        v
PAI Federation Gateway / Chief MCP
        |
        v
pai_action_run / current governed work request
        |
        v
existing admission + Governor/RSM + Claim/Fence
        |
        v
GOVERNED_HOST_CONTROL profile
        |
        v
Session Runtime -> Transport Adapter -> Shell/PTY -> Host
        |
        +-> bounded output -> spool -> output_ref -> receipt
        +-> actor transcript
        +-> process-tree owner / reaper
        |
        v
existing Result/HANDOFF reconciliation
```

## Core separation

The session engine knows how to execute and preserve machine state. It does not decide whether an action is authorized. `fenceValidator` proves current ownership/freshness; `operationAuthorizer` applies the current effect, allowed-root, network and policy decision on every interactive input. Both are required dependencies.

The engine therefore remains technically broad while admission remains external. New shell classes (PowerShell, CMD, WSL/bash, SSH, container, REPL) implement the same adapter contract instead of creating a new control plane.

## Truth boundary

`exitCode=0`, `SESSION_CLOSE`, or an execution receipt never means semantic Task DONE. The core receipt allows only `UNRESOLVED`, `VERIFIED_EXTERNALLY`, or `FAILED_EXTERNALLY`. Existing PAI Result/HANDOFF remains the owner of objective/Program truth.

## Storage layout

```text
runtime-root/
  registry/<session>.json
  sessions/<session>/
    output.log
    stdout.log
    stderr.log
    output-index.ndjson
    transcript.ndjson
    receipts/*.json
    workspace/           # removable resource workspace
```

## Memory/output model

Every output byte is first reduced to a bounded in-memory ring and also spooled to disk. Chat/Chief consumes a compact tail + cursors + `output_ref`; old output is recovered by range rather than replaying the whole transcript into model context.

The current reference uses deterministic local-file spooling. The live binder may substitute an async spool owner as long as cursor monotonicity, full-output evidence and bounded model-visible output remain invariant.

## Non-goals

- no new queue/database/scheduler;
- no new Claim or fencing authority;
- no public `shell`, `bash`, `exec`, `filesystem`, or SQL tool;
- no provider-specific lane;
- no automatic host migration of a live session;
- no secret extraction through the model;
- no semantic DONE projection from terminal status.
