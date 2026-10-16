'use strict';

const crypto = require('node:crypto');

const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

const MINIMAL_TOOL_PROFILES = Object.freeze({
  BOOT_DISCOVERY: Object.freeze({
    id: 'BOOT_DISCOVERY',
    description: 'Minimal discovery and status shell for session initiation',
    tools: Object.freeze(['chief_resume', 'chief_status', 'pai_capabilities', 'pai_get_pulse']),
    sourceClasses: Object.freeze(['POINTER_METADATA', 'SYSTEM_STATUS']),
    defaultJitReads: Object.freeze([])
  }),
  SOURCE_READ: Object.freeze({
    id: 'SOURCE_READ',
    description: 'Bounded metadata discovery and exact single-source retrieval',
    tools: Object.freeze(['chief_resume', 'search', 'fetch', 'pai_get_pulse']),
    sourceClasses: Object.freeze(['EXACT_SOURCE_BODY_BOUNDED', 'SEARCH_METADATA_ONLY']),
    defaultJitReads: Object.freeze(['source:exact_fetch'])
  }),
  DIRECT_COGNITION: Object.freeze({
    id: 'DIRECT_COGNITION',
    description: 'Cognitive reasoning and capability-routed analysis with zero action authority',
    tools: Object.freeze(['chief_turn', 'pai_capabilities', 'pai_cognition_run', 'fetch']),
    sourceClasses: Object.freeze(['COGNITION_OUTPUT_CANDIDATE', 'CAPABILITY_CARD']),
    defaultJitReads: Object.freeze([])
  }),
  GOVERNED_ACTION: Object.freeze({
    id: 'GOVERNED_ACTION',
    description: 'Chief Preview/Commit action requests routed through governed TaskBox admission',
    tools: Object.freeze(['chief_turn', 'pai_action_run', 'chief_status', 'pai_result']),
    sourceClasses: Object.freeze(['TASKBOX_CLAIM_RECEIPT', 'ADMISSION_PROJECTION']),
    defaultJitReads: Object.freeze(['admission:state'])
  }),
  HOST_CONTROL: Object.freeze({
    id: 'HOST_CONTROL',
    description: 'Governed host terminal/inspect/filesystem/service control through PAI — no raw shell',
    tools: Object.freeze(['chief_turn', 'pai_action_run', 'pai_capabilities', 'pai_result']),
    sourceClasses: Object.freeze(['HOST_CONTROL_RECEIPT', 'CAPABILITY_CARD']),
    defaultJitReads: Object.freeze([])
  }),
  PUBLIC_TASK_INBOX: Object.freeze({
    id: 'PUBLIC_TASK_INBOX',
    description: 'Reduced isolated public inbox for remote submission and status observation',
    tools: Object.freeze(['pai_health', 'pai_submit_task', 'pai_recent_status', 'pai_read_status', 'pai_read_result']),
    sourceClasses: Object.freeze(['PUBLIC_INBOX_WIRE']),
    defaultJitReads: Object.freeze([])
  })
});

const INTENT_TO_PROFILE = Object.freeze({
  // Discovery / Status
  BOOT: 'BOOT_DISCOVERY',
  BOOTSTRAP: 'BOOT_DISCOVERY',
  STATUS: 'BOOT_DISCOVERY',
  REPORT: 'BOOT_DISCOVERY',
  DISCOVERY: 'BOOT_DISCOVERY',

  // Source / Retrieval
  READ: 'SOURCE_READ',
  SOURCE: 'SOURCE_READ',
  LOOKUP: 'SOURCE_READ',
  SEARCH: 'SOURCE_READ',
  RESEARCH: 'SOURCE_READ',
  SOURCE_CHECK: 'SOURCE_READ',
  RETRIEVAL: 'SOURCE_READ',

  // Cognition
  COGNITION: 'DIRECT_COGNITION',
  THINK: 'DIRECT_COGNITION',
  DIRECT: 'DIRECT_COGNITION',
  DIRECT_QUERY: 'DIRECT_COGNITION',
  PLAN: 'DIRECT_COGNITION',
  INSPECT: 'DIRECT_COGNITION',

  // Governed Action
  ACTION: 'GOVERNED_ACTION',
  BUILD: 'GOVERNED_ACTION',
  REPAIR: 'GOVERNED_ACTION',
  QA: 'GOVERNED_ACTION',
  RELEASE: 'GOVERNED_ACTION',
  RUNTIME_ACTION: 'GOVERNED_ACTION',
  CHANGE: 'GOVERNED_ACTION',
  EXECUTE: 'GOVERNED_ACTION',
  COMMIT: 'GOVERNED_ACTION',

  // Host Control — governed terminal/host operations
  HOST_CONTROL: 'HOST_CONTROL',
  HOST_INSPECT: 'HOST_CONTROL',
  TERMINAL_COMMAND: 'HOST_CONTROL',
  FILESYSTEM_READ: 'HOST_CONTROL',
  FILESYSTEM_EDIT: 'HOST_CONTROL',
  SERVICE_CONTROL: 'HOST_CONTROL',
  PROCESS_CONTROL: 'HOST_CONTROL',
  INSPECT_AND_PLAN: 'HOST_CONTROL',

  // Public Inbox
  PUBLIC_INBOX: 'PUBLIC_TASK_INBOX',
  PUBLIC: 'PUBLIC_TASK_INBOX'
});

function resolveToolProfile(input = {}, publicDefs = []) {
  const reasonCodes = [];
  const rawIntent = input.intentClass || input.intent || input.taskClass || input.task;
  const intentClass = rawIntent ? String(rawIntent).toUpperCase().trim() : null;
  const requestedProfile = input.profile ? String(input.profile).toUpperCase().trim() : null;
  const mode = input.mode ? String(input.mode).toUpperCase().trim() : null;

  // Check for explicit full catalog override (for backward-compatible tests or admin inspections)
  if (mode === 'ALL' || (!intentClass && requestedProfile === 'STATIC_ALL') || (!intentClass && input.fullCatalogOverride === true)) {
    const toolNames = publicDefs.map(t => t.name);
    const schemaDigests = {};
    for (const def of publicDefs) {
      schemaDigests[def.name] = sha256(def.inputSchema || {});
    }
    const profileDigest = sha256({ profileId: 'FULL_CATALOG', toolNames, schemaDigests });
    return {
      profileId: 'FULL_CATALOG',
      toolNames,
      tools: publicDefs,
      sourceClasses: ['ALL_ACCESSIBLE'],
      deniedCapabilities: [],
      requiredJitReads: [],
      schemaDigests,
      reasonCodes: ['EXPLICIT_FULL_CATALOG_OVERRIDE'],
      profileDigest
    };
  }

  // Resolve target profile
  let targetProfileId = null;
  if (requestedProfile && MINIMAL_TOOL_PROFILES[requestedProfile]) {
    targetProfileId = requestedProfile;
    reasonCodes.push('EXPLICIT_PROFILE_REQUESTED');
  } else if (intentClass && INTENT_TO_PROFILE[intentClass]) {
    targetProfileId = INTENT_TO_PROFILE[intentClass];
    reasonCodes.push(`INTENT_CLASS_MAPPED:${intentClass}`);
  } else {
    // Safe fallback: minimal discovery/read shell
    targetProfileId = 'BOOT_DISCOVERY';
    reasonCodes.push(intentClass ? `UNKNOWN_INTENT_SAFE_FALLBACK:${intentClass}` : 'NO_INTENT_SAFE_FALLBACK');
  }

  const profileSpec = MINIMAL_TOOL_PROFILES[targetProfileId];
  const targetNames = profileSpec.tools;

  // Filter against available public definitions
  const availableMap = new Map();
  for (const def of publicDefs) {
    availableMap.set(def.name, def);
  }

  const selectedTools = [];
  const selectedNames = [];
  const deniedCapabilities = [];
  const schemaDigests = {};

  // Check effect / authority ceiling
  const effectCeiling = String(input.effectCeiling || 'UNRESTRICTED').toUpperCase();
  const privacyCeiling = String(input.privacyCeiling || 'UNRESTRICTED').toUpperCase();

  for (const name of targetNames) {
    if (effectCeiling === 'NO_EFFECT' && (name === 'pai_action_run' || name === 'chief_turn')) {
      deniedCapabilities.push(`${name}:EFFECT_CEILING_ENFORCED`);
      continue;
    }
    if (privacyCeiling === 'PUBLIC_ONLY' && (name === 'fetch' || name === 'pai_get_context_pack')) {
      deniedCapabilities.push(`${name}:PRIVACY_CEILING_ENFORCED`);
      continue;
    }

    if (availableMap.has(name)) {
      const def = availableMap.get(name);
      selectedTools.push(def);
      selectedNames.push(name);
      schemaDigests[name] = sha256(def.inputSchema || {});
    } else {
      // In-process dummy/fallback card if publicDefs not provided
      selectedNames.push(name);
      schemaDigests[name] = sha256({ name });
    }
  }

  // Enforce tool budget invariant: 3 to 8 tools
  if (selectedNames.length > 8 && !input.allowOversizedProfile) {
    throw new Error(`TOOL_BUDGET_EXCEEDED: profile ${targetProfileId} has ${selectedNames.length} tools (max 8 without explicit reason)`);
  }

  const profileDigest = sha256({
    profileId: targetProfileId,
    toolNames: selectedNames,
    sourceClasses: profileSpec.sourceClasses,
    schemaDigests,
    reasonCodes
  });

  return {
    profileId: targetProfileId,
    toolNames: selectedNames,
    tools: selectedTools,
    sourceClasses: [...profileSpec.sourceClasses],
    deniedCapabilities,
    requiredJitReads: [...profileSpec.defaultJitReads],
    schemaDigests,
    reasonCodes,
    profileDigest
  };
}

module.exports = {
  MINIMAL_TOOL_PROFILES,
  INTENT_TO_PROFILE,
  resolveToolProfile,
  sha256
};
