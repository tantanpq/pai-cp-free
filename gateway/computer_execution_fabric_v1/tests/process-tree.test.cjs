'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProcessTreeManager } = require('../runtime/process-tree-manager.cjs');

test('process tree terminates owned children but preserves explicit detach', async () => {
  const killed = [];
  const manager = new ProcessTreeManager({ terminate: async pid => killed.push(pid), verifyDead: async () => true });
  manager.register({ pid: 100, label: 'root' });
  manager.register({ pid: 101, parentPid: 100, label: 'child' });
  manager.register({ pid: 102, parentPid: 100, label: 'pinned' });
  manager.detach(102);
  const result = await manager.cleanup({ reason: 'TEST' });
  assert.deepEqual(killed, [101, 100]);
  assert.equal(result.every(x => x.status === 'TERMINATED'), true);
  assert.equal(manager.owned().some(x => x.pid === 102), false);
});
