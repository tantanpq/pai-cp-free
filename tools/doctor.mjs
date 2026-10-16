#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const oneLine = value => String(value).replace(/[\r\n]+/g, ' ').trim();

function report(name, status, detail) {
  detail = oneLine(detail);
  checks.push({ name, status, detail });
  console.log(`[${status}] ${name} - ${detail}`);
}

async function check(name, run) {
  try {
    const [status, detail] = await run();
    report(name, status, detail);
  } catch (error) {
    report(name, 'FAIL', error.message);
  }
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else if (process.platform === 'linux') {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/meta-chromium/chrome', '/snap/bin/chromium');
  }
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

let tmp;
try {
  await check('node-version', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return [major > 22 || (major === 22 && minor >= 5) ? 'PASS' : 'FAIL', process.versions.node];
  });

  await check('playwright-core', () => {
    try {
      return ['PASS', createRequire(path.join(root, 'package.json')).resolve('playwright-core')];
    } catch {
      return ['FAIL', 'not installed - run: npm install'];
    }
  });

  await check('syntax', () => {
    const files = [
      'core/browser-control-plane-core/site.mjs',
      'core/browser-control-plane-core/primitives/primitives.mjs',
      'core/browser-control-plane-core/proto/runner.mjs',
      'core/browser-control-plane-core/proto/operations.mjs',
      'core/browser-control-plane-core/proto/lease-local.mjs',
      'core/browser-control-plane-core/watch/evidence.mjs',
      'core/browser-control-plane-core/observe-act/adapters/web.mjs',
      ...['chatgpt', 'github', 'grok', 'home', 'msi', 'rea', 'suno'].map(cp => `core/${cp}-cp/proto/run-action.mjs`),
      'gateway/server.standalone.cjs', 'seed/seed-uplink.js', 'seed/seed-cli.js',
      'tools/doctor.mjs', 'tools/quickstart.mjs', 'install.mjs',
    ].filter(file => fs.existsSync(path.join(root, file)));
    const bad = [];
    for (const file of files) {
      const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
      if (result.error || result.status !== 0) bad.push(file);
    }
    return bad.length ? ['FAIL', `bad files: ${bad.join(', ')}`] : ['PASS', `${files.length}/${files.length} files`];
  });

  await check('contract-probes', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-cp-doctor-'));
    const bad = [];
    let present = 0;
    for (const [cp, prefix] of [
      ['chatgpt', 'CHATGPT_CP'], ['github', 'GITHUB_CP'], ['grok', 'GROK_CP'],
      ['home', 'HOME_CP'], ['msi', 'MSI_CP'], ['rea', 'REA_CP'], ['suno', 'SUNO_CP'],
    ]) {
      const runner = path.join(root, 'core', `${cp}-cp`, 'proto', 'run-action.mjs');
      if (!fs.existsSync(runner)) continue;
      present++;
      const result = spawnSync(process.execPath, [runner], {
        input: '{"action":"__doctor_probe__"}',
        env: { ...process.env, [`${prefix}_DIR`]: path.join(tmp, cp), [`${prefix}_CDP`]: 'http://127.0.0.1:9' },
        timeout: 30000, encoding: 'utf8',
      });
      const stdout = (result.stdout || '').trim();
      try {
        // Runners exit 1 on any failure reply by design, so the error payload, not the exit code, distinguishes unknown actions from module-load failures.
        const reply = JSON.parse(stdout);
        if (reply?.ok !== false || !/^unknown action:/i.test(String(reply.error || ''))) {
          throw new Error('expected a genuine unknown-action rejection');
        }
      } catch (error) {
        bad.push(`${cp}: ${oneLine(error.message)} (${oneLine(stdout || result.stderr || '').slice(0, 300)})`);
      }
    }
    if (present === 0) return ['FAIL', 'no control planes found'];
    return bad.length ? ['FAIL', bad.join('; ')] : ['PASS', `${present}/${present} present CPs answer with a structured unknown-action error`];
  });

  await check('seed-tests', () => {
    const result = spawnSync(process.execPath, ['--test', path.join(root, 'gateway/chief_chat_bridge_v1/test/seed-uplink.test.js')], {
      cwd: root, encoding: 'utf8', timeout: 60000,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const pass = output.match(/pass (\d+)/)?.[1];
    const fail = output.match(/fail (\d+)/)?.[1];
    return Number(pass) === 9 && Number(fail) === 0 && !result.error
      ? ['PASS', 'seed-uplink 9/9']
      : ['FAIL', `pass=${pass ?? 'not found'} fail=${fail ?? 'not found'}${result.error ? ` (${result.error.message})` : ''}`];
  });

  await check('chrome', () => {
    const chrome = findChrome();
    return chrome ? ['PASS', chrome] : ['WARN', 'not found - browser actions need Chrome/Chromium (or point a CP at an already-running Chrome via its <PREFIX>_CDP env)'];
  });

  await check('cdp', async () => {
    if (!process.env.PAI_CP_CDP_URL) return ['SKIP', 'set PAI_CP_CDP_URL to probe a running Chrome'];
    try {
      const response = await fetch(process.env.PAI_CP_CDP_URL.replace(/\/$/, '') + '/json/list', { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      if (!Array.isArray(targets)) throw new Error('expected a target array');
      return ['PASS', `reachable (${targets.length} targets)`];
    } catch (error) {
      return ['WARN', `unreachable: ${error.message}`];
    }
  });
} finally {
  if (tmp) {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Best effort. */ }
  }
}

const pass = checks.filter(check => check.status === 'PASS').length;
const warn = checks.filter(check => check.status === 'WARN').length;
const fail = checks.filter(check => check.status === 'FAIL').length;
console.log(`DOCTOR_RESULT PASS=${pass} WARN=${warn} FAIL=${fail}`);
if (process.argv.includes('--json')) console.log(JSON.stringify({ pass, warn, fail, checks }));
process.exitCode = fail > 0 ? 1 : 0;
