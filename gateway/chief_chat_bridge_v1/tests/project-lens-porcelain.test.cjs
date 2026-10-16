'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parsePorcelain, buildProjectLens, assertLensPath } = require('../src/project-lens');

function fail(message) {
  process.stderr.write(`PORCELAIN_FAIL ${message}\n`);
  process.exit(1);
}

const legacyTrim = text => text.trim().split(/\r?\n/).filter(Boolean).map(line => line.slice(3).trim());
if (legacyTrim(' M note.txt')[0] !== 'ote.txt') fail('legacy defect fixture changed');
const parsed = parsePorcelain(' M note.txt\n');
if (parsed.length !== 1 || parsed[0].path !== 'note.txt' || parsed[0].code !== ' M') fail(JSON.stringify(parsed));
if (parsePorcelain('M  staged.js\n')[0].path !== 'staged.js') fail('index');
if (parsePorcelain('A  added.js\n')[0].kind !== 'added') fail('added');
if (parsePorcelain(' D gone.js\n')[0].kind !== 'deleted') fail('deleted');
if (parsePorcelain('?? fresh.js\n')[0].path !== 'fresh.js') fail('untracked');
const renamed = parsePorcelain('R  old.js -> new.js\n')[0];
if (renamed.path !== 'new.js' || renamed.previous_path !== 'old.js') fail('rename');
let unsupported = false;
try { parsePorcelain('UU both.js\n'); } catch (err) { unsupported = err.code === 'PORCELAIN_UNSUPPORTED'; }
if (!unsupported) fail('unsupported porcelain was accepted');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-porcelain-'));
const git = args => {
  const result = spawnSync('git', ['-c', 'user.email=lens@local', '-c', 'user.name=lens', ...args], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail(result.stderr || 'git');
};
spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
fs.writeFileSync(path.join(root, 'note.txt'), 'accepted\n');
git(['add', 'note.txt']);
git(['commit', '-m', 'accepted']);
fs.appendFileSync(path.join(root, 'note.txt'), 'local-delta\n');
const lens = buildProjectLens(root, { projectId: 'porcelain' });
if (lens.capsule.affected_files.map(file => file.path).join('|') !== 'note.txt') fail('live lens path');
if (lens.capsule.affected_files[0].code !== ' M') fail('live lens xy');
let denied = false;
try { assertLensPath(lens, 'ote.txt'); } catch (err) { denied = err.code === 'SCOPE_DENIED'; }
if (!denied) fail('corrupted path was admitted');
try { assertLensPath(lens, 'note.txt'); } catch (_) { fail('real path denied'); }

process.stdout.write('PROJECT_LENS_PORCELAIN: PASS\n');
