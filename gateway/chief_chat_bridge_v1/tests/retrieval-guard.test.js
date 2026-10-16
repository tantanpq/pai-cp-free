'use strict';

const assert = require('node:assert/strict');
const {
  createReadGateway,
  createCurrentOwnerAdapters,
  FETCH_TEXT_MAX_BYTES
} = require('../src/pai-read-gateway');

console.log('Running Retrieval Guard Test Suite...');

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

const mockCatalog = [
  {
    id: 'source:arch-overview',
    canonicalId: '159tphE7IE81KlLfINi-Ec2Uj42g2u6r1',
    title: 'Federation Gateway Architecture',
    cones: ['ARCHITECTURE'],
    classification: 'STATIC_SEMANTIC',
    text: 'A'.repeat(16384) // 16KB body, exceeds 8KB limit
  },
  {
    id: 'source:small-doc',
    canonicalId: 'doc-002',
    title: 'Small Doc',
    cones: ['ARCHITECTURE'],
    classification: 'STATIC_SEMANTIC',
    text: 'Compact text body'
  }
];

const gateway = createReadGateway({ owners: mockOwners, catalog: mockCatalog });

// 1. Broad search returns metadata only (body_count = 0)
const searchResult = gateway.call('search', { query: 'cone:ARCHITECTURE overview' });
assert.ok(searchResult.structuredContent?.results?.length > 0, 'Search should find matches');
for (const hit of searchResult.structuredContent.results) {
  assert.equal(hit.text, undefined, 'Search result hit must not contain text body');
  assert.ok(hit.canonicalId, 'Hit must have canonicalId');
  assert.ok(hit.sourceHash, 'Hit must have sourceHash');
}
console.log('  ✓ 1. Broad discovery search returns metadata only (zero bodies).');

// 2. Exact fetch mode POINTER returns metadata only
const pointerFetch = gateway.call('fetch', { id: 'source:arch-overview', mode: 'POINTER' });
assert.equal(pointerFetch.structuredContent.text, null, 'Mode POINTER must return null text');
assert.equal(pointerFetch.structuredContent.metadata?.pointerOnly, true);
console.log('  ✓ 2. Fixed source fetch with mode POINTER returns pointer metadata.');

// 3. Exact fetch mode FULL is bounded by FETCH_TEXT_MAX_BYTES (8KB)
const fullFetch = gateway.call('fetch', { id: 'source:arch-overview', mode: 'FULL' });
assert.ok(fullFetch.structuredContent.text, 'Mode FULL must return text');
assert.ok(
  Buffer.byteLength(fullFetch.structuredContent.text, 'utf8') <= FETCH_TEXT_MAX_BYTES,
  `Fetched text (${Buffer.byteLength(fullFetch.structuredContent.text, 'utf8')} bytes) must be <= ${FETCH_TEXT_MAX_BYTES}`
);
assert.equal(fullFetch.structuredContent.metadata?.maxFullBytes, FETCH_TEXT_MAX_BYTES);
console.log(`  ✓ 3. Large source is bounded to <= ${FETCH_TEXT_MAX_BYTES} bytes.`);

// 4. Missing exact source fails closed without broadening search or hydrating multiple files
assert.throws(() => {
  gateway.call('fetch', { id: 'source:non-existent-missing-id', mode: 'FULL' });
}, /KNOWLEDGE_OBJECT_NOT_FOUND/);
console.log('  ✓ 4. Missing exact source fails closed (no broad hydration).');

console.log('✓ PASS: All Retrieval Guard tests passed cleanly.');
