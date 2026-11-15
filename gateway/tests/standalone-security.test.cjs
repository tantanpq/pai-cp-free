'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createServer, configFromEnv } = require('../server.standalone.cjs');
const TOKEN = require('node:crypto').randomBytes(32).toString('hex');
const AUTH = { authorization: `Bearer ${TOKEN}` };
const ORIGIN = 'https://client.example';
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
const call = (name, arguments_ = {}) => rpc('tools/call', { name, arguments: arguments_ });

function isolatedModule(relativeFile, { platform = process.platform, env = {}, fsOverrides = {}, spawn } = {}) {
  const filename = path.resolve(__dirname, relativeFile);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), Buffer,
    process: { platform, env },
    require: name => name === 'node:fs' ? { ...fs, ...fsOverrides }
      : name === 'node:child_process' && spawn ? { spawn } : localRequire(name)
  }, { filename });
  return module.exports;
}

test('token file rejects symlinks/reparse links and non-regular files before open', () => {
  for (const platform of ['win32', 'linux']) {
    for (const [link, regular] of [[true, true], [true, false], [false, false]]) {
      let opened = false;
      const { readBearerToken } = isolatedModule('../standalone-security.cjs', { platform, fsOverrides: {
        lstatSync: () => ({ isSymbolicLink: () => link, isFile: () => regular, mode: 0o600 }),
        openSync: () => { opened = true; throw new Error('must not open'); }
      } });
      assert.throws(() => readBearerToken({ CHIEF_MCP_BEARER_TOKEN_FILE: 'fixture-token' }), /^Error: CHIEF_MCP_TOKEN_FILE_INVALID$/);
      assert.equal(opened, false);
    }
  }
});

test('token file enforces POSIX owner-only permissions before and after open', () => {
  for (const phase of ['lstat', 'fstat']) {
    for (const bit of [0o040, 0o020, 0o010, 0o004, 0o002, 0o001]) {
      let opened = false, closed = false;
      const stat = mode => ({ isSymbolicLink: () => false, isFile: () => true, size: TOKEN.length, mode });
      const { readBearerToken } = isolatedModule('../standalone-security.cjs', { platform: 'linux', fsOverrides: {
        lstatSync: () => stat(0o600 | (phase === 'lstat' ? bit : 0)),
        openSync: () => { opened = true; return 7; },
        fstatSync: () => stat(0o600 | (phase === 'fstat' ? bit : 0)),
        readSync: () => assert.fail('insecure file must not be read'),
        closeSync: () => { closed = true; }
      } });
      assert.throws(() => readBearerToken({ CHIEF_MCP_BEARER_TOKEN_FILE: 'fixture-token' }), /CHIEF_MCP_TOKEN_FILE_INVALID/);
      assert.equal(opened, phase === 'fstat');
      assert.equal(closed, opened);
    }
  }
});

test('token file uses O_NOFOLLOW when available and leaves Windows ACLs to the operator', () => {
  for (const platform of ['linux', 'win32']) {
    for (const nofollow of [0, 0x20000]) {
      let closed = false;
      const stat = { isSymbolicLink: () => false, isFile: () => true, size: TOKEN.length, mode: platform === 'win32' ? 0o666 : 0o600 };
      const { readBearerToken } = isolatedModule('../standalone-security.cjs', { platform, fsOverrides: {
        constants: { ...fs.constants, O_NOFOLLOW: nofollow },
        lstatSync: () => stat,
        openSync: (_, flags) => { assert.equal(flags, fs.constants.O_RDONLY | nofollow); return 7; },
        fstatSync: () => stat,
        readSync: (_, buffer) => buffer.write(TOKEN),
        closeSync: () => { closed = true; }
      } });
      assert.equal(readBearerToken({ CHIEF_MCP_BEARER_TOKEN_FILE: 'fixture-token' }), TOKEN);
      assert.equal(closed, true);
    }
  }
});

test('standalone configuration deletes the process bearer after hashing without changing authorization', () => {
  const env = { CHIEF_MCP_BEARER_TOKEN: TOKEN, PAI_GATEWAY_DATA: path.resolve(__dirname, '..', '.security-fixtures') };
  const { configFromEnv: isolatedConfig } = isolatedModule('../server.standalone.cjs', { env });
  const cfg = isolatedConfig();
  assert.equal(Object.hasOwn(env, 'CHIEF_MCP_BEARER_TOKEN'), false);
  assert.deepEqual(cfg.security.tokenDigest, require('node:crypto').createHash('sha256').update(TOKEN).digest());
  const { checkRpc } = require('../standalone-security.cjs');
  const policy = new Set(['chief_resume']);
  assert.equal(checkRpc({ headers: AUTH }, call('chief_resume'), cfg, policy), null);
  assert.equal(checkRpc({ headers: {} }, call('chief_resume'), cfg, policy).status, 401);
});

test('fabric child environment strips inherited and overridden bearer credentials', () => {
  for (const platform of ['linux', 'win32']) {
    const env = { CHIEF_MCP_BEARER_TOKEN: TOKEN, CHIEF_MCP_BEARER_TOKEN_FILE: 'parent-fixture-token', FIXTURE_KEEP: 'parent' };
    const overrides = { CHIEF_MCP_BEARER_TOKEN: TOKEN + '-override', CHIEF_MCP_BEARER_TOKEN_FILE: 'session-fixture-token', FIXTURE_KEEP: 'session' };
    if (platform === 'win32') Object.assign(overrides, { chief_mcp_bearer_token: TOKEN, Chief_Mcp_Bearer_Token_File: 'alias-fixture-token' });
    let spawned;
    const { createPowerShellPipeAdapter } = isolatedModule('../computer_execution_fabric_v1/runtime/powershell-adapter.cjs', {
      platform, env, spawn: (_, __, options) => {
        spawned = options;
        return { pid: 7, stdin: { setDefaultEncoding() {}, write() {} }, stdout: { on() {} }, stderr: { on() {} }, on() {} };
      }
    });
    createPowerShellPipeAdapter().start({ cwd: __dirname, env: overrides });
    assert.ok(spawned);
    assert.equal(Object.keys(spawned.env).some(key => /^CHIEF_MCP_BEARER_TOKEN(?:_FILE)?$/i.test(key)), false);
    assert.equal(spawned.env.FIXTURE_KEEP, 'session');
    assert.ok(spawned.env.NODE_OPTIONS.includes('runtime-fs-guard.cjs'));
    assert.ok(spawned.env.PYTHONPATH);
    assert.equal(spawned.windowsHide, true);
    assert.equal(env.CHIEF_MCP_BEARER_TOKEN, TOKEN);
    assert.equal(overrides.CHIEF_MCP_BEARER_TOKEN, TOKEN + '-override');
  }
});

async function fixture(t, extra = {}) {
  const parent = path.resolve(__dirname, '..', '.security-fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'http-'));
  const env = { PORT: '0', PAI_GATEWAY_CANARY: '1', PAI_GATEWAY_DATA: root,
    CHIEF_BRIDGE_DB_PATH: path.join(root, 'isolated.sqlite'),
    PAI_RUNTIME_POINTER: path.join(root, 'absent-pointer.json'),
    CHIEF_MCP_BEARER_TOKEN: TOKEN, ...extra };
  const app = createServer({ env });
  let dispatched = 0, executed = 0;
  const originalRpc = app.bridge.rpc;
  app.bridge.rpc = (...args) => { dispatched++; return originalRpc(...args); };
  app.bridge.federationCore.handleActionRun = async () => { executed++; return { status: 'FIXTURE_ONLY' }; };
  app.bridge.federationCore.handleCognitionRun = async () => { executed++; return { status: 'FIXTURE_ONLY' }; };
  app.bridge.federationCore.tasks.set('fixture-task', { taskId: 'fixture-task', status: 'running', payload: { value: 'original' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const port = app.server.address().port;
  const request = (payload, headers = {}, method = 'POST', url = '/mcp') => new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload);
    const pairs = Object.entries({ host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }), ...headers })
      .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).flatMap(item => [name, item]));
    const req = http.request({ host: '127.0.0.1', port, path: url, method, agent: false,
      headers: pairs }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const snapshot = (includeDispatch = true) => JSON.stringify({
    tables: app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]),
    tasks: [...app.bridge.federationCore.tasks], ledger: [...app.bridge.federationCore.idempotencyLedger],
    sessions: [...app.bridge.federationCore.sessionRuntime.sessions], ...(includeDispatch ? { dispatched } : {}), executed
  });
  return { ...app, env, root, port, request, snapshot, executed: () => executed };
}

test('fail-closed configuration: read-only default, explicit write token and exec opt-in', () => {
  assert.equal(configFromEnv({}).profile, 'READ_ONLY');
  for (const profile of ['GOVERNED_RW', 'FEDERATION_RW']) {
    assert.throws(() => configFromEnv({ CHIEF_MCP_PUBLIC_PROFILE: profile }), /WRITE_REQUIRES_TOKEN/);
    assert.equal(configFromEnv({ CHIEF_MCP_PUBLIC_PROFILE: profile, CHIEF_MCP_BEARER_TOKEN: TOKEN }).security.allowExec, false);
  }
  for (const bad of ['', '*', 'https://client.example/', 'null', 'https://client.example,']) {
    assert.throws(() => configFromEnv({ CHIEF_MCP_ALLOWED_ORIGINS: bad }), /ALLOWED_ORIGINS_INVALID/);
  }
  for (const bad of ['', '*', 'localhost', 'localhost:0', 'localhost:65536', 'localhost:8787/path', 'user@localhost:8787']) {
    assert.throws(() => configFromEnv({ CHIEF_MCP_ALLOWED_HOSTS: bad }), /ALLOWED_HOSTS_INVALID/);
  }
  assert.throws(() => configFromEnv({ CHIEF_MCP_ALLOW_EXEC: 'true' }), /ALLOW_EXEC_INVALID/);
  assert.throws(() => configFromEnv({ CHIEF_MCP_ALLOW_EXEC: '1', CHIEF_MCP_BEARER_TOKEN: TOKEN }), /EXEC_REQUIRES_WRITE_PROFILE/);
  for (const value of ['', 'short', `${TOKEN}\n`, 'x'.repeat(4097)]) assert.throws(() => configFromEnv({ CHIEF_MCP_BEARER_TOKEN: value }), /TOKEN_INVALID/);
});

test('untrusted browser Origins, including null, fail before any RPC effects', async t => {
  const f = await fixture(t);
  const before = f.snapshot();
  for (const origin of ['https://attacker.example', 'null', ORIGIN]) {
    const res = await f.request(call('chief_resume'), { ...AUTH, origin });
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(f.snapshot(), before);
});

test('Host rejects DNS rebinding, wrong port, forwarded trust and duplicate headers', async t => {
  const f = await fixture(t);
  const before = f.snapshot();
  for (const host of ['rebind.example:' + f.port, '127.0.0.1:' + (f.port === 65535 ? 1 : f.port + 1), 'localhost', 'localhost.:' + f.port, 'user@localhost:' + f.port, ['localhost:' + f.port, 'rebind.example:' + f.port]]) {
    const res = await f.request(call('chief_resume'), { ...AUTH, host, 'x-forwarded-host': 'localhost:' + f.port, 'x-forwarded-for': '127.0.0.1' });
    assert.equal(res.status, 403);
  }
  assert.equal(f.snapshot(), before);
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal((await f.request(rpc('tools/list'), { host: `${host}:${f.port}` })).status, 200);
});

test('missing, invalid, malformed or replayed session headers cannot authorize calls', async t => {
  const f = await fixture(t);
  const before = f.snapshot();
  for (const headers of [{}, { authorization: `Bearer ${TOKEN}x` }, { authorization: 'Basic ' + TOKEN }, { authorization: `Bearer  ${TOKEN}` }, { authorization: 'Bearer ' + 'x'.repeat(200) }, { 'mcp-session-id': f.cfg.sessionId }, { authorization: [`Bearer ${TOKEN}`, 'Bearer forged'] }]) {
    const res = await f.request(call('chief_resume'), headers);
    assert.equal(res.status, Array.isArray(headers.authorization) ? 403 : 401);
    if (res.status === 401) assert.equal(res.headers['www-authenticate'], 'Bearer');
  }
  assert.equal(f.snapshot(), before);
});

test('no configured token leaves discovery usable and all calls unauthorized', async t => {
  const f = await fixture(t, { CHIEF_MCP_BEARER_TOKEN: undefined });
  const before = f.snapshot();
  assert.equal((await f.request(call('chief_resume'), AUTH)).status, 401);
  assert.equal(f.snapshot(), before);
  assert.equal((await f.request(rpc('tools/list'))).status, 200);
});

test('CORS preflight echoes only an exact allowed Origin with bounded headers', async t => {
  const f = await fixture(t, { CHIEF_MCP_ALLOWED_ORIGINS: ORIGIN });
  const before = f.snapshot();
  const preflight = { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type, MCP-Session-ID' };
  for (const origin of ['https://attacker.example', `${ORIGIN}.attacker.example`, `${ORIGIN}/`, 'null']) {
    const res = await f.request(undefined, { ...preflight, origin }, 'OPTIONS');
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  for (const forged of [{ 'access-control-request-method': 'DELETE' }, { 'access-control-request-headers': 'x-forged' }]) {
    const rejected = await f.request(undefined, { ...preflight, ...forged }, 'OPTIONS');
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  }
  const res = await f.request(undefined, preflight, 'OPTIONS');
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  assert.ok(!res.headers['access-control-allow-headers'].includes('*'));
  assert.equal(f.snapshot(), before);
  const positive = await f.request(call('chief_resume'), { ...AUTH, origin: ORIGIN });
  assert.equal(positive.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(positive.headers.vary, 'Origin');
  assert.ok(positive.body.result);
});

test('method, simple-request content types and malformed envelopes are rejected without effects', async t => {
  const f = await fixture(t);
  const before = f.snapshot();
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await f.request(call('chief_resume'), AUTH, method)).status, 405);
  assert.equal((await f.request(call('chief_resume'), AUTH, 'POST', '/health')).status, 405);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp', 'application/json-evil', '']) {
    assert.equal((await f.request(call('chief_resume'), { ...AUTH, 'content-type': type })).status, 415);
  }
  for (const payload of ['{', [], null, 'true', { method: 'tools/call' }]) assert.equal((await f.request(payload, AUTH)).status, 400);
  assert.equal(f.snapshot(), before);
});

test('READ_ONLY lists the original read catalog and refuses every write and execution alias', async t => {
  const f = await fixture(t);
  const list = await f.request(rpc('tools/list', { mode: 'ALL' }));
  assert.deepEqual(list.body.result.tools.map(t => t.name), ['chief_resume', 'chief_status']);
  assert.ok(f.bridge.publicToolDefinitions.every(t => t.annotations.readOnlyHint));
  const before = f.snapshot();
  for (const name of ['chief_turn', 'chief_prepare_handoff', 'chief_correct_memory', 'chief_admit_committed_work', 'pai_action_run', 'pai_cognition_run', 'pai_cancel', 'chief_work_request', 'pai_terminal', 'terminal', 'pai-terminal', '', 'pai_terminal:pai_action_run', 'pai-terminal.pai_action_run', 'pai_terminal:pai_terminal:pai_action_run', 'sys.exec', 'powershell', 'shell', 'unknown']) {
    const res = await f.request(call(name), AUTH);
    assert.equal(res.body.error.data.code, 'BRIDGE_TOOL_DENIED', name);
  }
  assert.equal(f.snapshot(), before);
});

test('alternate task mutation RPCs require bearer and write profile; unknown methods have no effects', async t => {
  const f = await fixture(t);
  const before = f.snapshot();
  for (const method of ['tasks/update', 'tasks/cancel']) {
    const payload = rpc(method, { taskId: 'fixture-task', payload: { value: 'forged' } });
    assert.equal((await f.request(payload)).status, 401);
    assert.equal((await f.request(payload, AUTH)).status, 403);
  }
  assert.equal((await f.request(rpc('tasks/get', { taskId: 'fixture-task' }))).status, 401);
  assert.equal((await f.request(rpc('unknown/mutate'), AUTH)).body.error.code, -32601);
  assert.equal(f.snapshot(), before);
});

test('authorized read works in modern and legacy protocols with namespace/header compatibility', async t => {
  const f = await fixture(t);
  for (const version of ['2026-07-28', '2025-03-26', '2024-11-05']) {
    const init = await f.request(rpc('initialize', { protocolVersion: version }));
    assert.equal(init.body.result.protocolVersion, version);
    const result = await f.request(call('pai_terminal.chief_resume'), { ...AUTH, 'mcp-protocol-version': version, 'mcp-method': 'tools/call', 'mcp-name': 'chief_resume' });
    assert.equal(result.status, 200);
    assert.equal(result.body.result.structuredContent.result.sessionId, f.cfg.sessionId);
    if (version !== '2026-07-28') assert.equal(result.headers['mcp-session-id'], f.cfg.sessionId);
  }
  assert.equal((await f.request(rpc('tools/get', { name: 'chief_resume' }))).status, 200);
  assert.equal((await f.request(undefined, {}, 'GET', '/health')).body.profile, 'READ_ONLY');
  assert.equal((await f.request(undefined, {}, 'HEAD', '/mcp')).status, 200);
});

test('write profiles omit exec tools and block execution aliases unless separately opted in', async t => {
  for (const profile of ['GOVERNED_RW', 'FEDERATION_RW']) {
    const f = await fixture(t, { CHIEF_MCP_PUBLIC_PROFILE: profile });
    assert.ok(!f.bridge.publicToolDefinitions.some(t => ['pai_action_run', 'pai_cognition_run'].includes(t.name)));
    const list = await f.request(rpc('tools/list'));
    assert.ok(!list.body.result.tools.some(t => t.name === 'pai_action_run'));
    const before = f.snapshot();
    for (const name of ['pai_action_run', 'chief_work_request', 'terminal', 'pai_cognition_run']) {
      assert.equal((await f.request(call(name, { action_payload: { operation: 'ADMIN_SUBMIT' } }), AUTH)).body.error.data.code, 'BRIDGE_TOOL_DENIED');
    }
    assert.equal(f.snapshot(), before);
  }
});

test('explicit exec opt-in still requires bearer; authorized aliases reach only fixture spies', async t => {
  const f = await fixture(t, { CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW', CHIEF_MCP_ALLOW_EXEC: '1' });
  const before = f.snapshot();
  assert.equal((await f.request(call('pai_action_run'))).status, 401);
  assert.equal(f.snapshot(), before);
  assert.ok((await f.request(rpc('tools/list'))).body.result.tools.some(t => t.name === 'pai_action_run'));
  for (const name of ['pai_action_run', 'chief_work_request', 'terminal', 'pai_terminal', 'pai-terminal', '', 'pai_terminal:pai_action_run', 'pai_cognition_run']) {
    assert.ok((await f.request(call(name), AUTH)).body.result, name);
  }
  assert.equal(f.executed(), 8);
});

test('rejected writes do not consume request IDs, revision fences or receipt keys', async t => {
  const f = await fixture(t, { CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW' });
  const input = { requestId: 'same-after-rejection', expectedRevision: 1, summary: 'Isolated handoff fixture.' };
  const before = f.snapshot();
  assert.equal((await f.request(call('chief_prepare_handoff', input))).status, 401);
  assert.equal((await f.request(call('chief_prepare_handoff', input), { ...AUTH, origin: 'https://attacker.example' })).status, 403);
  assert.equal(f.snapshot(), before);
  const accepted = await f.request(call('chief_prepare_handoff', input), AUTH);
  assert.equal(accepted.body.result.structuredContent.result.revision, 2);
  const tables = () => JSON.stringify(f.db.prepare('SELECT * FROM chief_bridge_receipts ORDER BY receipt_key').all());
  const receipts = tables();
  const replay = await f.request(call('chief_prepare_handoff', input), AUTH);
  assert.deepEqual(replay.body.result.structuredContent.receipt, accepted.body.result.structuredContent.receipt);
  assert.deepEqual(replay.body.result.structuredContent.result.checkpoint, accepted.body.result.structuredContent.result.checkpoint);
  assert.equal(tables(), receipts);
  assert.equal(f.db.prepare('SELECT revision FROM sessions').get().revision, 2);
});

test('protocol/header failures have no effects; authorized task updates remain usable', async t => {
  const f = await fixture(t, { CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW' });
  const before = f.snapshot();
  for (const headers of [{ 'mcp-protocol-version': 'unsupported' }, { 'mcp-method': 'tools/list' }, { 'mcp-name': 'chief_status' }]) {
    assert.equal((await f.request(call('chief_resume'), { ...AUTH, ...headers })).status, 400);
  }
  assert.equal(f.snapshot(), before);
  const updated = await f.request(rpc('tasks/update', { taskId: 'fixture-task', payload: { value: 'authorized' } }), AUTH);
  assert.equal(updated.body.result.task.payload.value, 'authorized');
  const cancelled = await f.request(rpc('tasks/cancel', { taskId: 'fixture-task' }), AUTH);
  assert.equal(cancelled.body.result.task.status, 'cancelled');
});

test('fixture token file authentication, invalid sources and exact custom Host policy', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'fixture-token.txt');
  fs.writeFileSync(file, TOKEN + '\r\n', { mode: 0o600 });
  const cfg = configFromEnv({ ...f.env, CHIEF_MCP_BEARER_TOKEN: undefined, CHIEF_MCP_BEARER_TOKEN_FILE: file });
  assert.deepEqual(cfg.security.tokenDigest, f.cfg.security.tokenDigest);
  assert.throws(() => configFromEnv({ ...f.env, CHIEF_MCP_BEARER_TOKEN_FILE: file }), /TOKEN_SOURCE_AMBIGUOUS/);
  assert.throws(() => configFromEnv({ ...f.env, CHIEF_MCP_BEARER_TOKEN: undefined, CHIEF_MCP_BEARER_TOKEN_FILE: path.join(f.root, 'missing') }), /TOKEN_FILE_INVALID/);
  const g = await fixture(t, { CHIEF_MCP_BEARER_TOKEN: undefined, CHIEF_MCP_BEARER_TOKEN_FILE: file, CHIEF_MCP_ALLOWED_HOSTS: 'proxy.example:443' });
  assert.equal((await g.request(call('chief_resume'), AUTH)).status, 403);
  assert.ok((await g.request(call('chief_resume'), { ...AUTH, host: 'proxy.example:443' })).body.result);
});

test('authorized but rejected synchronous session calls leave durable state unchanged', async t => {
  const f = await fixture(t, { CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW' });
  const before = f.snapshot(false);
  for (const [name, args] of [
    ['chief_prepare_handoff', {}], ['chief_correct_memory', {}],
    ['chief_prepare_handoff', { requestId: 'stale-fixture', expectedRevision: 9, summary: 'Valid text.' }]
  ]) {
    assert.ok((await f.request(call(name, args), AUTH)).body.error);
    assert.equal(f.snapshot(false), before);
  }
});

for (const [label, modulePath] of [
  ['gateway', '../chief_chat_bridge_v1/src/seed-cli'],
  ['root seed', '../../seed/seed-cli']
]) test(`${label} CLI sends env/file bearer to the isolated HTTP endpoint`, async t => {
  const f = await fixture(t);
  const { postJson } = require(modulePath);
  const endpoint = `http://127.0.0.1:${f.port}/mcp`;
  await assert.rejects(postJson(endpoint, call('chief_resume'), { env: {} }), /SEED_GATEWAY_HTTP_401/);
  assert.ok((await postJson(endpoint, call('chief_resume'), { env: { CHIEF_MCP_BEARER_TOKEN: TOKEN } })).result);
  const file = path.join(f.root, 'cli-fixture-token.txt');
  fs.writeFileSync(file, TOKEN + '\n', { mode: 0o600 });
  assert.ok((await postJson(endpoint, call('chief_resume'), { env: { CHIEF_MCP_BEARER_TOKEN_FILE: file } })).result);
});

test('sys.exec payloads and terminal aliases require authenticated execution opt-in', async t => {
  const input = { operation: 'RUN', command: 'fixture-inert', selected_provider_tool: 'sys.exec',
    action_payload: { operation: 'RUN', command: 'fixture-inert' } };
  for (const extra of [{ CHIEF_MCP_PUBLIC_PROFILE: 'READ_ONLY' }, { CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW' },
    { CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW', CHIEF_MCP_ALLOW_EXEC: '1' }]) {
    const f = await fixture(t, extra);
    const before = f.snapshot();
    assert.equal((await f.request(call('pai_action_run', input))).status, 401);
    assert.equal(f.snapshot(), before);
    assert.equal((await f.request(call('sys.exec', input), AUTH)).body.error.data.code, 'BRIDGE_TOOL_DENIED');
    if (extra.CHIEF_MCP_ALLOW_EXEC !== '1') {
      for (const name of ['pai_action_run', 'chief_work_request', 'terminal', 'pai_terminal:pai_action_run']) {
        assert.equal((await f.request(call(name, input), AUTH)).body.error.data.code, 'BRIDGE_TOOL_DENIED');
      }
      assert.equal(f.snapshot(), before);
    } else {
      assert.ok((await f.request(call('pai_action_run', input), AUTH)).body.result);
      assert.equal(f.executed(), 1);
    }
  }
});
