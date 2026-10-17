#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const { URL } = require('node:url');
const uplink = require('./seed-uplink');

function usage() {
  return 'Usage: node src/seed-cli.js <encode|decode|request|submit> <value> [--confirm] [--endpoint http://127.0.0.1:8787/mcp]';
}
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function postJson(endpoint, payload) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('SEED_ENDPOINT_MUST_BE_LOOPBACK_HTTP');
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || 80, path: `${url.pathname}${url.search}`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      let raw = '', bytes = 0; response.setEncoding('utf8'); response.on('error', reject); response.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 1024*1024) { response.destroy(new Error('SEED_GATEWAY_RESPONSE_LIMIT')); return; } raw += chunk; }); response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`SEED_GATEWAY_HTTP_${response.statusCode}`));
        try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error('SEED_GATEWAY_INVALID_JSON')); }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('SEED_GATEWAY_TIMEOUT_OUTCOME_UNKNOWN'))); request.on('error', reject); request.end(body);
  });
}
async function run(argv, { readFile = file => fs.readFileSync(file, 'utf8'), submit = postJson } = {}) {
  const [command, value, ...rest] = argv;
  if (!command || !value) throw new Error(usage());
  if (command === 'encode') return { code: uplink.encode(JSON.parse(readFile(value))) };
  if (command === 'decode') return uplink.decode(value);
  if (command === 'request') return uplink.prepareGovernedRequest(value);
  if (command !== 'submit') throw new Error(usage());
  if (!rest.includes('--confirm')) return { status: 'NEEDS_LOCAL_USER_CONFIRMATION' };
  const endpointIndex = rest.indexOf('--endpoint');
  const endpoint = endpointIndex >= 0 ? rest[endpointIndex + 1] : 'http://127.0.0.1:8787/mcp';
  if (!endpoint) throw new Error('SEED_ENDPOINT_REQUIRED');
  const imported = await uplink.importSeed({ code: value, confirm: true, submit: request => submit(endpoint, { jsonrpc: '2.0', id: request.request_id, method: 'tools/call', params: { name: 'pai_action_run', arguments: request } }), readResult: run_id => submit(endpoint, { jsonrpc:'2.0', id:'seed-result:'+run_id, method:'tools/call', params:{name:'pai_result',arguments:{run_id}} }) });
  return imported;
}
if (require.main === module) run(process.argv.slice(2)).then(value => { print(value); if (['SUBMISSION_FAILED','REJECTED_BY_EXISTING_GOVERNOR','SUBMISSION_UNKNOWN','SUBMISSION_UNVERIFIED','EXECUTION_FAILURE_REPORTED'].includes(value.status)) process.exitCode = 1; }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { postJson, run, usage };
