'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    const err = new Error(`GIT_FAILED: ${args.join(' ')} ${result.stderr || ''}`.trim());
    err.code = 'GIT_FAILED';
    throw err;
  }
  return result.stdout || '';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const PORCELAIN_XY = new Set([' ', 'M', 'A', 'D', 'R', '?']);

function porcelainError(detail) {
  const err = new Error(`PORCELAIN_UNSUPPORTED${detail ? ': ' + detail : ''}`);
  err.code = 'PORCELAIN_UNSUPPORTED';
  return err;
}

function parsePorcelainLine(line) {
  if (line.length < 4 || line[2] !== ' ') throw porcelainError(JSON.stringify(line));
  const code = line.slice(0, 2);
  if (![...code].every(ch => PORCELAIN_XY.has(ch))) throw porcelainError(JSON.stringify(code));
  if (code === '??') return { code, path: line.slice(3), kind: 'untracked' };
  if (code.includes('?')) throw porcelainError(JSON.stringify(code));
  let rest = line.slice(3);
  let previousPath = null;
  if (code.includes('R')) {
    const arrow = rest.indexOf(' -> ');
    if (arrow < 0) throw porcelainError('rename missing arrow');
    previousPath = rest.slice(0, arrow);
    rest = rest.slice(arrow + 4);
  }
  if (!rest || rest.startsWith('"') || rest.includes(' -> ')) throw porcelainError('quoted or extra rename');
  let kind = 'modified';
  if (code.includes('A')) kind = 'added';
  else if (code.includes('D') && !code.includes('M') && !code.includes('A')) kind = 'deleted';
  else if (code.includes('R')) kind = 'renamed';
  return { code, path: rest, previous_path: previousPath, kind };
}

function parsePorcelain(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return raw.split('\n').filter(line => line.length > 0).map(parsePorcelainLine);
}

function allowedPaths(lens) {
  const paths = new Set();
  for (const file of lens.capsule.affected_files || []) paths.add(file.path);
  for (const file of lens.capsule.tracked_files || []) paths.add(file);
  return paths;
}

function assertLensPath(lens, relativePath) {
  const name = String(relativePath || '');
  if (!name || name.includes('..') || name.includes('\\') || name.includes('/') || name.includes(':')) {
    const err = new Error('SCOPE_DENIED');
    err.code = 'SCOPE_DENIED';
    throw err;
  }
  if (!allowedPaths(lens).has(name)) {
    const err = new Error(`SCOPE_DENIED: ${name}`);
    err.code = 'SCOPE_DENIED';
    throw err;
  }
  return name;
}

function buildProjectLens(root, options = {}) {
  const abs = path.resolve(root);
  const head = git(abs, ['rev-parse', 'HEAD']).trim();
  const porcelain = git(abs, ['status', '--porcelain']);
  const files = parsePorcelain(porcelain);
  const dirty = files.length > 0;
  const diff = dirty ? git(abs, ['diff', 'HEAD']) : '';
  const diffHash = dirty ? sha256(diff) : null;
  const tracked = git(abs, ['ls-files']).split(/\r?\n/).filter(Boolean);
  let diffRef = null;
  if (dirty) {
    const dir = path.join(os.tmpdir(), 'pai-lens-diffs');
    fs.mkdirSync(dir, { recursive: true });
    diffRef = path.join(dir, `${diffHash}.diff`).split('\\').join('/');
    if (!fs.existsSync(diffRef)) fs.writeFileSync(diffRef, diff, 'utf8');
  }
  const capsule = {
    schema: 'pai.project-capsule.v0',
    project_id: options.projectId || path.basename(abs),
    objective: options.objective || 'Describe the local delta. Do not assume unseen file bodies.',
    program: options.program || 'PAI_AI_FEDERATION',
    phase: options.phase || 'PROJECT_LENS_V0',
    acceptance: options.acceptance || 'PROJECT_LENS_V0_PASS',
    mission: options.mission || null,
    repo_root: abs,
    base_commit: head,
    worktree: dirty ? 'DIRTY' : 'CLEAN',
    diff_hash: diffHash,
    diff_ref: diffRef,
    source_lock: options.sourceLock || null,
    affected_files: files,
    tracked_files: tracked,
    latest_result_refs: options.resultRefs || [],
    blockers: options.blockers || [],
    tests: options.tests || [],
    refs: {
      architecture: options.architectureRef || 'drive:1KyccfUHvP3ViCmNyRNuw0reOy2f9VraouEFB0BHWjKU',
      code: files.map(file => file.path),
      runtime: 'local-git',
      results: options.resultRefs || []
    },
    privacy: 'LOCAL_ONLY',
    effect_ceiling: 'NONE',
    generated_at: new Date().toISOString()
  };
  capsule.capsule_digest = sha256(JSON.stringify(capsule));
  const sourceMap = {
    schema: 'pai.source-map.v0',
    base_commit: head,
    files
  };
  const gitState = {
    schema: 'pai.git-state.v0',
    base_commit: head,
    worktree: capsule.worktree,
    porcelain
  };
  return {
    capsule,
    sourceMap,
    gitState,
    diffRef,
    diffHash,
    diffText: diff,
    latestResultRefs: capsule.latest_result_refs
  };
}

module.exports = {
  buildProjectLens,
  sha256,
  parsePorcelain,
  parsePorcelainLine,
  allowedPaths,
  assertLensPath
};
