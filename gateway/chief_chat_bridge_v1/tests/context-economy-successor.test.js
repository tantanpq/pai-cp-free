'use strict';

const assert = require('node:assert/strict');
const { createBridge } = require('../src/chief-chat-bridge');
const { compactHealth } = require('../src/context-economy/health-compact');
const live = require('../../chief_live_session_v1/src/chief-live-session');

const identity = { role: 'PAI_CHIEF', userId: 'tan', paiIdentityId: 'pai', projectId: 'PAI' };
const mindReceipt = reason => ({ status: 'PASS', reason, version: 'PAI_MIND_V1', driveFileId: 'fixture', sha256: 'fixture', receiptPath: 'fixture' });
const mindGate = {
  pointerStatus: () => ({ ...mindReceipt('JIT_NOT_READ'), status: 'JIT_NOT_READ' }),
  ensureDailyRead: ({ reason }) => mindReceipt(reason),
  preflightMajorWork: ({ reason }) => mindReceipt(reason),
  status: () => mindReceipt('STATUS')
};
const bridge = createBridge({ identity, db: live.open(':memory:'), mindGate });

const statusSchema = bridge.publicToolDefinitions.find(tool => tool.name === 'chief_status').inputSchema.properties;
assert.deepEqual(statusSchema.mode.enum, ['FULL', 'COMPACT']);
assert.equal(statusSchema.maxChecks.maximum, 32);

const turnSchema = bridge.publicToolDefinitions.find(tool => tool.name === 'chief_turn').inputSchema.properties;
assert.ok(turnSchema.threadRef, 'threadRef must survive Context Economy composition');
assert.ok(turnSchema.sourceMessageId, 'sourceMessageId must survive Context Economy composition');

const full = bridge.call('chief_status', { userId: 'tan', mode: 'FULL' }).structuredContent.result;
const compactCall = bridge.call('chief_status', { userId: 'tan', mode: 'COMPACT', maxChecks: 8 });
const compact = compactCall.structuredContent.result;
assert.equal(compact.schema, 'health-compact/v1');
assert.equal(compact.status, full.status);
assert.equal(compact.revision, full.revision);
assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') < 1024, 'compact chief status must stay below 1 KiB');
assert.equal(Object.hasOwn(compactCall.structuredContent.receipt, 'result'), false);
assert.ok(Buffer.byteLength(JSON.stringify(compactCall.structuredContent), 'utf8') < 1024, 'compact structured output including receipt must stay below 1 KiB');

const historical = compactHealth({ status: 'OPEN', checks: [], counts: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`historical_tool_with_long_name_${index}`, index])), fullRef: 'chief_status:FULL' });
assert.equal(Object.keys(historical.counts).length, 8);
assert.ok(historical.omittedCount >= 32);
assert.ok(Buffer.byteLength(JSON.stringify(historical), 'utf8') < 1024, 'historical audit counts must not expand compact status');

console.log('context-economy-successor: PASS compact status and exact prompt identity compose');
