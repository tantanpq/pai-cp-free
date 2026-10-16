# Seed uplink kit — canonical set

A seed lets a chat-only agent (no local tools) hand a structured work order
to a local PAI. The work order is encoded as one opaque string:

```
PAI-SEED-V1.<base64url(canonical JSON)>.<sha256 signature>
```

Decoding verifies the signature (`SEED_TAMPERED` on mismatch), validates a
strict 9-field schema (unknown fields, absolute scopes and path traversal
are rejected), and — this is the point of the design — **nothing executes
on import alone**: an unconfirmed import returns
`NEEDS_LOCAL_USER_CONFIRMATION`, every generated request is a
`CANDIDATE_DRAFT` stamped `LOCAL_PAI_USER_REVIEW_REQUIRED`, and execution
only ever happens through the gateway's governed `pai_action_run` after the
local user confirms. The kit itself contains no network code except the
CLI's JSON-RPC POST to a **loopback-only** HTTP endpoint (default port
8787), and no credentials or personal values of any kind.

## Canonical set (chosen by content hash, 2026-10-15)

The kit existed in ~110 copies across Drive with only 16 distinct
contents. This set is the latest complete distribution (2026-09-30) and is
byte-identical to the copies that live upstream in the gateway repo
(`gateway/chief_chat_bridge_v1/src/seed-uplink.js`, `seed-cli.js`,
`test/seed-uplink.test.js` — verified by hash during packaging).

| File | Bytes | SHA-256 |
|---|---|---|
| `seed-uplink.js` | 5,998 | `6d102ec513398d49e7ee42813c7093bcadecfcb5ae705d1290d7997f538e521c` |
| `seed-cli.js` | 2,632 | `0dc4171bac980c0a63d57bcdc1f21f1fee341a2abfe9ce3f3a1569dab74075e2` |
| `seed-uplink.test.js` | 4,802 | `cfdaa76f54402874aaa604c20bbb1c716da44b94e2161122e9f7cbab8b9aae40` |
| `seed-source-capsule.json` | 1,148 | `b2350d87b1e80d8eeec6e826f9da6a7fca371076e37cd3ec28b17fc5258737ff` |
| `seed.js` | 3,239 | `f36f7fb76d4ed33225e80be208cccc9757d363a9d1527cf560736c0f1e5edd31` |

**About `seed.js`:** despite the name it is *not* part of the uplink kit —
it is Playwright's own `seed` module (generates `seed.spec.ts` from a
config) that ended up in the same Drive folders. It is kept here, labelled,
because the canonical-set decision was "the five files as distributed";
do not wire it into anything seed-related.

`seed-compiler.cjs` (an older evidence/contract compiler, 12 copies / 6
contents) is a different artifact and is **not** part of this kit.

## Running the test

`seed-uplink.test.js` is written for the gateway repo layout: it imports
`../src/seed-uplink`, `../src/executor-router` and `../src/federation-core`.
In this package the runnable copy is the upstream one:

```bash
cd gateway/chief_chat_bridge_v1
node test/seed-uplink.test.js     # 9/9 pass — see gateway/README.md
```

The bundled suite passes **9/9** after the 2026-10-15 packaging fix
(executor-pin validation in the gateway sources).
Historical: it was 7/9 at original packaging, also on the pristine upstream clone.
A reduced variant of the
test that needs only `seed-uplink.js` + `seed-cli.js` passes 6/6 — the
core encode/decode/confirm flow is self-contained in those two files.

## Live probe status (as recorded on Drive, read 2026-10-15)

End-to-end seed probes (`PAI_SEED_UPLINK_E2E_PROBE`): **R3** DONE/DONE,
acceptance PASS · **R2** RECOVERING/BLOCKED with healthy readback ·
**R1** WAIT_RESOURCE/RECONCILE_REQUIRED, degraded. (Lifecycle read times
2026-10-15; the probes themselves originated 2026-09-24/26.)
