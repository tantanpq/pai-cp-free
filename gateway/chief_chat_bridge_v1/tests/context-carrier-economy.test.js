'use strict';

const assert = require('node:assert/strict');
const live = require('../../chief_live_session_v1/src/chief-live-session');
const { createContextGateway } = require('../../continuity_memory_rooms_v1/src/context-gateway');
const { createBridge } = require('../src/chief-chat-bridge');

const db = live.open(':memory:');
const identity = { userId: 'tan', paiIdentityId: 'pai-chief', projectId: 'PAI', role: 'PAI_CHIEF' };
const contextGateway = createContextGateway({ db, identity });
const mind = { status: 'PASS', version: 'TEST', driveFileId: 'pointer', sha256: 'a'.repeat(64), receiptPath: 'pointer' };
const mindGate = { pointerStatus: () => mind, ensureDailyRead: () => mind, preflightMajorWork: () => mind, status: () => mind };
const bridge = createBridge({ identity, db, contextGateway, mindGate });

for (let index = 1; index <= 12; index += 1) {
  const reply = bridge.call('chief_turn', { userId: 'tan', requestId: `economy-${index}`,
    expectedRevision: index, intentClass: 'ANALYZE', message: `Bounded turn ${index}.`,
    roomAction: index === 1 ? 'NEW' : 'CONTINUE', roomName: index === 1 ? 'Economy fixture' : undefined,
    topicId: 'economy-fixture', roomSignals: { decisions: [`Decision ${index}`], openLoops: [`Open loop ${index}`] } });
  assert.equal(Object.hasOwn(reply.structuredContent.receipt, 'result'), false);
  assert.equal(JSON.stringify(reply.structuredContent).includes('includedRecords'), false);
  assert.equal(reply.structuredContent.result.promptEvidence.status, 'SKIPPED_EXPLICIT_OPT_IN_REQUIRED');
}

const receipts = db.prepare("SELECT COUNT(*) rows, SUM(length(body_json)) bytes, MAX(length(body_json)) max_bytes FROM chief_bridge_receipts WHERE receipt_key LIKE 'chief_turn:%'").get();
const packages = db.prepare("SELECT COUNT(*) rows, SUM(length(payload_json)) bytes, MAX(length(payload_json)) max_bytes FROM continuity_context_packages").get();
assert.ok(receipts.max_bytes < 18000, `stored receipt too large: ${receipts.max_bytes}`);
assert.ok(packages.max_bytes < 10000, `context package too large: ${packages.max_bytes}`);
console.log(JSON.stringify({ status: 'PASS', receiptRows: receipts.rows, receiptBytes: receipts.bytes,
  maxReceiptBytes: receipts.max_bytes, packageRows: packages.rows, packageBytes: packages.bytes,
  maxPackageBytes: packages.max_bytes }));
