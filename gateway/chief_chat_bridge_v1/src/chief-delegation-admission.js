'use strict';
// Candidate-only admission seam. It is separate from chief_turn and can only materialize an immutable DISPATCH.
const crypto = require('node:crypto'); const fs = require('node:fs'); const path = require('node:path');
const { normalizeWorkSpec } = require('./chief-conversation-experience');
const { validMutableScope, providerCapability } = require('./work-contract');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const fail = code => { throw new Error(code); };
const safeToken = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
const ID_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SAFE_PATH_RE = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const TYPES = new Set(['DRAFT', 'DISPATCH', 'CONTINUATION', 'HANDOFF']);
const DATA_MODES = new Set(['NONE', 'READ_ONLY', 'READ_WRITE', 'PORTABLE_ARTIFACT']);
const RESULT_STATUSES = new Set(['DONE', 'NOT_DONE', 'BLOCKED']);
const HEADER_FIELDS = new Set(['TASK_ID','TYPE','ROOT_ID','PARENT_ID','PRIORITY','MUTABLE_SCOPE','REQUIRED_CAPABILITIES','WORKDIR','DATA_MODE']);
const RESULT_FIELDS = ['STATUS','TESTS','OUTPUTS','NEXT','BLOCKER'];
const MAX_TASK_BOX_CARRIER_BYTES = 4096;
const scalar = (value, name) => { if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) fail(`TASK_BOX_WIRE_${name}_REQUIRED`); return value.trim(); };
const validPath = value => SAFE_PATH_RE.test(value);
const safeScope = validMutableScope;
const safeCapability = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/.test(value);
const ALLOWED = new Set(['BUILD','REPAIR','QA','CHANGE']);

function parseTaskBoxWire(bytes, kind = null) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '# TASK BOX') fail('TASK_BOX_WIRE_HEADER_INVALID');
  let divider = 1; while (divider < lines.length && lines[divider] !== '---') divider += 1;
  if (divider === lines.length) fail('TASK_BOX_WIRE_DIVIDER_REQUIRED');
  const fields = {};
  for (const line of lines.slice(1, divider)) {
    const match = /^([A-Z_]+):[ ]*(.*)$/.exec(line); if (!match || !HEADER_FIELDS.has(match[1])) fail('TASK_BOX_WIRE_HEADER_INVALID');
    if (Object.hasOwn(fields, match[1])) fail('TASK_BOX_WIRE_HEADER_DUPLICATE'); fields[match[1]] = match[2];
  }
  for (const required of ['TASK_ID','TYPE','PRIORITY','MUTABLE_SCOPE','REQUIRED_CAPABILITIES']) scalar(fields[required], required);
  if (!ID_RE.test(fields.TASK_ID)) fail('TASK_BOX_WIRE_TASK_ID_INVALID');
  if (!TYPES.has(fields.TYPE) || (kind && fields.TYPE !== kind)) fail('TASK_BOX_WIRE_TYPE_INVALID');
  for (const optional of ['ROOT_ID', 'PARENT_ID']) if (fields[optional] !== undefined && !ID_RE.test(fields[optional])) fail(`TASK_BOX_WIRE_${optional}_INVALID`);
  if (!PRIORITIES.has(fields.PRIORITY)) fail('TASK_BOX_WIRE_PRIORITY_INVALID');
  if (!safeScope(fields.MUTABLE_SCOPE)) fail('TASK_BOX_WIRE_SCOPE_INVALID');
  if (!fields.REQUIRED_CAPABILITIES.split(',').map(x => x.trim()).filter(Boolean).every(safeCapability)) fail('TASK_BOX_WIRE_CAPABILITIES_INVALID');
  if ((fields.WORKDIR === undefined) !== (fields.DATA_MODE === undefined)) fail('TASK_BOX_WIRE_WORKDIR_DATA_MODE_PAIR_REQUIRED');
  if (fields.WORKDIR !== undefined && fields.WORKDIR !== '.' && !validPath(scalar(fields.WORKDIR, 'WORKDIR'))) fail('TASK_BOX_WIRE_WORKDIR_INVALID');
  if (fields.DATA_MODE !== undefined && !DATA_MODES.has(fields.DATA_MODE)) fail('TASK_BOX_WIRE_DATA_MODE_INVALID');
  const body = lines.slice(divider + 1); while (body.length && body.at(-1) === '') body.pop();
  if (fields.TYPE === 'HANDOFF') {
    if (body[0] !== 'Result:' || body.length !== 6) fail('TASK_BOX_WIRE_HANDOFF_RESULT_REQUIRED');
    const result = {};
    RESULT_FIELDS.forEach((field, index) => { const match = /^([A-Z_]+):[ ]*(.*)$/.exec(body[index + 1]); if (!match || match[1] !== field) fail('TASK_BOX_WIRE_HANDOFF_RESULT_INVALID'); result[field] = scalar(match[2], `RESULT_${field}`); });
    if (!RESULT_STATUSES.has(result.STATUS)) fail('TASK_BOX_WIRE_RESULT_STATUS_INVALID');
    return { fields, result };
  }
  if (body[0] !== 'TASK:') fail('TASK_BOX_WIRE_BODY_REQUIRED');
  const task = body.slice(1).join('\n').replace(/\n+$/, ''); if (!task.trim()) fail('TASK_BOX_WIRE_BODY_REQUIRED');
  return { fields, task };
}

function serializeDispatch({ taskId, priority = 'P2', mutableScope, requiredCapabilities, body, rootId = null, parentId = null, workdir = null, dataMode = null }) {
  if (Array.isArray(requiredCapabilities) && requiredCapabilities.some(providerCapability)) fail('ADMISSION_DURABLE_PROVIDER_PIN_UNSUPPORTED');
  if (!ID_RE.test(taskId) || !PRIORITIES.has(priority) || !safeScope(mutableScope) || !Array.isArray(requiredCapabilities) || !requiredCapabilities.length || !requiredCapabilities.every(safeCapability) || (rootId && !ID_RE.test(rootId)) || (parentId && !ID_RE.test(parentId)) || ((workdir == null) !== (dataMode == null)) || (workdir && workdir !== '.' && !validPath(workdir)) || (dataMode && !DATA_MODES.has(dataMode))) fail('ADMISSION_WIRE_INPUT_INVALID');
  const fields = [`TASK_ID: ${taskId}`, 'TYPE: DISPATCH', `PRIORITY: ${priority}`, `MUTABLE_SCOPE: ${mutableScope}`, `REQUIRED_CAPABILITIES: ${requiredCapabilities.join(',')}`];
  fields.push(`ROOT_ID: ${rootId || taskId}`); if (parentId) fields.push(`PARENT_ID: ${parentId}`); if (workdir) fields.push(`WORKDIR: ${workdir}`); if (dataMode) fields.push(`DATA_MODE: ${dataMode}`);
  const bytes = Buffer.from(['# TASK BOX', ...fields, '---', 'TASK:', String(body || '').trim(), ''].join('\n'), 'utf8');
  if (bytes.length > MAX_TASK_BOX_CARRIER_BYTES) fail('ADMISSION_CARRIER_BUDGET_EXCEEDED');
  parseTaskBoxWire(bytes, 'DISPATCH'); return bytes;
}

// Reads only candidate bridge-owned tables through prepared statements. This is
// an internal composition function, never an MCP/raw-SQL surface.
function createBridgeEvidenceReader({ db }) {
  if (!db || typeof db.prepare !== 'function') fail('ADMISSION_EVIDENCE_DB_REQUIRED');
  const previewStmt = db.prepare('SELECT preview_id, preview_hash, expected_revision, intent_class, message_hash, status, body_json, committed_at FROM chief_action_previews WHERE preview_id=?');
  const receiptStmt = db.prepare('SELECT body_json FROM chief_bridge_receipts WHERE receipt_key=?');
  return Object.freeze({ resolve(request) {
    if (!safeToken(request?.requestId)) return null;
    const receipt = receiptStmt.get(`chief_turn:${request.requestId}:COMMIT`);
    if (!receipt) return null;
    let receiptBody; try { receiptBody = JSON.parse(receipt.body_json); } catch (_) { return null; }
    const action = receiptBody?.result?.actionPreview;
    const delegation = receiptBody?.result?.delegation; const committedRequest = delegation?.request;
    const preview = action?.actionPreviewId ? previewStmt.get(action.actionPreviewId) : null;
    if (!preview || !action || !delegation || !committedRequest || preview.status !== 'COMMITTED_REQUEST_ONLY' || delegation.status !== 'REQUESTED_NOT_ADMITTED') return null;
    if (action.actionPreviewId !== preview.preview_id || action.previewHash !== preview.preview_hash || action.expectedRevision !== preview.expected_revision || action.intentClass !== preview.intent_class || action.messageHash !== preview.message_hash || action.status !== preview.status) return null;
    let workSpec; try { workSpec = normalizeWorkSpec(action.workSpec); } catch (_) { return null; }
    if (committedRequest.requestId !== request.requestId || !safeToken(delegation.delegationId) || !safeToken(committedRequest.workUnitId) || committedRequest.intentClass !== preview.intent_class || committedRequest.route !== 'GOVERNOR' || committedRequest.authorityProvenance !== 'BOUND_USER_REQUEST_VIA_CHIEF' || !workSpec || stable(workSpec) !== stable(committedRequest.workSpec)) return null;
    return Object.freeze({ requestId: committedRequest.requestId, delegationId: delegation.delegationId, workUnitId: committedRequest.workUnitId, authorityProvenance: committedRequest.authorityProvenance, intentClass: preview.intent_class, route: committedRequest.route, actionPreviewId: preview.preview_id, previewHash: preview.preview_hash, expectedRevision: preview.expected_revision, messageHash: preview.message_hash, status: preview.status, delegationStatus: delegation.status, committedAt: preview.committed_at, workSpec });
  }});
}

function createAdmission({ now = () => new Date().toISOString(), allowedIntentClasses = ALLOWED, evidenceReader = null, taskBoxRoot = null } = {}) {
  if (!evidenceReader || typeof evidenceReader.resolve !== 'function') fail('ADMISSION_EVIDENCE_READER_REQUIRED');
  const root = typeof taskBoxRoot === 'string' && taskBoxRoot.trim() ? path.resolve(taskBoxRoot) : null;
  function validate(input) {
    const request = input?.request || {}; if (!safeToken(request.requestId) || !safeToken(request.workUnitId) || !safeToken(request.delegationId)) fail('ADMISSION_REQUEST_IDENTITY_INVALID');
    for (const field of ['authorityProvenance','intentClass','messageHash','mutableScope','requiredCapabilities','priority','rootId','parentId','workdir','dataMode','task','workSpec']) if (Object.hasOwn(request, field)) fail('ADMISSION_CALLER_WORK_SPEC_DENIED');
    if (String(request.workUnitId).startsWith('TAN_DIRECT_') || String(request.delegationId).startsWith('TAN_DIRECT_')) fail('ADMISSION_RESERVED_OR_INTENT_DENIED');
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 1 || !safeToken(request.actionPreviewId) || !/^[a-f0-9]{64}$/i.test(request.actionPreviewHash || '')) fail('ADMISSION_COMMIT_BINDING_INVALID');
    const evidence = evidenceReader.resolve(request);
    if (!evidence || !allowedIntentClasses.has(String(evidence.intentClass || '').toUpperCase()) || evidence.authorityProvenance !== 'BOUND_USER_REQUEST_VIA_CHIEF' || evidence.status !== 'COMMITTED_REQUEST_ONLY' || evidence.delegationStatus !== 'REQUESTED_NOT_ADMITTED' || evidence.requestId !== request.requestId || evidence.delegationId !== request.delegationId || evidence.workUnitId !== request.workUnitId || evidence.actionPreviewId !== request.actionPreviewId || evidence.previewHash !== request.actionPreviewHash || evidence.expectedRevision !== request.expectedRevision || evidence.route !== 'GOVERNOR' || !evidence.workSpec || !safeScope(evidence.workSpec.mutableScope) || !Array.isArray(evidence.workSpec.requiredCapabilities) || !evidence.workSpec.requiredCapabilities.length || !evidence.workSpec.requiredCapabilities.every(safeCapability) || !PRIORITIES.has(evidence.workSpec.priority) || typeof evidence.workSpec.task !== 'string' || !evidence.workSpec.task.trim() || evidence.workSpec.task.length > 2000 || (evidence.workSpec.rootId && !ID_RE.test(evidence.workSpec.rootId)) || (evidence.workSpec.parentId && !ID_RE.test(evidence.workSpec.parentId)) || ((evidence.workSpec.workdir == null) !== (evidence.workSpec.dataMode == null)) || (evidence.workSpec.workdir && evidence.workSpec.workdir !== '.' && !validPath(evidence.workSpec.workdir)) || (evidence.workSpec.dataMode && !DATA_MODES.has(evidence.workSpec.dataMode))) fail('ADMISSION_COMMITTED_EVIDENCE_INVALID');
    return evidence;
  }
  function admit(input) {
    if (!root || root === path.parse(root).root) fail('ADMISSION_TASK_BOX_ROOT_REQUIRED');
    const evidence = validate(input);
    const request = input.request; const taskId = `CHIEF_REQUEST_${sha256(Buffer.from(`${request.delegationId}:${request.workUnitId}:${evidence.previewHash}`)).slice(0, 24).toUpperCase()}`;
    const items = path.join(root, 'items'); const target = path.join(items, `${taskId}.md`); if (path.relative(items, target).startsWith('..')) fail('ADMISSION_TARGET_INVALID');
    const spec = evidence.workSpec; const bytes = serializeDispatch({ taskId, priority: spec.priority, mutableScope: spec.mutableScope, requiredCapabilities: spec.requiredCapabilities, rootId: spec.rootId, parentId: spec.parentId, workdir: spec.workdir, dataMode: spec.dataMode, body: spec.task });
    const hash = sha256(bytes); fs.mkdirSync(items, { recursive: true });
    if (fs.existsSync(target)) { const existing = fs.readFileSync(target); if (sha256(existing) === hash) return { status: 'IDEMPOTENT_READBACK', taskId, artifactPath: target, sha256: hash }; fail('ADMISSION_DUPLICATE_CONFLICT'); }
    fs.writeFileSync(target, bytes, { flag: 'wx' }); return { status: 'MATERIALIZED_DISPATCH_CANDIDATE_ONLY', taskId, artifactPath: target, sha256: hash, carrierBytes: bytes.length, sourceRefCount: 0, evidence: { actionPreviewId: evidence.actionPreviewId, committedAt: evidence.committedAt }, createdAt: now() };
  }
  function admitCommitted({ requestId, expectedRevision } = {}) {
    if (!safeToken(requestId) || !Number.isInteger(expectedRevision) || expectedRevision < 1) fail('ADMISSION_COMMIT_BINDING_INVALID');
    const evidence = evidenceReader.resolve({ requestId });
    if (!evidence || !allowedIntentClasses.has(String(evidence.intentClass || '').toUpperCase()) || evidence.expectedRevision !== expectedRevision) fail('ADMISSION_COMMITTED_EVIDENCE_INVALID');
    return admit({ request: { requestId: evidence.requestId, workUnitId: evidence.workUnitId, delegationId: evidence.delegationId, expectedRevision: evidence.expectedRevision, actionPreviewId: evidence.actionPreviewId, actionPreviewHash: evidence.previewHash } });
  }
  return { admit, admitCommitted, validate, interface: { name: 'admitCommittedChiefDelegation', automaticBridgeBinding: true, materialization: 'DISPATCH_ONLY_NO_CLAIM_EXECUTION_HOST_OR_AUTHORITY' } };
}
module.exports = { createAdmission, createBridgeEvidenceReader, serializeDispatch, parseTaskBoxWire, sha256 };
