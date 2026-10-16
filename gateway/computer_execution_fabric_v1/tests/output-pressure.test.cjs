'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionRuntime } = require('../runtime/session-runtime.cjs');
const { FakePersistentAdapter } = require('./helpers/fake-adapter.cjs');

test('bounded RAM truncates while disk spool retains full output and output_ref', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-pressure-'));
  const runtime = new SessionRuntime({ rootDir, adapterFactory: s => new FakePersistentAdapter(s), fenceValidator: async () => true, operationAuthorizer: async () => ({ allowed:true }) });
  const opened = await runtime.open({ requestId:'req-pressure',rootId:'root-pressure',ownerHost:'HOME',claimId:'claim',fenceToken:'f',shellClass:'POWERSHELL',cwd:'/repo',effectClass:'NONE',maxRamBytes:4096,openIdempotencyKey:'pressure' });
  const id = opened.session.sessionId;
  await runtime.input(id, { text: 'spam 12000\n', actor:'CHATGPT', fenceToken:'f' });
  const view = runtime.read(id, { cursor: 0, maxBytes: 1024 });
  assert.equal(view.truncated, true);
  assert.equal(view.output.length, 1024);
  assert.ok(view.outputBytes >= 12000);
  assert.match(view.outputRef, /^pai-output:\/\//);
  const disk = runtime.readOutputRef(id, { start: 0, maxBytes: 13000 });
  assert.ok(disk.data.length >= 12000);
});
