#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipped = [];
const children = new Set();
const progress = (step, detail) => console.log(`[quickstart] step ${step}: ${detail}`);
let step = 'deps';
let tmp;

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

async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

function launch(command, args, options) {
  const child = spawn(command, args, { ...options, windowsHide: true });
  child.diagnostic = '';
  child.once('error', error => { child.spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', chunk => { child.diagnostic = (child.diagnostic + chunk).slice(-16000); });
  }
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    for (const child of children) killTree(child);
    process.exit(code);
  });
}

function isSignedOutObservation(error) {
  const text = String(error || '');
  if (!/^session check failed:/.test(text) || /checkSession error/i.test(text)) return false;
  try {
    const detail = JSON.parse(text.slice('session check failed:'.length).trim());
    return detail !== null && typeof detail === 'object' &&
      Number.isFinite(detail.loginButtons) && Number.isFinite(detail.avatarCount) &&
      detail.cloudflare !== true;
  } catch { return false; }
}

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null && !child.spawnError) {
    const closed = new Promise(resolve => child.once('close', resolve));
    killTree(child);
    // Let Windows release SQLite/profile handles before removing the workspace.
    await Promise.race([closed, delay(2000)]);
  }
  children.delete(child);
}

async function pollJson(url, child, validate) {
  const deadline = Date.now() + 20000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.spawnError) throw child.spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child exited before readiness: ${child.diagnostic}`);
    }
    try {
      const remaining = deadline - Date.now();
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, remaining))) });
      assert(response.ok, `HTTP ${response.status}`);
      const body = await response.json();
      validate(body);
      return body;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(400, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`readiness timeout: ${lastError?.message}; ${child.diagnostic}`);
}

function outputOf(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function lastReply(result) {
  if (result.error) throw result.error;
  const line = (result.stdout || '').split(/\r?\n/).filter(line => line.trim()).at(-1);
  return JSON.parse(line);
}

function seedCommand(...args) {
  const result = spawnSync(process.execPath, [path.join(root, 'seed/seed-cli.js'), ...args], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, outputOf(result));
  return JSON.parse(result.stdout);
}

try {
  progress(step, 'checking playwright-core');
  try {
    createRequire(path.join(root, 'package.json')).resolve('playwright-core');
  } catch {
    throw new Error('dependencies missing - run: npm install (or node install.mjs)');
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-cp-quickstart-'));

  step = 'doctor';
  progress(step, 'running package checks');
  const doctor = spawnSync(process.execPath, [path.join(root, 'tools/doctor.mjs')], { stdio: 'inherit', cwd: root });
  if (doctor.error) throw doctor.error;
  assert.equal(doctor.status, 0, `doctor exited ${doctor.status}`);

  step = 'seed-demo';
  progress(step, 'encoding, decoding, and preparing a candidate-only seed');
  // Use the validated example from seed-uplink.test.js; acceptance is an array
  // of strings, and intent must be one of seed-uplink.js's supported intents.
  const seed = {
    schema: 'pai-seed-uplink/v1', seedId: 'quickstart-demo-001', intent: 'BUILD',
    objective: 'Create a candidate-only PAI improvement.',
    acceptance: ['Emit a tested candidate.', 'Do not mutate live state.'],
    mutableScope: '06_STATE/PAI_SEED_UPLINK_V0', requestedMode: 'candidate-only',
    sourceRefs: ['drive:mission-001'], createdAt: '2026-09-24T00:00:00.000Z',
  };
  const seedFile = path.join(tmp, 'seed.json');
  fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  const encoded = seedCommand('encode', seedFile);
  assert.equal(typeof encoded.code, 'string');
  assert(encoded.code.startsWith('PAI-SEED-V1.'));
  const decoded = seedCommand('decode', encoded.code);
  assert.equal(decoded.seedId, 'quickstart-demo-001');
  assert.equal(decoded.schema, 'pai-seed-uplink/v1');
  const request = seedCommand('request', encoded.code);
  assert.match(request.seed_receipt.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(request.selected_provider_tool, 'CODEX_HOME');
  progress(step, `seed demo OK (fingerprint ${request.seed_receipt.fingerprint.slice(0, 12)}...)`);

  step = 'gateway-smoke';
  progress(step, 'starting an isolated gateway and checking MCP tools');
  const bridgePort = await freePort();
  let livePort = await freePort();
  while (livePort === bridgePort) livePort = await freePort();
  const server = launch(process.execPath, [path.join(root, 'gateway/server.standalone.cjs')], {
    cwd: root, stdio: 'pipe',
    env: { ...process.env, PORT: String(bridgePort), CHIEF_LIVE_PORT: String(livePort),
      CHIEF_BRIDGE_DB_PATH: path.join(tmp, 'bridge.sqlite'), CHIEF_BRIDGE_ALLOWED_ORIGINS: 'http://127.0.0.1',
      // The gateway defaults an empty action into provider dispatch. Keep this
      // malformed smoke request from invoking the user's installed AI CLIs.
      PAI_AGY_CLI_PATH: path.join(tmp, 'unconfigured-agy'),
      PAI_GROK_CLI_PATH: path.join(tmp, 'unconfigured-grok') },
  });
  try {
    const base = `http://127.0.0.1:${bridgePort}`;
    await pollJson(`${base}/health`, server, body => assert.equal(body.status, 'READY'));
    let sessionId;
    async function post(body, ignoreBody = false) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      }).catch(error => { throw new Error(`${body.method}${body.params?.name ? ` ${body.params.name}` : ''}: ${error.message}`); });
      if (body.method === 'initialize') sessionId = response.headers.get('mcp-session-id');
      if (ignoreBody) { await response.arrayBuffer(); return; }
      assert.equal(response.status, 200, `${body.method}: HTTP ${response.status}`);
      return response.json();
    }
    const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pai-cp-quickstart', version: '1.0.0' },
    } });
    assert(initialized.result, 'initialize must return result');
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, true).catch(() => {});
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = listed.result?.tools?.map(tool => tool.name) || [];
    assert(names.includes('pai_action_run') && names.includes('chief_status'), 'required MCP tools missing');
    const status = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chief_status', arguments: {} } });
    assert(status.result, 'chief_status must return result');
    const refused = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pai_cp_no_such_tool', arguments: {} } });
    assert(refused.error && typeof refused.error === 'object', 'unknown tool must return a JSON-RPC error');
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    assert(health.ok, `health HTTP ${health.status}`);
    assert.equal((await health.json()).status, 'READY');
    progress(step, 'PASS initialize, tools/list, chief_status, unknown-tool refusal, and final health');
  } finally {
    await stop(server);
  }

  step = 'browser-sample';
  progress(step, 'checking a fresh headless Chrome profile');
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('[SKIP] browser sample - no Chrome/Chromium found on this machine');
    skipped.push(step);
  } else {
    const port = await freePort();
    const chrome = launch(chromePath, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', 'about:blank',
    ], { stdio: 'ignore' });
    try {
      await pollJson(`http://127.0.0.1:${port}/json/list`, chrome, body => assert(Array.isArray(body), 'expected CDP target array'));
      const result = spawnSync(process.execPath, [path.join(root, 'core/github-cp/proto/run-action.mjs')], {
        input: '{"action":"session.check"}',
        env: { ...process.env, GITHUB_CP_DIR: path.join(tmp, 'github-cp'), GITHUB_CP_CDP: `http://127.0.0.1:${port}` },
        timeout: 60000, encoding: 'utf8',
      });
      try {
        const reply = lastReply(result);
        if (reply?.ok === true) {
          progress(step, `PASS github-cp session.check ok:true (user: ${reply.data?.user})`);
        } else if (reply?.ok === false && isSignedOutObservation(reply.error)) {
          progress(step, 'PASS browser path verified end-to-end; this fresh Chrome profile is not signed in to GitHub yet, so the CP refused by design (session gate). Sign in once in your CDP Chrome and the same command returns ok:true.');
        } else {
          throw new Error('unexpected session.check reply');
        }
      } catch (error) {
        throw new Error(`${error.message}: ${outputOf(result).slice(0, 300)}`);
      }
    } finally {
      await stop(chrome);
    }
  }

  step = 'windows-bonus';
  progress(step, 'checking Windows process enumeration');
  if (process.platform === 'win32') {
    const result = spawnSync(process.execPath, [path.join(root, 'core/msi-cp/proto/run-action.mjs')], {
      input: '{"action":"sys.processes"}', env: { ...process.env, MSI_CP_DIR: path.join(tmp, 'msi-cp') },
      timeout: 60000, encoding: 'utf8',
    });
    try {
      assert.equal(lastReply(result)?.ok, true);
      progress(step, 'PASS msi-cp sys.processes ok:true');
    } catch {
      progress(step, `WARN msi-cp sys.processes: ${(result.error?.message || outputOf(result) || 'no reply').replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
    }
  } else {
    console.log('[SKIP] windows-bonus - msi-cp sys.* actions are Windows-only');
    skipped.push(step);
  }
} catch (error) {
  progress(step, String(error.message).replace(/[\r\n]+/g, ' '));
  console.log(`QUICKSTART FAILED: ${step}`);
  process.exitCode = 1;
} finally {
  for (const child of children) await stop(child);
  if (tmp) {
    if (process.env.PAI_CP_QUICKSTART_KEEP === '1') {
      progress('cleanup', `keeping workspace ${tmp}`);
    } else {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        progress('cleanup', `WARN could not remove ${tmp}: ${error.message}`);
      }
    }
  }
}

if (!process.exitCode) {
  if (skipped.length) progress('complete', `skipped: ${skipped.join(', ')}`);
  console.log('QUICKSTART OK');
  process.exitCode = 0;
}
