'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createAdminBridgeClient } = require('./admin-bridge-client');
const { discoverEligibleCards, findCard } = require('./capability-cards');
const { AntigravityProviderAdapter } = require('./antigravity-adapter');
const { digest, stable } = require('./provider-result-envelope');
const { observeCall, writeCallUsage } = require('./turn-call-usage');
// PAI Bootstrap Provider V0 — ChatGPT Web adapter (lazy, guarded by env)
let ChatGPTWebProviderAdapter = null;
if (process.env.CHATGPT_WEB_ENABLED === '1') {
  try {
    ({ ChatGPTWebProviderAdapter } = require('./chatgpt-web-adapter'));
  } catch (e) {
    // Non-fatal: CHATGPT adapter not available; ANTIGRAVITY remains default
  }
}
const { ExecutorRouter, HOST_CONTROL_INTENTS } = require('./executor-router');
const {
  GovernedHostControlAdapter,
  matchesDenyList,
  matchesAllowList,
  classifyAuthorityClass,
  isPathWithinRoots,
  extractWritePaths,
  ALLOWED_WRITE_ROOTS
} = require('./host-control-adapter');
const { resolveTargetHost } = require('./host-capability-resolver');
const { runDirectCliTransport } = require('./direct-cli-transport');
const { validMutableScope, providerCapability } = require('./work-contract');
const { serializeDispatch } = require('./chief-delegation-admission');
const { createProviderAvailabilityStore } = require('./provider-availability');
const { SessionRuntime } = require('../../computer_execution_fabric_v1/runtime/session-runtime.cjs');

function taskBoxWireCapabilitiesForExecutor(executor) {
  const caps = executor && executor.taskBoxCapabilities;
  if (!Array.isArray(caps) || caps.length === 0 ||
      caps.some(cap => typeof cap !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cap)) ||
      new Set(caps).size !== caps.length) {
    const err = new Error(`TASKBOX_CAPABILITIES_UNDECLARED: ${executor && executor.id ? executor.id : 'UNKNOWN'}`);
    err.code = 'TASKBOX_CAPABILITIES_UNDECLARED';
    throw err;
  }
  const neutral = caps.filter(cap => !providerCapability(cap));
  if (!neutral.length) throw new Error('TASKBOX_NEUTRAL_CAPABILITIES_UNDECLARED');
  return neutral;
}
class FederationCore {
  constructor(options = {}) {
    this.options = options;
    this.admission = options.admission || null;
    this.taskBoxRoot = options.taskBoxRoot || null;
    this.db = options.db || null;
    this.continuity = options.continuity || null;
    this.router = options.executorRouter || new ExecutorRouter();
    this.router.attachAvailabilityStore(createProviderAvailabilityStore(this.db));

    this.adapters = new Map();
    this.idempotencyLedger = new Map();
    this.tasks = new Map();
    const identity = options.identity;
    this.acceptedIdentity = identity && identity.userId && identity.paiIdentityId && identity.projectId
      ? { userId:identity.userId, paiIdentityId:identity.paiIdentityId, projectId:identity.projectId } : null;
    this.acceptedReceiptPrefix = this.acceptedIdentity ? 'accepted_action:' + digest(this.acceptedIdentity) + ':' : null;
    this.acceptedReceiptRead = this.acceptedIdentity && this.db && typeof this.db.prepare === 'function'
      ? this.db.prepare('SELECT input_hash,body_json FROM chief_bridge_receipts WHERE receipt_key=?') : null;
    this.acceptedReceiptWrite = this.acceptedIdentity && this.db && typeof this.db.prepare === 'function'
      ? this.db.prepare('INSERT OR REPLACE INTO chief_bridge_receipts (receipt_key,input_hash,body_json,created_at) VALUES (?,?,?,?)') : null;

    // Register built-in Antigravity adapter
    const antigravity = new AntigravityProviderAdapter();
    this.adapters.set(antigravity.providerId, antigravity);

    // PAI Bootstrap Provider V0 — Register ChatGPT Web adapter if enabled
    if (ChatGPTWebProviderAdapter) {
      const chatgpt = new ChatGPTWebProviderAdapter();
      this.adapters.set(chatgpt.providerId, chatgpt);
    }

    // Initialize governed host control adapter (internal — never exposed as MCP tool)
    this.hostControlAdapter = new GovernedHostControlAdapter({ hostId: options.hostId || 'HOME_SIMPLE_BODY_01' });

    this.realReaders = options.realReaders || null;
    this.refreshQcheck = options.refreshQcheck || null;

    // Initialize persistent session runtime (HOME only, governed admission)
    this.sessionRuntime = options.sessionRuntime || new SessionRuntime({
      authorityReader: () => {
        if (typeof options.authorityReader === 'function') {
          return options.authorityReader();
        }

        // 1. Prefer the current-bound authority readback from Claim Service.
        if (this.realReaders && typeof this.realReaders.authority === 'function') {
          try {
            const authState = this.realReaders.authority();
            if(authState?.authorityBindingFailed===true)return {status:'UNAVAILABLE',statusCode:503,reason:authState.failureClass||'CLAIM_AUTHORITY_BINDING_FAILED'};
            if (authState && authState.status === 'OK' && authState.authority) {
              const auth = authState.authority;
              const updatedAtMs = Date.parse(auth.updatedAt);
              const leaseExpiresMs = Date.parse(auth.leaseExpiresAt);
              const isFresh = auth.backend==='SQLITE' ? authState.currentBound===true&&Number.isFinite(leaseExpiresMs)&&leaseExpiresMs-Date.now()>=30000 : (Number.isFinite(leaseExpiresMs) && Date.now() < leaseExpiresMs + 60000)
                || (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= 5 * 60 * 1000);
              if(auth.backend==='SQLITE'&&(!isFresh||auth.operationalCutover!==true||!Number.isSafeInteger(auth.fencingToken)||auth.fencingToken<1))return {status:'UNAVAILABLE',statusCode:503,reason:'SQLITE_AUTHORITY_NOT_ELIGIBLE'};
              if (auth.operationalCutover === true && isFresh) {
                const fence = auth.fencingToken !== undefined && auth.fencingToken !== null
                  ? String(auth.fencingToken)
                  : (auth.releaseHash ? String(auth.releaseHash) : null);
                if (fence) {
                  return {
                    status: 'AVAILABLE',
                    fenceRef: fence,
                    provenance: auth.backend==='SQLITE'?'CLAIM_SERVICE_HOME_SQLITE':'CLAIM_SERVICE_POSTGRESQL',
                    authority: auth
                  };
                }
              }
            }
          } catch (_) {}
        }

        // 2. Fallback to continuity / canonicalTruth
        if (typeof this.continuity !== 'function') {
          return { status: 'UNAVAILABLE', statusCode: 503, reason: 'CONTINUITY_FUNCTION_MISSING' };
        }
        let truth;
        try {
          truth = this.continuity();
        } catch (err) {
          return { status: 'UNAVAILABLE', statusCode: 503, reason: `CONTINUITY_READ_FAILED: ${err.message || err}` };
        }

        // 3. If degraded and refreshQcheck is available, trigger bounded JIT refresh
        if ((!truth || truth.available === false || truth.status === 'DEGRADED') && typeof this.refreshQcheck === 'function') {
          try {
            this.refreshQcheck();
            truth = this.continuity();
          } catch (_) {}
        }

        if (!truth || truth.available === false || truth.status === 'DEGRADED') {
          return { status: 'UNAVAILABLE', statusCode: 503, reason: truth?.degradedReason || 'CURRENT_FENCE_OR_AUTHORITY_READBACK_UNAVAILABLE' };
        }
        const currentFence = truth.fenceRef || truth.bundleHash || (truth.authority?.fencingToken !== undefined ? String(truth.authority.fencingToken) : null) || truth.authority?.fenceRef || (truth.projectionHash ? String(truth.projectionHash) : null);
        if (!currentFence || typeof currentFence !== 'string') {
          return { status: 'UNAVAILABLE', statusCode: 503, reason: 'CURRENT_FENCE_OR_AUTHORITY_READBACK_UNAVAILABLE' };
        }
        return { status: 'AVAILABLE', fenceRef: currentFence, provenance: 'CANONICAL_TRUTH_CONTINUITY' };
      },
      fenceValidator: (expected, actual) => {
        if (!expected || !actual) return false;
        return expected === actual;
      },
      authorityClassifier: (effectClass, cmd) => {
        return classifyAuthorityClass('TERMINAL_COMMAND', effectClass, cmd);
      },
      operationAuthorizer: (cmd, effectClass, session) => {
        const denyCheck = matchesDenyList(cmd);
        if (denyCheck.denied) {
          return {
            authorized: false,
            code: 'HOST_CONTROL_DENIED',
            reason: `HOST_CONTROL_DENIED: Command matches deny pattern "${denyCheck.pattern}"`
          };
        }
        const effectiveClass = effectClass || (session && session.effectClass) || 'CANDIDATE_DRAFT';
        const authClass = classifyAuthorityClass('TERMINAL_COMMAND', effectiveClass, cmd);
        if (authClass === 'D') {
          return {
            authorized: false,
            code: 'HOST_CONTROL_CONSEQUENTIAL_GATE',
            reason: 'HOST_CONTROL_CONSEQUENTIAL_GATE: Consequential operations forbidden in terminal session'
          };
        }
        if (authClass === 'A') {
          if (!matchesAllowList(cmd) && (effectiveClass === 'NO_MATERIAL_DELTA' || effectiveClass === 'READ_ONLY')) {
            return {
              authorized: false,
              code: 'HOST_CONTROL_NOT_ALLOWED',
              reason: 'HOST_CONTROL_NOT_ALLOWED: Command not in read-only allow list for Class A'
            };
          }
        }

        // Scope validation for candidate sessions: prevent writes outside admitted mutable scope
        const candidateScope = (session && session.scope && session.scope !== 'NONE') ? session.scope : null;
        const writePaths = extractWritePaths(cmd);
        if (writePaths.length > 0) {
          const allowedRoots = candidateScope ? [candidateScope, ...ALLOWED_WRITE_ROOTS] : [...ALLOWED_WRITE_ROOTS];
          const baseCwd = session?.cwd || candidateScope || process.cwd();
          for (const wp of writePaths) {
            if (!isPathWithinRoots(wp, allowedRoots, baseCwd)) {
              return {
                authorized: false,
                code: 'HOST_CONTROL_SCOPE_DENIED',
                reason: `HOST_CONTROL_SCOPE_DENIED: Write target "${wp}" is outside admitted mutable scope "${candidateScope || 'NONE'}"`
              };
            }
          }
        }

        return { authorized: true };
      }
    });
  }

  registerAdapter(adapter) {
    this.adapters.set(adapter.providerId, adapter);
  }

  _readAcceptedAdmission(id) {
    if (!this.acceptedReceiptRead || !this.acceptedReceiptPrefix || typeof id !== 'string') return null;
    const mismatch = () => { throw Error('ACCEPTED_ADMISSION_LOOKUP_MISMATCH'); };
    const parse = value => {
      let body;
      try { body=JSON.parse(value); } catch (_) { return mismatch(); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return mismatch();
      return body;
    };
    const validateTask = (row, taskId) => {
      if (!row) return mismatch();
      const body=parse(row.body_json);
      if (body.taskId !== taskId) return mismatch();
      if (body.schema !== 'pai-chief-accepted-action-admission/v1' || digest(body.identity) !== digest(this.acceptedIdentity)) throw Error('ACCEPTED_ADMISSION_IDENTITY_MISMATCH');
      if (body.identityBinding !== 'BOUND_IDENTITY_V1' || body.taskId !== this._boundTaskId(row.input_hash)) throw Error('ACCEPTED_ADMISSION_LEGACY_UNBOUND');
      return {...body,requestDigest:row.input_hash};
    };
    // Neither namespace may shadow the other: request IDs are caller supplied
    // and can legitimately equal another admission's generated task ID.
    const taskRow=this.acceptedReceiptRead.get(this.acceptedReceiptPrefix + 'task:' + id);
    const alias=this.acceptedReceiptRead.get(this.acceptedReceiptPrefix + 'request:' + id);
    const task=taskRow ? validateTask(taskRow,id) : null;
    let request=null;
    if (alias) {
      const target=parse(alias.body_json);
      if (typeof target.taskId !== 'string' || !target.taskId) return mismatch();
      request=validateTask(this.acceptedReceiptRead.get(this.acceptedReceiptPrefix + 'task:' + target.taskId),target.taskId);
      if (request.requestId !== id || alias.input_hash !== request.requestDigest) return mismatch();
    }
    if (task && request && digest(task) !== digest(request)) throw Error('ACCEPTED_ADMISSION_LOOKUP_AMBIGUOUS');
    // Existing malformed/dangling routes reject above; null means both absent.
    return task || request;
  }

  _boundTaskId(requestDigest) {
    return 'CHIEF_REQUEST_' + digest({identity:this.acceptedIdentity,requestDigest}).slice(0,24).toUpperCase();
  }

  _prepareAcceptedMaterialization(binding, requestDigest) {
    if (!this.acceptedReceiptWrite) return false;
    const key=this.acceptedReceiptPrefix+'pending:'+binding.taskId;
    const requestKey=this.acceptedReceiptPrefix+'pending-request:'+binding.requestId;
    const body={schema:'pai-chief-accepted-action-materialization/v1',...binding,identity:this.acceptedIdentity,identityBinding:'BOUND_IDENTITY_V1'};
    const request=this.acceptedReceiptRead.get(requestKey);
    if(request&&(request.input_hash!==requestDigest||JSON.parse(request.body_json).taskId!==binding.taskId))throw Error('ACTION_IDEMPOTENCY_CONFLICT');
    const existing=this.acceptedReceiptRead.get(key);
    if (existing) {
      if (!request || existing.input_hash !== requestDigest || digest(JSON.parse(existing.body_json)) !== digest(body)) throw Error('ACCEPTED_MATERIALIZATION_CONFLICT');
      return true;
    }
    if(fs.existsSync(path.join(this.taskBoxRoot,binding.dispatchRef))||fs.existsSync(path.join(this.taskBoxRoot,'archive',binding.dispatchRef)))throw Error('ACCEPTED_MATERIALIZATION_UNBOUND_ORPHAN');
    // Durable intent precedes file creation. Existing bytes without this exact
    // identity/request/hash intent must never be adopted after a crash.
    this.db.exec('BEGIN');
    try {
      this.acceptedReceiptWrite.run(key,requestDigest,JSON.stringify(body),new Date().toISOString());
      this.acceptedReceiptWrite.run(requestKey,requestDigest,JSON.stringify({taskId:binding.taskId}),new Date().toISOString());
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return false;
  }

  _persistAcceptedAdmission(binding, requestDigest) {
    if (!this.acceptedReceiptWrite || !this.acceptedReceiptPrefix) return;
    const existing=this._readAcceptedAdmission(binding.requestId);
    if (existing && (existing.requestDigest !== requestDigest || existing.taskId !== binding.taskId)) throw Error('ACTION_IDEMPOTENCY_CONFLICT');
    const body={schema:'pai-chief-accepted-action-admission/v1',...binding,identity:this.acceptedIdentity,identityBinding:'BOUND_IDENTITY_V1'};
    const at=new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      this.acceptedReceiptWrite.run(this.acceptedReceiptPrefix+'task:'+binding.taskId,requestDigest,JSON.stringify(body),at);
      this.acceptedReceiptWrite.run(this.acceptedReceiptPrefix+'request:'+binding.requestId,requestDigest,JSON.stringify({taskId:binding.taskId}),at);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }

  resolveAcceptedTask(id, userId) {
    if (userId !== undefined && userId !== this.acceptedIdentity?.userId) throw Error('BRIDGE_IDENTITY_MISMATCH');
    const binding=this._readAcceptedAdmission(id); if(!binding)return null;
    if(!this.realReaders||typeof this.realReaders.acceptedResult!=='function')return {status:'UNAVAILABLE',failureClass:'CLAIM_RESULT_READER_UNAVAILABLE',binding};
    return {...this.realReaders.acceptedResult(binding),binding};
  }

  _acceptedAdmissionReplay(binding) {
    return { request_id:binding.requestId, chief_state:'ADMITTED', admission_state:'IDEMPOTENT_REPLAY', pai_task_id:binding.taskId, lifecycle_state:'READY', selected_executor_if_assigned:binding.selectedExecutor, result_ref:`pai_result:${binding.taskId}`, blocker:null, next_automatic:true, tan_decision_required:false };
  }

  getAdapter(providerId) {
    return this.adapters.get(String(providerId || 'ANTIGRAVITY').toUpperCase()) || null;
  }

  async handleCapabilities(input = {}) {
    return discoverEligibleCards(input);
  }

  async handleCognitionRun(input = {}) {
    if (!input.objective || typeof input.objective !== 'string') {
      throw new Error('COGNITION_OBJECTIVE_REQUIRED');
    }
    if (!input.reasoning_type || typeof input.reasoning_type !== 'string') {
      throw new Error('COGNITION_REASONING_TYPE_REQUIRED');
    }
    if (!input.idempotency_key || typeof input.idempotency_key !== 'string') {
      throw new Error('COGNITION_IDEMPOTENCY_KEY_REQUIRED');
    }

    // Check idempotency ledger
    const key = input.idempotency_key.trim();
    const reqDigest = digest(input);
    const existing = this.idempotencyLedger.get(key);
    if (existing) {
      if (existing.request_digest !== reqDigest) {
        throw new Error('COGNITION_IDEMPOTENCY_CONFLICT');
      }
      return existing.result;
    }

    const providerName = (Array.isArray(input.provider_preferences) && input.provider_preferences[0])
      ? input.provider_preferences[0]
      : 'ANTIGRAVITY';

    const adapter = this.getAdapter(providerName);
    if (!adapter) {
      throw new Error(`PROVIDER_NOT_AVAILABLE: ${providerName}`);
    }

    const prepared = await adapter.prepareCognition({
      ...input,
      authority: 'NONE'
    });

    let result;
    try {
      result = await adapter.invokeCognition(prepared);
    } catch (error) {
      try {
        writeCallUsage(observeCall({ input, prepared, adapter, error }), this.options.usageArchiveRoot);
      } catch (_) {
        // Preserve the original provider error and its ambiguous-submit semantics.
      }
      throw error;
    }

    try {
      result.turn_call_usage = writeCallUsage(
        observeCall({ input, prepared, adapter, result }),
        this.options.usageArchiveRoot
      );
    } catch (_) {
      // A returned provider result must never be blindly retried for telemetry.
      result.turn_call_usage = { status: 'DEGRADED_WRITE_FAILED' };
    }

    // Save to ledger
    this.idempotencyLedger.set(key, {
      request_digest: reqDigest,
      result
    });

    return result;
  }

  async handleActionRun(input = {}) {
    if (this.acceptedIdentity && input.userId !== undefined && input.userId !== this.acceptedIdentity.userId) throw Error('BRIDGE_IDENTITY_MISMATCH');
    const rawTerminalOp = String(input.operation || input.action_payload?.operation || '').trim().toUpperCase();
    if (['ADMIN_STATUS','ADMIN_SUBMIT','ADMIN_RESULT'].includes(rawTerminalOp)) {
      if (!this.adminBridgeClient) this.adminBridgeClient = createAdminBridgeClient();
      const adminResult = await this.adminBridgeClient.run({ ...(input.action_payload || input), operation: rawTerminalOp });
      return { contract_type:'ADMIN_ACTION_RECEIPT', transport:'PAI_ADMIN_BRIDGE', request_id:input.request_id || null, ...adminResult };
    }
    const sessionId = input.session_id || input.action_payload?.session_id || null;
    const hasCommand = Boolean(input.command || input.input || (input.action_payload && (input.action_payload.command || input.action_payload.input)));
    const terminalOperation = rawTerminalOp || (sessionId ? (hasCommand ? 'INPUT' : 'STATUS') : '');
    const isTerminalOperation = ['OPEN', 'INPUT', 'RUN', 'READ', 'STATUS', 'SNAPSHOT', 'CLOSE'].includes(terminalOperation);

    const requestId = String(
      input.request_id ||
      input.idempotency_key ||
      (input.action_payload && (input.action_payload.request_id || input.action_payload.idempotency_key)) ||
      `action_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    ).trim();

    const effectClass = String(
      input.effect_class ||
      (input.action_payload && input.action_payload.effect_class) ||
      'CANDIDATE_DRAFT'
    ).trim();

    const objective = String(
      input.objective ||
      input.target ||
      input.command ||
      input.input ||
      (input.action_payload && (input.action_payload.objective || input.action_payload.command || input.action_payload.input || input.action_payload.operation)) ||
      (isTerminalOperation ? `Terminal operation ${terminalOperation}` : 'Governed host technical action')
    ).trim();

    // Synthesize action_payload if top-level terminal properties were provided
    if (!input.action_payload && (terminalOperation || input.command || input.input || sessionId || input.cursor !== undefined)) {
      input.action_payload = {
        operation: terminalOperation || (hasCommand ? 'INPUT' : 'OPEN'),
        session_id: sessionId,
        input: input.input !== undefined ? input.input : input.command,
        command: input.command,
        cursor: input.cursor,
        cwd: input.cwd,
        scope: input.scope,
        max_bytes: input.max_bytes,
        max_lines: input.max_lines,
        tail: input.tail
      };
    }

    const intent = String(input.intent || (isTerminalOperation ? 'TERMINAL_COMMAND' : 'CHANGE')).trim().toUpperCase();
    const scope = String(input.scope || input.mutable_scope || (input.action_payload && (input.action_payload.scope || input.action_payload.mutable_scope)) || 'NONE').trim();
    const requestedMode = String(input.requested_mode || 'candidate-only').trim();
    const sourceRefs = Array.isArray(input.source_refs) ? input.source_refs : [];
    const acceptance = String(input.acceptance || 'PASS_VERIFIED').trim();
    const authorityPolicyRef = typeof input.authority_policy_ref === 'string'
      ? input.authority_policy_ref.trim()
      : (typeof input.action_payload?.authority_policy_ref === 'string' ? input.action_payload.authority_policy_ref.trim() : null);

    let executorConstraint = null;
    let seedConstrained = false;
    const seedCodePresent = input.seed_code !== undefined;
    const seedReceiptPresent = input.seed_receipt !== undefined;
    if (seedCodePresent || seedReceiptPresent) {
      try {
        if (seedCodePresent && (typeof input.seed_code !== 'string' || !input.seed_code.length)) {
          throw new Error('UNTRUSTED_SEED_EXECUTOR_CONSTRAINT');
        }
        const receipt = input.seed_receipt;
        if (seedReceiptPresent && (!receipt || typeof receipt !== 'object' ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(receipt)))) {
          throw new Error('UNTRUSTED_SEED_EXECUTOR_CONSTRAINT');
        }
        const provider = input.selected_provider_tool ?? input.pinned_provider;
        if (input.requested_mode !== 'candidate-only' || input.effect_class !== 'CANDIDATE_DRAFT' ||
            (provider !== undefined && provider !== 'CODEX_HOME')) {
          throw new Error('UNTRUSTED_SEED_EXECUTOR_CONSTRAINT');
        }
        const seedUplink = require('./seed-uplink');
        const seed = seedCodePresent ? seedUplink.decode(input.seed_code) : null;
        const validSeed = input.seed_receipt && input.seed_receipt.schema === seedUplink.SCHEMA &&
          (seedCodePresent ? input.seed_receipt.fingerprint === seedUplink.fingerprint(seed) :
            typeof input.seed_receipt.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(input.seed_receipt.fingerprint)) &&
          input.seed_receipt.transport === 'USER_PASTE_OR_LOCAL_APP_IMPORT' &&
          input.selected_provider_tool === 'CODEX_HOME';
        if (!validSeed) throw new Error('UNTRUSTED_SEED_EXECUTOR_CONSTRAINT');
        executorConstraint = 'CODEX_HOME';
        seedConstrained = true;
      } catch (_) {
        const err = new Error('UNTRUSTED_SEED_EXECUTOR_CONSTRAINT');
        err.code = 'UNTRUSTED_SEED_EXECUTOR_CONSTRAINT';
        throw err;
      }
    }

    // ChatGPT may describe an explicitly selected terminal operation with the
    // generic CHANGE/ACTION_DIRECT vocabulary. The operation itself is the
    // deterministic routing signal; keep its authority inside the governed
    // terminal Class-B ceiling and retain the command deny-list/fence checks.
    const routedIntent = isTerminalOperation ? 'TERMINAL_COMMAND' : intent;
    const routedEffectClass = isTerminalOperation && effectClass === 'ACTION_DIRECT'
      ? 'CANDIDATE_DRAFT'
      : effectClass;

    // 1. Authority & Negative Gating (PUBLICATION, MONEY, CREDENTIALS fail closed without explicit grant)
    try {
      this.router.validateAuthority({
        intent: routedIntent,
        objective,
        scope,
        effect_class: routedEffectClass,
        authority_policy_ref: authorityPolicyRef
      });
    } catch (err) {
      if (err.code && (err.code.startsWith('HOST_CONTROL_') || err.code.startsWith('AUTHORITY_'))) {
        return {
          request_id: requestId,
          chief_state: 'DENIED',
          admission_state: 'HOST_CONTROL_DENIED',
          lifecycle_state: 'COMPLETED',
          status: 'DENIED',
          denial_code: err.code,
          reason: err.message
        };
      }
      throw err;
    }

    // Determine if this is a no-effect operation (used in both host-control and standard paths)
    let isNoEffect = routedEffectClass === 'NO_MATERIAL_DELTA' || routedEffectClass === 'READ_ONLY';

    // 1a. Host Control fast path — deterministic terminal adapter for bounded host operations
    if (HOST_CONTROL_INTENTS.has(routedIntent) && !seedConstrained) {
      const hostResolution = resolveTargetHost(routedIntent, {
        preferredHost: input.target_host || input.action_payload?.target_host || 'HOME'
      });
      if (!hostResolution.resolved) {
        throw new Error(`HOST_CONTROL_NO_HOST: ${hostResolution.reason}`);
      }

      // Check for persistent terminal session operation
      if (isTerminalOperation) {
        const opUpper = terminalOperation;
        const reqDigest = digest({
          requestId,
          intent: routedIntent,
          objective,
          scope,
          effectClass: routedEffectClass,
          op: opUpper,
          actionPayload: input.action_payload || null
        });

        const existing = this.idempotencyLedger.get(requestId);
        if (existing) {
          if (existing.request_digest !== reqDigest) {
            throw new Error('ACTION_IDEMPOTENCY_CONFLICT');
          }
          return { ...existing.result, admission_state: 'IDEMPOTENT_REPLAY' };
        }

        const targetSessionId = input.session_id || input.action_payload?.session_id;
        const activeSession = targetSessionId ? this.sessionRuntime?.sessions?.get(targetSessionId) : null;
        const passedScope = (input.scope || input.mutable_scope || (input.action_payload && (input.action_payload.scope || input.action_payload.mutable_scope))) ? scope : null;
        const effectiveTerminalScope = passedScope || (activeSession?.scope && activeSession.scope !== 'NONE' ? activeSession.scope : null);

        const terminalResult = await this.handleTerminalSession({
          ...input,
          ...(input.action_payload || {}),
          operation: opUpper,
          effect_class: routedEffectClass,
          target_host: input.target_host || input.action_payload?.target_host || 'HOME',
          scope: effectiveTerminalScope
        });

        if (terminalResult && (terminalResult.status === 'BLOCKED' || terminalResult.status === 'DENIED')) {
          const isDenied = terminalResult.status === 'DENIED';
          const structuredDenial = {
            request_id: requestId,
            chief_state: isDenied ? 'DENIED' : 'BLOCKED',
            admission_state: isDenied ? 'HOST_CONTROL_DENIED' : 'BLOCKED',
            lifecycle_state: 'COMPLETED',
            transport: 'PAI_HOST_CONTROL',
            status: terminalResult.status,
            denial_code: terminalResult.denial_code || (isDenied ? 'HOST_CONTROL_SCOPE_DENIED' : 'BLOCKED'),
            reason: terminalResult.reason || terminalResult.blocker,
            blocker: terminalResult.blocker,
            session_id: terminalResult.session_id,
            terminal_session: terminalResult
          };
          this.idempotencyLedger.set(requestId, { request_digest: reqDigest, result: structuredDenial });
          return structuredDenial;
        }

        const terminalAdmissionState = isNoEffect
          ? 'HOST_CONTROL_READ_ONLY'
          : (routedEffectClass === 'CANDIDATE_DRAFT' || routedEffectClass === 'REVERSIBLE_CANDIDATE' || routedEffectClass === 'ACTION_DIRECT' ? 'HOST_CONTROL_CANDIDATE' : 'HOST_CONTROL_GOVERNED');

        const structuredResult = {
          request_id: requestId,
          chief_state: 'ADMITTED',
          admission_state: terminalAdmissionState,
          lifecycle_state: 'COMPLETED',
          transport: 'PAI_HOST_CONTROL',
          ...terminalResult,
          terminal_session: terminalResult
        };

        this.idempotencyLedger.set(requestId, { request_digest: reqDigest, result: structuredResult });
        return structuredResult;
      }

      const reqDigest = digest({ requestId, intent, objective, scope, effectClass });

      // Idempotency check for host-control
      const existingHc = this.idempotencyLedger.get(requestId);
      if (existingHc) {
        if (existingHc.request_digest !== reqDigest) {
          throw new Error('ACTION_IDEMPOTENCY_CONFLICT');
        }
        return { ...existingHc.result, admission_state: 'IDEMPOTENT_REPLAY' };
      }

      // Execute through governed host control adapter
      let receipt;
      try {
        receipt = await this.hostControlAdapter.execute({
          request_id: requestId,
          intent,
          objective,
          command: input.command || (input.action_payload && input.action_payload.command) || objective,
          effect_class: effectClass,
          scope,
          cwd: input.action_payload && input.action_payload.cwd || undefined,
          timeout_seconds: input.timeout_seconds || 30,
          network: input.network || 'DENY',
          target_path: input.action_payload && input.action_payload.target_path || undefined,
          session_id: input.session_id || undefined
        });
      } catch (err) {
        if (err.code && (err.code.startsWith('HOST_CONTROL_') || err.code.startsWith('AUTHORITY_'))) {
          const denialResult = {
            request_id: requestId,
            chief_state: 'DENIED',
            admission_state: 'HOST_CONTROL_DENIED',
            lifecycle_state: 'COMPLETED',
            transport: 'PAI_HOST_CONTROL',
            status: 'DENIED',
            denial_code: err.code,
            reason: err.message,
            receipt: {
              request_id: requestId,
              status: 'DENIED',
              denial_code: err.code,
              error: err.message
            }
          };
          this.idempotencyLedger.set(requestId, { request_digest: reqDigest, result: denialResult });
          return denialResult;
        }
        throw err;
      }

      const rawSeed = `${requestId}:${intent}:HOST_CONTROL:${reqDigest}`;
      const taskId = `HC_${crypto.createHash('sha256').update(rawSeed).digest('hex').slice(0, 24).toUpperCase()}`;

      const hcAdmissionState = isNoEffect
        ? 'HOST_CONTROL_READ_ONLY'
        : (effectClass === 'CANDIDATE_DRAFT' || effectClass === 'REVERSIBLE_CANDIDATE' || effectClass === 'ACTION_DIRECT' ? 'HOST_CONTROL_CANDIDATE' : 'HOST_CONTROL_GOVERNED');

      const structuredResult = {
        request_id: requestId,
        chief_state: 'ADMITTED',
        admission_state: hcAdmissionState,
        pai_task_id: taskId,
        lifecycle_state: receipt.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED',
        selected_executor_if_assigned: 'DETERMINISTIC_HOST',
        host_control_receipt: receipt,
        result_ref: `pai_result:${taskId}`,
        blocker: receipt.status !== 'SUCCESS' ? receipt.stderr_summary : null,
        next_automatic: true,
        tan_decision_required: false,
        transport: 'PAI_HOST_CONTROL',
        rdc_dependency: false
      };

      // Store durable result
      const taskRecord = {
        taskId, mcp_task_id: taskId, runId: requestId,
        status: receipt.status === 'SUCCESS' ? 'completed' : 'failed',
        createdAt: receipt.startedAt, updatedAt: receipt.completedAt,
        payload: input,
        result: { status: receipt.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED', structuredResult, executor: 'DETERMINISTIC_HOST', completedAt: receipt.completedAt }
      };
      this.tasks.set(taskId, taskRecord);
      this.tasks.set(requestId, taskRecord);

      this.idempotencyLedger.set(requestId, { request_digest: reqDigest, result: structuredResult });
      return structuredResult;
    }

    // --- Standard (non-host-control) action path ---

    if (!validMutableScope(scope)) {
      const err = new Error(scope.includes(',') ? 'MULTI_SCOPE_UNSUPPORTED' : 'MUTABLE_SCOPE_INVALID');
      err.code = err.message;
      throw err;
    }

    const reqDigest = digest({
      ...(this.acceptedIdentity ? {boundIdentity:this.acceptedIdentity} : {}),
      requestId,
      intent,
      objective,
      scope,
      effectClass,
      requestedMode,
      sourceRefs,
      acceptance,
      authorityPolicyRef,
      selectedProvider: input.selected_provider_tool || null,
      actionPayload: input.action_payload || null
    });

    // Durable lookup must validate both namespaces even when this process has
    // an admitted-work replay cached from before a second admission existed.
    const persisted = this._readAcceptedAdmission(requestId);
    if (persisted && persisted.requestDigest !== reqDigest) throw new Error('ACTION_IDEMPOTENCY_CONFLICT');
    const existing = this.idempotencyLedger.get(requestId);
    if (existing) {
      if (existing.request_digest !== reqDigest) {
        throw new Error('ACTION_IDEMPOTENCY_CONFLICT');
      }
      if ((persisted && existing.result?.pai_task_id !== persisted.taskId) ||
          (!persisted && this.acceptedReceiptRead && ['ADMITTED_TASKBOX','NO_EFFECT_CANDIDATE'].includes(existing.result?.admission_state))) {
        throw Error('ACCEPTED_ADMISSION_REPLAY_MISMATCH');
      }
      return {
        ...existing.result,
        admission_state: 'IDEMPOTENT_REPLAY'
      };
    }
    if (persisted) {
      // The validated digest binds effectClass too. Preserve the existing warm
      // admission label for no-effect work without synthesizing Claim results.
      return {...this._acceptedAdmissionReplay(persisted),lifecycle_state:isNoEffect ? 'COMPLETED' : 'READY'};
    }

    // 3. Dynamic Router chooses eligible READY executor
    const isSeedProbe = executorConstraint === 'CODEX_HOME' &&
      effectClass === 'CANDIDATE_DRAFT' && requestedMode === 'candidate-only';
    if (isSeedProbe) isNoEffect = true;
    const role = (intent === 'QA' || intent === 'REVIEW') ? 'QA' : 'BUILDER';
    let activeClaimants = null;
    if (Array.isArray(input.active_claimants)) {
      activeClaimants = input.active_claimants;
    } else {
      try {
        const residentPath = 'C:/ProgramData/PAI_SIMPLE_BODY_R1/HOME/config/resident.json';
        if (fs.existsSync(residentPath)) {
          const rc = JSON.parse(fs.readFileSync(residentPath, 'utf8'));
          if (Array.isArray(rc.hostCapabilities)) activeClaimants = rc.hostCapabilities;
        }
      } catch (_) {}
    }

    const selectedExecutor = this.router.selectExecutor({
      requiredCapabilities: input.required_capabilities || (intent === 'QA' ? ['QA'] : ['CODE_ENGINEERING']),
      mutableScope: scope,
      role,
      preferredExecutor: input.selected_provider_tool || null,
      executorConstraint,
      activeClaimants: (this.taskBoxRoot && input.require_active_claimant !== false) ? activeClaimants : null
    });

    // 5. Deterministic TaskBox Task ID
    const rawSeed = `${requestId}:${intent}:${scope}:${reqDigest}`;
    const taskId = this.acceptedIdentity ? this._boundTaskId(reqDigest)
      : `CHIEF_REQUEST_${crypto.createHash('sha256').update(rawSeed).digest('hex').slice(0, 24).toUpperCase()}`;
    // Direct CLI transport is used ONLY when explicitly requested, or as transport fallback when TaskBox is unconfigured/offline.
    // Normal governed work with an active TaskBox root must materialize to TaskBox so Resident claims and executes it.
    const explicitCliRequested = (
      requestedMode === 'DIRECT_CLI_TRANSPORT' ||
      input.bypass_taskbox === true ||
      (input.action_payload && input.action_payload.bypass_taskbox === true) ||
      input.selected_provider_tool === 'ANTIGRAVITY_CLI' ||
      input.selected_provider_tool === 'GROK_CLI'
    );
    const isCliFallback = explicitCliRequested || !this.taskBoxRoot;

    // Resolve the wire contract before claiming a scope or reporting READY.
    const taskBoxCapabilities = this.taskBoxRoot && !isCliFallback && !isSeedProbe
      ? taskBoxWireCapabilitiesForExecutor(selectedExecutor)
      : null;
    if (taskBoxCapabilities && activeClaimants && input.require_active_claimant !== false) {
      this.router.validateClaimantCompatibility(selectedExecutor, activeClaimants);
    }
    let scopeClaim = null;
    if (scope !== 'NONE') {
      scopeClaim = this.router.claimScope(scope, { taskId, requestId });
    }

if (isCliFallback && !isSeedProbe) {
      if (scopeClaim && scope !== 'NONE') {
        this.router.releaseScope(scope);
      }

      const authCheck = this.sessionRuntime ? this.sessionRuntime._checkAuthority() : { available: true };
      const currentFence = (authCheck && authCheck.currentFence) || null;
      const pinnedProvider = (
        input.selected_provider_tool === 'GROK_CLI' ||
        input.selected_provider_tool === 'ANTIGRAVITY_CLI'
      ) ? String(input.selected_provider_tool) : null;

      // PINNED: never substitute another provider.
      if (pinnedProvider && selectedExecutor.id !== pinnedProvider) {
        const structuredResult = {
          request_id: requestId,
          chief_state: 'REJECTED',
          admission_state: 'CLI_PROVIDER_MISMATCH',
          pai_task_id: taskId,
          lifecycle_state: 'FAILED',
          selected_executor_if_assigned: selectedExecutor.id,
          transport: 'DIRECT_CLI_TRANSPORT',
          blocker: {
            code: 'CLI_PROVIDER_MISMATCH',
            detail: `pinned=${pinnedProvider} selected=${selectedExecutor.id}`
          },
          next_automatic: false,
          tan_decision_required: false
        };
        this.idempotencyLedger.set(requestId, { request_digest: reqDigest, result: structuredResult });
        return structuredResult;
      }

      const payload = (input.action_payload && typeof input.action_payload === 'object') ? input.action_payload : {};
      const scratchRoot = path.join(__dirname, '..', 'scratch');
      const mutableForCli = (scope && scope !== 'NONE') ? scope : scratchRoot;
      const expectedArtifactPath = payload.expected_artifact_path
        ? String(payload.expected_artifact_path)
        : (payload.artifact_path ? String(payload.artifact_path) : null);
      const receiptDir = path.join(scratchRoot, '.direct-cli-receipts');
      const cliPath = payload.cli_path_override
        ? String(payload.cli_path_override)
        : (selectedExecutor.cliPath || null);
      const prompt = String(
        payload.cli_prompt ||
        objective ||
        ''
      );

      let cliOutcome;
      try {
        cliOutcome = await runDirectCliTransport({
          executorId: selectedExecutor.id,
          pinned: Boolean(pinnedProvider),
          cliPath,
          cwd: payload.cli_cwd ? String(payload.cli_cwd) : scratchRoot,
          prompt,
          objective,
          timeoutMs: Number(payload.cli_timeout_ms) || 180000,
          receiptDir,
          expectedArtifactPath,
          mutableScope: expectedArtifactPath ? mutableForCli : null,
          args: Array.isArray(payload.cli_args) ? payload.cli_args : null
        });
      } catch (err) {
        cliOutcome = {
          ok: false,
          failure_code: 'CLI_EXECUTION_FAILED',
          detail: err && err.message ? err.message : String(err),
          executor: selectedExecutor.id,
          transport: 'DIRECT_CLI_TRANSPORT',
          synthetic: false,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        };
      }

      let effectiveExecutor = selectedExecutor;
      const failoverHistory = [];
      const isQuotaOrUnavailable = (code) => {
        return /QUOTA|RATE_LIMIT|UNAVAILABLE|AUTH_REQUIRED|MISSING/.test(String(code || ''));
      };

      if (!cliOutcome.ok && isQuotaOrUnavailable(cliOutcome.failure_code)) {
        this.router.markProviderUnavailable(selectedExecutor.id, cliOutcome.failure_code);
      }

      // Governed failover seam: If first provider attempt failed locally and provider is not pinned
      if (!cliOutcome.ok && !pinnedProvider && !seedConstrained && isQuotaOrUnavailable(cliOutcome.failure_code)) {
        failoverHistory.push({
          executor: selectedExecutor.id,
          failure_code: cliOutcome.failure_code,
          detail: cliOutcome.detail,
          attempt: 1,
          timestamp: new Date().toISOString()
        });

        // Determine failover candidate: Antigravity is primary failover for code/builder work
        let failoverCandidate = null;
        if (selectedExecutor.id !== 'ANTIGRAVITY_CLI') {
          const anti = this.router.getExecutor('ANTIGRAVITY_CLI');
          if (anti && anti.state === 'READY' && anti.quotaState !== 'EXHAUSTED' &&
              ['AUTHENTICATED', 'READY'].includes(anti.authState)) {
            const missing = (input.required_capabilities || (intent === 'QA' ? ['QA'] : ['CODE_ENGINEERING']))
              .filter(req => !anti.capabilities.includes(req));
            if (missing.length === 0 && anti.suitableRoles.includes(role)) {
              failoverCandidate = anti;
            }
          }
        }

        // Grok is evaluated ONLY if role is QA/REVIEW (never for BUILDER/REPAIR)
        if (!failoverCandidate && selectedExecutor.id !== 'GROK_CLI' && (role === 'QA' || role === 'REVIEW')) {
          const grok = this.router.getExecutor('GROK_CLI');
          const required = input.required_capabilities || (intent === 'QA' ? ['QA'] : ['CODE_ENGINEERING']);
          if (grok && grok.state === 'READY' && grok.quotaState !== 'EXHAUSTED' &&
              ['AUTHENTICATED', 'READY'].includes(grok.authState) &&
              required.every(cap => grok.capabilities.includes(cap)) && grok.suitableRoles.includes(role)) {
            failoverCandidate = grok;
          }
        }

        if (failoverCandidate) {
          try {
            const failoverCliPath = (payload && payload.failover_cli_path_override)
              ? String(payload.failover_cli_path_override)
              : failoverCandidate.cliPath;
            const failoverOutcome = await runDirectCliTransport({
              executorId: failoverCandidate.id,
              pinned: false,
              cliPath: failoverCliPath,
              cwd: payload.cli_cwd ? String(payload.cli_cwd) : scratchRoot,
              prompt,
              objective,
              timeoutMs: Number(payload.cli_timeout_ms) || 180000,
              receiptDir,
              expectedArtifactPath,
              mutableScope: expectedArtifactPath ? mutableForCli : null,
              args: Array.isArray(payload.failover_cli_args) ? payload.failover_cli_args : null
            });
            effectiveExecutor = failoverCandidate;
            cliOutcome = failoverOutcome;
            if (!cliOutcome.ok && isQuotaOrUnavailable(cliOutcome.failure_code)) {
              this.router.markProviderUnavailable(failoverCandidate.id, cliOutcome.failure_code);
            }
          } catch (err) {
            failoverHistory.push({
              executor: failoverCandidate.id,
              failure_code: 'FAILOVER_EXECUTION_FAILED',
              detail: err.message,
              attempt: 2,
              timestamp: new Date().toISOString()
            });
          }
        }
      }

      const lifecycle = cliOutcome.ok ? 'COMPLETED' : 'FAILED';
      const admission = cliOutcome.ok ? 'ADMITTED_CLI_TRANSPORT' : 'CLI_PROVIDER_FAILED';
      const cliReceipt = {
        taskId,
        requestId,
        transport: 'DIRECT_CLI_TRANSPORT',
        executor: effectiveExecutor.id,
        original_executor: selectedExecutor.id !== effectiveExecutor.id ? selectedExecutor.id : undefined,
        failover_history: failoverHistory.length > 0 ? failoverHistory : null,
        intent,
        objective,
        scope,
        effect_class: effectClass,
        status: lifecycle,
        fence_ref: currentFence,
        failure_code: cliOutcome.failure_code || null,
        provider: {
          cliPath: cliOutcome.cliPath || (effectiveExecutor.cliPath || cliPath),
          pid: cliOutcome.pid || null,
          exit_code: cliOutcome.exit_code,
          startedAt: cliOutcome.startedAt,
          completedAt: cliOutcome.completedAt,
          stdout_ref: cliOutcome.stdout_ref || null,
          stderr_ref: cliOutcome.stderr_ref || null,
          artifact_path: cliOutcome.artifact_path || expectedArtifactPath,
          artifact_sha256: cliOutcome.artifact_sha256 || null,
          provider_version: cliOutcome.provider_version || null,
          synthetic: false
        },
        handoff: {
          status: cliOutcome.ok ? 'HANDOFF_READY' : 'HANDOFF_FAILED',
          executor: effectiveExecutor.id,
          reconciled: Boolean(cliOutcome.ok),
          evidence_ref: `pai_result:${taskId}`
        },
        startedAt: cliOutcome.startedAt,
        completedAt: cliOutcome.completedAt
      };

      const structuredResult = {
        request_id: requestId,
        chief_state: cliOutcome.ok ? 'ADMITTED' : 'FAILED',
        admission_state: admission,
        pai_task_id: taskId,
        lifecycle_state: lifecycle,
        selected_executor_if_assigned: effectiveExecutor.id,
        original_executor: selectedExecutor.id !== effectiveExecutor.id ? selectedExecutor.id : undefined,
        failover_history: failoverHistory.length > 0 ? failoverHistory : null,
        transport: 'DIRECT_CLI_TRANSPORT',
        cli_receipt: cliReceipt,
        result_ref: `pai_result:${taskId}`,
        blocker: cliOutcome.ok ? null : {
          code: cliOutcome.failure_code || 'CLI_EXECUTION_FAILED',
          detail: cliOutcome.detail || null
        },
        next_automatic: false,
        tan_decision_required: false,
        taskbox_materialized: false
      };

      const taskRecord = {
        taskId,
        mcp_task_id: taskId,
        runId: requestId,
        status: cliOutcome.ok ? 'completed' : 'failed',
        createdAt: cliReceipt.startedAt,
        updatedAt: cliReceipt.completedAt,
        payload: input,
        result: {
          status: lifecycle,
          structuredResult,
          executor: effectiveExecutor.id,
          completedAt: cliReceipt.completedAt,
          cliOutcome
        }
      };
      this.tasks.set(taskId, taskRecord);
      this.tasks.set(requestId, taskRecord);

      this.idempotencyLedger.set(requestId, { request_digest: reqDigest, result: structuredResult });
      return structuredResult;
    }

    // 6. Materialize TaskBox Item if taskBoxRoot is configured
    let materialized = false;
    let acceptedAdmission = null;
    if (this.taskBoxRoot && !isSeedProbe) {
      try {
        const itemsDir = path.join(this.taskBoxRoot, 'items');
        fs.mkdirSync(itemsDir, { recursive: true });
        const taskFile = path.join(itemsDir, `${taskId}.md`);
        const body = [
          `Objective: ${objective}`,
          `Intent: ${intent}`,
          `Mode: ${requestedMode}`,
          `Acceptance: ${acceptance}`
        ].join('\n') + '\n';
        const bytes = serializeDispatch({ taskId, mutableScope: scope,
          requiredCapabilities: taskBoxCapabilities, body });
        const parsedDispatch = require('./chief-delegation-admission').parseTaskBoxWire(bytes, 'DISPATCH');
        acceptedAdmission = { taskId, requestId, selectedExecutor:selectedExecutor.id, dispatchRef:`items/${taskId}.md`, dispatchSha256:crypto.createHash('sha256').update(bytes).digest('hex'), mutableScope:parsedDispatch.fields.MUTABLE_SCOPE, rootId:parsedDispatch.fields.ROOT_ID, parentId:parsedDispatch.fields.PARENT_ID||null, dispatchType:parsedDispatch.fields.TYPE };
        const recovering=this._prepareAcceptedMaterialization(acceptedAdmission,reqDigest);
        if(recovering&&!fs.existsSync(taskFile)&&fs.existsSync(path.join(this.taskBoxRoot,'archive',acceptedAdmission.dispatchRef)))throw Error('ACCEPTED_MATERIALIZATION_ARCHIVED_ORPHAN');
        try { fs.writeFileSync(taskFile, bytes, { flag:'wx' }); }
        catch(error) {
          if(error.code!=='EEXIST'||!recovering)throw error;
          const root=path.resolve(this.taskBoxRoot),realRoot=fs.realpathSync(root);
          const stat=fs.statSync(taskFile);
          if(fs.lstatSync(root).isSymbolicLink()||fs.lstatSync(itemsDir).isSymbolicLink()||fs.lstatSync(taskFile).isSymbolicLink()||!stat.isFile()||stat.size!==bytes.length||!fs.realpathSync(taskFile).startsWith(realRoot+path.sep)||!fs.readFileSync(taskFile).equals(bytes))throw Error('ACCEPTED_MATERIALIZATION_ORPHAN_MISMATCH');
        }
        // Publish neither success nor volatile replay until the admission
        // receipt commits. A failed commit retains intent and exact file bytes.
        this._persistAcceptedAdmission(acceptedAdmission, reqDigest);
        materialized = true;
      } catch (error) {
        if (scope !== 'NONE') this.router.releaseScope(scope);
        const err = new Error(`TASKBOX_MATERIALIZATION_FAILED: ${error.message}`);
        err.code = 'TASKBOX_MATERIALIZATION_FAILED';
        throw err;
      }
    }

    // Release scope lock for no-material-delta / read-only / direct action tasks immediately
    if ((isNoEffect || effectClass === 'ACTION_DIRECT') && scope !== 'NONE') {
      this.router.releaseScope(scope);
    }

    const admissionState = isNoEffect ? 'NO_EFFECT_CANDIDATE' : (materialized ? 'ADMITTED_TASKBOX' : 'ADMITTED');
    const lifecycleState = isNoEffect ? 'COMPLETED' : 'READY';

    const structuredResult = {
      request_id: requestId,
      chief_state: 'ADMITTED',
      admission_state: admissionState,
      pai_task_id: taskId,
      lifecycle_state: lifecycleState,
      selected_executor_if_assigned: selectedExecutor.id,
      result_ref: `pai_result:${taskId}`,
      blocker: null,
      next_automatic: true,
      tan_decision_required: false
    };

    // Store in tasks map for pai_run_status and pai_result readback
    const taskRecord = {
      taskId,
      mcp_task_id: taskId,
      runId: requestId,
      status: lifecycleState.toLowerCase(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: input,
      result: {
        status: lifecycleState,
        structuredResult,
        executor: selectedExecutor.id,
        completedAt: new Date().toISOString()
      }
    };
    this.tasks.set(taskId, taskRecord);
    this.tasks.set(requestId, taskRecord);

    // Save to idempotency ledger
    this.idempotencyLedger.set(requestId, {
      request_digest: reqDigest,
      result: structuredResult
    });

    return structuredResult;
  }

  // --- MCP Tasks Extension Handlers ---
  createMcpTask(runId, type, initialPayload) {
    const taskId = `mcp-task-${crypto.randomBytes(8).toString('hex')}`;
    const taskRecord = {
      taskId,
      mcp_task_id: taskId,
      runId,
      type,
      status: 'working',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: initialPayload,
      result: null
    };
    this.tasks.set(taskId, taskRecord);
    return taskRecord;
  }

  getMcpTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  cancelMcpTask(taskId, reason = 'CLIENT_REQUESTED_CANCELLATION') {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = 'cancelled';
    task.updatedAt = new Date().toISOString();
    task.cancelReason = reason;
    return task;
  }

  completeMcpTask(taskId, result) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = 'completed';
    task.updatedAt = new Date().toISOString();
    task.result = result;
    return task;
  }

  // --- Persistent PowerShell Terminal Session Handler ---
  async handleTerminalSession(input = {}) {
    const op = String(input.operation || 'STATUS').toUpperCase();
    if (op === 'RUN') {
      const exe = String(input.executable || '');
      const args = input.arguments;
      if (!['node','python','codex','git'].includes(exe) || !Array.isArray(args) || args.length > 40 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw Error('TERMINAL_RUN_SCHEMA_DENIED');
      const quote = value => "'" + value.replace(/'/g,"''") + "'";
      const marker = 'PAI_NATIVE_RESULT_' + crypto.randomBytes(16).toString('hex');
      const stdin = exe === 'codex' ? '$null | ' : '';
      const script = `$global:LASTEXITCODE=0; try { ${stdin}& ${quote(exe)} ${args.map(quote).join(' ')}; $nativeOk=$?; $nativeExit=$LASTEXITCODE; Write-Output ('${marker}'+(@{exitCode=$nativeExit;success=$nativeOk}|ConvertTo-Json -Compress)) } catch { Write-Output ('${marker}'+(@{exitCode=-1;success=$false}|ConvertTo-Json -Compress)) }`;
      const response = await this.handleTerminalSession({ ...input, operation:'INPUT', input:script });
      if (response.status !== 'SUCCESS') return { ...response, execution_status:'UNVERIFIED' };
      const output = this.sessionRuntime.readSession({ session_id:input.session_id, tail:true, max_bytes:8192, max_lines:100 });
      const found = output.text.match(new RegExp(marker+'(\\{[^\\r\\n]+\\})'));
      if (!found) return { ...response, execution_status:'UNVERIFIED' };
      const result = JSON.parse(found[1]);
      return { ...response, execution_status:result.success && result.exitCode===0?'PASS':'FAIL', exit_code:result.exitCode, executable:exe, execution_note:'One native command executed inside the existing contained unelevated session.' };
    }

    if (op === 'OPEN') {
      const rawScope = input.scope || input.mutable_scope || null;
      let effectiveScope = rawScope;
      let effectiveCwd = input.cwd || (input.action_payload && input.action_payload.cwd) || null;

      if (!effectiveScope || effectiveScope === 'NONE') {
        const wsId = `candidate_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const wsRoot = path.join(os.tmpdir(), 'pai_candidate_workspaces', wsId);
        const scratchDir = path.join(wsRoot, 'scratch');
        try { fs.mkdirSync(scratchDir, { recursive: true }); } catch (_) {}
        effectiveScope = scratchDir;
        if (!effectiveCwd) effectiveCwd = scratchDir;
      } else {
        effectiveScope = path.resolve(effectiveScope);
        if (!effectiveCwd) effectiveCwd = effectiveScope;
        try { fs.mkdirSync(effectiveCwd, { recursive: true }); } catch (_) {}
      }

      return await this.sessionRuntime.openSession({
        owner_host: input.target_host || input.host || 'HOME',
        work_context: input.work_context || effectiveScope || 'DEFAULT_WORK_CONTEXT',
        scope: effectiveScope,
        fence_ref: input.fence_ref || (input.action_payload && input.action_payload.fence_ref) || null,
        effect_class: input.effect_class || 'CANDIDATE_DRAFT',
        cwd: effectiveCwd,
        env: input.env,
        timeoutMs: input.timeout_ms || (input.timeout_seconds ? input.timeout_seconds * 1000 : 30000)
      });
    }

    if (op === 'INPUT') {
      const sessionId = input.session_id;
      const script = input.input !== undefined ? input.input : (input.command !== undefined ? input.command : input.objective);
      const activeSession = this.sessionRuntime?.sessions?.get(sessionId);
      const effectiveInputScope = input.scope || input.mutable_scope || (activeSession ? activeSession.scope : null);
      try {
        return await this.sessionRuntime.inputSession({
          session_id: sessionId,
          input: script,
          timeout_ms: input.timeout_ms || (input.timeout_seconds ? input.timeout_seconds * 1000 : 30000),
          fence_ref: input.fence_ref || (input.action_payload && input.action_payload.fence_ref) || null,
          effect_class: input.effect_class || null,
          owner_host: input.target_host || input.host || null,
          work_context: input.work_context || null,
          scope: effectiveInputScope
        });
      } catch (err) {
        const msg = String(err.message || err);
        const isAuthDenied = msg.includes('OPERATION_NOT_AUTHORIZED') ||
          msg.includes('HOST_CONTROL_') ||
          err.code?.startsWith('HOST_CONTROL_') ||
          err.code === 'OPERATION_NOT_AUTHORIZED';
        if (isAuthDenied) {
          const code = err.code || err.denial_code || (
            msg.includes('HOST_CONTROL_SCOPE_DENIED') ? 'HOST_CONTROL_SCOPE_DENIED' :
            msg.includes('HOST_CONTROL_DENIED') ? 'HOST_CONTROL_DENIED' :
            msg.includes('HOST_CONTROL_CONSEQUENTIAL_GATE') ? 'HOST_CONTROL_CONSEQUENTIAL_GATE' :
            msg.includes('HOST_CONTROL_NOT_ALLOWED') ? 'HOST_CONTROL_NOT_ALLOWED' :
            'HOST_CONTROL_DENIED'
          );
          const session = this.sessionRuntime.sessions?.get(sessionId);
          if (session && session.state === 'RUNNING') {
            session.state = 'IDLE';
          }
          return {
            session_id: sessionId,
            host: input.target_host || input.host || 'HOME',
            terminal_mode: 'POWERSHELL_PERSISTENT_PIPE_V0',
            state: session ? session.state : 'IDLE',
            cursor: session ? (session.spooler?.admitted_bytes || 0) : 0,
            nextCursor: session ? (session.spooler?.admitted_bytes || 0) : 0,
            output_ref: session ? session.spooler?.output_ref : null,
            pid: session ? session.rootPid : null,
            fence_ref: session ? session.fenceRef : null,
            status: 'DENIED',
            denial_code: code,
            reason: msg
          };
        }
        throw err;
      }
    }

    if (op === 'READ') {
      return this.sessionRuntime.readSession({
        session_id: input.session_id,
        cursor: input.cursor !== undefined ? input.cursor : 0,
        max_bytes: input.max_bytes || 4096,
        max_lines: input.max_lines !== undefined ? input.max_lines : 40,
        tail: input.tail === true
      });
    }

    if (op === 'STATUS') {
      return this.sessionRuntime.statusSession({ session_id: input.session_id });
    }

    if (op === 'SNAPSHOT') {
      return this.sessionRuntime.snapshotSession({ session_id: input.session_id });
    }

    if (op === 'CLOSE') {
      return this.sessionRuntime.closeSession({ session_id: input.session_id });
    }

    throw new Error(`TERMINAL_OPERATION_UNKNOWN: ${op}`);
  }
}

module.exports = {
  FederationCore
};
