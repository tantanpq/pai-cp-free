'use strict';

const VERSION = 'health-compact/v1';
const allowed = new Set(['status', 'sampledAt', 'revision', 'fenceRef', 'checks', 'counts', 'stalenessMs', 'fullRef', 'errorCode']);

function compactHealth(full, options = {}) {
  if (!full || typeof full !== 'object' || Array.isArray(full)) throw new Error('HEALTH_FULL_INVALID');
  if (typeof full.status !== 'string' || !full.status) throw new Error('HEALTH_STATUS_REQUIRED');
  const maxChecks = Number.isSafeInteger(options.maxChecks) ? options.maxChecks : 8;
  if (maxChecks < 0 || maxChecks > 32) throw new Error('HEALTH_COMPACT_OPTIONS_INVALID');
  const checks = Array.isArray(full.checks)
    ? full.checks.slice(0, maxChecks).map(check => ({ name: String(check.name), status: String(check.status) }))
    : [];
  const allCounts = full.counts && typeof full.counts === 'object' ? Object.entries(full.counts) : [];
  const counts = Object.fromEntries(allCounts.slice(0, 8).map(([name, value]) => [String(name).slice(0, 64), Number(value)]));
  const out = {
    schema: VERSION,
    status: full.status,
    sampledAt: full.sampledAt || null,
    revision: full.revision ?? null,
    fenceRef: full.fenceRef ?? null,
    checks,
    counts,
    stalenessMs: Number.isFinite(full.stalenessMs) ? full.stalenessMs : null,
    omittedCount: Math.max(0, Object.keys(full).filter(key => !allowed.has(key)).length + Math.max(0, (full.checks?.length || 0) - checks.length) + Math.max(0, allCounts.length - 8)),
    fullRef: full.fullRef || null,
    errorCode: full.errorCode || null
  };
  return Object.freeze(out);
}

module.exports = { VERSION, compactHealth };
