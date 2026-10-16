'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHostControlWorkSpec } = require('../bridge/host-control-profile.cjs');
const { buildPaiActionRunRequest } = require('../bridge/federation-adapter.cjs');
const { compactGovernedResult } = require('../bridge/chief-work-request-adapter.cjs');

test('host-control profile uses governed capabilities without provider pin or raw-shell capability', () => {
  const workSpec = buildHostControlWorkSpec({ requestId:'req-bridge',rootId:'root-bridge',operation:'SESSION_OPEN',effectClass:'READ_ONLY',mutableScope:'NONE',payload:{cwd:'C:/repo'} });
  assert.ok(workSpec.requiredCapabilities.includes('GOVERNED_HOST_CONTROL'));
  assert.equal(workSpec.requiredCapabilities.some(v => /GROK|CODEX|ANTIGRAVITY|SHELL_RAW/i.test(v)), false);
  assert.match(workSpec.task, /PAI_HOST_CONTROL_PACKET_R1/);
  const request = buildPaiActionRunRequest({ requestId:'req-bridge',rootId:'root-bridge',operation:'SESSION_OPEN',effectClass:'READ_ONLY',mutableScope:'NONE',payload:{cwd:'C:/repo'} });
  assert.equal(request.tool, 'pai_action_run');
  assert.equal(request.bindingNotes.schemaStatus, 'DISCOVER_LIVE_BEFORE_CALL');
});

test('bridge rejects secret-bearing profile fields and never declares semantic task done', () => {
  assert.throws(() => buildHostControlWorkSpec({ requestId:'r',rootId:'root',operation:'SESSION_INPUT',effectClass:'X',payload:{nested:{['pass' + 'word']:'bad'}} }), /HOST_CONTROL_SECRET_FIELD_DENIED/);
  assert.equal(compactGovernedResult({ chief_state:'COMPLETED' }).semanticTaskDone, false);
});
