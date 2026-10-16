'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');

console.log('Running MCP Protocol Differential Conformance Test Suite...');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-proto-conf-'));
const app = createServer({
  env: {
    ...process.env,
    PAI_GATEWAY_CANARY: '1',
    PORT: '0',
    CHIEF_BRIDGE_DB_PATH: path.join(tmpRoot, 'conformance.sqlite'),
    CHIEF_TASK_BOX_ROOT: path.join(tmpRoot, 'task-box'),
    CHIEF_BRIDGE_USER_ID: 'tan',
    CHIEF_BRIDGE_PAI_ID: 'pai',
    CHIEF_BRIDGE_PROJECT_ID: 'PAI',
    CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW'
  }
});

app.server.listen(0, '127.0.0.1', async () => {
  const port = app.server.address().port;

  const rpc = (bodyObj, headers = {}) => new Promise((resolve, reject) => {
    const data = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  try {
    // 1. Negotiation: Modern 2026-07-28
    const init2026 = await rpc({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {} }
    });
    assert.equal(init2026.status, 200);
    assert.equal(init2026.headers['mcp-session-id'], undefined, 'Modern 2026 wire MUST NOT contain mcp-session-id header');
    assert.equal(init2026.body.result.protocolVersion, '2026-07-28');
    assert.ok(init2026.body.result.capabilities.tools);
    assert.ok(init2026.body.result.capabilities.tasks);
    console.log('  ✓ 1. Protocol 2026-07-28 negotiated: stateless wire (no session header) and Tasks capability.');

    // 2. Negotiation: Legacy 2025-03-26
    const init2025 = await rpc({
      jsonrpc: '2.0',
      id: 'init-2',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {} }
    });
    assert.equal(init2025.status, 200);
    assert.equal(init2025.headers['mcp-session-id'], 'pai-tan-chief-main', 'Legacy 2025 wire MUST contain mcp-session-id header');
    assert.equal(init2025.body.result.protocolVersion, '2025-03-26');
    console.log('  ✓ 2. Protocol 2025-03-26 backward-compatible negotiation verified with session header.');

    // 3. JIT tools/list with minimal profile
    const toolsJit = await rpc({
      jsonrpc: '2.0',
      id: 'tools-jit',
      method: 'tools/list',
      params: { profile: 'BOOT_DISCOVERY' }
    });
    assert.equal(toolsJit.status, 200);
    const jitNames = toolsJit.body.result.tools.map(t => t.name);
    assert.ok(jitNames.length >= 3 && jitNames.length <= 8, `Tool count (${jitNames.length}) must be in [3, 8]`);
    assert.deepEqual(jitNames, ['chief_resume', 'chief_status', 'pai_get_pulse', 'search', 'fetch', 'chief_turn', 'pai_action_run']);
    console.log(`  ✓ 3. JIT tools/list returns bounded ${jitNames.length} canonical tools including pai_action_run.`);

    // 4. Tasks extension: tasks/get non-existent task
    const tasksGet = await rpc({
      jsonrpc: '2.0',
      id: 'task-1',
      method: 'tasks/get',
      params: { taskId: 'TASK_NONEXISTENT_999' }
    });
    assert.equal(tasksGet.status, 200);
    assert.equal(tasksGet.body.error.code, -32001);
    assert.equal(tasksGet.body.error.message, 'TASK_NOT_FOUND');
    console.log('  ✓ 4. Tasks extension handles missing task fail-closed.');

    // 5. JSON-RPC malformed request handling
    const malformed = await rpc({ jsonrpc: '1.0', method: 'ping' });
    assert.equal(malformed.body.error.code, -32000);
    console.log('  ✓ 5. JSON-RPC invalid version rejected with -32000.');

    console.log('✓ PASS: MCP Protocol Differential Conformance verified with direct wire evidence.');
  } finally {
    app.server.close(() => {
      app.db.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
  }
});
