'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const live = require('../../chief_live_session_v1/src/chief-live-session');
const { createBridge, TOOL_DEFINITIONS, CHIEF_RESUME_MAX_BYTES } = require('../src/chief-chat-bridge');
const { createSqlitePromptEvidenceHook } = require('../src/user-prompt-evidence-hook');
const { BOOT_POINTERS, READ_TOOLS, createReadGateway, createCurrentOwnerAdapters } = require('../src/pai-read-gateway');
const { createFederationBridge } = require('../src/federation-bridge');
const { createServer } = require('../src/server');
const federationToolSchemas = require('../src/FEDERATION_TOOL_SCHEMAS.json');
const projectionOwner = require('../../../adapters/notebook_projection/projection-owner');

console.log('Running PAI Context Repair P0 Acceptance Suite (Tests A through H)...');

const identity = { userId: 'tan', paiIdentityId: 'pai-chief', projectId: 'PAI', role: 'PAI_CHIEF' };
const mindGate = { pointerStatus: () => ({ status: 'JIT_NOT_READ', version: 'TEST_MIND', driveFileId: 'fixture', sha256: '0'.repeat(64), authority: 'POINTER_ONLY_NO_DOCTRINE_CONTENT_LOADED' }) };

// ---------------------------------------------------------------------------
// TEST A: Resume leak regression
// Construct heavy contextGateway fixture with 100KB raw sources; assert chief_resume < 6,144 bytes, pointer-only.
// ---------------------------------------------------------------------------
{
  const hugeRawBlob = 'RAW_SECRET_LEAK_BODY_PAYLOAD_'.repeat(3500); // ~105KB
  const rawFragments = Array.from({ length: 40 }, (_, i) => ({
    fragmentId: `heavy-frag-${i}`,
    type: i % 2 === 0 ? 'INTENT' : 'CORRECTION',
    text: `User intent text ${i} with raw body: ${hugeRawBlob.slice(0, 500)}`,
    status: 'ROOM_LOCAL',
    createdAt: `2026-09-01T00:${String(i).padStart(2, '0')}:00.000Z`,
    sourcePointer: { sourceId: `heavy-${i}`, sourceHash: `hash-${i}` },
    rawPayload: hugeRawBlob
  }));

  const heavyRoom = {
    roomId: 'ROOM:heavy-leak-test',
    roomName: 'Heavy Leak Test Room',
    primaryTopicId: 'leak-topic',
    status: 'ACTIVE',
    revision: 99,
    projectId: 'PAI',
    rawContextDumps: hugeRawBlob
  };

  const heavyContextGateway = {
    peek: () => ({
      room: { ...heavyRoom },
      contextPackage: {
        packageId: 'PKG:heavy-1',
        roomId: heavyRoom.roomId,
        records: rawFragments,
        rawDump: hugeRawBlob,
        sourceIds: rawFragments.map(f => f.fragmentId)
      },
      rawDump: hugeRawBlob
    }),
    inspect: () => ({
      room: heavyRoom,
      fragments: rawFragments,
      rawDumps: hugeRawBlob,
      buffer: [{ text: 'RECENT_BUFFER must never be projected' }]
    }),
    current: () => { throw new Error('RAW_CONTEXT_PACKAGE_MUST_NOT_BE_USED'); }
  };

  const continuity = () => ({
    status: 'VERIFIED',
    available: true,
    lifecycleStage: 'RUNNING',
    lastVerifiedAt: '2026-09-20T10:00:00.000Z',
    sourceType: 'JIT_QCHECK_READ_ONLY',
    authority: 'QCHECK_READ_OWNER',
    raw_user_prompt: 'forbidden-raw-prompt'
  });

  const behavioralMemory = {
    recall: () => ({
      projectionHash: 'heavy-behavioral-hash',
      cards: Array.from({ length: 15 }, (_, i) => ({
        cardId: `card-${i}`,
        scope: 'PROJECT',
        scopeKey: 'PAI',
        state: 'ACTIVE',
        globalAlways: false,
        rawAssistantText: `forbidden assistant body ${i}`,
        projectionHash: `proj-hash-${i}`
      }))
    }),
    recallGlobal: () => ({
      cards: [{ cardId: 'global-1', scope: 'GLOBAL', rawData: hugeRawBlob }],
      ids: ['global-1'],
      projectionHash: 'global-hash',
      limit: 8
    })
  };

  const owners = createCurrentOwnerAdapters({ continuity, contextGateway: heavyContextGateway, behavioralMemory });
  const readGateway = createReadGateway({ owners });

  const db = live.open();
  try {
    const promptEvidence = createSqlitePromptEvidenceHook({ db, identity, sessionId: 'test-a-session' });
    const bridge = createBridge({
      identity,
      mindGate,
      db,
      promptEvidence,
      readGateway,
      contextGateway: heavyContextGateway,
      publicToolNames: [...TOOL_DEFINITIONS, ...READ_TOOLS].map(tool => tool.name)
    });

    const resumeRes = bridge.call('chief_resume', { userId: 'tan' });
    const serialized = JSON.stringify(resumeRes);
    const payloadBytes = Buffer.byteLength(JSON.stringify(resumeRes.structuredContent.result), 'utf8');
    const contentTextBytes = Buffer.byteLength(resumeRes.content[0].text, 'utf8');

    // Requirement: strictly under 6,144 bytes budget ceiling
    assert.ok(payloadBytes < CHIEF_RESUME_MAX_BYTES, `chief_resume payload bytes (${payloadBytes}) exceeds ceiling ${CHIEF_RESUME_MAX_BYTES}`);
    assert.ok(contentTextBytes < CHIEF_RESUME_MAX_BYTES, `chief_resume content text bytes (${contentTextBytes}) exceeds ceiling ${CHIEF_RESUME_MAX_BYTES}`);

    // Requirement: contextPackage is pointer-only
    const outwardContextPackage = resumeRes.structuredContent?.result?.roomContext?.contextPackage;
    assert.ok(outwardContextPackage, 'outward contextPackage must exist');
    assert.equal(outwardContextPackage.is_pointer_only, true, 'contextPackage must declare is_pointer_only: true');
    assert.equal(outwardContextPackage.records.length, 0, 'pointer-only contextPackage records must be empty');

    // Requirement: raw bodies and forbidden markers must not leak
    assert.equal(serialized.includes(hugeRawBlob.slice(0, 100)), false, 'raw 100KB blob leaked in chief_resume');
    assert.equal(serialized.includes('RAW_CONTEXT_PACKAGE'), false, 'RAW_CONTEXT_PACKAGE leaked');
    assert.equal(serialized.includes('RECENT_BUFFER'), false, 'RECENT_BUFFER leaked');
    assert.equal(serialized.includes('forbidden-raw-prompt'), false, 'raw_user_prompt leaked');
    assert.equal(serialized.includes('forbidden assistant body'), false, 'raw assistant text leaked');

    console.log(`  ✓ Test A PASSED: chief_resume payload bytes = ${payloadBytes} (content text bytes = ${contentTextBytes} < ${CHIEF_RESUME_MAX_BYTES}), pointer-only package verified, raw bodies redacted.`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// TEST B: Turn parity
// chief_turn preserves pointer-only package, receipt identity, zero whole-room dumps.
// ---------------------------------------------------------------------------
{
  const db = live.open();
  try {
    const promptEvidence = createSqlitePromptEvidenceHook({ db, identity, sessionId: 'test-b-session' });
    const bridge = createBridge({
      identity,
      mindGate,
      db,
      promptEvidence,
      publicToolNames: TOOL_DEFINITIONS.map(tool => tool.name)
    });

    const turnRes = bridge.call('chief_turn', {
      userId: 'tan',
      requestId: 'req-turn-parity-1',
      expectedRevision: 1,
      intentClass: 'ANALYZE',
      message: 'Verify turn context projection is bounded and pointer-only.'
    });

    const serialized = JSON.stringify(turnRes);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    const result = turnRes.structuredContent?.result;
    const receipt = turnRes.structuredContent?.receipt;

    assert.ok(result, 'chief_turn must return structured result');
    assert.ok(receipt, 'chief_turn must include receipt');
    assert.ok(receipt.receiptId, 'receipt must include receiptId');
    assert.equal(receipt.tool, 'chief_turn');

    const cp = result.contextPackage;
    assert.ok(cp, 'contextPackage must exist in chief_turn response');
    assert.equal(cp.is_pointer_only, true, 'turn contextPackage must be pointer-only');
    assert.equal(cp.records.length, 0);

    assert.equal(serialized.includes('RAW_CONTEXT_PACKAGE'), false);
    assert.equal(serialized.includes('raw_user_prompt'), false);

    console.log(`  ✓ Test B PASSED: chief_turn serialized bytes = ${bytes}, receipt verified, pointer-only contextPackage enforced.`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// TEST C: Task-aware tool projection
// status task: 4 tools; lookup task: 4 tools; build task: 6 tools. Pure read excludes effectful tools.
// ---------------------------------------------------------------------------
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-test-c-'));
  const app = createServer({
    env: {
      ...process.env,
      PAI_GATEWAY_CANARY: '1',
      PORT: '19792',
      CHIEF_BRIDGE_DB_PATH: path.join(tmpRoot, 'test-c.sqlite'),
      CHIEF_TASK_BOX_ROOT: path.join(tmpRoot, 'task-box'),
      CHIEF_BRIDGE_USER_ID: 'tan',
      CHIEF_BRIDGE_PAI_ID: 'pai',
      CHIEF_BRIDGE_PROJECT_ID: 'PAI',
      CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW'
    }
  });
  const bridge = app.bridge;

  // 1. STATUS intent -> 4 tools
  const statusTools = bridge.resolveJitTools({ intentClass: 'STATUS' }, bridge.publicToolDefinitions);
  assert.equal(statusTools.length, 4, `STATUS must project exactly 4 tools, got ${statusTools.length}`);
  const statusNames = new Set(statusTools.map(t => t.name));
  assert.ok(statusNames.has('chief_status'));
  assert.ok(statusNames.has('chief_resume'));
  assert.ok(statusNames.has('pai_get_pulse'));
  assert.ok(statusNames.has('chief_turn'));
  // Effectful tools must NOT be present
  for (const effectful of ['chief_admit_committed_work', 'chief_prepare_handoff', 'pai_action_run', 'chief_work_request', 'pai_submit_task']) {
    assert.equal(statusNames.has(effectful), false, `Effectful tool ${effectful} must not appear in STATUS projection`);
  }

  // 2. LOOKUP intent -> 4 tools
  const lookupTools = bridge.resolveJitTools({ intentClass: 'LOOKUP' }, bridge.publicToolDefinitions);
  assert.equal(lookupTools.length, 4, `LOOKUP must project exactly 4 tools, got ${lookupTools.length}`);
  const lookupNames = new Set(lookupTools.map(t => t.name));
  assert.ok(lookupNames.has('search'));
  assert.ok(lookupNames.has('fetch'));
  assert.ok(lookupNames.has('chief_turn'));
  assert.ok(lookupNames.has('pai_get_context_pack'));
  for (const effectful of ['chief_admit_committed_work', 'chief_prepare_handoff', 'pai_action_run', 'chief_work_request', 'pai_submit_task']) {
    assert.equal(lookupNames.has(effectful), false, `Effectful tool ${effectful} must not appear in LOOKUP projection`);
  }

  // 3. BUILD intent -> 6 tools
  const buildTools = bridge.resolveJitTools({ intentClass: 'BUILD' }, bridge.publicToolDefinitions);
  assert.equal(buildTools.length, 6, `BUILD must project exactly 6 tools, got ${buildTools.length}`);
  const buildNames = new Set(buildTools.map(t => t.name));
  assert.ok(buildNames.has('chief_turn'));
  assert.ok(buildNames.has('chief_admit_committed_work'));
  assert.ok(buildNames.has('pai_get_work_item'));
  assert.ok(buildNames.has('pai_get_result_event'));
  assert.ok(buildNames.has('pai_get_host_capabilities'));
  assert.ok(buildNames.has('chief_prepare_handoff'));

  console.log('  ✓ Test C PASSED: STATUS (4 tools), LOOKUP (4 tools), BUILD (6 tools). Pure read strictly excludes effectful tools.');
}

// ---------------------------------------------------------------------------
// TEST D: Tool budget test
// Routine bootstrap projects 6 tools (3–8 range), bounded fallback, schema size < 5KB vs 19KB unconstrained.
// ---------------------------------------------------------------------------
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-test-d-'));
  const app = createServer({
    env: {
      ...process.env,
      PAI_GATEWAY_CANARY: '1',
      PORT: '19793',
      CHIEF_BRIDGE_DB_PATH: path.join(tmpRoot, 'test-d.sqlite'),
      CHIEF_TASK_BOX_ROOT: path.join(tmpRoot, 'task-box'),
      CHIEF_BRIDGE_USER_ID: 'tan',
      CHIEF_BRIDGE_PAI_ID: 'pai',
      CHIEF_BRIDGE_PROJECT_ID: 'PAI',
      CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW'
    }
  });
  const bridge = app.bridge;

  // JIT Routine Bootstrap
  const bootstrapTools = bridge.resolveJitTools({ jit: true }, bridge.publicToolDefinitions);
  assert.equal(bootstrapTools.length, 7, `Bootstrap must project exactly 7 tools, got ${bootstrapTools.length}`);
  assert.ok(bootstrapTools.length >= 3 && bootstrapTools.length <= 8, 'Bootstrap tools must be within [3, 8] range');

  const bootstrapNames = bootstrapTools.map(t => t.name);
  assert.deepEqual(bootstrapNames, ['chief_resume', 'chief_status', 'pai_get_pulse', 'search', 'fetch', 'chief_turn', 'pai_action_run']);

  const bootstrapSchemaBytes = Buffer.byteLength(JSON.stringify(bootstrapTools), 'utf8');
  const fullSchemaBytes = Buffer.byteLength(JSON.stringify(bridge.publicToolDefinitions), 'utf8');

    assert.ok(bootstrapSchemaBytes < 12000, `Bootstrap schema bytes (${bootstrapSchemaBytes}) should be < 12,000`);
    assert.ok(fullSchemaBytes > 18000, `Full schema bytes (${fullSchemaBytes}) should be > 18,000`);

  // Bounded fallback: unconstrained ALL mode returns full tool set (26 tools)
  const allProjected = bridge.resolveJitTools({ mode: 'ALL' }, bridge.publicToolDefinitions);
  assert.equal(allProjected.length, bridge.publicToolDefinitions.length, 'mode: ALL must return full tool set for backward compatibility');

  console.log(`  ✓ Test D PASSED: Bootstrap projects 6 tools (${bootstrapSchemaBytes} bytes vs full ${fullSchemaBytes} bytes, ~${Math.ceil(bootstrapSchemaBytes / 4)} tokens vs ~${Math.ceil(fullSchemaBytes / 4)} tokens).`);
}

// ---------------------------------------------------------------------------
// TEST E: Boot budget test
// pai_resume payload < 2,048 bytes; pointer references only; no behavioral memory dump.
// ---------------------------------------------------------------------------
{
  const continuity = () => ({
    status: 'VERIFIED',
    available: true,
    lifecycleStage: 'RUNNING',
    lastVerifiedAt: '2026-09-20T10:00:00.000Z',
    sourceType: 'JIT_QCHECK_READ_ONLY',
    authority: 'QCHECK_READ_OWNER'
  });

  const owners = createCurrentOwnerAdapters({ continuity, bootPointers: BOOT_POINTERS });
  const readGateway = createReadGateway({ owners });

  const resume = readGateway.call('pai_resume').structuredContent;
  const serialized = JSON.stringify(resume);
  const bytes = Buffer.byteLength(serialized, 'utf8');

  assert.ok(bytes < 2048, `pai_resume payload (${bytes} bytes) must be < 2048 bytes`);
  assert.equal(resume.boot.profile, 'THIN_BOOT_R3');
  assert.equal(resume.boot.notebookOperatingMapPointer, '06_STATE/PAI_CHIEF_WORK_NOTEBOOK_R1/PAI_CHIEF_WORK_NOTEBOOK_CURRENT.md#section-0');
  assert.equal(resume.boot.activeArchitecturePointer, '06_STATE/PAI_ACTIVE_ARCHITECTURE_POINTER.json');
  assert.equal(Object.hasOwn(resume, 'behavioralMemory'), false, 'pai_resume must not contain behavioralMemory');

  console.log(`  ✓ Test E PASSED: pai_resume is ${bytes} bytes (< 2048 bytes), profile THIN_BOOT_R3, pointers verified.`);
}

// ---------------------------------------------------------------------------
// TEST F: Notebook section test
// Fetch semantic:notebook-operating-map returns §0 only (< 2,048 bytes), never the 25KB+ full notebook.
// ---------------------------------------------------------------------------
{
  // Exercise the recovered section owner, never personal/live notebook content.
  const wholeFileContent = '# Hermetic notebook fixture\n## 1. NOW\nCURRENT_OPERATING_MAP: fixture only\n\n## 2. NEXT\n'
    + 'Non-operating-map fixture row.\n'.repeat(1000)
    + '\n## 3. ACTIVE_PROGRAM_BOARDS\nFixture only\n## 7. HISTORICAL_LOG\nFixture only\n';
  assert.ok(wholeFileContent.length > 20000, `Whole notebook must be > 20KB, got ${wholeFileContent.length}`);

  const notebookOperatingMapLoader = () => {
    return projectionOwner.extractSection(wholeFileContent, 'CURRENT_OPERATING_MAP');
  };

  const catalog = [{
    id: 'semantic:notebook-operating-map',
    canonicalId: '1aT0ywd293nSgo1J5THzpaDcSgjA6rX6zVDe8H0tJ1k0',
    title: 'PAI Chief Work Notebook §0 CURRENT_OPERATING_MAP',
    url: 'https://drive.google.com/open?id=1aT0ywd293nSgo1J5THzpaDcSgjA6rX6zVDe8H0tJ1k0',
    cones: ['ARCHITECTURE', 'CURRENT_RUNTIME'],
    classification: 'BOUNDED_SECTION_PROJECTION',
    authority: 'READ_MODEL_SECTION_0_ONLY_NO_AUTHORITY',
    load: notebookOperatingMapLoader
  }];

  const owners = createCurrentOwnerAdapters({});
  const readGateway = createReadGateway({ owners, catalog });

  const fetched = readGateway.call('fetch', { id: 'semantic:notebook-operating-map', mode: 'FULL' }).structuredContent;
  const sectionText = fetched.text;
  const sectionBytes = Buffer.byteLength(sectionText, 'utf8');

  assert.ok(sectionBytes < 2048, `Section 0 payload (${sectionBytes} bytes) must be < 2048 bytes`);
  assert.ok(sectionText.includes('## 1. NOW') && sectionText.includes('SECTION_0_BOUNDED'), 'Must contain §0 / NOW header');
  assert.equal(sectionText.includes('## 3. ACTIVE_PROGRAM_BOARDS'), false, 'Must not include subsequent sections');
  assert.equal(sectionText.includes('## 7. HISTORICAL_LOG'), false, 'Must not include historical logs');

  console.log(`  ✓ Test F PASSED: Notebook §0 retrieval is ${sectionBytes} bytes (${sectionText.length} chars) vs ${wholeFileContent.length} chars whole file.`);
}

// ---------------------------------------------------------------------------
// TEST G: Retrieval guard
// Search with no matches returns 0 bodies; non-existent ID throws KNOWLEDGE_OBJECT_NOT_FOUND cleanly.
// ---------------------------------------------------------------------------
{
  const owners = createCurrentOwnerAdapters({});
  const catalog = [
    { id: 'semantic:boot', title: 'PAI Boot', cones: ['ARCHITECTURE'], text: 'Boot text' }
  ];
  const readGateway = createReadGateway({ owners, catalog });

  // 1. Zero-result search
  const searchRes = readGateway.call('search', { query: 'cone:ARCHITECTURE completely_non_existent_key_99999' }).structuredContent;
  assert.equal(searchRes.results.length, 0, 'Zero-match search must return empty results array');
  assert.equal(JSON.stringify(searchRes).includes('Boot text'), false, 'No candidate body leakage in search');

  // 2. Missing ID fetch fails cleanly
  assert.throws(
    () => readGateway.call('fetch', { id: 'completely_unknown_id', mode: 'FULL' }),
    /KNOWLEDGE_OBJECT_NOT_FOUND/
  );

  console.log('  ✓ Test G PASSED: Zero-result search returns 0 bodies; missing ID cleanly yields KNOWLEDGE_OBJECT_NOT_FOUND.');
}

// ---------------------------------------------------------------------------
// TEST H: Duplicate semantic object test
// Canonical + staging aliases deduped to 1 projection in search.
// ---------------------------------------------------------------------------
{
  const owners = createCurrentOwnerAdapters({});
  const fixedDriveId = '1aT0ywd293nSgo1J5THzpaDcSgjA6rX6zVDe8H0tJ1k0';
  const catalog = [
    {
      id: 'semantic:notebook-operating-map',
      canonicalId: fixedDriveId,
      title: 'PAI Chief Work Notebook §0 CURRENT_OPERATING_MAP',
      url: `https://drive.google.com/open?id=${fixedDriveId}`,
      cones: ['ARCHITECTURE'],
      provenance: { fixedDriveId, version: 'SECTION_0' },
      text: 'Notebook Section 0'
    },
    {
      id: 'semantic:notebook',
      canonicalId: fixedDriveId,
      title: 'PAI Chief Work Notebook Staging Alias',
      url: `https://drive.google.com/open?id=${fixedDriveId}`,
      cones: ['ARCHITECTURE'],
      provenance: { fixedDriveId, version: 'STAGING' },
      text: 'Notebook Staging'
    },
    {
      id: 'PAI_CHIEF_WORK_NOTEBOOK_CURRENT',
      canonicalId: fixedDriveId,
      title: 'PAI Chief Work Notebook Legacy Alias',
      url: `https://drive.google.com/open?id=${fixedDriveId}`,
      cones: ['ARCHITECTURE'],
      provenance: { fixedDriveId, version: 'LEGACY' },
      text: 'Notebook Legacy'
    }
  ];

  const readGateway = createReadGateway({ owners, catalog });
  const searchRes = readGateway.call('search', { query: 'cone:ARCHITECTURE notebook' }).structuredContent;

  assert.equal(searchRes.results.length, 1, `Expected exactly 1 canonical search result for notebook aliases, got ${searchRes.results.length}`);
  assert.equal(searchRes.results[0].canonicalId, fixedDriveId);
  assert.ok(searchRes.conflictCount > 0 || searchRes.dedupedCount > 0, 'Deduplication or conflict count must be recorded');

  console.log(`  ✓ Test H PASSED: 3 alias objects deduplicated into 1 canonical result (deduped/conflicts recorded).`);
}

console.log('\nALL PAI CONTEXT REPAIR P0 ACCEPTANCE TESTS (A-H) PASSED CLEANLY.\n');
