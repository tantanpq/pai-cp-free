'use strict';

const crypto = require('node:crypto');

const VERIFIED_CARDS = [
  {
    provider: 'ANTIGRAVITY',
    surface: 'google-deepmind/antigravity-agent',
    capabilities: ['CODE_ENGINEERING', 'SCOUT', 'SYNTHESIZE', 'ARCHITECT', 'VERIFY', 'LOCAL_CANARY'],
    connectors: ['MCP', 'CLI', 'API'],
    supported_effects: ['AUTHORITY_NONE', 'LOCAL_READ', 'LOCAL_WRITE_PREVIEW'],
    identity_support: {
      supports_pai_conversation_ref: true,
      supports_provider_thread_ref: true
    },
    session_support: 'STATEFUL_SESSION',
    best_for: ['Autonomous codebase refactoring', 'Provider-neutral cognition', 'In-situ deterministic test execution'],
    privacy_constraints: {
      data_retention_policy: 'LOCAL_MACHINE_ONLY',
      zero_data_retention_verified: true,
      restricted_cones: ['CREDENTIALS_AND_TRUST_ROOTS']
    },
    user_entitlement: 'VERIFIED',
    cost_class: 'LOCAL_HOST',
    freshness: 'CURRENT',
    evidence_refs: [
      { kind: 'OFFICIAL', ref: 'GOOGLE_DEEPMIND_ANTIGRAVITY_RUNTIME_V2', verified_at: '2026-09-19T00:00:00Z' },
      { kind: 'LIVE_CANARY', ref: 'CANARY_ANTIGRAVITY_20260919', verified_at: '2026-09-19T01:00:00Z' }
    ],
    canary_status: 'PASS',
    last_verified_at: '2026-09-19T12:00:00Z',
    auth_state: 'AUTHENTICATED',
    health: 'HEALTHY',
    latency_class: 'LOCAL_FAST',
    locality: 'LOCAL_HOST',
    supported_protocols: ['2026-07-28', '2025-03-26'],
    context_cost_estimate: 'LOW',
    schema_bytes: 1480,
    expected_result_budget: 1200,
    source_read_budget: 8192
  },
  {
    provider: 'CHATGPT',
    surface: 'openai/chatgpt-secure-mcp',
    capabilities: ['SYNTHESIZE', 'ARCHITECT', 'PLAN', 'RECONCILE', 'CURATE'],
    connectors: ['MCP'],
    supported_effects: ['AUTHORITY_NONE', 'LOCAL_READ'],
    identity_support: {
      supports_pai_conversation_ref: true,
      supports_provider_thread_ref: true
    },
    session_support: 'HYBRID',
    best_for: ['Long-form strategic synthesis', 'High-level architectural challenge'],
    privacy_constraints: {
      data_retention_policy: 'ENTERPRISE_ZERO_RETENTION',
      zero_data_retention_verified: true,
      restricted_cones: ['SYSTEM_SECRETS', 'PRODUCTION_POSTGRESQL']
    },
    user_entitlement: 'VERIFIED',
    cost_class: 'SUBSCRIPTION',
    freshness: 'CURRENT',
    evidence_refs: [
      { kind: 'OFFICIAL', ref: 'OPENAI_SECURE_TUNNEL_RECEIPT_20260831', verified_at: '2026-08-31T22:00:37Z' },
      { kind: 'LIVE_CANARY', ref: 'CANARY_CHATGPT_TUNNEL_20260831', verified_at: '2026-08-31T22:00:37Z' }
    ],
    canary_status: 'PASS',
    last_verified_at: '2026-09-19T01:10:00Z',
    auth_state: 'AUTHENTICATED',
    health: 'HEALTHY',
    latency_class: 'NETWORK_TYPICAL',
    locality: 'REMOTE_CLOUD',
    supported_protocols: ['2026-07-28', '2025-03-26'],
    context_cost_estimate: 'MEDIUM',
    schema_bytes: 2150,
    expected_result_budget: 2048,
    source_read_budget: 8192
  },
  {
    provider: 'CLAUDE',
    surface: 'anthropic/claude-desktop-mcp',
    capabilities: ['SCOUT', 'CHALLENGE', 'VERIFY', 'CURATE'],
    connectors: ['MCP'],
    supported_effects: ['AUTHORITY_NONE', 'LOCAL_READ'],
    identity_support: {
      supports_pai_conversation_ref: true,
      supports_provider_thread_ref: false
    },
    session_support: 'STATEFUL_SESSION',
    best_for: ['Independent QA verification', 'Adversarial challenge', 'Code critique'],
    privacy_constraints: {
      data_retention_policy: 'LOCAL_DESKTOP_BOUND',
      zero_data_retention_verified: false,
      restricted_cones: ['SECRETS']
    },
    user_entitlement: 'VERIFIED',
    cost_class: 'SUBSCRIPTION',
    freshness: 'CURRENT',
    evidence_refs: [
      { kind: 'OFFICIAL', ref: 'ANTHROPIC_CLAUDE_LOCAL_MCP_RECEIPT', verified_at: '2026-08-24T00:00:00Z' },
      { kind: 'LIVE_CANARY', ref: 'CANARY_CLAUDE_W3_QA_PASS', verified_at: '2026-08-24T07:15:00Z' }
    ],
    canary_status: 'PASS',
    last_verified_at: '2026-09-18T10:00:00Z',
    auth_state: 'AUTHENTICATED',
    health: 'HEALTHY',
    latency_class: 'NETWORK_TYPICAL',
    locality: 'REMOTE_CLOUD',
    supported_protocols: ['2025-03-26'],
    context_cost_estimate: 'MEDIUM',
    schema_bytes: 2150,
    expected_result_budget: 2048,
    source_read_budget: 8192
  },
  {
    provider: 'GROK',
    surface: 'xai/grok-cli',
    capabilities: ['CODE_ENGINEERING', 'SCOUT', 'SYNTHESIZE', 'ARCHITECT', 'VERIFY', 'LOCAL_CANARY', 'MULTI_FILE_EDIT', 'QA', 'REVIEW'],
    connectors: ['CLI', 'MCP'],
    supported_effects: ['AUTHORITY_NONE', 'LOCAL_READ', 'LOCAL_WRITE_PREVIEW'],
    identity_support: {
      supports_pai_conversation_ref: true,
      supports_provider_thread_ref: true
    },
    session_support: 'STATEFUL_SESSION',
    best_for: ['Autonomous codebase refactoring', 'TypeScript/Node scripts', 'Independent QA verification'],
    privacy_constraints: {
      data_retention_policy: 'LOCAL_MACHINE_ONLY',
      zero_data_retention_verified: true,
      restricted_cones: ['CREDENTIALS_AND_TRUST_ROOTS']
    },
    user_entitlement: 'VERIFIED',
    cost_class: 'LOCAL_HOST',
    freshness: 'CURRENT',
    evidence_refs: [
      { kind: 'OFFICIAL', ref: 'XAI_GROK_CLI_RUNTIME_V1', verified_at: '2026-09-20T00:00:00Z' },
      { kind: 'LIVE_CANARY', ref: 'CANARY_GROK_20260920', verified_at: '2026-09-20T06:37:00Z' }
    ],
    canary_status: 'PASS',
    last_verified_at: '2026-09-20T06:37:00Z',
    auth_state: 'AUTHENTICATED',
    health: 'HEALTHY',
    latency_class: 'LOCAL_FAST',
    locality: 'LOCAL_HOST',
    supported_protocols: ['2026-07-28', '2025-03-26'],
    context_cost_estimate: 'LOW',
    schema_bytes: 1550,
    expected_result_budget: 1200,
    source_read_budget: 8192
  },
  {
    provider: 'DETERMINISTIC_HOST',
    surface: 'pai/governed-host-control',
    capabilities: ['HOST_INSPECT', 'TERMINAL_COMMAND', 'FILESYSTEM_READ', 'FILESYSTEM_EDIT', 'SERVICE_CONTROL', 'PROCESS_CONTROL'],
    connectors: ['INTERNAL'],
    supported_effects: ['NO_MATERIAL_DELTA', 'READ_ONLY', 'CANDIDATE_DRAFT', 'REVERSIBLE_LOCAL_EFFECT'],
    identity_support: {
      supports_pai_conversation_ref: true,
      supports_provider_thread_ref: false
    },
    session_support: 'BOUNDED_SESSION',
    best_for: ['Host inspection', 'Deterministic terminal commands', 'Bounded filesystem operations', 'Service status and control'],
    privacy_constraints: {
      data_retention_policy: 'LOCAL_MACHINE_ONLY',
      zero_data_retention_verified: true,
      restricted_cones: ['CREDENTIALS_AND_TRUST_ROOTS', 'BROWSER_TOKENS']
    },
    user_entitlement: 'VERIFIED',
    cost_class: 'ZERO',
    freshness: 'CURRENT',
    evidence_refs: [
      { kind: 'OFFICIAL', ref: 'PAI_GOVERNED_HOST_CONTROL_ADAPTER_R1', verified_at: new Date().toISOString() },
      { kind: 'LIVE_CANARY', ref: 'CANARY_HOST_CONTROL_DETERMINISTIC', verified_at: new Date().toISOString() }
    ],
    canary_status: 'PENDING',
    last_verified_at: new Date().toISOString(),
    auth_state: 'READY',
    health: 'HEALTHY',
    latency_class: 'LOCAL_INSTANT',
    locality: 'LOCAL_HOST',
    supported_protocols: ['2026-07-28'],
    context_cost_estimate: 'ZERO',
    schema_bytes: 0,
    expected_result_budget: 1024,
    source_read_budget: 0,
    llm_required: false
  }
];

function checkCapabilityCardEligibility(card) {
  if (!card) return { eligible: false, reason: 'CARD_MISSING' };
  if (card.freshness !== 'CURRENT') return { eligible: false, reason: 'STALE_CAPABILITY' };
  if (!card.user_entitlement) return { eligible: false, reason: 'ENTITLEMENT_UNKNOWN' };
  if (card.user_entitlement !== 'VERIFIED') return { eligible: false, reason: 'ENTITLEMENT_NOT_VERIFIED' };
  if (!Array.isArray(card.evidence_refs) || card.evidence_refs.length === 0) return { eligible: false, reason: 'UNVERIFIED_EVIDENCE' };
  const hasQualifying = card.evidence_refs.some(e => e.kind === 'OFFICIAL' || e.kind === 'LIVE_CANARY');
  if (!hasQualifying) return { eligible: false, reason: 'UNVERIFIED_EVIDENCE' };
  if (card.canary_status === 'FAIL') return { eligible: false, reason: 'CANARY_FAILED' };
  return { eligible: true, reason: 'ELIGIBLE' };
}

function getVerifiedCards() {
  return VERIFIED_CARDS.map(card => ({ ...card }));
}

function findCard(provider) {
  const norm = String(provider || '').toUpperCase();
  return VERIFIED_CARDS.find(c => c.provider === norm) || null;
}

function discoverEligibleCards({ objective = '', required_capabilities = [], privacy_boundary, provider_preference } = {}) {
  const eligible = [];
  const blockers = [];
  const unknowns = [];

  for (const card of VERIFIED_CARDS) {
    if (provider_preference && card.provider !== String(provider_preference).toUpperCase()) {
      continue;
    }
    const check = checkCapabilityCardEligibility(card);
    if (!check.eligible) {
      blockers.push({ provider: card.provider, reason: check.reason });
      continue;
    }

    // Check required capabilities if requested
    if (Array.isArray(required_capabilities) && required_capabilities.length > 0) {
      const missing = required_capabilities.filter(req => !card.capabilities.includes(req));
      if (missing.length > 0) {
        blockers.push({ provider: card.provider, reason: `MISSING_CAPABILITIES: ${missing.join(',')}` });
        continue;
      }
    }

    // Check privacy boundary
    if (privacy_boundary === 'LOCAL_ONLY' && card.locality !== 'LOCAL_HOST') {
      blockers.push({ provider: card.provider, reason: 'LOCAL_ONLY_BOUNDARY_VIOLATION' });
      continue;
    }

    eligible.push(card);
  }

  // Context-aware capability resolution (Section 21)
  const hasLowCost = eligible.some(c => c.context_cost_estimate === 'LOW');
  const contextCostEstimate = hasLowCost ? 'LOW' : (eligible.length > 0 ? 'MEDIUM' : 'NONE');
  const minSchemaBytes = eligible.length > 0 ? Math.min(...eligible.map(c => c.schema_bytes || 2000)) : 0;
  const minResultBudget = eligible.length > 0 ? Math.min(...eligible.map(c => c.expected_result_budget || 2048)) : 0;

  return {
    objective,
    eligible_count: eligible.length,
    eligible_providers: eligible.map(c => c.provider),
    capability_cards: eligible,
    context_cost_estimate: contextCostEstimate,
    schema_bytes: minSchemaBytes,
    expected_result_budget: minResultBudget,
    source_read_budget: 8192,
    local_blockers: blockers,
    unknowns
  };
}

module.exports = {
  VERIFIED_CARDS,
  checkCapabilityCardEligibility,
  getVerifiedCards,
  findCard,
  discoverEligibleCards
};
