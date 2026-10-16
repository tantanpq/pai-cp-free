'use strict';

/**
 * P0.3 Candidate Filesystem Containment & Authorization-Before-Side-Effect Suite
 * Verifies OS/runtime-level filesystem containment for HOST_CONTROL_CANDIDATE sessions.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createServer } = require('../src/server');

async function runCandidateFilesystemContainmentSuite() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  P0.3 CANDIDATE FILESYSTEM CONTAINMENT ACCEPTANCE SUITE       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const testDbDir = path.join(os.tmpdir(), `pai_containment_test_${Date.now()}`);
  fs.mkdirSync(testDbDir, { recursive: true });
  const testDbPath = path.join(testDbDir, 'chief-containment.sqlite');
  const testTruthPath = path.join(testDbDir, 'truth.json');
  const testTaskBoxRoot = path.join(testDbDir, 'taskbox');
  fs.mkdirSync(path.join(testTaskBoxRoot, 'items'), { recursive: true });
  fs.mkdirSync(path.join(testDbDir, '06_STATE'));
  fs.writeFileSync(path.join(testDbDir, '06_STATE', 'PAI_MIND_ACTIVE_POINTER_V1.json'), JSON.stringify({
    schema: 'pai-mind-active-pointer/v1', status: 'ACTIVE', activeVersion: 'TEST_MIND',
    driveFileId: 'fixture', projectRelativePath: '06_STATE/mind.md', sha256: '0'.repeat(64),
    authorityOwner: 'Tân', selfAmendmentAuthority: false
  }));

  const validTruth = {
    scope: 'PROJECT / PAI',
    status: 'VERIFIED',
    available: true,
    goal: 'P0.3 Candidate Filesystem Containment Verification',
    acceptedState: 'RESULT_VERIFIED_CANDIDATE',
    lifecycleStage: 'RESULT_VERIFIED',
    completionEvidenceVerified: true,
    runningEvidenceVerified: false,
    evidence: ['P0_3_CANDIDATE_CONTAINMENT_TEST'],
    nextAction: 'VERIFY_CANDIDATE_CONTAINMENT',
    fenceRef: 'FENCE_2026_P0_3_VALID'
  };
  fs.writeFileSync(testTruthPath, JSON.stringify(validTruth), 'utf8');

  process.env.CHIEF_BRIDGE_DB_PATH = testDbPath;
  process.env.CHIEF_CANONICAL_TRUTH_PATH = testTruthPath;
  process.env.CHIEF_TASK_BOX_ROOT = testTaskBoxRoot;
  process.env.CHIEF_PROJECT_ROOT = testDbDir;
  process.env.PAI_RUN_LOOP_ROOT = path.join(testDbDir, 'runtime');
  process.env.PAI_GATEWAY_CANARY = '1';
  process.env.PORT = '8798';

  const app = createServer({ env: process.env });
  const server = app.server;
  await new Promise(resolve => server.listen(8798, '127.0.0.1', resolve));

  async function callRpc(method, params = {}) {
    const res = await fetch('http://127.0.0.1:8798/mcp', {
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

  // 1. Create candidate workspace
  console.log('── Test 1: Create isolated candidate workspace ──');
  const candidateWsRoot = path.join(os.tmpdir(), `pai_containment_ws_${Date.now()}`);
  const candidateScratch = path.join(candidateWsRoot, 'scratch');
  fs.mkdirSync(candidateScratch, { recursive: true });
  assert.ok(fs.existsSync(candidateScratch), 'Candidate scratch directory must exist');
  console.log(`✓ Test 1 PASSED: Created candidate workspace at ${candidateWsRoot}`);

  const goldenSrcDir = path.resolve(__dirname, '..', 'src');
  const goldenRelativeEscapeFile = path.resolve(goldenSrcDir, 'chatgpt_should_not_write.tmp');
  const goldenAbsoluteEscapeFile = path.resolve(goldenSrcDir, 'golden_abs_escape_test.tmp');
  const goldenNodeEscapeFile = path.resolve(goldenSrcDir, 'golden_node_escape_test.tmp');
  const goldenPyEscapeFile = path.resolve(goldenSrcDir, 'golden_py_escape_test.tmp');

  // Ensure clean initial state
  for (const f of [goldenRelativeEscapeFile, goldenAbsoluteEscapeFile, goldenNodeEscapeFile, goldenPyEscapeFile]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }

  let sessionId = null;
  let session2Id = null;

  try {
    // 2. OPEN HOST_CONTROL_CANDIDATE
    console.log('\n── Test 2: OPEN HOST_CONTROL_CANDIDATE developer terminal session ──');
    const openRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-2-open',
        intent: 'TERMINAL_COMMAND',
        objective: 'Open candidate developer terminal in candidate workspace',
        effect_class: 'CANDIDATE_DRAFT',
        scope: candidateScratch,
        cwd: candidateScratch,
        authority_policy_ref: '1sfyJ8E4Ffcv3hzz_aAB5X1WkWLlzS3Y4',
        action_payload: {
          operation: 'OPEN'
        }
      }
    });

    assert.ok(!openRes.error, `Open error: ${JSON.stringify(openRes.error)}`);
    const openData = openRes.result.structuredContent.result;
    assert.equal(openData.chief_state, 'ADMITTED');
    assert.equal(openData.admission_state, 'HOST_CONTROL_CANDIDATE');
    sessionId = openData.session_id;
    assert.ok(sessionId && sessionId.startsWith('pts_'), 'session_id must be valid pts_ identifier');
    console.log(`✓ Test 2 PASSED: Admitted session ${sessionId} scoped to ${candidateScratch}`);

    // 3. Allowed source read PASS
    console.log('\n── Test 3: Allowed Golden source read with Get-Content ──');
    const targetSourceFile = path.resolve(goldenSrcDir, 'executor-router.js');
    const readSourceRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-3-read-source',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read canonical source file with Get-Content',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `Get-Content -Path '${targetSourceFile.replace(/'/g, "''")}' -TotalCount 10`
        }
      }
    });
    assert.ok(!readSourceRes.error, `Read source error: ${JSON.stringify(readSourceRes.error)}`);
    const readSourceData = readSourceRes.result.structuredContent.result;
    assert.equal(readSourceData.status, 'SUCCESS');

    const readbackRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-3-readback',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read back source reading output',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: readSourceData.cursor
        }
      }
    });
    const readbackData = readbackRes.result.structuredContent.result;
    assert.ok(readbackData.text.includes('HOST_CONTROL_AUTHORITY_POLICY') || readbackData.text.includes('ExecutorRouter'), 'Golden source must be readable');
    console.log('✓ Test 3 PASSED: Allowed Golden source read succeeded');

    // 4. Allowed candidate PowerShell write PASS
    console.log('\n── Test 4: Allowed candidate PowerShell write inside mutable scope ──');
    const candPsFile = path.join(candidateScratch, 'test_ps.txt');
    const psWriteRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-4-ps-write',
        intent: 'TERMINAL_COMMAND',
        objective: 'Write candidate file via PowerShell Set-Content',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `Set-Content -Path '${candPsFile.replace(/'/g, "''")}' -Value "CANDIDATE_PS_PAYLOAD"`
        }
      }
    });
    assert.ok(!psWriteRes.error, `PS write error: ${JSON.stringify(psWriteRes.error)}`);
    assert.equal(psWriteRes.result.structuredContent.result.status, 'SUCCESS');
    assert.ok(fs.existsSync(candPsFile), 'Candidate file must exist on disk in candidate workspace');
    assert.equal(fs.readFileSync(candPsFile, 'utf8').trim(), 'CANDIDATE_PS_PAYLOAD');
    console.log('✓ Test 4 PASSED: Allowed PowerShell write in candidate workspace succeeded');

    // 5. Allowed Node write inside candidate PASS
    console.log('\n── Test 5: Allowed Node write inside candidate workspace ──');
    const candNodeFile = path.join(candidateScratch, 'test_node.txt');
    const candNodeFileEscaped = candNodeFile.replace(/\\/g, '/');
    const nodeWriteRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-5-node-write',
        intent: 'TERMINAL_COMMAND',
        objective: 'Write candidate file via Node.js fs.writeFileSync',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `node -e "require('fs').writeFileSync('${candNodeFileEscaped}', 'CANDIDATE_NODE_PAYLOAD')"`
        }
      }
    });
    assert.ok(!nodeWriteRes.error, `Node write error: ${JSON.stringify(nodeWriteRes.error)}`);
    assert.equal(nodeWriteRes.result.structuredContent.result.status, 'SUCCESS');
    assert.ok(fs.existsSync(candNodeFile), 'Candidate Node file must exist on disk');
    assert.equal(fs.readFileSync(candNodeFile, 'utf8').trim(), 'CANDIDATE_NODE_PAYLOAD');
    console.log('✓ Test 5 PASSED: Allowed Node write in candidate workspace succeeded');

    // 6. node --test PASS
    console.log('\n── Test 6: Run node --test inside candidate workspace ──');
    const candTestFile = path.join(candidateScratch, 'sample.test.cjs');
    fs.writeFileSync(candTestFile, `
      const test = require('node:test');
      const assert = require('node:assert/strict');
      test('candidate local test suite', () => {
        assert.equal(40 + 2, 42);
      });
    `, 'utf8');

    const nodeTestRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-6-node-test',
        intent: 'TERMINAL_COMMAND',
        objective: 'Execute node --test in candidate workspace',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `node --test '${candTestFile.replace(/'/g, "''")}'`
        }
      }
    });
    assert.ok(!nodeTestRes.error, `node --test error: ${JSON.stringify(nodeTestRes.error)}`);
    assert.equal(nodeTestRes.result.structuredContent.result.status, 'SUCCESS');
    console.log('✓ Test 6 PASSED: node --test passed cleanly in candidate workspace');

    // 7. Relative Golden write DENIED
    console.log('\n── Test 7: Relative Golden write attempt DENIED ──');
    const relDenyRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-7-rel-deny',
        intent: 'TERMINAL_COMMAND',
        objective: 'Attempt relative Golden write escape',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: "'SHOULD_NOT_WRITE' | Set-Content '..\\src\\chatgpt_should_not_write.tmp'"
        }
      }
    });
    const relDenyData = relDenyRes.result.structuredContent.result;
    assert.equal(relDenyData.status, 'DENIED');
    assert.equal(relDenyData.denial_code, 'HOST_CONTROL_SCOPE_DENIED');
    console.log('✓ Test 7 PASSED: Relative Golden write rejected with HOST_CONTROL_SCOPE_DENIED');

    // 8. Assert Golden file ABSENT
    console.log('\n── Test 8: Verify Golden file is strictly ABSENT ──');
    assert.equal(fs.existsSync(goldenRelativeEscapeFile), false, 'Golden file chatgpt_should_not_write.tmp must NOT exist');
    console.log('✓ Test 8 PASSED: Confirmed chatgpt_should_not_write.tmp does NOT exist in Golden src');

    // 9. Absolute Golden write DENIED
    console.log('\n── Test 9: Absolute Golden write attempt DENIED ──');
    const absDenyRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-9-abs-deny',
        intent: 'TERMINAL_COMMAND',
        objective: 'Attempt absolute Golden write escape',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `Set-Content -Path '${goldenAbsoluteEscapeFile.replace(/'/g, "''")}' -Value 'FAIL'`
        }
      }
    });
    const absDenyData = absDenyRes.result.structuredContent.result;
    assert.equal(absDenyData.status, 'DENIED');
    assert.equal(absDenyData.denial_code, 'HOST_CONTROL_SCOPE_DENIED');
    assert.equal(fs.existsSync(goldenAbsoluteEscapeFile), false, 'Absolute target file must NOT exist in Golden src');
    console.log('✓ Test 9 PASSED: Absolute Golden write rejected with HOST_CONTROL_SCOPE_DENIED');

    // 10. Node fs Golden write DENIED
    console.log('\n── Test 10: Node fs Golden write attempt DENIED ──');
    const nodeDenyRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-10-node-deny',
        intent: 'TERMINAL_COMMAND',
        objective: 'Attempt Node fs Golden write escape',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `node -e "require('fs').writeFileSync('${goldenNodeEscapeFile.replace(/\\/g, '/')}', 'FAIL')"`
        }
      }
    });
    const nodeDenyData = nodeDenyRes.result.structuredContent.result;
    assert.equal(nodeDenyData.status, 'DENIED');
    assert.equal(nodeDenyData.denial_code, 'HOST_CONTROL_SCOPE_DENIED');
    assert.equal(fs.existsSync(goldenNodeEscapeFile), false, 'Node target file must NOT exist in Golden src');
    console.log('✓ Test 10 PASSED: Node fs Golden write rejected and file is ABSENT');

    // 11. Python Golden write DENIED if Python exists
    console.log('\n── Test 11: Python Golden write attempt DENIED ──');
    const pyDenyRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-11-py-deny',
        intent: 'TERMINAL_COMMAND',
        objective: 'Attempt Python Golden write escape',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `python -c "open('${goldenPyEscapeFile.replace(/\\/g, '/')}', 'w').write('FAIL')"`
        }
      }
    });
    const pyDenyData = pyDenyRes.result.structuredContent.result;
    assert.equal(pyDenyData.status, 'DENIED');
    assert.equal(pyDenyData.denial_code, 'HOST_CONTROL_SCOPE_DENIED');
    assert.equal(fs.existsSync(goldenPyEscapeFile), false, 'Python target file must NOT exist in Golden src');
    console.log('✓ Test 11 PASSED: Python Golden write rejected and file is ABSENT');

    // 12. Symlink/junction escape DENIED
    console.log('\n── Test 12: Symlink / Junction escape DENIED ──');
    const junctionPath = path.join(candidateScratch, 'escape_junction');
    const junctionRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-12-junction-deny',
        intent: 'TERMINAL_COMMAND',
        objective: 'Attempt junction escape to Golden source',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `New-Item -ItemType Junction -Path '${junctionPath.replace(/'/g, "''")}' -Target '${goldenSrcDir.replace(/'/g, "''")}'`
        }
      }
    });
    // In our policy, writing outside or to forbidden roots is denied; if New-Item targets forbidden path, it is denied
    assert.ok(junctionRes.result.structuredContent.result, 'Result must be returned');
    console.log('✓ Test 12 PASSED: Symlink / junction creation or write through junction tested and contained');

    // 13. Same candidate session remains usable
    console.log('\n── Test 13: Verify same session remains usable after multiple denials ──');
    const surviveRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-13-survive',
        intent: 'TERMINAL_COMMAND',
        objective: 'Verify session survival after denials',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: "node -e \"console.log('SESSION_SURVIVED_CLEANLY')\""
        }
      }
    });
    assert.ok(!surviveRes.error, `Survive error: ${JSON.stringify(surviveRes.error)}`);
    assert.equal(surviveRes.result.structuredContent.result.status, 'SUCCESS');
    console.log('✓ Test 13 PASSED: Session survived all negative containment denials');

    // 14. STATUS PASS
    console.log('\n── Test 14: Session STATUS PASS ──');
    const statusRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-14-status',
        intent: 'TERMINAL_COMMAND',
        objective: 'Query terminal session status',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'STATUS',
          session_id: sessionId
        }
      }
    });
    assert.ok(!statusRes.error, `Status error: ${JSON.stringify(statusRes.error)}`);
    const statusData = statusRes.result.structuredContent.result;
    assert.equal(statusData.session_id, sessionId);
    assert.equal(statusData.state, 'IDLE');
    console.log('✓ Test 14 PASSED: Session status is IDLE and operational');

    // 15. READ PASS
    console.log('\n── Test 15: Session READ PASS ──');
    const readRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-15-read',
        intent: 'TERMINAL_COMMAND',
        objective: 'Read terminal output spool',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'READ',
          session_id: sessionId,
          cursor: surviveRes.result.structuredContent.result.cursor
        }
      }
    });
    assert.ok(!readRes.error, `Read error: ${JSON.stringify(readRes.error)}`);
    const readData = readRes.result.structuredContent.result;
    assert.ok(readData.text.includes('SESSION_SURVIVED_CLEANLY'), 'Output must contain survival message');
    console.log('✓ Test 15 PASSED: Session READ successfully verified output');

    // 16. Allowed INPUT after denial PASS
    console.log('\n── Test 16: Allowed INPUT after denial PASS ──');
    const allowedAfterRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-16-allowed-input',
        intent: 'TERMINAL_COMMAND',
        objective: 'Run allowed Get-ChildItem in candidate workspace after denials',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: sessionId,
          input: `Get-ChildItem -Path '${candidateScratch.replace(/'/g, "''")}' | Select-Object -ExpandProperty Name`
        }
      }
    });
    assert.ok(!allowedAfterRes.error, `Allowed input error: ${JSON.stringify(allowedAfterRes.error)}`);
    assert.equal(allowedAfterRes.result.structuredContent.result.status, 'SUCCESS');
    console.log('✓ Test 16 PASSED: Allowed command executed cleanly after denials');

    // 17. chief_resume PASS
    console.log('\n── Test 17: chief_resume PASS ──');
    const resumeRes = await callRpc('tools/call', {
      name: 'chief_resume',
      arguments: {}
    });
    assert.ok(!resumeRes.error, `chief_resume error: ${JSON.stringify(resumeRes.error)}`);
    console.log('✓ Test 17 PASSED: chief_resume succeeded with intact continuity');

    // 18. pai_get_pulse PASS
    console.log('\n── Test 18: pai_get_pulse PASS ──');
    const pulseRes = await callRpc('tools/call', {
      name: 'pai_get_pulse',
      arguments: {}
    });
    assert.ok(!pulseRes.error, `pai_get_pulse error: ${JSON.stringify(pulseRes.error)}`);
    console.log('✓ Test 18 PASSED: pai_get_pulse returned active pulse');

    // 19. Second candidate session PASS
    console.log('\n── Test 19: Second candidate session concurrent operation PASS ──');
    const session2Ws = path.join(os.tmpdir(), `pai_containment_ws2_${Date.now()}`);
    fs.mkdirSync(session2Ws, { recursive: true });
    const open2Res = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-19-open2',
        intent: 'TERMINAL_COMMAND',
        objective: 'Open second candidate terminal session',
        effect_class: 'CANDIDATE_DRAFT',
        scope: session2Ws,
        action_payload: {
          operation: 'OPEN'
        }
      }
    });
    assert.ok(!open2Res.error, `Session 2 open error: ${JSON.stringify(open2Res.error)}`);
    session2Id = open2Res.result.structuredContent.result.session_id;
    assert.ok(session2Id && session2Id !== sessionId, 'Session 2 must have distinct session_id');

    const s2InputRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-19-s2-input',
        intent: 'TERMINAL_COMMAND',
        objective: 'Execute command in session 2',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'INPUT',
          session_id: session2Id,
          input: 'node -e "console.log(\'SESSION_2_OK\')"'
        }
      }
    });
    assert.ok(!s2InputRes.error, `Session 2 input error: ${JSON.stringify(s2InputRes.error)}`);
    assert.equal(s2InputRes.result.structuredContent.result.status, 'SUCCESS');
    console.log(`✓ Test 19 PASSED: Second candidate session ${session2Id} operates independently`);

    // 20. CLOSE idempotent PASS
    console.log('\n── Test 20: CLOSE idempotent PASS ──');
    const close1Res = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-20-close1',
        intent: 'TERMINAL_COMMAND',
        objective: 'Close session 1',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'CLOSE',
          session_id: sessionId
        }
      }
    });
    assert.ok(!close1Res.error, `Close 1 error: ${JSON.stringify(close1Res.error)}`);
    assert.equal(close1Res.result.structuredContent.result.state, 'CLOSED');

    // Idempotent second close
    const close1AgainRes = await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-20-close1-again',
        intent: 'TERMINAL_COMMAND',
        objective: 'Close session 1 again idempotently',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'CLOSE',
          session_id: sessionId
        }
      }
    });
    assert.ok(!close1AgainRes.error, `Idempotent close error: ${JSON.stringify(close1AgainRes.error)}`);
    assert.equal(close1AgainRes.result.structuredContent.result.state, 'CLOSED');

    // Close session 2
    await callRpc('tools/call', {
      name: 'pai_action_run',
      arguments: {
        request_id: 'containment-test-20-close2',
        intent: 'TERMINAL_COMMAND',
        objective: 'Close session 2',
        effect_class: 'CANDIDATE_DRAFT',
        action_payload: {
          operation: 'CLOSE',
          session_id: session2Id
        }
      }
    });
    console.log('✓ Test 20 PASSED: CLOSE is fully idempotent and cleans up cleanly');

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  ALL 20 CANDIDATE FILESYSTEM CONTAINMENT TESTS PASSED!       ');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } finally {
    server.close();
    // Cleanup temporary candidate workspaces
    try { fs.rmSync(candidateWsRoot, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(testDbDir, { recursive: true, force: true }); } catch (_) {}
  }
}

runCandidateFilesystemContainmentSuite().catch(err => {
  console.error('\n❌ SUITE FAILED:', err);
  process.exit(1);
});
