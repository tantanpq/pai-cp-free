'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionRuntime } = require('../runtime/session-runtime.cjs');
const { FakePersistentAdapter } = require('./helpers/fake-adapter.cjs');

const make = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-session-test-'));
  const runtime = new SessionRuntime({ rootDir, adapterFactory: spec => new FakePersistentAdapter(spec), fenceValidator: async (_meta, token) => token === 'fence-A', operationAuthorizer: async () => ({ allowed:true }) });
  return { rootDir, runtime };
};
const spec = (extra = {}) => ({ requestId: 'req-1', rootId: 'root-1', ownerHost: 'HOME_HOST_01', claimId: 'claim-1', fenceToken: 'fence-A', shellClass: 'POWERSHELL', cwd: '/repo', allowedRoots: ['/repo'], effectClass: 'INTERNAL_REVERSIBLE', sessionClass: 'PERSISTENT', openIdempotencyKey: 'open-1', ...extra });

test('persistent session preserves cwd/env/REPL state and cursor reads are incremental', async () => {
  const { runtime } = make();
  const opened = await runtime.open(spec());
  const id = opened.session.sessionId;
  await runtime.input(id, { text: 'cd /repo/sub\nsetenv PAI_TEST=alive\n', fenceToken: 'fence-A', actor: 'CHATGPT' });
  const first = runtime.read(id, { cursor: 0, maxBytes: 4096 });
  assert.match(first.output, /cwd=\/repo\/sub/);
  const cursor = first.nextCursor;
  await runtime.input(id, { text: 'pwd\ngetenv PAI_TEST\nrepl start\nrepl one\nrepl two\n', fenceToken: 'fence-A', actor: 'CHATGPT' });
  const second = runtime.read(id, { cursor, maxBytes: 4096 });
  assert.match(second.output, /\/repo\/sub/);
  assert.match(second.output, /alive/);
  assert.match(second.output, /repl#1:one/);
  assert.match(second.output, /repl#2:two/);
  assert.equal(second.output.includes('cwd=/repo/sub'), false);
  assert.match(second.outputRef, /^pai-output:\/\//);
});

test('wrong and stale fence are rejected for input', async () => {
  const { runtime } = make();
  const opened = await runtime.open(spec({ openIdempotencyKey: 'open-fence' }));
  await assert.rejects(() => runtime.input(opened.session.sessionId, { text: 'pwd\n', fenceToken: 'wrong', actor: 'CHATGPT' }), /SESSION_FENCE_MISMATCH/);
  const staleRuntime = new SessionRuntime({ rootDir: make().rootDir, adapterFactory: s => new FakePersistentAdapter(s), fenceValidator: async () => false, operationAuthorizer: async () => ({ allowed:true }) });
  const stale = await staleRuntime.open(spec({ openIdempotencyKey: 'open-stale' }));
  await assert.rejects(() => staleRuntime.input(stale.session.sessionId, { text: 'pwd\n', fenceToken: 'fence-A', actor: 'CHATGPT' }), /SESSION_FENCE_STALE/);
});

test('open idempotency deduplicates exact request and rejects drift', async () => {
  const { runtime } = make();
  const a = await runtime.open(spec({ openIdempotencyKey: 'same-open' }));
  const b = await runtime.open(spec({ openIdempotencyKey: 'same-open' }));
  assert.equal(b.status, 'DEDUPLICATED');
  assert.equal(a.session.sessionId, b.session.sessionId);
  await assert.rejects(() => runtime.open(spec({ openIdempotencyKey: 'same-open', cwd: '/different' })), /SESSION_OPEN_IDEMPOTENCY_CONFLICT/);
});

test('operation authorization is fail-closed for every interactive input', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-authz-test-'));
  const runtime = new SessionRuntime({ rootDir, adapterFactory: s => new FakePersistentAdapter(s), fenceValidator: async () => true, operationAuthorizer: async () => ({ allowed:false, code:'TEST_POLICY_DENIED' }) });
  const opened = await runtime.open(spec({ openIdempotencyKey:'authz-deny' }));
  await assert.rejects(() => runtime.input(opened.session.sessionId, { text:'pwd\n', fenceToken:'fence-A', actor:'CHATGPT' }), /TEST_POLICY_DENIED/);
});

test('session snapshot captures bounded semantic state without environment values', async () => {
  const { runtime } = make();
  const opened = await runtime.open(spec({ openIdempotencyKey:'snapshot' }));
  const id = opened.session.sessionId;
  await runtime.input(id, { text:'cd /repo/snap\nsetenv SECRETISH=value\nrepl start\nrepl x\n', fenceToken:'fence-A', actor:'CHATGPT' });
  const snap = await runtime.snapshot(id);
  assert.equal(snap.snapshot.cwd, '/repo/snap');
  assert.ok(snap.snapshot.envKeys.includes('SECRETISH'));
  assert.equal(JSON.stringify(snap).includes('value'), false);
});
