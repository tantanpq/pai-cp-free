# TESTS — Provider V0 accepted

**Date**: 2026-09-23
**Status**: PROVIDER_V0_ACCEPTED: CONFIRMED

| Check | Result |
| --- | --- |
| `npm test` after artifact handoff | PASS, exit 0 |
| Checkpoint A canary | PASS, exit 0, 23/23, `PAI_BRAIN_OK`, inline disposition |
| W4 local policy | PASS: short inline, long spill, digest readback, credential text refused |
| W4 live send | One send at 21:40:46Z. 1279 bytes stored. Digest `02e6b0638dde883e1dee2cc8aa1d49ff4791e3156a15ef71201e0ddde13de3c0` |
| Compact result | Re-read of those exact bytes: summary 180 chars, full body absent from the envelope |

Checkpoint B bytes were not edited. The B live loop was not rerun.

## Phase 2

`node tests/project-lens-canary.cjs` on fixture `pai-lens-TBlfGt`. Exit 0. `PROJECT_LENS_V0_PASS: CONFIRMED`. WorkSpec commit `ba3a70ce65b1f6eb42b52ccb2ddc0d6731b32fb6` and diff hash `286d6db0eeda4ce29163dddaf0616b0f04a00304690b2ee6ca1b309271adaad6` matched the capsule.

## Lens repair

`node tests/project-lens-porcelain.test.cjs` exit 0. The old trim parser yields `ote.txt`. The repaired parser yields `note.txt` with code ` M`. `ote.txt` is `SCOPE_DENIED`.

`node tests/project-lens-canary.cjs` exit 0. `PROJECT_LENS_V0_PASS: CONFIRMED`. Capsule path `note.txt`. WorkSpec files `note.txt`. Commit `6ab1529b8b83c8184b88dabdaf80fb97e7db1268`.

`node src/bounded-work-entry.js read` exit 0. `LENS_CONTROL_PASS: CONFIRMED`. Two turns. Executor `DETERMINISTIC_HOST`.

`node src/bounded-work-entry.js edit` exit 1. `LOOP_LIMIT_REACHED`. Write repeated `a - b`. No passing RUN. `CHATGPT_TIMEOUT` on later turns.

`npm test` exit 0 after the Lens repair.
