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
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireBrowser, operationStore, effectActions, digest } from './operations.mjs';

// Export riêng để test được config resolution mà không cần chạy CLI.
export function resolveCliConfig({ prefix, config = {}, defaults = {} }) {
  const baseDir = process.env[`${prefix}_DIR`] || config.deployDir || defaults.dir;
  const cdpUrl = process.env[`${prefix}_CDP`] || config.cdpUrl || defaults.cdp;
  return { baseDir, cdpUrl };
}

const errorText = (error) => String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 500);
const failure = (error) => ({ ok: false, error: errorText(error), ...(error?.cpData ? {data:error.cpData} : {}) });

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
  const idempotencyFile = path.join(baseDir, 'idempotency.jsonl');
  const queueDir = path.join(baseDir, 'queue');

  // Successful receipts only; the last matching record wins.
  async function checkIdempotent(key, cmd) {
    if (key === undefined || key === null) return null;
    let contents;
    try {
      contents = await fs.readFile(idempotencyFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
    let output = null;
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // A damaged receipt must not silently permit another side effect.
        throw new Error('invalid idempotency record');
      }
      if (record.idempotency_key === key && record.output?.ok === true) {
        if(effectActions.has(cmd.action)&&!record.payloadHash)throw Error('IDEMPOTENCY_LEGACY_UNBOUND: reconcile old receipt before submit');
        if(record.payloadHash && record.payloadHash !== digest({action:cmd.action,params:cmd.params??{}})) throw Error('IDEMPOTENCY_KEY_REUSED');
        if(record.action !== cmd.action) throw Error('IDEMPOTENCY_KEY_REUSED');
        output = record.output;
      }
    }
    return output;
  }

  async function appendIdempotent(cmd, output) {
    if (cmd.idempotency_key === undefined || cmd.idempotency_key === null || !output.ok) return;
    await fs.mkdir(baseDir, { recursive: true });
    await fs.appendFile(idempotencyFile, JSON.stringify({
      idempotency_key: cmd.idempotency_key,
      action: cmd.action,
      payloadHash: digest({action:cmd.action,params:cmd.params??{}}),
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

  // Imports stay lazy so a cached receipt works without sibling modules.
  async function runSingle(cmd) {
    let ev, run, logger;
    let releaseBrowser, operation, attachedBrowser;
    let page=null,ownedPage=false,cleanupPage=false;
    let ended = false;
    try {
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) ||
          typeof cmd.action !== 'string' || !cmd.action.trim()) {
        throw new Error('missing action');
      }
      const store=operationStore(baseDir);
      if(cmd.action==='operation.get') return {ok:true,data:await store.get(cmd.idempotency_key)};
      if(effectActions.has(cmd.action)) {
        const old=await store.get(cmd.idempotency_key);
        if(old){
          if(old.payloadHash!==digest({action:cmd.action,params:cmd.params??{}}))throw Error('IDEMPOTENCY_KEY_REUSED');
          if(old.output)return {...old.output,replayed:true,operation_id:old.operationId};
          throw Error('OUTCOME_UNCERTAIN: reconcile operation '+old.operationId+'; submit will not replay');
        }
      }
      const cached = await checkIdempotent(cmd.idempotency_key,cmd);
      if (cached) return { ...cached, replayed: true };

      const registryPath = process.env[`${prefix}_REGISTRY`]
        ? path.resolve(process.cwd(), process.env[`${prefix}_REGISTRY`])
        : fileURLToPath(actionsUrl);
      const registry = await import(pathToFileURL(registryPath).href);
      let actions = registry.actions;
      let observeExtension;
      if (['cp.observe','cp.step','capabilities.describe'].includes(cmd.action)) {
        const { createUniversalRegistry, resolveActivation } = await import('../observe-act/registry.mjs');
        const activation = await resolveActivation({baseDir});
        if(activation.flags.web || activation.flags.desktop) {
          observeExtension = createUniversalRegistry({baseDir,cdpUrl,prefix,legacyActions:actions,activation});
          actions = {...actions,...observeExtension.actions};
        }
      }
      cleanupPage=registry.closeRunnerPage===true;
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
      const cdpOptional = observeExtension?.actions[cmd.action] ? true : noCdpDecl instanceof Set
        ? noCdpDecl.has(cmd.action)
        : (Array.isArray(noCdpDecl) && noCdpDecl.includes(cmd.action));
      if (!cdpOptional) {
        releaseBrowser=await acquireBrowser(cdpUrl);
        try {
          ({ browser:attachedBrowser,page,ownedPage } = await prim.connectCDP(cdpUrl));
        } catch (cdpError) {
          // Bắt buộc CDP mà chết → báo rõ địa chỉ + gợi ý, thay vì lỗi playwright thô.
          throw new Error(`CDP_UNREACHABLE at ${cdpUrl} — cần browser sống: ${errorText(cdpError)}`);
        }
      } else {
        await logger.log(`Browser not required for ${cmd.action}`);
      }
      if (gate !== 'none' && !cdpOptional) {
        const watchdog = await import(watchdogUrl.href);
        // Never fly blind: gate every dispatch on the watchdog session check.
        const session = await watchdog.checkSession(page);
        if (gate === 'cloudflare-only') {
          // rea-cp là map tool: gate duy nhất là KHÔNG có Cloudflare challenge.
          // Login là thông tin (ghi vào evidence), không bắt buộc — trang public vẫn quét được.
          ev.logStep(run.runId, 'session.check', { ...session, loginRequired: false });
          if (!session || session.readError || session.cloudflare === true) {
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
      if(effectActions.has(cmd.action)){operation=await store.begin(cmd);if(operation.cached)return operation.cached;}
      const extra = typeof ctxExtra === 'function' ? ctxExtra(cmd) : {};
      if(releaseBrowser)await releaseBrowser.verify();
      const result = await actions[cmd.action]({ page, prim, ev: evBound, log: logger.log, operation,verifyResource:releaseBrowser?.verify, ...extra }, cmd.params ?? {});
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
      const completed=operation ? await operation.complete(output) : output;
    try{await appendIdempotent(cmd, completed);}catch(e){if(!operation)throw e;await logger.log('Compatibility receipt append failed; durable operation already committed: '+errorText(e));}
      return completed;
    } catch (error) {
      const output = failure(error);
      if(operation?.fail)await operation.fail(output);
      if (logger) {
        await logger.log(`Failed: ${output.error}`);
        await logger.flush().catch((logError) => process.stderr.write(errorText(logError) + '\n'));
      }
      if (run && !ended) {
        await Promise.resolve().then(() => ev.endRun(run.runId, output))
          .catch((endError) => process.stderr.write(errorText(endError) + '\n'));
      }
      return output;
    } finally {
      try{if(cleanupPage&&ownedPage&&page&&!page.isClosed())await page.close();}
      finally{try{if(attachedBrowser)await attachedBrowser.close();}finally{if(releaseBrowser)await releaseBrowser();}}
    }
  }

  // Sequential queue processing; unreadable or invalid JSON files remain available.
  async function runQueue() {
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
  // Attached CDP client was disconnected in finally. Let Node drain stdout
  // and websocket shutdown naturally; forced exit races native libuv handles.
}
