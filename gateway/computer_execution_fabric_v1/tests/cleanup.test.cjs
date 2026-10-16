'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionRuntime } = require('../runtime/session-runtime.cjs');
const { FakePersistentAdapter } = require('./helpers/fake-adapter.cjs');

test('close is idempotent, removes workspace, retains receipts/transcript/spool', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-cleanup-'));
  const runtime = new SessionRuntime({ rootDir, adapterFactory: s => new FakePersistentAdapter(s), fenceValidator: async () => true, operationAuthorizer: async () => ({ allowed:true }) });
  const opened = await runtime.open({ requestId:'req-close',rootId:'root-close',ownerHost:'HOME',claimId:'claim',fenceToken:'f',shellClass:'POWERSHELL',cwd:'/repo',effectClass:'NONE',openIdempotencyKey:'close' });
  const id = opened.session.sessionId;
  const before = runtime.status(id);
  const workspace = runtime.registry.get(id).workspaceDir;
  fs.writeFileSync(path.join(workspace, 'temp.txt'), 'temp');
  const first = await runtime.close(id, { fenceToken:'f' });
  assert.equal(first.status, 'CLOSED');
  assert.equal(fs.existsSync(workspace), false);
  const meta = runtime.registry.get(id);
  assert.equal(meta.cleanupState, 'CLOSED_CLEANUP_UNVERIFIED');
  assert.equal(fs.existsSync(path.join(meta.storageDir, 'transcript.ndjson')), true);
  assert.equal(fs.existsSync(path.join(meta.storageDir, 'receipts')), true);
  const second = await runtime.close(id, { fenceToken:'f' });
  assert.equal(second.idempotent, true);
});

test('spooled output remains readable after session close', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-closed-output-'));
  const runtime = new SessionRuntime({ rootDir, adapterFactory:s=>new FakePersistentAdapter(s), fenceValidator:async()=>true, operationAuthorizer:async()=>({allowed:true}) });
  const opened = await runtime.open({ requestId:'req-out',rootId:'root-out',ownerHost:'HOME',claimId:'claim',fenceToken:'f',shellClass:'POWERSHELL',cwd:'/repo',effectClass:'NONE',openIdempotencyKey:'out' });
  const id = opened.session.sessionId;
  await runtime.input(id,{text:'repl start\nrepl persisted\n',actor:'CHATGPT',fenceToken:'f'});
  await runtime.close(id,{fenceToken:'f'});
  const read = runtime.read(id,{cursor:0,maxBytes:4096});
  assert.match(read.output,/repl#1:persisted/);
  assert.equal(read.state,'CLOSED');
});

test('runtime reports verified cleanup when process-tree binding proves owned process death', async () => {
  const { ProcessTreeManager } = require('../runtime/process-tree-manager.cjs');
  const killed = [];
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-verified-cleanup-'));
  const runtime = new SessionRuntime({
    rootDir,
    adapterFactory:s=>new FakePersistentAdapter(s),
    fenceValidator:async()=>true,
    operationAuthorizer:async()=>({allowed:true}),
    processTreeFactory:()=>new ProcessTreeManager({ terminate:async pid=>killed.push(pid), verifyDead:async()=>true })
  });
  const opened = await runtime.open({ requestId:'req-vclean',rootId:'root-vclean',ownerHost:'HOME',claimId:'claim',fenceToken:'f',shellClass:'POWERSHELL',cwd:'/repo',effectClass:'NONE',openIdempotencyKey:'vclean' });
  const result = await runtime.close(opened.session.sessionId,{fenceToken:'f'});
  assert.equal(result.session.cleanupState,'CLOSED_AND_FLUSHED');
  assert.deepEqual(killed,[4242]);
});

test('receipt remains readable after close and cannot imply semantic DONE', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-receipt-read-'));
  const runtime = new SessionRuntime({ rootDir, adapterFactory:s=>new FakePersistentAdapter(s), fenceValidator:async()=>true, operationAuthorizer:async()=>({allowed:true}) });
  const opened = await runtime.open({ requestId:'req-rcpt',rootId:'root-rcpt',ownerHost:'HOME',claimId:'claim',fenceToken:'f',shellClass:'POWERSHELL',cwd:'/repo',effectClass:'NONE',openIdempotencyKey:'rcpt' });
  const id=opened.session.sessionId;
  const receiptId = path.basename(opened.receiptRef,'.json');
  await runtime.close(id,{fenceToken:'f'});
  const receipt = runtime.getReceipt(id,receiptId);
  assert.equal(receipt.semanticStatus,'UNRESOLVED');
  assert.equal(receipt.operation,'SESSION_OPEN');
});
