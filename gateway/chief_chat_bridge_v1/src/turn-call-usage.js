'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { stable } = require('./provider-result-envelope');

const UNKNOWN = 'UNKNOWN';
const uiDispatchAttestations = new WeakMap();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function identityDigest(value) {
  return typeof value === 'string' && value.trim() ? sha256(value.trim()) : UNKNOWN;
}

// The ChatGPT Web adapter calls this only after its UI send action returns.
// It stores a digest of the composer readback, not the composer text.
function attestUiDispatch(carrier, composerText) {
  if (!carrier || typeof carrier !== 'object') return;
  uiDispatchAttestations.set(carrier, {
    status: 'UI_SEND_ACTION_RETURNED',
    composerDigest: typeof composerText === 'string' ? sha256(composerText) : UNKNOWN,
    composerBytes: typeof composerText === 'string' ? Buffer.byteLength(composerText, 'utf8') : UNKNOWN
  });
}

function defaultRoot() {
  const archive = process.env.CHIEF_PROMPT_ARCHIVE_ROOT
    ? path.resolve(process.env.CHIEF_PROMPT_ARCHIVE_ROOT)
    : path.join(os.homedir(), '.pai-chief-gateway', 'PAI_PROMPT_BUNDLE_ARCHIVE_R1');
  return path.join(archive, 'provider-cognition', 'turn-call-usage');
}

function observeCall({ input, prepared, adapter, result = null, error = null }) {
  const provider = String(adapter.providerId || UNKNOWN);
  const uiDispatch = uiDispatchAttestations.get(result || error);
  const callIndex = Number.isSafeInteger(input.call_index) && input.call_index >= 0
    ? input.call_index : UNKNOWN;
  return {
    schema: 'pai-turn-call-usage/v1',
    evidence_class: uiDispatch ? 'UI_DISPATCH_OBSERVED'
      : provider === 'ANTIGRAVITY' ? 'BOUNDED_IN_PROCESS_CANARY' : 'PROVIDER_PATH_ATTEMPT',
    episode_id_digest: identityDigest(input.episode_id),
    call_index: callIndex,
    run_id_digest: identityDigest(prepared.run_id),
    idempotency_key_digest: identityDigest(input.idempotency_key),
    strategy_id_digest: identityDigest(input.context_strategy_id),
    strategy_version: typeof input.context_strategy_version === 'string' && /^[A-Za-z0-9._-]{1,48}$/.test(input.context_strategy_version)
      ? input.context_strategy_version : UNKNOWN,
    provider,
    model: typeof result?.model === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(result.model)
      ? result.model : UNKNOWN,
    request_digest: UNKNOWN,
    request_digest_basis: UNKNOWN,
    request_input_bytes: UNKNOWN,
    ui_composer_digest: uiDispatch?.composerDigest || UNKNOWN,
    ui_composer_bytes: uiDispatch?.composerBytes || UNKNOWN,
    context_bytes: UNKNOWN,
    repeated_context_bytes: UNKNOWN,
    cache_read_tokens: UNKNOWN,
    cache_write_tokens: UNKNOWN,
    provider_input_tokens: UNKNOWN,
    provider_output_tokens: UNKNOWN,
    session_age_messages: UNKNOWN,
    recovery_search: UNKNOWN,
    submit_boundary: uiDispatch ? (error ? 'UI_SEND_ACTION_RETURNED_OUTCOME_UNKNOWN' : uiDispatch.status)
      : error?.dispatched === true ? 'ADAPTER_DISPATCH_CLAIM_OUTCOME_UNKNOWN' : UNKNOWN,
    call_outcome: error ? 'ERROR' : 'RESULT_RETURNED',
    error_code: error && /^[A-Z0-9_]{1,80}$/.test(String(error.code || '')) ? String(error.code) : UNKNOWN,
    response_digest: typeof result?.response_digest === 'string' && /^[a-f0-9]{64}$/i.test(result.response_digest)
      ? result.response_digest : UNKNOWN,
    terminal_result_ref: UNKNOWN,
    terminal_acceptance: UNKNOWN,
    observed_at: new Date().toISOString()
  };
}

function writeCallUsage(receipt, root = defaultRoot()) {
  const bytes = Buffer.from(`${stable(receipt)}\n`, 'utf8');
  const digest = sha256(bytes);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${digest}.json`);
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const readback = fs.readFileSync(file);
  if (readback.length !== bytes.length || sha256(readback) !== digest) {
    throw new Error('TURN_CALL_USAGE_READBACK_MISMATCH');
  }
  return { status: 'RECORDED', ref: file, sha256: digest };
}

module.exports = { UNKNOWN, attestUiDispatch, observeCall, writeCallUsage };
