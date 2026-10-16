'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createServer } = require('../src/server');

async function runP0AcceptanceSuite() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  P0 DIRECT DEVELOPER HOST CONTROL REPAIR ACCEPTANCE SUITE    ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Setup isolated test environment
  const testDbDir = path.join(os.tmpdir(), `pai_p0_test_${Date.now()}`);
  fs.mkdirSync(testDbDir, { recursive: true });
  const testDbPath = path.join(testDbDir, 'chief-test.sqlite');
  const testTruthPath = path.join(testDbDir, 'truth.json');
  const testTaskBoxRoot = path.join(testDbDir, 'taskbox');
  fs.mkdirSync(path.join(testTaskBoxRoot, 'items'), { recursive: true });

  const validTruth = {
    scope: 'PROJECT / PAI',
    status: 'VERIFIED',
    available: true,
    goal: 'P0 Developer Host Control Verification',
    acceptedState: 'RESULT_VERIFIED_CANDIDATE',
    lifecycleStage: 'RESULT_VERIFIED',
    completionEvidenceVerified: true,
    runningEvidenceVerified: false,
    evidence: ['P0_DEVELOPER_HOST_CONTROL_TEST'],
    nextAction: 'VERIFY_CANDIDATE_ADMISSION',
    fenceRef: 'FENCE_2026_P0_VALID'
  };
  fs.writeFileSync(testTruthPath, JSON.stringify(validTruth), 'utf8');

  process.env.CHIEF_BRIDGE_DB_PATH = testDbPath;
  process.env.CHIEF_CANONICAL_TRUTH_PATH = testTruthPath;
  process.env.CHIEF_TASK_BOX_ROOT = testTaskBoxRoot;
  process.env.PAI_GATEWAY_CANARY = '1';
  process.env.PORT = '8797';

  const app = createServer({ env: process.env });
  const server = app.server;
  await new Promise(resolve => server.listen(8797, '127.0.0.1', resolve));

  async function callRpc(method, params = {}) {
    const res = await fetch('http://127.0.0.1:8797/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        method,
        params
      })
    });
    return await res.json();
  }

  const scratchDir = path.resolve(__dirname, '..', 'scratch');
  fs.mkdirSync(scratchDir, { recursive: true });

  try {
    // ── Check 1: P0-A Admitted HOST_CONTROL_CANDIDATE Terminal Session ──
    console.log('── Check 1: Open HOST_CONTROL_CANDIDATE developer terminal session ──');
    const openRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-1-open-candidate',
        intent: 'TERMINAL_COMMAND',
        objective: 'Open candidate developer terminal session',
        effect_class: 'CANDIDATE_DRAFT',
        scope: scratchDir,
        authority_policy_ref: '1sfyJ8E4Ffcv3hzz_aAB5X1WkWLlzS3Y4',
        action_payload: {
          operation: 'OPEN'
        }
      }
    });

    assert.ok(!openRes.error, `Check 1 error: ${JSON.stringify(openRes.error)}`);
    const openData = openRes.result.structuredContent.result;
    assert.equal(openData.chief_state, 'ADMITTED', 'chief_state must be ADMITTED');
    assert.equal(openData.admission_state, 'HOST_CONTROL_CANDIDATE', 'admission_state must be HOST_CONTROL_CANDIDATE');
    assert.equal(openData.host, 'HOME', 'host must be HOME');
    const sessionId = openData.session_id;
    assert.ok(sessionId.startsWith('pts_'), 'session_id must be valid pts_ identifier');
    console.log(`✓ Check 1 PASSED: Admitted HOST_CONTROL_CANDIDATE session ${sessionId} under Engineering Change authority`);

    // ── Check 2: P0-A Read normal source bodies with Get-Content ──
    console.log('\n── Check 2: Read source bodies with Get-Content in candidate session ──');
    const targetSourceFile = path.resolve(__dirname, '..', 'src', 'executor-router.js');
    const readInputRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-2-get-content',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read canonical source body',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `Get-Content -Path '${targetSourceFile.replace(/'/g, "''")}' -TotalCount 10`
        }
      }
    });

    assert.ok(!readInputRes.error, `Check 2 input error: ${JSON.stringify(readInputRes.error)}`);
    const readInputData = readInputRes.result.structuredContent.result;
    assert.equal(readInputData.status, 'SUCCESS');

    // Read back output
    const readBackRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-2-readback',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read back terminal output',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: readInputData.cursor
        }
      }
    });

    assert.ok(!readBackRes.error, `Check 2 readback error: ${JSON.stringify(readBackRes.error)}`);
    const readBackData = readBackRes.result.structuredContent.result;
    assert.ok(readBackData.text.includes('HOST_CONTROL_AUTHORITY_POLICY') || readBackData.text.includes('ExecutorRouter'), 'Source body must be readable');
    console.log('✓ Check 2 PASSED: Normal source bodies readable with Get-Content in candidate session');

    // ── Check 3: P0-A Create and edit candidate files inside mutable scope ──
    console.log('\n── Check 3: Create and edit candidate file inside scratch scope ──');
    const candidateFile = path.join(scratchDir, `candidate_${Date.now()}.txt`);
    const createRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-3-create-file',
        intent: 'TERMINAL_COMMAND',
        objective: 'Create candidate file in mutable scratch',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `Set-Content -Path '${candidateFile.replace(/'/g, "''")}' -Value "CANDIDATE_PAYLOAD_V1"\r\nGet-Content -Path '${candidateFile.replace(/'/g, "''")}'`
        }
      }
    });

    assert.ok(!createRes.error, `Check 3 create error: ${JSON.stringify(createRes.error)}`);
    const createData = createRes.result.structuredContent.result;

    const readCreateRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-3-read-create',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read back created candidate file',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: createData.cursor
        }
      }
    });

    const readCreateData = readCreateRes.result.structuredContent.result;
    assert.ok(readCreateData.text.includes('CANDIDATE_PAYLOAD_V1'), 'Candidate file content must match created value');
    assert.ok(fs.existsSync(candidateFile), 'Candidate file must exist on disk in scratch scope');
    console.log('✓ Check 3 PASSED: Candidate file created, edited, and read within scratch scope');

    // Clean up test file
    try { fs.unlinkSync(candidateFile); } catch (_) {}

    // ── Check 4: P0-A Run local developer tooling (node -v, node --test) ──
    console.log('\n── Check 4: Run developer tooling through candidate terminal ──');
    const testToolRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-4-node-test',
        intent: 'TERMINAL_COMMAND',
        objective: 'Run developer tooling',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: 'node -e "console.log(\'DEV_TOOL_OK:\' + process.version)"'
        }
      }
    });

    assert.ok(!testToolRes.error, `Check 4 error: ${JSON.stringify(testToolRes.error)}`);
    const testToolData = testToolRes.result.structuredContent.result;

    const readToolRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-4-read-tool',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read back developer tooling output',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: testToolData.cursor
        }
      }
    });

    const readToolData = readToolRes.result.structuredContent.result;
    assert.ok(readToolData.text.includes('DEV_TOOL_OK:v'), 'Developer tooling execution output verified');
    console.log('✓ Check 4 PASSED: Local developer node execution authorized and verified');

    // ── Check 5: P0-B Hard denials remain fail-closed ──
    console.log('\n── Check 5: Verify hard denials remain fail-closed ──');

    // 5a. Out of scope write to live source
    const outOfScopeRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-5-out-of-scope',
        intent: 'FILESYSTEM_EDIT',
        objective: 'Attempt write to Golden source without admitted scope',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          command: 'Set-Content -Path "C:\\Users\\Tom\\My Drive\\PAI_PROJECT\\CORE\\chief_chat_bridge_v1\\src\\server.js" -Value "HACK"',
          target_path: 'C:\\Users\\Tom\\My Drive\\PAI_PROJECT\\CORE\\chief_chat_bridge_v1\\src\\server.js'
        }
      }
    });
    const outData = outOfScopeRes.result?.structuredContent?.result;
    if (!outData) console.error('outOfScopeRes DEBUG:', JSON.stringify(outOfScopeRes, null, 2));
    assert.ok(outData, 'Out-of-scope write must return structured governed result');
    assert.equal(outData.status, 'DENIED');
    assert.equal(outData.denial_code, 'HOST_CONTROL_SCOPE_DENIED');
    console.log('✓ 5a: Out-of-scope Golden source write returned governed denial (HOST_CONTROL_SCOPE_DENIED)');

    // 5b. Credential dump
    const credRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-5-credential',
        intent: 'TERMINAL_COMMAND',
        objective: 'Extract credentials',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: 'Get-Credential'
        }
      }
    });
    const credData = credRes.result?.structuredContent?.result;
    assert.ok(credData, 'Credential command must return structured governed result');
    assert.equal(credData.status, 'DENIED');
    assert.equal(credData.denial_code, 'HOST_CONTROL_DENIED');
    console.log('✓ 5b: Credential command returned governed denial (HOST_CONTROL_DENIED)');

    // 5c. Consequential action
    const consRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-5-consequential',
        intent: 'TERMINAL_COMMAND',
        objective: 'Format volume',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: 'format C:'
        }
      }
    });
    const consData = consRes.result?.structuredContent?.result;
    assert.ok(consData, 'Consequential command must return structured governed result');
    assert.equal(consData.status, 'DENIED');
    assert.ok(
      consData.denial_code === 'HOST_CONTROL_CONSEQUENTIAL_GATE' || consData.denial_code === 'HOST_CONTROL_DENIED',
      `Expected denial_code to be HOST_CONTROL_CONSEQUENTIAL_GATE or HOST_CONTROL_DENIED, got ${consData.denial_code}`
    );
    console.log(`✓ 5c: Consequential command returned governed denial (${consData.denial_code})`);

    // 5d. In-session out-of-scope write attempt (actual ChatGPT negative gate canary)
    const forbiddenTarget = path.resolve(__dirname, '..', 'src', 'chatgpt_should_not_write.tmp');
    if (fs.existsSync(forbiddenTarget)) fs.unlinkSync(forbiddenTarget);

    const inSessionOutOfScopeRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-5-in-session-out-of-scope',
        intent: 'TERMINAL_COMMAND',
        objective: 'Attempt out-of-scope write to src directory from candidate session',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: "'SHOULD_NOT_WRITE' | Set-Content '..\\src\\chatgpt_should_not_write.tmp'"
        }
      }
    });
    const inSessionData = inSessionOutOfScopeRes.result?.structuredContent?.result;
    assert.ok(inSessionData, 'In-session out-of-scope write must return structured governed result');
    assert.equal(inSessionData.status, 'DENIED');
    assert.equal(inSessionData.denial_code, 'HOST_CONTROL_SCOPE_DENIED');
    assert.equal(fs.existsSync(forbiddenTarget), false, 'Forbidden target file must NEVER be created');
    console.log('✓ 5d: In-session out-of-scope write pre-authorized and denied fail-closed (HOST_CONTROL_SCOPE_DENIED, no file created)');

    // 5e. P0.2 Denial Survivability: same session remains usable after denial
    const surviveRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-5-survive-after-denial',
        intent: 'TERMINAL_COMMAND',
        objective: 'Verify session survived denial and executes allowed command',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: 'node -e "console.log(\'SURVIVED_DENIAL_P02_OK\')"'
        }
      }
    });
    const surviveData = surviveRes.result?.structuredContent?.result;
    assert.ok(surviveData, 'Session must remain usable after denial');
    assert.equal(surviveData.status, 'SUCCESS');

    // Read back output from surviving session
    const surviveReadRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-5-survive-read',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read back surviving session output',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: surviveData.cursor
        }
      }
    });
    const surviveReadData = surviveReadRes.result?.structuredContent?.result;
    assert.ok(surviveReadData.text.includes('SURVIVED_DENIAL_P02_OK'), 'Output must verify successful execution after denial');
    console.log('✓ 5e: P0.2 Denial survivability verified: candidate session executed allowed command cleanly after denial');

    // Close candidate session
    await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-close',
        intent: 'TERMINAL_COMMAND',
        objective: 'Close session',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: { operation: 'CLOSE', session_id: sessionId }
      }
    });

    // ── Check 6: P0-D Real CLI Fallback Transport (ANTIGRAVITY_CLI) ──
    // ── Check 6: P0.4 Real CLI Fallback Transport (ANTIGRAVITY_CLI mock) ──
    console.log('\n── Check 6: DIRECT_CLI_TRANSPORT fallback bypassing TaskBox ──');
    const mockCli = path.join(scratchDir, 'mock-anti-cli.js');
    const mockArtifact = path.join(scratchDir, 'anti_cli_canary.txt');
    fs.writeFileSync(mockCli, [
      "const fs=require('fs');",
      "const out=process.argv[process.argv.indexOf('--out')+1];",
      "fs.writeFileSync(out,'provider=ANTIGRAVITY_CLI\\nMOCK_OK\\n');",
      "console.log('MOCK_ANTI_OK');"
    ].join('\n'), 'utf8');

    const cliRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'p0-call-6-antigravity-cli',
        intent: 'BUILD',
        objective: 'Build candidate component directly via Antigravity CLI fallback',
        effect_class: 'CANDIDATE_DRAFT',
        scope: 'NONE',
        selected_provider_tool: 'ANTIGRAVITY_CLI',
        requested_mode: 'DIRECT_CLI_TRANSPORT',
        bypass_taskbox: true,
        action_payload: {
          cli_path_override: process.execPath,
          cli_args: [mockCli, '--out', mockArtifact],
          expected_artifact_path: mockArtifact,
          cli_cwd: scratchDir,
          cli_timeout_ms: 30000
        }
      }
    });

    assert.ok(!cliRes.error, `Check 6 error: ${JSON.stringify(cliRes.error)}`);
    const cliData = cliRes.result.structuredContent.result;
    assert.equal(cliData.contract_type, 'HEAVY_ACTION_RESULT');
    assert.equal(cliData.status, 'PASS');
    assert.equal(cliData.lifecycle_state, 'COMPLETED', 'lifecycle_state must be COMPLETED (not READY)');
    assert.equal(cliData.receipt.source_provider, 'DIRECT_CLI_TRANSPORT');
    const resultRef = cliData.receipt.evidence_refs.find(ref => ref.startsWith('pai_result:'));
    assert.ok(resultRef, 'result reference must be assigned');
    const taskId = resultRef.slice('pai_result:'.length);
    assert.ok(fs.existsSync(mockArtifact), 'mock artifact must exist on disk');
    assert.match(fs.readFileSync(mockArtifact, 'utf8'), /MOCK_OK/);

    // Verify TaskBox file was NOT created (TaskBox bypassed as required)
    const taskBoxFile = path.join(testTaskBoxRoot, 'items', `${taskId}.md`);
    assert.ok(!fs.existsSync(taskBoxFile), 'TaskBox item must NOT be created when bypassing TaskBox via DIRECT_CLI_TRANSPORT');

    // Readback via pai_result
    const resultRes = await callRpc('tools/call', {
      name: 'pai_result',
      arguments: {
        run_id: taskId
      }
    });
    assert.ok(!resultRes.error, `pai_result readback error: ${JSON.stringify(resultRes.error)}`);
    const readbackResult = resultRes.result.structuredContent.result;
    assert.equal(readbackResult.status, 'COMPLETED', 'pai_result must report status COMPLETED');
    assert.equal(readbackResult.executor, 'ANTIGRAVITY_CLI', 'pai_result must report ANTIGRAVITY_CLI');
    console.log('✓ Check 6 PASSED: DIRECT_CLI_TRANSPORT real child, TaskBox bypassed, reconciled via pai_result');

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  ALL P0 DIRECT DEVELOPER HOST CONTROL CHECKS PASSED CLEANLY   ');
    console.log('═══════════════════════════════════════════════════════════════');
  } finally {
    server.close();
    try { fs.rmSync(testDbDir, { recursive: true, force: true }); } catch (_) {}
  }
}

runP0AcceptanceSuite().catch(err => {
  console.error('\n✖ P0 ACCEPTANCE SUITE FAILED:', err);
  process.exit(1);
});
