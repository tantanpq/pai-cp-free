# Seed to TaskBox: terminal readback

Submit once through the existing Governor, retain its pai_task_id, then use the same local client:

```powershell
node seed-cli.js status CHIEF_REQUEST_ID
node seed-cli.js result CHIEF_REQUEST_ID
node seed-cli.js wait CHIEF_REQUEST_ID --timeout-ms 60000
```

status/result read the existing pai_run_status and pai_result tools. wait is bounded to at most300000ms, defaults to60000ms, and never submits work. A saved task ID remains usable without the original in-memory submission receipt.

Only COMPLETED_WITH_RESULT with terminal=true, completed=true and result_verified=true confirms goal completion. A verified NOT_DONE/BLOCKED/CANCELLED returns TERMINAL_FAILURE_WITH_RESULT and native exit1. A pending timeout returns WAIT_TIMEOUT_NO_RESUBMIT, retains the task ID and exits2. Reconciliation or conflicting/error readbacks remain held. No read command retries an effect.

A cached admission/replay receipt may still say READY after the canonical task is DONE. submit now performs one Result read for any admitted reply; verified canonical Result takes precedence over stale receipt state. An absent Result still means pending, never completed.

For an end-to-end read-only smoke task, provide the actual input first: a small immutable fixture/receipt in the named scope, its relative sourceRefs and SHA256, and acceptance requiring the exact hash in the resulting HANDOFF. Do not ask an executor to return a nonexistent historical receipt. Admission alone and an unrelated historical Result are insufficient.

For reconciliation, use the existing Claim authority API and exact owner/claim/attempt/fence. Verify worker stream audit, bound HANDOFF, publication locks and canonical postcondition. Known-no-effect repair can reopen the same task through reconcile-no-effect; verified successful output uses complete while canonical RUNNING, or reconcile-applied if canonical RECONCILE_REQUIRED. Never edit SQLite, fabricate DONE, clear an unknown-effect hold, relax publication guards, or blindly resubmit. These client commands do not grant reconciliation authority.
