'use strict';

class ResourceBudget {
  constructor({ maxDiskBytes = 1024 * 1024 * 1024, maxProcessCount = 128, maxOutputBytesPerSecond = 16 * 1024 * 1024, maxRuntimeMs = null } = {}) {
    for (const [name, value] of Object.entries({ maxDiskBytes, maxProcessCount, maxOutputBytesPerSecond })) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`RESOURCE_${name.toUpperCase()}_INVALID`);
    }
    if (maxRuntimeMs != null && (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs <= 0)) throw new Error('RESOURCE_MAX_RUNTIME_INVALID');
    this.config = { maxDiskBytes, maxProcessCount, maxOutputBytesPerSecond, maxRuntimeMs };
    this.window = [];
    this.totalObservedOutputBytes = 0;
  }

  observeOutput(bytes, atMs = Date.now()) {
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('RESOURCE_OUTPUT_BYTES_INVALID');
    this.totalObservedOutputBytes += bytes;
    this.window.push({ atMs, bytes });
    this.#prune(atMs);
    return this.outputRate(atMs);
  }

  #prune(nowMs) {
    const cutoff = nowMs - 1000;
    while (this.window.length && this.window[0].atMs < cutoff) this.window.shift();
  }

  outputRate(nowMs = Date.now()) {
    this.#prune(nowMs);
    return this.window.reduce((sum, item) => sum + item.bytes, 0);
  }

  evaluate({ diskBytes = 0, processCount = 0, runtimeMs = 0, hostStabilityThreatened = false, nowMs = Date.now() } = {}) {
    const signals = [];
    const outputRate = this.outputRate(nowMs);
    if (diskBytes > this.config.maxDiskBytes) signals.push({ code:'DISK_BUDGET_PRESSURE', action:'ROTATE_COMPRESS_OR_ARCHIVE_SPOOL' });
    if (processCount > this.config.maxProcessCount) signals.push({ code:'PROCESS_COUNT_PRESSURE', action:'RECONCILE_OWNED_PROCESS_TREE' });
    if (outputRate > this.config.maxOutputBytesPerSecond) signals.push({ code:'OUTPUT_RATE_PRESSURE', action:'REDUCE_MODEL_VISIBLE_SAMPLING_KEEP_SPOOLING' });
    if (this.config.maxRuntimeMs != null && runtimeMs > this.config.maxRuntimeMs) signals.push({ code:'RUNTIME_RESOURCE_EXPIRY', action:'RESOURCE_REAPER_EVALUATION' });
    if (hostStabilityThreatened) signals.push({ code:'HOST_STABILITY_THREAT', action:'POLICY_GATED_FORCE_REAP_MAY_BE_REQUIRED' });
    return {
      level: hostStabilityThreatened ? 'HOST_STABILITY_THREAT' : (signals.length ? 'PRESSURE' : 'OK'),
      signals,
      outputBytesPerSecond: outputRate,
      shouldForceTerminate: Boolean(hostStabilityThreatened),
      semanticTaskFailure: false
    };
  }

  snapshot(nowMs = Date.now()) { return { config:{...this.config}, totalObservedOutputBytes:this.totalObservedOutputBytes, outputBytesPerSecond:this.outputRate(nowMs) }; }
}

module.exports = { ResourceBudget };
