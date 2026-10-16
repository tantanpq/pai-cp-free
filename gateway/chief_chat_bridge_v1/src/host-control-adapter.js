'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ─────────────────────────────────────────────────────────────────────────────
// Governed Host Control Adapter
// Internal only — NEVER exposed as MCP tool.
// Routes through Federation → pai_action_run → this adapter.
// ─────────────────────────────────────────────────────────────────────────────

const STDOUT_CEILING = 8192;
const STDERR_CEILING = 2048;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;

const EVIDENCE_DIR = path.join(os.tmpdir(), 'pai_host_control');

// ── Host Control Intents ────────────────────────────────────────────────────
const HOST_CONTROL_INTENTS = new Set([
  'HOST_INSPECT',
  'TERMINAL_COMMAND',
  'FILESYSTEM_READ',
  'FILESYSTEM_EDIT',
  'SERVICE_CONTROL',
  'PROCESS_CONTROL'
]);

// ── Authority Classes ───────────────────────────────────────────────────────
const AUTHORITY_CLASS = Object.freeze({
  A: 'READ_ONLY_OBSERVATION',      // NO_MATERIAL_DELTA — auto-admit
  B: 'REVERSIBLE_CANDIDATE',       // CANDIDATE_DRAFT — bounded mutable scope
  C: 'REVERSIBLE_SERVICE_CONTROL', // REVERSIBLE_LOCAL_EFFECT — named target
  D: 'CONSEQUENTIAL'               // Human gate required
});

// ── Class A: Read-only commands (auto-admissible) ───────────────────────────
const COMMAND_ALLOW_LIST_CLASS_A = Object.freeze([
  'hostname',
  'whoami',
  '[System.Environment]::OSVersion',
  'Get-ComputerInfo',
  'Get-Process',
  'Get-Service',
  'Get-Item',
  'Get-ChildItem',
  'Get-Content',
  'Get-NetTCPConnection',
  'Test-Path',
  'Get-FileHash',
  'Get-CimInstance',
  'Get-Date',
  'Get-Host',
  'Get-Volume',
  'Get-Disk',
  'Get-PSDrive',
  'Get-WmiObject',
  'Measure-Object',
  'Select-Object',
  'Where-Object',
  'Format-List',
  'Format-Table',
  'Sort-Object',
  'Out-String',
  'ConvertTo-Json',
  'node --version',
  'node -v',
  'npm --version',
  'npm -v',
  'git --version',
  'git status',
  'git log',
  'systeminfo',
  'ipconfig',
  'tasklist',
  'wmic',
  'dir',
  'type',
  'cat',
  'echo',
  'node --test',
  'node',
  'npm test',
  'npm',
  'git diff',
  'Select-String'
]);

// ── Hard-deny commands (Class D or forbidden entirely) ──────────────────────
const COMMAND_DENY_LIST = Object.freeze([
  'format [A-Z]:',
  'diskpart',
  'Remove-Item.*-Recurse.*C:\\\\',
  'Remove-Item.*-Recurse.*C:/',
  'Remove-Item.*-Recurse.*\\$env:SystemRoot',
  'Remove-Item.*-Force.*-Recurse',
  'rd /s',
  'rmdir /s',
  'del /f /s /q C:',
  'reg delete',
  'reg add.*HKLM',
  'Set-ItemProperty.*HKLM',
  'Remove-ItemProperty.*HKLM',
  'New-ItemProperty.*HKLM',
  'Disable-NetAdapter',
  'Disable-NetFirewallRule',
  'Set-NetFirewallProfile.*-Enabled.*False',
  'Stop-Computer',
  'Restart-Computer',
  'Clear-EventLog',
  'Remove-EventLog',
  'ConvertTo-SecureString',
  'Get-Credential',
  'Get-StoredCredential',
  'Get-VaultCredential',
  'cmdkey',
  'klist',
  'certutil.*-exportPFX',
  'Export-PfxCertificate',
  'Import-Certificate.*Root',
  'New-SelfSignedCertificate.*Root',
  'Set-ExecutionPolicy.*Unrestricted',
  'schtasks.*/(create|change).*SYSTEM',
  'net user.*\\/add',
  'net localgroup.*administrators.*\\/add',
  'Invoke-WebRequest',
  'Invoke-RestMethod',
  'Start-BitsTransfer',
  'curl',
  'wget',
  'Compress-Archive.*Password'
]);

// ── Allowed filesystem roots for read operations ────────────────────────────
const ALLOWED_READ_ROOTS = Object.freeze([
  'C:\\ProgramData\\PAI_RUNTIME',
  'C:\\ProgramData\\PAI_SIMPLE_BODY_R1',
  'C:\\ProgramData\\PAI_CHIEF',
  'C:\\ProgramData\\PAI_NODE_RUNTIME',
  'C:\\ProgramData\\PAI_WORKER_TRANSPORT',
  'C:\\ProgramData\\PAI_P341_WORKER_TRANSPORT',
  path.join(os.homedir(), 'My Drive'),
  path.join(os.homedir(), '.gemini'),
  path.join(os.homedir(), '.grok'),
  os.homedir(),
  os.tmpdir()
]);

// ── Allowed filesystem roots for write operations ───────────────────────────
const ALLOWED_WRITE_ROOTS = Object.freeze([
  path.join(os.tmpdir(), 'pai_host_control'),
  path.join(os.tmpdir(), 'pai_host_canary_ws'),
  path.join(os.tmpdir(), 'pai_candidate_workspaces'),
  'C:\\ProgramData\\PAI_RUNTIME\\receipts',
  'C:\\ProgramData\\PAI_CHIEF\\workspaces'
]);

// ── Forbidden filesystem roots for write operations (Fail-closed Negative Boundary) ──
const FORBIDDEN_WRITE_ROOTS = Object.freeze([
  path.resolve(__dirname, '..', 'src'),
  path.resolve(__dirname, '..', 'contracts'),
  path.resolve(__dirname, '..', 'launchers'),
  path.join(os.homedir(), 'My Drive', 'PAI_PROJECT', 'CORE', 'chief_chat_bridge_v1', 'src'),
  path.join(os.homedir(), 'My Drive', 'PAI_PROJECT', 'CORE', 'chief_chat_bridge_v1', 'contracts'),
  path.join(os.homedir(), 'My Drive', 'PAI_PROJECT', 'CORE', 'chief_chat_bridge_v1', 'launchers'),
  path.join(os.homedir(), 'My Drive', 'PAI_PROJECT', 'CORE', 'computer_execution_fabric_v1', 'runtime'),
  'C:\\ProgramData\\PAI_CHIEF\\generations',
  'C:\\ProgramData\\PAI_CHIEF\\launchers',
  'C:\\Windows',
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.azure')
]);

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function generateOperationId() {
  return `hc_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeCommand(cmd) {
  return String(cmd || '').trim().replace(/\s+/g, ' ');
}

function matchesDenyList(command) {
  const normalized = normalizeCommand(command).toLowerCase();
  for (const pattern of COMMAND_DENY_LIST) {
    try {
      if (new RegExp(pattern, 'i').test(normalized)) {
        return { denied: true, pattern };
      }
    } catch (_) {
      if (normalized.includes(pattern.toLowerCase())) {
        return { denied: true, pattern };
      }
    }
  }
  return { denied: false };
}

function matchesAllowList(command) {
  const normalized = normalizeCommand(command);
  for (const allowed of COMMAND_ALLOW_LIST_CLASS_A) {
    if (normalized.startsWith(allowed) || normalized.toLowerCase().startsWith(allowed.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function classifyAuthorityClass(intent, effectClass, command) {
  const ec = String(effectClass || '').toUpperCase();
  const i = String(intent || '').toUpperCase();

  if (ec === 'NO_MATERIAL_DELTA' || ec === 'READ_ONLY' || i === 'HOST_INSPECT') {
    return 'A';
  }
  if (ec === 'CANDIDATE_DRAFT' || i === 'FILESYSTEM_EDIT') {
    return 'B';
  }
  if (ec === 'REVERSIBLE_LOCAL_EFFECT' || i === 'SERVICE_CONTROL' || i === 'PROCESS_CONTROL') {
    return 'C';
  }
  return 'D';
}

function isPathWithinRoots(filePath, allowedRoots, baseCwd = process.cwd()) {
  if (!filePath || typeof filePath !== 'string') return false;

  let resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(baseCwd, filePath);

  // Check realpath to prevent symlink/junction/reparse escapes
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync(resolved);
    } else {
      let cur = path.dirname(resolved);
      while (cur && cur !== path.dirname(cur)) {
        if (fs.existsSync(cur)) {
          const realCur = fs.realpathSync(cur);
          resolved = path.join(realCur, path.relative(cur, resolved));
          break;
        }
        cur = path.dirname(cur);
      }
    }
  } catch (_) {}

  const normResolved = path.normalize(resolved).toLowerCase();

  // 1. Strict Negative Check: Check against FORBIDDEN_WRITE_ROOTS first
  for (const forbidden of FORBIDDEN_WRITE_ROOTS) {
    if (!forbidden || typeof forbidden !== 'string') continue;
    const normForbidden = path.normalize(path.resolve(forbidden)).toLowerCase();
    if (normResolved === normForbidden || normResolved.startsWith(normForbidden + path.sep) || normResolved.startsWith(normForbidden + '/')) {
      return false;
    }
  }

  // 2. Positive Scope Check
  for (const root of allowedRoots) {
    if (!root || typeof root !== 'string') continue;
    let resolvedRoot = path.resolve(root);
    try {
      if (fs.existsSync(resolvedRoot)) {
        resolvedRoot = fs.realpathSync(resolvedRoot);
      }
    } catch (_) {}
    const normRoot = path.normalize(resolvedRoot).toLowerCase();
    if (normResolved === normRoot || normResolved.startsWith(normRoot + path.sep) || normResolved.startsWith(normRoot + '/')) {
      return true;
    }
  }

  return false;
}

function extractWritePaths(cmd) {
  const paths = [];
  if (!cmd || typeof cmd !== 'string') return paths;

  // 1. Explicit -Path / -LiteralPath / -FilePath
  const explicitPath = /(?:Set-Content|Add-Content|Out-File|New-Item|Clear-Content|sc|ac)\b.*-(?:Path|LiteralPath|FilePath)\s+(?:'([^']+)'|"([^"]+)"|([^\s|;]+))/gi;
  let m;
  while ((m = explicitPath.exec(cmd)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (p && !p.startsWith('-')) paths.push(p.trim());
  }

  // 2. Positional argument: Set-Content 'path' or ... | Set-Content 'path'
  const positionalPath = /(?:Set-Content|Add-Content|Out-File|New-Item|Clear-Content|sc|ac)\s+(?:'([^']+)'|"([^"]+)"|([^\s-|;][^\s|;]*))/gi;
  while ((m = positionalPath.exec(cmd)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (p && !p.startsWith('-')) paths.push(p.trim());
  }

  // 3. Redirection > and >>
  const redirs = /(?:>>|>)\s*(?:'([^']+)'|"([^"]+)"|([^\s|;]+))/g;
  while ((m = redirs.exec(cmd)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (p && !p.startsWith('-') && !/^\d+$/.test(p)) paths.push(p.trim());
  }

  // 4. .NET File writes
  const dotnet = /\[System\.IO\.File\]::(?:WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|Create|OpenWrite)\s*\(\s*(?:'([^']+)'|"([^"]+)")/gi;
  while ((m = dotnet.exec(cmd)) !== null) {
    const p = m[1] || m[2];
    if (p) paths.push(p.trim());
  }

  // 5. Copy-Item / Move-Item -Destination
  const transfer = /(?:Copy-Item|Move-Item|cp|copy|mv|move)\b.*-(?:Destination|Target)\s+(?:'([^']+)'|"([^"]+)"|([^\s|;]+))/gi;
  while ((m = transfer.exec(cmd)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (p && !p.startsWith('-')) paths.push(p.trim());
  }

  // 6. Node.js fs writes: fs.writeFileSync, require('fs').writeFileSync, promises.writeFile
  const nodeWrites = /(?:fs|fsp|promises)\.(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/gi;
  while ((m = nodeWrites.exec(cmd)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (p) paths.push(p.trim());
  }
  const reqFsWrites = /require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)\.(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/gi;
  while ((m = reqFsWrites.exec(cmd)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (p) paths.push(p.trim());
  }

  // 7. Python file writes: open('...', 'w'/'a'/'wb'/'a+'), Path('...').write_text / write_bytes
  const pyOpen = /\bopen\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*,\s*(?:'([wa][b+]?)'|"([wa][b+])")/gi;
  while ((m = pyOpen.exec(cmd)) !== null) {
    const p = m[1] || m[2];
    if (p) paths.push(p.trim());
  }
  const pyPathWrite = /\bPath\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*\)\.(?:write_text|write_bytes)/gi;
  while ((m = pyPathWrite.exec(cmd)) !== null) {
    const p = m[1] || m[2];
    if (p) paths.push(p.trim());
  }

  // 8. Symlink / Junction creation: mklink, New-Item -ItemType SymbolicLink/Junction
  const mklink = /(?:mklink\s+(?:\/d|\/j|\/h)?\s+|(?:New-Item\b.*-(?:ItemType|Type)\s+(?:SymbolicLink|Junction)\b.*-(?:Path|LiteralPath)\s+))(?:'([^']+)'|"([^"]+)"|([^\s|;]+))/gi;
  while ((m = mklink.exec(cmd)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (p && !p.startsWith('-')) paths.push(p.trim());
  }

  return paths;
}

function truncateOutput(text, ceiling) {
  if (!text || text.length <= ceiling) return text || '';
  return text.slice(0, ceiling) + `\n[TRUNCATED: ${text.length - ceiling} bytes omitted]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency Ledger
// ─────────────────────────────────────────────────────────────────────────────

class IdempotencyLedger {
  constructor() {
    this._ledger = new Map();
  }

  has(requestId) {
    return this._ledger.has(requestId);
  }

  get(requestId) {
    return this._ledger.get(requestId) || null;
  }

  set(requestId, receipt) {
    this._ledger.set(requestId, { receipt, storedAt: new Date().toISOString() });
  }

  isMutation(authorityClass) {
    return authorityClass !== 'A';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Manager
// ─────────────────────────────────────────────────────────────────────────────

class HostControlSessionManager {
  constructor() {
    this._sessions = new Map();
  }

  create({ owner, scope, cwd, effectCeiling = 'READ_ONLY', expiryMs = 600000 }) {
    const sessionId = `hcs_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const session = {
      session_id: sessionId,
      host: 'HOME',
      owner,
      scope,
      cwd: cwd || process.cwd(),
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + expiryMs).toISOString(),
      effectCeiling,
      commandCount: 0
    };
    this._sessions.set(sessionId, session);
    return session;
  }

  get(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    if (new Date(session.expiresAt) < new Date()) {
      this._sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  touch(sessionId) {
    const session = this.get(sessionId);
    if (session) {
      session.lastUsedAt = new Date().toISOString();
      session.commandCount += 1;
    }
    return session;
  }

  expire(sessionId) {
    return this._sessions.delete(sessionId);
  }

  expireStale() {
    const now = new Date();
    for (const [id, session] of this._sessions) {
      if (new Date(session.expiresAt) < now) {
        this._sessions.delete(id);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PowerShell Executor (internal — never exposed as MCP)
// ─────────────────────────────────────────────────────────────────────────────

function executePowerShell({ command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, networkDeny = true }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', command
    ];

    const startedAt = new Date().toISOString();
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn('powershell.exe', args, {
      cwd: cwd || process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: networkDeny ? { ...process.env, HTTP_PROXY: 'http://0.0.0.0:1', HTTPS_PROXY: 'http://0.0.0.0:1' } : process.env
    });

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 2000);
    }, Math.min(timeoutMs, MAX_TIMEOUT_MS));

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > STDOUT_CEILING * 2) {
        // Hard cap to prevent memory issues
        stdout = stdout.slice(0, STDOUT_CEILING * 2);
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > STDERR_CEILING * 2) {
        stderr = stderr.slice(0, STDERR_CEILING * 2);
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`POWERSHELL_SPAWN_FAILED: ${err.message}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        exit_code: killed ? -1 : (code ?? -1),
        stdout: truncateOutput(stdout.trim(), STDOUT_CEILING),
        stderr: truncateOutput(stderr.trim(), STDERR_CEILING),
        startedAt,
        completedAt: new Date().toISOString(),
        killed,
        pid: child.pid
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Reducer — terminal output → bounded receipt
// ─────────────────────────────────────────────────────────────────────────────

function reduceToReceipt(operationId, request, execResult, authorityClass) {
  const keyOutput = (() => {
    const lines = (execResult.stdout || '').split('\n').filter(l => l.trim());
    if (lines.length <= 10) return lines.join('\n');
    return lines.slice(0, 8).join('\n') + `\n... (${lines.length - 8} more lines)`;
  })();

  return Object.freeze({
    operation_id: operationId,
    request_id: request.request_id,
    status: execResult.exit_code === 0 ? 'SUCCESS' : (execResult.killed ? 'TIMEOUT' : 'FAILED'),
    host: 'HOME',
    host_id: 'HOME_SIMPLE_BODY_01',
    intent: request.intent,
    operation: request.command || request.objective,
    effect_class: request.effect_class,
    authority_class: authorityClass,
    exit_code: execResult.exit_code,
    duration_ms: new Date(execResult.completedAt) - new Date(execResult.startedAt),
    key_output: keyOutput,
    output_ref: `file:///${EVIDENCE_DIR.replace(/\\/g, '/')}/${operationId}.txt`,
    stderr_summary: execResult.stderr ? execResult.stderr.slice(0, 200) : '',
    effect_receipt: authorityClass === 'A' ? 'NO_MATERIAL_DELTA' : 'BOUNDED_EFFECT',
    transport: 'PAI_HOST_CONTROL',
    rdc_dependency: false,
    startedAt: execResult.startedAt,
    completedAt: execResult.completedAt
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence Writer
// ─────────────────────────────────────────────────────────────────────────────

function writeEvidence(operationId, receipt, execResult) {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const evidenceFile = path.join(EVIDENCE_DIR, `${operationId}.txt`);
    const content = [
      `# Host Control Evidence`,
      `operation_id: ${operationId}`,
      `request_id: ${receipt.request_id}`,
      `host: ${receipt.host}`,
      `intent: ${receipt.intent}`,
      `command: ${receipt.operation}`,
      `exit_code: ${receipt.exit_code}`,
      `authority_class: ${receipt.authority_class}`,
      `startedAt: ${receipt.startedAt}`,
      `completedAt: ${receipt.completedAt}`,
      `duration_ms: ${receipt.duration_ms}`,
      `---`,
      `STDOUT:`,
      execResult.stdout || '(empty)',
      `---`,
      `STDERR:`,
      execResult.stderr || '(empty)'
    ].join('\n') + '\n';
    fs.writeFileSync(evidenceFile, content, 'utf8');
    return evidenceFile;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GovernedHostControlAdapter — main class
// ─────────────────────────────────────────────────────────────────────────────

class GovernedHostControlAdapter {
  constructor(options = {}) {
    this.idempotencyLedger = new IdempotencyLedger();
    this.sessionManager = new HostControlSessionManager();
    this.hostId = options.hostId || 'HOME_SIMPLE_BODY_01';
    this.os = process.platform;
  }

  isHostControlIntent(intent) {
    return HOST_CONTROL_INTENTS.has(String(intent || '').toUpperCase());
  }

  async execute(request) {
    const requestId = String(request.request_id || '').trim();
    if (!requestId) {
      throw new Error('HOST_CONTROL_REQUEST_ID_REQUIRED');
    }

    const intent = String(request.intent || '').toUpperCase();
    if (!HOST_CONTROL_INTENTS.has(intent)) {
      throw new Error(`HOST_CONTROL_UNKNOWN_INTENT: ${intent}`);
    }

    const effectClass = String(request.effect_class || 'NO_MATERIAL_DELTA').toUpperCase();
    const command = normalizeCommand(request.command || request.objective || '');
    if (!command) {
      throw new Error('HOST_CONTROL_COMMAND_REQUIRED');
    }

    // 1. Classify authority
    const authorityClass = classifyAuthorityClass(intent, effectClass, command);

    // 2. Check idempotency for mutations
    if (this.idempotencyLedger.isMutation(authorityClass) && this.idempotencyLedger.has(requestId)) {
      const existing = this.idempotencyLedger.get(requestId);
      return { ...existing.receipt, admission_state: 'IDEMPOTENT_REPLAY' };
    }

    // 3. Filesystem scope validation
    if (intent === 'FILESYSTEM_READ' && request.target_path) {
      if (!isPathWithinRoots(request.target_path, ALLOWED_READ_ROOTS)) {
        throw Object.assign(
          new Error('HOST_CONTROL_SCOPE_DENIED: Path outside allowed read roots'),
          { code: 'HOST_CONTROL_SCOPE_DENIED' }
        );
      }
    }

    const writePaths = extractWritePaths(command);
    if (request.target_path && (intent === 'FILESYSTEM_EDIT' || authorityClass === 'B' || authorityClass === 'C')) {
      writePaths.push(request.target_path);
    }
    if (writePaths.length > 0) {
      const allowedWriteRoots = [...ALLOWED_WRITE_ROOTS];
      if (request.scope && request.scope !== 'NONE') {
        allowedWriteRoots.push(request.scope);
      }
      const baseCwd = request.cwd || (request.scope && request.scope !== 'NONE' ? request.scope : process.cwd());
      for (const wp of writePaths) {
        if (!isPathWithinRoots(wp, allowedWriteRoots, baseCwd)) {
          throw Object.assign(
            new Error(`HOST_CONTROL_SCOPE_DENIED: Write target "${wp}" is outside admitted mutable scope "${request.scope || 'NONE'}"`),
            { code: 'HOST_CONTROL_SCOPE_DENIED' }
          );
        }
      }
    }

    // 4. Deny-list check (applies to ALL classes)
    const denyCheck = matchesDenyList(command);
    if (denyCheck.denied) {
      throw Object.assign(
        new Error(`HOST_CONTROL_DENIED: Command matches deny pattern "${denyCheck.pattern}"`),
        { code: 'HOST_CONTROL_DENIED' }
      );
    }

    // 5. Authority class enforcement
    if (authorityClass === 'D') {
      throw Object.assign(
        new Error('HOST_CONTROL_CONSEQUENTIAL_GATE: This operation requires explicit human authorization'),
        { code: 'HOST_CONTROL_CONSEQUENTIAL_GATE' }
      );
    }

    if (authorityClass === 'A' && !matchesAllowList(command)) {
      // Class A but not in allow list — deny for safety
      throw Object.assign(
        new Error(`HOST_CONTROL_NOT_ALLOWED: Command not in read-only allow list for Class A`),
        { code: 'HOST_CONTROL_NOT_ALLOWED' }
      );
    }

    // 6. Execute
    const operationId = generateOperationId();
    const timeoutMs = Math.min(
      Number(request.timeout_seconds || 30) * 1000,
      MAX_TIMEOUT_MS
    );
    const networkDeny = request.network !== 'ALLOW';

    const execResult = await executePowerShell({
      command,
      cwd: request.cwd || undefined,
      timeoutMs,
      networkDeny
    });

    // 7. Reduce to receipt
    const receipt = reduceToReceipt(operationId, request, execResult, authorityClass);

    // 8. Write evidence
    writeEvidence(operationId, receipt, execResult);

    // 9. Record idempotency for mutations
    if (this.idempotencyLedger.isMutation(authorityClass)) {
      this.idempotencyLedger.set(requestId, receipt);
    }

    // 10. Touch session if active
    if (request.session_id) {
      this.sessionManager.touch(request.session_id);
    }

    return receipt;
  }

  getCapabilities() {
    return {
      hostId: this.hostId,
      os: this.os,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      terminalCapability: 'POWERSHELL',
      supportedIntents: [...HOST_CONTROL_INTENTS],
      authorityClasses: AUTHORITY_CLASS,
      executorType: 'DETERMINISTIC_HOST',
      llmRequired: false,
      allowedReadRoots: ALLOWED_READ_ROOTS,
      allowedWriteRoots: ALLOWED_WRITE_ROOTS,
      evidenceDir: EVIDENCE_DIR
    };
  }
}

module.exports = {
  GovernedHostControlAdapter,
  HostControlSessionManager,
  HOST_CONTROL_INTENTS,
  AUTHORITY_CLASS,
  COMMAND_ALLOW_LIST_CLASS_A,
  COMMAND_DENY_LIST,
  ALLOWED_READ_ROOTS,
  ALLOWED_WRITE_ROOTS,
  FORBIDDEN_WRITE_ROOTS,
  classifyAuthorityClass,
  matchesDenyList,
  matchesAllowList,
  isPathWithinRoots,
  extractWritePaths,
  executePowerShell,
  reduceToReceipt,
  EVIDENCE_DIR,
  STDOUT_CEILING,
  STDERR_CEILING
};
