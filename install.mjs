#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const oneLine = value => String(value).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
const progress = (step, detail) => console.log(`[install] step ${step}: ${oneLine(detail)}`);
let step = 'node';

function checkChild(result, name) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${name} ${result.signal ? `terminated by signal ${result.signal}` : `exited with status ${result.status}`}`);
  }
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  progress(step, `checking Node ${process.versions.node}`);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`Node >= 22.5 is required; found ${process.versions.node}`);
  }

  step = 'deps';
  let installed = false;
  try {
    require.resolve('playwright-core');
    installed = true;
  } catch { /* Install missing dependencies below. */ }
  if (installed) {
    progress(step, 'already installed');
  } else {
    progress(step, 'installing dependencies with npm');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'], {
      cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (result.error) {
      throw new Error('npm not found - install Node.js >= 22.5 (npm is bundled) and re-run node install.mjs');
    }
    checkChild(result, 'npm install');
    try {
      require.resolve('playwright-core');
    } catch {
      throw new Error('playwright-core is still missing after npm install');
    }
    progress(step, 'dependencies installed');
  }

  step = 'doctor';
  progress(step, 'running package checks');
  checkChild(spawnSync(process.execPath, [path.join(root, 'tools/doctor.mjs')], {
    cwd: root, stdio: 'inherit',
  }), 'doctor');

  step = 'quickstart';
  progress(step, 'running end-to-end checks');
  checkChild(spawnSync(process.execPath, [path.join(root, 'tools/quickstart.mjs')], {
    cwd: root, stdio: 'inherit',
  }), 'quickstart');

  console.log('Verified: doctor PASS; QUICKSTART OK.');
  console.log(`PAI_CP_INSTALL_RESULT ${JSON.stringify({
    ok: true, version: '1.0.0', node: process.versions.node,
    deps: 'installed-or-present', doctor: 'PASS', quickstart: 'OK',
  })}`);
  process.exitCode = 0;
} catch (error) {
  const message = oneLine(error?.message ?? error);
  progress(step, message);
  console.log(`PAI_CP_INSTALL_RESULT ${JSON.stringify({ ok: false, step, error: message })}`);
  process.exitCode = 1;
}
