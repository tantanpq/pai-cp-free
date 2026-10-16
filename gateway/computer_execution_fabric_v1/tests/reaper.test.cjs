'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionRuntime } = require('../runtime/session-runtime.cjs');
const { SessionReaper } = require('../runtime/session-reaper.cjs');
const { FakePersistentAdapter } = require('./helpers/fake-adapter.cjs');

test('reaper treats TTL as resource hygiene and closes idle persistent sessions without semantic DONE', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-reaper-'));
  const runtime = new SessionRuntime({ rootDir, adapterFactory: s => new FakePersistentAdapter(s), fenceValidator: async () => true, operationAuthorizer: async () => ({ allowed:true }), now: () => '2026-09-21T00:00:00.000Z' });
  const opened = await runtime.open({ requestId:'req-reap',rootId:'root-reap',ownerHost:'HOME',claimId:'claim',fenceToken:'f',shellClass:'POWERSHELL',cwd:'/repo',effectClass:'NONE',sessionClass:'PERSISTENT',idleTimeoutMs:1000,openIdempotencyKey:'reap' });
  const reaper = new SessionReaper({ runtime, registry:runtime.registry, nowMs:() => Date.parse('2026-09-21T00:00:02.000Z') });
  const actions = await reaper.sweep();
  assert.equal(actions[0].action, 'CLOSE');
  assert.equal(runtime.registry.get(opened.session.sessionId).state, 'CLOSED');
});
