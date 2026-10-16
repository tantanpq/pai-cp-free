'use strict';
const assert = require('node:assert/strict');
const { createReadGateway, createCurrentOwnerAdapters } = require('../src/pai-read-gateway.js');
const { formatTypedOutwardResult, OUTWARD_CONTRACT_TYPES, OUTWARD_BUDGETS } = require('../src/context-economy/typed-outward-contracts.js');

async function testBoundedFetch() {
  console.log('── Bounded Fetch Verification on > 20KB Document ──');

  // Create a large 25 KB knowledge document
  const largeDocumentText = 'A'.repeat(25 * 1024); // 25,600 bytes
  const largeDocId = 'knowledge:large_test_doctrine';

  const mockKnowledge = [
    {
      id: largeDocId,
      canonicalId: largeDocId,
      title: 'Large Test Doctrine',
      text: largeDocumentText,
      url: 'pai://doctrine/large_test',
      classification: 'INTERNAL_CONFIDENTIAL',
      freshness: '2026-09-22T00:00:00Z',
      authority: 'CORE_DOCTRINE',
      cones: ['KNOWLEDGE_INDEX']
    }
  ];

  const mockOwners = createCurrentOwnerAdapters({
    continuity: () => ({ status: 'VERIFIED', scope: 'PROJECT / PAI' }),
    realReaders: {
      pulse: () => ({ status: 'PASS', graphId: 'G1' }),
      authority: () => ({ status: 'ACTIVE' }),
      workItem: id => ({ workItemId: id }),
      resultEvent: id => ({ resultEventId: id }),
      hostCapabilities: () => ({ workers: [] })
    }
  });

  const gateway = createReadGateway({
    owners: mockOwners,
    catalog: mockKnowledge
  });

  // 1. Fetch with mode POINTER (default) -> Zero body bytes loaded!
  const pointerRes = gateway.call('fetch', { id: largeDocId, mode: 'POINTER' });
  assert.equal(pointerRes.structuredContent.metadata.pointerOnly, true);
  assert.equal(pointerRes.structuredContent.text, null, 'Mode POINTER must NOT hydrate text');
  assert.ok(pointerRes.structuredContent.url, 'Pointer must provide URL');
  console.log('✓ Mode POINTER returns metadata only: 0 body bytes hydrated.');

  // 2. Fetch with mode FULL -> Bound to <= 8192 bytes
  const fullRes = gateway.call('fetch', { id: largeDocId, mode: 'FULL' });
  assert.equal(fullRes.structuredContent.metadata.pointerOnly, false);
  assert.ok(fullRes.structuredContent.text, 'Mode FULL must return text excerpt');
  const textBytes = Buffer.byteLength(fullRes.structuredContent.text, 'utf8');
  assert.ok(textBytes <= 8192, `Hydrated text must be <= 8192 bytes, was ${textBytes}`);
  console.log(`✓ Mode FULL strictly bounded: ${textBytes} bytes hydrated (<= 8,192 bytes).`);

  // 3. Outward typed contract format check
  const outwardFormatted = formatTypedOutwardResult({ toolName: 'fetch', result: fullRes.structuredContent });
  assert.equal(outwardFormatted.contract_type, OUTWARD_CONTRACT_TYPES.EXACT_FETCH_CHUNK);
  const outwardBytes = Buffer.byteLength(JSON.stringify(outwardFormatted), 'utf8');
  assert.ok(outwardBytes <= OUTWARD_BUDGETS.EXACT_FETCH_CHUNK.maxBytes, `Outward payload must be <= ${OUTWARD_BUDGETS.EXACT_FETCH_CHUNK.maxBytes}B (was ${outwardBytes}B)`);
  assert.ok(outwardFormatted.text !== undefined, 'Outward fetch contains bounded text');
  console.log(`✓ Outward typed contract: ${outwardBytes} bytes (<= ${OUTWARD_BUDGETS.EXACT_FETCH_CHUNK.maxBytes}B ceiling), type: ${outwardFormatted.contract_type}.`);

  // 4. Missing exact source fails closed without broad hydration
  assert.throws(
    () => gateway.call('fetch', { id: 'nonexistent:doctrine', mode: 'FULL' }),
    /KNOWLEDGE_OBJECT_NOT_FOUND/,
    'Missing source must fail closed'
  );
  console.log('✓ Missing exact source fails closed (no broad hydration).');

  console.log('✅ ALL BOUNDED FETCH CHECKS PASSED CLEANLY.');
}

testBoundedFetch().catch(err => {
  console.error('❌ Bounded fetch test failed:', err);
  process.exit(1);
});
