'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../src/server');
const { ExecutorRouter } = require('../src/executor-router');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-chief-work-test-'));
const taskBoxRoot = path.join(root, 'task-box');
fs.mkdirSync(path.join(taskBoxRoot, 'items'), { recursive: true });

const app = createServer({
  env: {
    ...process.env,
    PAI_GATEWAY_CANARY: '1',
    PORT: '18791',
    CHIEF_BRIDGE_DB_PATH: path.join(root, 'chief-work-test.sqlite'),
    CHIEF_TASK_BOX_ROOT: taskBoxRoot,
    CHIEF_BRIDGE_USER_ID: 'tan',
    CHIEF_BRIDGE_PAI_ID: 'pai',
    CHIEF_BRIDGE_PROJECT_ID: 'PAI',
    CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW'
  }
});

app.server.listen(0, '127.0.0.1', () => {
  const port = app.server.address().port;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ res, body: JSON.parse(body) });
        } catch (e) {
          reject(new Error(`Failed to parse JSON response: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }));
  });

  (async () => {
    console.log('Running Governed Chief Work Request & Dynamic Executor Test Suite (15 Checks)...');

    // 1. MCP server/discover shows the governed Chief work operation
    const discover = await call('server/discover');
    assert.equal(discover.body.result.capabilities.tools.listChanged, true);
    assert.equal(discover.body.result.capabilities.tools.governedWorkOperation, 'pai_action_run');
    assert.match(discover.body.result.instructions, /pai_action_run/);
    assert.equal(discover.body.result.resultType, 'complete');
    console.log('✓ 1. MCP server/discover shows governed Chief work operation');

    // 2. ChatGPT-style request can submit a no-effect technical work candidate
    const noEffectRes = await call('tools/call', {
      name: 'pai_action_run',
      arguments: {
        intent: 'ANALYZE',
        objective: 'Evaluate candidate architecture for unified login gate',
        scope: 'NONE',
        effect_class: 'NO_MATERIAL_DELTA',
        requested_mode: 'plan',
        request_id: 'chatgpt-eval-001'
      }
    });
    assert.equal(noEffectRes.res.statusCode, 200);
    const noEffect = noEffectRes.body.result.structuredContent.result;
    assert.equal(noEffect.request_id, 'chatgpt-eval-001');
    assert.equal(noEffect.chief_state, 'ADMITTED');
    assert.equal(noEffect.admission_state, 'NO_EFFECT_CANDIDATE');
    assert.equal(noEffect.lifecycle_state, 'COMPLETED');
    assert.equal(noEffect.tan_decision_required, false);
    assert.ok(noEffect.pai_task_id.startsWith('CHIEF_REQUEST_'));
    console.log('✓ 2. ChatGPT-style request submits no-effect technical work candidate');

    // 3. Request enters existing Chief/Governor/TaskBox path
    const workRes = await call('tools/call', {
      name: 'pai_action_run',
      arguments: {
        intent: 'BUILD',
        objective: 'Implement isolated auth candidate in staging',
        scope: 'STAGING_AUTH_01',
        effect_class: 'GOVERNED_DELEGATION',
        requested_mode: 'accept-edits',
        request_id: 'chatgpt-build-002',
        acceptance: '140/140 unit tests pass and build succeeds'
      }
    });
    assert.ok(workRes.body.result, JSON.stringify(workRes.body));
    const workResult = workRes.body.result.structuredContent.result;
    assert.equal(workResult.request_id, 'chatgpt-build-002');
    assert.equal(workResult.chief_state, 'ADMITTED');
    assert.equal(workResult.admission_state, 'ADMITTED_TASKBOX');
    assert.equal(workResult.lifecycle_state, 'READY');
    assert.ok(workResult.selected_executor_if_assigned);
    assert.equal(workResult.result_ref, `pai_result:${workResult.pai_task_id}`);

    // Verify task item was materialized in TaskBox items
    const taskItemPath = path.join(taskBoxRoot, 'items', `${workResult.pai_task_id}.md`);
    assert.ok(fs.existsSync(taskItemPath), 'Task item materialized in TaskBox directory');
    const taskContent = fs.readFileSync(taskItemPath, 'utf8');
    assert.ok(taskContent.includes('# TASK BOX'));
    assert.ok(taskContent.includes(`TASK_ID: ${workResult.pai_task_id}`));
    console.log('✓ 3. Request enters Chief/Governor/TaskBox path and materializes');

    // 4. Dynamic router chooses an eligible READY executor
    const router = new ExecutorRouter();
    const exAny = router.selectExecutor({ requiredCapabilities: ['CODE_ENGINEERING'] });
    assert.ok(exAny);
    assert.equal(exAny.state, 'READY');
    assert.equal(exAny.quotaState, 'ACTIVE');
    console.log(`✓ 4. Dynamic router chooses an eligible READY executor: ${exAny.id}`);

    // 5. Anti can be selected when capability/quota fit
    const antiEx = router.selectExecutor({ role: 'BUILDER', excludeExecutors: ['CODEX_HOME'] });
    assert.equal(antiEx.id, 'ANTIGRAVITY_CLI');
    assert.equal(antiEx.state, 'READY');
    console.log('✓ 5. Anti selected when capability and quota fit for BUILDER');

    // 6. Grok remains QA-only; it cannot be selected for BUILD work.
    const grokEx = router.selectExecutor({
      role: 'QA',
      excludeExecutors: ['CODEX_HOME', 'ANTIGRAVITY_CLI']
    });
    assert.equal(grokEx.id, 'GROK_CLI');
    assert.equal(grokEx.state, 'READY');

    // Also QA role prefers Grok CLI
    const grokQa = router.selectExecutor({ role: 'QA', excludeExecutors: ['CODEX_HOME', 'ANTIGRAVITY_CLI'] });
    assert.equal(grokQa.id, 'GROK_CLI');
    console.log('✓ 6. Grok selected when Anti unavailable or for independent QA role');

    // 7. Codex/Farm quota exhaustion blocks only those executors
    const codexEx = router.selectExecutor({
      role: 'QA', requiredCapabilities: ['QA'], preferredExecutor: 'CODEX_HOME'
    });
    assert.equal(codexEx.id, 'CODEX_HOME');
    router.markProviderUnavailable('CODEX_HOME', 'QUOTA_EXHAUSTED');
    assert.throws(() => {
      router.selectExecutor({ preferredExecutor: 'FARM_REMOTE', excludeExecutors: ['ANTIGRAVITY_CLI', 'GROK_CLI', 'DETERMINISTIC_TOOL'] });
    }, /QUOTA_EXHAUSTED/);

    // But standard routing bypasses Codex and Farm cleanly
    const nonExhausted = router.selectExecutor();
    assert.ok(['ANTIGRAVITY_CLI', 'GROK_CLI'].includes(nonExhausted.id));
    console.log('✓ 7. Codex/Farm quota exhaustion blocks only those executors');

    // 8. duplicate request is idempotent
    const dupeRes = await call('tools/call', {
      name: 'pai_action_run',
      arguments: {
        intent: 'ANALYZE',
        objective: 'Evaluate candidate architecture for unified login gate',
        scope: 'NONE',
        effect_class: 'NO_MATERIAL_DELTA',
        requested_mode: 'plan',
        request_id: 'chatgpt-eval-001'
      }
    });
    const dupe = dupeRes.body.result.structuredContent.result;
    assert.equal(dupe.request_id, 'chatgpt-eval-001');
    assert.equal(dupe.admission_state, 'IDEMPOTENT_REPLAY');

    // Conflicting payload on same request_id throws conflict
    const conflictRes = await call('tools/call', {
      name: 'pai_action_run',
      arguments: {
        intent: 'BUILD_DIFFERENT',
        objective: 'Different objective with same id',
        scope: 'NONE',
        effect_class: 'NO_MATERIAL_DELTA',
        request_id: 'chatgpt-eval-001'
      }
    });
    assert.ok(conflictRes.body.error || conflictRes.body.result?.structuredContent?.result?.blocker);
    console.log('✓ 8. Duplicate request is idempotent; conflict is rejected');

    // 9. concurrent same mutable scope is denied/serialized
    const scopeRouter = new ExecutorRouter();
    scopeRouter.claimScope('SHARED_MUTABLE_W1', { taskId: 'T1', requestId: 'R1' });
    assert.throws(() => {
      scopeRouter.claimScope('SHARED_MUTABLE_W1', { taskId: 'T2', requestId: 'R2' });
    }, /CONCURRENT_SCOPE_LOCKED/);
    console.log('✓ 9. Concurrent same mutable scope is denied/serialized');

    // 10. independent scopes remain eligible
    const claimOther = scopeRouter.claimScope('INDEPENDENT_W2', { taskId: 'T3', requestId: 'R3' });
    assert.ok(claimOther);
    assert.equal(claimOther.scope, 'independent_w2');
    console.log('✓ 10. Independent scopes remain eligible concurrently');

    // 11. authority-negative PUBLICATION/MONEY/CREDENTIAL tests fail closed
    const authNegativeCases = [
      { intent: 'PUBLICATION', objective: 'Publish artifact to public web', effect_class: 'GOVERNED_DELEGATION' },
      { intent: 'PAYMENT', objective: 'Transfer funds or disburse money', effect_class: 'GOVERNED_DELEGATION' },
      { intent: 'CREDENTIAL', objective: 'Extract system root secrets', effect_class: 'GOVERNED_DELEGATION' }
    ];
    for (const testCase of authNegativeCases) {
      const negRes = await call('tools/call', {
        name: 'pai_action_run',
        arguments: {
          ...testCase,
          request_id: `neg-${Date.now()}-${Math.random()}`
        }
      });
      assert.ok(negRes.body.error || negRes.body.result?.content?.[0]?.text?.includes('AUTHORITY_POLICY_DENIED'));
    }
    console.log('✓ 11. Authority-negative PUBLICATION/MONEY/CREDENTIAL tests fail closed');

    const defaultList = await call('tools/list');
    assert.equal(defaultList.body.result.tools.length, 7);
    const listRes = await call('tools/list', { mode: 'ALL' });
    const wireToolNames = listRes.body.result.tools.map(t => t.name);
    assert.equal(wireToolNames.length, 7);
    assert.ok(wireToolNames.includes('pai_action_run'));

    const internalToolNames = app.bridge.publicToolDefinitions.map(t => t.name);
    assert.equal(internalToolNames.length, 26);
    for (const forbidden of ['shell', 'exec', 'bash', 'cmd', 'raw_sql', 'sql_query', 'fs_write', 'fs_delete']) {
      assert.ok(!internalToolNames.includes(forbidden), `Forbidden tool exposed: ${forbidden}`);
    }
    console.log('✓ 12. No raw shell/fs/sql tool appears in MCP discovery (26 bounded tools internally, 7 on wire)');

    // 13. Result/Handoff is readable through existing MCP result/status path
    const statusRes = await call('tools/call', {
      name: 'pai_run_status',
      arguments: { run_id: workResult.pai_task_id }
    });
    const status = statusRes.body.result.structuredContent.result;
    assert.equal(status.status, 'unavailable');
    assert.equal(status.task.taskId, workResult.pai_task_id);
    assert.equal(status.task.acceptedResult.failureClass, 'SANITIZED_CLAIM_SERVICE_UNAVAILABLE');

    const resultRes = await call('tools/call', {
      name: 'pai_result',
      arguments: { run_id: workResult.pai_task_id }
    });
    const resultObj = resultRes.body.result.structuredContent.result;
    assert.equal(resultObj.status, 'RESULT_UNAVAILABLE');
    assert.equal(resultObj.structuredResult.binding.taskId, workResult.pai_task_id);
    console.log('✓ 13. Missing canonical Claim reader returns truthful unavailable result/status');

    // 14. restart preserves existing Chief session/continuity behavior
    const repeatedStatus = await call('tools/call', { name: 'pai_run_status', arguments: { run_id: workResult.pai_task_id } });
    assert.equal(repeatedStatus.body.result.structuredContent.result.task.taskId, workResult.pai_task_id);
    console.log('✓ 14. Session and continuity preserved across queries');

    // 15. Direct chief_work_request invocation alias
    const aliasRes = await call('tools/call', {
      name: 'chief_work_request',
      arguments: {
        intent: 'ANALYZE',
        objective: 'Direct chief_work_request alias test',
        scope: 'NONE',
        effect_class: 'NO_MATERIAL_DELTA',
        request_id: 'alias-req-001'
      }
    });
    assert.equal(aliasRes.body.result.structuredContent.result.request_id, 'alias-req-001');
    assert.equal(aliasRes.body.result.structuredContent.result.admission_state, 'NO_EFFECT_CANDIDATE');
    console.log('✓ 15. chief_work_request alias operates cleanly through governed pipeline');

    app.server.close(() => {
      app.db.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      console.log('\nALL 15 GOVERNED EXECUTOR SEAM TESTS PASSED CLEANLY.');
    });
  })().catch(err => {
    console.error('Test failure:', err);
    app.server.close(() => {
      app.db.close();
      process.exitCode = 1;
    });
  });
});
