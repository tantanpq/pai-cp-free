// primitives.mjs — browser-control-plane-core (shared).
// Canonical source duy nhất cho 5 site CP. Gộp từ bản ChatGPT CP (mới nhất — có fix
// RegExp .pattern, lazy locator resolution, fill 2-path) + hàm uploadFile từ Grok CP.
// Site cấu hình qua configureSite() trong site.mjs — KHÔNG import config của site nào.
// Contract giữ nguyên: connectCDP, clickLocate, fillRobust, pressKey, readState,
// waitState, shot, loadCalibration/saveCalibration, uploadFile. Tọa độ calibrate = tỉ lệ 0..1.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { site, siteEnv } from '../site.mjs';

const require = createRequire(import.meta.url);
function loadPlaywrightCore() {
  const candidates = [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', 'C:\\temp\\msi-bin\\node_modules\\playwright-core'].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) { lastError = error; }
  }
  throw new Error('PLAYWRIGHT_CORE_NOT_FOUND: run `npm install` at the pai-cp repository root, or set PLAYWRIGHT_CORE_PATH. Last error: ' + (lastError && lastError.message));
}
const { chromium } = loadPlaywrightCore();
// Lazy: deployDir chỉ có sau khi site gọi configureSite().
const calibrationDir = () => path.join(site().deployDir, 'calibration');
const describe = target => JSON.stringify(target);
const log = (...args) => {
  if (siteEnv('DEBUG') === '1') console.log(...args);
};

async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await fn(); } catch (error) {
      log(label, attempt, error.message);
      if (attempt === 2) throw error;
    }
  }
}

function validCoord(fx, fy) {
  return typeof fx === 'number' && Number.isFinite(fx) && fx >= 0 && fx <= 1
    && typeof fy === 'number' && Number.isFinite(fy) && fy >= 0 && fy <= 1;
}

async function clickElement(page, found, timeout) {
  if (found.kind === 'locator') {
    await found.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await found.locator.click({ timeout });
  } else if (found.kind === 'handle') {
    await found.handle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await found.handle.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
    const box = await found.handle.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) throw new Error('Element has no clickable bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await page.mouse.click(found.x, found.y);
  }
}

async function locateElement(page, target, click = false) {
  const steps = [
    ['role', 8000, async () => {
      if (!target.role) return null;
      // target.name đã là RegExp (hoặc string) — dùng trực tiếp. KHÔNG dùng .pattern
      // (RegExp JS không có .pattern → new RegExp(undefined) thành regex rỗng khớp MỌI textbox).
      const nm = target.name instanceof RegExp ? target.name
        : (target.name && typeof target.name === 'object' ? new RegExp(target.name.source, target.name.flags) : target.name);
      return { kind: 'locator', locator: page.getByRole(target.role, nm ? { name: nm } : {}).first() };
    }],
    ['text', 5000, async () => target.text
      ? { kind: 'locator', locator: page.getByText(target.text).first() } : null],
    ['js', 5000, async () => {
      if (!target.js) return null;
      // target.js là function string "() => ..." — phải INVOKE mới trả về element.
      // evaluateHandle trực tiếp chỉ trả về function object → asElement() null.
      const h = await page.evaluateHandle(`(${target.js})()`);
      const handle = h.asElement();
      if (!handle) { await h.dispose(); throw new Error('Expression did not return element'); }
      return { kind: 'handle', handle };
    }],
    ['coord', 5000, async () => {
      if (!target.coord || !validCoord(target.coord.fx, target.coord.fy)) return null;
      const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      return { kind: 'coord', x: target.coord.fx * vp.w, y: target.coord.fy * vp.h };
    }],
  ];
  for (const [label, timeout, resolve] of steps) {
    // Mỗi strategy thử đúng 1 lần — chuỗi fallback [role,text,js,coord] chính là retry.
    try {
      const candidate = await resolve();
      if (!candidate) continue;
      try {
        if (click) await clickElement(page, candidate, timeout);
        else if (candidate.kind === 'locator') await candidate.locator.waitFor({ state: 'visible', timeout });
      } catch (error) {
        if (candidate.kind === 'handle') await candidate.handle.dispose().catch(() => {});
        throw error;
      }
      return candidate;
    } catch (error) { log('locate exhausted', label, error.message); }
  }
  throw new Error('LOCATE_FAILED: exhausted [role,text,js,coord] tried for ' + JSON.stringify(target));
}

export async function connectCDP(cdpUrl = site().cdpUrl) {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
  const ctx = browser.contexts()[0];
  if(!ctx)throw Error('BROWSER_CONTEXT_UNAVAILABLE');
  // Ưu tiên tab của site đang điều khiển (web-agnostic qua env), rồi mới tới tab bất kỳ.
  const prefer = siteEnv('PREFER_URL') || site().preferUrl;
  const targetId=siteEnv('TARGET_ID');
  let page,ownedPage=false;
  if(targetId){
    for(const p of ctx.pages()){
      const session=await ctx.newCDPSession(p);
      try{const {targetInfo}=await session.send('Target.getTargetInfo');if(targetInfo.targetId===targetId)page=p;}finally{await session.detach();}
      if(page)break;
    }
    if(!page)throw Error('BROWSER_TARGET_NOT_FOUND');
  }else{
    page=prefer?ctx.pages().find(p=>p.url().includes(prefer)):null;
    if(!page){page=await ctx.newPage();ownedPage=true;}
  }
  return { browser, page,ownedPage };
  }catch(error){await browser.close();throw error;}
}

export async function clickLocate(page, target) {
  const found = await locateElement(page, target, true);
  if (found.kind === 'handle') await found.handle.dispose().catch(() => {});
}
export async function clickOnce(page,target){
  const found=await locateElement(page,target,false);
  try{return await clickElement(page,found,5000);}
  finally{if(found.kind==='handle')await found.handle.dispose();}
}

export async function fillRobust(page, target, text) {
  const found = await locateElement(page, target);
  const mismatch = () => new Error('FILL_FAILED: value mismatch for ' + describe(target));
  // Resolve LAZY locator -> CONCRETE handle đúng 1 lần (tránh re-resolution sai sau React re-render).
  // KHÔNG dùng Playwright fill(): nó click/focus theo tọa độ, đã chứng minh fill nhầm
  // sang field khác (title -> style). Chỉ dùng native setter trực tiếp trên DOM node.
  const toHandle = async () => {
    if (found.kind === 'handle') return found.handle;
    if (found.kind === 'locator') {
      const h = await found.locator.elementHandle();
      if (!h) throw mismatch();
      return h;
    }
    throw mismatch(); // coord: không có element
  };
  let handle = null;
  try {
    handle = await toHandle();
    const readValue = () => handle.evaluate((n, empty) => { const value=n.isContentEditable?n.innerText:n.value; return empty&&n.isContentEditable&&/^[\r\n]*$/.test(value)?'':value; },text==='').catch(() => null);
    // Path 1: Playwright fill trên concrete handle (focus/events chuẩn).
    try {
      await withRetry(async () => {
        await handle.fill(text);
        if ((await readValue()) !== text) throw mismatch();
      }, 'fill:playwright');
      return 'fill';
    } catch (error) { log('fill fallback', error.message); }
    // Path 2: native setter trực tiếp trên DOM node (không click/focus theo tọa độ).
    await withRetry(async () => {
      await handle.evaluate((node, val) => {
        node.scrollIntoView({ block: 'center', inline: 'center' });
        const win = node.ownerDocument.defaultView;
        if (node.isContentEditable) {
          node.focus();
          const sel = win.getSelection();
          sel.selectAllChildren(node);
          if (!node.ownerDocument.execCommand('insertText', false, val)) node.textContent = val;
        } else {
          const proto = node.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype
            : node.tagName === 'INPUT' ? win.HTMLInputElement.prototype : null;
          const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (!setter) throw new Error('Native value setter unavailable');
          setter.call(node, val);
        }
        node.dispatchEvent(new win.Event('input', { bubbles: true }));
        node.dispatchEvent(new win.Event('change', { bubbles: true }));
      }, text);
      if ((await readValue()) !== text) throw mismatch();
    }, 'fill:native');
    return 'js';
  } finally {
    if (handle) await handle.dispose().catch(() => {});
  }
}

export async function pressKey(page, key) {
  return withRetry(() => page.keyboard.press(key), 'pressKey');
}

export async function readState(page, jsExpr) {
  return page.evaluate(new Function('return (' + jsExpr + ')'));
}

export async function waitState(page, jsExpr, timeoutMs) {
  if (!(timeoutMs > 0)) throw new Error('WAIT_TIMEOUT: invalid timeoutMs');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await readState(page, jsExpr).catch(() => undefined);
    if (v) return v;
    if (Date.now() >= deadline) throw new Error('WAIT_TIMEOUT: ' + jsExpr);
    await new Promise(r => setTimeout(r, 250));
  }
}

export async function shot(page, label) {
  const dir = siteEnv('EVIDENCE_DIR') || site().evidenceDir;
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(label || 'shot').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 80) || 'shot';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fp = path.join(dir, ts + '-' + safe + '.png');
  await withRetry(() => page.screenshot({ path: fp }), 'shot');
  return fp;
}

export function loadCalibration(name) {
  const n = String(name);
  if (/(\.\.|[\\/])/.test(n)) return null;
  const fp = path.join(calibrationDir(), n + '.json');
  try {
    const o = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!validCoord(o.fx, o.fy)) return null;
    return { fx: o.fx, fy: o.fy, anchor: o.anchor ?? null };
  } catch { return null; }
}

export function saveCalibration(name, { fx, fy, anchor }) {
  const n = String(name);
  if (/(\.\.|[\\/])/.test(n)) throw new Error('saveCalibration: invalid name');
  if (!validCoord(fx, fy)) throw new Error('saveCalibration: fx,fy must be numbers in [0,1]');
  fs.mkdirSync(calibrationDir(), { recursive: true });
  const fp = path.join(calibrationDir(), n + '.json');
  fs.writeFileSync(fp, JSON.stringify({ fx, fy, anchor: anchor ?? null, savedAt: new Date().toISOString() }, null, 2));
  return fp;
}

// Upload file cho input[type=file] ẩn — dùng setInputFiles trực tiếp (không click).
// (Gộp từ Grok CP — hàm generic, site nào cũng dùng được.)
export async function uploadFile(page, inputTarget, filePath) {
  const found = await locateElement(page, inputTarget);
  let handle = null;
  try {
    if (found.kind === 'handle') handle = found.handle;
    else if (found.kind === 'locator') handle = await found.locator.elementHandle();
    else throw new Error('UPLOAD_INPUT_NOT_RESOLVABLE: need DOM element, got coord');
    if (!handle) throw new Error('UPLOAD_INPUT_NOT_FOUND');
    await withRetry(() => handle.setInputFiles(filePath), 'uploadFile');
    return 'upload';
  } finally {
    if (handle && found.kind !== 'handle') await handle.dispose().catch(() => {});
  }
}
export async function uploadFileOnce(page,inputTarget,filePath,beforeEffect){
  const found=await locateElement(page,inputTarget);let handle;
  try{handle=found.kind==='handle'?found.handle:found.kind==='locator'?await found.locator.elementHandle():null;if(!handle)throw Error('UPLOAD_INPUT_NOT_FOUND');await beforeEffect?.();await handle.setInputFiles(filePath);return 'upload';}
  finally{await handle?.dispose().catch(()=>{});}
}
