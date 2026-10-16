'use strict';

/**
 * Context Contracts & Envelopes
 *
 * Implements bounded operational contracts (Sections 14, 23, 24, 25, 26, 27, 39):
 * - CONTEXT_MISS envelope
 * - Builder Mission Capsule
 * - Builder Result contract
 * - Independent QA Context contract
 * - Platform-Owned vs PAI-Controlled classification
 * - Honest uncertainty status
 */

const crypto = require('node:crypto');

const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/**
 * Creates a bounded CONTEXT_MISS payload (Section 14).
 * Triggers exactly one bounded JIT read without hydrating the entire project library.
 */
function createContextMiss({
  requiredPointer = 'pointer:unknown',
  sourceClass = 'UNKNOWN_SOURCE_CLASS',
  reason = 'MISSING_EXACT_CONTEXT'
} = {}) {
  return {
    status: 'CONTEXT_MISS',
    required_pointer: String(requiredPointer).trim(),
    source_class: String(sourceClass).trim(),
    reason: String(reason).trim(),
    next_action: 'SINGLE_BOUNDED_JIT_READ',
    forbidden_action: 'FULL_PROJECT_HYDRATION_DENIED',
    disposition: 'UNKNOWN'
  };
}

/**
 * Formats a Builder Mission Capsule (Section 23).
 * Sends only essential operational boundaries to Grok/Anti/Codex builder.
 */
function createBuilderMissionCapsule({
  missionId,
  objective,
  acceptance = [],
  allowedScope = '',
  sourcePointers = [],
  requiredFiles = [],
  effectCeiling = 'LOCAL_FILE_EDIT_AND_TEST',
  authorityRefs = [],
  tests = [],
  outputContract = 'BOUNDED_RECEIPT_AND_EXTERNAL_DIFF'
} = {}) {
  const capsule = {
    schema: 'pai-builder-mission-capsule/v1',
    mission_id: String(missionId || `mission_${Date.now()}`),
    objective: String(objective || '').trim(),
    acceptance: Array.isArray(acceptance) ? acceptance : [String(acceptance)],
    allowed_scope: String(allowedScope || '').trim(),
    source_pointers: Array.isArray(sourcePointers) ? sourcePointers : [String(sourcePointers)],
    required_files: Array.isArray(requiredFiles) ? requiredFiles : [String(requiredFiles)],
    effect_ceiling: String(effectCeiling),
    authority_refs: Array.isArray(authorityRefs) ? authorityRefs : [String(authorityRefs)],
    tests: Array.isArray(tests) ? tests : [String(tests)],
    output_contract: String(outputContract),
    context_policy: 'POINTER_FIRST_JIT_EXPAND_ON_DEMAND'
  };
  capsule.capsule_hash = sha256(capsule);
  return Object.freeze(capsule);
}

/**
 * Formats a Builder Result (Section 24).
 * Keeps logs and diffs external while returning concise status to Chief.
 */
function createBuilderResult({
  missionId,
  status = 'PASS',
  changedFiles = [],
  tests = null,
  keyDesignDecisions = [],
  rollback = null,
  evidenceRefs = [],
  remainingBlocker = null
} = {}) {
  const result = {
    schema: 'pai-builder-result/v1',
    mission_id: String(missionId || ''),
    status: String(status).toUpperCase().trim(),
    changed_files: Array.isArray(changedFiles) ? changedFiles.slice(0, 15) : [String(changedFiles)],
    tests: typeof tests === 'object' ? tests : { status: String(tests || 'PASS') },
    key_design_decisions: Array.isArray(keyDesignDecisions) ? keyDesignDecisions.slice(0, 5) : [String(keyDesignDecisions)],
    rollback: rollback ? String(rollback).trim() : 'REVERT_MUTATIONS_TO_SOURCE_LOCK',
    evidence_refs: Array.isArray(evidenceRefs) ? evidenceRefs.slice(0, 5) : [String(evidenceRefs)],
    remaining_blocker: remainingBlocker ? String(remainingBlocker).trim() : null
  };
  result.result_hash = sha256(result);
  return Object.freeze(result);
}

/**
 * Formats an Independent QA Context packet (Section 25).
 * Sends only the frozen candidate pointer and acceptance rules, not builder chat history.
 */
function createIndependentQAContext({
  frozenCandidatePointer,
  acceptanceCriteria = [],
  sourceLock = {},
  builderIdentity = 'ANTIGRAVITY_CLI',
  requiredTests = [],
  knownNonGoals = []
} = {}) {
  const qaPacket = {
    schema: 'pai-independent-qa-context/v1',
    frozen_candidate_pointer: String(frozenCandidatePointer || '').trim(),
    acceptance_criteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [String(acceptanceCriteria)],
    source_lock: sourceLock,
    builder_identity: String(builderIdentity),
    required_tests: Array.isArray(requiredTests) ? requiredTests : [String(requiredTests)],
    known_non_goals: Array.isArray(knownNonGoals) ? knownNonGoals : [String(knownNonGoals)],
    isolation_guarantee: 'BUILDER_TRANSCRIPT_EXCLUDED'
  };
  qaPacket.packet_hash = sha256(qaPacket);
  return Object.freeze(qaPacket);
}

/**
 * Classify context origin (Section 27).
 */
function classifyContextOrigin(sourceName) {
  const norm = String(sourceName || '').toLowerCase();
  if (/system_instructions|chatgpt_platform|grok_platform|openai_internal|anthropic_system/.test(norm)) {
    return 'PLATFORM_OWNED';
  }
  if (/chief_|pai_|taskbox|notebook|pointer|candidate|skill_store/.test(norm)) {
    return 'PAI_CONTROLLED';
  }
  return 'UNKNOWN';
}

module.exports = {
  createContextMiss,
  createBuilderMissionCapsule,
  createBuilderResult,
  createIndependentQAContext,
  classifyContextOrigin
};
