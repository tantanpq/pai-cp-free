'use strict';

// Seed Uplink is deliberately a transport adapter, not an authority path.
// A seed can be created in an ordinary ChatGPT conversation, then explicitly
// imported by a local PAI surface.  It never authenticates ChatGPT, claims
// work, or performs an effect by itself.
const crypto = require('node:crypto');

const SCHEMA = 'pai-seed-uplink/v1';
const PREFIX = 'PAI-SEED-V1';
const MAX_CODE_BYTES = 16 * 1024;
const MAX_OBJECTIVE = 2000;
const MAX_ACCEPTANCE = 12;
const MAX_SOURCE_REFS = 12;
const INTENTS = new Set(['ANALYZE', 'SYNTHESIZE', 'CLARIFY', 'RECOMMEND', 'REPORT', 'BUILD', 'REPAIR', 'QA']);
const MODES = new Set(['plan', 'candidate-only', 'REVIEW']);
const SCOPE = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function base64url(value) { return Buffer.from(value, 'utf8').toString('base64url'); }
function fromBase64url(value) { return Buffer.from(value, 'base64url').toString('utf8'); }
function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`SEED_${field}_INVALID`);
  return value.trim();
}
function optionalRefs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCE_REFS) throw new Error('SEED_SOURCE_REFS_INVALID');
  return value.map(item => text(item, 'SOURCE_REF', 512));
}
function acceptance(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ACCEPTANCE) throw new Error('SEED_ACCEPTANCE_INVALID');
  return value.map(item => text(item, 'ACCEPTANCE', 512));
}
function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('SEED_OBJECT_REQUIRED');
  const allowed = new Set(['schema', 'seedId', 'intent', 'objective', 'acceptance', 'mutableScope', 'requestedMode', 'sourceRefs', 'createdAt']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('SEED_UNKNOWN_FIELD');
  if (input.schema !== SCHEMA) throw new Error('SEED_SCHEMA_INVALID');
  const seedId = text(input.seedId, 'ID', 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,95}$/.test(seedId)) throw new Error('SEED_ID_INVALID');
  const intent = text(input.intent, 'INTENT', 24).toUpperCase();
  if (!INTENTS.has(intent)) throw new Error('SEED_INTENT_INVALID');
  const objective = text(input.objective, 'OBJECTIVE', MAX_OBJECTIVE);
  const mutableScope = text(input.mutableScope, 'SCOPE', 256);
  if (!SCOPE.test(mutableScope)) throw new Error('SEED_SCOPE_INVALID');
  const requestedMode = text(input.requestedMode, 'MODE', 32);
  if (!MODES.has(requestedMode)) throw new Error('SEED_MODE_INVALID');
  const createdAt = text(input.createdAt, 'CREATED_AT', 40);
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('SEED_CREATED_AT_INVALID');
  return Object.freeze({ schema: SCHEMA, seedId, intent, objective, acceptance: Object.freeze(acceptance(input.acceptance)), mutableScope, requestedMode, sourceRefs: Object.freeze(optionalRefs(input.sourceRefs)), createdAt: new Date(createdAt).toISOString() });
}
function fingerprint(seed) { return sha256(canonical(seed)); }
function encode(input) {
  const seed = normalize(input);
  const payload = base64url(canonical(seed));
  return `${PREFIX}.${payload}.${fingerprint(seed)}`;
}
function decode(code) {
  if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) throw new Error('SEED_CODE_INVALID');
  const parts = code.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) throw new Error('SEED_CODE_INVALID');
  let raw;
  try { raw = JSON.parse(fromBase64url(parts[1])); } catch (_) { throw new Error('SEED_CODE_INVALID'); }
  const seed = normalize(raw);
  if (!crypto.timingSafeEqual(Buffer.from(fingerprint(seed), 'utf8'), Buffer.from(parts[2], 'utf8'))) throw new Error('SEED_TAMPERED');
  return seed;
}

// Local PAI invokes this only after presenting the decoded fields to its user.
// The result can be passed unchanged to the existing pai_action_run gateway.
function prepareGovernedRequest(code) {
  const seed = decode(code);
  return Object.freeze({
    request_id: `seed:${seed.seedId}:${fingerprint(seed).slice(0, 16)}`,
    idempotency_key: `seed:${fingerprint(seed)}`,
    intent: seed.intent,
    objective: seed.objective,
    acceptance: seed.acceptance.join(' | '),
    scope: seed.mutableScope,
    source_refs: [...seed.sourceRefs],
    requested_mode: seed.requestedMode,
    effect_class: 'CANDIDATE_DRAFT',
    seed_code: code.trim(),
    // This is an explicit local choice. The Governor rejects it if Codex is
    // unavailable; it must never silently fall back to another provider.
    selected_provider_tool: 'CODEX_HOME',
    authority_policy_ref: 'LOCAL_PAI_USER_REVIEW_REQUIRED',
    seed_receipt: Object.freeze({ schema: SCHEMA, seedId: seed.seedId, fingerprint: fingerprint(seed), createdAt: seed.createdAt, transport: 'USER_PASTE_OR_LOCAL_APP_IMPORT', authority: 'NONE_UNTIL_EXISTING_GOVERNOR_ADMISSION' })
  });
}

async function importSeed({ code, confirm, submit, readResult }) {
  if (confirm !== true) return Object.freeze({ status: 'NEEDS_LOCAL_USER_CONFIRMATION' });
  if (typeof submit !== 'function') throw new Error('SEED_SUBMITTER_REQUIRED');
  const request = prepareGovernedRequest(code);
  let result;
  try { result = await submit(request); }
  catch (_) { return Object.freeze({status:'SUBMISSION_UNKNOWN',accepted:false,completed:false,result_verified:false,reason:'TRANSPORT_FAILED_NO_RESUBMIT',request}); }
  const state = require('./submission-state').classify(result, request);
  if (state.accepted && state.receipt.lifecycle_state === 'COMPLETED' && typeof readResult === 'function') {
    try {
      const readback = await readResult(state.receipt.pai_task_id);
      const proof = require('./submission-state').verifyResult(readback, state.receipt.pai_task_id);
      if (proof.verified) return Object.freeze({ ...state, status:'COMPLETED_WITH_RESULT', completed:true, result_verified:true, request, result, readback });
      return Object.freeze({ ...state, result_read_reason:proof.reason, request, result, readback });
    } catch (_) { return Object.freeze({ ...state, result_read_reason:'RESULT_READ_FAILED_NO_RESUBMIT', request, result }); }
  }
  return Object.freeze({ ...state, request, result });
}

module.exports = Object.freeze({ SCHEMA, PREFIX, canonical, fingerprint, normalize, encode, decode, prepareGovernedRequest, importSeed });

