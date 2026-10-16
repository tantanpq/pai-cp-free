'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.CHATGPT_WEB_ENABLED = '1';

const { buildProjectLens, sha256 } = require('../src/project-lens');
const { ChatGPTWebProviderAdapter } = require('../src/chatgpt-web-adapter');

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.email=lens@local', '-c', 'user.name=lens', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git failed');
}

function parseJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    const err = new Error('PROVIDER_OUTPUT_INVALID');
    err.raw = raw.slice(0, 300);
    throw err;
  }
  const body = raw.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (err) {
    const wrapped = new Error('PROVIDER_OUTPUT_INVALID');
    wrapped.raw = body.slice(0, 300);
    throw wrapped;
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-lens-'));
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(path.join(root, 'note.txt'), 'accepted\n');
  git(root, ['add', 'note.txt']);
  git(root, ['commit', '-m', 'accepted']);
  fs.appendFileSync(path.join(root, 'note.txt'), 'local-delta\n');

  const lens = buildProjectLens(root, {
    projectId: path.basename(root),
    objective: 'Name the dirty file and the source identity. Do not invent unseen lines.',
    resultRefs: ['PROVIDER_V0_RESULT.md'],
    sourceLock: 'PROVIDER_V0_ACCEPTED'
  });
  if (lens.capsule.worktree !== 'DIRTY' || !lens.diffHash) throw new Error('LENS_DID_NOT_DETECT_DIRTY');
  if (JSON.stringify(lens.capsule).includes('local-delta')) throw new Error('CAPSULE_HYDRATED_DIFF');
  const dirtyPaths = lens.capsule.affected_files.map(file => file.path);
  if (dirtyPaths.join('|') !== 'note.txt') throw new Error(`LENS_PATH:${dirtyPaths.join('|')}`);
  if (lens.capsule.refs.code.join('|') !== 'note.txt') throw new Error('LENS_CODE_REF');
  if (lens.sourceMap.files.map(file => file.path).join('|') !== 'note.txt') throw new Error('LENS_SOURCE_MAP');
  if (lens.capsule.affected_files[0].code !== ' M') throw new Error(`LENS_XY:${JSON.stringify(lens.capsule.affected_files[0].code)}`);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (lens.capsule.base_commit !== head) throw new Error('LENS_COMMIT');
  const diffBytes = fs.readFileSync(lens.diffRef, 'utf8');
  if (sha256(diffBytes) !== lens.diffHash || diffBytes !== lens.diffText) throw new Error('LENS_DIFF_READBACK');

  const outDir = path.join(__dirname, '..', 'scratch', 'provider-v0-bootstrap-evidence', 'project-lens-v0');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'PROJECT_CAPSULE.json'), JSON.stringify(lens.capsule, null, 2));
  fs.writeFileSync(path.join(outDir, 'SOURCE_MAP.json'), JSON.stringify(lens.sourceMap, null, 2));
  fs.writeFileSync(path.join(outDir, 'GIT_STATE.json'), JSON.stringify(lens.gitState, null, 2));
  fs.writeFileSync(path.join(outDir, 'LATEST_RESULT_REFS.json'), JSON.stringify(lens.latestResultRefs, null, 2));
  fs.writeFileSync(path.join(outDir, 'DIFF_REF.txt'), `${lens.diffRef}\n${lens.diffHash}\n`);

  const adapter = new ChatGPTWebProviderAdapter();
  const keyBase = `lens-${path.basename(root)}`;
  let evidenceGiven = false;
  let workSpec = null;
  try {
    for (let turn = 1; turn <= 3 && !workSpec; turn += 1) {
      const objective = evidenceGiven
        ? [
          'You now have the exact diff and nothing else new.',
          'Reply with ONE JSON WorkSpec and no other text:',
          '{"action":"WORKSPEC","source_identity":{"base_commit":"...","diff_hash":"..."},"files":["<affected_files paths from the capsule>"],"objective":"short","done":true}',
          'files must be copied from the capsule affected_files paths. source_identity must copy the capsule.',
          `base_commit=${lens.capsule.base_commit}`,
          `diff_hash=${lens.diffHash}`,
          'DIFF:',
          lens.diffText.slice(0, 2000)
        ].join('\n')
        : [
          'You have a Project Capsule only. The diff body is not included.',
          'Reply with ONE JSON object and no other text.',
          'Request the missing diff as {"action":"REQUEST_EVIDENCE","ref":"<diff_ref>","done":false}.',
          'Do not emit WORKSPEC yet.',
          JSON.stringify(lens.capsule)
        ].join('\n');
      fs.writeFileSync(path.join(outDir, `turn-${turn}-prompt.txt`), objective);
      const result = await adapter.invokeCognition({
        run_id: `run:${keyBase}-${turn}`,
        objective,
        reasoning_type: 'PLAN',
        idempotency_key: `${keyBase}-turn-${turn}`,
        artifact_policy: 'INLINE',
        source_refs: [`git:${lens.capsule.base_commit}`]
      });
      fs.writeFileSync(path.join(outDir, `turn-${turn}-response.txt`), String(result.candidate_content || ''));
      let action;
      try {
        action = parseJson(result.candidate_content);
      } catch (err) {
        if (turn === 3) throw err;
        continue;
      }
      if (!evidenceGiven) {
        if (action.action !== 'REQUEST_EVIDENCE') throw new Error(`PROVIDER_OUTPUT_INVALID:${action.action || 'missing'}`);
        evidenceGiven = true;
        continue;
      }
      if (action.action !== 'WORKSPEC') {
        if (turn === 3) throw new Error(`PROVIDER_OUTPUT_INVALID:${action.action || 'missing'}`);
        continue;
      }
      const sameCommit = action.source_identity?.base_commit === lens.capsule.base_commit;
      const sameDiff = action.source_identity?.diff_hash === lens.diffHash;
      const sameFiles = Array.isArray(action.files) && action.files.join('|') === dirtyPaths.join('|');
      if (!sameCommit || !sameDiff || !sameFiles) {
        if (turn === 3) throw new Error(!sameCommit ? 'SOURCE_IDENTITY_MISMATCH' : (!sameDiff ? 'DIFF_HASH_MISMATCH' : 'FILES_MISMATCH'));
        continue;
      }
      workSpec = action;
    }
  } finally {
    await ChatGPTWebProviderAdapter.closeBrowser();
  }
  if (!workSpec) throw new Error('LOOP_LIMIT_REACHED');
  fs.writeFileSync(path.join(outDir, 'WORKSPEC.json'), JSON.stringify(workSpec, null, 2));
  process.stdout.write('PROJECT_LENS_V0_PASS: CONFIRMED\n');
  process.stdout.write(`FIXTURE ${root}\n`);
}

main().catch(err => {
  process.stderr.write(`LENS_FAIL ${err.message}\n`);
  process.exit(1);
});
