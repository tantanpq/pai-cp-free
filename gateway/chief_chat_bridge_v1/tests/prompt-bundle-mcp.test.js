'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const live = require('../../chief_live_session_v1/src/chief-live-session');
const { createBridge } = require('../src/chief-chat-bridge');
const { createSqlitePromptEvidenceHook } = require('../src/user-prompt-evidence-hook');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-prompt-mcp-'));
const db = live.open(path.join(root, 'bridge.sqlite'));
const identity = { userId: 'tan', paiIdentityId: 'pai-chief', projectId: 'PAI', role: 'PAI_CHIEF' };
const mindReceipt = { status: 'PASS', version: 'TEST', driveFileId: 'test', sha256: 'a'.repeat(64), receiptPath: 'test' };
const mindGate = { ensureDailyRead: () => mindReceipt, preflightMajorWork: () => mindReceipt, status: () => mindReceipt };
try {
  const promptEvidence = createSqlitePromptEvidenceHook({ db, identity, sessionId: 'prompt-mcp-session',
    archiveRoot: path.join(root, 'drive'), now: () => '2026-09-16T01:00:00.000Z' });
  const publicToolNames = ['chief_resume', 'chief_turn', 'chief_prepare_handoff', 'pai_record_user_prompt',
    'pai_commit_prompt_bundle', 'pai_get_prompt_bundle', 'pai_get_user_profile', 'pai_flush_prompt_bundle_archive'];
  const bridge = createBridge({ identity, sessionId: 'prompt-mcp-session', db, mindGate, promptEvidence,
    publicToolNames, now: () => '2026-09-16T01:00:00.000Z' });
  const invoke = (name, args = {}) => bridge.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const names = bridge.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { mode: 'ALL' } }).result.tools.map(tool => tool.name);
  for (const name of publicToolNames) assert.ok(names.includes(name));
  assert.ok(bridge.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }).result.tools.length <= 8);
  const exactTurn = invoke('chief_turn', { requestId: 'turn-exact-1', expectedRevision: 1, intentClass: 'ANALYZE',
    message: 'Preserve this exact visible prompt.', threadRef: 'thread-exact', sourceMessageId: 'message-exact-1', persistPromptEvidence: true });
  assert.equal(exactTurn.result.structuredContent.result.promptEvidence.captured, true);
  assert.equal(Object.hasOwn(exactTurn.result.structuredContent.receipt, 'result'), false);
  assert.equal(db.prepare('SELECT source_message_id, conversation_ref FROM chief_user_prompt_evidence_v1 WHERE source_message_id=?').get('message-exact-1').conversation_ref, 'thread-exact');
  const rowCountBeforeMissingIdentity = db.prepare('SELECT COUNT(*) AS count FROM chief_user_prompt_evidence_v1').get().count;
  const degradedTurn = invoke('chief_turn', { requestId: 'turn-missing-identity', expectedRevision: 2, intentClass: 'ANALYZE',
    message: 'This turn must not pretend requestId is message identity.', persistPromptEvidence: true });
  assert.equal(degradedTurn.result.structuredContent.result.promptEvidence.status, 'DEGRADED_IDENTITY_UNAVAILABLE');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chief_user_prompt_evidence_v1').get().count, rowCountBeforeMissingIdentity);
  const partialIdentity = invoke('chief_turn', { requestId: 'turn-partial-identity', expectedRevision: 3, intentClass: 'ANALYZE',
    message: 'Reject partial prompt identity.', threadRef: 'thread-exact', persistPromptEvidence: true });
  assert.equal(partialIdentity.error.data.code, 'PROMPT_IDENTITY_PAIR_REQUIRED');
  const recorded = invoke('pai_record_user_prompt', { requestId: 'record-1', threadRef: 'thread-mcp',
    sourceMessageId: 'message-1', prompt: 'Please keep status updates concise.' });
  assert.equal(recorded.result.structuredContent.result.captured, true);
  const longRecorded = invoke('pai_record_user_prompt', { requestId: 'record-long', threadRef: 'thread-mcp',
    sourceMessageId: 'message-long', prompt: 'x'.repeat(8192) });
  assert.equal(longRecorded.result.structuredContent.result.captured, true);
  const tooLong = invoke('pai_record_user_prompt', { requestId: 'record-too-long', threadRef: 'thread-mcp',
    sourceMessageId: 'message-too-long', prompt: 'x'.repeat(8193) });
  assert.equal(tooLong.error.data.code, 'PROMPT_TEXT_INVALID');
  const committed = invoke('pai_commit_prompt_bundle', { requestId: 'bundle-call-1', bundleRef: 'bundle-1',
    threadRef: 'thread-mcp', purpose: 'HANDOFF', complete: true,
    prompts: [{ sourceMessageId: 'message-1', text: 'Please keep status updates concise.' },
      { sourceMessageId: 'message-2', text: 'Please keep status updates concise.' }] });
  assert.equal(committed.result.structuredContent.result.status, 'COMMITTED');
  const bundle = committed.result.structuredContent.result;
  const fetched = invoke('pai_get_prompt_bundle', { bundleId: bundle.bundleId, threadRef: 'thread-mcp' });
  assert.equal(fetched.result.structuredContent.result.bundleSha256, bundle.bundleSha256);
  assert.equal(JSON.stringify(fetched).includes('Please keep status'), false);
  const wrongThread = invoke('pai_get_prompt_bundle', { bundleId: bundle.bundleId, threadRef: 'wrong-thread' });
  assert.equal(wrongThread.error.data.code, 'PROMPT_BUNDLE_NOT_FOUND_OR_THREAD_MISMATCH');
  const profile = invoke('pai_get_user_profile', { limit: 5 });
  assert.equal(profile.result.structuredContent.result.cards.some(card => card.state === 'ACTIVE'), true);
  const archived = invoke('pai_flush_prompt_bundle_archive', { requestId: 'archive-1', bundleId: bundle.bundleId, threadRef: 'thread-mcp' });
  assert.equal(archived.result.structuredContent.result.status, 'DELIVERED');
  const resumed = invoke('chief_resume');
  assert.equal(resumed.result.structuredContent.result.revision, 3);
  const handoff = invoke('chief_prepare_handoff', { requestId: 'handoff-1', expectedRevision: 3,
    summary: 'Continue from the verified prompt bundle.', promptBundleId: bundle.bundleId, threadRef: 'thread-mcp' });
  const handoffResult = handoff.result.structuredContent.result;
  assert.equal(handoffResult.promptBundle.bundleId, bundle.bundleId);
  assert.equal(handoffResult.promptBundle.bundleSha256, bundle.bundleSha256);
  assert.equal(JSON.stringify(handoffResult.promptBundle).includes('Please keep status'), false);
  assert.equal(handoffResult.checkpoint.evidenceReceipts[0].kind, 'PROMPT_BUNDLE_POINTER');
  console.log('prompt-bundle-mcp: PASS tool contracts, exact-thread readback, profile, Drive projection, and handoff pointer');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
