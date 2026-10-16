'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ledger = require(path.resolve(__dirname, '..', '..', '..', '06_STATE', 'PAI_USER_PROMPT_EVIDENCE_LEDGER_R1_CANDIDATE', 'src', 'promptEvidenceLedger.js'));

const BUNDLE_SCHEMA = 'pai.user-prompt-bundle.v1';
const PURPOSES = new Set(['MCP_ACTION', 'HANDOFF', 'DRIVE_SUMMARY', 'THREAD_CLOSE', 'BACKFILL']);
// User evidence may contain a compact report or a structured handoff. Keep the
// cap well below the HTTP body's 64 KiB limit while avoiding a silent 2,000-char
// truncation boundary that would reject normal long-form user intent.
const MAX_PROMPT_CHARS = 8192;
const exactRef = (value, name, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`${name}_INVALID`);
  return value.trim();
};
const parseJson = (value, fallback) => { try { return JSON.parse(value); } catch (_) { return fallback; } };

function rowToEvent(row) {
  return {
    event_id: row.event_id, schema_version: row.schema_version, idempotency_key: row.idempotency_key,
    source_surface: row.source_surface, source_message_id: row.source_message_id,
    conversation_ref: row.conversation_ref, session_ref: row.session_ref, project_ref: row.project_ref,
    observed_at_utc: row.observed_at_utc, raw_user_prompt: row.raw_user_prompt,
    content_sha256: row.content_sha256, provenance_ref: row.provenance_ref,
    privacy_classification: row.privacy_classification,
    privacy_flags: parseJson(row.privacy_flags_json || '[]', [])
  };
}

function intentKind(text) {
  const value = String(text || '').toLowerCase();
  if (/đính chính|sửa lại|correct|correction/.test(value)) return 'CORRECTION';
  if (/không được|đừng|tránh|phải|bắt buộc|only|must|never|avoid/.test(value)) return 'CONSTRAINT';
  if (/\?|sao|tại sao|thế nào|how|why|what|when/.test(value)) return 'QUESTION';
  if (/tiếp tục|làm tiếp|continue|carry on/.test(value)) return 'CONTINUATION';
  if (/giúp|hãy|cần|muốn|build|fix|create|install|thiết lập|cài/.test(value)) return 'REQUEST';
  return 'INTENT';
}

function createSqlitePromptEvidenceHook({ db, identity, sessionId, projectRoot = null, archiveRoot = null, now = () => new Date().toISOString() }) {
  if (!db?.prepare || !db?.exec) throw new TypeError('sqlite db required');
  if (!identity?.userId || !identity?.projectId || !sessionId) throw new TypeError('bound identity and session required');
  const projectRef = String(identity.projectId);
  const sourceSurface = `pai-chief:${sessionId}`;
  const coldArchiveRoot = path.resolve(archiveRoot || path.join(projectRoot || process.cwd(), '06_STATE', 'PAI_PROMPT_BUNDLE_ARCHIVE_R1'));
  db.exec(`CREATE TABLE IF NOT EXISTS chief_user_prompt_evidence_v1 (
    event_id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
    source_surface TEXT NOT NULL, source_message_id TEXT, conversation_ref TEXT, session_ref TEXT NOT NULL,
    project_ref TEXT NOT NULL, observed_at_utc TEXT NOT NULL, raw_user_prompt TEXT NOT NULL,
    content_sha256 TEXT NOT NULL, provenance_ref TEXT, privacy_classification TEXT NOT NULL,
    privacy_flags_json TEXT NOT NULL, UNIQUE(source_surface, source_message_id));
    CREATE INDEX IF NOT EXISTS idx_chief_user_prompt_evidence_session_time
      ON chief_user_prompt_evidence_v1(session_ref, observed_at_utc);
    CREATE TABLE IF NOT EXISTS chief_user_prompt_bundle_v1 (
      bundle_id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      project_ref TEXT NOT NULL, session_ref TEXT NOT NULL, conversation_ref TEXT NOT NULL,
      purpose TEXT NOT NULL, complete INTEGER NOT NULL, previous_bundle_hash TEXT,
      from_cursor TEXT, to_cursor TEXT, item_count INTEGER NOT NULL, bundle_sha256 TEXT NOT NULL,
      summary_text TEXT, result_refs_json TEXT NOT NULL, privacy_state TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_prompt_bundle_conversation_time
      ON chief_user_prompt_bundle_v1(project_ref, conversation_ref, created_at);
    CREATE TABLE IF NOT EXISTS chief_user_prompt_bundle_item_v1 (
      bundle_id TEXT NOT NULL, ordinal INTEGER NOT NULL, event_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL, content_sha256 TEXT NOT NULL,
      PRIMARY KEY(bundle_id, ordinal), UNIQUE(bundle_id, event_id));
    CREATE TABLE IF NOT EXISTS chief_user_prompt_bundle_learning_v1 (
      bundle_id TEXT PRIMARY KEY, projection_sha256 TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chief_user_prompt_bundle_projection_outbox_v1 (
      bundle_id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
      next_attempt_at TEXT, last_error TEXT, artifact_path TEXT, artifact_sha256 TEXT, updated_at TEXT NOT NULL);`);

  const byKey = db.prepare('SELECT * FROM chief_user_prompt_evidence_v1 WHERE idempotency_key=?');
  const bySourceMessage = db.prepare('SELECT * FROM chief_user_prompt_evidence_v1 WHERE source_surface=? AND source_message_id=?');
  const insert = db.prepare(`INSERT INTO chief_user_prompt_evidence_v1 (
    event_id,schema_version,idempotency_key,source_surface,source_message_id,conversation_ref,session_ref,project_ref,
    observed_at_utc,raw_user_prompt,content_sha256,provenance_ref,privacy_classification,privacy_flags_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const store = {
    append(event) {
      const prior = byKey.get(event.idempotency_key);
      if (prior) return { inserted: false, event: rowToEvent(prior) };
      const sourcePrior = event.source_message_id ? bySourceMessage.get(event.source_surface, event.source_message_id) : null;
      if (sourcePrior) {
        if (sourcePrior.content_sha256 !== event.content_sha256) throw new Error('PROMPT_SOURCE_MESSAGE_CONFLICT');
        return { inserted: false, event: rowToEvent(sourcePrior) };
      }
      insert.run(event.event_id, event.schema_version, event.idempotency_key, event.source_surface,
        event.source_message_id, event.conversation_ref, event.session_ref, event.project_ref,
        event.observed_at_utc, event.raw_user_prompt, event.content_sha256, event.provenance_ref,
        event.privacy_classification, JSON.stringify(event.privacy_flags || []));
      return { inserted: true, event };
    }
  };

  function capture({ rawUserPrompt, sourceMessageId, conversationRef = null, provenanceRef = null, observedAt = null, failOpen = true }) {
    if (typeof rawUserPrompt !== 'string' || !rawUserPrompt.trim() || rawUserPrompt.length > MAX_PROMPT_CHARS) throw new Error('PROMPT_TEXT_INVALID');
    const sourceId = exactRef(sourceMessageId, 'PROMPT_SOURCE_MESSAGE', 256);
    const conversation = conversationRef == null ? null : exactRef(conversationRef, 'PROMPT_CONVERSATION', 256);
    if (observedAt != null && Number.isNaN(Date.parse(observedAt))) throw new Error('PROMPT_OBSERVED_AT_INVALID');
    const input = { source_surface: sourceSurface, source_message_id: sourceId,
      conversation_ref: conversation, session_ref: sessionId, project_ref: projectRef,
      observed_at_utc: observedAt || now(), provenance_ref: provenanceRef || `chief-turn:${sessionId}:${sourceId}`,
      raw_user_prompt: rawUserPrompt };
    const outcome = failOpen ? ledger.captureFailOpen(store, input) : { captured: true, ...ledger.capturePrompt(store, input) };
    if (!outcome.captured) return { status: 'DEGRADED_FAIL_OPEN', captured: false, reason: outcome.failure.error };
    return { status: outcome.inserted ? 'CAPTURED' : 'DEDUPLICATED', captured: true,
      inserted: Boolean(outcome.inserted), eventId: outcome.event.event_id,
      contentSha256: outcome.event.content_sha256, privacyClassification: outcome.event.privacy_classification,
      authority: 'LOCAL_APPEND_ONLY_EVIDENCE_NO_ASSISTANT_BODY' };
  }

  function bundleRow(bundleId, conversationRef) {
    const id = exactRef(bundleId, 'PROMPT_BUNDLE_ID', 128);
    const conversation = exactRef(conversationRef, 'PROMPT_CONVERSATION', 256);
    const row = db.prepare('SELECT * FROM chief_user_prompt_bundle_v1 WHERE bundle_id=? AND project_ref=? AND conversation_ref=?').get(id, projectRef, conversation);
    if (!row) throw new Error('PROMPT_BUNDLE_NOT_FOUND_OR_THREAD_MISMATCH');
    return row;
  }

  function projectBundle(row) {
    const learning = db.prepare('SELECT projection_sha256, body_json FROM chief_user_prompt_bundle_learning_v1 WHERE bundle_id=?').get(row.bundle_id);
    const outbox = db.prepare('SELECT status, attempts, next_attempt_at, artifact_path, artifact_sha256 FROM chief_user_prompt_bundle_projection_outbox_v1 WHERE bundle_id=?').get(row.bundle_id);
    const learningBody = learning ? parseJson(learning.body_json, {}) : {};
    return { schema: row.schema_version, bundleId: row.bundle_id, threadRef: row.conversation_ref,
      purpose: row.purpose, complete: Boolean(row.complete), previousBundleHash: row.previous_bundle_hash,
      fromCursor: row.from_cursor, toCursor: row.to_cursor, itemCount: Number(row.item_count),
      bundleSha256: row.bundle_sha256, privacyState: row.privacy_state, createdAt: row.created_at,
      resultRefs: parseJson(row.result_refs_json, []),
      learning: { projectionSha256: learning?.projection_sha256 || null,
        atomCount: learningBody.checkpoint?.atom_count || 0, patternCount: learningBody.checkpoint?.pattern_count || 0,
        profileCandidateCount: learningBody.checkpoint?.profile_candidate_count || 0,
        authority: 'CANDIDATE_ONLY_REQUIRES_GOVERNED_PROMOTION' },
      archive: outbox ? { status: outbox.status, attempts: Number(outbox.attempts),
        nextAttemptAt: outbox.next_attempt_at, artifactPath: outbox.artifact_path,
        artifactSha256: outbox.artifact_sha256 } : null,
      authority: 'EXACT_THREAD_BUNDLE_METADATA_NO_ASSISTANT_REASONING' };
  }

  function commitBundle({ bundleRef, conversationRef, purpose, complete, prompts, previousBundleHash = null, fromCursor = null, toCursor = null, summary = null, resultRefs = [] }) {
    const ref = exactRef(bundleRef, 'PROMPT_BUNDLE_REF', 128);
    const conversation = exactRef(conversationRef, 'PROMPT_CONVERSATION', 256);
    if (!PURPOSES.has(purpose)) throw new Error('PROMPT_BUNDLE_PURPOSE_INVALID');
    if (typeof complete !== 'boolean') throw new Error('PROMPT_BUNDLE_COMPLETE_REQUIRED');
    if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > 32) throw new Error('PROMPT_BUNDLE_ITEMS_INVALID');
    if (!Array.isArray(resultRefs) || resultRefs.length > 16) throw new Error('PROMPT_BUNDLE_RESULT_REFS_INVALID');
    const normalizedRefs = resultRefs.map(value => exactRef(value, 'PROMPT_BUNDLE_RESULT_REF', 512));
    const normalizedPrompts = prompts.map((item, index) => {
      if (!item || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000) throw new Error('PROMPT_BUNDLE_ITEM_TEXT_INVALID');
      const sourceMessageId = exactRef(item.sourceMessageId, 'PROMPT_BUNDLE_SOURCE_MESSAGE', 256);
      const observedAt = item.observedAt == null ? null : String(item.observedAt);
      if (observedAt && Number.isNaN(Date.parse(observedAt))) throw new Error('PROMPT_BUNDLE_OBSERVED_AT_INVALID');
      return { ordinal: index + 1, sourceMessageId, text: item.text, observedAt };
    });
    if (new Set(normalizedPrompts.map(item => item.sourceMessageId)).size !== normalizedPrompts.length) throw new Error('PROMPT_BUNDLE_DUPLICATE_SOURCE_MESSAGE');
    const priorHash = previousBundleHash == null || previousBundleHash === '' ? null : String(previousBundleHash).toLowerCase();
    if (priorHash && !/^[a-f0-9]{64}$/.test(priorHash)) throw new Error('PROMPT_BUNDLE_PREVIOUS_HASH_INVALID');
    const cursorFrom = fromCursor == null ? null : exactRef(String(fromCursor), 'PROMPT_BUNDLE_FROM_CURSOR', 256);
    const cursorTo = toCursor == null ? null : exactRef(String(toCursor), 'PROMPT_BUNDLE_TO_CURSOR', 256);
    const summaryText = summary == null || summary === '' ? null : String(summary).trim().slice(0, 2000);
    const idempotencyKey = ledger.sha256([projectRef, conversation, ref].join('\u001f'));
    const bundleId = `upb_${idempotencyKey.slice(0, 32)}`;
    const payload = { schema: BUNDLE_SCHEMA, projectRef, conversationRef: conversation, purpose, complete,
      previousBundleHash: priorHash, fromCursor: cursorFrom, toCursor: cursorTo,
      prompts: normalizedPrompts.map(item => ({ sourceMessageId: item.sourceMessageId,
        textSha256: ledger.sha256(item.text), observedAt: item.observedAt })),
      summarySha256: summaryText ? ledger.sha256(summaryText) : null, resultRefs: normalizedRefs };
    const bundleSha256 = ledger.sha256(JSON.stringify(payload));
    const existing = db.prepare('SELECT * FROM chief_user_prompt_bundle_v1 WHERE idempotency_key=?').get(idempotencyKey);
    if (existing) {
      if (existing.bundle_sha256 !== bundleSha256) throw new Error('PROMPT_BUNDLE_IDEMPOTENCY_CONFLICT');
      return { ...projectBundle(existing), status: 'DEDUPLICATED' };
    }
    if (priorHash) {
      const prior = db.prepare('SELECT bundle_id FROM chief_user_prompt_bundle_v1 WHERE project_ref=? AND conversation_ref=? AND bundle_sha256=?').get(projectRef, conversation, priorHash);
      if (!prior) throw new Error('PROMPT_BUNDLE_PREVIOUS_HASH_UNKNOWN');
    }
    const createdAt = now();
    const execute = () => {
      db.exec('BEGIN IMMEDIATE');
      try {
      const events = normalizedPrompts.map(item => ledger.capturePrompt(store, {
        source_surface: `pai-continuity:${projectRef}:${conversation}`,
        source_message_id: item.sourceMessageId, conversation_ref: conversation, session_ref: sessionId,
        project_ref: projectRef, observed_at_utc: item.observedAt || createdAt,
        provenance_ref: `prompt-bundle:${bundleId}:${item.ordinal}`, raw_user_prompt: item.text
      }).event);
      const privacyState = events.some(event => event.privacy_classification !== 'INTERNAL') ? 'MIXED_RESTRICTED_REDACT_ON_EXPORT' : 'INTERNAL';
      db.prepare('INSERT INTO chief_user_prompt_bundle_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        bundleId, BUNDLE_SCHEMA, idempotencyKey, projectRef, sessionId, conversation, purpose, complete ? 1 : 0,
        priorHash, cursorFrom, cursorTo, events.length, bundleSha256, summaryText, JSON.stringify(normalizedRefs), privacyState, createdAt);
      const insertItem = db.prepare('INSERT INTO chief_user_prompt_bundle_item_v1 VALUES (?,?,?,?,?)');
      events.forEach((event, index) => insertItem.run(bundleId, index + 1, event.event_id, event.source_message_id, event.content_sha256));
      const projection = ledger.rebuild(events.filter(event => event.privacy_classification === 'INTERNAL'));
      const projectionJson = JSON.stringify(projection);
      db.prepare('INSERT INTO chief_user_prompt_bundle_learning_v1 VALUES (?,?,?,?)').run(bundleId, ledger.sha256(projectionJson), projectionJson, createdAt);
      db.prepare('INSERT INTO chief_user_prompt_bundle_projection_outbox_v1 VALUES (?,?,?,?,?,?,?,?,?)').run(bundleId, 'DRIVE_COLD_ARCHIVE', 'PENDING', 0, createdAt, null, null, null, createdAt);
      const stored = db.prepare('SELECT * FROM chief_user_prompt_bundle_v1 WHERE bundle_id=?').get(bundleId);
      db.exec('COMMIT');
      return stored;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw error;
      }
    };
    return { ...projectBundle(execute()), status: 'COMMITTED' };
  }

  function bundleReceipt({ bundleId, conversationRef }) { return projectBundle(bundleRow(bundleId, conversationRef)); }

  function profile({ limit = 10 } = {}) {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(20, limit)) : 10;
    const events = db.prepare(`SELECT * FROM chief_user_prompt_evidence_v1
      WHERE project_ref=? AND privacy_classification='INTERNAL'
      ORDER BY observed_at_utc ASC, event_id ASC`).all(projectRef).map(rowToEvent);
    const memory = ledger.buildBehavioralMemory(events);
    const cards = memory.cards.filter(card => card.retention.state !== 'EXPIRED')
      .sort((a, b) => b.strength - a.strength || a.card_id.localeCompare(b.card_id)).slice(0, bounded)
      .map(card => ({ cardId: card.card_id, pattern: card.pattern, scope: card.scope,
        strength: card.strength, state: card.retention.state, promotion: card.promotion,
        evidenceCount: card.evidence_event_ids.length, stableTruth: false }));
    return { schema: memory.model, cards, eventCount: events.length,
      activeCount: cards.filter(card => card.state === 'ACTIVE').length,
      authority: 'EVIDENCE_WEIGHTED_CANDIDATES_NOT_CANONICAL_USER_TRUTH' };
  }

  function flushBundleArchive({ bundleId, conversationRef }) {
    const row = bundleRow(bundleId, conversationRef);
    const current = db.prepare('SELECT * FROM chief_user_prompt_bundle_projection_outbox_v1 WHERE bundle_id=?').get(row.bundle_id);
    if (current?.status === 'DELIVERED' && current.artifact_path && fs.existsSync(current.artifact_path)) return { ...projectBundle(row), status: 'ALREADY_DELIVERED' };
    const items = db.prepare(`SELECT i.ordinal, i.event_id, i.source_message_id, i.content_sha256,
      e.observed_at_utc, e.raw_user_prompt, e.privacy_classification, e.privacy_flags_json
      FROM chief_user_prompt_bundle_item_v1 i JOIN chief_user_prompt_evidence_v1 e ON e.event_id=i.event_id
      WHERE i.bundle_id=? ORDER BY i.ordinal`).all(row.bundle_id);
    const artifact = { schema: 'pai.prompt-bundle-cold-archive.v1',
      bundle: { bundleId: row.bundle_id, bundleSha256: row.bundle_sha256, projectRef: row.project_ref,
        threadRef: row.conversation_ref, purpose: row.purpose, complete: Boolean(row.complete),
        previousBundleHash: row.previous_bundle_hash, fromCursor: row.from_cursor, toCursor: row.to_cursor,
        createdAt: row.created_at, summary: row.summary_text, resultRefs: parseJson(row.result_refs_json, []) },
      prompts: items.map(item => ({ ordinal: Number(item.ordinal), eventId: item.event_id,
        sourceMessageId: item.source_message_id, observedAt: item.observed_at_utc,
        text: item.privacy_classification === 'INTERNAL' ? item.raw_user_prompt : null,
        redacted: item.privacy_classification !== 'INTERNAL', contentSha256: item.content_sha256,
        privacyClassification: item.privacy_classification, privacyFlags: parseJson(item.privacy_flags_json, []) })),
      learningAuthority: 'CANDIDATE_ONLY_LOCAL_DB_PROJECTION', exportPolicy: 'RESTRICTED_PROMPT_TEXT_REDACTED' };
    const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
    const artifactSha256 = ledger.sha256(bytes);
    const target = path.join(coldArchiveRoot, row.project_ref.replace(/[^A-Za-z0-9._-]/g, '_'), `${row.bundle_id}.json`);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temp, bytes, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, target);
      db.prepare(`UPDATE chief_user_prompt_bundle_projection_outbox_v1 SET status='DELIVERED', attempts=attempts+1,
        next_attempt_at=NULL, last_error=NULL, artifact_path=?, artifact_sha256=?, updated_at=? WHERE bundle_id=?`).run(target, artifactSha256, now(), row.bundle_id);
      return { ...projectBundle(row), status: 'DELIVERED' };
    } catch (error) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
      const attempts = Number(current?.attempts || 0) + 1;
      const nextAttemptAt = new Date(Date.now() + Math.min(3600, 2 ** Math.min(attempts, 10)) * 1000).toISOString();
      db.prepare(`UPDATE chief_user_prompt_bundle_projection_outbox_v1 SET status='PENDING', attempts=?, next_attempt_at=?,
        last_error=?, updated_at=? WHERE bundle_id=?`).run(attempts, nextAttemptAt, String(error.message || error).slice(0, 500), now(), row.bundle_id);
      throw new Error('PROMPT_BUNDLE_ARCHIVE_FAILED');
    }
  }

  function status() {
    const row = db.prepare('SELECT COUNT(*) AS count, MAX(observed_at_utc) AS latest FROM chief_user_prompt_evidence_v1 WHERE project_ref=?').get(projectRef);
    const bundles = db.prepare('SELECT COUNT(*) AS count FROM chief_user_prompt_bundle_v1 WHERE project_ref=?').get(projectRef);
    const pending = db.prepare("SELECT COUNT(*) AS count FROM chief_user_prompt_bundle_projection_outbox_v1 WHERE status='PENDING'").get();
    return { status: 'ACTIVE', eventCount: Number(row?.count || 0), bundleCount: Number(bundles?.count || 0),
      pendingBundleProjections: Number(pending?.count || 0), latestObservedAt: row?.latest || null,
      rawPromptProjection: false, archiveRoot: coldArchiveRoot, authority: 'LOCAL_APPEND_ONLY_EVIDENCE' };
  }

  function recent({ limit = 3 } = {}) {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(5, limit)) : 3;
    const rows = db.prepare(`SELECT event_id, observed_at_utc, raw_user_prompt, content_sha256,
      privacy_classification, privacy_flags_json, session_ref, provenance_ref
      FROM chief_user_prompt_evidence_v1 WHERE project_ref=?
      ORDER BY observed_at_utc DESC, event_id DESC LIMIT ?`).all(projectRef, bounded);
    return { schema: 'pai.recent-user-intent/v1', status: 'READY',
      items: rows.map(row => { const restricted = row.privacy_classification !== 'INTERNAL';
        return { eventId: row.event_id, observedAt: row.observed_at_utc,
          intentKind: intentKind(row.raw_user_prompt), text: restricted ? null : row.raw_user_prompt.trim().slice(0, 480),
          redacted: restricted, contentSha256: row.content_sha256,
          privacyClassification: row.privacy_classification, privacyFlags: parseJson(row.privacy_flags_json || '[]', []),
          sessionRefHash: ledger.sha256(row.session_ref).slice(0, 16), provenanceRef: restricted ? null : row.provenance_ref }; }),
      limit: bounded, authority: 'RECENT_PROMPT_EVIDENCE_NOT_STABLE_PREFERENCE_OR_TASK_AUTHORITY' };
  }
  return { capture, commitBundle, bundleReceipt, profile, flushBundleArchive, status, recent, sourceSurface, archiveRoot: coldArchiveRoot };
}

module.exports = { createSqlitePromptEvidenceHook };
