'use strict';

// A bounded operational session journal.  It is deliberately not a planner,
// Governor, graph, claim service, or canonical-memory writer.
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const chief = require('../../role_jd_s0_v1/chief_contract_v1/src/chief-contract');

const ROLE = 'PAI_CHIEF';
const CHECKPOINT_KEYS = new Set(['objective', 'activeTopic', 'threadState', 'decisions', 'constraints', 'openLoops', 'corrections', 'assumptions', 'rejectedPaths', 'unresolvedQuestions', 'branchParticipation', 'workStatus', 'evidenceReceipts', 'nextFrontier']);
const SENSITIVE = /credential|password|secret|token|oauth|authorization|api[_-]?key/i;
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);
const digest = v => crypto.createHash('sha256').update(stable(v)).digest('hex');
const fail = code => { throw new Error(code); };
const requireFields = (v, fields, code) => { if (!v || fields.some(k => v[k] === undefined || v[k] === null || v[k] === '')) fail(code); };
function forbidden(value) { if (!value || typeof value !== 'object') return false; return Object.entries(value).some(([k, v]) => SENSITIVE.test(k) || (typeof v === 'string' && v.length > 4096) || forbidden(v)); }
function identityOf(input) {
  requireFields(input, ['userId', 'paiIdentityId', 'projectId', 'role'], 'LIVE_SESSION_IDENTITY_REQUIRED');
  if (input.role !== ROLE) fail('LIVE_SESSION_ROLE_DENIED');
  return { userId: String(input.userId), paiIdentityId: String(input.paiIdentityId), projectId: String(input.projectId), role: input.role, externalChatId: input.externalChatId == null ? null : String(input.externalChatId), externalThreadId: input.externalThreadId == null ? null : String(input.externalThreadId) };
}
function sameIdentity(a, b) { return ['userId','paiIdentityId','projectId','role','externalChatId','externalThreadId'].every(k => a[k] === b[k]); }
function checkpoint(input = {}, { defaultWorkStatus = false } = {}) {
  if (!input || typeof input !== 'object' || forbidden(input)) fail('LIVE_SESSION_CONTENT_DENIED');
  const unknown = Object.keys(input).filter(k => !CHECKPOINT_KEYS.has(k));
  if (unknown.length) fail('LIVE_SESSION_CHECKPOINT_FIELD_DENIED');
  const output = {};
  for (const k of CHECKPOINT_KEYS) if (input[k] !== undefined) output[k] = input[k];
  if (defaultWorkStatus && !output.workStatus) output.workStatus = { direct: false, delegated: false, note: 'OBSERVATION_ONLY_NOT_GOVERNOR_AUTHORITY' };
  if (output.workStatus?.direct && output.workStatus?.delegated) fail('LIVE_SESSION_WORK_STATUS_CONFLICT');
  return output;
}
function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, identity_json TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, revision INTEGER NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, revision), UNIQUE(session_id, event_id));
           CREATE TABLE IF NOT EXISTS candidate_deltas (session_id TEXT NOT NULL, delta_id TEXT NOT NULL, candidate_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, delta_id));`);
}
function open(path = ':memory:') { const db = new DatabaseSync(path); init(db); return db; }
function row(db, id) { const r = db.prepare('SELECT * FROM sessions WHERE session_id=?').get(id); if (!r) fail('LIVE_SESSION_NOT_FOUND'); return r; }
function parseSession(r) { return { ...r, identity: JSON.parse(r.identity_json), snapshot: JSON.parse(r.snapshot_json) }; }
function chain(db, id) {
  let previous = 'GENESIS';
  for (const event of db.prepare('SELECT * FROM events WHERE session_id=? ORDER BY revision').all(id)) {
    const body = { sessionId: id, revision: event.revision, eventId: event.event_id, type: event.type, payload: JSON.parse(event.payload_json), previousHash: previous, createdAt: event.created_at };
    if (event.previous_hash !== previous || event.event_hash !== digest(body)) fail('LIVE_SESSION_TAMPERED');
    previous = event.event_hash;
  }
  return previous;
}
function authorize(db, sessionId, supplied) { const s = parseSession(row(db, sessionId)); if (!sameIdentity(s.identity, identityOf(supplied))) fail('LIVE_SESSION_IDENTITY_MISMATCH'); if (s.status !== 'OPEN') fail('LIVE_SESSION_CLOSED'); chain(db, sessionId); return s; }
function append(db, s, type, eventId, payload, now) {
  if (!eventId || forbidden(payload)) fail('LIVE_SESSION_EVENT_DENIED');
  const previousHash = chain(db, s.session_id); const revision = s.revision + 1;
  const body = { sessionId: s.session_id, revision, eventId, type, payload, previousHash, createdAt: now };
  try { db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)').run(s.session_id, revision, eventId, type, JSON.stringify(payload), previousHash, digest(body), now); }
  catch (e) { if (String(e.message).includes('UNIQUE')) fail('LIVE_SESSION_DUPLICATE_EVENT'); throw e; }
  return revision;
}
function beginTurn(db, { sessionId, identity, eventId, checkpoint: initial = {}, now = new Date().toISOString() }) {
  if (!sessionId || !eventId) fail('LIVE_SESSION_BEGIN_REQUIRED'); const id = identityOf(identity); const existing = db.prepare('SELECT * FROM sessions WHERE session_id=?').get(sessionId);
  if (existing) { const s = parseSession(existing); if (!sameIdentity(s.identity, id)) fail('LIVE_SESSION_IDENTITY_MISMATCH'); return resume(db, { sessionId, identity: id }); }
  const snap = checkpoint(initial, { defaultWorkStatus: true }); db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(sessionId, JSON.stringify(id), 'OPEN', 0, JSON.stringify(snap), now, now);
  const s = parseSession(row(db, sessionId)); const revision = append(db, s, 'BEGIN', eventId, { snapshot: snap }, now);
  db.prepare('UPDATE sessions SET revision=?, updated_at=? WHERE session_id=?').run(revision, now, sessionId); return resume(db, { sessionId, identity: id });
}
function commitTurn(db, { sessionId, identity, eventId, expectedRevision, checkpoint: update, candidateDurableDeltas = [], now = new Date().toISOString() }) {
  const s = authorize(db, sessionId, identity); if (expectedRevision !== s.revision) fail('LIVE_SESSION_OUT_OF_ORDER');
  if (!Array.isArray(candidateDurableDeltas) || forbidden(candidateDurableDeltas)) fail('LIVE_SESSION_CANDIDATE_DENIED');
  const patch = checkpoint(update); const snap = { ...s.snapshot, ...patch }; const revision = append(db, s, 'COMMIT', eventId, { patch, candidateCount: candidateDurableDeltas.length }, now);
  for (const candidate of candidateDurableDeltas) { if (!candidate || !candidate.deltaId) fail('LIVE_SESSION_CANDIDATE_DENIED'); try { db.prepare('INSERT INTO candidate_deltas VALUES (?,?,?,?,?)').run(sessionId, candidate.deltaId, JSON.stringify(candidate), 'CANDIDATE_NOT_ADMITTED', now); } catch (e) { if (String(e.message).includes('UNIQUE')) fail('LIVE_SESSION_DUPLICATE_DELTA'); throw e; } }
  db.prepare('UPDATE sessions SET revision=?, snapshot_json=?, updated_at=? WHERE session_id=?').run(revision, JSON.stringify(snap), now, sessionId); return resume(db, { sessionId, identity });
}
function resume(db, { sessionId, identity }) { const s = authorize(db, sessionId, identity); return { sessionId, status: s.status, revision: s.revision, identity: s.identity, checkpoint: s.snapshot, candidateDurableDeltas: db.prepare('SELECT delta_id, status FROM candidate_deltas WHERE session_id=? ORDER BY delta_id').all(sessionId), authority: 'OPERATIONAL_SESSION_ONLY; CANDIDATES_NOT_CANONICAL_OR_USER_TRUTH; GOVERNOR_AND_CANONICAL_SOURCES_REMAIN_AUTHORITATIVE' }; }
function correct(db, { sessionId, identity, eventId, expectedRevision, correction, now = new Date().toISOString() }) { return commitTurn(db, { sessionId, identity, eventId, expectedRevision, checkpoint: { corrections: [correction] }, now }); }
function forget(db, { sessionId, identity, eventId, expectedRevision, deltaId, now = new Date().toISOString() }) { const s = authorize(db, sessionId, identity); if (expectedRevision !== s.revision) fail('LIVE_SESSION_OUT_OF_ORDER'); const found = db.prepare('SELECT 1 FROM candidate_deltas WHERE session_id=? AND delta_id=?').get(sessionId, deltaId); if (!found) fail('LIVE_SESSION_DELTA_NOT_FOUND'); const revision = append(db, s, 'FORGET', eventId, { deltaId }, now); db.prepare('DELETE FROM candidate_deltas WHERE session_id=? AND delta_id=?').run(sessionId, deltaId); db.prepare('UPDATE sessions SET revision=?, updated_at=? WHERE session_id=?').run(revision, now, sessionId); return resume(db, { sessionId, identity }); }
function rollback(db, { sessionId, identity, eventId, expectedRevision, toRevision, now = new Date().toISOString() }) { const s = authorize(db, sessionId, identity); if (expectedRevision !== s.revision || !Number.isInteger(toRevision) || toRevision < 1 || toRevision > s.revision) fail('LIVE_SESSION_ROLLBACK_DENIED'); const events = db.prepare('SELECT * FROM events WHERE session_id=? AND revision<=? ORDER BY revision').all(sessionId, toRevision); let snap = {}; for (const e of events) { const p = JSON.parse(e.payload_json); if (p.snapshot) snap = p.snapshot; if (p.patch) snap = { ...snap, ...p.patch }; } const revision = append(db, s, 'ROLLBACK', eventId, { toRevision }, now); db.prepare('UPDATE sessions SET revision=?, snapshot_json=?, updated_at=? WHERE session_id=?').run(revision, JSON.stringify(snap), now, sessionId); return resume(db, { sessionId, identity }); }
function close(db, { sessionId, identity, eventId, expectedRevision, now = new Date().toISOString() }) { const s = authorize(db, sessionId, identity); if (expectedRevision !== s.revision) fail('LIVE_SESSION_OUT_OF_ORDER'); const revision = append(db, s, 'CLOSE', eventId, {}, now); db.prepare('UPDATE sessions SET status=?, revision=?, updated_at=? WHERE session_id=?').run('CLOSED', revision, now, sessionId); const closed = parseSession(row(db, sessionId)); return { sessionId, status: closed.status, revision: closed.revision }; }
function exportSession(db, { sessionId, identity }) { const s = authorize(db, sessionId, identity); return { version: 1, sessionId, identity: s.identity, status: s.status, revision: s.revision, checkpoint: s.snapshot, chainHash: chain(db, sessionId), candidateDurableDeltas: db.prepare('SELECT delta_id, status FROM candidate_deltas WHERE session_id=? ORDER BY delta_id').all(sessionId), privacy: 'NO_CREDENTIALS_OR_RAW_CHAT_HISTORY; CANDIDATES_NOT_ADMITTED' }; }
module.exports = { open, beginTurn, commitTurn, resume, correct, forget, exportSession, rollback, close, _chain: chain };

