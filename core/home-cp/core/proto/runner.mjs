// runner.mjs — browser-control-plane-core: CLI engine dùng chung cho mọi site CP.
// Gộp từ proto/run-action.mjs của 5 site (bản ChatGPT CP làm chuẩn).
// Mỗi site giữ proto/run-action.mjs MỎNG — chỉ gọi runCli() với params của site.
//
// runCli params:
//   prefix     — env prefix của site, vd 'SUNO_CP' (env: <PREFIX>_DIR/_CDP/_REGISTRY)
//   config     — object config.mjs của site (optional, có thể {})
//   actionsUrl — URL tới actions-<site>/registry.mjs
//   watchdogUrl— URL tới watch/watchdog.mjs của site (bỏ qua khi gate === 'none')
//   defaults   — { dir, cdp } default khi không có env/config
//   gate       — 'strict' (đòi loggedIn && !cloudflare: chatgpt/github/grok)
//              | 'cloudflare-only' (rea: login là thông tin, chỉ chặn cloudflare)
//              | 'none' (suno: không check session)
//   ctxExtra   — (cmd) => object thêm vào ctx của action, hoặc null
//
// Contract CLI giữ nguyên: node proto/run-action.mjs '<json>' (hoặc stdin)
// → đúng 1 dòng JSON trên stdout; exit code 0/1 theo ok.
// HOME-CP VENDOR NOTES (2026-10-12, sau Codex review vòng 1): bản core vendor trong
// home-cp mang các fix riêng — idempotency claim + digest (F7/F8), không cache kết quả
// sys.exec exitCode != 0 (F9), bootstrap configureSite cho queue mode (F10), chặn
// baseDir/idempotencyFile trỏ vào vùng bảo vệ của HOME (F11). Khuôn CLI giữ nguyên.
import * as fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Export riêng để test được config resolution mà không cần chạy CLI.
export function resolveCliConfig({ prefix, config = {}, defaults = {} }) {
  const baseDir = process.env[`${prefix}_DIR`] || config.deployDir || defaults.dir;
  const cdpUrl = process.env[`${prefix}_CDP`] || config.cdpUrl || defaults.cdp;
  return { baseDir, cdpUrl };
}

const errorText = (error) => String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 500);
const failure = (error) => ({ ok: false, error: errorText(error) });

function parseArg(raw) {
  if (raw === undefined) throw new Error('missing JSON argument');
  const cmd = JSON.parse(raw);
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw new Error('command must be a JSON object');
  }
  return cmd;
}

export async function runCli({ prefix, config = {}, actionsUrl, watchdogUrl, defaults = {}, gate = 'strict', ctxExtra = null }) {
  const { baseDir, cdpUrl } = resolveCliConfig({ prefix, config, defaults });
  // F11: HOME_CP_DIR override không được trỏ artifact tự động vào vùng live được bảo vệ.
  const PROTECTED_ROOTS = ['C:\\scoring-service', 'C:\\temp\\sunolisten'];
  const winNorm = (x) => String(x).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  const underRoot = (root, x) => { const r = winNorm(path.win32.resolve(root)), q = winNorm(path.win32.resolve(x)); return q === r || q.startsWith(r + '\\'); };
  // Resolve final path kiểu Windows (đi bộ lên ancestor gần nhất) — dùng để validate
  // đích artifact + neo namespace (F11/N3, Codex vòng 3).
  async function resolveFinalWin(p) {
    // N11: fail-CLOSED như registry — chỉ ENOENT/ENOTDIR mới được đi bộ lên; lỗi lạ
    // (EACCES/EIO...) phải throw, không fail-open xuống ancestor cao hơn.
    const onlyMissing = (e) => {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
        throw new Error(`artifact path resolve failed: ${e.code || e.message}`);
      }
    };
    try { return path.win32.resolve(await fs.realpath(p)); } catch (e) { onlyMissing(e); }
    const rest = [];
    let dir = p;
    while (true) {
      const parent = path.win32.dirname(dir);
      if (parent === dir) return path.win32.resolve(p);
      rest.unshift(path.win32.basename(dir));
      dir = parent;
      try { return path.win32.resolve(path.win32.join(await fs.realpath(dir), ...rest)); }
      catch (e) { onlyMissing(e); }
    }
  }
  let earlyError = null;
  let idempotencyFile = config.idempotencyFile || path.join(baseDir, 'idempotency.jsonl');
  if (PROTECTED_ROOTS.some((r) => underRoot(r, baseDir))) {
    earlyError = new Error(`refusing to run: baseDir inside protected root: ${baseDir}`);
  } else if (PROTECTED_ROOTS.some((r) => underRoot(r, idempotencyFile))) {
    earlyError = new Error('refusing to run: idempotencyFile inside protected root');
  }
  const queueDir = path.join(baseDir, 'queue');
  let claimsDir = path.join(path.dirname(idempotencyFile), 'claims'); // N3: cùng namespace với receipt store (neo lại theo final path ở init)

  // F8: mỗi key gắn với digest của (action + params) — dùng lại key cho command khác = lỗi.
  function canonicalize(v) {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v && typeof v === 'object') {
      const o = Object.create(null); // N9: tránh setter __proto__ nuốt mất key của JSON
      for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
      return o;
    }
    return v;
  }
  function commandDigest(cmd) {
    return crypto.createHash('sha256')
      .update(JSON.stringify(canonicalize({ action: cmd.action, params: cmd.params ?? null })), 'utf8')
      .digest('hex');
  }

  // Successful receipts only; the last matching record wins.
  async function findReceipt(key, digest) {
    let contents;
    try {
      contents = await fs.readFile(idempotencyFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { found: null, mismatch: false };
    }
    let found = null;
    let mismatch = false;
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // A damaged receipt must not silently permit another side effect.
        throw new Error('invalid idempotency record');
      }
      if (record.idempotency_key !== key) continue;
      if (record.digest === digest && record.output?.ok === true) found = record.output;
      else if (record.digest !== digest) mismatch = true;
    }
    return { found, mismatch };
  }

  // F7 + Codex vòng 2 (N1/N2): claim cross-process giữ TRƯỚC khi đối soát receipt và
  // dispatch. KHÔNG tự hết hạn/takeover: claim còn sót = kết quả lần chạy trước KHÔNG
  // CHẮC CHẮN — operator đối soát tay rồi mới xóa file claim. Release mang owner token:
  // process chỉ xóa claim của chính nó.
  function claimFileFor(key) {
    return path.join(
      claimsDir,
      crypto.createHash('sha256').update(String(key), 'utf8').digest('hex') + '.claim.json'
    );
  }
  async function acquireClaim(key, digest, owner) {
    await fs.mkdir(claimsDir, { recursive: true });
    const claimPath = claimFileFor(key);
    const payload = JSON.stringify({ idempotency_key: key, digest, owner, pid: process.pid, at: new Date().toISOString() });
    try {
      await fs.writeFile(claimPath, payload, { flag: 'wx', encoding: 'utf8' });
      return claimPath;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      return null; // đang bị giữ — caller đối soát receipt rồi quyết định
    }
  }
  async function releaseClaim(claimPath, owner) {
    if (!claimPath) return;
    try {
      const rec = JSON.parse(await fs.readFile(claimPath, 'utf8'));
      if (rec.owner !== owner) return; // không phải claim của mình — tuyệt đối không xóa
    } catch { return; }
    await fs.unlink(claimPath).catch(() => {});
  }

  async function appendIdempotent(cmd, output) {
    if (cmd.idempotency_key === undefined || cmd.idempotency_key === null || !output.ok) return;
    // F9: sys.exec exitCode != 0 = invocation xong nhưng COMMAND thất bại — không cache
    // thành công (nếu không, retry cùng key sẽ replay kết quả hỏng vĩnh viễn).
    if (typeof output?.data?.exitCode === 'number' && output.data.exitCode !== 0) return;
    await fs.mkdir(baseDir, { recursive: true });
    await fs.appendFile(idempotencyFile, JSON.stringify({
      idempotency_key: cmd.idempotency_key,
      action: cmd.action,
      digest: commandDigest(cmd),
      at: new Date().toISOString(),
      output,
    }) + '\n', 'utf8');
  }

  // Serialize file logging even when actions do not await ctx.log().
  function makeLog(dir) {
    let pending = Promise.resolve();
    let writeError;
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] ${String(msg).replace(/[\r\n]+/g, ' ')}\n`;
      process.stderr.write(line);
      pending = pending.then(() => fs.appendFile(path.join(dir, 'run.log'), line, 'utf8'))
        .catch((error) => { writeError ??= error; });
      return pending;
    };
    const flush = async () => {
      await pending;
      if (writeError) throw writeError;
    };
    return { log, flush };
  }

  function registryFilePath() {
    return process.env[`${prefix}_REGISTRY`]
      ? path.resolve(process.cwd(), process.env[`${prefix}_REGISTRY`])
      : fileURLToPath(actionsUrl);
  }

  // Imports stay lazy so a cached receipt works without sibling modules.
  async function runSingle(cmd) {
    let ev, run, logger;
    let ended = false;
    let claimPath = null;
    let claimOwner = null;
    let claimUncertain = false;
    let dispatched = false;
    try {
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) ||
          typeof cmd.action !== 'string' || !cmd.action.trim()) {
        throw new Error('missing action');
      }
      const key = cmd.idempotency_key;
      if (key !== undefined && key !== null) {
        if (typeof key !== 'string' || !key) throw new Error('idempotency_key must be a non-empty string');
        const digest = commandDigest(cmd);
        claimOwner = crypto.randomUUID();
        // N1: giữ claim TRƯỚC, đối soát receipt BÊN TRONG claim — khép race 2 process.
        claimPath = await acquireClaim(key, digest, claimOwner);
        if (!claimPath) {
          // Đang bị giữ: replay chỉ khi receipt đã có; ngược lại là UNCERTAIN (N2).
          const held = await findReceipt(key, digest);
          if (held.mismatch) throw new Error('IDEMPOTENCY_KEY_REUSED: key đã dùng cho command khác');
          if (held.found) return { ...held.found, replayed: true };
          throw new Error(`IDEMPOTENCY_UNCERTAIN: key đang bị giữ bởi claim ${claimFileFor(key)} — kết quả lần chạy trước không chắc chắn; đối soát tay rồi mới xóa claim để chạy lại`);
        }
        const { found, mismatch } = await findReceipt(key, digest);
        if (mismatch) {
          await releaseClaim(claimPath, claimOwner);
          claimPath = null;
          throw new Error('IDEMPOTENCY_KEY_REUSED: key đã dùng cho command khác');
        }
        if (found) {
          await releaseClaim(claimPath, claimOwner);
          claimPath = null;
          return { ...found, replayed: true };
        }
      }

      const registry = await import(pathToFileURL(registryFilePath()).href);
      const { actions } = registry;
      if (!actions || typeof actions !== 'object' ||
          !Object.hasOwn(actions, cmd.action) || typeof actions[cmd.action] !== 'function') {
        throw new Error(`unknown action: ${cmd.action}`);
      }
      // Registry import ở trên đã gọi configureSite() — core modules đọc site() lazy nên an toàn.
      ev = await import('../watch/evidence.mjs');
      const prim = await import('../primitives/primitives.mjs');
      run = ev.beginRun(cmd.action);
      logger = makeLog(run.dir);
      await logger.log(`Starting action: ${cmd.action}`);
      // Đường backup: action khai báo trong registry.cdpNotRequired (Set/Array tên action)
      // thì KHÔNG bắt buộc CDP — CDP sập vẫn chạy với page=null.
      // Registry không export cdpNotRequired → hành vi cũ (CDP bắt buộc, fail hard).
      // Dùng cho msi-cp: sys.exec/sys.processes/sys.tasks/sys.files chạy local,
      // không cần browser; chỉ sys.screenshot bắt buộc CDP.
      const noCdpDecl = registry.cdpNotRequired;
      const cdpOptional = noCdpDecl instanceof Set
        ? noCdpDecl.has(cmd.action)
        : (Array.isArray(noCdpDecl) && noCdpDecl.includes(cmd.action));
      let page = null;
      if (!cdpOptional) {
        try {
          ({ page } = await prim.connectCDP(cdpUrl));
        } catch (cdpError) {
          // Bắt buộc CDP mà chết → báo rõ địa chỉ + gợi ý, thay vì lỗi playwright thô.
          throw new Error(`CDP_UNREACHABLE at ${cdpUrl} — cần browser sống: ${errorText(cdpError)}`);
        }
      } else {
        // HOME-CP vendor delta (Codex vòng 2, F6): action thuộc cdpNotRequired của
        // home-cp KHÔNG BAO GIỜ dùng page (sys.* local; screenshot tự probe TCP +
        // agent-browser) — bỏ qua hẳn lần connect CDP của runner để khỏi tác dụng phụ
        // (tạo tab) và khỏi phụ thuộc playwright trên HOME.
        page = null;
      }
      if (gate !== 'none') {
        const watchdog = await import(watchdogUrl.href);
        // Never fly blind: gate every dispatch on the watchdog session check.
        const session = await watchdog.checkSession(page);
        if (gate === 'cloudflare-only') {
          // rea-cp là map tool: gate duy nhất là KHÔNG có Cloudflare challenge.
          // Login là thông tin (ghi vào evidence), không bắt buộc — trang public vẫn quét được.
          ev.logStep(run.runId, 'session.check', { ...session, loginRequired: false });
          if (!session || session.cloudflare === true) {
            throw new Error(`session check failed: ${errorText(session?.detail || 'cdp/page unreachable')}`);
          }
        } else {
          ev.logStep(run.runId, 'session.check', session);
          if (!session || session.loggedIn !== true || session.cloudflare === true) {
            throw new Error(`session check failed: ${errorText(session?.detail || 'not logged in')}`);
          }
        }
        await logger.log('Session check passed');
      }
      // Bind evidence to this runId: actions call ctx.ev.logStep(step, data).
      const evBound = { logStep: (step, data) => ev.logStep(run.runId, step, data) };
      const extra = typeof ctxExtra === 'function' ? ctxExtra(cmd) : {};
      dispatched = true; // F7: từ điểm này, MỌI failure đều giữ claim (kết quả không chắc chắn)
      const result = await actions[cmd.action]({ page, prim, ev: evBound, log: logger.log, ...extra }, cmd.params ?? {});
      if (result && typeof result === 'object' && result.ok === false) {
        throw new Error(result.error || 'action failed');
      }
      const output = {
        ok: true,
        data: result !== null && typeof result === 'object' && 'data' in result
          ? result.data : result,
        evidence_dir: run.dir,
      };
      // Verify serialization before committing a successful evidence receipt.
      JSON.stringify(output);
      await logger.log(`Completed action: ${cmd.action}`);
      await logger.flush();
      ended = true;
      await ev.endRun(run.runId, result);
      try {
        await appendIdempotent(cmd, output);
      } catch (receiptError) {
        // Action ĐÃ chạy nhưng receipt không ghi được: giữ claim + báo UNCERTAIN (N2/F7).
        claimUncertain = true;
        throw new Error(`IDEMPOTENCY_RECEIPT_FAILED: ${errorText(receiptError)} — claim được giữ để đối soát tay`);
      }
      // F9: keyed sys.exec exitCode != 0 không cache được — giữ claim, đánh dấu uncertain.
      if (key !== undefined && key !== null &&
          typeof output?.data?.exitCode === 'number' && output.data.exitCode !== 0) {
        output.idempotency = 'uncertain';
        claimPath = null; // giữ file claim trên đĩa (không release)
      } else {
        await releaseClaim(claimPath, claimOwner);
        claimPath = null;
      }
      return output;
    } catch (error) {
      const output = failure(error);
      if (logger) {
        await logger.log(`Failed: ${output.error}`);
        await logger.flush().catch((logError) => process.stderr.write(errorText(logError) + '\n'));
      }
      if (run && !ended) {
        await Promise.resolve().then(() => ev.endRun(run.runId, output))
          .catch((endError) => process.stderr.write(errorText(endError) + '\n'));
      }
      if (!claimUncertain && !dispatched) await releaseClaim(claimPath, claimOwner);
      claimPath = null;
      return output;
    }
  }

  // Sequential queue processing; unreadable or invalid JSON files remain available.
  async function runQueue() {
    // F10: phải bootstrap site (import registry -> configureSite) TRƯỚC beginRun,
    // nếu không site() throw ngay cả với queue rỗng.
    await import(pathToFileURL(registryFilePath()).href);
    const ev = await import('../watch/evidence.mjs');
    const batch = ev.beginRun('queue');
    const logger = makeLog(batch.dir);
    let ended = false;
    try {
      let files;
      try {
        files = (await fs.readdir(queueDir, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => entry.name).sort();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        files = [];
      }
      const results = [];
      for (const file of files) {
        const filename = path.join(queueDir, file);
        let cmd;
        try {
          cmd = parseArg(await fs.readFile(filename, 'utf8'));
        } catch (error) {
          results.push({ file, action: '', ...failure(error) });
          await logger.log(`${file}: ${errorText(error)}`);
          continue;
        }
        const output = await runSingle(cmd);
        const item = { file, action: typeof cmd.action === 'string' ? cmd.action : '', ok: output.ok };
        if (!output.ok) item.error = output.error;
        try {
          await fs.unlink(filename);
        } catch (error) {
          item.ok = false;
          item.error = [item.error, `queue deletion failed: ${errorText(error)}`].filter(Boolean).join('; ').slice(0, 500);
        }
        results.push(item);
        await logger.log(`${file}: ${item.ok ? 'ok' : item.error}`);
      }
      const succeeded = results.filter((item) => item.ok).length;
      const output = {
        ok: succeeded === results.length,
        data: { mode: 'queue', total: results.length, succeeded, failed: results.length - succeeded, results },
        evidence_dir: batch.dir,
      };
      await logger.flush();
      ended = true;
      await ev.endRun(batch.runId, output);
      return output;
    } catch (error) {
      const output = failure(error);
      await logger.log(`Queue failed: ${output.error}`);
      await logger.flush().catch((logError) => process.stderr.write(errorText(logError) + '\n'));
      if (!ended) {
        await Promise.resolve().then(() => ev.endRun(batch.runId, output))
          .catch((endError) => process.stderr.write(errorText(endError) + '\n'));
      }
      return output;
    }
  }

  // Reserve stdout for exactly one final JSON line, including sibling console logs.
  function readStdin() {
    return new Promise((resolve, reject) => {
      if (process.stdin.isTTY) return resolve(undefined);
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    });
  }

  const stdoutLog = console.log;
  console.log = (...args) => console.error(...args);
  let out;
  try {
    if (earlyError) throw earlyError;
    // F11/N3: validate FINAL path của mọi đích artifact tự động (base, receipt, claims,
    // queue, evidence) và neo claims + receipt vào store đã resolve — junction con
    // (claims/queue trỏ vào vùng bảo vệ) cũng bị chặn.
    const idemFinal = await resolveFinalWin(idempotencyFile);
    claimsDir = path.join(path.dirname(idemFinal), 'claims');
    const artifactDests = [baseDir, idemFinal, claimsDir, queueDir, config.evidenceDir].filter(Boolean);
    for (const dest of artifactDests) {
      const destFinal = dest === idemFinal ? idemFinal : await resolveFinalWin(dest);
      if (PROTECTED_ROOTS.some((r) => underRoot(r, destFinal))) {
        throw new Error(`refusing to run: artifact destination inside protected root: ${dest}`);
      }
    }
    // N3: receipt store là hardlink (nlink > 1) thì 2 tên khác nhau = 2 namespace claim
    // khác nhau trên cùng 1 file — từ chối, không hỗ trợ.
    try {
      const st = await fs.stat(idemFinal);
      if (st.nlink > 1) {
        throw new Error('refusing to run: idempotency store is hardlinked (nlink>1) — unsupported');
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    idempotencyFile = idemFinal;
    let raw = process.argv[2];
    if (raw === undefined || raw === '') raw = await readStdin();
    const cmd = parseArg(raw);
    out = cmd.queue === true ? await runQueue() : await runSingle(cmd);
    JSON.stringify(out);
  } catch (error) {
    out = failure(error);
  }
  process.exitCode = out.ok ? 0 : 1;
  console.log = stdoutLog;
  console.log(JSON.stringify(out));
  // Đóng hẳn process: CDP websocket giữ event loop sống, ssh sẽ treo chờ.
  // (Không đóng browser — chỉ thoát tiến trình node.)
  process.exit(process.exitCode);
}
