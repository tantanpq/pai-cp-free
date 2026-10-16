'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const live = require('../../chief_live_session_v1/src/chief-live-session');
const { createSqlitePromptEvidenceHook } = require('../src/user-prompt-evidence-hook');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-prompt-hook-'));
const db = live.open(path.join(root, 'hook.sqlite'));
try {
  const hook = createSqlitePromptEvidenceHook({
    db,
    identity: { userId: 'tan', projectId: 'PAI' },
    sessionId: 'session-1',
    archiveRoot: path.join(root, 'drive-archive'),
    now: () => '2026-09-16T00:00:00.000Z'
  });
  const input = { rawUserPrompt: 'Hãy nhớ prompt này để giữ continuity.', sourceMessageId: 'msg-1', conversationRef: 'thread-1' };
  const first = hook.capture(input);
  const retry = hook.capture(input);
  assert.equal(first.status, 'CAPTURED');
  assert.equal(retry.status, 'DEDUPLICATED');
  assert.equal(first.eventId, retry.eventId);
  const rows = db.prepare('SELECT * FROM chief_user_prompt_evidence_v1').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_user_prompt, input.rawUserPrompt);
  assert.equal(Object.keys(rows[0]).some(key => /assistant|answer|chain_of_thought/i.test(key)), false);
  const longPrompt = 'x'.repeat(8192);
  assert.equal(hook.capture({ rawUserPrompt: longPrompt, sourceMessageId: 'long-msg', conversationRef: 'thread-long' }).status, 'CAPTURED');
  assert.throws(() => hook.capture({ rawUserPrompt: `${longPrompt}x`, sourceMessageId: 'too-long-msg', conversationRef: 'thread-long' }), /PROMPT_TEXT_INVALID/);
  const conflict = hook.capture({ ...input, rawUserPrompt: 'Một nội dung khác nhưng cùng message id.' });
  assert.equal(conflict.status, 'DEGRADED_FAIL_OPEN');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chief_user_prompt_evidence_v1').get().count, 2);
  hook.capture({ rawUserPrompt: 'Đừng lưu pass' + 'word=super-secret vào context.', sourceMessageId: 'msg-2', conversationRef: 'thread-2' });
  const recent = hook.recent({ limit: 5 });
  assert.equal(recent.items.some(item => item.redacted), true);
  assert.equal(recent.items.some(item => item.text === longPrompt.slice(0, 480)), true);
  assert.equal(JSON.stringify(recent).includes('super-secret'), false);
  const bundleInput = {
    bundleRef: 'thread-3-checkpoint-1', conversationRef: 'thread-3', purpose: 'HANDOFF', complete: true,
    prompts: [
      { sourceMessageId: 't3-msg-1', text: 'I prefer concise communication for every status update.' },
      { sourceMessageId: 't3-msg-2', text: 'I prefer concise communication for every status update.' },
      { sourceMessageId: 't3-msg-3', text: 'Keep pass' + 'word=drive-secret only in local evidence.' }
    ],
    summary: 'Thread handoff summary.', resultRefs: ['result:test-1']
  };
  const bundle = hook.commitBundle(bundleInput);
  assert.equal(bundle.status, 'COMMITTED');
  assert.equal(bundle.itemCount, 3);
  assert.equal(bundle.privacyState, 'MIXED_RESTRICTED_REDACT_ON_EXPORT');
  assert.equal(hook.commitBundle(bundleInput).status, 'DEDUPLICATED');
  assert.throws(() => hook.commitBundle({ ...bundleInput, complete: false }), /PROMPT_BUNDLE_IDEMPOTENCY_CONFLICT/);
  assert.throws(() => hook.bundleReceipt({ bundleId: bundle.bundleId, conversationRef: 'wrong-thread' }), /PROMPT_BUNDLE_NOT_FOUND_OR_THREAD_MISMATCH/);
  const profile = hook.profile({ limit: 10 });
  assert.equal(profile.cards.some(card => card.pattern === 'concise-communication' && card.state === 'ACTIVE' && card.strength >= 2), true);
  const delivered = hook.flushBundleArchive({ bundleId: bundle.bundleId, conversationRef: 'thread-3' });
  assert.equal(delivered.status, 'DELIVERED');
  const archiveText = fs.readFileSync(delivered.archive.artifactPath, 'utf8');
  assert.equal(archiveText.includes('drive-secret'), false);
  assert.equal(archiveText.includes('I prefer concise communication'), true);
  assert.equal(hook.flushBundleArchive({ bundleId: bundle.bundleId, conversationRef: 'thread-3' }).status, 'ALREADY_DELIVERED');
  const status = hook.status();
  assert.equal(status.status, 'ACTIVE');
  assert.equal(status.eventCount, 6);
  assert.equal(status.bundleCount, 1);
  assert.equal(status.pendingBundleProjections, 0);
  assert.equal(status.rawPromptProjection, false);
  console.log('user-prompt-evidence-hook: PASS capture, bundle chain, weighted profile, exact-thread readback, and redacted Drive archive');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
