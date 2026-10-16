'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { ByteRingBuffer } = require('./ring-buffer.cjs');
const { OutputSpooler, createOutputSpooler } = require('./output-spooler.cjs');
const { SessionRegistry, hash } = require('./session-registry.cjs');
const {
  ProcessTreeManager,
  terminateSessionTree,
  captureProcessOwnership,
  verifyProcessOwnership,
  pidAlive
} = require('./process-tree-manager.cjs');
const { ReceiptWriter } = require('./receipt-writer.cjs');
const { ResourceBudget } = require('./resource-budget.cjs');
const { ActorTranscript } = require('../human/actor-transcript.cjs');
const { TakeoverController } = require('../human/takeover-controller.cjs');
const { SecretInputChannel } = require('../human/secret-input-channel.cjs');
const { createPowerShellPipeAdapter, TERMINAL_MODE } = require('./powershell-adapter.cjs');

const STATES = new Set([
  'OPEN', 'ACTIVE', 'WAITING_INPUT', 'RUNNING', 'IDLE',
  'CLOSING', 'EXITED', 'ORPHANED', 'RECOVERING', 'REAPING', 'CLOSED', 'LOST'
]);
const CLASSES = new Set(['EPHEMERAL', 'PERSISTENT', 'PINNED']);
const DEFAULT_SPOOL_DIR = path.join(os.tmpdir(), 'pai_terminal_spools');

const safeText = (value, code, max = 1024) => {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\u0000-\u001f]/.test(text)) throw new Error(code);
  return text;
};

const AUTHORITY_RANK = Object.freeze({
  A: 1,
  B: 2,
  C: 3,
  D: 4
});

function defaultClassifyEffect(effectClass) {
  const ec = String(effectClass || '').toUpperCase();
  if (ec === 'NO_MATERIAL_DELTA' || ec === 'READ_ONLY') return 'A';
  if (ec === 'CANDIDATE_DRAFT') return 'B';
  if (ec === 'REVERSIBLE_LOCAL_EFFECT') return 'C';
  return 'D';
}

class SessionRuntime {
  constructor(options = {}) {
    this.options = options;
    this.now = options.now || (() => new Date().toISOString());

    if (options.rootDir) {
      if (typeof options.adapterFactory !== 'function' ||
          typeof options.fenceValidator !== 'function' ||
          typeof options.operationAuthorizer !== 'function') {
        throw new Error('SESSION_RUNTIME_CONFIG_INVALID');
      }
      this.rootDir = options.rootDir;
      this.sessionsDir = path.join(options.rootDir, 'sessions');
      fs.mkdirSync(this.sessionsDir, { recursive: true });
      this.registry = options.registry || new SessionRegistry(options.rootDir);
      this.adapterFactory = options.adapterFactory;
      this.fenceValidator = options.fenceValidator;
      this.operationAuthorizer = options.operationAuthorizer;
      this.processTreeFactory = options.processTreeFactory || (() => new ProcessTreeManager());
      this.orphanReaper = options.orphanReaper || null;
      this.live = new Map();
    }

    if (options.authorityReader) {
      if (typeof options.authorityReader !== 'function') {
        throw new Error('SESSION_AUTHORITY_READER_REQUIRED');
      }
      if (!options.fenceValidator || typeof options.fenceValidator !== 'function') {
        throw new Error('SESSION_FENCE_VALIDATOR_REQUIRED');
      }
      if (!options.operationAuthorizer || typeof options.operationAuthorizer !== 'function') {
        throw new Error('SESSION_OPERATION_AUTHORIZER_REQUIRED');
      }
      this.sessions = new Map();
      this.spoolDir = options.spoolDir || DEFAULT_SPOOL_DIR;
      this.authorityReader = options.authorityReader;
      this.fenceValidator = options.fenceValidator;
      this.operationAuthorizer = options.operationAuthorizer;
      this.authorityClassifier = typeof options.authorityClassifier === 'function' ? options.authorityClassifier : null;
    }

    if (!options.rootDir && !options.authorityReader) {
      if (options.adapterFactory) {
        throw new Error('SESSION_RUNTIME_CONFIG_INVALID');
      }
      throw new Error('SESSION_AUTHORITY_READER_REQUIRED');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REFERENCE SPEC INTERFACE (open, input, read, snapshot, close, etc.)
  // ═══════════════════════════════════════════════════════════════════════════

  hasLive(sessionId) {
    return this.live ? this.live.has(sessionId) : false;
  }

  async open(spec) {
    if (!this.registry) throw new Error('REFERENCE_MODE_NOT_CONFIGURED');
    const normalized = this.#normalizeOpenSpec(spec);
    const openSpecHash = hash(normalized);
    if (normalized.openIdempotencyKey) {
      const prior = this.registry.findByOpenKey(normalized.openIdempotencyKey);
      if (prior) {
        if (prior.openSpecHash !== openSpecHash) throw new Error('SESSION_OPEN_IDEMPOTENCY_CONFLICT');
        return { status: 'DEDUPLICATED', session: this.#public(prior) };
      }
    }
    const sessionId = `ses-${crypto.randomUUID()}`;
    const storageDir = path.join(this.sessionsDir, sessionId);
    const workspaceDir = path.join(storageDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const openedAt = this.now();
    let metadata = {
      version: 'pai-session/r1',
      sessionId,
      requestId: normalized.requestId,
      rootId: normalized.rootId,
      ownerHost: normalized.ownerHost,
      ownerExecutor: normalized.ownerExecutor,
      fenceTokenHash: crypto.createHash('sha256').update(normalized.fenceToken).digest('hex'),
      claimId: normalized.claimId,
      shellClass: normalized.shellClass,
      cwd: normalized.cwd,
      allowedRoots: normalized.allowedRoots,
      effectClass: normalized.effectClass,
      networkPolicy: normalized.networkPolicy,
      sessionClass: normalized.sessionClass,
      state: 'OPEN',
      openedAt,
      lastActivityAt: openedAt,
      idleTimeoutMs: normalized.idleTimeoutMs,
      maxRuntimeMs: normalized.maxRuntimeMs,
      expiresAt: normalized.expiresAt,
      maxRamBytes: normalized.maxRamBytes,
      maxInputBytes: normalized.maxInputBytes,
      cleanupPolicy: normalized.cleanupPolicy,
      resourceBudget: normalized.resourceBudget,
      storageDir,
      workspaceDir,
      openIdempotencyKey: normalized.openIdempotencyKey,
      openSpecHash,
      cleanupState: 'OWNED',
      exitCode: null,
      exitSignal: null
    };
    metadata = this.registry.save(metadata);
    const ring = new ByteRingBuffer(normalized.maxRamBytes);
    const spooler = new OutputSpooler({ rootDir: this.sessionsDir, sessionId, now: this.now });
    const transcript = new ActorTranscript({ rootDir: this.sessionsDir, sessionId, now: this.now });
    const takeover = new TakeoverController({ transcript });
    const secretChannel = new SecretInputChannel({ transcript, now: this.now });
    const processTree = this.processTreeFactory({ metadata });
    const receipts = new ReceiptWriter({ rootDir: this.sessionsDir, sessionId, now: this.now });
    const resourceBudget = new ResourceBudget(normalized.resourceBudget);
    const adapter = await this.adapterFactory({ ...normalized, sessionId, workspaceDir });
    if (!adapter || typeof adapter.start !== 'function' || typeof adapter.write !== 'function' || typeof adapter.close !== 'function') {
      throw new Error('SESSION_ADAPTER_INVALID');
    }
    const context = { metadata, normalized, ring, spooler, transcript, takeover, secretChannel, processTree, receipts, resourceBudget, adapter, closing: false, secretRedactions: [] };
    this.live.set(sessionId, context);
    this.#bindAdapter(context);
    try {
      await adapter.start();
      const adapterStatus = typeof adapter.status === 'function' ? adapter.status() : {};
      if (Number.isInteger(adapterStatus.pid) && adapterStatus.pid > 0) {
        processTree.register({ pid: adapterStatus.pid, label: 'SESSION_ROOT_PROCESS' });
      }
      context.metadata = this.registry.save({ ...context.metadata, state: 'ACTIVE', adapter: adapterStatus, lastActivityAt: this.now() });
      transcript.append({ actor: 'SYSTEM', type: 'session_opened', meta: { ownerHost: normalized.ownerHost, shellClass: normalized.shellClass, sessionClass: normalized.sessionClass } });
      const receipt = receipts.write({ operation: 'SESSION_OPEN', requestId: normalized.requestId, commandStatus: 'OPENED', semanticStatus: 'UNRESOLVED', host: normalized.ownerHost, effectClass: normalized.effectClass, cleanupState: context.metadata.cleanupState });
      return { status: 'OPENED', session: this.#public(context.metadata), receiptRef: receipt.receiptPath };
    } catch (error) {
      this.live.delete(sessionId);
      this.registry.save({ ...context.metadata, state: 'CLOSED', cleanupState: 'OPEN_FAILED', closeReason: String(error.message || error), lastActivityAt: this.now() });
      throw error;
    }
  }

  async input(sessionId, { text, actor = 'AGENT', fenceToken, operationId = null } = {}) {
    const ctx = this.#live(sessionId);
    await this.#assertFence(ctx, fenceToken);
    if (!ctx.takeover.canWrite(actor)) throw new Error('SESSION_ACTOR_NOT_IN_CONTROL');
    if (!['ACTIVE', 'WAITING_INPUT', 'RUNNING', 'IDLE'].includes(ctx.metadata.state)) throw new Error('SESSION_NOT_WRITABLE');
    const buffer = Buffer.isBuffer(text) ? text : Buffer.from(String(text ?? ''), 'utf8');
    await this.#assertOperationAuthorized(ctx, { type: 'SESSION_INPUT', actor: String(actor).toUpperCase(), text: buffer.toString('utf8') });
    if (!buffer.length || buffer.length > ctx.metadata.maxInputBytes) throw new Error('SESSION_INPUT_SIZE_INVALID');
    ctx.transcript.append({ actor: String(actor).toUpperCase(), type: 'input', text: buffer.toString('utf8'), meta: { operationId } });
    ctx.metadata = this.registry.save({ ...ctx.metadata, state: 'RUNNING', lastActivityAt: this.now() });
    await ctx.adapter.write(buffer);
    const receipt = ctx.receipts.write({ operation: 'SESSION_INPUT', operationId, commandStatus: 'SENT', semanticStatus: 'UNRESOLVED', host: ctx.metadata.ownerHost, effectClass: ctx.metadata.effectClass, bytes: buffer.length });
    return { status: 'SENT', bytes: buffer.length, state: ctx.metadata.state, receiptRef: receipt.receiptPath };
  }

  read(sessionId, { cursor = null, maxBytes = 8192, tailBytes = null } = {}) {
    const ctx = this.live?.get(sessionId);
    if (ctx) {
      const view = tailBytes != null ? ctx.ring.tail(tailBytes) : ctx.ring.read(cursor == null ? ctx.ring.startCursor : cursor, maxBytes);
      const spool = ctx.spooler.snapshot();
      return {
        sessionId,
        state: ctx.metadata.state,
        output: view.data.toString('utf8'),
        requestedCursor: view.requestedCursor,
        retainedStartCursor: view.retainedStartCursor,
        nextCursor: view.nextCursor,
        endCursor: view.endCursor,
        truncated: view.truncated,
        hasMore: view.hasMore,
        outputBytes: spool.combinedBytes,
        outputRef: spool.outputRef
      };
    }
    const meta = this.registry?.get(sessionId);
    if (!meta) throw new Error('SESSION_NOT_FOUND');
    const spooler = new OutputSpooler({ rootDir: this.sessionsDir, sessionId, now: this.now });
    const spool = spooler.snapshot();
    const start = tailBytes != null ? Math.max(0, spool.combinedBytes - tailBytes) : (cursor == null ? 0 : cursor);
    const disk = spooler.readCombined(start, tailBytes != null ? tailBytes : maxBytes);
    return {
      sessionId,
      state: meta.state,
      output: disk.data.toString('utf8'),
      requestedCursor: start,
      retainedStartCursor: 0,
      nextCursor: disk.next,
      endCursor: disk.end,
      truncated: false,
      hasMore: disk.hasMore,
      outputBytes: spool.combinedBytes,
      outputRef: spool.outputRef
    };
  }

  readOutputRef(sessionId, { start = 0, maxBytes = 65536 } = {}) {
    const ctx = this.live?.get(sessionId);
    if (ctx) return ctx.spooler.readCombined(start, maxBytes);
    if (!this.registry?.get(sessionId)) throw new Error('SESSION_NOT_FOUND');
    return new OutputSpooler({ rootDir: this.sessionsDir, sessionId, now: this.now }).readCombined(start, maxBytes);
  }

  async snapshot(sessionId) {
    const ctx = this.#live(sessionId);
    const adapterSnapshot = typeof ctx.adapter.snapshot === 'function' ? await ctx.adapter.snapshot() : (typeof ctx.adapter.status === 'function' ? ctx.adapter.status() : {});
    const safeSnapshot = {
      cwd: adapterSnapshot?.cwd || ctx.metadata.cwd,
      shellClass: ctx.metadata.shellClass,
      adapterState: adapterSnapshot?.closed ? 'CLOSED' : (adapterSnapshot?.started ? 'STARTED' : 'UNKNOWN'),
      implementation: adapterSnapshot?.implementation || null,
      stateFidelity: adapterSnapshot?.stateFidelity || null,
      replCounter: Number.isInteger(adapterSnapshot?.replCounter) ? adapterSnapshot.replCounter : null,
      envKeys: Array.isArray(adapterSnapshot?.envKeys) ? adapterSnapshot.envKeys : []
    };
    ctx.metadata = this.registry.save({ ...ctx.metadata, cwd: safeSnapshot.cwd, semanticSnapshot: safeSnapshot, lastActivityAt: this.now() });
    const receipt = ctx.receipts.write({ operation: 'SESSION_SNAPSHOT', commandStatus: 'SNAPSHOTTED', semanticStatus: 'UNRESOLVED', host: ctx.metadata.ownerHost, effectClass: ctx.metadata.effectClass, snapshot: safeSnapshot });
    return { sessionId, state: ctx.metadata.state, snapshot: safeSnapshot, receiptRef: receipt.receiptPath };
  }

  getReceipt(sessionId, receiptId) {
    if (!this.registry?.get(sessionId)) throw new Error('SESSION_NOT_FOUND');
    return new ReceiptWriter({ rootDir: this.sessionsDir, sessionId, now: this.now }).get(receiptId);
  }

  status(sessionId) {
    const ctx = this.live?.get(sessionId);
    const meta = ctx?.metadata || this.registry?.get(sessionId);
    if (!meta) throw new Error('SESSION_NOT_FOUND');
    return {
      ...this.#public(meta),
      ring: ctx?.ring.snapshot() || null,
      processTree: ctx?.processTree.snapshot() || null,
      takeover: ctx?.takeover.snapshot() || null,
      spool: ctx?.spooler.snapshot() || null,
      resourceBudget: ctx?.resourceBudget.snapshot() || null,
      resourcePressure: meta.resourcePressure || null
    };
  }

  async resize(sessionId, { cols, rows, fenceToken } = {}) {
    const ctx = this.#live(sessionId);
    await this.#assertFence(ctx, fenceToken);
    await this.#assertOperationAuthorized(ctx, { type: 'SESSION_RESIZE', cols, rows });
    if (!Number.isInteger(cols) || cols < 20 || cols > 1000 || !Number.isInteger(rows) || rows < 5 || rows > 500) throw new Error('SESSION_SIZE_INVALID');
    const result = await ctx.adapter.resize(cols, rows);
    ctx.metadata = this.registry.save({ ...ctx.metadata, lastActivityAt: this.now(), size: { cols, rows } });
    return { status: 'RESIZED', ...result };
  }

  requestTakeover(sessionId, input = {}) { return this.#live(sessionId).takeover.request(input); }
  grantTakeover(sessionId) { return this.#live(sessionId).takeover.grant(); }
  releaseTakeover(sessionId) { return this.#live(sessionId).takeover.release(); }
  resumeAgent(sessionId) { return this.#live(sessionId).takeover.resumeAgent(); }

  requestSecret(sessionId, input = {}) {
    const ctx = this.#live(sessionId);
    if (ctx.takeover.state !== 'HUMAN_CONTROL') throw new Error('SECRET_INPUT_REQUIRES_HUMAN_CONTROL');
    return ctx.secretChannel.request({ sessionId, ...input });
  }

  async submitSecret(sessionId, { token, secret, fenceToken } = {}) {
    const ctx = this.#live(sessionId);
    await this.#assertFence(ctx, fenceToken);
    if (ctx.takeover.state !== 'HUMAN_CONTROL') throw new Error('SECRET_INPUT_REQUIRES_HUMAN_CONTROL');
    const secretBytes = Buffer.isBuffer(secret) ? secret.length : Buffer.byteLength(String(secret ?? ''), 'utf8');
    await this.#assertOperationAuthorized(ctx, { type: 'SECRET_INPUT', actor: 'TAN', bytes: secretBytes });
    return ctx.secretChannel.submit({
      token, secret, writer: async data => {
        const shadow = Buffer.from(data);
        ctx.secretRedactions.push({ buffer: shadow, expiresAt: Date.now() + 10000 });
        const timer = setTimeout(() => { shadow.fill(0); ctx.secretRedactions = ctx.secretRedactions.filter(item => item.buffer !== shadow); }, 10000);
        timer.unref?.();
        return ctx.adapter.write(data);
      }
    });
  }

  async close(sessionId, { fenceToken = null, force = false, forceEffectAdmitted = false, systemCleanup = false, reason = 'EXPLICIT_CLOSE' } = {}) {
    const meta = this.registry?.get(sessionId);
    if (!meta) throw new Error('SESSION_NOT_FOUND');
    if (meta.state === 'CLOSED') return { status: 'CLOSED', idempotent: true, session: this.#public(meta) };
    const ctx = this.live?.get(sessionId);
    if (!ctx) return { status: 'OWNER_RECONCILIATION_REQUIRED', idempotent: false, session: this.#public(meta) };
    if (!systemCleanup) await this.#assertFence(ctx, fenceToken);
    if (force && !forceEffectAdmitted) throw new Error('FORCE_TERMINATE_EFFECT_NOT_ADMITTED');
    if (ctx.closing) return { status: 'CLOSING', idempotent: true, session: this.#public(ctx.metadata) };
    ctx.closing = true;
    ctx.metadata = this.registry.save({ ...ctx.metadata, state: 'CLOSING', closeReason: reason, lastActivityAt: this.now() });
    let adapterClose = null;
    try { adapterClose = await ctx.adapter.close({ force }); } catch (error) { adapterClose = { closed: false, error: String(error.message || error) }; }
    const processCleanup = await ctx.processTree.cleanup({ reason });
    if (ctx.metadata.cleanupPolicy?.deleteWorkspaceOnClose !== false) fs.rmSync(ctx.metadata.workspaceDir, { recursive: true, force: true });
    const cleanupVerified = processCleanup.every(item => item.status === 'TERMINATED' && item.verifiedDead !== false);
    const cleanupState = cleanupVerified ? 'CLOSED_AND_FLUSHED' : 'CLOSED_CLEANUP_UNVERIFIED';
    for (const item of ctx.secretRedactions || []) item.buffer.fill(0);
    ctx.secretRedactions = [];
    ctx.transcript.append({ actor: 'SYSTEM', type: 'session_closed', meta: { reason, force, processCleanup, cleanupState } });
    ctx.metadata = this.registry.save({ ...ctx.metadata, state: 'CLOSED', closedAt: this.now(), lastActivityAt: this.now(), cleanupState, adapterClose, processCleanup });
    const receipt = ctx.receipts.write({ operation: 'SESSION_CLOSE', commandStatus: 'CLOSED', semanticStatus: 'UNRESOLVED', host: ctx.metadata.ownerHost, effectClass: ctx.metadata.effectClass, cleanupState: ctx.metadata.cleanupState, reason, force, processCleanup });
    this.live.delete(sessionId);
    return { status: 'CLOSED', idempotent: false, session: this.#public(ctx.metadata), receiptRef: receipt.receiptPath };
  }

  async recoverOrReap(sessionId, { canReattach = false, reattachFactory = null, reason = 'RECOVERY' } = {}) {
    let meta = this.registry.get(sessionId);
    if (!meta) throw new Error('SESSION_NOT_FOUND');
    if (meta.state === 'CLOSED') return { status: 'CLOSED', idempotent: true };
    meta = this.registry.save({ ...meta, state: 'RECOVERING', recoveryStartedAt: this.now(), lastActivityAt: this.now() });
    if (canReattach && typeof reattachFactory === 'function') {
      const adapter = await reattachFactory(meta);
      if (adapter) return { status: 'REATTACH_BINDER_REQUIRED', adapterPresent: true, session: this.#public(meta) };
    }
    meta = this.registry.save({ ...meta, state: 'REAPING', recoveryReason: reason, lastActivityAt: this.now() });
    if (typeof this.orphanReaper !== 'function') {
      meta = this.registry.save({ ...meta, state: 'LOST', cleanupState: 'BINDER_ORPHAN_REAPER_REQUIRED', lastActivityAt: this.now() });
      return { status: 'LOST', blocker: 'BINDER_ORPHAN_REAPER_REQUIRED', session: this.#public(meta) };
    }
    const reap = await this.orphanReaper(meta);
    if (!reap || reap.verifiedClosed !== true) {
      meta = this.registry.save({ ...meta, state: 'LOST', cleanupState: 'ORPHAN_REAP_UNVERIFIED', orphanReap: reap || null, lastActivityAt: this.now() });
      return { status: 'LOST', blocker: 'ORPHAN_REAP_UNVERIFIED', session: this.#public(meta) };
    }
    if (meta.cleanupPolicy?.deleteWorkspaceOnClose !== false && meta.workspaceDir) fs.rmSync(meta.workspaceDir, { recursive: true, force: true });
    meta = this.registry.save({ ...meta, state: 'CLOSED', cleanupState: 'REAPED_AND_VERIFIED', orphanReap: reap, closedAt: this.now(), lastActivityAt: this.now() });
    return { status: 'REAPED', session: this.#public(meta) };
  }

  #bindAdapter(ctx) {
    ctx.adapter.on?.('data', event => {
      try {
        const stream = event?.stream === 'stderr' ? 'stderr' : 'stdout';
        const raw = Buffer.isBuffer(event?.data) ? event.data : Buffer.from(String(event?.data ?? ''), 'utf8');
        const data = this.#redactSecretEcho(ctx, raw);
        ctx.ring.append(data);
        ctx.spooler.append(stream, data);
        ctx.transcript.append({ actor: 'PTY', type: stream, text: data.toString('utf8') });
        ctx.resourceBudget.observeOutput(data.length);
        const runtimeMs = Math.max(0, Date.now() - Date.parse(ctx.metadata.openedAt));
        const pressure = ctx.resourceBudget.evaluate({ diskBytes: ctx.spooler.combinedBytes, processCount: ctx.processTree.owned().length, runtimeMs });
        ctx.metadata = this.registry.save({ ...ctx.metadata, lastActivityAt: this.now(), outputBytes: ctx.spooler.combinedBytes, resourcePressure: pressure });
      } catch (error) {
        try { ctx.transcript.append({ actor: 'SYSTEM', type: 'output_capture_error', meta: { error: String(error.message || error) } }); } catch {}
      }
    });
    ctx.adapter.on?.('state', event => {
      const state = String(event?.state || '').toUpperCase();
      if (!STATES.has(state) || ['CLOSED', 'ORPHANED', 'RECOVERING', 'REAPING', 'LOST'].includes(state)) return;
      ctx.metadata = this.registry.save({ ...ctx.metadata, state, lastActivityAt: this.now() });
      ctx.transcript.append({ actor: 'SYSTEM', type: 'adapter_state', meta: { state } });
    });
    ctx.adapter.on?.('exit', event => {
      if (ctx.closing) return;
      ctx.metadata = this.registry.save({ ...ctx.metadata, state: 'EXITED', exitCode: event?.code ?? null, exitSignal: event?.signal ?? null, exitedAt: this.now(), lastActivityAt: this.now() });
      ctx.transcript.append({ actor: 'SYSTEM', type: 'process_exit', meta: { code: event?.code ?? null, signal: event?.signal ?? null } });
    });
    ctx.adapter.on?.('error', error => {
      ctx.transcript.append({ actor: 'SYSTEM', type: 'adapter_error', meta: { error: String(error.message || error) } });
    });
  }

  #redactSecretEcho(ctx, raw) {
    const now = Date.now();
    const active = [];
    let output = Buffer.from(raw);
    for (const item of ctx.secretRedactions || []) {
      if (item.expiresAt < now) { item.buffer.fill(0); continue; }
      active.push(item);
      if (!item.buffer.length) continue;
      let index = output.indexOf(item.buffer);
      while (index >= 0) {
        output = Buffer.concat([output.subarray(0, index), Buffer.from('[REDACTED_SECRET_ECHO]', 'utf8'), output.subarray(index + item.buffer.length)]);
        index = output.indexOf(item.buffer, index + 1);
      }
    }
    ctx.secretRedactions = active;
    return output;
  }

  async #assertOperationAuthorized(ctx, operation) {
    const decision = await this.operationAuthorizer({ session: this.#public(ctx.metadata), metadata: ctx.metadata, operation });
    if (decision === true || decision?.allowed === true) return decision;
    throw new Error(decision?.code || 'SESSION_OPERATION_NOT_AUTHORIZED');
  }

  async #assertFence(ctx, suppliedFenceToken) {
    const token = safeText(suppliedFenceToken, 'SESSION_FENCE_REQUIRED', 512);
    const suppliedHash = crypto.createHash('sha256').update(token).digest('hex');
    if (suppliedHash !== ctx.metadata.fenceTokenHash) throw new Error('SESSION_FENCE_MISMATCH');
    if (!(await this.fenceValidator(ctx.metadata, token))) throw new Error('SESSION_FENCE_STALE');
  }

  #live(sessionId) {
    const ctx = this.live?.get(sessionId);
    if (!ctx) throw new Error('SESSION_NOT_LIVE');
    return ctx;
  }

  #normalizeOpenSpec(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('SESSION_OPEN_SPEC_INVALID');
    const sessionClass = String(spec.sessionClass || 'PERSISTENT').toUpperCase();
    if (!CLASSES.has(sessionClass)) throw new Error('SESSION_CLASS_INVALID');
    const maxRamBytes = Number(spec.maxRamBytes || 256 * 1024);
    const maxInputBytes = Number(spec.maxInputBytes || 64 * 1024);
    if (!Number.isInteger(maxRamBytes) || maxRamBytes < 4096 || maxRamBytes > 8 * 1024 * 1024) throw new Error('SESSION_RAM_BUDGET_INVALID');
    if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 1024 * 1024) throw new Error('SESSION_INPUT_BUDGET_INVALID');
    const allowedRoots = Array.isArray(spec.allowedRoots) && spec.allowedRoots.length ? spec.allowedRoots.map(value => safeText(value, 'SESSION_ALLOWED_ROOT_INVALID', 1024)) : [safeText(spec.cwd, 'SESSION_CWD_INVALID', 1024)];
    return {
      requestId: safeText(spec.requestId, 'SESSION_REQUEST_ID_INVALID', 160),
      rootId: safeText(spec.rootId, 'SESSION_ROOT_ID_INVALID', 160),
      ownerHost: safeText(spec.ownerHost, 'SESSION_OWNER_HOST_INVALID', 160),
      ownerExecutor: safeText(spec.ownerExecutor || 'PAI_HOST_CONTROL', 'SESSION_OWNER_EXECUTOR_INVALID', 160),
      claimId: safeText(spec.claimId, 'SESSION_CLAIM_ID_INVALID', 256),
      fenceToken: safeText(spec.fenceToken, 'SESSION_FENCE_REQUIRED', 512),
      shellClass: safeText(spec.shellClass || 'POWERSHELL', 'SESSION_SHELL_INVALID', 96).toUpperCase(),
      cwd: safeText(spec.cwd, 'SESSION_CWD_INVALID', 1024),
      allowedRoots,
      effectClass: safeText(spec.effectClass, 'SESSION_EFFECT_CLASS_INVALID', 128),
      networkPolicy: safeText(spec.networkPolicy || 'INHERIT_ADMISSION', 'SESSION_NETWORK_POLICY_INVALID', 128),
      sessionClass,
      idleTimeoutMs: spec.idleTimeoutMs == null ? (sessionClass === 'PERSISTENT' ? 30 * 60 * 1000 : 5 * 60 * 1000) : Number(spec.idleTimeoutMs),
      maxRuntimeMs: spec.maxRuntimeMs == null ? null : Number(spec.maxRuntimeMs),
      expiresAt: spec.expiresAt || null,
      maxRamBytes,
      maxInputBytes,
      cleanupPolicy: { deleteWorkspaceOnClose: true, ...(spec.cleanupPolicy || {}) },
      resourceBudget: {
        maxDiskBytes: Number(spec.resourceBudget?.maxDiskBytes || 1024 * 1024 * 1024),
        maxProcessCount: Number(spec.resourceBudget?.maxProcessCount || 128),
        maxOutputBytesPerSecond: Number(spec.resourceBudget?.maxOutputBytesPerSecond || 16 * 1024 * 1024),
        maxRuntimeMs: spec.maxRuntimeMs == null ? null : Number(spec.maxRuntimeMs)
      },
      openIdempotencyKey: spec.openIdempotencyKey ? safeText(spec.openIdempotencyKey, 'SESSION_OPEN_KEY_INVALID', 256) : null,
      env: spec.env && typeof spec.env === 'object' ? { ...spec.env } : {}
    };
  }

  #public(meta) {
    return {
      sessionId: meta.sessionId,
      requestId: meta.requestId,
      rootId: meta.rootId,
      ownerHost: meta.ownerHost,
      ownerExecutor: meta.ownerExecutor,
      claimId: meta.claimId,
      shellClass: meta.shellClass,
      cwd: meta.cwd,
      effectClass: meta.effectClass,
      networkPolicy: meta.networkPolicy,
      allowedRoots: meta.allowedRoots,
      sessionClass: meta.sessionClass,
      state: meta.state,
      openedAt: meta.openedAt,
      lastActivityAt: meta.lastActivityAt,
      cleanupState: meta.cleanupState,
      exitCode: meta.exitCode,
      exitSignal: meta.exitSignal
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BRIDGE INTERFACE (openSession, inputSession, readSession, statusSession, etc.)
  // ═══════════════════════════════════════════════════════════════════════════

  _checkAuthority() {
    if (!this.authorityReader) return { available: true, currentFence: 'LOCAL_AUTHORITY' };
    try {
      const auth = this.authorityReader();
      if (!auth || auth.status !== 'AVAILABLE' || auth.available === false || auth.statusCode === 503) {
        return {
          available: false,
          status: 'BLOCKED',
          blocker: 'CURRENT_FENCE_OR_AUTHORITY_READBACK_UNAVAILABLE'
        };
      }
      const currentFence = auth.fenceRef || auth.bundleHash || auth.authority?.fenceRef || auth.projectionHash;
      if (!currentFence || typeof currentFence !== 'string') {
        return {
          available: false,
          status: 'BLOCKED',
          blocker: 'CURRENT_FENCE_OR_AUTHORITY_READBACK_UNAVAILABLE'
        };
      }
      return { available: true, auth, currentFence };
    } catch (_) {
      return {
        available: false,
        status: 'BLOCKED',
        blocker: 'CURRENT_FENCE_OR_AUTHORITY_READBACK_UNAVAILABLE'
      };
    }
  }

  async openSession({
    owner_host = 'HOME',
    work_context = 'DEFAULT_WORK_CONTEXT',
    scope = 'NONE',
    fence_ref = null,
    effect_class = 'CANDIDATE_DRAFT',
    cwd = process.cwd(),
    env = {},
    timeoutMs = 30000
  } = {}) {
    const authCheck = this._checkAuthority();
    if (!authCheck.available) {
      return {
        status: 'BLOCKED',
        blocker: authCheck.blocker
      };
    }

    const currentAuthorityFence = authCheck.currentFence;
    const sessionFence = fence_ref || currentAuthorityFence;

    if (fence_ref && !this.fenceValidator(fence_ref, currentAuthorityFence)) {
      throw new Error('STALE_FENCE_INCOMING');
    }

    const hostUpper = String(owner_host || 'HOME').toUpperCase();
    if (hostUpper !== 'HOME') {
      throw new Error(`UNSUPPORTED_HOST: Terminal V0 supports HOME only, requested: ${hostUpper}`);
    }

    const adapter = createPowerShellPipeAdapter({ timeoutMs });
    const startInfo = adapter.start({ cwd, env, scope });

    const sessionId = `pts_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const spoolDir = this.spoolDir || DEFAULT_SPOOL_DIR;
    fs.mkdirSync(spoolDir, { recursive: true });
    const spoolPath = path.join(spoolDir, `${sessionId}.spool`);

    const spooler = createOutputSpooler({
      spoolPath,
      sessionId
    });

    adapter.onData((stream, chunk) => {
      spooler.append(chunk);
    });

    const processOwnership = captureProcessOwnership(startInfo.pid, sessionId);
    const authClass = defaultClassifyEffect(effect_class);

    const session = {
      sessionId,
      ownerHost: hostUpper,
      workContext: work_context,
      scope,
      fenceRef: sessionFence,
      effectClass: effect_class,
      authorityClass: authClass,
      terminalMode: startInfo.terminal_mode,
      rootPid: startInfo.pid,
      processOwnership,
      adapter,
      spooler,
      state: 'IDLE',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    };

    if (!this.sessions) this.sessions = new Map();
    this.sessions.set(sessionId, session);

    return {
      session_id: sessionId,
      host: session.ownerHost,
      terminal_mode: session.terminalMode,
      state: session.state,
      cursor: 0,
      output_ref: spooler.output_ref,
      pid: session.rootPid,
      fence_ref: sessionFence
    };
  }

  async inputSession({
    session_id,
    input,
    timeout_ms = null,
    fence_ref = null,
    effect_class = null,
    owner_host = null,
    host = null,
    work_context = null,
    scope = null
  } = {}) {
    if (!session_id || typeof session_id !== 'string') {
      throw new Error('SESSION_ID_REQUIRED');
    }

    if (!this.sessions) this.sessions = new Map();
    const session = this.sessions.get(session_id);
    if (!session) {
      throw new Error(`SESSION_NOT_FOUND: ${session_id}`);
    }

    if (session.state === 'CLOSED' || session.state === 'CLOSING') {
      throw new Error(`SESSION_CLOSED: Cannot send input to ${session.state} session`);
    }

    const incomingHost = owner_host || host;
    if (incomingHost && String(incomingHost).toUpperCase() !== session.ownerHost) {
      throw new Error(`HOST_MISMATCH: Session host is ${session.ownerHost}, received ${incomingHost}`);
    }
    if (session.ownerHost !== 'HOME') {
      throw new Error('HOST_MISMATCH: Session host is no longer HOME');
    }

    if (work_context && work_context !== session.workContext) {
      throw new Error(`WORK_CONTEXT_MISMATCH: Session work context is immutable (${session.workContext})`);
    }

    if (scope && scope !== session.scope) {
      throw new Error(`SCOPE_MISMATCH: Session scope is immutable (${session.scope})`);
    }

    const authCheck = this._checkAuthority();
    if (!authCheck.available) {
      return {
        status: 'BLOCKED',
        blocker: authCheck.blocker
      };
    }

    const currentAuthorityFence = authCheck.currentFence;

    if (!this.fenceValidator(session.fenceRef, currentAuthorityFence)) {
      throw new Error('STALE_FENCE_CURRENT_AUTHORITY_CHANGED');
    }

    if (fence_ref) {
      if (!this.fenceValidator(fence_ref, session.fenceRef) || !this.fenceValidator(fence_ref, currentAuthorityFence)) {
        throw new Error('STALE_FENCE: Incoming fence does not match active session fence');
      }
    }

    const requestedEffectClass = effect_class || session.effectClass;
    const requestedAuthClass = this.authorityClassifier
      ? this.authorityClassifier(requestedEffectClass, input)
      : defaultClassifyEffect(requestedEffectClass);

    if (requestedAuthClass === 'D') {
      throw new Error('HOST_CONTROL_CONSEQUENTIAL_GATE: Consequential operations forbidden in terminal session');
    }

    const sessionRank = AUTHORITY_RANK[session.authorityClass] || 4;
    const requestedRank = AUTHORITY_RANK[requestedAuthClass] || 4;

    if (requestedRank > sessionRank) {
      throw new Error('SESSION_EFFECT_CEILING_EXCEEDED');
    }

    const authResult = this.operationAuthorizer(input, requestedEffectClass, session);
    if (authResult && !authResult.authorized) {
      throw new Error(`OPERATION_NOT_AUTHORIZED: ${authResult.reason || 'DENIED'}`);
    }

    session.state = 'RUNNING';
    session.lastActivity = new Date().toISOString();

    const cursorBefore = session.spooler.admitted_bytes;
    const budgetMs = Number(timeout_ms) || session.adapter.timeoutMs || 30000;

    const blockResult = await session.adapter.runBlock(input, budgetMs);

    session.state = 'IDLE';
    session.lastActivity = new Date().toISOString();

    return {
      session_id: session.sessionId,
      host: session.ownerHost,
      terminal_mode: session.terminalMode,
      state: session.state,
      cursor: cursorBefore,
      nextCursor: session.spooler.admitted_bytes,
      output_ref: session.spooler.output_ref,
      pid: session.rootPid,
      fence_ref: session.fenceRef,
      status: blockResult.status,
      transport_status: blockResult.status,
      execution_status: 'NOT_ASSERTED',
      execution_note: 'INPUT completion proves terminal transport only; inspect command output and native exit codes.',
      timeout: blockResult.timeout || false
    };
  }

  readSession({
    session_id,
    cursor = 0,
    max_bytes = 4096,
    max_lines = 80,
    tail = false
  } = {}) {
    if (!session_id || typeof session_id !== 'string') {
      throw new Error('SESSION_ID_REQUIRED');
    }
    if (!this.sessions) this.sessions = new Map();
    const session = this.sessions.get(session_id);
    if (!session) {
      throw new Error(`SESSION_NOT_FOUND: ${session_id}`);
    }

    session.lastActivity = new Date().toISOString();

    const readRes = session.spooler.read({
      cursor: Number(cursor) || 0,
      maxBytes: Number(max_bytes) || 4096,
      maxLines: Number(max_lines) || 80,
      tail: tail === true
    });

    return {
      session_id: session.sessionId,
      output_ref: session.spooler.output_ref,
      cursor: readRes.cursor,
      nextCursor: readRes.nextCursor,
      bytes: readRes.bytes,
      text: readRes.text,
      truncated: readRes.truncated
    };
  }

  statusSession({ session_id } = {}) {
    if (!session_id || typeof session_id !== 'string') {
      throw new Error('SESSION_ID_REQUIRED');
    }
    if (!this.sessions) this.sessions = new Map();
    const session = this.sessions.get(session_id);
    if (!session) {
      throw new Error(`SESSION_NOT_FOUND: ${session_id}`);
    }

    return {
      session_id: session.sessionId,
      host: session.ownerHost,
      terminal_mode: session.terminalMode,
      state: session.state,
      pid: session.rootPid,
      fence_ref: session.fenceRef,
      admitted_bytes: session.spooler.admitted_bytes,
      output_ref: session.spooler.output_ref,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity
    };
  }

  snapshotSession({ session_id } = {}) {
    if (!session_id || typeof session_id !== 'string') {
      throw new Error('SESSION_ID_REQUIRED');
    }
    if (!this.sessions) this.sessions = new Map();
    const session = this.sessions.get(session_id);
    if (!session) {
      throw new Error(`SESSION_NOT_FOUND: ${session_id}`);
    }

    const tailRes = session.spooler.read({
      tail: true,
      maxLines: 50,
      maxBytes: 4096
    });

    return {
      session_id: session.sessionId,
      state: session.state,
      pid: session.rootPid,
      fence_ref: session.fenceRef,
      tail_text: tailRes.text,
      tail_cursor: tailRes.cursor,
      tail_nextCursor: tailRes.nextCursor,
      total_bytes: session.spooler.admitted_bytes,
      output_ref: session.spooler.output_ref
    };
  }

  closeSession({ session_id } = {}) {
    if (!session_id || typeof session_id !== 'string') {
      throw new Error('SESSION_ID_REQUIRED');
    }
    if (!this.sessions) this.sessions = new Map();
    const session = this.sessions.get(session_id);
    if (!session) {
      throw new Error(`SESSION_NOT_FOUND: ${session_id}`);
    }

    if (session.state === 'CLOSED') {
      return {
        session_id: session.sessionId,
        state: 'CLOSED',
        idempotent: true,
        closedAt: session.closedAt,
        cleanup: {
          mechanism: session.cleanupMechanism || 'TASKKILL_TREE_V0',
          verified: session.cleanupVerified !== undefined ? session.cleanupVerified : true,
          rootPid: session.rootPid
        }
      };
    }

    session.state = 'CLOSING';
    session.adapter.stop();

    const cleanup = terminateSessionTree(session.rootPid, {
      expectedOwnership: session.processOwnership,
      waitMs: 1500
    });

    session.state = 'CLOSED';
    session.closedAt = new Date().toISOString();
    session.cleanupMechanism = cleanup.mechanism;
    session.cleanupVerified = cleanup.verified;

    return {
      session_id: session.sessionId,
      state: 'CLOSED',
      closedAt: session.closedAt,
      cleanup: {
        mechanism: cleanup.mechanism,
        verified: cleanup.verified,
        rootPid: session.rootPid
      }
    };
  }
}

module.exports = {
  SessionRuntime,
  STATES,
  CLASSES,
  DEFAULT_SPOOL_DIR,
  AUTHORITY_RANK,
  defaultClassifyEffect
};
