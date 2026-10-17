'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const uplink = require('../src/seed-uplink');
const cli = require('../src/seed-cli');
const { ExecutorRouter } = require('../src/executor-router');
const { FederationCore } = require('../src/federation-core');

function seed(overrides = {}) { return {
  schema: uplink.SCHEMA, seedId: 'normal-chat-001', intent: 'BUILD',
  objective: 'Create a candidate-only PAI improvement.',
  acceptance: ['Emit a tested candidate.', 'Do not mutate live state.'],
  mutableScope: '06_STATE/PAI_SEED_UPLINK_V0', requestedMode: 'candidate-only',
  sourceRefs: ['drive:mission-001'], createdAt: '2026-09-24T00:00:00.000Z', ...overrides
}; }

test('round trip is canonical and stable', () => {
  const first = uplink.encode(seed());
  const reordered = uplink.encode({ ...seed(), sourceRefs: ['drive:mission-001'] });
  assert.equal(first, reordered);
  assert.deepEqual(uplink.decode(first), uplink.normalize(seed()));
});
test('governed request is candidate-only and contains no provider authority', () => {
  const request = uplink.prepareGovernedRequest(uplink.encode(seed()));
  assert.equal(request.effect_class, 'CANDIDATE_DRAFT');
  assert.equal(request.authority_policy_ref, 'LOCAL_PAI_USER_REVIEW_REQUIRED');
  assert.equal(request.selected_provider_tool, 'CODEX_HOME');
  assert.equal(request.scope, '06_STATE/PAI_SEED_UPLINK_V0');
  assert.match(request.request_id, /^seed:normal-chat-001:/);
  assert.equal(request.seed_receipt.authority, 'NONE_UNTIL_EXISTING_GOVERNOR_ADMISSION');
});
test('tampering fails closed', () => {
  const code = uplink.encode(seed());
  const [prefix, payload, tag] = code.split('.');
  const changed = `${prefix}.${payload}.${tag.replace(/^./, tag[0] === '0' ? '1' : '0')}`;
  assert.throws(() => uplink.decode(changed), /SEED_TAMPERED/);
});
test('absolute, traversing, arbitrary and effect-shaped fields are rejected', () => {
  assert.throws(() => uplink.encode(seed({ mutableScope: 'C:/ProgramData/PAI' })), /SEED_SCOPE_INVALID/);
  assert.throws(() => uplink.encode(seed({ mutableScope: '06_STATE/../live' })), /SEED_SCOPE_INVALID/);
  assert.throws(() => uplink.encode({ ...seed(), effectClass: 'ACTION_DIRECT' }), /SEED_UNKNOWN_FIELD/);
  assert.throws(() => uplink.encode(seed({ requestedMode: 'EXECUTE' })), /SEED_MODE_INVALID/);
});
test('an import requires explicit local confirmation and keeps the submission injectable', async () => {
  const code = uplink.encode(seed());
  assert.deepEqual(await uplink.importSeed({ code, confirm: false, submit: () => assert.fail('must not submit') }), { status: 'NEEDS_LOCAL_USER_CONFIRMATION' });
  let received;
  const imported = await uplink.importSeed({ code, confirm: true, submit: async request => { received = request; return { admission: 'PENDING' }; } });
  assert.equal(imported.status, 'SUBMISSION_RECEIVED');
  assert.equal(imported.accepted, false);
  assert.equal(received.idempotency_key, imported.request.idempotency_key);
});
test('CLI makes user confirmation explicit and sends only the governed request', async () => {
  const code = uplink.encode(seed());
  assert.deepEqual(await cli.run(['submit', code]), { status: 'NEEDS_LOCAL_USER_CONFIRMATION' });
  let endpoint, payload;
  const result = await cli.run(['submit', code, '--confirm', '--endpoint', 'http://127.0.0.1:8787/mcp'], {
    submit: async (url, body) => { endpoint = url; payload = body; return { result: { accepted: true } }; }
  });
  assert.equal(endpoint, 'http://127.0.0.1:8787/mcp');
  assert.equal(payload.params.name, 'pai_action_run');
  assert.equal(payload.params.arguments.effect_class, 'CANDIDATE_DRAFT');
  assert.equal(result.result.result.accepted, true);
});

test('a CODEX_HOME seed pin selects CODEX_HOME for QA', () => {
  const selected = new ExecutorRouter().selectExecutor({
    requiredCapabilities: ['QA'], role: 'QA', preferredExecutor: 'CODEX_HOME'
  });
  assert.equal(selected.id, 'CODEX_HOME');
});

test('an unavailable provider pin fails closed instead of falling back', () => {
  assert.throws(
    () => new ExecutorRouter().selectExecutor({ requiredCapabilities: ['QA'], role: 'QA', preferredExecutor: 'MISSING_PROVIDER' }),
    /PINNED_EXECUTOR_UNAVAILABLE/
  );
});

test('a confirmed candidate-only seed terminates as a no-effect CODEX_HOME probe', async () => {
  const core = new FederationCore();
  const request = uplink.prepareGovernedRequest(uplink.encode(seed({ intent: 'QA', seedId: 'normal-chat-terminal-001' })));
  const result = await core.handleActionRun(request);
  assert.equal(result.selected_executor_if_assigned, 'CODEX_HOME');
  assert.equal(result.admission_state, 'NO_EFFECT_CANDIDATE');
  assert.equal(result.lifecycle_state, 'COMPLETED');
  assert.equal(core.getMcpTask(result.pai_task_id).status, 'completed');
});
