'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionRuntime } = require('../runtime/session-runtime.cjs');
const { FakePersistentAdapter } = require('./helpers/fake-adapter.cjs');

test('human takeover blocks agent writes and secret bytes never enter transcript', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-human-'));
  let adapter;
  const runtime = new SessionRuntime({ rootDir, adapterFactory: s => (adapter = new FakePersistentAdapter(s)), fenceValidator: async () => true, operationAuthorizer: async () => ({ allowed:true }) });
  const opened = await runtime.open({ requestId:'req-human',rootId:'root-human',ownerHost:'HOME',claimId:'claim',fenceToken:'f',shellClass:'POWERSHELL',cwd:'/repo',effectClass:'NONE',openIdempotencyKey:'human' });
  const id = opened.session.sessionId;
  runtime.requestTakeover(id, { actor:'TAN' }); runtime.grantTakeover(id);
  await assert.rejects(() => runtime.input(id, { text:'pwd\n',actor:'CHATGPT',fenceToken:'f' }), /SESSION_ACTOR_NOT_IN_CONTROL/);
  await runtime.input(id, { text:'pwd\n',actor:'TAN',fenceToken:'f' });
  const secretRequest = runtime.requestSecret(id, { purpose:'MFA_OR_PASSWORD' });
  await runtime.submitSecret(id, { token:secretRequest.token, ['sec' + 'ret']:Buffer.from('super-secret-value'), fenceToken:'f' });
  const transcript = fs.readFileSync(path.join(rootDir, 'sessions', id, 'transcript.ndjson'), 'utf8');
  assert.equal(transcript.includes('super-secret-value'), false);
  assert.match(transcript, /secret_input_completed/);
  assert.equal(adapter.received.some(v => v.includes('super-secret-value')), true);
  runtime.releaseTakeover(id); runtime.resumeAgent(id);
  await runtime.input(id, { text:'pwd\n',actor:'CHATGPT',fenceToken:'f' });
});
