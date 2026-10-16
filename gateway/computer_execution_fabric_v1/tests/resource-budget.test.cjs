'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ResourceBudget } = require('../runtime/resource-budget.cjs');

test('resource pressure signals degradation without inventing semantic task failure', () => {
  const budget = new ResourceBudget({ maxDiskBytes:100, maxProcessCount:2, maxOutputBytesPerSecond:50, maxRuntimeMs:1000 });
  budget.observeOutput(60,1000);
  const result = budget.evaluate({ diskBytes:101, processCount:3, runtimeMs:1001, nowMs:1000 });
  assert.equal(result.level,'PRESSURE');
  assert.equal(result.semanticTaskFailure,false);
  assert.equal(result.shouldForceTerminate,false);
  assert.ok(result.signals.length >= 4);
});

test('force reap is only signalled by explicit host-stability threat input', () => {
  const budget = new ResourceBudget();
  assert.equal(budget.evaluate({hostStabilityThreatened:false}).shouldForceTerminate,false);
  assert.equal(budget.evaluate({hostStabilityThreatened:true}).shouldForceTerminate,true);
});
