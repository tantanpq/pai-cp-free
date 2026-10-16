'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

// ── HOST_CONTROL Authority Policy ────────────────────────────────────────────
// Class A: Read-only host observation — auto-admit under founder technical authority
// Class B: Reversible candidate/local workspace change — bounded mutable scope + rollback
// Class C: Local service/process reversible control — named target + healthcheck
// Class D: Consequential — human gate required, fail-closed
const HOST_CONTROL_AUTHORITY_POLICY = Object.freeze({
  CLASS_A: {
    id: 'READ_ONLY_OBSERVATION',
    effect_classes: ['NO_MATERIAL_DELTA', 'READ_ONLY'],
    intents: ['HOST_INSPECT', 'FILESYSTEM_READ'],
    admission: 'AUTO_ADMIT',
    authority_provenance: 'FOUNDER_TECHNICAL_AUTHORITY_HOST_CONTROL_CLASS_A',
    requires_human_gate: false
  },
  CLASS_B: {
    id: 'REVERSIBLE_CANDIDATE',
    effect_classes: ['CANDIDATE_DRAFT'],
    intents: ['FILESYSTEM_EDIT', 'TERMINAL_COMMAND'],
    admission: 'GOVERNED_ADMIT',
    authority_provenance: 'FOUNDER_TECHNICAL_AUTHORITY_HOST_CONTROL_CLASS_B',
    requires_human_gate: false
  },
  CLASS_C: {
    id: 'REVERSIBLE_SERVICE_CONTROL',
    effect_classes: ['REVERSIBLE_LOCAL_EFFECT'],
    intents: ['SERVICE_CONTROL', 'PROCESS_CONTROL'],
    admission: 'GOVERNED_ADMIT',
    authority_provenance: 'FOUNDER_TECHNICAL_AUTHORITY_HOST_CONTROL_CLASS_C',
    requires_human_gate: false
  },
  CLASS_D: {
    id: 'CONSEQUENTIAL',
    effect_classes: ['CONSEQUENTIAL', 'UNKNOWN'],
    intents: [],
    admission: 'HUMAN_GATE',
    authority_provenance: 'REQUIRES_EXPLICIT_HUMAN_AUTHORIZATION',
    requires_human_gate: true
  }
});

const HOST_CONTROL_INTENTS = new Set([
  'HOST_INSPECT', 'TERMINAL_COMMAND', 'FILESYSTEM_READ',
  'FILESYSTEM_EDIT', 'SERVICE_CONTROL', 'PROCESS_CONTROL'
]);

function classifyHostControlAuthority(intent, effectClass) {
  const i = String(intent || '').toUpperCase();
  const ec = String(effectClass || '').toUpperCase();
  if (HOST_CONTROL_AUTHORITY_POLICY.CLASS_A.effect_classes.includes(ec) ||
      HOST_CONTROL_AUTHORITY_POLICY.CLASS_A.intents.includes(i)) return 'A';
  if (HOST_CONTROL_AUTHORITY_POLICY.CLASS_B.effect_classes.includes(ec) ||
      HOST_CONTROL_AUTHORITY_POLICY.CLASS_B.intents.includes(i)) return 'B';
  if (HOST_CONTROL_AUTHORITY_POLICY.CLASS_C.effect_classes.includes(ec) ||
      HOST_CONTROL_AUTHORITY_POLICY.CLASS_C.intents.includes(i)) return 'C';
  return 'D';
}

const DEFAULT_EXECUTORS = Object.freeze([
  {
    id: 'CODEX_HOME',
    provider: 'CODEX',
    cliPath: 'codex.exe',
    version: '0.145.0',
    authState: 'AUTHENTICATED',
    state: 'READY',
    quotaState: 'ACTIVE',
    locality: 'LOCAL_HOST',
    priority: 0,
    capabilities: [
      'workspaceRead', 'workspaceWrite', 'multiFileEdit',
      'CODE_ENGINEERING', 'BUILD', 'REPAIR', 'QA'
    ],
    taskBoxCapabilities: [
      'CANONICAL_WORKSPACE_RW', 'agentic-edit', 'CODEX_LOCAL', 'HOME_HOST_LOCAL'
    ],
    suitableRoles: ['BUILDER', 'REPAIR', 'QA']
  },
  {
    id: 'ANTIGRAVITY_CLI',
    provider: 'ANTIGRAVITY',
    cliPath: process.env.PAI_AGY_CLI_PATH || path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
    version: '1.2.2',
    authState: 'AUTHENTICATED',
    state: 'READY',
    quotaState: 'ACTIVE',
    locality: 'LOCAL_HOST',
    priority: 1,
    capabilities: [
      'workspaceRead', 'workspaceWrite', 'multiFileEdit', 'shellExec',
      'testExec', 'isolatedWorkspace', 'mcpSupport', 'gitWorktree',
      'CODE_ENGINEERING', 'CANONICAL_WORKSPACE_RW', 'agentic-edit',
      'BUILD', 'REPAIR', 'CHANGE'
    ],
    taskBoxCapabilities: [
      'CANONICAL_WORKSPACE_RW', 'agentic-edit', 'ANTIGRAVITY_LOCAL', 'HOME_HOST_LOCAL'
    ],
    suitableRoles: ['BUILDER', 'REPAIR', 'REVIEW', 'CHALLENGE', 'QA']
  },
  {
    id: 'GROK_CLI',
    provider: 'GROK',
    cliPath: process.env.PAI_GROK_CLI_PATH || path.join(os.homedir(), '.grok', 'bin', 'grok.exe'),
    version: '1.0.34',
    authState: 'AUTHENTICATED',
    state: 'READY',
    quotaState: 'ACTIVE',
    locality: 'LOCAL_HOST',
    priority: 2,
    capabilities: [
      'workspaceRead', 'shellExec', 'testExec', 'isolatedWorkspace', 'mcpSupport',
      'QA', 'REVIEW', 'CHALLENGE'
    ],
    taskBoxCapabilities: [
      'GROK_LOCAL', 'HOME_HOST_LOCAL'
    ],
    // Grok authorized role is bounded to QA, REVIEW, CHALLENGE. Strictly NO BUILDER or REPAIR.
    suitableRoles: ['REVIEW', 'CHALLENGE', 'QA']
  },
  {
    id: 'FARM_REMOTE',
    provider: 'FARM',
    cliPath: 'farm-worker',
    version: 'N/A',
    authState: 'ONLINE',
    state: 'QUOTA_EXHAUSTED',
    quotaState: 'EXHAUSTED',
    locality: 'REMOTE_FARM',
    priority: 99,
    capabilities: ['workspaceRead', 'workspaceWrite'],
    taskBoxCapabilities: null,
    suitableRoles: []
  },
  {
    id: 'DETERMINISTIC_TOOL',
    provider: 'DETERMINISTIC',
    cliPath: 'node',
    version: process.version,
    authState: 'READY',
    state: 'READY',
    quotaState: 'ACTIVE',
    locality: 'LOCAL_HOST',
    priority: 3,
    capabilities: ['NO_MATERIAL_DELTA', 'READ_ONLY', 'SPECIFICATION', 'STATIC_CHECK'],
    taskBoxCapabilities: ['HOME_HOST_LOCAL'],
    suitableRoles: ['SPEC_VALIDATOR', 'NO_EFFECT_EVALUATOR']
  },
  {
    id: 'DETERMINISTIC_HOST',
    provider: 'DETERMINISTIC_HOST',
    cliPath: 'powershell.exe',
    version: '7.x',
    authState: 'READY',
    state: 'READY',
    quotaState: 'ACTIVE',
    locality: 'LOCAL_HOST',
    priority: 0,
    capabilities: [
      'HOST_INSPECT', 'TERMINAL_COMMAND', 'FILESYSTEM_READ',
      'FILESYSTEM_EDIT', 'SERVICE_CONTROL', 'PROCESS_CONTROL',
      'NO_MATERIAL_DELTA', 'READ_ONLY', 'CANDIDATE_DRAFT', 'REVERSIBLE_LOCAL_EFFECT'
    ],
    taskBoxCapabilities: ['HOME_HOST_LOCAL'],
    suitableRoles: ['HOST_CONTROL']
  }
]);

const SENSITIVE_TERMS = /\b(PUBLICATION|PUBLIC_RELEASE|MONEY|PAYMENT|DISBURSEMENT|CREDENTIAL|SECRET|SYSTEM_CONTROL|ROOT_TRUST)\b/i;

class ExecutorRouter {
  constructor({ executors = null } = {}) {
    this.executors = new Map();
    const sourceList = Array.isArray(executors) ? executors : DEFAULT_EXECUTORS;
    for (const ex of sourceList) {
      this.executors.set(ex.id, { ...ex });
    }
    // Scope locking for one-writer safety
    this.activeScopes = new Map();
  }

  getExecutor(id) {
    return this.executors.get(id) || null;
  }

  attachAvailabilityStore(store) {
    this.availabilityStore = store;
    if (store) for (const executor of this.executors.values()) {
      const saved = store.get(executor.id);
      if (saved) Object.assign(executor, saved);
    }
  }

  setExecutorState(id, patch = {}) {
    const existing = this.executors.get(id);
    if (!existing) throw new Error(`EXECUTOR_NOT_FOUND: ${id}`);
    if (existing.retryHorizon && patch.state === 'READY' && patch.verifiedReadiness !== true) {
      throw new Error('PROVIDER_READINESS_REFRESH_REQUIRED');
    }
    Object.assign(existing, patch);
    if (patch.verifiedReadiness === true && existing.state === 'READY' &&
        existing.quotaState === 'ACTIVE' && ['AUTHENTICATED', 'READY'].includes(existing.authState)) {
      this.availabilityStore?.put(id, null);
      delete existing.unavailableReason;
      delete existing.retryHorizon;
    }
  }

  markProviderUnavailable(id, failureCode) {
    if (!/QUOTA|RATE_LIMIT|UNAVAILABLE|AUTH_REQUIRED|MISSING/.test(String(failureCode))) return;
    // Unknown reset time: require a readiness refresh, never guess a timed retry.
    const patch = { state: 'UNAVAILABLE', unavailableReason: failureCode,
      retryHorizon: 'UNTIL_EXPLICIT_READINESS_REFRESH' };
    if (/QUOTA|RATE_LIMIT/.test(failureCode)) patch.quotaState = 'EXHAUSTED';
    if (/AUTH_REQUIRED/.test(failureCode)) patch.authState = 'AUTH_REQUIRED';
    this.setExecutorState(id, patch);
    this.availabilityStore?.put(id, patch);
  }

  isScopeLocked(scope, callerRequestId = null) {
    if (!scope || scope === 'NONE') return false;
    const norm = scope.trim().toLowerCase();
    for (const [active, record] of this.activeScopes.entries()) {
      if (active === norm || active.startsWith(norm + '/') || norm.startsWith(active + '/')) {
        if (callerRequestId && record && record.requestId === callerRequestId) {
          return false;
        }
        return true;
      }
    }
    return false;
  }

  claimScope(scope, { taskId, requestId }) {
    if (!scope || scope === 'NONE') return null;
    const norm = scope.trim().toLowerCase();
    const existing = this.activeScopes.get(norm);
    if (existing && existing.requestId === requestId) {
      if (taskId) existing.taskId = taskId;
      return existing;
    }
    if (this.isScopeLocked(norm, requestId)) {
      const err = new Error(`CONCURRENT_SCOPE_LOCKED: Mutable scope "${scope}" is already claimed by an active writer.`);
      err.code = 'CONCURRENT_SCOPE_LOCKED';
      throw err;
    }
    const record = { scope: norm, taskId, requestId, claimedAt: new Date().toISOString() };
    this.activeScopes.set(norm, record);
    return record;
  }

  releaseScope(scope) {
    if (!scope || scope === 'NONE') return false;
    const norm = scope.trim().toLowerCase();
    return this.activeScopes.delete(norm);
  }

  validateAuthority({ intent, objective, scope, effect_class, authority_policy_ref } = {}) {
    const i = String(intent || '').toUpperCase();

    if (HOST_CONTROL_INTENTS.has(i)) {
      const authorityClass = classifyHostControlAuthority(i, effect_class);
      const policy = HOST_CONTROL_AUTHORITY_POLICY[`CLASS_${authorityClass}`];
      if (policy && policy.requires_human_gate) {
        const err = new Error('HOST_CONTROL_CONSEQUENTIAL_GATE: This operation requires explicit human authorization');
        err.code = 'HOST_CONTROL_CONSEQUENTIAL_GATE';
        throw err;
      }
      return;
    }

    const combined = `${intent || ''} ${objective || ''} ${scope || ''} ${effect_class || ''}`;
    if (SENSITIVE_TERMS.test(combined)) {
      const ref = typeof authority_policy_ref === 'string' ? authority_policy_ref.trim() : '';
      const hasGrantedPolicy = (
        /^AUTH_POLICY_GRANTED_[A-Za-z0-9._-]+$/i.test(ref) ||
        ref === '1sfyJ8E4Ffcv3hzz_aAB5X1WkWLlzS3Y4' ||
        /^[A-Za-z0-9_-]{28,44}$/.test(ref)
      );
      if (!hasGrantedPolicy) {
        const err = new Error('AUTHORITY_POLICY_DENIED: Sensitive effect class requires explicit granted authority policy');
        err.code = 'AUTHORITY_POLICY_DENIED';
        throw err;
      }
    }
  }

  /**
   * Pre-admission invariant: prove there exists at least ONE discrete active claimant
   * whose advertised TaskBox capabilities satisfy the executor's wire requirements.
   * Prevents union-of-capabilities false positives where multiple partial claimants
   * appear to satisfy a requirement that no single claimant can fulfill.
   */
  validateClaimantCompatibility(executor, activeClaimants = null) {
    if (!activeClaimants) return true; // not constrained by probe
    const required = executor.taskBoxCapabilities;
    if (!Array.isArray(required) || required.length === 0) {
      const err = new Error(`TASKBOX_CAPABILITIES_UNDECLARED: ${executor.id}`);
      err.code = 'TASKBOX_CAPABILITIES_UNDECLARED';
      throw err;
    }

    // Check for conflicting exact provider tokens within required wire capabilities
    const exactTokens = required.filter(c => ['CODEX_LOCAL', 'ANTIGRAVITY_LOCAL', 'GROK_LOCAL'].includes(c));
    if (exactTokens.length > 1) {
      const err = new Error(`CONFLICTING_EXACT_PROVIDER_CAPABILITIES: [${exactTokens.join(',')}]`);
      err.code = 'CONFLICTING_EXACT_PROVIDER_CAPABILITIES';
      throw err;
    }

    // Determine claimant list:
    // Supports:
    // - Array of claimant objects: [{ id, capabilities: [...] }, ...]
    // - Array of discrete capability arrays: [[...], [...]]
    // - Single claimant flat capability array: [...]
    let claimantList = [];
    if (Array.isArray(activeClaimants)) {
      if (activeClaimants.length > 0 && typeof activeClaimants[0] === 'object' && !Array.isArray(activeClaimants[0])) {
        claimantList = activeClaimants.map(c => new Set(Array.isArray(c.capabilities) ? c.capabilities : []));
      } else if (activeClaimants.length > 0 && Array.isArray(activeClaimants[0])) {
        claimantList = activeClaimants.map(arr => new Set(arr));
      } else {
        claimantList = [new Set(activeClaimants)];
      }
    }

    // Prove there exists at least ONE discrete claimant that satisfies ALL required capabilities
    const satisfyingClaimant = claimantList.find(claimantCaps => {
      return required.every(cap => claimantCaps.has(cap));
    });

    if (!satisfyingClaimant) {
      const err = new Error(`TASK_CAPABILITY_UNCLAIMABLE: Executor ${executor.id} requires [${required.join(',')}] but no single active claimant satisfies all required capabilities`);
      err.code = 'TASK_CAPABILITY_UNCLAIMABLE';
      err.executorId = executor.id;
      throw err;
    }
    return true;
  }

  selectExecutor({
    requiredCapabilities = [],
    mutableScope = 'NONE',
    role = 'BUILDER',
    preferredExecutor = null,
    executorConstraint = null,
    excludeExecutors = [],
    activeClaimants = null
  } = {}) {
    const excluded = new Set(excludeExecutors);

    if (preferredExecutor) {
      const normalized = String(preferredExecutor).toUpperCase();
      const registered = [...this.executors.values()].some(e =>
        String(e.id).toUpperCase() === normalized || String(e.provider).toUpperCase() === normalized);
      if (!registered) {
        const err = new Error(`PINNED_EXECUTOR_UNAVAILABLE: ${normalized}`);
        err.code = 'PINNED_EXECUTOR_UNAVAILABLE';
        throw err;
      }
    }

    if (mutableScope !== 'NONE' && this.isScopeLocked(mutableScope)) {
      const err = new Error(`CONCURRENT_SCOPE_LOCKED: Mutable scope "${mutableScope}" is currently locked.`);
      err.code = 'CONCURRENT_SCOPE_LOCKED';
      throw err;
    }

    const eligible = [];
    const blockedByQuota = [];
    const blockedByClaimant = [];

    for (const executor of this.executors.values()) {
      if (excluded.has(executor.id)) continue;

      // Check required capabilities first
      if (Array.isArray(requiredCapabilities) && requiredCapabilities.length > 0) {
        const missing = requiredCapabilities.filter(req => !executor.capabilities.includes(req));
        if (missing.length > 0) continue;
      }

      // Check role suitability (Grok can never be BUILDER/REPAIR)
      if (role && Array.isArray(executor.suitableRoles) && executor.suitableRoles.length > 0 && !executor.suitableRoles.includes(role)) {
        continue;
      }

      if (executor.state !== 'READY') {
        if (executor.quotaState === 'EXHAUSTED') {
          blockedByQuota.push(executor.id);
        }
        continue;
      }

      if (executor.authState !== 'AUTHENTICATED' && executor.authState !== 'READY') {
        continue;
      }

      if (executor.quotaState === 'EXHAUSTED') {
        blockedByQuota.push(executor.id);
        continue;
      }

      // Check claimant compatibility if active claimants were provided
      if (activeClaimants && Array.isArray(executor.taskBoxCapabilities)) {
        try {
          this.validateClaimantCompatibility(executor, activeClaimants);
        } catch (err) {
          blockedByClaimant.push({ id: executor.id, error: err.message });
          continue;
        }
      }

      eligible.push(executor);
    }

    if (eligible.length === 0) {
      if (blockedByQuota.length > 0) {
        const err = new Error(`QUOTA_EXHAUSTED: Executors exhausted: ${blockedByQuota.join(', ')}`);
        err.code = 'QUOTA_EXHAUSTED';
        err.blockedExecutors = blockedByQuota;
        throw err;
      }
      if (blockedByClaimant.length > 0) {
        const err = new Error(`TASK_CAPABILITY_UNCLAIMABLE: No active claimant can satisfy requirements for: ${blockedByClaimant.map(b => b.id).join(', ')}`);
        err.code = 'TASK_CAPABILITY_UNCLAIMABLE';
        err.blockedDetails = blockedByClaimant;
        throw err;
      }
      const err = new Error('NO_ELIGIBLE_EXECUTOR_AVAILABLE: No ready executor matches the required capabilities.');
      err.code = 'NO_ELIGIBLE_EXECUTOR';
      throw err;
    }

    // Constraint evaluation
    if (executorConstraint) {
      const normalized = String(executorConstraint).toUpperCase();
      const constrained = eligible.find(e => e.id === normalized || e.provider === normalized);
      if (constrained) return constrained;
      const err = new Error(`EXECUTOR_CONSTRAINT_UNAVAILABLE: ${normalized}`);
      err.code = 'EXECUTOR_CONSTRAINT_UNAVAILABLE';
      throw err;
    }

    // If preferred executor requested and eligible, use it
    if (preferredExecutor) {
      const normPref = String(preferredExecutor).toUpperCase();
      const matched = eligible.find(e => e.id === normPref || e.provider === normPref);
      if (matched) return matched;
      // Preferred executor was not eligible (e.g. quota exhausted or unavailable).
      // Deterministically fallback according to policy:
    }

    // Deterministic policy ordering:
    // For QA / Review: prefer GROK_CLI if eligible, then ANTIGRAVITY_CLI, then CODEX_HOME
    if (role === 'QA' || role === 'REVIEW') {
      const grok = eligible.find(e => e.id === 'GROK_CLI');
      if (grok) return grok;
      const anti = eligible.find(e => e.id === 'ANTIGRAVITY_CLI');
      if (anti) return anti;
      const codex = eligible.find(e => e.id === 'CODEX_HOME');
      if (codex) return codex;
    }

    // For Builder / Repair:
    // Codex preferred if eligible; when Codex unavailable/quota-blocked, Antigravity is selected!
    // Grok is NEVER selected for Builder/Repair (suitableRoles guard).
    const codex = eligible.find(e => e.id === 'CODEX_HOME');
    if (codex) return codex;

    const anti = eligible.find(e => e.id === 'ANTIGRAVITY_CLI');
    if (anti) {
      return anti;
    }

    // Otherwise first eligible
    return eligible[0];
  }
}

module.exports = {
  DEFAULT_EXECUTORS,
  ExecutorRouter,
  HOST_CONTROL_AUTHORITY_POLICY,
  HOST_CONTROL_INTENTS,
  classifyHostControlAuthority
};
