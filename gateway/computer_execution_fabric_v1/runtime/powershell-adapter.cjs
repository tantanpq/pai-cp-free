'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const TERMINAL_MODE = 'POWERSHELL_PERSISTENT_PIPE_V0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const ROLLING_BUFFER_MAX = 2048;
const ROLLING_BUFFER_KEEP = 512;

function createPowerShellPipeAdapter(options = {}) {
  const timeoutMs = Math.min(Math.max(100, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const executable = options.executable || 'powershell.exe';
  let child = null;
  const listeners = new Set();
  let startedAt = null;
  let activeRolling = null;

  function emit(stream, chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (activeRolling) {
      activeRolling.append(buf);
    }
    for (const listener of listeners) {
      try {
        listener(stream, buf);
      } catch (_) {}
    }
  }

  function start({ cwd, env, scope } = {}) {
    if (child) throw new Error('ADAPTER_ALREADY_STARTED');
    for (const name of ['runtime-fs-guard.cjs', 'sitecustomize.py']) {
      const guardPath = path.join(__dirname, name);
      try {
        if (!fs.lstatSync(guardPath).isFile()) throw new Error('Regular file required');
        fs.accessSync(guardPath, fs.constants.R_OK);
      } catch (error) {
        throw new Error(`RUNTIME_GUARD_PREFLIGHT_FAILED: ${name}: ${error.message}`);
      }
    }
    startedAt = new Date().toISOString();

    const candidateScope = scope || (env && env.PAI_CANDIDATE_SCOPE) || (cwd || process.cwd());
    const nodeGuardPath = path.resolve(__dirname, 'runtime-fs-guard.cjs').replace(/\\/g, '/');
    const existingNodeOptions = (env && env.NODE_OPTIONS) || process.env.NODE_OPTIONS || '';
    const nodeOptions = existingNodeOptions
      ? `${existingNodeOptions} --require "${nodeGuardPath}"`
      : `--require "${nodeGuardPath}"`;

    const pythonPath = [__dirname, env?.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);

    child = spawn(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', '-'
    ], {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        ...(env || {}),
        PAI_CANDIDATE_SCOPE: candidateScope,
        NODE_OPTIONS: nodeOptions,
        PYTHONPATH: pythonPath,
        PYTHONIOENCODING: 'utf-8',
        TERM: 'dumb'
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.setDefaultEncoding('utf8');
    child.stdout.on('data', chunk => emit('stdout', chunk));
    child.stderr.on('data', chunk => emit('stderr', chunk));
    child.on('error', err => emit('stderr', Buffer.from(String(err.message || err))));

    // Initialize UTF-8 console and OS-level containment guards in persistent process
    try {
      const guardInitScript = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8;",
        "$OutputEncoding = [System.Text.Encoding]::UTF8;",
        "if ($env:PAI_CANDIDATE_SCOPE) {",
        "  $global:__pai_forbidden = @(",
        "    'c:\\users\\tom\\my drive\\pai_project\\core\\chief_chat_bridge_v1\\src',",
        "    'c:\\users\\tom\\my drive\\pai_project\\core\\chief_chat_bridge_v1\\contracts',",
        "    'c:\\users\\tom\\my drive\\pai_project\\core\\chief_chat_bridge_v1\\launchers',",
        "    'c:\\programdata\\pai_chief\\generations',",
        "    'c:\\programdata\\pai_chief\\launchers',",
        "    'c:\\windows'",
        "  );",
        "  function global:__pai_check_path([string]$p) {",
        "    if (-not $p) { return }",
        "    $full = [System.IO.Path]::GetFullPath($p).ToLowerInvariant();",
        "    foreach ($f in $global:__pai_forbidden) {",
        "      if ($full -eq $f -or $full.StartsWith($f + '\\') -or $full.StartsWith($f + '/')) {",
        "        throw \"HOST_CONTROL_SCOPE_DENIED: Write target '$p' is in protected Golden source\"",
        "      }",
        "    }",
        "    $scopeFull = [System.IO.Path]::GetFullPath($env:PAI_CANDIDATE_SCOPE).ToLowerInvariant();",
        "    $tmp = [System.IO.Path]::GetTempPath().ToLowerInvariant();",
        "    $ws = 'c:\\programdata\\pai_chief\\workspaces';",
        "    $isAllowed = ($full -eq $scopeFull -or $full.StartsWith($scopeFull + '\\') -or $full.StartsWith($scopeFull + '/') -or",
        "                  $full -eq $tmp -or $full.StartsWith($tmp) -or",
        "                  $full -eq $ws -or $full.StartsWith($ws + '\\'));",
        "    if (-not $isAllowed) {",
        "      throw \"HOST_CONTROL_SCOPE_DENIED: Write target '$p' is outside admitted candidate scope\"",
        "    }",
        "  }",
        "  function global:Set-Content { param([Parameter(ValueFromPipeline=$true)]$Value, [string]$Path, [string]$LiteralPath, [switch]$PassThru) $p = if ($Path) { $Path } else { $LiteralPath }; __pai_check_path $p; if ($PSBoundParameters.ContainsKey('Value')) { Microsoft.PowerShell.Management\\Set-Content @PSBoundParameters } else { $input | Microsoft.PowerShell.Management\\Set-Content @PSBoundParameters } }",
        "  function global:Add-Content { param([Parameter(ValueFromPipeline=$true)]$Value, [string]$Path, [string]$LiteralPath, [switch]$PassThru) $p = if ($Path) { $Path } else { $LiteralPath }; __pai_check_path $p; if ($PSBoundParameters.ContainsKey('Value')) { Microsoft.PowerShell.Management\\Add-Content @PSBoundParameters } else { $input | Microsoft.PowerShell.Management\\Add-Content @PSBoundParameters } }",
        "  function global:Out-File { param([Parameter(ValueFromPipeline=$true)]$InputObject, [string]$FilePath, [switch]$Append) __pai_check_path $FilePath; if ($PSBoundParameters.ContainsKey('InputObject')) { Microsoft.PowerShell.Utility\\Out-File @PSBoundParameters } else { $input | Microsoft.PowerShell.Utility\\Out-File @PSBoundParameters } }",
        "  function global:New-Item { param([string]$Path, [string]$Name, [string]$ItemType, $Value) $p = if ($Path) { $Path } else { $Name }; __pai_check_path $p; Microsoft.PowerShell.Management\\New-Item @PSBoundParameters }",
        "}"
      ].join("\r\n");
      const b64 = Buffer.from(guardInitScript, 'utf8').toString('base64');
      child.stdin.write(`Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))\r\n`);
    } catch (_) {}

    return {
      pid: child.pid,
      terminal_mode: TERMINAL_MODE,
      startedAt
    };
  }

  function onData(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function writeRaw(text) {
    if (!child || !child.stdin || !child.stdin.writable) throw new Error('ADAPTER_STDIN_CLOSED');
    child.stdin.write(String(text));
  }

  function waitForMarker(marker, budgetMs) {
    const needle = Buffer.from(marker, 'utf8');
    const deadline = Date.now() + budgetMs;

    return new Promise((resolve) => {
      let resolved = false;
      let checkTimer = null;
      let failTimer = null;

      const rolling = {
        buf: Buffer.alloc(0),
        append(chunk) {
          this.buf = Buffer.concat([this.buf, chunk]);
          if (this.buf.length > ROLLING_BUFFER_MAX) {
            this.buf = this.buf.subarray(this.buf.length - ROLLING_BUFFER_KEEP);
          }
          check();
        }
      };

      activeRolling = rolling;

      function finish(result) {
        if (resolved) return;
        resolved = true;
        if (checkTimer) clearInterval(checkTimer);
        if (failTimer) clearTimeout(failTimer);
        if (activeRolling === rolling) activeRolling = null;
        resolve(result);
      }

      function check() {
        if (resolved) return true;
        if (rolling.buf.includes(needle)) {
          finish({ found: true, killed: false, status: 'SUCCESS' });
          return true;
        }
        if (!child || child.exitCode !== null) {
          finish({
            found: false,
            killed: false,
            exitCode: child ? child.exitCode : -1,
            status: 'PROCESS_EXITED'
          });
          return true;
        }
        if (Date.now() >= deadline) {
          finish({
            found: false,
            killed: false,
            timeout: true,
            status: 'INPUT_COMPLETION_UNVERIFIED'
          });
          return true;
        }
        return false;
      }

      checkTimer = setInterval(check, 25);
      failTimer = setTimeout(() => {
        check();
        finish({
          found: false,
          killed: false,
          timeout: true,
          status: 'INPUT_COMPLETION_UNVERIFIED'
        });
      }, budgetMs + 20);

      // Initial check in case output was synchronous
      check();
    });
  }

  async function runBlock(script, budgetMs = timeoutMs) {
    if (!child || !child.stdin || !child.stdin.writable) throw new Error('ADAPTER_STDIN_CLOSED');
    const marker = `PAI_SENTINEL_${crypto.randomBytes(16).toString('hex')}`;
    const payload = String(script || '');
    const b64 = Buffer.from(payload, 'utf8').toString('base64');
    const wrapped = [
      `$__pai = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
      'try { Invoke-Expression $__pai } catch { $_ | Out-String | Write-Output }',
      `Write-Output '${marker}'`,
      ''
    ].join('\r\n');

    writeRaw(wrapped);
    const wait = await waitForMarker(marker, budgetMs);
    return { marker, ...wait, pid: child && child.pid };
  }

  function stop() {
    if (!child) return { pid: null, already: true };
    const pid = child.pid;
    try {
      if (child.stdin && child.stdin.writable) child.stdin.end();
    } catch (_) {}
    return { pid, already: false };
  }

  return {
    terminal_mode: TERMINAL_MODE,
    start,
    stop,
    onData,
    writeRaw,
    runBlock,
    get pid() { return child && child.pid; },
    get child() { return child; },
    get startedAt() { return startedAt; }
  };
}

module.exports = { createPowerShellPipeAdapter, TERMINAL_MODE };
