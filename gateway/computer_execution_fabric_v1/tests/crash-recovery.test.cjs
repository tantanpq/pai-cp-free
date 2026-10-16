'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionRuntime } = require('../runtime/session-runtime.cjs');
const { SessionRegistry } = require('../runtime/session-registry.cjs');
const { FakePersistentAdapter } = require('./helpers/fake-adapter.cjs');

test('restart marks live-looking sessions orphaned and no-reattach recovery reaps safely', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-recover-'));
  const runtime1 = new SessionRuntime({ rootDir, adapterFactory: s => new FakePersistentAdapter(s), fenceValidator: async () => true, operationAuthorizer: async () => ({ allowed:true }) });
  const opened = await runtime1.open({ requestId:'req-recover',rootId:'root-recover',ownerHost:'HOME',claimId:'claim',fenceToken:'f',shellClass:'POWERSHELL',cwd:'/repo',effectClass:'NONE',openIdempotencyKey:'recover' });
  const registry = new SessionRegistry(rootDir);
  const orphans = registry.markRestartOrphans('2026-09-21T00:00:00.000Z');
  assert.equal(orphans[0].state, 'ORPHANED');
  const runtime2 = new SessionRuntime({ rootDir, registry, adapterFactory: s => new FakePersistentAdapter(s), fenceValidator: async () => true, operationAuthorizer: async () => ({ allowed:true }), orphanReaper: async () => ({ verifiedClosed:true, method:'TEST_JOB_OBJECT_REAPER' }) });
  const result = await runtime2.recoverOrReap(opened.session.sessionId, { canReattach:false, reason:'TEST_NO_REATTACH' });
  assert.equal(result.status, 'REAPED');
  assert.equal(registry.get(opened.session.sessionId).state, 'CLOSED');
  assert.equal(registry.get(opened.session.sessionId).cleanupState, 'REAPED_AND_VERIFIED');
});

test('crash recovery never claims cleanup without an OS-level orphan reaper binding', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-recover-nobinder-'));
  const runtime1 = new SessionRuntime({ rootDir, adapterFactory: s => new FakePersistentAdapter(s), fenceValidator: async () => true, operationAuthorizer: async () => ({ allowed:true }) });
  const opened = await runtime1.open({ requestId:'req-lost',rootId:'root-lost',ownerHost:'HOME',claimId:'claim',fenceToken:'f',shellClass:'POWERSHELL',cwd:'/repo',effectClass:'NONE',openIdempotencyKey:'lost' });
  const registry = new SessionRegistry(rootDir); registry.markRestartOrphans();
  const runtime2 = new SessionRuntime({ rootDir, registry, adapterFactory: s => new FakePersistentAdapter(s), fenceValidator: async () => true, operationAuthorizer: async () => ({ allowed:true }) });
  const result = await runtime2.recoverOrReap(opened.session.sessionId, { canReattach:false });
  assert.equal(result.status, 'LOST');
  assert.equal(registry.get(opened.session.sessionId).cleanupState, 'BINDER_ORPHAN_REAPER_REQUIRED');
});
