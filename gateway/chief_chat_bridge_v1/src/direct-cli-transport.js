'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const CREATE_NO_WINDOW = 0x08000000;

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const STDOUT_CEILING = 256 * 1024;
const STDERR_CEILING = 128 * 1024;

function truncate(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, n) + `\n...[truncated ${t.length - n} bytes]`;
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function classifyProviderFailure({ exitCode, stderr, stdout, killed, missingBinary }) {
  if (missingBinary) return 'CLI_PROVIDER_UNAVAILABLE';
  if (killed) return 'CLI_TIMEOUT';

  const blob = `${stderr || ''}\n${stdout || ''}`.toLowerCase();
  if (/auth|login|unauthor|oidc|not signed|sign in/.test(blob)) {
    return 'CLI_AUTH_REQUIRED';
  }
  if (/quota|rate.?limit|exhausted|usage.?limit|insufficient.?credit|billing|hit your usage limit/.test(blob)) {
    return 'CLI_QUOTA_EXHAUSTED';
  }
  if (/service unavailable|503|bad gateway|502|connection refused|connect econnrefused/.test(blob)) {
    return 'CLI_PROVIDER_UNAVAILABLE';
  }
  if (exitCode !== 0) return 'CLI_EXECUTION_FAILED';
  return null;
}

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 8000,
      stdio: 'ignore'
    });
  } catch (_) {
    try { process.kill(pid, 'SIGKILL'); } catch (__) {}
  }
}

function assertWritableUnderScope(targetPath, mutableScope) {
  if (!mutableScope || mutableScope === 'NONE') {
    const err = new Error('CLI_SCOPE_DENIED: DIRECT_CLI_TRANSPORT requires a mutable scope for writes');
    err.code = 'CLI_SCOPE_DENIED';
    throw err;
  }
  const resolvedTarget = path.normalize(path.resolve(targetPath)).toLowerCase();
  const resolvedScope = path.normalize(path.resolve(mutableScope)).toLowerCase();
  if (resolvedTarget !== resolvedScope && !resolvedTarget.startsWith(resolvedScope + path.sep) && !resolvedTarget.startsWith(resolvedScope + '/')) {
    const err = new Error(`CLI_SCOPE_DENIED: write target outside mutable scope: ${targetPath}`);
    err.code = 'CLI_SCOPE_DENIED';
    throw err;
  }
}

function buildGrokArgs({ prompt, cwd, artifactPath }) {
  return [
    '-p', prompt,
    '--cwd', cwd,
    '--always-approve',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'json'
  ];
}

function buildAntigravityArgs({ prompt, cwd, mode = null }) {
  // agy.exe CLI flags:
  // For plan/no-effect mode: use least-privileged '--mode plan' without '--dangerously-skip-permissions'.
  // For mutable edits: use '--dangerously-skip-permissions'.
  if (mode === 'plan') {
    return [
      '-p', prompt,
      '--mode', 'plan',
      '--output-format', 'json'
    ];
  }
  return [
    '-p', prompt,
    '--dangerously-skip-permissions',
    '--output-format', 'json'
  ];
}

/**
 * Validate that an argument list for Antigravity does not contain invalid cwd flags.
 */
function assertValidAntigravityArgs(args) {
  for (const arg of args) {
    if (arg === '-cwd' || arg === '--cwd' || arg.startsWith('-cwd=') || arg.startsWith('--cwd=')) {
      const err = new Error(`INVALID_ANTIGRAVITY_SYNTAX: agy.exe does not accept "${arg}". Use process spawn cwd.`);
      err.code = 'INVALID_ANTIGRAVITY_SYNTAX';
      throw err;
    }
  }
}

/**
 * Run a provider CLI in an isolated child process boundary.
 * Does NOT join MCP Job Object when CREATE_BREAKAWAY_FROM_JOB is honored.
 */
function runDirectCliTransport(input = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const executorId = String(input.executorId || 'ANTIGRAVITY_CLI');
    const pinned = Boolean(input.pinned);
    const cliPath = String(input.cliPath || '');
    const cwd = String(input.cwd || process.cwd());
    const prompt = String(input.prompt || input.objective || '');
    const timeoutMs = Math.min(Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const receiptDir = String(input.receiptDir || path.join(cwd, '.direct-cli-receipts'));
    const expectedArtifact = input.expectedArtifactPath ? path.resolve(String(input.expectedArtifactPath)) : null;
    const mutableScope = input.mutableScope ? String(input.mutableScope) : null;
    const argsOverride = Array.isArray(input.args) ? input.args : null;

    const fail = (code, detail, extra = {}) => {
      resolve({
        ok: false,
        failure_code: code,
        detail: String(detail || code),
        executor: executorId,
        pinned,
        transport: 'DIRECT_CLI_TRANSPORT',
        cliPath: cliPath || null,
        pid: extra.pid || null,
        exit_code: extra.exit_code == null ? null : extra.exit_code,
        startedAt,
        completedAt: new Date().toISOString(),
        stdout_ref: extra.stdout_ref || null,
        stderr_ref: extra.stderr_ref || null,
        artifact_path: expectedArtifact,
        artifact_sha256: null,
        provider_version: extra.provider_version || null,
        synthetic: false,
        ...extra
      });
    };

    if (!cliPath) return fail('CLI_PROVIDER_UNAVAILABLE', 'cliPath missing');
    if (!fs.existsSync(cliPath)) return fail('CLI_PROVIDER_UNAVAILABLE', `binary not found: ${cliPath}`);
    if (!prompt) return fail('CLI_EXECUTION_FAILED', 'prompt/objective required');

    try {
      if (expectedArtifact && mutableScope) assertWritableUnderScope(expectedArtifact, mutableScope);
      fs.mkdirSync(receiptDir, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
    } catch (err) {
      return fail(err.code === 'CLI_SCOPE_DENIED' ? 'CLI_SCOPE_DENIED' : 'CLI_EXECUTION_FAILED', err.message);
    }

    const runId = crypto.randomBytes(8).toString('hex');
    const stdoutPath = path.join(receiptDir, `${runId}.stdout.txt`);
    const stderrPath = path.join(receiptDir, `${runId}.stderr.txt`);

    let args = argsOverride;
    if (!args) {
      if (executorId === 'GROK_CLI') {
        args = buildGrokArgs({ prompt, cwd, artifactPath: expectedArtifact });
      } else if (executorId === 'ANTIGRAVITY_CLI') {
        args = buildAntigravityArgs({ prompt, cwd });
      } else {
        args = ['-p', prompt];
      }
    }

    if (executorId === 'ANTIGRAVITY_CLI') {
      try {
        assertValidAntigravityArgs(args);
      } catch (err) {
        return fail(err.code, err.message);
      }
    }

    let stdout = '';
    let stderr = '';
    let killed = false;
    let childPid = null;

    const child = spawn(cliPath, args, {
      cwd,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsVerbatimArguments: false,
      ...(process.platform === 'win32'
        ? { windowsCreationFlags: CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW }
        : {})
    });

    childPid = child.pid || null;

    try { child.unref(); } catch (_) {}

    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(childPid);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > STDOUT_CEILING * 2) stdout = stdout.slice(0, STDOUT_CEILING * 2);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > STDERR_CEILING * 2) stderr = stderr.slice(0, STDERR_CEILING * 2);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const classified = classifyProviderFailure({
        exitCode: null,
        stderr: err.message,
        stdout: '',
        killed: false,
        missingBinary: err.code === 'ENOENT',
        executorId
      });
      fail(classified || 'CLI_PROVIDER_UNAVAILABLE', err.message, { pid: childPid });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const completedAt = new Date().toISOString();
      const exitCode = killed ? -1 : (code == null ? -1 : code);
      try { fs.writeFileSync(stdoutPath, truncate(stdout, STDOUT_CEILING), 'utf8'); } catch (_) {}
      try { fs.writeFileSync(stderrPath, truncate(stderr, STDERR_CEILING), 'utf8'); } catch (_) {}

      const classifiedFailure = classifyProviderFailure({
        exitCode,
        stderr,
        stdout,
        killed,
        missingBinary: false,
        executorId
      });

      if (classifiedFailure) {
        return resolve({
          ok: false,
          failure_code: classifiedFailure,
          detail: truncate(stderr || stdout || classifiedFailure, 2048),
          executor: executorId,
          pinned,
          transport: 'DIRECT_CLI_TRANSPORT',
          cliPath,
          pid: childPid,
          exit_code: exitCode,
          startedAt,
          completedAt,
          stdout_ref: stdoutPath,
          stderr_ref: stderrPath,
          artifact_path: expectedArtifact,
          artifact_sha256: null,
          synthetic: false
        });
      }

      const artifactSha256 = expectedArtifact ? sha256File(expectedArtifact) : null;
      resolve({
        ok: true,
        failure_code: null,
        detail: 'CLI execution succeeded',
        executor: executorId,
        pinned,
        transport: 'DIRECT_CLI_TRANSPORT',
        cliPath,
        pid: childPid,
        exit_code: exitCode,
        startedAt,
        completedAt,
        stdout_ref: stdoutPath,
        stderr_ref: stderrPath,
        artifact_path: expectedArtifact,
        artifact_sha256: artifactSha256,
        synthetic: false
      });
    });
  });
}

module.exports = {
  runDirectCliTransport,
  classifyProviderFailure,
  assertWritableUnderScope,
  buildGrokArgs,
  buildAntigravityArgs,
  assertValidAntigravityArgs
};
