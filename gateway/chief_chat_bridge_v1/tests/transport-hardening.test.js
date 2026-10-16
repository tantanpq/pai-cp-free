'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');

console.log('Testing P0.1 Transport Hardening Edge Cases...');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-transport-edge-'));
fs.mkdirSync(path.join(tmpRoot, '06_STATE'));
fs.writeFileSync(path.join(tmpRoot, '06_STATE', 'PAI_MIND_ACTIVE_POINTER_V1.json'), JSON.stringify({
  schema: 'pai-mind-active-pointer/v1', status: 'ACTIVE', activeVersion: 'TEST_MIND',
  driveFileId: 'fixture', projectRelativePath: '06_STATE/mind.md', sha256: '0'.repeat(64),
  authorityOwner: 'Tân', selfAmendmentAuthority: false
}));
const app = createServer({
  env: {
    ...process.env,
    PAI_GATEWAY_CANARY: '1',
    PORT: '0',
    CHIEF_BRIDGE_DB_PATH: path.join(tmpRoot, 'transport_edge.sqlite'),
    CHIEF_TASK_BOX_ROOT: path.join(tmpRoot, 'task-box'),
    CHIEF_BRIDGE_USER_ID: 'tan',
    CHIEF_BRIDGE_PAI_ID: 'pai',
    CHIEF_BRIDGE_PROJECT_ID: 'PAI',
    CHIEF_PROJECT_ROOT: tmpRoot,
    PAI_RUN_LOOP_ROOT: path.join(tmpRoot, 'runtime'),
    CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW'
  }
});

app.server.listen(0, '127.0.0.1', async () => {
  const port = app.server.address().port;

  const request = (method, reqPath, bodyObj = null, headers = {}) => new Promise((resolve, reject) => {
    const data = bodyObj ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)) : '';
    const reqHeaders = { ...headers };
    if (data) {
      reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: reqHeaders
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
    if (data) req.write(data);
    req.end();
  });

  try {
    // 1. OPTIONS /mcp
    const optRes = await request('OPTIONS', '/mcp');
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers['access-control-allow-origin'], '*');
    console.log('✓ 1. OPTIONS /mcp returns 204 with CORS headers');

    // 2. GET /mcp
    const getRes = await request('GET', '/mcp');
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.status, 'READY');
    assert.ok(getRes.body.protocols.includes('2024-11-05'));
    console.log('✓ 2. GET /mcp returns 200 discovery JSON');

    // 3. Trailing slash: POST /mcp/
    const slashRes = await request('POST', '/mcp/', {
      jsonrpc: '2.0',
      id: 'slash-1',
      method: 'tools/list',
      params: {}
    });
    assert.equal(slashRes.status, 200);
    assert.equal(slashRes.body.result.tools.length, 7);
    console.log('✓ 3. POST /mcp/ (trailing slash) accepted and returns 7 tools');

    // 4. Protocol version 2024-11-05
    const proto2024Res = await request('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 'p2024-1',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} }
    }, { 'mcp-protocol-version': '2024-11-05' });
    assert.equal(proto2024Res.status, 200);
    assert.equal(proto2024Res.body.result.protocolVersion, '2024-11-05');
    console.log('✓ 4. Protocol 2024-11-05 accepted in initialize');

    // 5. Namespaced tool call: pai_terminal.chief_resume
    const nsResume = await request('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 'ns-1',
      method: 'tools/call',
      params: { name: 'pai_terminal.chief_resume', arguments: {} }
    }, { 'mcp-name': 'pai_terminal.chief_resume' });
    assert.equal(nsResume.status, 200);
    assert.ok(!nsResume.body.error, `Unexpected error: ${JSON.stringify(nsResume.body.error)}`);
    console.log('✓ 5. Namespaced tool call pai_terminal.chief_resume succeeds');

    // 6. Namespaced tool call: pai_terminal.pai_get_pulse
    const nsPulse = await request('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 'ns-2',
      method: 'tools/call',
      params: { name: 'pai_terminal.pai_get_pulse', arguments: {} }
    }, { 'mcp-name': 'pai_terminal.pai_get_pulse' });
    assert.equal(nsPulse.status, 200);
    assert.ok(!nsPulse.body.error, `Unexpected error: ${JSON.stringify(nsPulse.body.error)}`);
    console.log('✓ 6. Namespaced tool call pai_terminal.pai_get_pulse succeeds');

    // 7. Namespaced tool call: pai_terminal.search
    const nsSearch = await request('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 'ns-3',
      method: 'tools/call',
      params: { name: 'pai_terminal.search', arguments: { query: 'PAI' } }
    }, { 'mcp-name': 'pai_terminal.search' });
    assert.equal(nsSearch.status, 200);
    assert.ok(!nsSearch.body.error, `Unexpected error: ${JSON.stringify(nsSearch.body.error)}`);
    console.log('✓ 7. Namespaced tool call pai_terminal.search succeeds');

    // 8. Tool mismatch still properly caught
    const mismatch = await request('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 'ns-4',
      method: 'tools/call',
      params: { name: 'pai_terminal.search', arguments: { query: 'PAI' } }
    }, { 'mcp-name': 'pai_terminal.chief_resume' });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error?.message, 'HEADER_TOOL_MISMATCH');
    console.log('✓ 8. Genuine tool name mismatch still rejected with 400 HEADER_TOOL_MISMATCH');

    console.log('\nALL TRANSPORT HARDENING EDGE CASES PASSED!');
  } finally {
    app.server.close(() => {
      app.db.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
  }
});
