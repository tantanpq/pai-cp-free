// actions-msi/registry.mjs — MSI Control Plane action registry (v1.1, sau Codex review 2026-10-11).
// Chuẩn CP B1: bootstrap site cho browser-control-plane-core, actions export {ok:true,data}.
// Khác các site CP: action chạy lệnh LOCAL trên MSI qua child_process (không cần browser page).
//
// THREAT MODEL (ghi rõ theo Codex review): caller của msi-cp là operator TIN CẬY
// (Leona qua SSH). Denylist ở đây là GUARDRAIL chống nhầm lẫn, KHÔNG phải security
// boundary chống caller ác ý — PowerShell động không thể chặn triệt để bằng regex
// (alias, IEX, encoded command, ghép chuỗi...). Nếu cần cho input không tin cậy,
// phải dùng allowlist action có cấu trúc thay vì sys.exec tự do.
import { configureSite } from '../../browser-control-plane-core/site.mjs';
import { cdpUrl, deployDir, evidenceDir } from '../config.mjs';
configureSite({ prefix: 'MSI_CP', cdpUrl, deployDir, evidenceDir, preferUrl: '' });

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

const execFileAsync = promisify(execFile);
const ok = (data = {}) => ({ ok: true, data });
const MAX_FILE = 5 * 1024 * 1024;

// --- Đường backup (Tân 2026-10-11): các action này chạy local, không cần browser.
// Khi CDP :9336 sập, core runner vẫn dispatch chúng với page=null.
// sys.screenshot KHÔNG có trong danh sách → bắt buộc CDP, lỗi báo rõ cần Chrome sống.
export const cdpNotRequired = new Set(['sys.exec', 'sys.processes', 'sys.tasks', 'sys.files']);

// TCP probe nhanh: kiểm tra CDP port có nghe không trước khi gọi agent-browser
// (để báo lỗi rõ ràng thay vì để CLI fail khó hiểu).
function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const done = (err) => { sock.destroy(); err ? reject(err) : resolve(true); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done());
    sock.once('timeout', () => done(new Error('timeout')));
    sock.once('error', done);
    sock.connect(port, host);
  });
}

// Evidence: không nuốt lỗi âm thầm nữa (finding #6) — báo ra stderr để thấy trong log.
async function evidence(ctx, step, data = {}) {
  try { await ctx.ev?.logStep?.(step, { timestamp: new Date().toISOString(), ...data }); }
  catch (e) { process.stderr.write(`[msi-cp] evidence FAILED: ${step}: ${String(e?.message || e)}\n`); }
}

// Wrapper: mọi action đều ghi start/done/fail + duration (finding #7).
async function withEvidence(ctx, name, fn) {
  const t0 = Date.now();
  await evidence(ctx, `${name}.start`, {});
  try {
    const data = await fn();
    await evidence(ctx, `${name}.done`, { ms: Date.now() - t0 });
    return ok(data);
  } catch (e) {
    await evidence(ctx, `${name}.fail`, { ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300) });
    throw e;
  }
}

// --- Canonical path helpers (finding #2, #15) ---
const canonWin = (p) => path.win32.resolve(String(p).replace(/\//g, '\\'));
function isUnder(root, p) {
  const rel = path.win32.relative(canonWin(root), canonWin(p));
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
}

// --- sys.exec denylist (finding #1: guardrail, không phải boundary — xem THREAT MODEL) ---
const EXEC_DENY = [
  [/\bformat\s+[a-z]:/i, 'format drive'],
  [/\bdiskpart\b/i, 'diskpart'],
  [/\b(clear-disk|initialize-disk)\b/i, 'disk destructive cmdlet'],
  [/\bshutdown(\.exe)?\b/i, 'shutdown'],
  [/\b(restart-computer|stop-computer)\b/i, 'restart/stop computer'],
  [/\bbcdedit(\.exe)?\b/i, 'bcdedit'],
  [/\breg\s+(delete|add)\s+HKLM/i, 'registry HKLM write'],
  [/\bvssadmin\s+delete/i, 'delete shadow copies'],
  [/\bEncodedCommand\b/i, 'encoded command'],
  [/(^|[\s;&|])powershell(\.exe)?\s.*\s-[eE](\s|$)/i, 'nested powershell -e'],
  [/\bInvoke-Expression\b/i, 'Invoke-Expression'],
  [/\bIEX\b/i, 'IEX alias'],
];
function checkExecBlocked(command) {
  for (const [re, label] of EXEC_DENY) if (re.test(command)) return label;
  // Quét path tuyệt đối trong command: chặn xóa C:\Windows* hoặc drive root (finding #2).
  const DRIVE_ROOTS = ['C:\\Windows'];
  for (const m of command.matchAll(/[a-z]:\\[^\s"'`;,|&<>]*/gi)) {
    const q = canonWin(m[0]);
    for (const r of DRIVE_ROOTS) if (isUnder(r, q) && /remove-item|del\s|erase\s|rd\s|rmdir/i.test(command)) return `delete under ${r}`;
    if (/^[a-z]:\\$/i.test(q) && /remove-item|del\s|erase\s|rd\s|rmdir|format/i.test(command)) return 'delete drive root';
  }
  return null;
}

// --- Write policy (finding #2, #3, #15): canonical + component-wise ---
const WRITE_BLOCK_ROOTS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
function checkWriteBlocked(absPath) {
  const q = canonWin(absPath);
  for (const r of WRITE_BLOCK_ROOTS) if (isUnder(r, q)) return `under ${r}`;
  if (/authorized_keys$/i.test(q)) return 'SSH authorized_keys';
  if (isUnder('C:\\temp\\chatgpt', q)) return 'running worker dir (chatgpt)';
  return null;
}

// --- Read policy (finding #9): chỉ đọc trong vùng automation ---
const READ_ALLOW_ROOTS = ['C:\\temp'];
function checkReadAllowed(absPath) {
  const q = canonWin(absPath);
  for (const r of READ_ALLOW_ROOTS) if (isUnder(r, q)) return null;
  return `outside allowed roots (${READ_ALLOW_ROOTS.join(', ')})`;
}

// Chạy PowerShell local. $ErrorActionPreference='Stop' để lỗi non-terminating
// cũng thành terminating (finding #5). Phân biệt spawn error vs exit code (#14).
async function runPS(command, timeoutMs) {
  const t = Math.min(Math.max(1000, timeoutMs | 0 || 30000), 300000);
  const wrapped = `$ErrorActionPreference='Stop';\n${command}`;
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', wrapped],
      { timeout: t, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }
    );
    return { exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (e) {
    if (e.killed) throw new Error(`SYS_EXEC_TIMEOUT after ${t}ms`);
    if (typeof e.code !== 'number') {
      throw new Error(`SYS_EXEC_SPAWN_FAILED: code=${e.code} syscall=${e.syscall || '?'} ${String(e.message || '').slice(0, 200)}`);
    }
    return { exitCode: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const trunc = (s, max = 20000) =>
  s.length > max ? s.slice(0, max) + `\n...[truncated ${s.length - max} chars]` : s;
const cmdId = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

// Parse JSON từ PowerShell với mã lỗi domain-specific (finding #12).
function parsePSJson(raw, code) {
  const t = (raw || '').trim();
  if (!t || t === 'null') return [];
  try {
    const p = JSON.parse(t);
    return Array.isArray(p) ? p : [p];
  } catch {
    throw new Error(`${code}: ${t.replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
  }
}

export const actions = {
  // Chạy lệnh PowerShell/cmd local. Evidence chỉ log hash command (finding #8: chống leak secret).
  'sys.exec': async (ctx, { command, timeout_ms = 30000 } = {}) =>
    withEvidence(ctx, 'sys.exec', async () => {
      if (typeof command !== 'string' || !command.trim()) throw new Error('SYS_EXEC_EMPTY_COMMAND');
      const blocked = checkExecBlocked(command);
      if (blocked) throw new Error(`SYS_EXEC_BLOCKED: ${blocked}`);
      await evidence(ctx, 'sys.exec.cmd', { cmd_sha256_12: cmdId(command), cmd_len: command.length });
      const r = await runPS(command, timeout_ms);
      return { exitCode: r.exitCode, stdout: trunc(r.stdout), stderr: trunc(r.stderr) };
    }),

  // Liệt kê process. Lọc theo tên nếu có {name}.
  'sys.processes': async (ctx, { name } = {}) =>
    withEvidence(ctx, 'sys.processes', async () => {
      const filter = typeof name === 'string' && name.trim()
        ? `-Name '${name.trim().replace(/'/g, "''")}'` : '';
      const ps = `Get-Process ${filter} | Select-Object Name, Id, @{N='CPU';E={$_.CPU}}, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json -Compress -Depth 2`;
      const r = await runPS(ps, 30000);
      if (r.exitCode !== 0) throw new Error(`SYS_PROCESSES_FAILED: ${r.stderr.replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
      const list = parsePSJson(r.stdout, 'SYS_PROCESSES_BAD_OUTPUT');
      return { count: list.length, processes: list.slice(0, 500) };
    }),

  // Task Scheduler: list | run | enable | disable.
  'sys.tasks': async (ctx, { op = 'list', name } = {}) =>
    withEvidence(ctx, 'sys.tasks', async () => {
      if (!['list', 'run', 'enable', 'disable'].includes(op)) throw new Error(`SYS_TASKS_BAD_OP: ${op}`);
      if (op !== 'list' && (typeof name !== 'string' || !name.trim())) {
        throw new Error('SYS_TASKS_MISSING_NAME');
      }
      const n = typeof name === 'string' ? name.trim().replace(/'/g, "''") : '';
      let ps;
      if (op === 'list') {
        ps = `Get-ScheduledTask | Select-Object TaskName, TaskPath, State | ConvertTo-Json -Compress -Depth 2`;
      } else if (op === 'run') {
        ps = `Start-ScheduledTask -TaskName '${n}'; (Get-ScheduledTask -TaskName '${n}').State`;
      } else if (op === 'enable') {
        ps = `Enable-ScheduledTask -TaskName '${n}' | Out-Null; (Get-ScheduledTask -TaskName '${n}').State`;
      } else {
        ps = `Disable-ScheduledTask -TaskName '${n}' | Out-Null; (Get-ScheduledTask -TaskName '${n}').State`;
      }
      const r = await runPS(ps, 30000);
      if (r.exitCode !== 0) throw new Error(`SYS_TASKS_${op.toUpperCase()}_FAILED: ${r.stderr.replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
      if (op === 'list') {
        const list = parsePSJson(r.stdout, 'SYS_TASKS_BAD_OUTPUT');
        return { count: list.length, tasks: list.slice(0, 500) };
      }
      return { name: n, op, state: r.stdout.trim() };
    }),

  // Chụp màn hình Chrome :9336 qua agent-browser CLI. Áp cùng write policy (finding #3),
  // yêu cầu exitCode 0 + file mới thật (finding #4), validate port strict (finding #13).
  // BẮT BUỘC CDP sống: probe trước, chết thì báo rõ cần Chrome sống (đường backup).
  'sys.screenshot': async (ctx, { port, path: outPath } = {}) =>
    withEvidence(ctx, 'sys.screenshot', async () => {
      const p = port === undefined ? 9336 : port;
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('SYS_SCREENSHOT_BAD_PORT');
      try {
        await tcpProbe('127.0.0.1', p, 4000);
      } catch {
        throw new Error(`SYS_SCREENSHOT_NEEDS_CHROME: không nối được CDP 127.0.0.1:${p} — cần Chrome sống (task MSI-SocialChrome / watchdog MSI-ChromeWatchdog)`);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = crypto.randomBytes(3).toString('hex');
      const target = typeof outPath === 'string' && outPath.trim()
        ? canonWin(outPath.trim())
        : canonWin(path.win32.join(deployDir, 'screenshots', `msi-${stamp}-${rand}.png`));
      const blocked = checkWriteBlocked(target);
      if (blocked) throw new Error(`SYS_SCREENSHOT_WRITE_BLOCKED: ${blocked}`);
      await fs.mkdir(path.win32.dirname(target), { recursive: true });
      const t0 = Date.now();
      const cmd = `& 'C:\\PROGRA~1\\nodejs\\npx.cmd' agent-browser --cdp http://127.0.0.1:${p} screenshot --json '${target.replace(/'/g, "''")}'`;
      const r = await runPS(cmd, 60000);
      if (r.exitCode !== 0) throw new Error(`SYS_SCREENSHOT_FAILED: ${r.stderr.replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
      let shotPath = target;
      try {
        const j = JSON.parse(r.stdout.trim());
        if (j && typeof j.path === 'string' && j.path) shotPath = canonWin(j.path);
      } catch { /* dùng target */ }
      let st;
      try { st = await fs.stat(shotPath); } catch { throw new Error('SYS_SCREENSHOT_NO_OUTPUT'); }
      if (!st.size) throw new Error('SYS_SCREENSHOT_EMPTY');
      if (st.mtimeMs < t0 - 10000) throw new Error('SYS_SCREENSHOT_STALE_FILE');
      return { path: shotPath, bytes: st.size };
    }),

  // Đọc/ghi file text. Read giới hạn C:\temp (finding #9), chống TOCTOU bằng handle (#10).
  'sys.files': async (ctx, { op, path: fpath, content } = {}) =>
    withEvidence(ctx, 'sys.files', async () => {
      if (!['read', 'write'].includes(op)) throw new Error(`SYS_FILES_BAD_OP: ${op}`);
      if (typeof fpath !== 'string' || !fpath.trim()) throw new Error('SYS_FILES_MISSING_PATH');
      const abs = canonWin(fpath.trim());
      if (!/^[a-z]:\\/i.test(abs)) throw new Error('SYS_FILES_NOT_ABSOLUTE');
      if (op === 'read') {
        const allowed = checkReadAllowed(abs);
        if (allowed) throw new Error(`SYS_FILES_READ_DENIED: ${allowed}`);
        let fh;
        try {
          const lst = await fs.lstat(abs);
          if (lst.isSymbolicLink()) throw new Error('SYS_FILES_SYMLINK_REFUSED');
          fh = await fs.open(abs, 'r');
          const st = await fh.stat();
          if (st.size > MAX_FILE) throw new Error(`SYS_FILES_TOO_LARGE: ${st.size} bytes (giới hạn 5MB)`);
          const buf = Buffer.alloc(st.size);
          await fh.read(buf, 0, st.size, 0);
          return { path: abs, bytes: st.size, content: buf.toString('utf8') };
        } catch (e) {
          if (e.code === 'ENOENT') throw new Error('SYS_FILES_NOT_FOUND');
          throw e;
        } finally {
          await fh?.close().catch(() => {});
        }
      }
      const blocked = checkWriteBlocked(abs);
      if (blocked) throw new Error(`SYS_FILES_WRITE_BLOCKED: ${blocked}`);
      if (typeof content !== 'string') throw new Error('SYS_FILES_WRITE_NEEDS_CONTENT');
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE) throw new Error('SYS_FILES_WRITE_TOO_LARGE: giới hạn 5MB');
      await fs.mkdir(path.win32.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return { path: abs, bytes: Buffer.byteLength(content, 'utf8') };
    }),
};
