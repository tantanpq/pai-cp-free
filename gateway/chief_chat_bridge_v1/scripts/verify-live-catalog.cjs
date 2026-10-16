'use strict';

const http = require('http');

async function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({
      host: '127.0.0.1',
      port: 8787,
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  console.log('--- 1. server/discover ---');
  const disc = await call('server/discover');
  console.log('serverInfo:', disc.body.result?.serverInfo?.name);
  console.log('toolsCount:', disc.body.result?.toolsCount);
  console.log('governedWorkOperation:', disc.body.result?.capabilities?.tools?.governedWorkOperation);

  const probes = [
    { name: 'no params', params: {} },
    { name: 'profile: BOOT_DISCOVERY', params: { profile: 'BOOT_DISCOVERY' } },
    { name: 'intentClass: STATUS', params: { intentClass: 'STATUS' } },
    { name: 'intentClass: BUILD', params: { intentClass: 'BUILD' } },
    { name: 'intentClass: TERMINAL_COMMAND', params: { intentClass: 'TERMINAL_COMMAND' } },
    { name: 'mode: ALL', params: { mode: 'ALL' } },
    { name: 'profile: STATIC_ALL', params: { profile: 'STATIC_ALL' } },
    { name: 'fullCatalogOverride: true', params: { fullCatalogOverride: true } }
  ];

  for (const p of probes) {
    const res = await call('tools/list', p.params);
    const tools = res.body.result?.tools || [];
    const names = tools.map(t => t.name);
    console.log(`Probe [${p.name}]: count=${tools.length}, has_pai_action_run=${names.includes('pai_action_run')}, names=[${names.join(', ')}]`);
  }
})();
