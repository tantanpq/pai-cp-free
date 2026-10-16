'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const live = require('../../chief_live_session_v1/src/chief-live-session');
const { createBridge, TOOL_DEFINITIONS, CHIEF_RESUME_MAX_BYTES } = require('../src/chief-chat-bridge');
const { createReadGateway, createCurrentOwnerAdapters, READ_TOOLS } = require('../src/pai-read-gateway');
const { createSqlitePromptEvidenceHook } = require('../src/user-prompt-evidence-hook');

console.log('Running Huge Context Resume Regression Fixture Test...');

const identity = { userId: 'tan', paiIdentityId: 'pai-chief', projectId: 'PAI', role: 'PAI_CHIEF' };

// Intentionally huge payload markers:
const FORBIDDEN_BODY_MARKER = '###FORBIDDEN_RAW_SOURCE_BODY_MARKER_0123456789###';
const FORBIDDEN_FRAGMENT_MARKER = '###FORBIDDEN_ROOM_FRAGMENT_MARKER_9876543210###';
const FORBIDDEN_ASSISTANT_MARKER = '###FORBIDDEN_ASSISTANT_TRANSCRIPT_MARKER###';

// Construct 500 KB raw bodies
const hugeSourceBody = `${FORBIDDEN_BODY_MARKER}\n` + 'X'.repeat(500 * 1024);

const hugeContextGateway = {
  peek: () => ({
    room: {
      roomId: 'room-huge-001',
      roomName: 'Huge Context Fixture Room',
      primaryTopicId: 'huge-stress-test',
      status: 'ACTIVE',
      revision: 42,
      privacyClass: 'PRIVATE'
    },
    contextPackage: {
      packageId: 'PKG_HUGE_FIXTURE_999',
      roomId: 'room-huge-001',
      sourceIds: ['source:doc-large-1', 'source:doc-large-2'],
      sources: ['source:doc-large-1', 'source:doc-large-2'],
      records: Array.from({ length: 50 }, (_, i) => ({
        id: `record-huge-${i}`,
        type: 'FRAGMENT',
        text: `${FORBIDDEN_FRAGMENT_MARKER} fragment index ${i}: ${hugeSourceBody}`,
        sourcePointer: { sourceId: `src-${i}`, sourceKind: 'CHAT_TURN' }
      })),
      includedRecords: Array.from({ length: 50 }, (_, i) => ({
        id: `record-huge-${i}`,
        type: 'FRAGMENT',
        text: `${FORBIDDEN_FRAGMENT_MARKER} fragment index ${i}: ${hugeSourceBody}`,
        sourcePointer: { sourceId: `src-${i}`, sourceKind: 'CHAT_TURN' }
      }))
    }
  }),
  inspect: () => ({
    room: { roomId: 'room-huge-001', revision: 42, status: 'ACTIVE' },
    fragments: Array.from({ length: 30 }, (_, i) => ({
      fragmentId: `frag-huge-${i}`,
      status: 'ROOM_LOCAL',
      type: 'INTENT',
      text: `${FORBIDDEN_FRAGMENT_MARKER} intent ${i} ` + 'Y'.repeat(500),
      sourcePointer: { sourceId: `intent-${i}`, sourceHash: `hash-${i}` }
    })),
    buffer: [{ text: `RECENT_BUFFER raw text ${hugeSourceBody.slice(0, 1000)}` }]
  }),
  current: () => ({ packageId: 'PKG_HUGE_CURRENT', raw: hugeSourceBody })
};

const hugeBehavioralMemory = {
  recall: () => ({
    cards: Array.from({ length: 25 }, (_, i) => ({
      cardId: `card-huge-${i}`,
      scope: 'PROJECT',
      scopeKey: 'PAI',
      state: 'ACTIVE',
      globalAlways: i < 3,
      rawAssistantText: `${FORBIDDEN_ASSISTANT_MARKER} assistant text ${i}`,
      projectionHash: `proj-hash-${i}`
    }))
  }),
  recallGlobal: () => ({
    cards: [
      { cardId: 'global-huge-1', scope: 'GLOBAL', rawData: hugeSourceBody },
      { cardId: 'global-huge-2', scope: 'GLOBAL', rawData: hugeSourceBody } // Duplicated variant
    ],
    ids: ['global-huge-1', 'global-huge-2'],
    projectionHash: 'global-hash',
    limit: 8
  })
};

const owners = createCurrentOwnerAdapters({
  continuity: () => ({ status: 'VERIFIED', scope: 'PROJECT / PAI' }),
  contextGateway: hugeContextGateway,
  behavioralMemory: hugeBehavioralMemory
});
const readGateway = createReadGateway({ owners });
const db = live.open();
const promptEvidence = createSqlitePromptEvidenceHook({ db, identity, sessionId: 'test-huge-resume' });

const bridge = createBridge({
  identity,
  db,
  mindGate: { pointerStatus: () => ({ status: 'JIT_NOT_READ', version: 'TEST_MIND', driveFileId: 'fixture', sha256: '0'.repeat(64), authority: 'POINTER_ONLY_NO_DOCTRINE_CONTENT_LOADED' }) },
  promptEvidence,
  readGateway,
  contextGateway: hugeContextGateway,
  publicToolNames: [...TOOL_DEFINITIONS, ...READ_TOOLS].map(tool => tool.name)
});

// Execute chief_resume against huge fixture
const resumeRpc = bridge.rpc({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'chief_resume',
    arguments: { userId: 'tan' }
  }
});

const serialized = JSON.stringify(resumeRpc);
const byteLen = Buffer.byteLength(serialized, 'utf8');

console.log(`Serialized chief_resume response: ${byteLen} bytes (Budget target: <= 8192 bytes, internal limit: ${CHIEF_RESUME_MAX_BYTES} bytes)`);

// 1. None of the raw body markers may appear outward
assert.equal(serialized.includes(FORBIDDEN_BODY_MARKER), false, 'CRITICAL: Raw source body marker leaked outward!');
assert.equal(serialized.includes(FORBIDDEN_FRAGMENT_MARKER), false, 'CRITICAL: Raw room fragment marker leaked outward!');
assert.equal(serialized.includes(FORBIDDEN_ASSISTANT_MARKER), false, 'CRITICAL: Raw assistant transcript marker leaked outward!');

// 2. Only pointer metadata appears
assert.ok(resumeRpc.result, JSON.stringify(resumeRpc));
const outwardResult = resumeRpc.result.structuredContent.result;
assert.ok(outwardResult.contextPackagePointer, 'contextPackagePointer must exist');
assert.equal(outwardResult.contextPackagePointer.is_pointer_only, true, 'is_pointer_only must be true');
assert.equal(outwardResult.contextPackagePointer.records.length, 0, 'records array must be empty in pointer');
assert.equal(outwardResult.roomContext.contextPackage.is_pointer_only, true);
assert.equal(outwardResult.roomContext.contextPackage.records.length, 0);

// 3. Serialized payload stays under selected budget (<= 8 KB / 8192 bytes)
assert.ok(byteLen <= 8192, `Serialized resume response (${byteLen} bytes) exceeds 8 KB budget ceiling`);
assert.ok(byteLen < CHIEF_RESUME_MAX_BYTES, `Serialized resume response (${byteLen} bytes) exceeds internal ceiling ${CHIEF_RESUME_MAX_BYTES}`);

// 4. Required compact contract fields are present
assert.ok(outwardResult.sessionId, 'sessionId must exist');
assert.ok(outwardResult.checkpointPointer, 'checkpointPointer must exist');
assert.ok(outwardResult.roomPointer, 'roomPointer must exist');
assert.ok(outwardResult.paiMindPointer, 'paiMindPointer must exist');
assert.ok(outwardResult.projectionDigest, 'projectionDigest must exist');

console.log('✓ PASS: Huge Context Resume Regression fixture PASSED (zero raw bodies leaked, pointer-only, under 8 KB budget).');
