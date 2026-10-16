'use strict';

const crypto = require('node:crypto');
const { validMutableScope, providerCapability } = require('./work-contract');

const MODES = Object.freeze(['EXPLORE', 'DECIDE', 'EXECUTE', 'REVIEW', 'REFLECT']);
const DISPOSITIONS = Object.freeze(['ASK', 'ACT', 'WAIT', 'SURFACE']);
const TERMINAL = new Set(['RESULT_VERIFIED', 'COMPLETE', 'COMPLETED', 'PASS']);
const RUNNING = new Set(['RUNNING', 'CLAIMED']);
const WORK_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']); const DATA_MODES = new Set(['NONE', 'READ_ONLY', 'READ_WRITE', 'PORTABLE_ARTIFACT']);
const WORK_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/; const WORK_ID = /^[A-Z][A-Z0-9_]{2,63}$/; const WORK_CAPABILITY = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/;
const stable = value => Array.isArray(value)
  ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
function normalizeWorkSpec(value) {
  if (value == null) return null; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CHIEF_WORK_SPEC_INVALID');
  const allowed = new Set(['mutableScope', 'requiredCapabilities', 'priority', 'rootId', 'parentId', 'workdir', 'dataMode', 'task']); if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('CHIEF_WORK_SPEC_INVALID');
  const mutableScope = typeof value.mutableScope === 'string' ? value.mutableScope.trim() : ''; const requiredCapabilities = Array.isArray(value.requiredCapabilities) ? value.requiredCapabilities.map(x => typeof x === 'string' ? x.trim() : '') : []; const priority = String(value.priority || '').trim().toUpperCase();
  const opt = key => value[key] == null || value[key] === '' ? null : String(value[key]).trim(); const rootId = opt('rootId'), parentId = opt('parentId'), workdir = opt('workdir'), dataMode = opt('dataMode')?.toUpperCase() || null; const task = typeof value.task === 'string' ? value.task.trim() : '';
  if (requiredCapabilities.some(providerCapability)) throw new Error('CHIEF_WORK_SPEC_PROVIDER_PIN_UNSUPPORTED');
  if (!validMutableScope(mutableScope) || !requiredCapabilities.length || !requiredCapabilities.every(x => WORK_CAPABILITY.test(x)) || !WORK_PRIORITIES.has(priority) || !task || task.length > 2000 || /\u0000/.test(task) || (rootId && !WORK_ID.test(rootId)) || (parentId && !WORK_ID.test(parentId)) || ((workdir == null) !== (dataMode == null)) || (workdir && workdir !== '.' && !WORK_PATH.test(workdir)) || (dataMode && !DATA_MODES.has(dataMode))) throw new Error('CHIEF_WORK_SPEC_INVALID');
  return Object.freeze({ mutableScope, requiredCapabilities: Object.freeze([...requiredCapabilities]), priority, rootId, parentId, workdir, dataMode, task });
}

function modeFor(mode, intentClass) {
  const normalized = String(mode || '').toUpperCase();
  if (MODES.includes(normalized)) return normalized;
  if (['BUILD', 'REPAIR', 'QA', 'RELEASE', 'RUNTIME_ACTION', 'CHANGE'].includes(intentClass)) return 'EXECUTE';
  if (intentClass === 'RECOMMEND') return 'DECIDE';
  if (intentClass === 'REPORT') return 'REVIEW';
  if (intentClass === 'SYNTHESIZE') return 'REFLECT';
  return 'EXPLORE';
}

function boundedLifecycle(truth = {}) {
  const raw = String(truth.lifecycleStage || truth.runtimeStage || truth.acceptedState || 'UNKNOWN').toUpperCase();
  if (RUNNING.has(raw) && truth.runningEvidenceVerified !== true) return 'REQUESTED_NOT_ADMITTED';
  if (TERMINAL.has(raw) && truth.completionEvidenceVerified !== true) return 'RESULT_UNVERIFIED';
  return raw;
}

function assessTruth(truth = {}) {
  const scopeMissing = truth.scope === 'PROJECT_NOT_REGISTERED';
  const degraded = truth.available === false || scopeMissing || String(truth.status || '').toUpperCase() === 'DEGRADED';
  const conflict = truth.conflictingEvidence === true || String(truth.conflictStatus || '').toUpperCase().includes('CONFLICT');
  const stale = truth.staleEvidence === true;
  const mismatch = truth.operationalMismatch === true;
  const state = degraded ? 'DEGRADED' : conflict ? 'CONFLICT' : mismatch ? 'MISMATCH' : stale ? 'STALE' : 'VERIFIED';
  return {
    state,
    degraded,
    conflict,
    stale,
    mismatch,
    lifecycleStage: boundedLifecycle(truth),
    degradedReason: truth.degradedReason || (scopeMissing ? 'PROJECT_NOT_REGISTERED' : null)
  };
}

function dispositionFor({ intentClass, truth = {}, missingCanonical = false, waiting = false }) {
  const assessment = assessTruth(truth);
  if (assessment.state !== 'VERIFIED') return 'SURFACE';
  if (missingCanonical) return 'ASK';
  if (waiting || truth.waiting === true) return 'WAIT';
  if (['BUILD', 'REPAIR', 'QA', 'RELEASE', 'RUNTIME_ACTION', 'CHANGE'].includes(intentClass)) return 'ACT';
  return 'SURFACE';
}

function continuityCapsule({ session, truth = {} }) {
  const checkpoint = session?.checkpoint || {};
  const evidence = Array.isArray(truth.evidence)
    ? truth.evidence
    : Array.isArray(checkpoint.evidenceReceipts)
      ? checkpoint.evidenceReceipts
      : [];
  return {
    goal: truth.goal || checkpoint.activeTopic || 'Maintain the verified PAI frontier.',
    acceptedState: truth.acceptedState || boundedLifecycle(truth),
    evidence,
    blocker: truth.blocker || null,
    nextAction: truth.nextAction || checkpoint.nextFrontier || null,
    unresolvedAuthority: truth.unresolvedAuthority || null
  };
}

function resultStatus({ resultKind, truth = {}, assessment }) {
  if (assessment.state !== 'VERIFIED') return assessment.state;
  if (resultKind === 'CORRECTION') return 'CORRECTION_RECORDED';
  if (resultKind === 'ACTION_PREVIEW') return 'PREVIEWED_NOT_EXECUTED';
  if (resultKind === 'ACTION_COMMIT') return 'REQUESTED_NOT_ADMITTED';
  if (resultKind === 'DIRECT') return 'ANSWERED';
  if (resultKind === 'WAIT') return 'WAITING';
  return boundedLifecycle(truth);
}

function renderExperience({
  session,
  truth = {},
  intentClass = 'REPORT',
  mode,
  resultKind = 'DIRECT',
  answer = null,
  actionPreview = null,
  correction = null,
  missingCanonical = false,
  waiting = false
} = {}) {
  const assessment = assessTruth(truth);
  const disposition = dispositionFor({ intentClass, truth, missingCanonical, waiting });
  const capsule = continuityCapsule({ session, truth });
  const corrections = Array.isArray(session?.checkpoint?.corrections) ? session.checkpoint.corrections : [];
  const unresolved = capsule.unresolvedAuthority;
  const safeStatus = resultStatus({ resultKind, truth, assessment });
  const answerFirst = answer
    || (assessment.state !== 'VERIFIED'
      ? `Operational truth is ${assessment.state}; no RUNNING or COMPLETE claim is allowed.`
      : resultKind === 'ACTION_PREVIEW'
        ? 'Action is previewed only; no governed effect has occurred.'
        : resultKind === 'ACTION_COMMIT'
          ? 'The existing Governor received a request; execution is not claimed.'
          : 'Current verified picture is surfaced first.');
  return {
    version: 'PAI_CHIEF_CONVERSATION_EXPERIENCE_V0',
    mode: modeFor(mode, intentClass),
    disposition,
    answerFirst,
    continuityCapsule: capsule,
    objects: {
      resumeCard: {
        title: 'Resume Card',
        ...capsule,
        degraded: assessment.degraded,
        continuity: 'AUTOMATIC_NO_ROUTINE_SAVE_SYNC'
      },
      currentPicture: {
        title: 'Current Picture',
        truthState: assessment.state,
        lifecycleStage: assessment.lifecycleStage,
        verified: assessment.state === 'VERIFIED',
        staleEvidence: assessment.stale,
        conflictingEvidence: assessment.conflict,
        operationalMismatch: assessment.mismatch,
        degradedReason: assessment.degradedReason,
        inferred: Array.isArray(truth.inferred) ? truth.inferred : []
      },
      actionCard: {
        title: 'Action Card',
        disposition,
        previewRequired: disposition === 'ACT',
        actionPreview,
        effectBoundary: 'EXISTING_GOVERNOR_REQUEST_ONLY_NO_CLAIM_NO_EXECUTION',
        relayPolicy: 'INTERNAL_GOVERNED_HANDOFF_NO_REPEATED_USER_RELAY'
      },
      resultCard: {
        title: 'Result Card',
        status: safeStatus,
        running: !['ACTION_PREVIEW', 'ACTION_COMMIT'].includes(resultKind) && assessment.lifecycleStage === 'RUNNING' && truth.runningEvidenceVerified === true,
        complete: !['ACTION_PREVIEW', 'ACTION_COMMIT'].includes(resultKind) && TERMINAL.has(assessment.lifecycleStage) && truth.completionEvidenceVerified === true,
        evidence: capsule.evidence
      },
      improvementCard: {
        title: 'Improvement Card',
        correction,
        persistedCorrections: corrections,
        behaviorApplied: corrections.length > 0,
        latestAppliedCorrection: corrections.length ? corrections[corrections.length - 1] : null,
        authority: 'OPERATIONAL_CANDIDATE_ONLY'
      },
      decisionCard: {
        title: 'Decision Card',
        required: Boolean(unresolved),
        unresolvedAuthority: unresolved,
        owner: truth.authorityOwner || null
      }
    }
  };
}

function createActionPreview({ input, session, now = () => new Date().toISOString() }) {
  const workSpec = normalizeWorkSpec(input.workSpec);
  const body = {
    sessionId: session.sessionId,
    expectedRevision: session.revision,
    intentClass: input.intentClass,
    messageHash: digest(input.message),
    route: 'GOVERNOR',
    effect: 'REQUEST_ONLY_NO_NODE_CLAIM_OR_GRAPH_AUTHORITY', workSpec
  };
  const previewHash = digest(body);
  return {
    actionPreviewId: `CHIEF_ACTION_PREVIEW:${previewHash.slice(0, 24)}`,
    previewHash,
    expectedRevision: session.revision,
    intentClass: input.intentClass,
    messageHash: body.messageHash,
    route: 'GOVERNOR',
    effect: body.effect,
    summary: input.message, workSpec,
    status: 'PREVIEWED_NOT_EXECUTED',
    createdAt: now()
  };
}

function verifyActionPreview({ preview, input, session }) {
  if (!preview) throw new Error('CHIEF_ACTION_PREVIEW_NOT_FOUND');
  if (preview.status !== 'PREVIEWED_NOT_EXECUTED') throw new Error('CHIEF_ACTION_PREVIEW_ALREADY_USED');
  if (preview.expectedRevision !== session.revision) throw new Error('CHIEF_ACTION_PREVIEW_STALE');
  if (preview.intentClass !== input.intentClass || preview.messageHash !== digest(input.message) || digest(preview.workSpec || null) !== digest(normalizeWorkSpec(input.workSpec))) {
    throw new Error('CHIEF_ACTION_PREVIEW_MISMATCH');
  }
  if (preview.previewHash !== input.actionPreviewHash) throw new Error('CHIEF_ACTION_PREVIEW_HASH_MISMATCH');
  return true;
}

module.exports = {
  MODES,
  DISPOSITIONS,
  digest,
  modeFor,
  boundedLifecycle,
  assessTruth,
  dispositionFor,
  continuityCapsule,
  renderExperience,
  createActionPreview,
  verifyActionPreview,
  normalizeWorkSpec
};
