'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TERMINAL = new Set(['RESULT_VERIFIED', 'COMPLETE', 'COMPLETED', 'PASS']);
const RUNNING = new Set(['RUNNING', 'CLAIMED']);
const QCHECK_SCHEMA = 'pai-current-system-quick-check/v2-simple-body';
const DEFAULT_QCHECK_FRESHNESS_MS = 5 * 60 * 1000;
const stable = value => Array.isArray(value)
  ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');

function degraded(reason) {
  return {
    scope: 'PROJECT / PAI',
    status: 'DEGRADED',
    available: false,
    degradedReason: reason,
    lifecycleStage: 'UNKNOWN',
    completionEvidenceVerified: false,
    runningEvidenceVerified: false,
    evidence: []
  };
}
function validateProjection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('CHIEF_CANONICAL_TRUTH_INVALID');
  }
  const required = ['scope', 'goal', 'acceptedState', 'lifecycleStage', 'evidence', 'nextAction'];
  if (required.some(key => input[key] === undefined || input[key] === null || input[key] === '')) {
    throw new Error('CHIEF_CANONICAL_TRUTH_REQUIRED_FIELD_MISSING');
  }
  if (!['PROJECT / PAI', 'COMBINED / PAI PROJECT-FIRST'].includes(input.scope)) {
    throw new Error('CHIEF_CANONICAL_TRUTH_SCOPE_INVALID');
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    throw new Error('CHIEF_CANONICAL_TRUTH_EVIDENCE_REQUIRED');
  }
  const stage = String(input.lifecycleStage).toUpperCase();
  if (RUNNING.has(stage) && input.runningEvidenceVerified !== true) {
    throw new Error('CHIEF_CANONICAL_TRUTH_FALSE_RUNNING');
  }
  if (TERMINAL.has(stage) && input.completionEvidenceVerified !== true) {
    throw new Error('CHIEF_CANONICAL_TRUTH_FALSE_COMPLETE');
  }
  return JSON.parse(JSON.stringify({ ...input, lifecycleStage: stage }));
}

function qcheckDegraded(reason) {
  return degraded(`CHIEF_QCHECK_${reason}`);
}

function qcheckOperationalCutover(qcheck) {
  return qcheck?.authority?.operationalCutover === true || qcheck?.operationalCutover === true || qcheck?.simpleBody?.operationalCutover === true;
}

function readQcheck(qcheckPath, freshnessMs) {
  try {
    const raw = fs.readFileSync(qcheckPath, 'utf8').replace(/^\uFEFF/, '');
    const qcheck = JSON.parse(raw);
    const atMs = Date.parse(qcheck?.at);
    const ageMs = Date.now() - atMs;
    if (!qcheck || typeof qcheck !== 'object' || Array.isArray(qcheck)) throw new Error('INVALID');
    if (qcheck.schema !== QCHECK_SCHEMA) throw new Error('SCHEMA_INVALID');
    if (qcheck.status !== 'PASS') throw new Error('STATUS_NOT_PASS');
    if (!Number.isFinite(atMs) || ageMs < 0 || ageMs > freshnessMs) throw new Error('STALE_OR_INVALID_AT');
    if (!qcheckOperationalCutover(qcheck)) throw new Error('OPERATIONAL_CUTOVER_REQUIRED');
    const projection = qcheck.operationalSimpleBodyProjection
      || qcheck.simpleBody?.lifecycleSnapshot?.projection;
    const runningClaims = projection?.runningClaims;
    const staleRunning = projection?.staleRunning;
    if (!Number.isInteger(runningClaims) || runningClaims < 0 || !Number.isInteger(staleRunning) || staleRunning < 0) {
      throw new Error('LIFECYCLE_PROJECTION_INVALID');
    }
    if (runningClaims > 0 && staleRunning > 0) throw new Error('STALE_RUNNING_CLAIM');
    const running = runningClaims > 0 && staleRunning === 0;
    return {
      scope: 'PROJECT / PAI',
      sourceType: 'JIT_QCHECK_READ_ONLY',
      status: 'VERIFIED',
      available: true,
      lastVerifiedAt: qcheck.at,
      authority: qcheck.authority,
      lifecycleStage: running ? 'RUNNING' : 'OBSERVED_NO_RUNNING_CLAIM',
      runningEvidenceVerified: running,
      completionEvidenceVerified: false,
      evidence: [{
        kind: 'QCHECK_FACTS', schema: qcheck.schema, status: qcheck.status,
        at: qcheck.at, operationalCutover: true, runningClaims, staleRunning
      }]
    };
  } catch (error) {
    return qcheckDegraded(`READ_FAILED:${String(error.message || error)}`);
  }
}

function createCanonicalTruthAdapter({ projectionPath, qcheckPath, freshnessMs, refreshQcheck } = {}) {
  const resolved = projectionPath ? path.resolve(projectionPath) : null;
  if (resolved && /Google Drive|My Drive|PAI_PROJECT/i.test(resolved)) {
    return () => degraded('CHIEF_CANONICAL_TRUTH_MUST_BE_LOCAL_PROJECTION');
  }
  if (!resolved && !qcheckPath) return () => degraded('CHIEF_CANONICAL_TRUTH_ADAPTER_NOT_CONFIGURED');
  const qcheckResolved = qcheckPath ? path.resolve(qcheckPath) : null;
  const boundedFreshnessMs = Number.isFinite(freshnessMs) && freshnessMs > 0
    ? Math.min(Math.floor(freshnessMs), DEFAULT_QCHECK_FRESHNESS_MS)
    : DEFAULT_QCHECK_FRESHNESS_MS;
  return () => {
    if (!resolved) {
      let current = readQcheck(qcheckResolved, boundedFreshnessMs);
      if (current.status === 'VERIFIED' || typeof refreshQcheck !== 'function' || !/^CHIEF_QCHECK_READ_FAILED:/.test(current.degradedReason || '')) return current;
      let refresh;
      try { refresh = refreshQcheck(); }
      catch (error) { return qcheckDegraded(`REFRESH_FAILED:${String(error.message || error)}`); }
      current = readQcheck(qcheckResolved, boundedFreshnessMs);
      if (current.status === 'VERIFIED') current.jitRefresh = 'EXECUTED';
      else if (refresh && refresh.scheduled === true) current.jitRefresh = 'SCHEDULED';
      return current;
    }
    try {
      const raw = fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '');
      const projection = validateProjection(JSON.parse(raw));
      return {
        ...projection,
        status: projection.status || 'VERIFIED',
        available: projection.available !== false,
        adapter: 'LOCAL_READ_ONLY_CANONICAL_PROJECTION',
        projectionHash: digest(projection),
        projectionPathHash: digest(resolved)
      };
    } catch (error) {
      return degraded(`CHIEF_CANONICAL_TRUTH_READ_FAILED:${String(error.message || error)}`);
    }
  };
}

module.exports = {
  createCanonicalTruthAdapter,
  degraded,
  digest,
  validateProjection,
  DEFAULT_QCHECK_FRESHNESS_MS
};
