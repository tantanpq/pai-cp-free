'use strict';

const assert = require('node:assert/strict');
const experience = require('../src/chief-conversation-experience');

const session = {
  sessionId: 'pai-tan-chief-main',
  revision: 7,
  checkpoint: {
    activeTopic: 'Restore bridge-owned conversation experience coverage.',
    nextFrontier: 'RUN_DIRECT_BRIDGE_TESTS',
    evidenceReceipts: ['BRIDGE_TEST_RECEIPT'],
    corrections: [{ statement: 'Surface operational truth before recommendations.' }]
  }
};
const verifiedTruth = {
  scope: 'PROJECT / PAI',
  status: 'VERIFIED',
  available: true,
  goal: 'Render the current verified Chief picture.',
  lifecycleStage: 'RESULT_VERIFIED',
  completionEvidenceVerified: true,
  evidence: ['BRIDGE_TEST_RECEIPT']
};

const rendered = experience.renderExperience({
  session,
  truth: verifiedTruth,
  intentClass: 'REPORT',
  mode: 'REVIEW',
  answer: 'The verified current picture is available.'
});
assert.equal(rendered.answerFirst, 'The verified current picture is available.');
assert.equal(rendered.mode, 'REVIEW');
assert.equal(rendered.objects.currentPicture.truthState, 'VERIFIED');
assert.equal(rendered.objects.currentPicture.verified, true);
assert.equal(rendered.objects.resumeCard.goal, verifiedTruth.goal);
assert.equal(rendered.objects.resultCard.complete, true);
assert.equal(rendered.objects.actionCard.effectBoundary, 'EXISTING_GOVERNOR_REQUEST_ONLY_NO_CLAIM_NO_EXECUTION');

for (const fixture of [
  { name: 'stale', patch: { staleEvidence: true, lifecycleStage: 'RUNNING', runningEvidenceVerified: false }, state: 'STALE' },
  { name: 'conflict', patch: { conflictingEvidence: true, lifecycleStage: 'COMPLETE', completionEvidenceVerified: false }, state: 'CONFLICT' },
  { name: 'degraded', patch: { available: false, status: 'DEGRADED', lifecycleStage: 'RUNNING', runningEvidenceVerified: false }, state: 'DEGRADED' }
]) {
  const unsafe = experience.renderExperience({
    session,
    truth: { ...verifiedTruth, ...fixture.patch },
    intentClass: 'REPORT',
    mode: 'REVIEW'
  });
  assert.equal(unsafe.disposition, 'SURFACE', fixture.name);
  assert.equal(unsafe.objects.currentPicture.truthState, fixture.state, fixture.name);
  assert.equal(unsafe.objects.resultCard.running, false, fixture.name);
  assert.equal(unsafe.objects.resultCard.complete, false, fixture.name);
  assert.match(unsafe.answerFirst, /no RUNNING or COMPLETE claim/i, fixture.name);
}

const correction = experience.renderExperience({
  session,
  truth: verifiedTruth,
  resultKind: 'CORRECTION',
  correction: 'Use verified evidence for the current picture.'
});
assert.equal(correction.objects.improvementCard.behaviorApplied, true);
assert.equal(correction.objects.improvementCard.latestAppliedCorrection.statement, 'Surface operational truth before recommendations.');
assert.equal(correction.objects.improvementCard.correction, 'Use verified evidence for the current picture.');
assert.equal(correction.objects.improvementCard.authority, 'OPERATIONAL_CANDIDATE_ONLY');

const preview = experience.createActionPreview({
  input: { intentClass: 'REPAIR', message: 'Prepare a bounded repair request.', workSpec: { mutableScope: 'CORE/chief_chat_bridge_v1', requiredCapabilities: ['NODE'], priority: 'P1', workdir: 'CORE/chief_chat_bridge_v1', dataMode: 'READ_WRITE', task: 'Repair bounded validation.' } },
  session,
  now: () => '2026-08-15T00:00:00.000Z'
});
assert.equal(preview.status, 'PREVIEWED_NOT_EXECUTED');
assert.equal(preview.effect, 'REQUEST_ONLY_NO_NODE_CLAIM_OR_GRAPH_AUTHORITY');
assert.equal(experience.verifyActionPreview({
  preview,
  input: { intentClass: 'REPAIR', message: 'Prepare a bounded repair request.', actionPreviewHash: preview.previewHash, workSpec: preview.workSpec },
  session
}), true);
assert.throws(() => experience.verifyActionPreview({ preview, input: { intentClass: 'REPAIR', message: 'Prepare a bounded repair request.', actionPreviewHash: preview.previewHash, workSpec: { ...preview.workSpec, priority: 'P0' } }, session }), /CHIEF_ACTION_PREVIEW_MISMATCH/);
assert.doesNotMatch(JSON.stringify({ rendered, correction, preview }), /claim[^\"]*\"\s*:\s*true|execut(?:ion|ed)[^\"]*\"\s*:\s*true/i);

console.log('chief-conversation-experience: PASS');
