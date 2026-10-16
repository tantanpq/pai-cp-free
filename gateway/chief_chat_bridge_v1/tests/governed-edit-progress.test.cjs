'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertLensPath, buildProjectLens } = require('../src/project-lens');
const { validateCandidateBytes, gateDone, parseJson, normalizeProviderAction } = require('../src/bounded-work-entry');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stderr.write(`FAIL ${name} ${err.message}\n`);
  }
}
function codeOf(fn) {
  try { fn(); return ''; } catch (err) { return err.code || ''; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-edit-matrix-'));
fs.writeFileSync(path.join(root, 'item.js'), "'use strict';\nmodule.exports = (a, b) => a - b;\n");
const lens = {
  capsule: {
    affected_files: [{ code: ' M', path: 'item.js' }],
    tracked_files: ['item.js', 'item.test.js']
  }
};
const state = { reads: new Set(['item.js']), wrote: false, testExit: null };
const same = fs.readFileSync(path.join(root, 'item.js'), 'utf8');
const changed = same.replace('a - b', 'a + b');

check('1 READ target is admitted', () => {
  if (assertLensPath(lens, 'item.js') !== 'item.js') throw new Error('read target');
});
check('2 identical write is NO_MATERIAL_DELTA', () => {
  if (codeOf(() => validateCandidateBytes(same, same)) !== 'NO_MATERIAL_DELTA') throw new Error('not rejected');
});
check('3 invalid bytes are ACTION_NOT_ALLOWED', () => {
  if (codeOf(() => validateCandidateBytes(same, "require('child_process').exec('rm')")) !== 'ACTION_NOT_ALLOWED') throw new Error('invalid accepted');
});
check('4 material change is accepted', () => {
  const next = validateCandidateBytes(same, changed);
  if (!next.includes('a + b')) throw new Error('delta lost');
});
check('5 DONE before pass is DONE_WITHOUT_PASS', () => {
  if (codeOf(() => gateDone(state, true)) !== 'DONE_WITHOUT_PASS') throw new Error('done allowed');
});
check('6 failed run does not permit DONE', () => {
  const after = { reads: new Set(['item.js']), wrote: true, testExit: 1 };
  if (codeOf(() => gateDone(after, true)) !== 'DONE_WITHOUT_PASS') throw new Error('fail treated as pass');
});
check('7 pass after write permits DONE', () => {
  gateDone({ reads: new Set(['item.js']), wrote: true, testExit: 0 }, true);
});
check('8 outside lens path is SCOPE_DENIED', () => {
  if (codeOf(() => assertLensPath(lens, 'other.js')) !== 'SCOPE_DENIED') throw new Error('outside admitted');
});
check('9 traversal and absolute paths are SCOPE_DENIED', () => {
  if (codeOf(() => assertLensPath(lens, '../item.js')) !== 'SCOPE_DENIED') throw new Error('traversal');
  if (codeOf(() => assertLensPath(lens, 'C:\\Windows\\notepad.exe')) !== 'SCOPE_DENIED') throw new Error('absolute');
});
check('11 nested WRITE_CANDIDATE with a real delta parses', () => {
  const raw = '{"WRITE_CANDIDATE":{"target":"item.js","content":"\'use strict\';module.exports = (a, b) => a + b;"}}';
  const parsed = parseJson(raw);
  const nested = parsed.WRITE_CANDIDATE;
  const next = validateCandidateBytes(same, nested.content);
  if (!next.includes('a + b') || nested.target !== 'item.js') throw new Error('nested shape');
});
check('T1 flat READ normalizes', () => {
  const action = normalizeProviderAction({ action: 'READ', target: 'item.js', payload: '', done: false });
  if (action.action !== 'READ' || action.target !== 'item.js') throw new Error(JSON.stringify(action));
});
check('T2 flat WRITE is a material delta', () => {
  const action = normalizeProviderAction({ action: 'WRITE_CANDIDATE', target: 'item.js', payload: changed, done: false });
  if (action.action !== 'WRITE_CANDIDATE' || !validateCandidateBytes(same, action.payload).includes('a + b')) throw new Error('flat write');
});
check('T3 nested WRITE becomes canonical payload', () => {
  const action = normalizeProviderAction({ WRITE_CANDIDATE: { target: 'item.js', content: changed } });
  if (action.action !== 'WRITE_CANDIDATE' || action.target !== 'item.js' || action.payload !== changed) throw new Error(JSON.stringify(action));
  if ('content' in action) throw new Error('content leaked');
});
check('T4 nested identical write is NO_MATERIAL_DELTA', () => {
  const action = normalizeProviderAction({ WRITE_CANDIDATE: { target: 'item.js', content: same } });
  if (codeOf(() => validateCandidateBytes(same, action.payload)) !== 'NO_MATERIAL_DELTA') throw new Error('wrote identical');
});
check('T5 unknown nested action is rejected', () => {
  if (codeOf(() => normalizeProviderAction({ SHELL: { command: 'rm -rf /' } })) !== 'ACTION_NOT_ALLOWED') throw new Error('shell action');
});
check('T6 two action keys are invalid', () => {
  if (codeOf(() => normalizeProviderAction({ READ: { target: 'a.js' }, RUN: { target: 'a.test.js' } })) !== 'PROVIDER_OUTPUT_INVALID') throw new Error('multi');
});
check('T7 mixed flat and nested is invalid', () => {
  if (codeOf(() => normalizeProviderAction({ action: 'READ', WRITE_CANDIDATE: { target: 'item.js', content: changed } })) !== 'PROVIDER_OUTPUT_INVALID') throw new Error('mixed');
});
check('T8 nested target outside lens is SCOPE_DENIED', () => {
  const action = normalizeProviderAction({ WRITE_CANDIDATE: { target: 'other.js', content: changed } });
  if (codeOf(() => assertLensPath(lens, action.target)) !== 'SCOPE_DENIED') throw new Error('scope');
});
check('T11 DONE before verified test is closed', () => {
  if (codeOf(() => gateDone(state, true)) !== 'DONE_WITHOUT_PASS') throw new Error('early done');
});
check('T12 mock READ WRITE RUN PASS DONE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-mock-host-'));
  const file = path.join(dir, 'item.js');
  fs.writeFileSync(file, same);
  const read = normalizeProviderAction({ action: 'READ', target: 'item.js', payload: '', done: false });
  if (read.action !== 'READ') throw new Error('read');
  const write = normalizeProviderAction({ WRITE_CANDIDATE: { target: 'item.js', content: changed } });
  const next = validateCandidateBytes(fs.readFileSync(file, 'utf8'), write.payload);
  let hostWrites = 0;
  fs.writeFileSync(file, next);
  hostWrites += 1;
  if (hostWrites !== 1 || !fs.readFileSync(file, 'utf8').includes('a + b')) throw new Error('host write');
  const hostState = { reads: new Set(['item.js']), wrote: true, testExit: 0 };
  gateDone(hostState, true);
});
check('10 raw shell is PROVIDER_OUTPUT_INVALID', () => {
  if (codeOf(() => parseJson('node -e "process.exit(1)"')) !== 'PROVIDER_OUTPUT_INVALID') throw new Error('shell parsed');
});

const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-edit-git-'));
const git = args => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('git', ['-c', 'user.email=lens@local', '-c', 'user.name=lens', ...args], { cwd: gitRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git');
};
require('node:child_process').spawnSync('git', ['init'], { cwd: gitRoot, encoding: 'utf8' });
fs.writeFileSync(path.join(gitRoot, 'item.js'), same.replace('a - b', 'a + b'));
git(['add', 'item.js']);
git(['commit', '-m', 'ok']);
fs.writeFileSync(path.join(gitRoot, 'item.js'), same);
const live = buildProjectLens(gitRoot, { projectId: 'matrix' });
check('lens names the dirty file exactly', () => {
  if (live.capsule.affected_files.map(file => file.path).join('|') !== 'item.js') throw new Error(live.capsule.affected_files.map(file => file.path).join('|'));
});

if (failed) process.exit(1);
process.stdout.write('GOVERNED_EDIT_PROGRESS: PASS\n');
