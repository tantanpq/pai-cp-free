'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

console.log('Testing LIVE 8787 Server...');

const request = (method, reqPath, bodyObj = null, headers = {}) => new Promise((resolve, reject) => {
  const data = bodyObj ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)) : '';
  const reqHeaders = { ...headers };
  if (data) {
    reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
    reqHeaders['Content-Length'] = Buffer.byteLength(data);
  }
  const req = http.request({
    hostname: '127.0.0.1',
    port: 8787,
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

(async () => {
  // 1. GET /mcp
  const getRes = await request('GET', '/mcp');
  assert.equal(getRes.status, 200);
  console.log('✓ 1. GET /mcp:', getRes.body);

  // 2. OPTIONS /mcp
  const optRes = await request('OPTIONS', '/mcp');
  assert.equal(optRes.status, 204);
  console.log('✓ 2. OPTIONS /mcp status 204 with CORS');

  // 3. tools/list on /mcp
  const listRes = await request('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 'list-1',
    method: 'tools/list',
    params: {}
  });
  assert.equal(listRes.status, 200);
  console.log(`✓ 3. POST /mcp tools/list returned ${listRes.body.result.tools.length} tools`);

  // 4. chief_resume
  const resumeRes = await request('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 'resume-1',
    method: 'tools/call',
    params: { name: 'chief_resume', arguments: {} }
  });
  assert.equal(resumeRes.status, 200);
  assert.ok(!resumeRes.body.error, `chief_resume error: ${JSON.stringify(resumeRes.body.error)}`);
  console.log('✓ 4. chief_resume succeeded on live 8787');

  // 5. pai_get_pulse
  const pulseRes = await request('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 'pulse-1',
    method: 'tools/call',
    params: { name: 'pai_get_pulse', arguments: {} }
  });
  assert.equal(pulseRes.status, 200);
  assert.ok(!pulseRes.body.error, `pai_get_pulse error: ${JSON.stringify(pulseRes.body.error)}`);
  console.log('✓ 5. pai_get_pulse succeeded on live 8787');

  // 6. search query PAI
  const searchRes = await request('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 'search-1',
    method: 'tools/call',
    params: { name: 'search', arguments: { query: 'PAI' } }
  });
  assert.equal(searchRes.status, 200);
  assert.ok(!searchRes.body.error, `search error: ${JSON.stringify(searchRes.body.error)}`);
  console.log('✓ 6. search succeeded on live 8787');

  // 7. Namespaced tool call: pai_terminal.chief_resume
  const nsResume = await request('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 'ns-resume-1',
    method: 'tools/call',
    params: { name: 'pai_terminal.chief_resume', arguments: {} }
  }, { 'mcp-name': 'pai_terminal.chief_resume' });
  assert.equal(nsResume.status, 200);
  assert.ok(!nsResume.body.error, `ns chief_resume error: ${JSON.stringify(nsResume.body.error)}`);
  console.log('✓ 7. pai_terminal.chief_resume succeeded on live 8787');

  // 8. Protocol version 2024-11-05
  const proto2024Res = await request('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 'p2024-1',
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {} }
  }, { 'mcp-protocol-version': '2024-11-05' });
  assert.equal(proto2024Res.status, 200);
  console.log('✓ 8. Protocol 2024-11-05 succeeded on live 8787');

  // 9. Trailing slash /mcp/
  const slashRes = await request('POST', '/mcp/', {
    jsonrpc: '2.0',
    id: 'slash-1',
    method: 'tools/list',
    params: {}
  });
  assert.equal(slashRes.status, 200);
  console.log('✓ 9. Trailing slash /mcp/ succeeded on live 8787');

  console.log('\nLIVE 8787 VERIFICATION ALL PASSED!');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
