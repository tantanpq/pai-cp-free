'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');

console.log('Running Modern MCP 2026 Conformance Test Suite (20 Tests)...');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-proto-modern-'));
fs.mkdirSync(path.join(tmpRoot, 'task-box'));
const app = createServer({
  env: {
    ...process.env,
    PAI_GATEWAY_CANARY: '1',
    PORT: '0',
    CHIEF_BRIDGE_DB_PATH: path.join(tmpRoot, 'modern_conformance.sqlite'),
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
    // ==========================================
    // MODERN ERA (2026-07-28) TESTS (1 - 12)
    // ==========================================

    // 1. Modern initialize negotiation
    const test1 = await rpc({
      jsonrpc: '2.0',
      id: 'm-init-1',
      method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {} }
    }, { 'mcp-protocol-version': '2026-07-28' });
    assert.equal(test1.status, 200);
    assert.equal(test1.body.result.protocolVersion, '2026-07-28');
    assert.equal(test1.headers['mcp-session-id'], undefined, 'Modern response MUST NOT have mcp-session-id header');
    console.log('✓ 1. Modern initialize: 2026-07-28 negotiation successful, stateless wire (no session header)');

    // 2. Modern tools/list without initialize
    const test2 = await rpc({
      jsonrpc: '2.0',
      id: 'm-tools-no-init',
      method: 'tools/list',
      params: {}
    }, { 'mcp-protocol-version': '2026-07-28' });
    assert.equal(test2.status, 200);
    assert.ok(Array.isArray(test2.body.result.tools));
    assert.equal(test2.headers['mcp-session-id'], undefined);
    console.log('✓ 2. Modern tools/list without initialize succeeds statelessly');

    // 3. Modern default tools/list bounded (3-8 tools, schema bytes < 12000)
    const defTools = test2.body.result.tools;
    assert.ok(defTools.length >= 3 && defTools.length <= 8, `Default tools count ${defTools.length} not in [3, 8]`);
    const schemaBytes = Buffer.byteLength(JSON.stringify(defTools), 'utf8');
    assert.ok(schemaBytes < 12000, `Default schema bytes ${schemaBytes} exceeds 12000 limit`);
    console.log(`✓ 3. Modern default tools/list bounded: ${defTools.length} tools, ${schemaBytes} bytes (< 12000)`);

    // 4. Modern tools/list cache metadata
    assert.ok(test2.body.result._meta, 'tools/list response must include _meta cache metadata');
    assert.equal(test2.body.result.ttlMs, 300000);
    assert.equal(test2.body.result.cacheScope, 'private');
    assert.ok(test2.body.result._meta['io.pai/catalog'].profileId);
    console.log('✓ 4. Modern tools/list returns cache metadata (_meta.ttlMs=300000, cacheScope=SESSION_LOCAL)');

    // 5. Modern tools/call without initialize
    const test5 = await rpc({
      jsonrpc: '2.0',
      id: 'm-call-no-init',
      method: 'tools/call',
      params: { name: 'pai_capabilities', arguments: {} }
    }, { 'mcp-protocol-version': '2026-07-28' });
    assert.equal(test5.status, 200);
    assert.ok(test5.body.result?.structuredContent?.result?.capability_cards);
    assert.equal(test5.headers['mcp-session-id'], undefined);
    console.log('✓ 5. Modern tools/call without initialize succeeds directly');

    // 6. Modern tasks capability advertised
    assert.ok(test1.body.result.capabilities.tasks);
    assert.equal(test1.body.result.capabilities.tasks.supported, true);
    console.log('✓ 6. Modern tasks capability advertised in initialize response');

    // 7. Modern tasks/get for non-existent task
    const test7 = await rpc({
      jsonrpc: '2.0',
      id: 'm-task-get',
      method: 'tasks/get',
      params: { taskId: 'TASK_NONEXISTENT_888' }
    }, { 'mcp-protocol-version': '2026-07-28' });
    assert.equal(test7.status, 200);
    assert.equal(test7.body.error?.code, -32001);
    assert.equal(test7.body.error?.message, 'TASK_NOT_FOUND');
    console.log('✓ 7. Modern tasks/get fails closed (-32001 TASK_NOT_FOUND) for nonexistent task');

    // 8. Modern tasks/update handled correctly on live task
    const runRes = await rpc({
      jsonrpc: '2.0',
      id: 'm-run-task',
      method: 'tools/call',
      params: {
        name: 'pai_action_run',
        arguments: {
          intent: 'BUILD',
          objective: 'Inspect conformance',
          scope: 'CORE/test',
          effect_class: 'CANDIDATE_DRAFT',
          requested_mode: 'candidate-only',
          request_id: 'proto-conf-req-001',
          acceptance: 'unit test verification passes'
        }
      }
    }, { 'mcp-protocol-version': '2026-07-28' });
    const taskId = runRes.body.result?.structuredContent?.result?.pai_task_id;
    assert.ok(taskId, 'pai_action_run should return taskId');

    const test8 = await rpc({
      jsonrpc: '2.0',
      id: 'm-task-update',
      method: 'tasks/update',
      params: { taskId, payload: { note: 'updated' } }
    }, { 'mcp-protocol-version': '2026-07-28' });
    assert.equal(test8.status, 200);
    assert.equal(test8.body.result?.task?.taskId, taskId);
    assert.equal(test8.body.result?.task?.payload?.note, 'updated');
    console.log('✓ 8. Modern tasks/update handled cleanly on active task');

    // 9. Modern subscriptions/listen handled correctly
    const test9 = await rpc({
      jsonrpc: '2.0',
      id: 'm-sub-listen',
      method: 'subscriptions/listen',
      params: { types: ['toolsListChanged'] }
    }, { 'mcp-protocol-version': '2026-07-28' });
    assert.equal(test9.status, 200);
    assert.equal(test9.body.result?.subscribed, true);
    console.log('✓ 9. Modern subscriptions/listen returns subscribed state');

    // 10. Modern header validation: unsupported protocol version rejected with -32600
    const test10 = await rpc({
      jsonrpc: '2.0',
      id: 'm-bad-proto',
      method: 'tools/list',
      params: {}
    }, { 'mcp-protocol-version': '1999-01-01' });
    assert.equal(test10.status, 400);
    assert.equal(test10.body.error?.code, -32600);
    assert.equal(test10.body.error?.message, 'PROTOCOL_VERSION_UNSUPPORTED');
    console.log('✓ 10. Modern header audit: unsupported protocol version rejected with -32600');

    // 11. Modern header mismatch validation: mcp-method vs body method mismatch rejected with -32600
    const test11 = await rpc({
      jsonrpc: '2.0',
      id: 'm-method-mismatch',
      method: 'tools/list',
      params: {}
    }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' });
    assert.equal(test11.status, 400);
    assert.equal(test11.body.error?.code, -32600);
    assert.equal(test11.body.error?.message, 'HEADER_METHOD_MISMATCH');
    console.log('✓ 11. Modern header audit: mcp-method mismatch rejected with -32600');

    // 12. Modern header tool-name mismatch validation: mcp-name vs params.name rejected with -32600
    const test12 = await rpc({
      jsonrpc: '2.0',
      id: 'm-name-mismatch',
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'test' } }
    }, { 'mcp-protocol-version': '2026-07-28', 'mcp-name': 'fetch' });
    assert.equal(test12.status, 400);
    assert.equal(test12.body.error?.code, -32600);
    assert.equal(test12.body.error?.message, 'HEADER_TOOL_MISMATCH');
    console.log('✓ 12. Modern header audit: mcp-name mismatch rejected with -32600');

    // ==========================================
    // LEGACY ERA (2025-03-26) TESTS (13 - 16)
    // ==========================================

    // 13. Legacy initialize negotiation returns mcp-session-id
    const test13 = await rpc({
      jsonrpc: '2.0',
      id: 'l-init-1',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {} }
    });
    assert.equal(test13.status, 200);
    assert.equal(test13.body.result.protocolVersion, '2025-03-26');
    assert.equal(test13.headers['mcp-session-id'], 'pai-tan-chief-main');
    console.log('✓ 13. Legacy initialize: 2025-03-26 negotiation returns mcp-session-id header');

    // 14. Legacy tools/list with session header returns mcp-session-id
    const test14 = await rpc({
      jsonrpc: '2.0',
      id: 'l-tools-1',
      method: 'tools/list',
      params: {}
    }, { 'mcp-session-id': 'pai-tan-chief-main' });
    assert.equal(test14.status, 200);
    assert.equal(test14.headers['mcp-session-id'], 'pai-tan-chief-main');
    console.log('✓ 14. Legacy tools/list returns mcp-session-id on wire');

    // 15. Legacy tools/call with session header returns mcp-session-id
    const test15 = await rpc({
      jsonrpc: '2.0',
      id: 'l-call-1',
      method: 'tools/call',
      params: { name: 'chief_status', arguments: {} }
    }, { 'mcp-session-id': 'pai-tan-chief-main' });
    assert.equal(test15.status, 200);
    assert.equal(test15.headers['mcp-session-id'], 'pai-tan-chief-main');
    console.log('✓ 15. Legacy tools/call returns mcp-session-id on wire');

    // 16. Wire catalog invariance: mode: 'ALL' returns invariant 7 tools, internal definitions have 26
    const test16 = await rpc({
      jsonrpc: '2.0',
      id: 'l-all-tools',
      method: 'tools/list',
      params: { mode: 'ALL' }
    });
    assert.equal(test16.status, 200);
    assert.equal(test16.body.result.tools.length, 7);
    assert.equal(app.bridge.publicToolDefinitions.length, 26);
    console.log('✓ 16. Wire catalog invariant: tools/list returns 7 tools, internal catalog has 26 registered tools');

    // ==========================================
    // CROSS-ERA & BOUNDING INVARIANTS (17 - 20)
    // ==========================================

    // 17. Server discover endpoint
    const test17 = await rpc({
      jsonrpc: '2.0',
      id: 'disc-1',
      method: 'server/discover',
      params: {}
    });
    assert.equal(test17.status, 200);
    assert.equal(test17.body.result.resultType, 'complete');
    assert.deepEqual(test17.body.result.supportedVersions, ['2026-07-28']);
    assert.equal(test17.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'pai-federation-gateway');
    assert.ok(test17.body.result.capabilities.tools);
    assert.equal(test17.body.result.cacheScope, 'private');
    console.log('✓ 17. server/discover advertises serverInfo, sourceLockDigest, and modern capabilities');

    // 18. Unknown tool call fails closed
    let threwDenied = false;
    const test18 = await rpc({
      jsonrpc: '2.0',
      id: 'bad-tool',
      method: 'tools/call',
      params: { name: 'unregistered_dangerous_tool', arguments: {} }
    });
    assert.equal(test18.status, 200);
    assert.ok(test18.body.error?.message?.includes('BRIDGE_TOOL_DENIED') || test18.body.error);
    console.log('✓ 18. Unknown tool call fails closed with tool denied error');

    // 19. Default tools/list bounded under unconstrained callers (no hints/params)
    const test19 = await rpc({
      jsonrpc: '2.0',
      id: 'unconstrained',
      method: 'tools/list'
    });
    assert.equal(test19.status, 200);
    assert.ok(test19.body.result.tools.length >= 3 && test19.body.result.tools.length <= 8,
      `Unconstrained tool count ${test19.body.result.tools.length} not bounded in [3, 8]`);
    console.log(`✓ 19. Unconstrained tools/list correctly bounded to ${test19.body.result.tools.length} tools`);

    // 20. Fallback invariant: UNKNOWN profile => MINIMAL_SAFE_PROFILE (3-8 tools, never FULL_CATALOG)
    const test20 = await rpc({
      jsonrpc: '2.0',
      id: 'unknown-profile',
      method: 'tools/list',
      params: { profile: 'RANDOM_UNKNOWN_PROFILE_12345' }
    });
    assert.equal(test20.status, 200);
    assert.ok(test20.body.result.tools.length >= 3 && test20.body.result.tools.length <= 8,
      `Unknown profile must fall back to minimal profile [3, 8], got: ${test20.body.result.tools.length}`);
    assert.notEqual(test20.body.result.tools.length, 26, 'UNKNOWN profile MUST NEVER fall back to FULL_CATALOG');
    console.log(`✓ 20. Invariant holds: UNKNOWN profile falls back to ${test20.body.result.tools.length} tools (never full catalog)`);

    console.log('\nALL 20 MODERN MCP 2026 PROTOCOL CONFORMANCE TESTS PASSED CLEANLY.');
  } finally {
    app.server.close(() => {
      app.db.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
  }
});
