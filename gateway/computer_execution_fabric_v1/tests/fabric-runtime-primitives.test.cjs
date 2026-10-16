'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { createPowerShellPipeAdapter, TERMINAL_MODE } = require('../runtime/powershell-adapter.cjs');
const { createOutputSpooler, DEFAULT_MAX_SPOOL_BYTES } = require('../runtime/output-spooler.cjs');
const {
  terminateSessionTree,
  captureProcessOwnership,
  verifyProcessOwnership,
  pidAlive
} = require('../runtime/process-tree-manager.cjs');
const { SessionRuntime } = require('../runtime/session-runtime.cjs');

async function testAdapter() {
  console.log('── Adapter Tests ──');
  const adapter = createPowerShellPipeAdapter({ timeoutMs: 5000 });
  const startInfo = adapter.start();
  assert.ok(startInfo.pid > 0, 'Adapter PID should be positive');
  assert.equal(startInfo.terminal_mode, 'POWERSHELL_PERSISTENT_PIPE_V0');
  const initialPid = adapter.pid;

  // 1. Persistent same PID across blocks
  const res1 = await adapter.runBlock('$a = 10; Write-Output "BLOCK1"');
  assert.equal(res1.status, 'SUCCESS', 'Block 1 should succeed');
  assert.equal(res1.pid, initialPid, 'PID must remain the same for Block 1');

  const res2 = await adapter.runBlock('$a = $a + 5; Write-Output "VAL:$a"');
  assert.equal(res2.status, 'SUCCESS', 'Block 2 should succeed');
  assert.equal(res2.pid, initialPid, 'PID must remain the same for Block 2');

  // 2. Deterministic unique sentinel
  assert.ok(res1.marker.startsWith('PAI_SENTINEL_'), 'Marker must use unique prefix');
  assert.notEqual(res1.marker, res2.marker, 'Markers must be unique per block');

  // 3. UTF-8 output
  const resUtf8 = await adapter.runBlock('Write-Output "Xin chào thế giới! Tiếng Việt đẹp."');
  assert.equal(resUtf8.status, 'SUCCESS', 'UTF-8 block must succeed');

  // 4. Sentinel timeout
  // Start a sleep that exceeds timeout
  const resTimeout = await adapter.runBlock('Start-Sleep -Milliseconds 3000', 500);
  assert.equal(resTimeout.status, 'INPUT_COMPLETION_UNVERIFIED', 'Timed-out block must return INPUT_COMPLETION_UNVERIFIED');
  assert.equal(resTimeout.timeout, true, 'timeout flag must be true');

  // Clean stop
  adapter.stop();
  console.log('✓ Adapter tests passed');
}

async function testSpooler() {
  console.log('── Spooler Tests ──');
  const spoolFile = path.join(os.tmpdir(), `test_spool_${Date.now()}.spool`);
  const spooler = createOutputSpooler({
    spoolPath: spoolFile,
    sessionId: 'test-session-001'
  });

  // 1. Opaque external output_ref
  assert.equal(spooler.output_ref, 'pai-terminal-output://test-session-001');
  assert.ok(!spooler.output_ref.includes(':\\'), 'output_ref must not reveal physical filesystem path');

  // 2. Raw byte cursor + UTF-8 paging (Vietnamese multibyte)
  const chunk1 = 'Line 1: Xin chào\n';
  const chunk2 = 'Line 2: Tiếng Việt\n';
  const chunk3 = 'Line 3: Kết thúc\n';

  spooler.append(Buffer.from(chunk1, 'utf8'));
  spooler.append(Buffer.from(chunk2, 'utf8'));
  spooler.append(Buffer.from(chunk3, 'utf8'));

  const read1 = spooler.read({ cursor: 0, maxLines: 1 });
  assert.equal(read1.text, 'Line 1: Xin chào\n');
  assert.equal(read1.cursor, 0);
  assert.equal(read1.nextCursor, Buffer.byteLength(chunk1, 'utf8'));

  // Sequential read from nextCursor: no duplicate, no skip
  const read2 = spooler.read({ cursor: read1.nextCursor, maxLines: 1 });
  assert.equal(read2.text, 'Line 2: Tiếng Việt\n');
  assert.equal(read2.cursor, read1.nextCursor);
  assert.equal(read2.nextCursor, read1.nextCursor + Buffer.byteLength(chunk2, 'utf8'));

  const read3 = spooler.read({ cursor: read2.nextCursor, maxLines: 1 });
  assert.equal(read3.text, 'Line 3: Kết thúc\n');

  // 3. Large output handling
  for (let i = 0; i < 500; i++) {
    spooler.append(Buffer.from(`Data line ${i}: ${'x'.repeat(100)}\n`, 'utf8'));
  }
  const largeRead = spooler.read({ cursor: 0, maxBytes: 1024 });
  assert.ok(largeRead.bytes <= 1024, 'Read must not exceed maxBytes');
  assert.equal(largeRead.truncated, true, 'truncated must be true when more data remains');

  try { fs.unlinkSync(spoolFile); } catch (_) {}
  console.log('✓ Spooler tests passed');
}

async function testProcessTreeManager() {
  console.log('── Process Tree Manager Tests ──');
  const adapter = createPowerShellPipeAdapter();
  const startInfo = adapter.start();
  const pid = startInfo.pid;

  assert.ok(pidAlive(pid), 'Spawned process must be alive');

  // 1. Capture ownership
  const ownership = captureProcessOwnership(pid, 'test-session-tree');
  assert.equal(ownership.pid, pid);
  assert.equal(ownership.sessionId, 'test-session-tree');

  // 2. Ownership mismatch refuses kill
  const fakeOwnership = {
    ...ownership,
    creationDate: '99999999.000000+000',
    executablePath: 'malicious_recycled.exe'
  };
  const mismatchResult = terminateSessionTree(pid, { expectedOwnership: fakeOwnership });
  assert.equal(mismatchResult.verified, false);
  assert.equal(mismatchResult.status, 'CLEANUP_UNVERIFIED');
  assert.equal(mismatchResult.reason, 'PROCESS_OWNERSHIP_MISMATCH');
  assert.ok(pidAlive(pid), 'Process must still be alive after refused kill');

  // 3. Proper ownership matches and terminates
  const killResult = terminateSessionTree(pid, { expectedOwnership: ownership });
  assert.equal(killResult.verified, true);
  assert.equal(killResult.status, 'CLOSED_WITH_VERIFIED_CLEANUP');
  assert.equal(killResult.reason, 'ROOT_PID_GONE');
  assert.ok(!pidAlive(pid), 'Process must be gone after verified kill');

  // 4. Already dead is verified
  const deadResult = terminateSessionTree(pid, { expectedOwnership: ownership });
  assert.equal(deadResult.verified, true);
  assert.equal(deadResult.reason, 'ALREADY_EXITED');

  console.log('✓ Process Tree Manager tests passed');
}

async function testSessionRuntime() {
  console.log('── Session Runtime Tests ──');
  const runtime = new SessionRuntime({
    authorityReader: () => ({ status: 'AVAILABLE', fenceRef: 'FENCE_2026_TEST' }),
    fenceValidator: (expected, actual) => expected === actual,
    operationAuthorizer: (cmd) => {
      if (cmd.includes('FORBIDDEN_COMMAND')) {
        return { authorized: false, reason: 'DENIED_BY_POLICY' };
      }
      return { authorized: true };
    }
  });

  // 0. Constructor fail-closed tests (A, B, C)
  assert.throws(() => new SessionRuntime({}), /SESSION_AUTHORITY_READER_REQUIRED/);
  assert.throws(() => new SessionRuntime({ authorityReader: () => {} }), /SESSION_FENCE_VALIDATOR_REQUIRED/);
  assert.throws(() => new SessionRuntime({ authorityReader: () => {}, fenceValidator: () => {} }), /SESSION_OPERATION_AUTHORIZER_REQUIRED/);

  // 1. OPEN
  const openRes = await runtime.openSession({
    owner_host: 'HOME',
    fence_ref: 'FENCE_2026_TEST',
    effect_class: 'CANDIDATE_DRAFT',
    work_context: 'CANARY_WORK_CONTEXT',
    scope: 'DISPOSABLE_SCOPE'
  });
  assert.ok(openRes.session_id.startsWith('pts_'), 'session_id must start with pts_');
  assert.equal(openRes.host, 'HOME');
  assert.equal(openRes.terminal_mode, 'POWERSHELL_PERSISTENT_PIPE_V0');
  assert.equal(openRes.state, 'IDLE');
  const sessionId = openRes.session_id;
  const sessionPid = openRes.pid;

  // 2. Persistent state across multiple INPUT calls on same PID
  // Call 1: set cwd, env, variable
  const in1 = await runtime.inputSession({
    session_id: sessionId,
    fence_ref: 'FENCE_2026_TEST',
    input: '$env:CANARY_TEST = "PERSISTED_OK"; $test_var = 100; Write-Output "STEP1_DONE"'
  });
  assert.equal(in1.status, 'SUCCESS');
  assert.equal(in1.pid, sessionPid, 'PID must remain the same');

  const read1 = runtime.readSession({ session_id: sessionId, cursor: in1.cursor });
  assert.ok(read1.text.includes('STEP1_DONE'), 'Must contain output from step 1');

  // Call 2: verify persistence of env and variable
  const in2 = await runtime.inputSession({
    session_id: sessionId,
    fence_ref: 'FENCE_2026_TEST',
    input: 'Write-Output "ENV:$env:CANARY_TEST"; Write-Output "VAR:$($test_var + 23)"'
  });
  assert.equal(in2.status, 'SUCCESS');
  assert.equal(in2.pid, sessionPid, 'PID must still be the same');

  const read2 = runtime.readSession({ session_id: sessionId, cursor: in2.cursor });
  assert.ok(read2.text.includes('ENV:PERSISTED_OK'), 'Env var must persist');
  assert.ok(read2.text.includes('VAR:123'), 'PowerShell variable must persist');

  // 3. STATUS & SNAPSHOT
  const statusRes = runtime.statusSession({ session_id: sessionId });
  assert.equal(statusRes.session_id, sessionId);
  assert.equal(statusRes.pid, sessionPid);
  assert.equal(statusRes.state, 'IDLE');

  const snapRes = runtime.snapshotSession({ session_id: sessionId });
  assert.equal(snapRes.session_id, sessionId);
  assert.ok(snapRes.tail_text.length > 0);

  // 4. Negative: Wrong session_id
  await assert.rejects(
    () => runtime.inputSession({ session_id: 'nonexistent_session', input: 'echo test' }),
    /SESSION_NOT_FOUND/
  );

  // 5. Negative: Caller-supplied stale fence
  await assert.rejects(
    () => runtime.inputSession({ session_id: sessionId, fence_ref: 'STALE_FENCE_OLD', input: 'echo test' }),
    /STALE_FENCE/
  );

  // 5b. Negative: Server-owned fence rotation without caller fence_ref (D)
  let dynamicFence = 'FENCE_A';
  const rotationRuntime = new SessionRuntime({
    authorityReader: () => ({ status: 'AVAILABLE', fenceRef: dynamicFence }),
    fenceValidator: (expected, actual) => expected === actual,
    operationAuthorizer: () => ({ authorized: true })
  });
  const rotOpen = await rotationRuntime.openSession({ owner_host: 'HOME' });
  assert.equal(rotOpen.state, 'IDLE');
  // Rotate authority behind the session
  dynamicFence = 'FENCE_B';
  await assert.rejects(
    () => rotationRuntime.inputSession({ session_id: rotOpen.session_id, input: 'Write-Output "SHOULD_NOT_EXECUTE"' }),
    /STALE_FENCE_CURRENT_AUTHORITY_CHANGED/
  );

  // 6. Negative: Authority 503 / unavailable or missing fence (E)
  const blockedRuntime = new SessionRuntime({
    authorityReader: () => ({ status: 'UNAVAILABLE', statusCode: 503 }),
    fenceValidator: (expected, actual) => expected === actual,
    operationAuthorizer: () => ({ authorized: true })
  });
  const blockedOpen = await blockedRuntime.openSession();
  assert.equal(blockedOpen.status, 'BLOCKED');
  assert.equal(blockedOpen.blocker, 'CURRENT_FENCE_OR_AUTHORITY_READBACK_UNAVAILABLE');

  const missingFenceRuntime = new SessionRuntime({
    authorityReader: () => ({ status: 'AVAILABLE' }), // no fenceRef
    fenceValidator: (expected, actual) => expected === actual,
    operationAuthorizer: () => ({ authorized: true })
  });
  const missingFenceOpen = await missingFenceRuntime.openSession();
  assert.equal(missingFenceOpen.status, 'BLOCKED');
  assert.equal(missingFenceOpen.blocker, 'CURRENT_FENCE_OR_AUTHORITY_READBACK_UNAVAILABLE');

  // 6b. Effect ceiling tests (F)
  // OPEN A -> B denied
  const classARuntime = new SessionRuntime({
    authorityReader: () => ({ status: 'AVAILABLE', fenceRef: 'FENCE_A_CEILING' }),
    fenceValidator: (expected, actual) => expected === actual,
    operationAuthorizer: () => ({ authorized: true })
  });
  const openClassA = await classARuntime.openSession({ effect_class: 'NO_MATERIAL_DELTA' });
  await assert.rejects(
    () => classARuntime.inputSession({ session_id: openClassA.session_id, effect_class: 'CANDIDATE_DRAFT', input: 'echo test' }),
    /SESSION_EFFECT_CEILING_EXCEEDED/
  );

  // OPEN B -> C denied, B -> A/B permitted
  const classBRuntime = new SessionRuntime({
    authorityReader: () => ({ status: 'AVAILABLE', fenceRef: 'FENCE_B_CEILING' }),
    fenceValidator: (expected, actual) => expected === actual,
    operationAuthorizer: () => ({ authorized: true })
  });
  const openClassB = await classBRuntime.openSession({ effect_class: 'CANDIDATE_DRAFT' });
  await assert.rejects(
    () => classBRuntime.inputSession({ session_id: openClassB.session_id, effect_class: 'REVERSIBLE_LOCAL_EFFECT', input: 'echo test' }),
    /SESSION_EFFECT_CEILING_EXCEEDED/
  );
  const okInputA = await classBRuntime.inputSession({ session_id: openClassB.session_id, effect_class: 'NO_MATERIAL_DELTA', input: 'Write-Output "ALLOWED_A"' });
  assert.equal(okInputA.status, 'SUCCESS');
  const okInputB = await classBRuntime.inputSession({ session_id: openClassB.session_id, effect_class: 'CANDIDATE_DRAFT', input: 'Write-Output "ALLOWED_B"' });
  assert.equal(okInputB.status, 'SUCCESS');

  // 6c. Immutable scope / host / work_context (G)
  await assert.rejects(
    () => runtime.inputSession({ session_id: sessionId, fence_ref: 'FENCE_2026_TEST', owner_host: 'REMOTE_NODE', input: 'echo test' }),
    /HOST_MISMATCH/
  );
  await assert.rejects(
    () => runtime.inputSession({ session_id: sessionId, fence_ref: 'FENCE_2026_TEST', work_context: 'CHANGED_CONTEXT', input: 'echo test' }),
    /WORK_CONTEXT_MISMATCH/
  );
  await assert.rejects(
    () => runtime.inputSession({ session_id: sessionId, fence_ref: 'FENCE_2026_TEST', scope: 'DIFFERENT_SCOPE', input: 'echo test' }),
    /SCOPE_MISMATCH/
  );

  // 7. Negative: Policy rejection
  await assert.rejects(
    () => runtime.inputSession({ session_id: sessionId, fence_ref: 'FENCE_2026_TEST', input: 'FORBIDDEN_COMMAND' }),
    /OPERATION_NOT_AUTHORIZED/
  );

  // 8. CLOSE
  const closeRes = runtime.closeSession({ session_id: sessionId });
  assert.equal(closeRes.state, 'CLOSED');
  assert.equal(closeRes.cleanup.verified, true);
  rotationRuntime.closeSession({ session_id: rotOpen.session_id });
  classARuntime.closeSession({ session_id: openClassA.session_id });
  classBRuntime.closeSession({ session_id: openClassB.session_id });

  // 9. Negative: Closed session input rejected
  await assert.rejects(
    () => runtime.inputSession({ session_id: sessionId, fence_ref: 'FENCE_2026_TEST', input: 'echo after close' }),
    /SESSION_CLOSED/
  );

  // 10. Idempotent close
  const close2 = runtime.closeSession({ session_id: sessionId });
  assert.equal(close2.state, 'CLOSED');
  assert.equal(close2.idempotent, true);

  console.log('✓ Session Runtime tests passed');
}

async function runAll() {
  console.log('═══ Fabric Runtime Primitives Test Suite ═══\n');
  await testAdapter();
  await testSpooler();
  await testProcessTreeManager();
  await testSessionRuntime();
  console.log('\n═══ ALL FABRIC RUNTIME PRIMITIVES TESTS PASSED CLEANLY ═══');
}

runAll().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
