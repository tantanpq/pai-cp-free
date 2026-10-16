'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../src/server');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-fed-test-'));
const app = createServer({
  env: {
    ...process.env,
    PAI_GATEWAY_CANARY: '1',
    PORT: '18790',
    CHIEF_BRIDGE_DB_PATH: path.join(root, 'fed-test.sqlite'),
    CHIEF_TASK_BOX_ROOT: path.join(root, 'task-box'),
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
      res.on('end', () => resolve({ res, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });

  (async () => {
    // 1. server/discover
    const discover = await call('server/discover');
    assert.equal(discover.body.result.resultType, 'complete');
    assert.deepEqual(discover.body.result.supportedVersions, ['2026-07-28']);
    assert.equal(discover.body.result.cacheScope, 'private');
    assert.equal(discover.body.result.ttlMs, 300000);
    assert.equal(discover.body.result.capabilities.tools.listChanged, true);
    assert.equal(discover.body.result.capabilities.tools.governedWorkOperation, 'pai_action_run');

    // 2. initialize 2026 negotiation
    const init2026 = await call('initialize', { protocolVersion: '2026-07-28' });
    assert.equal(init2026.body.result.protocolVersion, '2026-07-28');
    assert.equal(init2026.body.result.serverInfo.name, 'pai-federation-gateway');

    // 3. initialize legacy 2025 negotiation
    const init2025 = await call('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(init2025.body.result.protocolVersion, '2025-03-26');

    // 4. tools/list - wire invariant canonical catalog (7 tools) and internal full catalog (26 tools)
    const defaultRes = await call('tools/list');
    assert.equal(defaultRes.body.result.resultType, 'complete');
    assert.equal(defaultRes.body.result.cacheScope, 'private');
    assert.equal(defaultRes.body.result.tools.length, 7, `Default tools count (${defaultRes.body.result.tools.length}) must be 7`);
    const listRes = await call('tools/list', { mode: 'ALL' });
    const wireToolNames = listRes.body.result.tools.map(t => t.name);
    assert.equal(wireToolNames.length, 7);
    assert.ok(wireToolNames.includes('pai_action_run'), 'Missing pai_action_run on wire');

    const internalToolNames = app.bridge.publicToolDefinitions.map(t => t.name);
    assert.equal(internalToolNames.length, 26);
    for (const fedTool of ['pai_capabilities', 'pai_cognition_run', 'pai_action_run', 'pai_run_status', 'pai_result', 'pai_cancel']) {
      assert.ok(internalToolNames.includes(fedTool), `Missing federation tool internally: ${fedTool}`);
    }
    const rawForbidden = ['shell', 'exec', 'bash', 'cmd', 'raw_sql', 'sql_query', 'fs_write', 'fs_delete'];
    for (const forbidden of rawForbidden) {
      assert.ok(!internalToolNames.includes(forbidden), `Forbidden tool exposed: ${forbidden}`);
    }

    // 5. pai_capabilities fail-closed check
    const capsRes = await call('tools/call', { name: 'pai_capabilities', arguments: {} });
    const caps = capsRes.body.result.structuredContent.result;
    assert.ok(caps.eligible_count >= 1);
    assert.ok(Array.isArray(caps.capability_cards));
    const ant = caps.capability_cards.find(p => p.provider === 'ANTIGRAVITY');
    assert.ok(ant, 'Antigravity provider card present');
    assert.equal(ant.user_entitlement, 'VERIFIED');
    assert.equal(ant.evidence_refs.length >= 1, true);

    // 6. tasks/get non-existent
    const taskGet = await call('tasks/get', { taskId: 'non-existent-task' });
    assert.equal(taskGet.body.error.code, -32001);

    app.server.close(() => {
      app.db.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      console.log('federation-gateway: PASS discovery, 2026 negotiation, 26-tool surface, capability cards, and Tasks extension.');
    });
  })().catch(err => {
    console.error(err);
    app.server.close(() => {
      app.db.close();
      process.exitCode = 1;
    });
  });
});
