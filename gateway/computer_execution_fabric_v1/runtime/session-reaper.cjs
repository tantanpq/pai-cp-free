'use strict';

class SessionReaper {
  constructor({ runtime, registry, nowMs = () => Date.now() } = {}) {
    if (!runtime || !registry) throw new Error('REAPER_DEPENDENCY_REQUIRED');
    this.runtime = runtime;
    this.registry = registry;
    this.nowMs = nowMs;
  }

  async sweep() {
    const now = this.nowMs();
    const actions = [];
    for (const meta of this.registry.list()) {
      if (['CLOSED'].includes(meta.state)) continue;
      const created = Date.parse(meta.openedAt);
      const last = Date.parse(meta.lastActivityAt || meta.openedAt);
      const age = Number.isFinite(created) ? now - created : 0;
      const idle = Number.isFinite(last) ? now - last : 0;
      let reason = null;
      if (meta.sessionClass === 'EPHEMERAL' && meta.idleTimeoutMs != null && idle >= meta.idleTimeoutMs) reason = 'EPHEMERAL_IDLE_EXPIRED';
      if (meta.sessionClass === 'PERSISTENT' && meta.idleTimeoutMs != null && idle >= meta.idleTimeoutMs) reason = 'PERSISTENT_IDLE_EXPIRED';
      if (meta.maxRuntimeMs != null && age >= meta.maxRuntimeMs) reason = 'RESOURCE_MAX_RUNTIME_EXPIRED';
      if (meta.sessionClass === 'PINNED' && meta.expiresAt && now >= Date.parse(meta.expiresAt)) reason = 'PIN_EXPIRED';
      if (meta.sessionClass === 'PINNED' && !meta.expiresAt) reason = null;
      if (meta.state === 'ORPHANED') {
        const result = await this.runtime.recoverOrReap(meta.sessionId, { canReattach: false, reason: 'ORPHAN_REAPER_NO_REATTACH_BINDING' });
        actions.push({ sessionId: meta.sessionId, action: 'RECOVER_OR_REAP', result });
        continue;
      }
      if (reason && this.runtime.hasLive(meta.sessionId)) {
        const result = await this.runtime.close(meta.sessionId, { systemCleanup: true, reason });
        actions.push({ sessionId: meta.sessionId, action: 'CLOSE', reason, result });
      } else if (reason) {
        actions.push({ sessionId: meta.sessionId, action: 'NEEDS_OWNER_RECONCILIATION', reason });
      }
    }
    return actions;
  }
}

module.exports = { SessionReaper };
