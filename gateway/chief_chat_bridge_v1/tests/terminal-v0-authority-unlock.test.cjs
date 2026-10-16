'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { FederationCore } = require('../src/federation-core');
const { matchesAllowList, matchesDenyList } = require('../src/host-control-adapter');
const { createServer } = require('../src/server');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  TERMINAL V0 AUTHORITY UNLOCK & GOVERNANCE TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════');

async function runTests() {
  // 1. matchesAllowList import path actually executes without ReferenceError
  console.log('\n── Check 1: matchesAllowList import and execution ──');
  assert.equal(typeof matchesAllowList, 'function', 'matchesAllowList must be exported');
  assert.equal(matchesAllowList('hostname'), true, 'hostname in allow list');
  assert.equal(matchesAllowList('Get-Process'), true, 'Get-Process in allow list');
  assert.equal(matchesAllowList('ArbitraryCommand -Arg 1'), false, 'Arbitrary command not in allow list');

  // Verify FederationCore executes operationAuthorizer with Class A
  let capturedFence = 'FENCE_TEST_01';
  const core = new FederationCore({
    authorityReader: () => ({ status: 'AVAILABLE', fenceRef: capturedFence })
  });
  // Class A allow-list check
  const authClassAAllowed = core.sessionRuntime.operationAuthorizer('hostname', 'READ_ONLY');
  assert.equal(authClassAAllowed.authorized, true, 'Class A allow list allowed command');
  const authClassADenied = core.sessionRuntime.operationAuthorizer('custom_script.ps1', 'READ_ONLY');
  assert.equal(authClassADenied.authorized, false, 'Class A not-allowed command rejected');
  assert.ok(authClassADenied.reason.includes('HOST_CONTROL_NOT_ALLOWED'), 'Class A rejection reason correct');
  console.log('✓ Check 1: matchesAllowList executes cleanly without ReferenceError');

  // 2. Class B (CANDIDATE_DRAFT) permits general PowerShell capability (not restricted to allow-list)
  console.log('\n── Check 2: Class B general capability authorization ──');
  const authClassBGeneral = core.sessionRuntime.operationAuthorizer('$x = 42; Set-Location C:\\; npm test', 'CANDIDATE_DRAFT');
  assert.equal(authClassBGeneral.authorized, true, 'Class B allows general engineering commands');
  // Deny list still enforced in Class B
  const authClassBDenied = core.sessionRuntime.operationAuthorizer('Get-Credential', 'CANDIDATE_DRAFT');
  assert.equal(authClassBDenied.authorized, false, 'Class B strictly enforces deny list');
  console.log('✓ Check 2: Class B permits general shell capability while enforcing external deny list');

  // 3. Fresh Claim authority permits Class-B OPEN
  console.log('\n── Check 3: Fresh Claim authority permits Class-B OPEN ──');
  const claimMockReader = {
    authority: () => ({
      status: 'OK',
      authority: {
        backend: 'POSTGRESQL',
        operationalCutover: true,
        generation: 118,
        fencingToken: 113,
        updatedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 120000).toISOString()
      }
    })
  };
  const claimCore = new FederationCore({
    realReaders: claimMockReader
  });
  const openResult = await claimCore.handleActionRun({
    request_id: 'test-open-claim-1',
    intent: 'TERMINAL_COMMAND',
    objective: 'Open test session under Claim authority',
    effect_class: 'CANDIDATE_DRAFT',
    action_payload: {
      operation: 'OPEN'
    }
  });
  assert.equal(openResult.chief_state, 'ADMITTED', 'OPEN must be ADMITTED');
  assert.equal(openResult.terminal_session?.fence_ref, '113', 'Bound real Claim fencing token');
  const sessionId = openResult.terminal_session?.session_id;
  assert.ok(sessionId, 'session_id returned');
  console.log(`✓ Check 3: Fresh Claim authority admitted Class-B OPEN with fenceRef=${openResult.terminal_session?.fence_ref}`);

  // 4. Same current fence preserves active session across calls
  console.log('\n── Check 4: Same current fence preserves active session ──');
  const inputResult = await claimCore.handleActionRun({
    request_id: 'test-input-same-fence',
    intent: 'TERMINAL_COMMAND',
    objective: 'Run command under same fence',
    effect_class: 'CANDIDATE_DRAFT',
    action_payload: {
      operation: 'INPUT',
      session_id: sessionId,
      input: 'Write-Output "FENCE_PRESERVED"'
    }
  });
  assert.equal(inputResult.chief_state, 'ADMITTED', 'INPUT admitted under same fence');
  console.log('✓ Check 4: Same fence preserves healthy active session');

  // 5. Server-owned fence rotation rejects old session
  console.log('\n── Check 5: Server-owned fence rotation rejects old session ──');
  // Rotate Claim authority to token 114
  claimMockReader.authority = () => ({
    status: 'OK',
    authority: {
      backend: 'POSTGRESQL',
      operationalCutover: true,
      generation: 118,
      fencingToken: 114, // ROTATED!
      updatedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 120000).toISOString()
    }
  });
  let threwStale = false;
  try {
    await claimCore.handleActionRun({
      request_id: 'test-input-rotated-fence',
      intent: 'TERMINAL_COMMAND',
      objective: 'Run command after fence rotated',
      effect_class: 'CANDIDATE_DRAFT',
      action_payload: {
        operation: 'INPUT',
        session_id: sessionId,
        input: 'Write-Output "SHOULD_FAIL"'
      }
    });
  } catch (err) {
    threwStale = true;
    assert.ok(err.message.includes('STALE_FENCE_CURRENT_AUTHORITY_CHANGED'), `Error was: ${err.message}`);
  }
  assert.ok(threwStale, 'Rotated fence must reject stale session');
  console.log('✓ Check 5: Server-owned fence rotation strictly rejects stale session');

  // Close session
  await claimCore.handleTerminalSession({ operation: 'CLOSE', session_id: sessionId });

  // 6. Stale authority triggers bounded JIT refresh and admits if fresh
  console.log('\n── Check 6: JIT authority refresh on stale continuity ──');
  let refreshed = false;
  let continuityState = { status: 'DEGRADED', available: false, degradedReason: 'STALE' };
  const refreshingCore = new FederationCore({
    continuity: () => continuityState,
    refreshQcheck: () => {
      refreshed = true;
      continuityState = { status: 'VERIFIED', available: true, fenceRef: 'FENCE_REFRESHED_999' };
    }
  });
  const refreshedOpen = await refreshingCore.handleActionRun({
    request_id: 'test-open-jit-refresh',
    intent: 'TERMINAL_COMMAND',
    objective: 'Test JIT refresh',
    effect_class: 'CANDIDATE_DRAFT',
    action_payload: { operation: 'OPEN' }
  });
  assert.ok(refreshed, 'refreshQcheck must be invoked when authority is stale');
  assert.equal(refreshedOpen.chief_state, 'ADMITTED');
  assert.equal(refreshedOpen.terminal_session?.fence_ref, 'FENCE_REFRESHED_999');
  console.log('✓ Check 6: Stale continuity triggers JIT refresh and admits refreshed fence');
  await refreshingCore.handleTerminalSession({ operation: 'CLOSE', session_id: refreshedOpen.terminal_session?.session_id });

  // 7. Default tools/list contains pai_action_run and excludes pai_terminal_session
  console.log('\n── Check 7: Default tools/list projection ──');
  const tmpDir = path.join(os.tmpdir(), `server_tool_test_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const serverApp = createServer({
    env: {
      ...process.env,
      PAI_GATEWAY_CANARY: '1',
      PORT: '0',
      CHIEF_BRIDGE_DB_PATH: path.join(tmpDir, 'test.sqlite'),
      CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW'
    }
  });

  const defaultTools = serverApp.bridge.resolveJitTools({}, serverApp.bridge.publicToolDefinitions);
  const toolNames = defaultTools.map(t => t.name);
  assert.ok(toolNames.includes('pai_action_run'), 'Default tools/list MUST include pai_action_run');
  assert.ok(!toolNames.includes('pai_terminal_session'), 'Default tools/list MUST NOT include pai_terminal_session');
  assert.ok(toolNames.length >= 3 && toolNames.length <= 8, `Default tool count ${toolNames.length} in [3, 8]`);
  console.log(`✓ Check 7: Default tools/list contains pai_action_run (${toolNames.length} bounded tools: ${toolNames.join(', ')})`);

  // 8. Direct call to pai_terminal_session fails closed
  console.log('\n── Check 8: Direct pai_terminal_session call denied ──');
  const rpcRes = await serverApp.bridge.rpc({
    jsonrpc: '2.0',
    id: 'test-direct-tool',
    method: 'tools/call',
    params: { name: 'pai_terminal_session', arguments: {} }
  });
  assert.ok(
    rpcRes.error?.message?.includes('BRIDGE_TOOL_DENIED') ||
    rpcRes.error?.data?.code === 'BRIDGE_TOOL_DENIED',
    `Expected BRIDGE_TOOL_DENIED, got: ${JSON.stringify(rpcRes.error)}`
  );
  console.log('✓ Check 8: Direct pai_terminal_session call strictly denied with BRIDGE_TOOL_DENIED');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ALL TERMINAL V0 AUTHORITY UNLOCK CHECKS PASSED CLEANLY');
  console.log('═══════════════════════════════════════════════════════════════');
}

runTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
