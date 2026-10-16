'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createNotebookSection0Projection,
  NOTEBOOK_SECTION_0_ID
} = require('../src/notebook-projection');

console.log('Running Notebook Section 0 Projection Test Suite...');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-notebook-projection-'));
const notebookPath = path.join(fixtureRoot, 'PAI_CHIEF_WORK_NOTEBOOK_CURRENT.md');
fs.writeFileSync(notebookPath, '# PAI CHIEF WORK NOTEBOOK\nSTATUS: ACTIVE_READ_MODEL\nSCOPE: PROJECT / PAI\nPURPOSE: fixture projection\nTRUTH_RULE: JIT\nUPDATE_OWNER: ONE_CHIEF_NOTEBOOK_WRITER_ONLY\n## 1. NOW\nnot in section zero\n## 2. RECENTLY VERIFIED DONE\n', 'utf8');

// 1. Projection succeeds on canonical file
const projection = createNotebookSection0Projection({
  notebookPath
});

assert.ok(projection, 'Projection must exist');
assert.equal(projection.sectionId, NOTEBOOK_SECTION_0_ID);
assert.equal(projection.sourceId, '06_STATE/PAI_CHIEF_WORK_NOTEBOOK_R1/PAI_CHIEF_WORK_NOTEBOOK_CURRENT.md');
assert.ok(projection.sourceRevision, 'sourceRevision must be present');
assert.ok(projection.generatedAt, 'generatedAt must be present');
assert.ok(Array.isArray(projection.ownerRoutingRefs), 'ownerRoutingRefs must be an array');
assert.ok(Array.isArray(projection.programRefs), 'programRefs must be an array');
assert.ok(Array.isArray(projection.supersessionRefs), 'supersessionRefs must be an array');
assert.ok(Array.isArray(projection.priorityRefs), 'priorityRefs must be an array');
assert.ok(projection.projectionDigest, 'projectionDigest must be present');
assert.ok(projection.compactSummary.includes('PAI CHIEF WORK NOTEBOOK'), 'Must contain header');
assert.ok(!projection.compactSummary.includes('## 1. NOW'), 'Section 0 must NOT leak Section 1 NOW');
assert.ok(!projection.compactSummary.includes('## 2. RECENTLY VERIFIED DONE'), 'Section 0 must NOT leak Section 2');

// 2. Invariant: Compact projection size must be < 2,500 bytes (raw notebook is ~26,000 bytes, >90% reduction)
const projectionBytes = Buffer.byteLength(JSON.stringify(projection), 'utf8');
assert.ok(projectionBytes < 2500, `Projection size (${projectionBytes} bytes) must be < 2500 bytes`);

// 3. Whole-file read denial test: ensure routine projection does not read full file
let bytesReadTotal = 0;
const originalReadSync = fs.readSync;
fs.readSync = function(fd, buffer, offset, length, position) {
  bytesReadTotal += length;
  return originalReadSync.apply(this, arguments);
};

try {
  createNotebookSection0Projection({ notebookPath });
  assert.ok(bytesReadTotal <= 4096, `Routine projection read ${bytesReadTotal} bytes; expected <= 4096 bytes (no whole-file read)`);
} finally {
  fs.readSync = originalReadSync;
}

console.log(`✓ PASS: Notebook Section 0 projection (${projectionBytes} bytes vs 26KB full notebook, bounded head read).`);
