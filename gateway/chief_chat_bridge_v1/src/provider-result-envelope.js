'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Archive root for long-cognition artifacts. The env override
// CHIEF_PROMPT_ARCHIVE_ROOT wins; the default is a local per-user folder.
const AUTO_INLINE_LIMIT = 512;
const SECRET_TEXT = /__Secure-next-auth|authorization:\s*bearer|cookie:\s*\S/i;

function defaultArtifactRoot() {
  const configured = process.env.CHIEF_PROMPT_ARCHIVE_ROOT;
  const base = configured
    ? path.resolve(configured)
    : path.join(os.homedir(), '.pai-chief-gateway', 'PAI_PROMPT_BUNDLE_ARCHIVE_R1');
  return path.join(base, 'provider-cognition');
}

function applyArtifactHandoff({
  content,
  policy = 'AUTO',
  sourceRefs = [],
  archiveRoot = null
} = {}) {
  const text = String(content || '');
  const mode = String(policy || 'AUTO').toUpperCase();
  if (!['INLINE', 'AUTO', 'ARTIFACT'].includes(mode)) {
    const err = new Error(`ARTIFACT_POLICY_INVALID: ${mode}`);
    err.code = 'ARTIFACT_POLICY_INVALID';
    throw err;
  }
  const bytes = Buffer.from(text, 'utf8');
  const spill = mode === 'ARTIFACT' || (mode === 'AUTO' && bytes.length > AUTO_INLINE_LIMIT);
  if (!spill) {
    return {
      candidate_content: text,
      disposition: 'CANDIDATE_INTELLIGENCE',
      summary: text.slice(0, 180),
      artifact: null
    };
  }
  if (SECRET_TEXT.test(text)) {
    const err = new Error('ARTIFACT_CREDENTIAL_BLOCKED');
    err.code = 'ARTIFACT_CREDENTIAL_BLOCKED';
    throw err;
  }
  const digestHex = crypto.createHash('sha256').update(bytes).digest('hex');
  const root = archiveRoot || defaultArtifactRoot();
  const file = path.join(root, `${digestHex}.txt`);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(file)) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, file);
  }
  const readBack = fs.readFileSync(file);
  const readDigest = crypto.createHash('sha256').update(readBack).digest('hex');
  if (readDigest !== digestHex || readBack.length !== bytes.length) {
    const err = new Error('ARTIFACT_READBACK_MISMATCH');
    err.code = 'ARTIFACT_READBACK_MISMATCH';
    throw err;
  }
  const summary = text.replace(/\s+/g, ' ').slice(0, 180);
  return {
    candidate_content: summary,
    disposition: 'ARTIFACT_READY',
    summary,
    artifact: {
      ref: file,
      digest: digestHex,
      bytes: bytes.length,
      summary,
      source_refs: sourceRefs
    }
  };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function createProviderResultEnvelope({
  run_id,
  objective_ref,
  provider,
  surface,
  state = 'COMPLETED',
  disposition = 'CANDIDATE_INTELLIGENCE',
  candidate_kind = 'ANALYSIS',
  candidate_content = '',
  evidence_refs = [],
  source_refs = [],
  provider_refs = { provider_thread_ref: null, provider_message_ref: null },
  changed_scope = [],
  tests = [],
  unknowns = [],
  known_limits = [],
  request_payload = {},
  started_at = new Date().toISOString(),
  completed_at = new Date().toISOString(),
  chiefQualificationRequired = true,
  effectPermission = 'AUTHORITY_NONE',
  handoff = { status: 'BUILD_READY_CANDIDATE', next_eligible_work: 'INDEPENDENT_QA_OR_FOUNDER_REVIEW' },
  artifact_ref = null,
  artifact_digest = null,
  summary = null
}) {
  const request_digest = digest(request_payload);
  const response_digest = digest({
    run_id,
    objective_ref,
    provider,
    surface,
    disposition,
    candidate_kind,
    candidate_content,
    artifact_digest: artifact_digest || null,
    started_at,
    completed_at
  });

  return {
    run_id,
    objective_ref,
    provider,
    surface,
    state,
    disposition,
    candidate_kind,
    candidate_content,
    summary: summary || String(candidate_content || '').slice(0, 180),
    artifact_ref: artifact_ref || null,
    artifact_digest: artifact_digest || null,
    evidence_refs,
    source_refs,
    provider_refs: {
      provider_thread_ref: provider_refs.provider_thread_ref || null,
      provider_message_ref: provider_refs.provider_message_ref || null
    },
    changed_scope,
    tests,
    unknowns,
    known_limits,
    request_digest,
    response_digest,
    started_at,
    completed_at,
    chiefQualificationRequired: Boolean(chiefQualificationRequired),
    effectPermission: effectPermission || 'AUTHORITY_NONE',
    handoff: {
      status: handoff?.status || 'BUILD_READY_CANDIDATE',
      next_eligible_work: handoff?.next_eligible_work || 'INDEPENDENT_QA_OR_FOUNDER_REVIEW'
    }
  };
}

module.exports = {
  stable,
  digest,
  createProviderResultEnvelope,
  applyArtifactHandoff,
  AUTO_INLINE_LIMIT
};
