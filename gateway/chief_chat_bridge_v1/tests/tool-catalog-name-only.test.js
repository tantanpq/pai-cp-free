'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../src/server');
const { CHATGPT_PUBLIC_TOOL_NAMES } = require('../src/chief-chat-bridge');
const { projectToolsList } = require('../src/context-economy/tool-catalog-projection');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-name-only-'));
const app = createServer({
  env: {
    ...process.env,
    PAI_GATEWAY_CANARY: '1',
    PORT: '18791',
    CHIEF_BRIDGE_DB_PATH: path.join(root, 'name-only.sqlite'),
    CHIEF_TASK_BOX_ROOT: path.join(root, 'task-box'),
    CHIEF_BRIDGE_USER_ID: 'tan',
    CHIEF_BRIDGE_PAI_ID: 'pai',
    CHIEF_BRIDGE_PROJECT_ID: 'PAI',
    CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW'
  }
});

app.server.listen(0, '127.0.0.1', () => {
  const port = app.server.address().port;
  const call = (method, params) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28' }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });

  (async () => {
    const list = await call('tools/list');
    const tools = list.body.result.tools;
    assert.equal(tools.length, 7);
    assert.deepEqual(tools.map(t => t.name), [...CHATGPT_PUBLIC_TOOL_NAMES]);
    for (const tool of tools) {
      assert.equal(Object.keys(tool.inputSchema.properties || {}).length, 0);
      assert.equal(tool._meta.schemaHydration, 'NAME_ONLY');
    }
    const nameOnlyBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
    assert.ok(nameOnlyBytes < 4500, `name-only list ${nameOnlyBytes}B`);

    const one = await call('tools/get', { name: 'fetch' });
    assert.equal(one.body.result.tools.length, 1);
    assert.equal(one.body.result.tool.name, 'fetch');
    assert.ok(one.body.result.tool.inputSchema.properties.id);

    const exactList = await call('tools/list', { name: 'search' });
    assert.equal(exactList.body.result.tools.length, 1);
    assert.ok(exactList.body.result.tools[0].inputSchema.properties.query);

    const denied = await call('tools/list', { schemaMode: 'FULL' });
    assert.equal(denied.body.error.data.code, 'BROAD_SCHEMA_DISCOVERY_DENIED');
    const bulk = await call('tools/get', { name: ['search', 'fetch'] });
    assert.equal(bulk.body.error.data.code, 'BROAD_SCHEMA_DISCOVERY_DENIED');

    assert.throws(
      () => projectToolsList([{ name: 'fetch', inputSchema: { type: 'object', properties: { id: {} } } }], { name: 'nope' }),
      /TOOL_SCHEMA_NOT_FOUND/
    );

    console.log(`tool-catalog-name-only: PASS name-only=${nameOnlyBytes}B fetch-schema-exact=1`);
    app.server.close(() => {
      try { app.db.close(); } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    });
  })().catch(error => {
    console.error(error);
    app.server.close(() => {
      try { app.db.close(); } catch (_) {}
      process.exitCode = 1;
    });
  });
});
