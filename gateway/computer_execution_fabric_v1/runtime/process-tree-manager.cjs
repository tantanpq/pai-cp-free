'use strict';

const { spawnSync } = require('node:child_process');

const MECHANISM = 'TASKKILL_TREE_V0';
const NEXT_SLICE = 'WINDOWS_JOB_OBJECT';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function sleepSync(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${Math.max(1, ms)})`], {
    windowsHide: true,
    timeout: Math.max(50, ms + 200)
  });
}

function queryProcessIdentity(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return null;

  try {
    const res = spawnSync('wmic', [
      'process',
      'where', `ProcessId=${p}`,
      'get', 'CreationDate,ExecutablePath,ProcessId',
      '/format:csv'
    ], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 3000
    });
    if (res.status === 0 && res.stdout) {
      const lines = res.stdout.trim().split(/\r?\n/).filter(l => l.trim() && !l.startsWith('Node,'));
      if (lines.length > 0) {
        const parts = lines[0].split(',');
        if (parts.length >= 4) {
          return {
            pid: Number(parts[3].trim()) || p,
            creationDate: parts[1].trim(),
            executablePath: parts[2].trim()
          };
        }
      }
    }
  } catch (_) {}

  // Fallback to powershell query if wmic is unavailable
  try {
    const res = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-Process -Id ${p} -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime, Path | ConvertTo-Json -Compress`
    ], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 3000
    });
    if (res.status === 0 && res.stdout) {
      const parsed = JSON.parse(res.stdout.trim());
      if (parsed && parsed.Id) {
        return {
          pid: Number(parsed.Id),
          creationDate: String(parsed.StartTime || ''),
          executablePath: String(parsed.Path || parsed.ProcessName || '')
        };
      }
    }
  } catch (_) {}

  return null;
}

function captureProcessOwnership(rootPid, sessionId) {
  const pid = Number(rootPid);
  const identity = queryProcessIdentity(pid) || {};
  return {
    pid,
    sessionId: String(sessionId || ''),
    creationDate: identity.creationDate || null,
    executablePath: identity.executablePath || 'powershell.exe',
    capturedAt: new Date().toISOString()
  };
}

function verifyProcessOwnership(rootPid, expectedOwnership) {
  const pid = Number(rootPid);
  if (!pidAlive(pid)) return false;
  if (!expectedOwnership || typeof expectedOwnership !== 'object') return false;

  const current = queryProcessIdentity(pid);
  if (!current) return false;

  // Check PID match
  if (current.pid !== pid) return false;

  // Check creation timestamp if captured
  if (expectedOwnership.creationDate && current.creationDate) {
    if (current.creationDate !== expectedOwnership.creationDate) {
      return false;
    }
  }

  // Check executable identity
  if (expectedOwnership.executablePath && current.executablePath) {
    const expBase = String(expectedOwnership.executablePath).toLowerCase().split(/[\\/]/).pop();
    const curBase = String(current.executablePath).toLowerCase().split(/[\\/]/).pop();
    if (expBase && curBase && expBase !== curBase) {
      return false;
    }
  }

  return true;
}

function terminateSessionTree(rootPid, options = {}) {
  const pid = Number(rootPid);
  const waitMs = Number.isInteger(options.waitMs) ? options.waitMs : 1500;
  const expectedOwnership = options.expectedOwnership || null;

  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      mechanism: MECHANISM,
      root_pid: pid,
      verified: false,
      status: 'CLEANUP_UNVERIFIED',
      reason: 'INVALID_ROOT_PID',
      next_slice: NEXT_SLICE
    };
  }

  // 1. If already dead, clean exit verified
  if (!pidAlive(pid)) {
    return {
      mechanism: MECHANISM,
      root_pid: pid,
      verified: true,
      status: 'CLOSED_WITH_VERIFIED_CLEANUP',
      reason: 'ALREADY_EXITED',
      next_slice: NEXT_SLICE
    };
  }

  // 2. Ownership verification before kill: prevent killing recycled PID
  if (expectedOwnership) {
    const verifiedOwnership = verifyProcessOwnership(pid, expectedOwnership);
    if (!verifiedOwnership) {
      return {
        mechanism: MECHANISM,
        root_pid: pid,
        verified: false,
        status: 'CLEANUP_UNVERIFIED',
        reason: 'PROCESS_OWNERSHIP_MISMATCH',
        next_slice: NEXT_SLICE
      };
    }
  }

  // 3. Terminate process tree by exact root PID
  const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 8000
  });

  const started = Date.now();
  while (Date.now() - started < waitMs) {
    if (!pidAlive(pid)) break;
    sleepSync(60);
  }

  const verified = !pidAlive(pid);
  return {
    mechanism: MECHANISM,
    root_pid: pid,
    verified,
    taskkill_status: killed.status,
    taskkill_error: killed.error ? String(killed.error.message || killed.error) : null,
    status: verified ? 'CLOSED_WITH_VERIFIED_CLEANUP' : 'CLEANUP_UNVERIFIED',
    reason: verified ? 'ROOT_PID_GONE' : 'ROOT_PID_STILL_ALIVE',
    next_slice: NEXT_SLICE
  };
}

class ProcessTreeManager {
  constructor({ terminate = null, verifyDead = null } = {}) {
    this.records = new Map();
    this.terminate = terminate;
    this.verifyDead = verifyDead;
  }

  register({ pid, parentPid = null, label = null, detached = false } = {}) {
    if (!Number.isInteger(pid) || pid < 1) throw new Error('PROCESS_PID_INVALID');
    const record = { pid, parentPid, label, detached: Boolean(detached), registeredAt: new Date().toISOString() };
    this.records.set(pid, record);
    return { ...record };
  }

  detach(pid) {
    const record = this.records.get(pid);
    if (!record) throw new Error('PROCESS_NOT_OWNED');
    record.detached = true;
    return { ...record };
  }

  owned() { return [...this.records.values()].filter(item => !item.detached).map(item => ({ ...item })); }

  async cleanup({ reason = 'SESSION_CLOSE' } = {}) {
    const results = [];
    const targets = this.owned().sort((a, b) => b.pid - a.pid);
    for (const item of targets) {
      if (typeof this.terminate !== 'function') {
        results.push({ pid: item.pid, status: 'BINDER_TERMINATOR_REQUIRED', reason });
        continue;
      }
      try {
        await this.terminate(item.pid, { reason, record: item });
        const dead = typeof this.verifyDead === 'function' ? await this.verifyDead(item.pid) : null;
        results.push({ pid: item.pid, status: dead === false ? 'TERMINATION_UNVERIFIED' : 'TERMINATED', verifiedDead: dead });
      } catch (error) {
        results.push({ pid: item.pid, status: 'TERMINATION_FAILED', error: String(error.message || error) });
      }
    }
    return results;
  }

  snapshot() { return [...this.records.values()].map(item => ({ ...item })); }
}

module.exports = {
  ProcessTreeManager,
  terminateSessionTree,
  pidAlive,
  captureProcessOwnership,
  verifyProcessOwnership,
  queryProcessIdentity,
  sleepSync,
  MECHANISM,
  NEXT_SLICE
};
