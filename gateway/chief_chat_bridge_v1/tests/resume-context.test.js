'use strict';
const assert = require('node:assert/strict');
const live = require('../../chief_live_session_v1/src/chief-live-session');
const { createBridge, TOOL_DEFINITIONS } = require('../src/chief-chat-bridge');
const { createSqlitePromptEvidenceHook } = require('../src/user-prompt-evidence-hook');
const { BOOT_POINTERS, READ_TOOLS, RESUME_CONTEXT_SCHEMA, RESUME_CONTEXT_MAX_BYTES, createReadGateway, createCurrentOwnerAdapters } = require('../src/pai-read-gateway');

const identity = { userId: 'tan', paiIdentityId: 'pai-chief', projectId: 'PAI', role: 'PAI_CHIEF' };
const old = Array.from({ length: 20 }, (_, index) => ({ fragmentId: `old-${index}`, type: 'INTENT', text: `old implementation prompt ${index}`, status: 'ROOM_LOCAL', createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, sourcePointer: { sourceId: `old-${index}`, sourceHash: `old-hash-${index}` } }));
const recent = [
  { fragmentId: 'recent-1', type: 'INTENT', text: 'Keep the resume context compact.', status: 'ROOM_LOCAL', createdAt: '2026-09-01T00:01:00.000Z', sourcePointer: { sourceId: 'recent-1', sourceHash: 'hash-1' } },
  { fragmentId: 'recent-2', type: 'OPEN_LOOP', text: 'Verify behavioral cards remain redacted.', status: 'VERIFIED_POINTER', createdAt: '2026-09-01T00:02:00.000Z', sourcePointer: { sourceId: 'recent-2', sourceHash: 'hash-2' } },
  { fragmentId: 'recent-3', type: 'CORRECTION', text: 'Do not dump raw room packages.', status: 'ROOM_LOCAL', createdAt: '2026-09-01T00:03:00.000Z', sourcePointer: { sourceId: 'recent-3', sourceHash: 'hash-3' } },
  { fragmentId: 'recent-3-duplicate', type: 'CORRECTION', text: 'Do not dump raw room packages.', status: 'ROOM_LOCAL', createdAt: '2026-09-01T00:04:00.000Z', sourcePointer: { sourceId: 'recent-3', sourceHash: 'hash-3' } }
];
const room = { roomId: 'ROOM:resume', roomName: 'Resume', primaryTopicId: 'resume-topic', status: 'ACTIVE', revision: 23, privacyClass: 'PRIVATE', projectId: 'PAI' };
let recalledQuery = null;
const contextGateway = { peek: () => ({ room: { ...room } }), inspect: ({ roomId }) => { assert.equal(roomId, room.roomId); return { room, fragments: [...old, ...recent], buffer: [{ text: 'RECENT_BUFFER must never be projected' }] }; }, current: () => { throw new Error('RAW_CONTEXT_PACKAGE_MUST_NOT_BE_USED'); } };
const behavioralMemory = { recall: ({ message }) => { recalledQuery = message; return { projectionHash: 'behavioral-projection', cards: [
  { cardId: 'global', scope: 'GLOBAL', scopeKey: 'GLOBAL', state: 'CORE', globalAlways: true, projectionHash: 'global-hash' },
  { cardId: 'project', scope: 'PROJECT', scopeKey: 'PAI', state: 'ACTIVE', globalAlways: false, projectionHash: 'project-hash' },
  { cardId: 'topic', scope: 'TOPIC', scopeKey: 'resume-topic', state: 'ACTIVE', globalAlways: false, projectionHash: 'topic-hash' },
  { cardId: 'unrelated', scope: 'PROJECT', scopeKey: 'OTHER', state: 'ACTIVE', globalAlways: false, projectionHash: 'other-hash' }
] }; }, recallGlobal: () => ({ cards: [{ cardId: 'global', scope: 'GLOBAL' }], ids: ['global'], projectionHash: 'global-hash', limit: 8 }) };
const continuity = () => ({ status: 'VERIFIED', available: true, lifecycleStage: 'RUNNING', lastVerifiedAt: '2026-09-01T00:05:00.000Z', sourceType: 'JIT_QCHECK_READ_ONLY', authority: 'QCHECK_READ_OWNER', raw_user_prompt: 'never project' });
const owners = createCurrentOwnerAdapters({ continuity, contextGateway, behavioralMemory });
assert.equal(JSON.stringify(BOOT_POINTERS).toLowerCase().includes('tan'), false);
for (const fixedId of ['1zWyHLGswNGjBYQ4N5HrG4vRaCektxrGn', '1QoJUVO-KB1i1EK25uQLQrqb3n9Bjg5CL', '1b8Uwm6nNnTCe_VSdnWIo27RoSLTpST8U']) assert.equal(JSON.stringify(BOOT_POINTERS).includes(fixedId), false);
const injectedBootPointers = Object.freeze({ profile: 'ONE_PAI_TEST_PROFILE', pointer: 'test-fixed-pointer' });
assert.deepEqual(createReadGateway({ owners: createCurrentOwnerAdapters({ continuity, bootPointers: injectedBootPointers }) }).call('pai_resume').structuredContent.boot, injectedBootPointers);
const gateway = createReadGateway({ owners });
const first = gateway.call('pai_get_context_pack').structuredContent;
const second = gateway.call('pai_get_context_pack').structuredContent;
assert.deepEqual(second, first);
assert.equal(first.schema, RESUME_CONTEXT_SCHEMA);
assert.notEqual(first.status, 'TRUNCATED');
assert.equal(Buffer.byteLength(JSON.stringify(first), 'utf8') < 8 * 1024, true);
assert.equal(Buffer.byteLength(JSON.stringify(first), 'utf8') <= RESUME_CONTEXT_MAX_BYTES, true);
assert.equal(first.recentMeaningful.length, 3);
assert.equal(first.recentMeaningful.every(record => ['CORRECTION', 'OPEN_LOOP', 'INTENT'].includes(record.type)), true);
assert.equal(first.recentMeaningful.every(record => record.text.length <= 480), true);
assert.equal(new Set(first.recentMeaningful.map(record => `${record.sourceId}\u0000${record.text}`)).size, 3);
assert.equal(first.recentMeaningful.some(record => record.sourceId.startsWith('old-')), false);
assert.equal(recalledQuery, 'Do not dump raw room packages.');
assert.deepEqual(first.behavioralMemory.cards.map(card => card.cardId), ['global', 'project', 'topic']);
assert.equal(first.reopenPointers.length, first.recentMeaningful.length);
const text = JSON.stringify(first);
for (const forbidden of ['RECENT_BUFFER', 'RAW_CONTEXT_PACKAGE', 'raw_user_prompt', 'assistant_body', 'answer_text', 'chain_of_thought', 'includedRecords', 'TRUNCATED']) assert.equal(text.includes(forbidden), false);
const degraded = createReadGateway({ owners: createCurrentOwnerAdapters({ continuity, contextGateway, behavioralMemory: { recall: () => { throw new Error('fixture'); } } }) }).call('pai_get_context_pack').structuredContent;
assert.equal(degraded.status, 'DEGRADED_BEHAVIORAL_RECALL'); assert.equal(degraded.behavioralMemory.cards.length, 0);
const blocked = createReadGateway({ owners: createCurrentOwnerAdapters({ continuity }) }).call('pai_get_context_pack').structuredContent;
assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.failureClass, 'MEMORY_ROOM_OWNER_UNAVAILABLE');
const resume = gateway.call('pai_resume').structuredContent;
assert.equal(Object.hasOwn(resume, 'behavioralMemory'), false);
assert.equal(Buffer.byteLength(JSON.stringify(resume), 'utf8') < 2048, true);
const db = live.open();
try {
  const promptEvidence = createSqlitePromptEvidenceHook({ db, identity, sessionId: 'resume-context-test' });
  const bridge = createBridge({ identity, db, promptEvidence, readGateway: gateway, publicToolNames: [...TOOL_DEFINITIONS, ...READ_TOOLS].map(tool => tool.name) });
  assert.equal(bridge.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { mode: 'ALL' } }).result.tools.length, 20);
  assert.equal(bridge.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools.length, 6);
} finally { db.close(); }
console.log('resume-context: PASS thin boot, JIT composed context, fail-open behavior, and 20-tool surface.');
