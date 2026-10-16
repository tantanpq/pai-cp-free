'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NOTEBOOK_CANONICAL_PATH = process.env.PAI_CHIEF_NOTEBOOK_PATH || null;
const NOTEBOOK_SECTION_0_ID = 'section-0';

const sha256 = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

function parseNotebookSection0(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    throw new Error('NOTEBOOK_CONTENT_INVALID');
  }

  // Section 0 is lines up to the first '## 1.' heading
  const lines = rawContent.split(/\r?\n/);
  const sec0Lines = [];
  for (const line of lines) {
    if (/^##\s+1\./.test(line)) break;
    sec0Lines.push(line);
  }
  const text = sec0Lines.join('\n').trim();

  // Extract structured tags from section 0 text
  const extractTag = tag => {
    const match = text.match(new RegExp(`^${tag}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  };

  const status = extractTag('STATUS') || 'ACTIVE_READ_MODEL';
  const scope = extractTag('SCOPE') || 'PROJECT / PAI';
  const purpose = extractTag('PURPOSE');
  const truthRule = extractTag('TRUTH_RULE');
  const updateOwner = extractTag('UPDATE_OWNER') || 'ONE_CHIEF_NOTEBOOK_WRITER_ONLY';

  return {
    text,
    status,
    scope,
    purpose,
    truthRule,
    updateOwner
  };
}

function createNotebookSection0Projection({
  notebookPath = NOTEBOOK_CANONICAL_PATH,
  now = () => new Date().toISOString()
} = {}) {
  if (!notebookPath || !path.isAbsolute(notebookPath)) throw new Error('NOTEBOOK_SOURCE_PATH_REQUIRED');
  const resolved = path.resolve(notebookPath);
  if (!fs.existsSync(resolved)) {
    throw new Error('NOTEBOOK_SOURCE_NOT_FOUND');
  }

  // Read only the first 4KB to extract Section 0, rather than full file
  const fd = fs.openSync(resolved, 'r');
  const buffer = Buffer.alloc(4096);
  const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
  fs.closeSync(fd);

  const rawHead = buffer.subarray(0, bytesRead).toString('utf8');
  const parsed = parseNotebookSection0(rawHead);
  const stat = fs.statSync(resolved);
  const sourceRevision = sha256(`${stat.size}:${stat.mtimeMs}`);

  const projectionPayload = {
    sourceId: '06_STATE/PAI_CHIEF_WORK_NOTEBOOK_R1/PAI_CHIEF_WORK_NOTEBOOK_CURRENT.md',
    sourceRevision,
    sectionId: NOTEBOOK_SECTION_0_ID,
    generatedAt: now(),
    ownerRoutingRefs: [parsed.updateOwner, parsed.scope],
    programRefs: [
      'PROGRAM_5E8C742169449640A846AB3F', // Personal Beta Completion
      'PROGRAM_1081C7B63A43671CA31F7667'  // GTM Private Beta
    ],
    reservationRefs: [],
    supersessionRefs: [
      'G0 -> G1 -> G2 -> G3',
      'Experience Continuity (PROGRAM_DONE)'
    ],
    priorityRefs: [
      'P1 PERSONAL',
      'P2 CHIEF',
      'LEARNING',
      'PORTFOLIO'
    ],
    section0Meta: {
      status: parsed.status,
      scope: parsed.scope,
      purpose: parsed.purpose,
      truthRule: parsed.truthRule
    },
    authority: 'DERIVATIVE_PROJECTION_ONLY; CANONICAL_NOTEBOOK_REMAINS_AUTHORITY',
    byteLength: Buffer.byteLength(parsed.text, 'utf8')
  };

  const projectionDigest = sha256(JSON.stringify(projectionPayload));

  return {
    ...projectionPayload,
    projectionDigest,
    compactSummary: parsed.text
  };
}

module.exports = {
  NOTEBOOK_CANONICAL_PATH,
  NOTEBOOK_SECTION_0_ID,
  parseNotebookSection0,
  createNotebookSection0Projection
};
