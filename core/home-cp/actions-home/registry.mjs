// actions-home/registry.mjs — HOME Control Plane action registry (v1, dựng từ mẫu msi-cp v1.1 — 2026-10-12).
// Chuẩn CP B1: bootstrap site cho core (vendor tại ..\core), actions export {ok:true,data}.
// Khác các site CP: action chạy lệnh LOCAL trên HOME (DESKTOP-0L1K3A7) qua child_process (không cần browser page).
//
// THREAT MODEL (ghi rõ theo Codex review): caller của home-cp là operator TIN CẬY
// (Codex HOME chạy local trên HOME / Leona qua SSH). Denylist ở đây là GUARDRAIL chống nhầm lẫn, KHÔNG phải security
// boundary chống caller ác ý — PowerShell động không thể chặn triệt để bằng regex
// (alias, IEX, encoded command, ghép chuỗi...). Nếu cần cho input không tin cậy,
// phải dùng allowlist action có cấu trúc thay vì sys.exec tự do.
import { configureSite } from '../core/site.mjs';
import { cdpUrl, deployDir, evidenceDir } from '../config.mjs';
configureSite({ prefix: 'HOME_CP', cdpUrl, deployDir, evidenceDir, preferUrl: '' });

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

const ok = (data = {}) => ({ ok: true, data });
const MAX_FILE = 5 * 1024 * 1024;

// --- Đường backup (Tân 2026-10-11): các action này chạy local, không cần browser.
// Khi CDP :9336 sập, core runner vẫn dispatch chúng với page=null.
// sys.screenshot KHÔNG có trong danh sách → bắt buộc CDP, lỗi báo rõ cần Chrome sống.
export const cdpNotRequired = new Set(['sys.exec', 'sys.processes', 'sys.tasks', 'sys.files', 'sys.screenshot']); // screenshot tự probe TCP + dùng agent-browser, không cần playwright (Codex F6)

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
  catch (e) { process.stderr.write(`[home-cp] evidence FAILED: ${step}: ${String(e?.message || e)}\n`); }
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
  [/\breg(\.exe)?\s+(delete|add)\s+HKLM/i, 'registry HKLM write'],
  [/\bvssadmin\s+delete/i, 'delete shadow copies'],
  [/\bEncodedCommand\b/i, 'encoded command'],
  [/(^|[\s;&|])powershell(\.exe)?\b[^|;&]*\s-[eE](\s|$)/i, 'nested powershell -e'],
  [/\bInvoke-Expression\b/i, 'Invoke-Expression'],
  [/\bIEX\b/i, 'IEX alias'],
  [/\b(disable|unregister|stop)-scheduledtask\b[^|;&]*(unified|scoring|musicintake|sunolisten)/i, 'disable live task (exec)'],
  [/\bschtasks(\.exe)?\b[^|;&]*\/(change|delete|disable|end)\b[^|;&]*(unified|scoring|musicintake|sunolisten)/i, 'schtasks live task (exec)'],
  [/\bschtasks(\.exe)?\b[^|;&]*(unified|scoring|musicintake|sunolisten)[^|;&]*\/(change|delete|disable|end)\b/i, 'schtasks live task (exec)'],
  [/\b(stop-process|stop-service)\b[^|;&]*\b(node|ollama|python|pythonw)\b/i, 'kill live-stack process (exec)'],
  [/\btaskkill(\.exe)?\b[^|;&]*\/im\s+(node|ollama|python|pythonw)/i, 'taskkill live-stack image (exec)'],
  [/\bschtasks(\.exe)?\b[^|;&]*\/(change|delete)\b[^|;&]*unifiedlanewatch/i, 'schtasks guardian task (exec)'],
];
function checkExecBlocked(command) {
  for (const [re, label] of EXEC_DENY) if (re.test(command)) return label;
  // Quét path tuyệt đối trong command (cả slash xuôi/ngược): chặn xóa C:\Windows* hoặc drive root (finding #2).
  const DRIVE_ROOTS = ['C:\\Windows'];
  // HOME (Codex review 2026-10-12, F1): mọi tham chiếu path tới 2 hệ đang chạy đều bị chặn trong sys.exec —
  // sys.exec tự do KHÔNG được đụng 2 vùng này kể cả đọc; muốn thao tác file hãy dùng sys.files (có policy).
  const EXEC_PROTECTED_ROOTS = ['C:\\scoring-service', 'C:\\temp\\sunolisten'];
  for (const m of command.matchAll(/[a-z]:[/\\][^\s"'`;,|&<>]*/gi)) {
    const q = canonWin(m[0]);
    for (const r of EXEC_PROTECTED_ROOTS) if (isUnder(r, q)) return `protected live path ${r}`;
    for (const r of DRIVE_ROOTS) if (isUnder(r, q) && /remove-item|del\s|erase\s|rd\s|rmdir/i.test(command)) return `delete under ${r}`;
    if (/^[a-z]:\\$/i.test(q) && /remove-item|del\s|erase\s|rd\s|rmdir|format/i.test(command)) return 'delete drive root';
  }
  // HOME (Codex review vòng 2, F1): khớp theo ĐOẠN TÊN vùng bảo vệ trong mọi token —
  // bắt cả dạng Join-Path/biến gián tiếp còn chứa literal. Vẫn là guardrail cho operator
  // tin cậy, KHÔNG phải sandbox (lệnh động không quét triệt để được — xem THREAT MODEL).
  if (/(^|[^a-z0-9_-])(scoring-service|sunolisten)(?=$|[^a-z0-9_-])/i.test(command)) {
    return 'protected live path (segment match)';
  }
  return null;
}

// --- Write policy (finding #2, #3, #15): canonical + component-wise ---
const WRITE_BLOCK_ROOTS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
function checkWriteBlocked(absPath) {
  const q = canonWin(absPath);
  for (const r of WRITE_BLOCK_ROOTS) if (isUnder(r, q)) return `under ${r}`;
  if (/authorized_keys$/i.test(q)) return 'SSH authorized_keys';
  if (isUnder('C:\\scoring-service', q)) return 'Scoring Service dir (đang chạy — cấm đụng)';
  if (isUnder('C:\\temp\\sunolisten', q)) return 'Unified Lane dir (đang chạy — cấm đụng)';
  return null;
}

// --- Read policy (finding #9): chỉ đọc trong vùng automation ---
const READ_ALLOW_ROOTS = ['C:\\temp'];
function checkReadAllowed(absPath) {
  const q = canonWin(absPath);
  for (const r of READ_ALLOW_ROOTS) if (isUnder(r, q)) return null;
  return `outside allowed roots (${READ_ALLOW_ROOTS.join(', ')})`;
}

// --- Final-path policy (Codex review 2026-10-12, F2/F3/F4) ---
// Policy lexical bị qua mặt bởi junction/symlink, ADS (file::$DATA) và tên ngắn 8.3 (PROGRA~1).
// Mọi quyết định read/write phải dựa trên FINAL path đã resolve (fs.realpath trên Windows
// trả đường dài + đích cuối qua junction/symlink). Target chưa tồn tại → resolve thư mục cha.
function checkStreamSyntax(absPath) {
  // Sau tiền tố ổ đĩa (X:\) mà còn ':' nữa = cú pháp alternate data stream.
  return absPath.slice(2).includes(':') ? 'alternate data stream syntax' : null;
}
async function resolveFinal(absPath) {
  try { return canonWin(await fs.realpath(absPath)); }
  catch (e) {
    // Chỉ lỗi "chưa tồn tại" mới được đi bộ lên; lỗi khác (EACCES...) phải fail rõ,
    // không fail-open xuống ancestor cao hơn (Codex vòng 3, F2).
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
      throw new Error(`SYS_PATH_RESOLVE_FAILED: ${e.code || e.message}`);
    }
  }
  // Đi bộ lên TỪNG ancestor tới khi gặp ancestor còn tồn tại thì resolve nó (bắt junction/
  // tên ngắn ở MỌI cấp, không chỉ cha trực tiếp — Codex vòng 2). Chỉ khi chạm gốc ổ đĩa mà
  // vẫn không resolve được mới trả path gốc (ổ đĩa luôn tồn tại nên thực tế không tới đây).
  const rest = [];
  let dir = absPath;
  while (true) {
    const parent = path.win32.dirname(dir);
    if (parent === dir) return absPath;
    rest.unshift(path.win32.basename(dir));
    dir = parent;
    try {
      const rp = await fs.realpath(dir);
      return canonWin(path.win32.join(rp, ...rest));
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
        throw new Error(`SYS_PATH_RESOLVE_FAILED: ${e.code || e.message}`);
      }
    }
  }
}

// Chạy PowerShell local. $ErrorActionPreference='Stop' để lỗi non-terminating
// cũng thành terminating (finding #5). Phân biệt spawn error vs exit code (#14).
// Codex review F12: timeout phải giết CẢ CÂY process (taskkill /T), không chỉ process PowerShell cha.
async function runPS(command, timeoutMs) {
  const t = Math.min(Math.max(1000, timeoutMs | 0 || 30000), 300000);
  const wrapped = `$ErrorActionPreference='Stop';\n${command}`;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let killNote = '';
    let killDone = false;
    let hardTimer = null;
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', wrapped],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardTimer) clearTimeout(hardTimer);
        if (timedOut) return reject(new Error(`SYS_EXEC_TIMEOUT after ${t}ms${killDone ? killNote : ' (termination unverified)'}`));
        if (!err) return resolve({ exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
        if (typeof err.code !== 'number') {
          return reject(new Error(`SYS_EXEC_SPAWN_FAILED: code=${err.code} syscall=${err.syscall || '?'} ${String(err.message || '').slice(0, 200)}`));
        }
        resolve({ exitCode: err.code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
    const timer = setTimeout(() => {
      timedOut = true;
      // N7/F12: hard deadline ĐỘC LẬP đặt ngay lúc timeout (không nằm trong callback của
      // taskkill) — tổng chờ sau timeout không quá 15s dù taskkill treo. taskkill tự nó
      // cũng bị bound 10s. Lưu ý trung thực: không có Job Object (cần native module) nên
      // đây là terminate-cây-theo-PID + deadline cứng, không phải containment tuyệt đối.
      hardTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`SYS_EXEC_TIMEOUT after ${t}ms (termination unverified)`));
      }, 15000);
      if (!child.pid) { child.kill(); return; }
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 }, (kerr) => {
        killDone = true;
        killNote = kerr ? ` (taskkill failed: ${String(kerr.message || '').slice(0, 120)})` : '';
      });
    }, t);
  });
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
  'sys.exec': async (ctx, { command, timeout_ms = 30000, fail_on_nonzero = false } = {}) =>
    withEvidence(ctx, 'sys.exec', async () => {
      if (typeof command !== 'string' || !command.trim()) throw new Error('SYS_EXEC_EMPTY_COMMAND');
      const blocked = checkExecBlocked(command);
      if (blocked) throw new Error(`SYS_EXEC_BLOCKED: ${blocked}`);
      await evidence(ctx, 'sys.exec.cmd', { cmd_sha256_12: cmdId(command), cmd_len: command.length });
      const r = await runPS(command, timeout_ms);
      // F9 (opt-in): mặc định giữ contract CP chung (exitCode trong data, envelope ok:true —
      // giống msi-cp); caller cần semantics chặt đặt fail_on_nonzero:true thì nonzero = lỗi.
      if (fail_on_nonzero === true && r.exitCode !== 0) {
        throw new Error(`SYS_EXEC_NONZERO: exit ${r.exitCode}: ${trunc(r.stderr || r.stdout, 300)}`);
      }
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
      // HOME (Codex review F1): task của các hệ đang chạy (Unified Lane, Scoring) — cấm disable qua home-cp.
      if (op === 'disable' && /(unified|scoring|musicintake|sunolisten)/i.test(name || '')) {
        throw new Error('SYS_TASKS_PROTECTED: task thuộc hệ đang chạy trên HOME');
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
        throw new Error(`SYS_SCREENSHOT_NEEDS_CHROME: không nối được CDP 127.0.0.1:${p} — cần Chrome CDP sống trên HOME (mặc định HOME không có Chrome CDP thường trực; các sys.* khác không cần Chrome)`);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = crypto.randomBytes(3).toString('hex');
      const target = typeof outPath === 'string' && outPath.trim()
        ? canonWin(outPath.trim())
        : canonWin(path.win32.join(deployDir, 'screenshots', `home-${stamp}-${rand}.png`));
      const streamErr = checkStreamSyntax(target);
      if (streamErr) throw new Error(`SYS_SCREENSHOT_WRITE_BLOCKED: ${streamErr}`);
      const blockedAbs = checkWriteBlocked(target);
      if (blockedAbs) throw new Error(`SYS_SCREENSHOT_WRITE_BLOCKED: ${blockedAbs}`);
      const finalTarget = await resolveFinal(target);
      const blocked = checkWriteBlocked(finalTarget);
      if (blocked) throw new Error(`SYS_SCREENSHOT_WRITE_BLOCKED: ${blocked}`);
      await fs.mkdir(path.win32.dirname(finalTarget), { recursive: true });
      // F2: target đã tồn tại dạng symlink/hardlink thì từ chối TRƯỚC khi backend ghi đè.
      try {
        const lst = await fs.lstat(finalTarget);
        if (lst.isSymbolicLink()) throw new Error('SYS_SCREENSHOT_SYMLINK_REFUSED');
        if (lst.nlink > 1) throw new Error('SYS_SCREENSHOT_HARDLINK');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const t0 = Date.now();
      // N6: backend phải ghi thẳng vào finalTarget ĐÃ validate — không qua alias gốc.
      const cmd = `& 'C:\\PROGRA~1\\nodejs\\npx.cmd' agent-browser --cdp http://127.0.0.1:${p} screenshot --json '${finalTarget.replace(/'/g, "''")}'`;
      const r = await runPS(cmd, 60000);
      if (r.exitCode !== 0) throw new Error(`SYS_SCREENSHOT_FAILED: ${r.stderr.replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
      let shotPath = finalTarget;
      try {
        const j = JSON.parse(r.stdout.trim());
        if (j && typeof j.path === 'string' && j.path) shotPath = canonWin(j.path);
      } catch { /* dùng finalTarget */ }
      // N6: output backend báo về phải resolve về đúng finalTarget đã validate.
      const shotFinal = await resolveFinal(shotPath);
      if (shotFinal.toLowerCase() !== finalTarget.toLowerCase()) {
        throw new Error('SYS_SCREENSHOT_OUTPUT_MISMATCH');
      }
      let st;
      try { st = await fs.stat(shotFinal); } catch { throw new Error('SYS_SCREENSHOT_NO_OUTPUT'); }
      if (!st.size) throw new Error('SYS_SCREENSHOT_EMPTY');
      if (st.nlink > 1) throw new Error('SYS_SCREENSHOT_HARDLINK');
      if (st.mtimeMs < t0 - 10000) throw new Error('SYS_SCREENSHOT_STALE_FILE');
      return { path: shotFinal, bytes: st.size };
    }),

  // Đọc/ghi file text. Read giới hạn C:\temp (finding #9), chống TOCTOU bằng handle (#10).
  'sys.files': async (ctx, { op, path: fpath, content } = {}) =>
    withEvidence(ctx, 'sys.files', async () => {
      if (!['read', 'write'].includes(op)) throw new Error(`SYS_FILES_BAD_OP: ${op}`);
      if (typeof fpath !== 'string' || !fpath.trim()) throw new Error('SYS_FILES_MISSING_PATH');
      const abs = canonWin(fpath.trim());
      if (!/^[a-z]:\\/i.test(abs)) throw new Error('SYS_FILES_NOT_ABSOLUTE');
      // Codex review F3: chặn cú pháp ADS (file::$DATA) trước mọi policy.
      const streamErr = checkStreamSyntax(abs);
      if (streamErr) throw new Error(`SYS_FILES_STREAM_DENIED: ${streamErr}`);
      // Codex review F2/F4: quyết định policy trên FINAL path (qua junction/symlink + tên dài).
      const finalPath = await resolveFinal(abs);
      if (op === 'read') {
        // N5: cấm theo TÊN GỐC nữa (vd authorized_keys là symlink ra ngoài) — path gốc
        // cũng phải qua policy, không chỉ final path.
        const allowedAbs = checkReadAllowed(abs);
        if (allowedAbs) throw new Error(`SYS_FILES_READ_DENIED: ${allowedAbs}`);
        const allowed = checkReadAllowed(finalPath);
        if (allowed) throw new Error(`SYS_FILES_READ_DENIED: ${allowed}`);
        let fh;
        try {
          const lst = await fs.lstat(finalPath);
          if (lst.isSymbolicLink()) throw new Error('SYS_FILES_SYMLINK_REFUSED');
          fh = await fs.open(finalPath, 'r');
          const st = await fh.stat();
          if (st.ino !== lst.ino) throw new Error('SYS_FILES_IDENTITY_CHANGED');
          if (st.size > MAX_FILE) throw new Error(`SYS_FILES_TOO_LARGE: ${st.size} bytes (giới hạn 5MB)`);
          if (st.nlink > 1) throw new Error('SYS_FILES_HARDLINK_REFUSED');
          // Codex review F13: đọc tới khi đủ/EOF theo bytesRead thật, chỉ decode phần đã đọc.
          const buf = Buffer.alloc(st.size);
          let off = 0;
          while (off < st.size) {
            const { bytesRead } = await fh.read(buf, off, st.size - off, off);
            if (bytesRead === 0) break;
            off += bytesRead;
          }
          return { path: finalPath, bytes: off, content: buf.subarray(0, off).toString('utf8') };
        } catch (e) {
          if (e.code === 'ENOENT') throw new Error('SYS_FILES_NOT_FOUND');
          throw e;
        } finally {
          await fh?.close().catch(() => {});
        }
      }
      const blockedAbs = checkWriteBlocked(abs);
      if (blockedAbs) throw new Error(`SYS_FILES_WRITE_BLOCKED: ${blockedAbs}`);
      const blocked = checkWriteBlocked(finalPath);
      if (blocked) throw new Error(`SYS_FILES_WRITE_BLOCKED: ${blocked}`);
      if (typeof content !== 'string') throw new Error('SYS_FILES_WRITE_NEEDS_CONTENT');
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE) throw new Error('SYS_FILES_WRITE_TOO_LARGE: giới hạn 5MB');
      // Chặn ghi qua symlink lá / đè hardlink (Codex F2).
      let preIno = null;
      try {
        const lst = await fs.lstat(finalPath);
        if (lst.isSymbolicLink()) throw new Error('SYS_FILES_SYMLINK_REFUSED');
        if (lst.nlink > 1) throw new Error('SYS_FILES_HARDLINK_REFUSED');
        preIno = lst.ino;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fs.mkdir(path.win32.dirname(finalPath), { recursive: true });
      // N8: KHÔNG mở 'w' trực tiếp trên target — open('w') truncate NGAY, trước khi kịp
      // kiểm tra identity. Ghi vào staging file độc quyền cùng thư mục, validate lại
      // identity của target, rồi mới rename đè (target chỉ đổi khi mọi kiểm tra đã qua).
      // N10: toàn bộ vòng đời staging nằm trong 1 scope — lỗi ở bất kỳ bước nào cũng
      // dọn staging (trừ khi đã publish bằng rename thành công).
      // N12: chỉ dọn file staging do CHÍNH lần chạy này tạo (created) — va chạm tên
      // (EEXIST) là file của writer khác, tuyệt đối không xóa; thử tên ngẫu nhiên mới.
      let published = false;
      let created = false;
      let stagePath = null;
      try {
        let sfh = null;
        for (let attempt = 0; attempt < 3 && !sfh; attempt++) {
          stagePath = path.win32.join(
            path.win32.dirname(finalPath),
            `.${path.win32.basename(finalPath)}.home-cp-stage-${crypto.randomBytes(4).toString('hex')}`
          );
          try {
            sfh = await fs.open(stagePath, 'wx');
            created = true;
          } catch (e) {
            if (e.code !== 'EEXIST') throw e;
          }
        }
        if (!sfh) throw new Error('SYS_FILES_STAGING_COLLISION');
        try {
          await sfh.writeFile(content, 'utf8');
          await sfh.close();
        } catch (e) {
          await sfh.close().catch(() => {});
          throw e;
        }
        let nowIno = null;
        try {
          const cur = await fs.lstat(finalPath);
          if (cur.isSymbolicLink()) throw new Error('SYS_FILES_SYMLINK_REFUSED');
          if (cur.nlink > 1) throw new Error('SYS_FILES_HARDLINK_REFUSED');
          nowIno = cur.ino;
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (nowIno !== preIno) throw new Error('SYS_FILES_IDENTITY_CHANGED');
        await fs.rename(stagePath, finalPath);
        published = true;
      } finally {
        if (created && !published && stagePath) await fs.unlink(stagePath).catch(() => {});
      }
      return { path: finalPath, bytes: Buffer.byteLength(content, 'utf8') };
    }),
};
