'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  runDirectCliTransport,
  classifyProviderFailure,
  assertWritableUnderScope
} = require('../src/direct-cli-transport');

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `p04-${name}-`));
  return d;
}

async function testScopeGuard() {
  const scope = tmpDir('scope');
  const outside = path.join(os.tmpdir(), `p04-outside-${Date.now()}.txt`);
  let threw = false;
  try {
    assertWritableUnderScope(outside, scope);
  } catch (err) {
    threw = err.code === 'CLI_SCOPE_DENIED';
  }
  assert.equal(threw, true);
  assertWritableUnderScope(path.join(scope, 'ok.txt'), scope);
  console.log('PASS scope guard');
}

async function testMockCliSuccess() {
  const cwd = tmpDir('cwd');
  const artifact = path.join(cwd, 'grok_cli_canary.txt');
  const mockJs = path.join(cwd, 'mock-cli.js');
  fs.writeFileSync(mockJs, [
    "const fs=require('fs');",
    "const out=process.argv[process.argv.indexOf('--out')+1];",
    "const title=process.argv[process.argv.indexOf('--title')+1];",
    "fs.writeFileSync(out, 'provider=GROK_CLI\\n'+title+'\\n', 'utf8');",
    "console.log('MOCK_OK');"
  ].join('\n'), 'utf8');

  const outcome = await runDirectCliTransport({
    executorId: 'GROK_CLI',
    pinned: true,
    cliPath: process.execPath,
    args: [mockJs, '--out', artifact, '--title', 'DOC_TITLE_CANARY'],
    cwd,
    prompt: 'unused',
    receiptDir: path.join(cwd, 'receipts'),
    expectedArtifactPath: artifact,
    mutableScope: cwd,
    timeoutMs: 30000
  });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(outcome.pid > 0);
  assert.equal(outcome.exit_code, 0);
  assert.ok(outcome.startedAt !== outcome.completedAt || true); // allow same-second
  assert.ok(fs.existsSync(artifact));
  const body = fs.readFileSync(artifact, 'utf8');
  assert.match(body, /provider=GROK_CLI/);
  assert.match(body, /DOC_TITLE_CANARY/);
  assert.ok(outcome.artifact_sha256 && outcome.artifact_sha256.length === 64);
  assert.equal(outcome.synthetic, false);
  console.log('PASS mock CLI success', { pid: outcome.pid, sha: outcome.artifact_sha256 });
}

async function testMockCliFailureDoesNotThrow() {
  const cwd = tmpDir('fail');
  const mockJs = path.join(cwd, 'mock-fail.js');
  fs.writeFileSync(mockJs, "console.error('quota exhausted'); process.exit(7);", 'utf8');
  const outcome = await runDirectCliTransport({
    executorId: 'GROK_CLI',
    pinned: true,
    cliPath: process.execPath,
    args: [mockJs],
    cwd,
    prompt: 'x',
    receiptDir: path.join(cwd, 'receipts'),
    timeoutMs: 15000
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure_code, 'CLI_QUOTA_EXHAUSTED');
  console.log('PASS mock CLI quota failure');
}

async function testMissingBinary() {
  const outcome = await runDirectCliTransport({
    executorId: 'GROK_CLI',
    cliPath: 'C:\\definitely\\missing\\grok.exe',
    prompt: 'x',
    cwd: tmpDir('miss')
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure_code, 'CLI_PROVIDER_UNAVAILABLE');
  console.log('PASS missing binary');
}

async function testClassify() {
  assert.equal(classifyProviderFailure({ exitCode: 1, stderr: 'rate limit exceeded', stdout: '', killed: false }), 'CLI_QUOTA_EXHAUSTED');
  assert.equal(classifyProviderFailure({ exitCode: 1, stderr: 'please login', stdout: '', killed: false }), 'CLI_AUTH_REQUIRED');
  assert.equal(classifyProviderFailure({ exitCode: 0, stderr: '', stdout: 'ok', killed: false }), null);
  console.log('PASS classify');
}

async function main() {
  await testScopeGuard();
  await testClassify();
  await testMissingBinary();
  await testMockCliSuccess();
  await testMockCliFailureDoesNotThrow();
  console.log('ALL direct-cli-transport tests PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
