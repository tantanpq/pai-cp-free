'use strict';

const assert = require('node:assert/strict');
const {
  MINIMAL_TOOL_PROFILES,
  resolveToolProfile
} = require('../src/tool-profile-resolver');

console.log('Running JIT Tool Projection Test Suite...');

// Mock public tool definitions matching live PAI catalog
const mockPublicDefs = [
  { name: 'chief_resume', inputSchema: { type: 'object' } },
  { name: 'chief_status', inputSchema: { type: 'object' } },
  { name: 'chief_turn', inputSchema: { type: 'object' } },
  { name: 'pai_capabilities', inputSchema: { type: 'object' } },
  { name: 'pai_cognition_run', inputSchema: { type: 'object' } },
  { name: 'pai_action_run', inputSchema: { type: 'object' } },
  { name: 'pai_result', inputSchema: { type: 'object' } },
  { name: 'pai_get_pulse', inputSchema: { type: 'object' } },
  { name: 'search', inputSchema: { type: 'object' } },
  { name: 'fetch', inputSchema: { type: 'object' } },
  { name: 'pai_health', inputSchema: { type: 'object' } },
  { name: 'pai_submit_task', inputSchema: { type: 'object' } },
  { name: 'pai_recent_status', inputSchema: { type: 'object' } },
  { name: 'pai_read_status', inputSchema: { type: 'object' } },
  { name: 'pai_read_result', inputSchema: { type: 'object' } }
];

// 1. Unknown intent must yield safe fallback (BOOT_DISCOVERY), NEVER all tools
const fallback = resolveToolProfile({ intentClass: 'TOTALLY_UNKNOWN_INTENT_XYZ' }, mockPublicDefs);
assert.equal(fallback.profileId, 'BOOT_DISCOVERY');
assert.ok(fallback.toolNames.length >= 3 && fallback.toolNames.length <= 8, `Tool count (${fallback.toolNames.length}) must be between 3 and 8`);
assert.ok(!fallback.toolNames.includes('pai_action_run'), 'Fallback must not expose action tools');
assert.ok(fallback.reasonCodes.some(r => r.startsWith('UNKNOWN_INTENT_SAFE_FALLBACK')));

// 2. Empty input must yield safe fallback (BOOT_DISCOVERY)
const emptyFallback = resolveToolProfile({}, mockPublicDefs);
assert.equal(emptyFallback.profileId, 'BOOT_DISCOVERY');
assert.equal(emptyFallback.toolNames.length, 4);

// 3. SOURCE_READ profile for search/lookup intents
const readProfile = resolveToolProfile({ intentClass: 'SEARCH' }, mockPublicDefs);
assert.equal(readProfile.profileId, 'SOURCE_READ');
assert.deepEqual(readProfile.toolNames, ['chief_resume', 'search', 'fetch', 'pai_get_pulse']);
assert.ok(readProfile.toolNames.length <= 8, 'SOURCE_READ must satisfy 3-8 tool invariant');

// 4. DIRECT_COGNITION profile for thinking/query
const cogProfile = resolveToolProfile({ intentClass: 'COGNITION' }, mockPublicDefs);
assert.equal(cogProfile.profileId, 'DIRECT_COGNITION');
assert.deepEqual(cogProfile.toolNames, ['chief_turn', 'pai_capabilities', 'pai_cognition_run', 'fetch']);

// 5. GOVERNED_ACTION profile for build/repair
const actProfile = resolveToolProfile({ intentClass: 'BUILD' }, mockPublicDefs);
assert.equal(actProfile.profileId, 'GOVERNED_ACTION');
assert.deepEqual(actProfile.toolNames, ['chief_turn', 'pai_action_run', 'chief_status', 'pai_result']);

// 6. Effect ceiling enforcement: NO_EFFECT drops action tools
const restrictedAct = resolveToolProfile({ intentClass: 'BUILD', effectCeiling: 'NO_EFFECT' }, mockPublicDefs);
assert.ok(!restrictedAct.toolNames.includes('pai_action_run'), 'pai_action_run must be denied under NO_EFFECT');
assert.ok(restrictedAct.deniedCapabilities.some(d => d.includes('EFFECT_CEILING_ENFORCED')));

// 7. Deterministic profile digest: same input snapshot yields identical digest
const snapshot1 = resolveToolProfile({ intentClass: 'SEARCH', taskClass: 'INSPECT' }, mockPublicDefs);
const snapshot2 = resolveToolProfile({ intentClass: 'SEARCH', taskClass: 'INSPECT' }, mockPublicDefs);
assert.equal(snapshot1.profileDigest, snapshot2.profileDigest, 'Profile digest must be deterministic');

// 8. Explicit full catalog override: allowed only on explicit mode=ALL
const fullCatalog = resolveToolProfile({ mode: 'ALL' }, mockPublicDefs);
assert.equal(fullCatalog.profileId, 'FULL_CATALOG');
assert.equal(fullCatalog.toolNames.length, mockPublicDefs.length);

console.log('✓ PASS: All JIT tool projection tests passed (3-8 tool invariant, safe fallback, deterministic digests).');
