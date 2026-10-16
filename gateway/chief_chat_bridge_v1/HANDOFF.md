# HANDOFF

STATUS: NOT_DONE:CANDIDATE_EDIT_NOT_VERIFIED
BOOTSTRAP_EXIT_READY: WITHDRAWN
CANDIDATE_EDIT_VERIFIED: NOT_DONE

`normalizeProviderAction` accepts one flat action object, or one top-level action key whose value is one object. `content` becomes `payload`. Multiple action keys, mixed flat-plus-nested shapes, unknown actions, and raw shell are rejected. Identical bytes remain `NO_MATERIAL_DELTA`.

Local matrix and `npm test` passed before the live canary.

One live canary, 4 sends, at least 90 seconds apart. No timeout, rate limit, or human challenge. Turn 1 read `item.js`. Turn 2 was a flat material `WRITE_CANDIDATE` changing the operator toward addition. Turn 3 ran target `tracked_test`, which is outside the Lens set, so `SCOPE_DENIED`. Turn 4 read target `scope`, also `SCOPE_DENIED`. No host-verified test exit 0 and no `DONE`.

Live ChatGPT testing stopped. Phase B was not started.
