'use strict';

// This adapter is intentionally the only MCP-facing authority. It delegates to
// bounded Chief/session modules and never exposes their storage or executors.
const crypto = require('node:crypto');
const live = require('../../chief_live_session_v1/src/chief-live-session');
const experience = require('./chief-conversation-experience');
let paiChiefModule = null, paiMindModule = null;
const paiChief = () => paiChiefModule || (paiChiefModule = require('../../pai_chief_v1/src/pai-chief'));
const paiMind = () => paiMindModule || (paiMindModule = require('../../pai_mind_v1/src/pai-mind'));
const { READ_TOOLS } = require('./pai-read-gateway');
const { compactHealth } = require('./context-economy/health-compact');
const { resolveToolProfile, MINIMAL_TOOL_PROFILES } = require('./tool-profile-resolver');
const { createNotebookSection0Projection } = require('./notebook-projection');
const { projectToolsList, projectExactToolSchema } = require('./context-economy/tool-catalog-projection');


const SESSION_ID = 'pai-chief-main';
const MAX_CALLS_PER_MINUTE = 120;
const MAX_TEXT = 2000;
// This tool stores exact user evidence only; it is deliberately larger than
// command-oriented bridge text, but remains bounded below the HTTP body cap.
const MAX_PROMPT_TEXT = 8192;
const BLOCKED_TEXT = /ignore (previous|all) instructions|system prompt|reveal .*\*prompt|api[_ -]?key|password|secret|token|authorization|shell|filesystem|(?:execute|run|access|query)\s+(?:a\s+)?raw\s+sqlite|raw\s+sqlite\s+(?:query|statement|command|access)/i;
const DIRECT_INTENTS = new Set(['ANALYZE', 'SYNTHESIZE', 'CLARIFY', 'RECOMMEND', 'REPORT']);
const DELEGATED_INTENTS = new Set(['BUILD', 'REPAIR', 'QA', 'RELEASE', 'RUNTIME_ACTION', 'CHANGE']);
const CHIEF_RESUME_MAX_BYTES = 6144;
const JIT_INTENT_TOOL_MAP = Object.freeze({
  STATUS: ['chief_status', 'chief_resume', 'pai_get_pulse', 'chief_turn'],
  REPORT: ['chief_status', 'chief_resume', 'pai_get_pulse', 'chief_turn'],
  INSPECT: ['chief_status', 'chief_resume', 'pai_get_pulse', 'chief_turn'],
  LOOKUP: ['search', 'fetch', 'chief_turn', 'pai_get_context_pack'],
  SEARCH: ['search', 'fetch', 'chief_turn', 'pai_get_context_pack'],
  RETRIEVAL: ['search', 'fetch', 'chief_turn', 'pai_get_context_pack'],
  RESEARCH: ['search', 'fetch', 'chief_turn', 'pai_get_context_pack'],
  SOURCE_CHECK: ['search', 'fetch', 'chief_turn', 'pai_get_context_pack'],
  BUILD: ['chief_turn', 'chief_admit_committed_work', 'pai_get_work_item', 'pai_get_result_event', 'pai_get_host_capabilities', 'chief_prepare_handoff'],
  REPAIR: ['chief_turn', 'chief_admit_committed_work', 'pai_get_work_item', 'pai_get_result_event', 'pai_get_host_capabilities', 'chief_prepare_handoff'],
  QA: ['chief_turn', 'chief_admit_committed_work', 'pai_get_work_item', 'pai_get_result_event', 'pai_get_host_capabilities', 'chief_prepare_handoff'],
  RELEASE: ['chief_turn', 'chief_admit_committed_work', 'pai_get_work_item', 'pai_get_result_event', 'pai_get_host_capabilities', 'chief_prepare_handoff'],
  RUNTIME_ACTION: ['chief_turn', 'chief_admit_committed_work', 'pai_get_work_item', 'pai_get_result_event', 'pai_get_host_capabilities', 'chief_prepare_handoff'],
  CHANGE: ['chief_turn', 'chief_admit_committed_work', 'pai_get_work_item', 'pai_get_result_event', 'pai_get_host_capabilities', 'chief_prepare_handoff'],
  PROMPT_EVIDENCE: ['pai_record_user_prompt', 'pai_commit_prompt_bundle', 'pai_get_prompt_bundle', 'chief_prepare_handoff', 'chief_turn'],
  HANDOFF: ['chief_prepare_handoff', 'pai_commit_prompt_bundle', 'chief_status', 'chief_turn']
});
const CHATGPT_PUBLIC_TOOL_NAMES = Object.freeze([
  'chief_resume',
  'chief_status',
  'pai_get_pulse',
  'search',
  'fetch',
  'chief_turn',
  'pai_action_run'
]);
const JIT_BOOTSTRAP_TOOLS = CHATGPT_PUBLIC_TOOL_NAMES;
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const fail = code => { throw new Error(code); };
const cleanText = (value, code = 'BRIDGE_INPUT_INVALID', max = MAX_TEXT) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || BLOCKED_TEXT.test(value)) fail(code);
  return value.trim();
};
const optionalText = (value, code, max = 128) => value == null || value === '' ? null : cleanText(String(value), code, max);
const exactRef = (value, code, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(code);
  return value.trim();
};
const json = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
const error = (id, code) => ({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: 'CHIEF_BRIDGE_DENIED', data: { code } } });

const TOOL_DEFINITIONS = Object.freeze([
  { name: 'chief_resume', description: 'Use this when the bound user needs the current Chief session checkpoint and bounded continuity status.', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
  { name: 'chief_status', description: 'Read bounded Chief state or source-grounded status for one named Program/task.', inputSchema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['FULL', 'COMPACT'] }, maxChecks: { type: 'integer', minimum: 0, maximum: 32 }, program_id: { type: 'string', minLength: 1, maxLength: 160 }, task_id: { type: 'string', minLength: 1, maxLength: 160 } } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
  {
    name: 'chief_turn',
    description: 'Use this for a bounded Chief direct answer, temporary Branch consultation, or a request-only Governor delegation. It never claims or executes work.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['requestId', 'expectedRevision', 'intentClass', 'message'],
      properties: {
        requestId: { type: 'string', minLength: 1, maxLength: 128 },
        expectedRevision: { type: 'integer', minimum: 1 },
        intentClass: { type: 'string', enum: ['ANALYZE', 'SYNTHESIZE', 'CLARIFY', 'RECOMMEND', 'REPORT', 'BUILD', 'REPAIR', 'QA', 'RELEASE', 'RUNTIME_ACTION', 'CHANGE'] },
        message: { type: 'string', minLength: 1, maxLength: 2000 },
        mode: { type: 'string', enum: ['EXPLORE', 'DECIDE', 'EXECUTE', 'REVIEW', 'REFLECT'] },
        doctrineRead: { type: 'string', enum: ['NONE', 'AUTHORITY_AMBIGUITY', 'DOCTRINE_AMBIGUITY'] },
        effectMode: { type: 'string', enum: ['LEGACY', 'PREVIEW', 'COMMIT'] },
        actionPreviewId: { type: 'string', minLength: 1, maxLength: 160 },
        actionPreviewHash: { type: 'string', minLength: 64, maxLength: 64 },
        workSpec: { type: 'object', additionalProperties: false, required: ['mutableScope', 'requiredCapabilities', 'priority', 'task'], properties: { mutableScope: { type: 'string', minLength: 1, maxLength: 1000 }, requiredCapabilities: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 96 } }, priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, rootId: { type: 'string', minLength: 3, maxLength: 64 }, parentId: { type: 'string', minLength: 3, maxLength: 64 }, workdir: { type: 'string', minLength: 1, maxLength: 512 }, dataMode: { type: 'string', enum: ['NONE', 'READ_ONLY', 'READ_WRITE', 'PORTABLE_ARTIFACT'] }, task: { type: 'string', minLength: 1, maxLength: 2000 } } },
        branchId: { type: 'string', enum: ['NONE', 'BRAINSTORM', 'PAI_PROGRAM'] },
        externalChatId: { type: 'string', minLength: 1, maxLength: 128 },
        externalThreadId: { type: 'string', minLength: 1, maxLength: 128 },
        threadRef: { type: 'string', minLength: 1, maxLength: 256 },
        sourceMessageId: { type: 'string', minLength: 1, maxLength: 256 },
        persistPromptEvidence: { type: 'boolean' },
        roomAction: { type: 'string', enum: ['AUTO', 'CONTINUE', 'NEW', 'RETURN', 'REOPEN', 'CLOSE', 'FORGET'] },
        roomId: { type: 'string', minLength: 1, maxLength: 160 },
        roomName: { type: 'string', minLength: 1, maxLength: 160 },
        roomAliases: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 160 } },
        topicId: { type: 'string', minLength: 1, maxLength: 160 },
        purpose: { type: 'string', enum: ['CONTINUITY', 'DIRECT_RESPONSE', 'GOVERNED_DELEGATION', 'CORRECTION', 'REOPEN', 'INSPECT'] },
        privacyClass: { type: 'string', enum: ['PUBLIC', 'INTERNAL', 'PRIVATE', 'SENSITIVE', 'NEVER_PERSIST'] },
        maxPrivacyClass: { type: 'string', enum: ['PUBLIC', 'INTERNAL', 'PRIVATE', 'SENSITIVE'] },
        roomTtlMs: { type: 'integer', minimum: 60000, maximum: 2592000000 },
        roomSignals: { type: 'object', additionalProperties: false, properties: {
          decisions: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          corrections: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          openLoops: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          hypotheses: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          rejectedPaths: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          entities: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 256 } },
          personalPreferences: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          explicitFacts: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          projectDecisions: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          technicalSolutions: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          negativeKnowledge: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          externalKnowledge: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          methods: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
          procedures: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } }
        } },
        learningCandidate: { type: 'string', minLength: 1, maxLength: 512 },
        cognitiveSignals: { type: 'object', additionalProperties: false, properties: {
          importance: { type: 'number', minimum: 0, maximum: 1 }, uncertainty: { type: 'number', minimum: 0, maximum: 1 },
          recurrence: { type: 'number', minimum: 0, maximum: 1 }, urgency: { type: 'number', minimum: 0, maximum: 1 },
          informationGain: { type: 'number', minimum: 0, maximum: 1 }, surprise: { type: 'boolean' },
          evidenceDiversity: { type: 'number', minimum: 0, maximum: 1 }, historicalCalibration: { type: 'number', minimum: 0, maximum: 1 },
          realityDependent: { type: 'boolean' }, evidenceAvailable: { type: 'boolean' }
        } },
        domainSignals: { type: 'object', additionalProperties: false, properties: {
          workClass: { type: 'string', maxLength: 96 }, objectType: { type: 'string', maxLength: 96 }, outcomeType: { type: 'string', maxLength: 96 },
          effectiveCommercialLanes: { type: 'integer', minimum: 0, maximum: 256 }, reliabilityCritical: { type: 'boolean' }
        } },
        behavioralOutcomeEvidence: { type: 'string', minLength: 1, maxLength: 256 }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true }
  },
  {
    name: 'pai_record_user_prompt',
    description: 'Use this when a visible user message must be appended to private PAI continuity evidence before any PAI action. Store only the exact user message, never assistant text or hidden reasoning.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'threadRef', 'sourceMessageId', 'prompt'], properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, threadRef: { type: 'string', minLength: 1, maxLength: 256 },
      sourceMessageId: { type: 'string', minLength: 1, maxLength: 256 }, prompt: { type: 'string', minLength: 1, maxLength: 2000 },
      observedAt: { type: 'string', minLength: 20, maxLength: 40 }
    } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true }
  },
  {
    name: 'pai_commit_prompt_bundle',
    description: 'Use this before a PAI handoff, Drive summary, MCP action, thread close, or backfill to commit the visible user-role messages not yet checkpointed. Set complete=false whenever conversation coverage is uncertain.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'bundleRef', 'threadRef', 'purpose', 'complete', 'prompts'], properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, bundleRef: { type: 'string', minLength: 1, maxLength: 128 },
      threadRef: { type: 'string', minLength: 1, maxLength: 256 }, purpose: { type: 'string', enum: ['MCP_ACTION', 'HANDOFF', 'DRIVE_SUMMARY', 'THREAD_CLOSE', 'BACKFILL'] },
      complete: { type: 'boolean' }, previousBundleHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      fromCursor: { type: 'string', minLength: 1, maxLength: 256 }, toCursor: { type: 'string', minLength: 1, maxLength: 256 },
      summary: { type: 'string', minLength: 1, maxLength: 2000 },
      resultRefs: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 512 } },
      prompts: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false,
        required: ['sourceMessageId', 'text'], properties: { sourceMessageId: { type: 'string', minLength: 1, maxLength: 256 },
          text: { type: 'string', minLength: 1, maxLength: 2000 }, observedAt: { type: 'string', minLength: 20, maxLength: 40 } } } }
    } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true }
  },
  { name: 'pai_get_prompt_bundle', description: 'Use this to verify one exact-thread prompt bundle receipt without returning raw prompt text.', inputSchema: { type: 'object', additionalProperties: false, required: ['bundleId', 'threadRef'], properties: { bundleId: { type: 'string', minLength: 1, maxLength: 128 }, threadRef: { type: 'string', minLength: 1, maxLength: 256 } } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
  { name: 'pai_get_user_profile', description: 'Use this to retrieve evidence-weighted behavioral candidates derived from user prompts. Results are candidates, never canonical user truth.', inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
  { name: 'pai_flush_prompt_bundle_archive', description: 'Use this after a prompt bundle commit to project it to the configured Drive-synced cold archive. Restricted prompt text is always redacted.', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'bundleId', 'threadRef'], properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 }, bundleId: { type: 'string', minLength: 1, maxLength: 128 }, threadRef: { type: 'string', minLength: 1, maxLength: 256 } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
  { name: 'chief_prepare_handoff', description: 'Use this when the bound user wants a bounded, candidate-only handoff checkpoint; attach an exact-thread prompt bundle pointer when available. No canonical memory is written.', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'expectedRevision', 'summary'], properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedRevision: { type: 'integer', minimum: 1 }, summary: { type: 'string', minLength: 1, maxLength: 2000 }, promptBundleId: { type: 'string', minLength: 1, maxLength: 128 }, threadRef: { type: 'string', minLength: 1, maxLength: 256 } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
  { name: 'chief_correct_memory', description: 'Use this when the bound user needs to correct an operational-session candidate and its current room fragment; it does not admit canonical or user-truth memory.', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'expectedRevision', 'correction'], properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedRevision: { type: 'integer', minimum: 1 }, correction: { type: 'string', minLength: 1, maxLength: 2000 }, roomId: { type: 'string', minLength: 1, maxLength: 160 }, targetFragmentId: { type: 'string', minLength: 1, maxLength: 160 }, expectedRoomRevision: { type: 'integer', minimum: 1 } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
  { name: 'chief_admit_committed_work', description: 'Materialize only an immutable DISPATCH from a matching committed Chief delegation. It never claims, executes, selects a host, or creates authority.', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'expectedRevision'], properties: { requestId: { type: 'string', minLength: 1, maxLength: 160 }, expectedRevision: { type: 'integer', minimum: 1 } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true } }
]);
const PUBLIC_READ_ONLY_TOOL_NAMES = Object.freeze(['chief_resume', 'chief_status']);
const PROMPT_TOOL_NAMES = new Set(['pai_record_user_prompt', 'pai_commit_prompt_bundle', 'pai_get_prompt_bundle', 'pai_get_user_profile', 'pai_flush_prompt_bundle_archive']);

// The bridge owns orchestration only. The injected classifier owns W1's
// deterministic semantics; the injected rooms owner remains the only card writer.
function createBehavioralMemoryAdapter({ classifier, rooms, db, identity, now = () => new Date().toISOString() } = {}) {
  if (!classifier || typeof classifier.projectTurn !== 'function' || !rooms
    || typeof rooms.captureMemoryCard !== 'function' || typeof rooms.recallMemoryCards !== 'function'
    || !db || !identity?.userId || !identity?.projectId) return null;
  const roomIdentity = { userId: String(identity.userId), projectId: String(identity.projectId) };
  const projection = value => ({ cardId: value.cardId, scope: value.scope, scopeKey: value.scopeKey, state: value.state, globalAlways: value.globalAlways, projectionHash: digest({ cardId: value.cardId, semanticKey: value.semanticKey, text: value.text, state: value.state }) });
  function recallGlobal() {
    const cards = rooms.recallMemoryCards(db, { identity: roomIdentity, query: '', scopes: ['GLOBAL'], scopeKeys: ['GLOBAL'], limit: rooms.GLOBAL_ALWAYS_LIMIT, now: now() });
    const projected = cards.map(projection);
    return { cards: projected, ids: cards.map(card => card.cardId), projectionHash: digest(projected), limit: rooms.GLOBAL_ALWAYS_LIMIT };
  }
  function recall({ message, room }) {
    const global = rooms.recallMemoryCards(db, { identity: roomIdentity, query: '', scopes: ['GLOBAL'], scopeKeys: ['GLOBAL'], limit: rooms.GLOBAL_ALWAYS_LIMIT, now: now() });
    const project = rooms.recallMemoryCards(db, { identity: roomIdentity, query: message, scopes: ['PROJECT'], scopeKeys: [roomIdentity.projectId], limit: 12, now: now() });
    const keys = [room?.primaryTopicId, room?.roomId].filter(Boolean);
    const local = keys.length ? rooms.recallMemoryCards(db, { identity: roomIdentity, query: message, scopes: ['TOPIC','SESSION'], scopeKeys: keys, limit: 12, now: now() }) : [];
    const cards = [...new Map([...global, ...project, ...local].map(card => [card.cardId, card])).values()];
    return { cards: cards.map(projection), ids: cards.map(card => card.cardId), projectionHash: digest(cards.map(projection)) };
  }
  function capture({ message, requestId, room, turnReceipt }) {
    const classified = classifier.projectTurn({ message, requestId, roomId: room?.roomId || null, topicId: room?.primaryTopicId || null, projectId: roomIdentity.projectId, now: now() });
    const candidates = Array.isArray(classified?.cards) ? classified.cards : [];
    const captured = [];
    for (const card of candidates) {
      // W1 cards expose retention state canonically at retention.state. The flat
      // field is accepted only for legacy injected/test classifiers.
      const sourceState = typeof card?.retention?.state === 'string' ? card.retention.state : card?.state;
      const normalizedState = typeof sourceState === 'string' ? sourceState.toUpperCase() : null;
      if (!card || !['CANDIDATE','ACTIVE','CORE'].includes(normalizedState) || typeof card.pattern !== 'string') continue;
      const global = card.scope?.kind === 'GLOBAL_ALWAYS', scope = global ? 'GLOBAL' : 'PROJECT', scopeKey = global ? 'GLOBAL' : roomIdentity.projectId, state = global ? 'CORE' : normalizedState;
      const receipt = rooms.captureMemoryCard(db, { identity: roomIdentity, text: `Behavioral preference: ${card.pattern}`, semanticKey: `behavioral:${card.pattern}:${scope}:${scopeKey}`, scope, scopeKey, state, strength: Math.min(1, Number(card.strength || 1) / 3), retentionScore: state === 'CORE' ? 0.9 : 0.75, roomId: room?.roomId || null, sourceFragmentId: turnReceipt?.payload?.fragmentIds?.[0] || null, globalAlways: global, idempotencyKey: `bridge:behavioral-card:${requestId}:${card.card_id}`, now: now() });
      captured.push({ cardId: receipt.payload.cardId, pattern: card.pattern, state, scope, scopeKey, projectionHash: digest(card), receiptId: receipt.receiptId });
    }
    return { status: 'CAPTURED_CARDS_ONLY', cards: captured, projectionHash: digest({ cards: candidates, model: classified?.model || null }), correctionObserved: Boolean(classified?.correctionObserved || classified?.dislikeObserved) };
  }
  return { recall, recallGlobal, capture };
}

function createBridge({
  identity,
  sessionId = SESSION_ID,
  now = () => new Date().toISOString(),
  continuity = () => ({ scope: 'PROJECT_NOT_REGISTERED' }),
  continuityRuntime = null,
  contextGateway = null,
  cognitiveLifecycle = null,
  learningGate = null,
  domainIntelligence = null,
  knowledgeRoom = null,
  behavioralMemory = null,
  promptEvidence = null,
  mindGate = null,
  readGateway = null,
  admission = null,
  db = live.open(),
  storage = { mode: 'MEMORY_TEST', durable: false },
  publicToolNames = null
}) {
  if (!identity || identity.role !== 'PAI_CHIEF' || !identity.userId || !identity.paiIdentityId || !identity.projectId) fail('BRIDGE_IDENTITY_CONFIG_INVALID');
  const boundSessionId = cleanText(String(sessionId), 'BRIDGE_SESSION_ID_INVALID', 160);
  if (readGateway && (typeof readGateway.call !== 'function' || !Array.isArray(readGateway.tools))) fail('BRIDGE_READ_GATEWAY_INVALID');
  if (behavioralMemory && (typeof behavioralMemory.recall !== 'function' || typeof behavioralMemory.capture !== 'function')) fail('BRIDGE_BEHAVIORAL_MEMORY_INVALID');
  if (promptEvidence && (typeof promptEvidence.capture !== 'function' || typeof promptEvidence.status !== 'function'
    || typeof promptEvidence.commitBundle !== 'function' || typeof promptEvidence.bundleReceipt !== 'function'
    || typeof promptEvidence.profile !== 'function' || typeof promptEvidence.flushBundleArchive !== 'function')) fail('BRIDGE_PROMPT_EVIDENCE_INVALID');
  if (admission && typeof admission.admitCommitted !== 'function') fail('BRIDGE_ADMISSION_INVALID');
  const allToolDefinitions = readGateway ? [...TOOL_DEFINITIONS, ...readGateway.tools] : TOOL_DEFINITIONS;
  publicToolNames = publicToolNames || TOOL_DEFINITIONS
    .filter(tool => tool.name !== 'chief_admit_committed_work' && (promptEvidence || !PROMPT_TOOL_NAMES.has(tool.name)))
    .map(tool => tool.name);
  const publicNames = new Set(publicToolNames);
  if (publicNames.size !== publicToolNames.length || [...publicNames].some(name => !allToolDefinitions.some(tool => tool.name === name))) fail('BRIDGE_PUBLIC_TOOLS_INVALID');
  if (!promptEvidence && [...publicNames].some(name => PROMPT_TOOL_NAMES.has(name))) fail('BRIDGE_PROMPT_EVIDENCE_UNAVAILABLE');
  const publicToolDefinitions = allToolDefinitions.filter(tool => publicNames.has(tool.name));
  db.exec(`CREATE TABLE IF NOT EXISTS chief_bridge_receipts (
      receipt_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chief_bridge_audit (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, tool TEXT NOT NULL,
      request_id TEXT, detail_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chief_action_previews (
      preview_id TEXT PRIMARY KEY, preview_hash TEXT NOT NULL, expected_revision INTEGER NOT NULL,
      intent_class TEXT NOT NULL, message_hash TEXT NOT NULL, status TEXT NOT NULL,
      body_json TEXT NOT NULL, created_at TEXT NOT NULL, committed_at TEXT);`);
  const rate = [];
  const mind = mindGate || paiMind().createGate();
  const mindPointer = () => typeof mind.pointerStatus === 'function' ? mind.pointerStatus() : { status: 'JIT_NOT_READ', version: null, driveFileId: null, sha256: null, authority: 'POINTER_ONLY_NO_DOCTRINE_CONTENT_LOADED' };
  const bound = { userId: String(identity.userId), paiIdentityId: String(identity.paiIdentityId), projectId: String(identity.projectId), role: 'PAI_CHIEF', externalChatId: null, externalThreadId: null };
  function cognitivePolicyFor(input, intentClass, roomContext) {
    if (!cognitiveLifecycle || typeof cognitiveLifecycle.metacognitiveRoute !== 'function') return null;
    const s = input.cognitiveSignals || {}; const delegated = DELEGATED_INTENTS.has(intentClass);
    const riskByIntent = { BUILD: 0.55, QA: 0.6, REPAIR: 0.72, CHANGE: 0.76, RELEASE: 0.9, RUNTIME_ACTION: 0.92 };
    const risk = riskByIntent[intentClass] || 0.28;
    const importance = Number.isFinite(s.importance) ? s.importance : (delegated ? 0.82 : 0.52);
    const uncertainty = Number.isFinite(s.uncertainty) ? s.uncertainty : (String(input.mode || '').toUpperCase() === 'EXPLORE' ? 0.72 : delegated ? 0.58 : 0.36);
    const evidenceDiversity = Number.isFinite(s.evidenceDiversity) ? s.evidenceDiversity : (roomContext?.contextPackage ? 0.72 : 0.46);
    const historicalCalibration = Number.isFinite(s.historicalCalibration) ? s.historicalCalibration : 0.62;
    const realityDependent = typeof s.realityDependent === 'boolean' ? s.realityDependent : ['RELEASE','RUNTIME_ACTION','CHANGE'].includes(intentClass);
    const evidenceAvailable = typeof s.evidenceAvailable === 'boolean' ? s.evidenceAvailable : true;
    const attention = cognitiveLifecycle.scoreAttention({ importance, uncertainty, recurrence: s.recurrence || 0, urgency: s.urgency || (delegated ? 0.6 : 0.2), informationGain: s.informationGain || 0.45, surprise: s.surprise === true, commitment: delegated });
    const route = cognitiveLifecycle.metacognitiveRoute({ risk, uncertainty, importance, evidenceDiversity, historicalCalibration, realityDependent, evidenceAvailable, surprise: s.surprise === true, domain: 'operational', proposedSelfUpdate: false });
    return Object.freeze({ attention, route, risk, uncertainty, evidenceDiversity, historicalCalibration, realityDependent, source: input.cognitiveSignals ? 'CALLER_SIGNALS_PLUS_DEFAULTS' : 'INTENT_CLASS_DEFAULTS', authority: 'ADVISORY_ONLY_NO_BLOCK_NO_EFFECT' });
  }


  function domainPolicyFor(input, intentClass) {
    if (!domainIntelligence || typeof domainIntelligence.economicPolicy !== 'function') return null;
    const d = input.domainSignals || {};
    const message = String(input.message || '');
    let workClass = d.workClass || null;
    if (!workClass && /revenue|margin|runway|capital|pricing|investment|market|customer|buyer|sales|commercial/i.test(message)) workClass = 'RESOURCE_ECONOMICS';
    const policy = domainIntelligence.economicPolicy({ message, workClass, objectType: d.objectType || null, outcomeType: d.outcomeType || null, effectiveCommercialLanes: d.effectiveCommercialLanes || 0, reliabilityCritical: d.reliabilityCritical === true });
    return Object.freeze({ ...policy, source: input.domainSignals ? 'CALLER_SIGNALS_PLUS_MESSAGE' : 'MESSAGE_AND_CONTRACT_ROUTING', authority: 'ADVISORY_ONLY_NO_BLOCK_NO_EFFECT' });
  }

  function truthSnapshot() {
    let canonical;
    try { canonical = continuity() || {}; }
    catch (error) { canonical = { status: 'DEGRADED', available: false, degradedReason: `CONTINUITY_ADAPTER_ERROR:${String(error.message || error)}` }; }
    let runtime = null;
    if (continuityRuntime) {
      try { runtime = continuityRuntime.resolve({}); }
      catch (error) {
        const contextDegradedReason = `CONTINUITY_RUNTIME_ERROR:${String(error.message || error)}`;
        return { ...canonical, runtime: null, contextDegraded: true, contextDegradedReason };
      }
    }
    return { ...canonical, runtime, contextDegraded: false };
  }

  function session() {
    try { return live.resume(db, { sessionId: boundSessionId, identity: bound }); }
    catch (e) {
      if (!String(e.message).includes('NOT_FOUND')) throw e;
      return live.beginTurn(db, { sessionId: boundSessionId, identity: bound, eventId: 'bridge-session-begin', checkpoint: { activeTopic: 'Chief live continuity', workStatus: { direct: false, delegated: false } }, now: now() });
    }
  }
  function guard(input) {
    if (!input || input.userId !== bound.userId) fail('BRIDGE_IDENTITY_MISMATCH');
    const at = Date.now();
    while (rate.length && rate[0] <= at - 60000) rate.shift();
    if (rate.length >= MAX_CALLS_PER_MINUTE) fail('BRIDGE_RATE_LIMITED');
    rate.push(at);
  }
  function receiptKey(tool, input) { const phase = tool === 'chief_turn' && input.effectMode ? `:${input.effectMode}` : ''; return `${tool}:${input.requestId || 'read'}${phase}`; }
  function storedReceipt(tool, input) {
    const key = receiptKey(tool, input);
    const prior = db.prepare('SELECT input_hash, body_json FROM chief_bridge_receipts WHERE receipt_key=?').get(key);
    if (!prior) return null;
    if (prior.input_hash !== digest(input)) fail('BRIDGE_IDEMPOTENCY_CONFLICT');
    return JSON.parse(prior.body_json);
  }
  function contextPackagePointer(value) {
    if (!value) return null;
    const sourceCount = Array.isArray(value.sourceIds) ? value.sourceIds.length : (Array.isArray(value.sources) ? value.sources.length : (value.sourceCount || 0));
    return {
      packageId: value.packageId || null,
      roomId: value.roomId || null,
      purpose: value.purpose || null,
      sourceCount,
      budget: value.budget || null,
      compiler: value.compiler || null,
      authorityEnvelope: value.authorityEnvelope || null,
      sourcePrecedenceContract: value.sourcePrecedenceContract || null,
      contentDigest: value.contentDigest || (value.packageId ? digest(value.packageId) : null),
      fullRef: value.packageId ? `context-package:${value.packageId}` : null,
      is_pointer_only: true,
      records: []
    };
  }
  function sanitizeRoomContext(rc) {
    if (!rc || typeof rc !== 'object') return null;
    const room = rc.room ? {
      roomId: rc.room.roomId || null,
      roomName: rc.room.roomName || null,
      primaryTopicId: rc.room.primaryTopicId || null,
      status: rc.room.status || null,
      revision: rc.room.revision ?? null,
      privacyClass: rc.room.privacyClass || null,
      projectId: rc.room.projectId || null
    } : null;
    const pkg = contextPackagePointer(rc.contextPackage);
    const turnReceipt = rc.turnReceipt ? {
      receiptId: rc.turnReceipt.receiptId || null,
      turnId: rc.turnReceipt.turnId || null,
      roomId: rc.turnReceipt.roomId || null
    } : null;
    return {
      room,
      contextPackage: pkg,
      turnReceipt,
      authority: rc.authority || 'POINTER_ONLY_NO_RAW_BODIES'
    };
  }
  function projectOutwardResult(tool, result, projectionProfile = {}) {
    if (!result || typeof result !== 'object') return result;
    const rawPkg = result.contextPackage || result.roomContext?.contextPackage;
    const pointer = rawPkg ? contextPackagePointer(rawPkg) : {
      packageId: null,
      roomId: result.roomContext?.room?.roomId || null,
      is_pointer_only: true,
      records: []
    };
    const roomContext = result.roomContext ? sanitizeRoomContext(result.roomContext) : null;
    let outward = {
      ...result,
      roomContext: roomContext ? { ...roomContext, contextPackage: pointer } : null,
      contextPackage: pointer
    };

    if (tool === 'chief_resume') {
      const rawPkg = result.contextPackage || result.roomContext?.contextPackage;
      const cpPointer = contextPackagePointer(rawPkg);
      const roomPtr = result.roomContext?.room ? {
        roomId: result.roomContext.room.roomId || null,
        roomName: result.roomContext.room.roomName || null,
        primaryTopicId: result.roomContext.room.primaryTopicId || null,
        status: result.roomContext.room.status || null,
        revision: result.roomContext.room.revision ?? null,
        privacyClass: result.roomContext.room.privacyClass || null,
        projectId: result.roomContext.room.projectId || null
      } : null;
      const ckPointer = result.checkpoint ? {
        activeTopic: result.checkpoint.activeTopic || 'Chief live continuity',
        workStatus: result.checkpoint.workStatus || { direct: false, delegated: false }
      } : {
        activeTopic: 'Chief live continuity',
        workStatus: { direct: false, delegated: false }
      };
      const contPointer = result.continuity ? {
        status: result.continuity.status || null,
        scope: result.continuity.scope || null,
        lastVerifiedAt: result.continuity.lastVerifiedAt || null
      } : null;
      const mindPointerObj = result.paiMind || mindPointer();

      let compactBehavioral = { status: 'DEGRADED_UNAVAILABLE', cards: [], authority: 'CARDS_ONLY_NO_RAW_TRANSCRIPT_OR_EFFECT' };
      if (outward.behavioralMemory && Array.isArray(outward.behavioralMemory.cards)) {
        compactBehavioral = {
          status: outward.behavioralMemory.status || 'RECALLED_REDACTED',
          cards: outward.behavioralMemory.cards.slice(0, 4).map(c => ({
            cardId: c.cardId || null,
            scope: c.scope || null,
            scopeKey: c.scopeKey || null,
            state: c.state || null,
            globalAlways: c.globalAlways === true,
            projectionHash: c.projectionHash || null
          })),
          authority: 'CARDS_ONLY_NO_RAW_TRANSCRIPT_OR_EFFECT'
        };
      }

      const projectionDigest = digest({
        sessionId: outward.sessionId,
        revision: outward.revision,
        cpPointer,
        roomPtr,
        ckPointer
      });

      outward = {
        sessionId: outward.sessionId,
        revision: outward.revision,
        status: outward.status,
        identity: outward.identity ? {
          userId: outward.identity.userId || null,
          role: outward.identity.role || null,
          projectId: outward.identity.projectId || null
        } : null,
        checkpointPointer: ckPointer,
        roomPointer: roomPtr,
        contextPackagePointer: cpPointer,
        continuityPointer: contPointer,
        paiMindPointer: mindPointerObj,
        paiMind: mindPointerObj,
        currentWorkPointer: result.currentWork || null,
        behavioralMemory: compactBehavioral,
        misses: [],
        fullRefs: ['chief_resume:FULL'],
        projectionDigest,
        experience: { status: 'COMPACT', summary: 'Resumed Chief checkpoint.' },
        authority: 'COMPACT_ROUTINE_RESUME_POINTER_ONLY',
        roomContext: {
          room: roomPtr,
          contextPackage: cpPointer,
          authority: 'POINTER_ONLY_NO_RAW_BODIES'
        }
      };
    }

    if (tool === 'chief_status') {
      if (outward.contextRooms && typeof outward.contextRooms === 'object') {
        outward.contextRooms = {
          enabled: outward.contextRooms.enabled !== false,
          activeRoomId: outward.contextRooms.activeRoomId || null,
          authority: 'ROOM_STATUS_ONLY'
        };
      }
    }

    return outward;
  }
  function publicResult(tool, result) {
    return projectOutwardResult(tool, result);
  }
  function resolveJitTools(params = {}, publicDefs = publicToolDefinitions) {
    if (publicDefs.length <= 7) return publicDefs;
    const rawIntent = params?.intentClass || params?.intent || params?.taskClass || params?.task;
    const intentClass = rawIntent ? String(rawIntent).toUpperCase() : null;
    const mode = params?.mode ? String(params.mode).toUpperCase() : null;
    const profile = params?.profile ? String(params.profile).toUpperCase() : null;

    if (mode === 'ALL' || (!intentClass && profile === 'STATIC_ALL') || params?.fullCatalogOverride === true) {
      return publicDefs;
    }

    let targetNames = null;
    if (intentClass && JIT_INTENT_TOOL_MAP[intentClass]) {
      targetNames = JIT_INTENT_TOOL_MAP[intentClass];
    } else if (profile && MINIMAL_TOOL_PROFILES && MINIMAL_TOOL_PROFILES[profile]) {
      targetNames = MINIMAL_TOOL_PROFILES[profile].tools;
    } else if (params?.jit === true || profile === 'JIT' || profile === 'ROUTINE' || profile === 'BOOTSTRAP' || mode === 'BOOTSTRAP' || intentClass === 'BOOTSTRAP') {
      targetNames = JIT_BOOTSTRAP_TOOLS;
    }

    // Default invariant: UNKNOWN => MINIMAL_SAFE_PROFILE (bounded 3-8 bootstrap tools)
    if (!targetNames) {
      targetNames = JIT_BOOTSTRAP_TOOLS;
    }

    const available = new Set(publicDefs.map(t => t.name));
    const filtered = [];
    for (const name of targetNames) {
      if (available.has(name)) {
        const def = publicDefs.find(t => t.name === name);
        if (def) filtered.push(def);
      }
    }
    return filtered.length > 0 ? filtered : publicDefs.slice(0, 7);
  }
  function receiptPointer(receipt) {
    return { tool: receipt.tool, key: receipt.key, sessionId: receipt.sessionId,
      revision: receipt.revision, receiptId: receipt.receiptId,
      persistedBytes: Buffer.byteLength(JSON.stringify(receipt), 'utf8') };
  }
  function storeReceipt(tool, input, result) {
    const key = receiptKey(tool, input);
    const durableResult = publicResult(tool, result);
    const body = { tool, key, sessionId: boundSessionId, revision: result.revision ?? session().revision, result: durableResult };
    const existing = storedReceipt(tool, input);
    if (existing) return existing;
    const withId = { ...body, receiptId: `CHREF_MCP:${digest(body).slice(0, 24)}` };
    db.prepare('INSERT INTO chief_bridge_receipts VALUES (?,?,?,?)').run(key, digest(input), JSON.stringify(withId), now());
    return withId;
  }
  function audit(eventType, tool, input, detail) {
    const safe = {
      requestId: input.requestId || null,
      intentClass: input.intentClass || null,
      branchId: input.branchId || null,
      externalChatHash: input.externalChatId ? digest(input.externalChatId).slice(0, 16): null,
      externalThreadHash: input.externalThreadId ? digest(input.externalThreadId).slice(0, 16) : null,
      ...detail
    };
    db.prepare('INSERT INTO chief_bridge_audit(event_type,tool,request_id,detail_json,created_at) VALUES (?,?,?,?,?)')
      .run(eventType, tool, input.requestId || null, JSON.stringify(safe), now());
  }
  function directResponse(name, input, result, eventType) {
    audit(eventType, name, input, {
      bundleId: result.bundleId || null,
      bundleSha256: result.bundleSha256 || null,
      status: result.status || null,
      itemCount: result.itemCount ?? null,
      eventId: result.eventId || null
    });
    const receipt = { tool: name, key: `${name}:${input.requestId || digest(input).slice(0, 16)}`,
      sessionId: boundSessionId, revision: null,
      receiptId: `CHREF_MCP:${digest({ name, inputHash: digest(input), result }).slice(0, 24)}` };
    return { content: [{ type: 'text', text: JSON.stringify({ receipt, result }) }], structuredContent: { receipt, result } };
  }
  function branchConsultation(chiefSession, branchId, summary, evidence) {
    let runtime = paiChief().branches.createRuntime({ contextReceipt: chiefSession.contextReceipt, now: now() });
    runtime = paiChief().branches.openBranch(runtime, { branchId, contextReceiptId: chiefSession.contextReceipt.receiptId, now: now() });
    runtime = paiChief().branches.closeAndDistillBranch(runtime, {
      branchId,
      distillation: { summary, evidence, unresolvedQuestions: [] },
      now: now()
    });
    const checkpoint = paiChief().branches.exportCheckpoint(runtime);
    return { branchId, status: 'COMPLETED', checkpointHash: checkpoint.sha256, permanent: false };
  }
  function governorDelegation(chiefSession, input, intentClass, roomContext = null) {
    let runtime = paiChief().branches.createRuntime({ contextReceipt: chiefSession.contextReceipt, now: now() });
    runtime = paiChief().branches.openBranch(runtime, { branchId: 'PAI_PROGRAM', contextReceiptId: chiefSession.contextReceipt.receiptId, now: now() });
    const request = {
      requestId: input.requestId,
      workUnitId: `CHIEF-REQUEST-${digest({ requestId: input.requestId, message: input.message }).slice(0, 16)}`,
      graphId: 'pai-chief-request-only',
      mutableScope: input.workSpec ? experience.normalizeWorkSpec(input.workSpec).mutableScope : 'UNRESOLVED_BY_CHIEF_GOVERNOR_MUST_RESOLVE',
      workSpec: input.workSpec ? experience.normalizeWorkSpec(input.workSpec) : null,
      authorityProvenance: 'BOUND_USER_REQUEST_VIA_CHIEF',
      sourceReferences: ['PAI_CHIEF_LIVE_SESSION', chiefSession.contextReceipt.receiptId,
        ...(roomContext?.contextPackage ? [roomContext.contextPackage.packageId] : [])],
      contextPackageId: roomContext?.contextPackage?.packageId || null,
      roomId: roomContext?.room?.roomId || null,
      rollback: 'NO_EFFECT_REQUEST_ONLY',
      acceptance: ['GOVERNOR_ADMISSION_OR_REJECTION_RECEIPT'],
      intentClass
    };
    const submitted = paiChief().branches.submitDelegatedWork(runtime, { branchId: 'PAI_PROGRAM', request, contextReceipt: chiefSession.contextReceipt });
    const completed = paiChief().branches.closeAndDistillBranch(submitted.runtime, {
      branchId: 'PAI_PROGRAM',
      distillation: { summary: 'Request-only Governor delegation emitted; Chief executed no work.', evidence: [submitted.delegation.delegationId], unresolvedQuestions: [] },
      now: now()
    });
    const checkpoint = paiChief().branches.exportCheckpoint(completed);
    return { delegation: submitted.delegation, branch: { branchId: 'PAI_PROGRAM', status: 'COMPLETED', checkpointHash: checkpoint.sha256, permanent: false } };
  }

  function call(name, input = {}) {
    if (readGateway && READ_TOOLS.some(tool => tool.name === name)) return readGateway.call(name, input);
    guard(input);
    const tool = TOOL_DEFINITIONS.find(x => x.name === name);
    if (!tool) fail('BRIDGE_TOOL_DENIED');
    if (name === 'pai_record_user_prompt') {
      exactRef(input.requestId, 'BRIDGE_REQUEST_ID_INVALID', 128);
      const threadRef = exactRef(input.threadRef, 'PROMPT_CONVERSATION_INVALID', 256);
      const sourceMessageId = exactRef(input.sourceMessageId, 'PROMPT_SOURCE_MESSAGE_INVALID', 256);
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT_TEXT) fail('PROMPT_TEXT_INVALID');
      const result = promptEvidence.capture({ rawUserPrompt: input.prompt, sourceMessageId,
        conversationRef: threadRef, provenanceRef: `mcp-prompt:${threadRef}:${sourceMessageId}`,
        observedAt: input.observedAt || null, failOpen: false });
      return directResponse(name, input, result, 'USER_PROMPT_EVIDENCE_RECORDED');
    }
    if (name === 'pai_commit_prompt_bundle') {
      exactRef(input.requestId, 'BRIDGE_REQUEST_ID_INVALID', 128);
      const result = promptEvidence.commitBundle({ bundleRef: input.bundleRef,
        conversationRef: input.threadRef, purpose: input.purpose, complete: input.complete,
        prompts: input.prompts, previousBundleHash: input.previousBundleHash || null,
        fromCursor: input.fromCursor || null, toCursor: input.toCursor || null,
        summary: input.summary || null, resultRefs: input.resultRefs || [] });
      return directResponse(name, input, result, 'USER_PROMPT_BUNDLE_COMMITTED');
    }
    if (name === 'pai_get_prompt_bundle') {
      const result = promptEvidence.bundleReceipt({ bundleId: input.bundleId, conversationRef: input.threadRef });
      return directResponse(name, input, result, 'USER_PROMPT_BUNDLE_READ');
    }
    if (name === 'pai_get_user_profile') {
      const result = promptEvidence.profile({ limit: input.limit });
      return directResponse(name, input, result, 'USER_PROMPT_PROFILE_READ');
    }
    if (name === 'pai_flush_prompt_bundle_archive') {
      exactRef(input.requestId, 'BRIDGE_REQUEST_ID_INVALID', 128);
      const result = promptEvidence.flushBundleArchive({ bundleId: input.bundleId, conversationRef: input.threadRef });
      return directResponse(name, input, result, 'USER_PROMPT_BUNDLE_ARCHIVED');
    }
    let promptEvidenceCapture = null;
    if (name === 'chief_turn') {
      const workSpec = experience.normalizeWorkSpec(input.workSpec);
      if (workSpec && (!new Set(['BUILD', 'REPAIR', 'QA', 'CHANGE']).has(String(input.intentClass || '').toUpperCase()) || !['PREVIEW', 'COMMIT'].includes(String(input.effectMode || 'LEGACY').toUpperCase()))) fail('CHIEF_WORK_SPEC_MODE_DENIED');
      input = { ...input, workSpec };
      cleanText(input.message);
      const persistPromptEvidence = input.persistPromptEvidence === true;
      const hasThreadRef = typeof input.threadRef === 'string' && Boolean(input.threadRef.trim());
      const hasSourceMessageId = typeof input.sourceMessageId === 'string' && Boolean(input.sourceMessageId.trim());
      if (persistPromptEvidence && hasThreadRef !== hasSourceMessageId) fail('PROMPT_IDENTITY_PAIR_REQUIRED');
      if (!persistPromptEvidence) {
        promptEvidenceCapture = { status: 'SKIPPED_EXPLICIT_OPT_IN_REQUIRED', captured: false,
          reason: 'USE_persistPromptEvidence_OR_pai_record_user_prompt',
          authority: 'NO_IMPLICIT_PROMPT_PERSISTENCE' };
      } else if (!hasThreadRef) {
        promptEvidenceCapture = { status: 'DEGRADED_IDENTITY_UNAVAILABLE', captured: false,
          reason: 'PROMPT_IDENTITY_REQUIRED:threadRef+sourceMessageId', authority: 'NO_EXACT_PROMPT_CONTINUITY_CLAIM' };
      } else {
        try {
          const threadRef = exactRef(input.threadRef, 'PROMPT_CONVERSATION_INVALID', 256);
          const sourceMessageId = exactRef(input.sourceMessageId, 'PROMPT_SOURCE_MESSAGE_INVALID', 256);
          promptEvidenceCapture = promptEvidence ? promptEvidence.capture({
            rawUserPrompt: input.message,
            sourceMessageId,
            conversationRef: threadRef,
            provenanceRef: `chief-bridge:${boundSessionId}:${threadRef}:${sourceMessageId}`,
            failOpen: false
          }) : { status: 'DEGRADED_UNAVAILABLE', captured: false };
        } catch (e) {
          promptEvidenceCapture = { status: 'DEGRADED_FAIL_OPEN', captured: false, reason: `PROMPT_EVIDENCE_CAPTURE_FAILED:${String(e.message || e)}` };
        }
      }
      if (persistPromptEvidence && !promptEvidenceCapture.captured) audit('USER_PROMPT_EVIDENCE_CAPTURE_FAILED', name, input, { reason: promptEvidenceCapture.reason || promptEvidenceCapture.status });
    }
    if (name === 'chief_admit_committed_work' && Object.keys(input).some(key => !['userId', 'requestId', 'expectedRevision'].includes(key))) fail('BRIDGE_INPUT_INVALID');
    const readOnly = name === 'chief_resume' || name === 'chief_status';
    const prior = readOnly || name === 'chief_admit_committed_work' ? null : storedReceipt(name, input);
    if (prior) {
      const replayResult = publicResult(name, prior.result);
      const replayReceipt = receiptPointer(prior);
      return { content: [{ type: 'text', text: JSON.stringify({ receipt: replayReceipt, result: replayResult }) }], structuredContent: { receipt: replayReceipt, result: replayResult } };
    }

    let result;
    if (name === 'chief_admit_committed_work') {
      if (!admission) fail('CHIEF_ADMISSION_UNAVAILABLE');
      result = admission.admitCommitted({ requestId: input.requestId, expectedRevision: input.expectedRevision });
      audit('CHIEF_COMMITTED_WORK_ADMITTED', name, input, { taskId: result.taskId, status: result.status });
      const receipt = { tool: name, key: `${name}:${input.requestId}`, sessionId: boundSessionId, result, receiptId: `CHREF_MCP:${digest({ name, result }).slice(0, 24)}` };
      return { content: [{ type: 'text', text: JSON.stringify({ receipt, result }) }], structuredContent: { receipt, result } };
    } else {
    const current = session();
    if (name === 'chief_resume') {
      const mindReceipt = mindPointer();
      result = { ...current, roomContext: contextGateway ? (contextGateway.peek ? contextGateway.peek() : contextGateway.current()) : null, provenance: 'CHIEF_BRIDGE_SQLITE_SESSION', storage, paiMind: mindReceipt };
      try {
        const room = result.roomContext?.room || null;
        const recalled = behavioralMemory ? (typeof behavioralMemory.recallGlobal === 'function' ? behavioralMemory.recallGlobal() : behavioralMemory.recall({ message: '', room })) : null;
        result.behavioralMemory = recalled ? { status: 'RECALLED_REDACTED', ...recalled, globalAlwaysLimit: recalled.limit ?? 'W2_GLOBAL_ALWAYS_LIMIT', authority: 'CARDS_ONLY_NO_RAW_TRANSCRIPT_OR_EFFECT' } : { status: 'DEGRADED_UNAVAILABLE', cards: [] };
      } catch (e) { result.behavioralMemory = { status: 'DEGRADED_FAIL_OPEN', cards: [], reason: `BEHAVIORAL_RECALL_FAILED:${String(e.message || e)}` }; }
      result.experience = experience.renderExperience({ session: current, truth: truthSnapshot(), intentClass: 'REPORT', mode: 'REVIEW', resultKind: 'DIRECT', answer: 'Resumed from the durable Chief checkpoint; routine save and sync are not required.' });
    } else if (name === 'chief_status') {
      const counts = db.prepare('SELECT tool, COUNT(*) AS count FROM chief_bridge_audit GROUP BY tool ORDER BY tool').all();
      result = {
        sessionId: boundSessionId, revision: current.revision, status: current.status,
        continuity: truthSnapshot(),
        provenance: { active: 'CHIEF_BRIDGE_SESSION', projectContextOnly: false, storage },
        contextRooms: contextGateway ? contextGateway.status() : null,
        paiMind: mindPointer(),
        cognitiveLifecycle: cognitiveLifecycle ? { enabled: true, authority: cognitiveLifecycle.authority || 'ADVISORY_ONLY' } : { enabled: false },
        chiefLearning: learningGate ? { enabled: true, storage: 'EPHEMERAL_GOVERNANCE_LEDGER', authority: learningGate.authority, durableReuseVerified: false } : { enabled: false },
        domainIntelligence: domainIntelligence ? { enabled: true, authority: 'ADVISORY_ROUTING_AND_ECONOMIC_POLICY_ONLY' } : { enabled: false },
        knowledgeRoom: knowledgeRoom && typeof knowledgeRoom.status === 'function' ? knowledgeRoom.status() : { enabled: false },
        promptEvidence: promptEvidence ? promptEvidence.status() : { status: 'DEGRADED_UNAVAILABLE', eventCount: 0 },
        auditCounts: counts,
        authority: 'READ_ONLY_STATUS; NO_GOVERNOR_OR_CANONICAL_AUTHORITY'
      };
      if (input.program_id || input.task_id) {
        if (!readGateway || typeof readGateway.projectStatus !== 'function') fail('PROJECT_STATUS_READ_OWNER_UNAVAILABLE');
        result.projectStatus = readGateway.projectStatus({ program_id: input.program_id, task_id: input.task_id });
      }
      result.experience = experience.renderExperience({ session: current, truth: result.continuity, intentClass: 'REPORT', mode: 'REVIEW', resultKind: 'DIRECT', answer: 'Current operational picture is surfaced without inventing execution state.' });
      if (String(input.mode || 'FULL').toUpperCase() === 'COMPACT') result = compactHealth({
        status: result.status,
        sampledAt: now(),
        revision: result.revision,
        fenceRef: result.continuity?.fenceRef || result.continuity?.bundleHash || null,
        checks: [
          { name: 'continuity', status: result.continuity?.status || result.continuity?.scope || 'AVAILABLE' },
          { name: 'promptEvidence', status: result.promptEvidence?.status || 'DEGRADED_UNAVAILABLE' },
          { name: 'knowledgeRoom', status: result.knowledgeRoom?.enabled === false ? 'DISABLED' : 'AVAILABLE' }
        ],
        counts: Object.fromEntries((result.auditCounts || []).map(row => [row.tool, Number(row.count)])),
        stalenessMs: 0,
        fullRef: 'chief_status:FULL',
        errorCode: null
      }, { maxChecks: input.maxChecks });
    } else if (name === 'chief_turn') {
      cleanText(input.requestId);
      const message = cleanText(input.message);
      if (!Number.isInteger(input.expectedRevision)) fail('BRIDGE_SCHEMA_INVALID');
      const intentClass = String(input.intentClass || '').toUpperCase();
      if (!DIRECT_INTENTS.has(intentClass) && !DELEGATED_INTENTS.has(intentClass)) fail('CHIEF_INTENT_CLASS_UNKNOWN');
      const effectMode = String(input.effectMode || 'LEGACY').toUpperCase();
      if (!['LEGACY', 'PREVIEW', 'COMMIT'].includes(effectMode)) fail('CHIEF_EFFECT_MODE_INVALID');
      if (DIRECT_INTENTS.has(intentClass) && effectMode !== 'LEGACY') fail('CHIEF_ACTION_PREVIEW_DIRECT_INTENT_DENIED');
      if (input.expectedRevision !== current.revision) fail('LIVE_SESSION_OUT_OF_ORDER');
      // Validate the complete bridge intent before context preparation, which
      // may write bounded room state. A rejected request must be mutation-free.
      if (DIRECT_INTENTS.has(intentClass) && input.branchId && !['NONE', 'BRAINSTORM'].includes(input.branchId)) fail('BRIDGE_BRANCH_INTENT_MISMATCH');
      if (DELEGATED_INTENTS.has(intentClass) && input.branchId && !['NONE', 'PAI_PROGRAM'].includes(input.branchId)) fail('BRIDGE_BRANCH_INTENT_MISMATCH');
      optionalText(input.externalChatId, 'BRIDGE_EXTERNAL_CHAT_INVALID');
      optionalText(input.externalThreadId, 'BRIDGE_EXTERNAL_THREAD_INVALID');
      const learningCandidate = optionalText(input.learningCandidate, 'BRIDGE_LEARNING_CANDIDATE_INVALID', 512);
      const behavioralOutcomeEvidence = optionalText(input.behavioralOutcomeEvidence, 'BRIDGE_BEHAVIORAL_OUTCOME_INVALID', 256);
      const doctrineRead = String(input.doctrineRead || 'NONE').toUpperCase();
      const majorMindWork = DELEGATED_INTENTS.has(intentClass) || ['DECIDE', 'EXECUTE', 'REVIEW'].includes(String(input.mode || '').toUpperCase());
      const mindReceipt = doctrineRead === 'AUTHORITY_AMBIGUITY' || doctrineRead === 'DOCTRINE_AMBIGUITY'
        ? (majorMindWork ? mind.preflightMajorWork({ reason: `CHIEF_TURN:${intentClass}:${doctrineRead}`, workClass: DELEGATED_INTENTS.has(intentClass) ? 'DELEGATED_MAJOR_WORK' : 'STRATEGIC_DIRECT_WORK', requestId: input.requestId }) : mind.ensureDailyRead({ reason: `CHIEF_TURN:${doctrineRead}` }))
        : mindPointer();
      if (DELEGATED_INTENTS.has(intentClass) && effectMode === 'PREVIEW') {
        const actionPreview = experience.createActionPreview({ input: { ...input, message, intentClass }, session: current, now });
        const previewBody = { ...actionPreview, messageHash: experience.digest(message) };
        db.prepare('INSERT OR IGNORE INTO chief_action_previews VALUES (?,?,?,?,?,?,?,?,NULL)')
          .run(actionPreview.actionPreviewId, actionPreview.previewHash, actionPreview.expectedRevision, intentClass, previewBody.messageHash, actionPreview.status, JSON.stringify(previewBody), actionPreview.createdAt);
        result = {
          ...current,
          disposition: 'ACTION_PREVIEW',
          actionPreview,
          paiMind: mindReceipt,
          experience: experience.renderExperience({ session: current, truth: truthSnapshot(), intentClass, mode: input.mode, resultKind: 'ACTION_PREVIEW', actionPreview })
        };
        audit('CHIEF_ACTION_PREVIEWED', name, input, { revision: current.revision, actionPreviewId: actionPreview.actionPreviewId });
        const previewReceipt = storeReceipt(name, input, result);
        const receipt = receiptPointer(previewReceipt);
        const outwardResult = publicResult(name, result);
        return { content: [{ type: 'text', text: JSON.stringify({ receipt, result: outwardResult }) }], structuredContent: { receipt, result: outwardResult } };
      }
      let verifiedPreview = null;
      if (DELEGATED_INTENTS.has(intentClass) && effectMode === 'COMMIT') {
        if (!input.actionPreviewId || !input.actionPreviewHash) fail('CHIEF_ACTION_PREVIEW_REQUIRED');
        const row = db.prepare('SELECT * FROM chief_action_previews WHERE preview_id=?').get(input.actionPreviewId);
        verifiedPreview = row ? { ...JSON.parse(row.body_json), status: row.status, messageHash: row.message_hash, previewHash: row.preview_hash, expectedRevision: row.expected_revision } : null;
        experience.verifyActionPreview({ preview: verifiedPreview, input: { ...input, message, intentClass }, session: current });
      }
      const roomContext = contextGateway ? contextGateway.prepareTurn({
        requestId: input.requestId, expectedRevision: input.expectedRevision, intentClass, message,
        roomAction: input.roomAction || 'AUTO', roomId: input.roomId || null,
        roomName: input.roomName || null, roomAliases: input.roomAliases || [], topicId: input.topicId || null,
        purpose: input.purpose || null, privacyClass: input.privacyClass || null,
        maxPrivacyClass: input.maxPrivacyClass || null, roomTtlMs: input.roomTtlMs || null,
        roomSignals: input.roomSignals || {}, externalChatId: input.externalChatId || null,
        externalThreadId: input.externalThreadId || null
      }) : null;
      let behavioralRecall;
      try { behavioralRecall = behavioralMemory ? behavioralMemory.recall({ message, room: roomContext?.room || null }) : null; }
      catch (e) { behavioralRecall = { status: 'DEGRADED_FAIL_OPEN', cards: [], ids: [], projectionHash: null, reason: `BEHAVIORAL_RECALL_FAILED:${String(e.message || e)}` }; }
      const cognitivePolicy = cognitivePolicyFor(input, intentClass, roomContext);
      const domainPolicy = domainPolicyFor(input, intentClass);
      const knowledgeCapsule = knowledgeRoom && typeof knowledgeRoom.compile === 'function' ? knowledgeRoom.compile({
        query: message, projectId: bound.projectId, purpose: input.purpose || (DELEGATED_INTENTS.has(intentClass) ? 'GOVERNED_DELEGATION' : 'DIRECT_RESPONSE'), budget: 8, now: now()
      }) : null;
      const knowledgeCandidateRoutes = knowledgeRoom && typeof knowledgeRoom.routeSignals === 'function' ? knowledgeRoom.routeSignals(input.roomSignals || {}) : [];
      const semanticSources = [{ sourceId: 'bridge', sourceKind: 'MCP_REQUEST', contentDigest: digest(message) }];
      if (mindReceipt.driveFileId && mindReceipt.sha256) semanticSources.push({ sourceId: mindReceipt.driveFileId, sourceKind: mindReceipt.status === 'JIT_NOT_READ' ? 'APPROVED_PRODUCT_DOCTRINE_POINTER' : 'APPROVED_PRODUCT_DOCTRINE', contentDigest: mindReceipt.sha256 });
      if (roomContext?.contextPackage) semanticSources.push({ sourceId: roomContext.contextPackage.packageId, sourceKind: 'CONTEXT_PACKAGE', contentDigest: digest(roomContext.contextPackage) });
      const runtimeFacts = [{ sourceId: 'session', sourceKind: 'STATUS_OR_LOG', contentDigest: digest(current) }];
      if (roomContext?.room) runtimeFacts.push({ sourceId: roomContext.room.roomId, sourceKind: 'CURRENT_LIFECYCLE_RECORD', contentDigest: digest(roomContext.room) });
      const chiefSession = paiChief().createSession({ semanticSources, runtimeFacts, authorityBoundary: 'CANDIDATES_ONLY_NO_EFFECTS', now: now() });
      const evidenceReceipts = [{ kind: 'BOUND_CHAT_TURN', messageHash: digest(message), externalChatHash: input.externalChatId ? digest(input.externalChatId) : null }];
      evidenceReceipts.push({ kind: mindReceipt.status === 'JIT_NOT_READ' ? 'PAI_MIND_POINTER' : 'PAI_MIND_PREFLIGHT', version: mindReceipt.version, driveFileId: mindReceipt.driveFileId, sha256: mindReceipt.sha256, receiptPath: mindReceipt.receiptPath || null });
      if (roomContext?.turnReceipt) evidenceReceipts.push({ kind: 'ROOM_RECEIPT', receiptId: roomContext.turnReceipt.receiptId, roomId: roomContext.room?.roomId || null });
      if (roomContext?.contextPackage) evidenceReceipts.push({ kind: 'CONTEXT_PACKAGE', packageId: roomContext.contextPackage.packageId, roomId: roomContext.contextPackage.roomId, authority: roomContext.contextPackage.authorityEnvelope });
      if (behavioralRecall) evidenceReceipts.push({ kind: 'BEHAVIORAL_MEMORY_CONSUMED', cardIds: behavioralRecall.ids || [], projectionHash: behavioralRecall.projectionHash || null });
      if (cognitivePolicy) evidenceReceipts.push({ kind: 'COGNITIVE_POLICY', attentionScore: cognitivePolicy.attention.score, salient: cognitivePolicy.attention.salient, verificationAdvice: cognitivePolicy.route.action, reason: cognitivePolicy.route.reason, authority: cognitivePolicy.authority });
      if (domainPolicy) evidenceReceipts.push({ kind: 'DOMAIN_ECONOMIC_POLICY', primaryDomain: domainPolicy.routing.primaryDomain, specialtyLenses: domainPolicy.routing.specialtyLenses, strategyMode: domainPolicy.strategy.mode, commercialAttention: domainPolicy.commercialAttention, authority: domainPolicy.authority });
      if (knowledgeCapsule) evidenceReceipts.push({ kind: 'KNOWLEDGE_CAPSULE', capsuleId: knowledgeCapsule.capsuleId, included: knowledgeCapsule.included.length, excluded: knowledgeCapsule.excludedCount, authority: knowledgeCapsule.authority });
      if (knowledgeCandidateRoutes.length) evidenceReceipts.push({ kind: 'KNOWLEDGE_CANDIDATE_ROUTES', count: knowledgeCandidateRoutes.length, states: [...new Set(knowledgeCandidateRoutes.map(x => x.status))], authority: 'ROUTING_ONLY_NO_ADMISSION' });

      let disposition;
      let candidate = null;
      let delegation = null;
      let branch = null;
      let workStatus;
      if (DIRECT_INTENTS.has(intentClass)) {
        const answer = paiChief().answerDirect({ session: chiefSession, intent: { intentClass }, evidence: [{ kind: 'STATUS_OR_LOG',
          value: message }] });
        disposition = answer.disposition;
        candidate = answer.candidate;
        workStatus = { direct: true, delegated: false };
        evidenceReceipts.push(answer.receipt);
        if (input.branchId === 'BRAINSTORM') branch = branchConsultation(chiefSession, 'BRAINSTORM', 'Bounded brainstorm consultation completed for this turn.', [answer.receipt.receiptId]);
      } else {
        const delegated = governorDelegation(chiefSession, input, intentClass, roomContext);
        disposition = delegated.delegation.status;
        delegation = delegated.delegation;
        branch = delegated.branch;
        workStatus = { direct: false, delegated: true };
        evidenceReceipts.push({ kind: 'GOVERNOR_REQUEST', delegationId: delegation.delegationId, route: delegation.route, status: delegation.status });
      }
      const deltas = learningCandidate ? [{
        deltaId: `learning:${input.requestId}`, statement: learningCandidate, status: 'CANDIDATE_NOT_ADMITTED'
      }] : [];
      const committed = live.commitTurn(db, {
        sessionId: boundSessionId, identity: bound, eventId: `turn:${input.requestId}`, expectedRevision: input.expectedRevision,
        checkpoint: {
          activeTopic: message,
          branchParticipation: branch ? [branch] : [],
          workStatus,
          evidenceReceipts,
          nextFrontier: delegation ? 'GOVERNOR_ADMISSION_OR_REJECTION' : current.checkpoint?.nextFrontier
        },
        candidateDurableDeltas: deltas,
        now: now()
      });
      let behavioralCapture = null;
      try {
        behavioralCapture = behavioralMemory ? behavioralMemory.capture({ message, requestId: input.requestId, room: roomContext?.room || null, turnReceipt: roomContext?.turnReceipt || null }) : null;
      } catch (e) { behavioralCapture = { status: 'DEGRADED_FAIL_OPEN', cards: [], reason: `BEHAVIORAL_CAPTURE_FAILED:${String(e.message || e)}` }; }
      const explicitCorrection = Boolean((input.roomSignals?.corrections || []).length || behavioralCapture?.correctionObserved);
      const violationCandidate = behavioralRecall?.ids?.length && explicitCorrection && behavioralOutcomeEvidence
        ? { status: 'CANDIDATE_ONLY_NO_EFFECT_OR_ADMISSION', consumedCardIds: behavioralRecall.ids, projectionHash: behavioralRecall.projectionHash, observedOutcomeEvidence: digest(behavioralOutcomeEvidence) }
        : null;
      if (verifiedPreview) db.prepare("UPDATE chief_action_previews SET status='COMMITTED_REQUEST_ONLY', committed_at=? WHERE preview_id=?").run(now(), input.actionPreviewId);
      result = { ...committed, disposition, candidate, delegation, branchConsultation: branch, roomContext, contextPackage: roomContext?.contextPackage || null, promptEvidence: promptEvidenceCapture, behavioralMemory: { recalled: behavioralRecall ? { status: 'RECALLED_REDACTED', cards: behavioralRecall.cards || [], projectionHash: behavioralRecall.projectionHash || null } : { status: 'DEGRADED_UNAVAILABLE', cards: [] }, captured: behavioralCapture, violationCandidate }, cognitivePolicy, domainPolicy, knowledgeCapsule, knowledgeCandidateRoutes, paiMind: mindReceipt, learningCandidate: learningCandidate ? { deltaId: `learning:${input.requestId}`, status: 'CANDIDATE_NOT_ADMITTED' } : null };
      if (verifiedPreview) result.actionPreview = { ...verifiedPreview, status: 'COMMITTED_REQUEST_ONLY' };
      result.experience = experience.renderExperience({
        session: committed,
        truth: truthSnapshot(),
        intentClass,
        mode: input.mode,
        resultKind: delegation ? 'ACTION_COMMIT' : 'DIRECT',
        actionPreview: result.actionPreview || null,
        answer: delegation ? 'The existing Governor received the bounded request; Chief claims neither RUNNING nor COMPLETE.' : null
      });
      audit('CHIEF_TURN_COMMITTED', name, input, { disposition, revision: result.revision, delegated: Boolean(delegation), learningCandidateRecorded: Boolean(learningCandidate), cognitiveAdvice: cognitivePolicy?.route?.action || null, primaryDomain: domainPolicy?.routing?.primaryDomain || null, economicStrategy: domainPolicy?.strategy?.mode || null, specialtyLenses: domainPolicy?.routing?.specialtyLenses || [], branchId: branch?.branchId || null, effectMode, paiMindVersion: mindReceipt.version, paiMindSha256: mindReceipt.sha256 });
    } else if (name === 'chief_prepare_handoff') {
      cleanText(input.requestId);
      const summary = cleanText(input.summary);
      if (Boolean(input.promptBundleId) !== Boolean(input.threadRef)) fail('HANDOFF_PROMPT_BUNDLE_POINTER_INCOMPLETE');
      const promptBundle = input.promptBundleId
        ? promptEvidence.bundleReceipt({ bundleId: input.promptBundleId, conversationRef: input.threadRef })
        : null;
      const promptBundlePointer = promptBundle ? { bundleId: promptBundle.bundleId,
        bundleSha256: promptBundle.bundleSha256, threadRef: promptBundle.threadRef,
        itemCount: promptBundle.itemCount, complete: promptBundle.complete,
        authority: 'EXACT_THREAD_PROMPT_BUNDLE_POINTER_NO_RAW_PROMPTS' } : null;
      result = live.commitTurn(db, {
        sessionId: boundSessionId, identity: bound, eventId: `handoff:${input.requestId}`, expectedRevision: input.expectedRevision,
        checkpoint: { nextFrontier: summary, workStatus: { direct: false, delegated: false },
          evidenceReceipts: promptBundlePointer ? [{ kind: 'PROMPT_BUNDLE_POINTER', ...promptBundlePointer }] : [] },
        candidateDurableDeltas: [{ deltaId: `handoff:${input.requestId}`, summary,
          promptBundle: promptBundlePointer, status: 'CANDIDATE_NOT_ADMITTED' }],
        now: now()
      });
      result.handoff = 'CANDIDATE_ONLY_NOT_CANONICAL';
      result.promptBundle = promptBundlePointer;
      result.experience = experience.renderExperience({ session: result, truth: truthSnapshot(), intentClass: 'REPORT', mode: 'REVIEW', resultKind: 'WAIT', waiting: true, answer: 'A bounded candidate handoff is recorded; canonical state was not changed.' });
      audit('HANDOFF_CANDIDATE_RECORDED', name, input, { revision: result.revision,
        promptBundleId: promptBundlePointer?.bundleId || null, promptBundleSha256: promptBundlePointer?.bundleSha256 || null });
    } else {
      cleanText(input.requestId);
      const correction = cleanText(input.correction);
      if (input.expectedRevision !== current.revision) fail('LIVE_SESSION_OUT_OF_ORDER');
      const roomSummary = contextGateway ? (contextGateway.peek ? contextGateway.peek() : contextGateway.current()) : null;
      const roomCorrection = contextGateway && (input.roomId || roomSummary?.room) ? contextGateway.correct({
        correction, roomId: input.roomId || roomSummary.room.roomId,
        targetFragmentId: input.targetFragmentId || null,
        requestId: input.requestId,
        expectedRoomRevision: input.expectedRoomRevision == null ? roomSummary?.room?.revision : input.expectedRoomRevision
      }) : null;
      result = live.correct(db, { sessionId: boundSessionId, identity: bound, eventId: `correct:${input.requestId}`, expectedRevision: input.expectedRevision, correction: { statement: correction, source: 'BOUND_USER' }, now: now() });
      result.memory = 'OPERATIONAL_CANDIDATE_ONLY_NOT_CANONICAL';
      result.roomCorrection = roomCorrection;
      result.experience = experience.renderExperience({ session: result, truth: truthSnapshot(), intentClass: 'REPORT', mode: 'REFLECT', resultKind: 'CORRECTION', correction, answer: 'Correction recorded and applied to subsequent Chief experience projections.' });
    }
    }
    const audited = readOnly
      ? { tool: name, key: `${name}:read:${result.revision ?? 'status'}`, sessionId: boundSessionId, revision: result.revision ?? session().revision, resultHash: digest(result), receiptId: `CHIEF_MCP_READ:${digest({ name, result }).slice(0, 24)}` }
      : storeReceipt(name, input, result);
    const outwardResult = projectOutwardResult(name, result);
    if (readOnly) return { content: [{ type: 'text', text: JSON.stringify(outwardResult) }], structuredContent: { receipt: audited, result: outwardResult } };
    const receipt = receiptPointer(audited);
    return { content: [{ type: 'text', text: JSON.stringify({ receipt, result: outwardResult }) }], structuredContent: { receipt, result: outwardResult } };
  }

  function rpc(request) {
    try {
      if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') fail('BRIDGE_PROTOCOL_INVALID');
      if (request.method === 'initialize') return json(request.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'pai-chief-chat-bridge', version: '1.3.0' },
        instructions: 'Before a PAI handoff, Drive summary, MCP action, or thread close, commit only visible user-role messages not yet checkpointed with pai_commit_prompt_bundle. Set complete=false when coverage is uncertain. Never store assistant text, hidden reasoning, or unredacted restricted data in Drive.' });
      if (request.method === 'tools/list') {
        const tools = resolveJitTools(request.params, publicToolDefinitions);
        const projected = projectToolsList(tools, request.params || {});
        return json(request.id, {
          tools: projected.tools,
          _meta: { 'io.pai/catalog': { hydration: projected.hydration, schemaBytes: projected.schemaBytes, toolCount: projected.tools.length } }
        });
      }
      if (request.method === 'tools/get') {
        const projected = projectExactToolSchema(publicToolDefinitions, request.params || {});
        return json(request.id, { tool: projected.tools[0], tools: projected.tools, hydration: projected.hydration });
      }
      if (request.method === 'tools/call') {
        const supplied = request.params?.arguments ?? {};
        if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) fail('BRIDGE_SCHEMA_INVALID');
        // userId is transport identity, never a public tool argument. Retain a
        // closed failure for legacy callers that explicitly attempt to override
        // the server-bound identity, then replace it before tool dispatch.
        if (Object.prototype.hasOwnProperty.call(supplied, 'userId') && supplied.userId !== bound.userId) fail('BRIDGE_IDENTITY_MISMATCH');
        const { userId: _ignoredUserId, ...toolArguments } = supplied;
        // The public profile is enforced before call(), which is the boundary
        // that can begin a session or record audit/receipt state.
        if (!publicNames.has(request.params?.name)) fail('BRIDGE_TOOL_DENIED');
        return json(request.id, call(request.params?.name, { ...toolArguments, userId: bound.userId }));
      }
      fail('BRIDGE_METHOD_DENIED');
    } catch (e) { return error(request?.id, String(e.message || e)); }
  }
  return { rpc, call, toolDefinitions: allToolDefinitions, publicToolDefinitions, resolveJitTools, projectOutwardResult, sessionId: boundSessionId, storage };
}
module.exports = { createBridge, createBehavioralMemoryAdapter, TOOL_DEFINITIONS, PUBLIC_READ_ONLY_TOOL_NAMES, CHATGPT_PUBLIC_TOOL_NAMES, PROMPT_TOOL_NAMES, SESSION_ID, CHIEF_RESUME_MAX_BYTES, JIT_INTENT_TOOL_MAP, JIT_BOOTSTRAP_TOOLS };
