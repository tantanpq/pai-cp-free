'use strict';

// W4: one real ChatGPT send, AUTO policy, Drive artifact, digest readback.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CHATGPT_WEB_ENABLED = '1';

const { applyArtifactHandoff, AUTO_INLINE_LIMIT } = require('../src/provider-result-envelope');
const { ChatGPTWebProviderAdapter, ChatGPTWebError, ERR } = require('../src/chatgpt-web-adapter');

function assert(name, ok, detail) {
  if (!ok) {
    const err = new Error(`${name}${detail ? ': ' + detail : ''}`);
    err.code = 'CANARY_ASSERT';
    throw err;
  }
  process.stdout.write(`PASS ${name}\n`);
}

function localPolicy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-artifact-policy-'));
  const short = applyArtifactHandoff({ content: 'PAI_BRAIN_OK', policy: 'AUTO', archiveRoot: dir });
  assert('short stays inline', short.disposition === 'CANDIDATE_INTELLIGENCE' && short.artifact === null && short.candidate_content === 'PAI_BRAIN_OK');
  const body = 'PAI_ARTIFACT_OK\n'.repeat(80);
  assert('fixture exceeds inline limit', Buffer.byteLength(body) > AUTO_INLINE_LIMIT);
  const spilled = applyArtifactHandoff({
    content: body,
    policy: 'AUTO',
    sourceRefs: ['drive:1KyccfUHvP3ViCmNyRNuw0reOy2f9VraouEFB0BHWjKU'],
    archiveRoot: dir
  });
  assert('auto spills', spilled.disposition === 'ARTIFACT_READY' && spilled.artifact);
  const read = fs.readFileSync(spilled.artifact.ref);
  const digest = crypto.createHash('sha256').update(read).digest('hex');
  assert('local readback digest', digest === spilled.artifact.digest);
  assert('inline is not the full body', spilled.candidate_content.length < body.length);
  let blocked = false;
  try {
    applyArtifactHandoff({ content: 'cookie: secret-value ' + 'x'.repeat(600), policy: 'AUTO', archiveRoot: dir });
  } catch (err) {
    blocked = err.code === 'ARTIFACT_CREDENTIAL_BLOCKED';
  }
  assert('credential text is not stored', blocked);
  assert('typed provider errors remain', ERR.AUTH_REQUIRED === 'CHATGPT_AUTH_REQUIRED' && new ChatGPTWebError('CHATGPT_TIMEOUT', 'x').code === 'CHATGPT_TIMEOUT');
}

async function live() {
  const adapter = new ChatGPTWebProviderAdapter();
  const sourceRefs = ['drive:1KyccfUHvP3ViCmNyRNuw0reOy2f9VraouEFB0BHWjKU'];
  const key = `w4-artifact-${Date.now()}`;
  const result = await adapter.invokeCognition({
    run_id: `run:${key}`,
    objective: 'Output only the line PAI_ARTIFACT_OK repeated 80 times, one line each. No other text.',
    reasoning_type: 'ANSWER',
    idempotency_key: key,
    artifact_policy: 'AUTO',
    source_refs: sourceRefs
  });
  await ChatGPTWebProviderAdapter.closeBrowser();
  const packed = JSON.stringify(result);
  assert('one result state', result.state === 'COMPLETED' && result.provider === 'CHATGPT');
  assert('artifact disposition', result.disposition === 'ARTIFACT_READY', result.disposition);
  assert('source refs preserved', Array.isArray(result.source_refs) && result.source_refs[0] === sourceRefs[0]);
  assert('compact result has ref and digest', Boolean(result.artifact_ref) && /^[a-f0-9]{64}$/.test(result.artifact_digest));
  assert('summary is bounded', typeof result.summary === 'string' && result.summary.length <= 180);
  const file = fs.readFileSync(result.artifact_ref);
  const digest = crypto.createHash('sha256').update(file).digest('hex');
  assert('exact readback digest', digest === result.artifact_digest && file.length === result.artifact_digest.length || digest === result.artifact_digest);
  const body = file.toString('utf8');
  assert('full body is not in the result', result.candidate_content.length < body.length && !packed.includes(body));
  assert('artifact has no credential marker', !/__Secure-next-auth|authorization:\s*bearer/i.test(file.toString('utf8')));
  const evidence = {
    ran_at: new Date().toISOString(),
    provider: result.provider,
    state: result.state,
    disposition: result.disposition,
    artifact_ref: result.artifact_ref,
    artifact_digest: result.artifact_digest,
    artifact_bytes: file.length,
    summary: result.summary,
    source_refs: result.source_refs,
    result_chars: packed.length,
    idempotency_key: key
  };
  const out = path.join(__dirname, '..', 'scratch', 'provider-v0-bootstrap-evidence', 'w4-preimage-20260923T213000Z', 'w4-live.json');
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  process.stdout.write(`ARTIFACT ${result.artifact_digest} bytes=${file.length} result_chars=${packed.length}\n`);
}

localPolicy();
live().catch(err => {
  process.stderr.write(`W4_FAIL ${err.code || ''} ${err.message}\n`);
  process.exit(1);
});
