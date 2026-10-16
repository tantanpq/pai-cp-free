'use strict';

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Set isolated canary environment
const canaryDbDir = path.join(os.tmpdir(), `pai_canary_db_${Date.now()}`);
fs.mkdirSync(canaryDbDir, { recursive: true });
const canaryDbPath = path.join(canaryDbDir, 'chief-live.sqlite');
const canaryTruthPath = path.join(canaryDbDir, 'truth.json');

const validTruth = {
  scope: 'PROJECT / PAI',
  status: 'VERIFIED',
  available: true,
  goal: 'Prove bounded Chief continuity experience.',
  acceptedState: 'RESULT_VERIFIED_CANDIDATE',
  lifecycleStage: 'RESULT_VERIFIED',
  completionEvidenceVerified: true,
  runningEvidenceVerified: false,
  evidence: ['WORK_TEST_RECEIPT', 'HOME_INDEPENDENT_QA'],
  blocker: null,
  nextAction: 'PERSONAL_BETA_R2_HANDOFF',
  unresolvedAuthority: null,
  authorityOwner: 'Tan',
  fenceRef: 'FENCE_2026_CANARY_VALID'
};
fs.writeFileSync(canaryTruthPath, JSON.stringify(validTruth), 'utf8');

process.env.CHIEF_BRIDGE_DB_PATH = canaryDbPath;
process.env.CHIEF_CANONICAL_TRUTH_PATH = canaryTruthPath;
process.env.PAI_GATEWAY_CANARY = '1';
process.env.PORT = '8799';

const { createServer } = require('../../../CORE/chief_chat_bridge_v1/src/server');

function makeRpcCall(port, method, params = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      method,
      params
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28'
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          resolve({ res, body });
        } catch (e) {
          reject(new Error(`FAILED_TO_PARSE_JSON: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runCanary() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CHATGPT PERSISTENT HOME POWERSHELL TERMINAL CANARY (V0)  ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const app = createServer({ env: process.env });
  const server = app.server;

  await new Promise(resolve => server.listen(8799, '127.0.0.1', resolve));
  console.log('✓ Chief Federation HTTP MCP server listening on 127.0.0.1:8799');

  try {
    // 0. Initialize & Discover
    const init = await makeRpcCall(8799, 'initialize', { protocolVersion: '2026-07-28' });
    assert.equal(init.body.result.protocolVersion, '2026-07-28');
    console.log('✓ Negotiated 2026-07-28 modern protocol');

    const discover = await makeRpcCall(8799, 'server/discover');
    assert.equal(discover.body.result.capabilities.tools.governedWorkOperation, 'pai_action_run');
    console.log('✓ MCP discover surfaces governedWorkOperation: pai_action_run');

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 9: REQUIRED REAL MULTI-CALL CANARY (via pai_action_run)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── SECTION 9: 5-CALL PERSISTENCE CANARY (via pai_action_run) ──');

    // CALL 1: OPEN
    const openRes = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-call-1-open',
        intent: 'TERMINAL_COMMAND',
        objective: 'OPEN persistent terminal session',
        effect_class: 'CANDIDATE_DRAFT',
        scope: 'DISPOSABLE_CANARY_WORKSPACE',
        action_payload: {
          operation: 'OPEN'
        }
      }
    });

    console.log('openRes.body:', JSON.stringify(openRes.body, null, 2));
    assert.ok(!openRes.body.error, `Call 1 error: ${JSON.stringify(openRes.body.error)}`);
    const openData = openRes.body.result.structuredContent.result;
    const sessionId = openData.session_id;
    const sessionPid = openData.pid;

    assert.ok(sessionId.startsWith('pts_'), 'session_id must start with pts_');
    assert.ok(sessionPid > 0, 'PowerShell PID must be valid');
    assert.equal(openData.host, 'HOME');
    assert.equal(openData.terminal_mode, 'POWERSHELL_PERSISTENT_PIPE_V0');
    assert.equal(openData.state, 'IDLE');
    assert.ok(openData.output_ref.startsWith('pai-terminal-output://'), 'output_ref must be opaque');
    assert.ok(!openData.output_ref.includes(':\\'), 'output_ref must not reveal physical filesystem path');

    console.log(`✓ CALL 1 (OPEN): session_id=${sessionId}, pid=${sessionPid}, host=${openData.host}`);

    // CALL 2: INPUT (Set-Location, $env, $x, A-DONE)
    const safeTempDir = os.tmpdir();
    const inputScript1 = [
      `Set-Location -Path '${safeTempDir.replace(/'/g, "''")}'`,
      `$env:PAI_TERMINAL_CANARY = "persist-ok"`,
      `$x = 41`,
      `Write-Output "A-DONE"`
    ].join('\r\n');

    const inputRes1 = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-call-2-input',
        intent: 'TERMINAL_COMMAND',
        objective: 'Set persistent canary state',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: inputScript1
        }
      }
    });

    assert.ok(!inputRes1.body.error, `Call 2 error: ${JSON.stringify(inputRes1.body.error)}`);
    const input1Data = inputRes1.body.result.structuredContent.result;
    assert.equal(input1Data.session_id, sessionId, 'session_id must match');
    assert.equal(input1Data.pid, sessionPid, 'PID must remain the same');
    assert.equal(input1Data.status, 'SUCCESS');
    console.log(`✓ CALL 2 (INPUT): script sent to SAME PID ${sessionPid}, cursor=${input1Data.cursor} -> nextCursor=${input1Data.nextCursor}`);

    // CALL 3: READ using cursor
    const readRes1 = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-call-3-read',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read output from cursor',
        effect_class: 'READ_ONLY',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: input1Data.cursor
        }
      }
    });

    assert.ok(!readRes1.body.error, `Call 3 error: ${JSON.stringify(readRes1.body.error)}`);
    const read1Data = readRes1.body.result.structuredContent.result;
    assert.ok(read1Data.text.includes('A-DONE'), `Expected 'A-DONE' in output, got: ${read1Data.text}`);
    console.log(`✓ CALL 3 (READ): returned 'A-DONE' cleanly at cursor ${read1Data.cursor}`);

    // CALL 4: INPUT on SAME session_id (Verify Location, Env, $x + 1)
    const inputScript2 = [
      `Write-Output (Get-Location).Path`,
      `Write-Output $env:PAI_TERMINAL_CANARY`,
      `Write-Output ($x + 1)`
    ].join('\r\n');

    const inputRes2 = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-call-4-input',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read back persistent state',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: inputScript2
        }
      }
    });

    assert.ok(!inputRes2.body.error, `Call 4 error: ${JSON.stringify(inputRes2.body.error)}`);
    const input2Data = inputRes2.body.result.structuredContent.result;
    assert.equal(input2Data.session_id, sessionId, 'session_id must match');
    assert.equal(input2Data.pid, sessionPid, 'PID must remain the SAME across calls');
    console.log(`✓ CALL 4 (INPUT): readback script sent to SAME PID ${sessionPid}`);

    // CALL 5: READ
    const readRes2 = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-call-5-read',
        intent: 'TERMINAL_COMMAND',
        objective: 'Verify persistent output values',
        effect_class: 'READ_ONLY',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: input2Data.cursor
        }
      }
    });

    assert.ok(!readRes2.body.error, `Call 5 error: ${JSON.stringify(readRes2.body.error)}`);
    const read2Data = readRes2.body.result.structuredContent.result;
    const text2 = read2Data.text;

    // Proof checks:
    assert.ok(text2.includes('persist-ok'), `Expected 'persist-ok', got:\n${text2}`);
    assert.ok(text2.includes('42'), `Expected '42', got:\n${text2}`);
    assert.ok(text2.toLowerCase().includes(safeTempDir.toLowerCase()), `Expected cwd '${safeTempDir}', got:\n${text2}`);

    console.log('✓ CALL 5 (READ) ACCEPTANCE VERIFIED:');
    console.log(`    - Same session_id: ${sessionId}`);
    console.log(`    - Same PowerShell PID: ${sessionPid}`);
    console.log(`    - Same persistent cwd: verified`);
    console.log(`    - Persistent env variable: persist-ok`);
    console.log(`    - Persistent PowerShell variable ($x + 1): 42`);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 10: OUTPUT PRESSURE + UNICODE CANARY
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── SECTION 10: OUTPUT PRESSURE + UNICODE CANARY ──');

    const pressureScript = [
      `for ($i = 1; $i -le 2000; $i++) {`,
      `  Write-Output "Dòng $($i) - Thử nghiệm tiếng Việt có dấu, UTF-8 chuẩn xác 100%!"`,
      `}`,
      `Write-Output "PRESSURE_TEST_COMPLETED"`
    ].join('\r\n');

    const pressureInput = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-pressure-input',
        intent: 'TERMINAL_COMMAND',
        objective: 'Run output pressure with Unicode',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: pressureScript,
          timeout_seconds: 60
        }
      }
    });

    assert.ok(!pressureInput.body.error);
    const pData = pressureInput.body.result.structuredContent.result;
    console.log('pData:', pData);
    assert.equal(pData.status, 'SUCCESS');
    assert.ok(pData.nextCursor > pData.cursor + 50000, 'Expected >50KB admitted');
    console.log(`✓ 2,000 lines generated: total admitted bytes = ${pData.nextCursor}`);

    // Read in bounded pages with maxLines and maxBytes
    const pRead1 = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-pressure-read-1',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read first page',
        effect_class: 'READ_ONLY',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: pData.cursor,
          max_lines: 5,
          max_bytes: 4096
        }
      }
    });

    const pRead1Data = pRead1.body.result.structuredContent.result;
    assert.ok(pRead1Data.text.includes('Dòng 1 - Thử nghiệm tiếng Việt'), 'Unicode line 1 present');
    assert.equal(pRead1Data.truncated, true, 'Page must be marked truncated');
    assert.ok(pRead1Data.nextCursor > pRead1Data.cursor, 'nextCursor must advance');

    // Sequential read: line 6 must follow line 5, no skips, no duplicates
    const pRead2 = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-pressure-read-2',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read second page',
        effect_class: 'READ_ONLY',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: pRead1Data.nextCursor,
          max_lines: 5,
          max_bytes: 4096
        }
      }
    });

    const pRead2Data = pRead2.body.result.structuredContent.result;
    assert.ok(pRead2Data.text.includes('Dòng 6 - Thử nghiệm tiếng Việt'), 'Unicode line 6 present without skip');
    assert.ok(!pRead2Data.text.includes('Dòng 5 -'), 'Line 5 must not be duplicated');

    // Tail read
    const tailRead = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-pressure-tail',
        intent: 'TERMINAL_COMMAND',
        objective: 'Tail read',
        effect_class: 'READ_ONLY',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          tail: true,
          max_lines: 10,
          max_bytes: 2048
        }
      }
    });

    const tailData = tailRead.body.result.structuredContent.result;
    assert.ok(tailData.text.includes('PRESSURE_TEST_COMPLETED'), 'Tail read must include final completion line');
    console.log('✓ Output pressure & Unicode verified: bounded memory, raw byte cursor, no skips, no duplicates');

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 11: NEGATIVE CANARY
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── SECTION 11: NEGATIVE CANARY ──');

    // 1. Wrong session_id
    const wrongSession = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-neg-wrong-session',
        intent: 'TERMINAL_COMMAND',
        objective: 'Wrong session test',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: 'pts_invalid_fake_session',
          input: 'Write-Output 1'
        }
      }
    });
    assert.ok(wrongSession.body.error || (wrongSession.body.result && wrongSession.body.result.isError), 'Wrong session must fail');
    console.log('✓ Wrong session_id rejected');

    // 2. Operation outside admitted effect / deny list
    const denyOp = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-neg-deny-cmd',
        intent: 'TERMINAL_COMMAND',
        objective: 'Deny test',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: 'Get-Credential'
        }
      }
    });
    assert.ok(denyOp.body.error, 'Deny-list command must be rejected');
    console.log('✓ Denied command (Get-Credential) rejected');

    // 3. Stale fence rejection
    const staleFence = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-neg-stale-fence',
        intent: 'TERMINAL_COMMAND',
        objective: 'Stale fence test',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          fence_ref: 'STALE_OLD_FENCE_EPOCH_0',
          input: 'Write-Output 1'
        }
      }
    });
    assert.ok(staleFence.body.error, 'Stale fence must be rejected');
    console.log('✓ Stale fence rejected');

    // 4. Authority readback unavailable / 503 -> BLOCKED
    // Temporarily corrupt truth to simulate unavailable authority readback
    fs.writeFileSync(canaryTruthPath, JSON.stringify({ status: 'DEGRADED', available: false }), 'utf8');
    const authBlocked = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-neg-auth-blocked',
        intent: 'TERMINAL_COMMAND',
        objective: 'Authority unavailable test',
        effect_class: 'NO_MATERIAL_DELTA',
        action_payload: {
          operation: 'OPEN'
        }
      }
    });
    const authBlockedData = authBlocked.body.result.structuredContent.result;
    assert.equal(authBlockedData.status, 'BLOCKED', 'Authority unavailable must return BLOCKED');
    assert.equal(authBlockedData.blocker, 'CURRENT_FENCE_OR_AUTHORITY_READBACK_UNAVAILABLE');
    console.log('✓ Authority unavailable/503 returns STATUS=BLOCKED and BLOCKER=CURRENT_FENCE_OR_AUTHORITY_READBACK_UNAVAILABLE');

    // Restore valid truth
    fs.writeFileSync(canaryTruthPath, JSON.stringify(validTruth), 'utf8');

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 12: CLOSE CANARY
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── SECTION 12: CLOSE CANARY ──');

    const closeRes1 = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-close-1',
        intent: 'TERMINAL_COMMAND',
        objective: 'Close terminal session',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'CLOSE',
          session_id: sessionId
        }
      }
    });

    assert.ok(!closeRes1.body.error);
    const close1Data = closeRes1.body.result.structuredContent.result;
    assert.equal(close1Data.state, 'CLOSED');
    assert.equal(close1Data.cleanup.verified, true);
    assert.equal(close1Data.cleanup.mechanism, 'TASKKILL_TREE_V0');
    console.log(`✓ CLOSE verified: state=${close1Data.state}, mechanism=${close1Data.cleanup.mechanism}, verified=${close1Data.cleanup.verified}`);

    // Input after close -> rejected
    const afterCloseInput = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-neg-after-close',
        intent: 'TERMINAL_COMMAND',
        objective: 'Input on closed session',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: 'Write-Output "FAIL"'
        }
      }
    });
    assert.ok(afterCloseInput.body.error, 'Input on closed session must be rejected');
    console.log('✓ Closed session input rejected');

    // Second CLOSE: idempotent
    const closeRes2 = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-close-2',
        intent: 'TERMINAL_COMMAND',
        objective: 'Close session second time',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'CLOSE',
          session_id: sessionId
        }
      }
    });
    assert.ok(!closeRes2.body.error);
    const close2Data = closeRes2.body.result.structuredContent.result;
    assert.equal(close2Data.state, 'CLOSED');
    assert.equal(close2Data.idempotent, true);
    console.log('✓ Second CLOSE idempotent verified');

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 13: ONE-SHOT REGRESSION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── SECTION 13: ONE-SHOT REGRESSION ──');

    const oneShotRes = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-oneshot-hostname',
        intent: 'HOST_INSPECT',
        objective: 'hostname',
        effect_class: 'NO_MATERIAL_DELTA'
      }
    });

    assert.ok(!oneShotRes.body.error);
    const oneShotData = oneShotRes.body.result.structuredContent.result;
    assert.equal(oneShotData.chief_state, 'ADMITTED');
    assert.equal(oneShotData.lifecycle_state, 'COMPLETED');
    assert.equal(oneShotData.host_control_receipt.status, 'SUCCESS');
    assert.equal(oneShotData.host_control_receipt.exit_code, 0);
    assert.ok(oneShotData.host_control_receipt.key_output.length > 0);
    console.log(`✓ Golden one-shot Host Control PASS: hostname=${oneShotData.host_control_receipt.key_output.trim()}`);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 14: NEGATIVE - DIRECT pai_terminal_session TOOL DENIED
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── SECTION 14: NEGATIVE - DIRECT pai_terminal_session TOOL DENIED ──');

    const directCall = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_terminal_session',
      arguments: {
        operation: 'OPEN'
      }
    });
    assert.ok(directCall.body.error, 'Direct pai_terminal_session must be denied');
    assert.equal(directCall.body.error.data?.code, 'BRIDGE_TOOL_DENIED', 'Error code must be BRIDGE_TOOL_DENIED');
    console.log('✓ Direct pai_terminal_session tool call correctly DENIED with BRIDGE_TOOL_DENIED');

    // Effect ceiling check via pai_action_run
    const ceilOpen = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-ceil-open',
        intent: 'TERMINAL_COMMAND',
        objective: 'Open class A session',
        effect_class: 'NO_MATERIAL_DELTA',
        action_payload: {
          operation: 'OPEN'
        }
      }
    });
    assert.ok(!ceilOpen.body.error);
    const ceilSessionId = ceilOpen.body.result.structuredContent.result.session_id;

    const ceilDeny = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-ceil-deny',
        intent: 'TERMINAL_COMMAND',
        objective: 'Attempt class B input on class A session',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: ceilSessionId,
          input: 'Write-Output 1'
        }
      }
    });
    assert.ok(ceilDeny.body.error);
    assert.ok(ceilDeny.body.error.data?.code.includes('SESSION_EFFECT_CEILING_EXCEEDED'), 'Must reject effect ceiling upgrade');
    console.log('✓ Effect ceiling upgrade on persistent session rejected');

    await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-ceil-close',
        intent: 'TERMINAL_COMMAND',
        objective: 'Close ceiling session',
        effect_class: 'NO_MATERIAL_DELTA',
        action_payload: {
          operation: 'CLOSE',
          session_id: ceilSessionId
        }
      }
    });

    // Idempotency: exact replay succeeds with IDEMPOTENT_REPLAY
    const replayCall = await makeRpcCall(8799, 'tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'canary-ceil-open',
        intent: 'TERMINAL_COMMAND',
        objective: 'Open class A session',
        effect_class: 'NO_MATERIAL_DELTA',
        action_payload: {
          operation: 'OPEN'
        }
      }
    });
    assert.ok(!replayCall.body.error);
    assert.equal(replayCall.body.result.structuredContent.result.admission_state, 'IDEMPOTENT_REPLAY');
    console.log('✓ Per-request_id idempotency replay verified');

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  STATUS: V0_CANARY_PASS  ');
    console.log('  ALL ACCEPTANCE CRITERIA VERIFIED ACROSS REAL WIRE  ');
    console.log('═══════════════════════════════════════════════════════════════');

  } finally {
    server.close();
    app.db.close();
    try { fs.rmSync(canaryDbDir, { recursive: true, force: true }); } catch (_) {}
  }
}

runCanary().catch(err => {
  console.error('CANARY FAILED:', err);
  process.exit(1);
});
