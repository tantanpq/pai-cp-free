'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createQcheckRefresh } = require('../src/server');

let now = 1_000_000;
let spawns = 0;
let syncCalls = 0;
const child = new EventEmitter();
child.kill = () => true;
const refresh = createQcheckRefresh({
  command: 'C:/fixture/PAI-Current-System-Quick-Check.cmd',
  platform: 'win32',
  env: { ComSpec: 'cmd.exe' },
  now: () => now,
  fsApi: { existsSync: value => value === 'C:/fixture/PAI-Current-System-Quick-Check.cmd' },
  childProcessApi: {
    spawnSync: () => { syncCalls += 1; throw new Error('SYNC_REFRESH_MUST_NOT_RUN'); },
    spawn: (executable, args, options) => {
      spawns += 1;
      assert.equal(executable, 'cmd.exe');
      assert.deepEqual(args, ['/d', '/c', 'C:/fixture/PAI-Current-System-Quick-Check.cmd', '--summary-json']);
      assert.equal(options.windowsHide, true);
      return child;
    }
  }
});

assert.deepEqual(refresh(), { scheduled: true });
assert.deepEqual(refresh(), { scheduled: false, reason: 'QCHECK_REFRESH_IN_FLIGHT' });
assert.equal(spawns, 1);
assert.equal(syncCalls, 0);
child.emit('close', 0);
now += 5001;
assert.deepEqual(refresh(), { scheduled: true });
assert.equal(spawns, 2);
assert.equal(syncCalls, 0);
console.log('qcheck-refresh-nonblocking: PASS');
