'use strict';

// Run the packaged, self-contained suites without inheriting operator config.
// All temporary/home-derived test state stays under gateway/.offline-fixtures.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixtureRoot = path.join(root, '.offline-fixtures');
fs.mkdirSync(fixtureRoot, { recursive: true });
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { TEMP: fixtureRoot, TMP: fixtureRoot, HOME: fixtureRoot, USERPROFILE: fixtureRoot, LOCALAPPDATA: fixtureRoot, APPDATA: fixtureRoot, PROGRAMDATA: fixtureRoot });
// The full upstream npm suite imports packages and fixture trees omitted from
// this public subset. Keep this list limited to the bundled offline suites.
const bridge = [
  'canonical-truth-adapter', 'chief-conversation-experience',
  'context-economy-successor', 'jit-tool-projection', 'retrieval-guard',
  'bounded-fetch-verification', 'project-status-truth', 'notebook-projection'
].map(name => `chief_chat_bridge_v1/tests/${name}.test.js`);
bridge.push('chief_chat_bridge_v1/test/seed-uplink.test.js');
bridge.push('chief_chat_bridge_v1/tests/project-lens-porcelain.test.cjs', 'chief_chat_bridge_v1/tests/governed-edit-progress.test.cjs');
const fabric = ['bridge-adapter', 'cleanup', 'crash-recovery', 'host-routing', 'human-takeover', 'output-pressure', 'process-tree', 'reaper', 'resource-budget', 'session-runtime']
  .map(name => `computer_execution_fabric_v1/tests/${name}.test.cjs`);
if (process.argv.includes('--security')) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/standalone-security.test.cjs'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status === 0 ? 0 : 1);
}
let pass = 0, fail = 0;
for (const file of [...bridge, ...fabric]) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  const output = (result.stdout || '') + (result.stderr || '');
  const passed = Number(output.match(/^# pass (\d+)$/m)?.[1] || 0);
  const failed = Number(output.match(/^# fail (\d+)$/m)?.[1] || (result.status === 0 ? 0 : 1));
  pass += passed;
  fail += failed;
  console.log(`${file}: pass=${passed} fail=${failed} exit=${result.status}`);
  if (result.status !== 0) console.log(output.split(/\r?\n/).filter(line => /Error:|error:|code:|Cannot find|^not ok|^# fail/.test(line)).map(line => line.replaceAll(root, '<gateway>')).join('\n'));
}
console.log(`OFFLINE_TOTAL suites=${bridge.length + fabric.length} pass=${pass} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
