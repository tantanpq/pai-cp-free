'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createCanonicalTruthAdapter,
  validateProjection
} = require('../src/canonical-truth-adapter');

const valid = {
  scope: 'PROJECT / PAI',
  status: 'VERIFIED',
  available: true,
  goal: 'Prove bounded Chief continuity experience.',
  acceptedState: 'RESULT_VERIFIED_CANDIDATE',
  lifecycleStage: 'RESULT_VERIFIED',
  completionEvidenceVerified: true,
  runningEvidenceVerified: false,
  evidence: ['WORK_TEST_RECEIPT', 'HOME_INDEPENDENT_QA'],
  blocker: null,
  nextAction: 'PERSONAL_BETA_R2_HANDOFF',
  unresolvedAuthority: null,
  authorityOwner: 'TÃƒÂ¢n'
};

assert.equal(validateProjection(valid).lifecycleStage, 'RESULT_VERIFIED');
assert.throws(() => validateProjection({ ...valid, evidence: [] }), /EVIDENCE_REQUIRED/);
assert.throws(
  () => validateProjection({
    ...valid,
    lifecycleStage: 'RUNNING',
    completionEvidenceVerified: false,
    runningEvidenceVerified: false
  }),
  /FALSE_RUNNING/
);
assert.throws(
  () => validateProjection({
    ...valid,
    completionEvidenceVerified: false
  }),
  /FALSE_COMPLETE/
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-chief-truth-'));
const file = path.join(dir, 'truth.json');
fs.writeFileSync(file, JSON.stringify(valid), 'utf8');
const read = createCanonicalTruthAdapter({ projectionPath: file })();
assert.equal(read.status, 'VERIFIED');
assert.equal(read.adapter, 'LOCAL_READ_ONLY_CANONICAL_PROJECTION');
assert.equal(read.projectionHash.length, 64);
assert.equal(read.projectionPathHash.length, 64);

fs.writeFileSync(file, '\uFEFF' + JSON.stringify(valid), 'utf8');
const bomRead = createCanonicalTruthAdapter({ projectionPath: file })();
assert.equal(bomRead.status, 'VERIFIED');
const missing = createCanonicalTruthAdapter({ projectionPath: path.join(dir, 'missing.json') })();
assert.equal(missing.status, 'DEGRADED');
assert.equal(missing.available, false);
assert.match(missing.degradedReason, /READ_FAILED/);

const unconfigured = createCanonicalTruthAdapter({ projectionPath: null })();
assert.equal(unconfigured.status, 'DEGRADED');
assert.match(unconfigured.degradedReason, /NOT_CONFIGURED/);

const drivePath = createCanonicalTruthAdapter({
  projectionPath: 'C:\\Users\\Tan\\My Drive\\PAI_PROJECT\\truth.json'
})();
assert.equal(drivePath.status, 'DEGRADED');
assert.match(drivePath.degradedReason, /MUST_BE_LOCAL_PROJECTION/);

const qcheckFile = path.join(dir, 'qcheck.json');
const qcheck = ({ at = new Date().toISOString(), runningClaims = 1, staleRunning = 0 } = {}) => ({
  schema: 'pai-current-system-quick-check/v2-simple-body',
  status: 'PASS',
  at,
  authority: { owner: 'PAI_CURRENT_SYSTEM_QUICK_CHECK', mode: 'READ_ONLY', operationalCutover: true },
  operationalSimpleBodyProjection: { runningClaims, staleRunning }
});
fs.writeFileSync(qcheckFile, JSON.stringify(qcheck()), 'utf8');
const jitRunning = createCanonicalTruthAdapter({ qcheckPath: qcheckFile })();
assert.equal(jitRunning.status, 'VERIFIED');
assert.equal(jitRunning.available, true);
assert.equal(jitRunning.sourceType, 'JIT_QCHECK_READ_ONLY');
assert.equal(jitRunning.lifecycleStage, 'RUNNING');
assert.equal(jitRunning.runningEvidenceVerified, true);
assert.equal(jitRunning.completionEvidenceVerified, false);
assert.deepEqual(jitRunning.authority, qcheck().authority);
assert.equal(jitRunning.evidence[0].runningClaims, 1);

fs.writeFileSync(qcheckFile, JSON.stringify(qcheck({ runningClaims: 0 })), 'utf8');
const jitNoRunning = createCanonicalTruthAdapter({ qcheckPath: qcheckFile })();
assert.equal(jitNoRunning.status, 'VERIFIED');
assert.equal(jitNoRunning.lifecycleStage, 'OBSERVED_NO_RUNNING_CLAIM');
assert.equal(jitNoRunning.runningEvidenceVerified, false);
assert.equal(jitNoRunning.completionEvidenceVerified, false);

const fallbackQcheck = qcheck({ runningClaims: 1 });
delete fallbackQcheck.operationalSimpleBodyProjection;
fallbackQcheck.simpleBody = { lifecycleSnapshot: { projection: { runningClaims: 1, staleRunning: 0 } } };
fs.writeFileSync(qcheckFile, JSON.stringify(fallbackQcheck), 'utf8');
const jitFallback = createCanonicalTruthAdapter({ qcheckPath: qcheckFile })();
assert.equal(jitFallback.status, 'VERIFIED');
assert.equal(jitFallback.lifecycleStage, 'RUNNING');

fs.writeFileSync(qcheckFile, JSON.stringify(qcheck({ at: new Date(Date.now() - 300001).toISOString() })), 'utf8');
let refreshCalls = 0;
const refreshed = createCanonicalTruthAdapter({
  qcheckPath: qcheckFile,
  refreshQcheck: () => {
    refreshCalls += 1;
    fs.writeFileSync(qcheckFile, JSON.stringify(qcheck()), 'utf8');
  }
})();
assert.equal(refreshed.status, 'VERIFIED');
assert.equal(refreshed.jitRefresh, 'EXECUTED');
assert.equal(refreshCalls, 1);
fs.writeFileSync(qcheckFile, JSON.stringify(qcheck({ at: new Date(Date.now() - 300001).toISOString() })), 'utf8');
let scheduledRefreshCalls = 0;
const scheduled = createCanonicalTruthAdapter({
  qcheckPath: qcheckFile,
  refreshQcheck: () => ({ scheduled: ++scheduledRefreshCalls === 1 })
})();
assert.equal(scheduled.status, 'DEGRADED');
assert.equal(scheduled.jitRefresh, 'SCHEDULED');
assert.equal(scheduledRefreshCalls, 1);
fs.writeFileSync(qcheckFile, JSON.stringify(qcheck({ at: new Date(Date.now() - 300001).toISOString() })), 'utf8');
assert.equal(createCanonicalTruthAdapter({ qcheckPath: qcheckFile })().status, 'DEGRADED');
fs.writeFileSync(qcheckFile, JSON.stringify(qcheck({ staleRunning: 1 })), 'utf8');
assert.equal(createCanonicalTruthAdapter({ qcheckPath: qcheckFile })().status, 'DEGRADED');
fs.writeFileSync(qcheckFile, JSON.stringify({ ...qcheck(), authority: { owner: 'PAI_CURRENT_SYSTEM_QUICK_CHECK', mode: 'READ_ONLY', operationalCutover: false } }), 'utf8');
assert.equal(createCanonicalTruthAdapter({ qcheckPath: qcheckFile })().status, 'DEGRADED');
fs.writeFileSync(qcheckFile, JSON.stringify({ schema: 'wrong', status: 'PASS' }), 'utf8');
assert.equal(createCanonicalTruthAdapter({ qcheckPath: qcheckFile })().status, 'DEGRADED');
assert.equal(createCanonicalTruthAdapter({ qcheckPath: path.join(dir, 'missing-qcheck.json') })().status, 'DEGRADED');

fs.rmSync(dir, { recursive: true, force: true });
console.log('canonical-truth-adapter: PASS');
