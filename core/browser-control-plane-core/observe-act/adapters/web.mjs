import {createExactPage, keySpec, validateViewportRegion} from './cdp-page.mjs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, detail = '') => { const error = new Error(`${code}${detail ? ': ' + detail : ''}`); error.code = code; throw error; };
const limit = (value, max = 160) => String(value ?? '').slice(0, max);
const kinds = ['click', 'double_click', 'type', 'press', 'scroll', 'wait_for'];

// Coordinates are scoped to the browser content viewport, never the OS chrome.
export function transformPoint(point, space, window, imageGeometry = null, region = null) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) fail('INVALID_COORDINATE');
  const [w, h] = window.viewport_css_px, scale = window.dpi_scale;
  let [x, y] = point;
  if (space === 'physical_window_px') { x /= scale; y /= scale; }
  else if (space === 'window_normalized') { x *= w; y *= h; }
  else if (space === 'screenshot_px' && region) { validateRegionMapping(region,imageGeometry); const [ox,oy,rw,rh]=region.rect; if(x<0||y<0||x>=rw||y>=rh)fail('POINT_OUTSIDE_REGION');x+=ox;y+=oy; }
  else if (space !== 'screenshot_px') fail('UNSUPPORTED_COORDINATE_SPACE', 'physical_screen_px requires trusted native viewport origin');
  if (x < 0 || y < 0 || x >= w || y >= h) fail('INVALID_COORDINATE', 'outside content viewport');
  if(region)insideRegion([x,y],region);
  return [x, y];
}
const regionMapping=region=>({space:'viewport_css_px',source_rect_css_px:[...region.rect],image_size_px:region.rect.slice(2),css_pixels_per_image_pixel:[1,1]});
function validateRegionMapping(region,mapping){const expected=regionMapping(region);if(!mapping||Object.keys(mapping).sort().join(',')!==Object.keys(expected).sort().join(',')||Object.keys(expected).some(k=>JSON.stringify(expected[k])!==JSON.stringify(mapping[k])))fail('INVALID_IMAGE_GEOMETRY');}
function insideRegion(point,region){const[x,y,w,h]=region.rect;if(point[0]<x||point[1]<y||point[0]>=x+w||point[1]>=y+h)fail('POINT_OUTSIDE_REGION');}

function collectDOM({ maximumElements }) {
  const round = n => Math.round(n * 100) / 100;
  const cut = (v, n = 160) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const selector = el => {
    const parts = [];
    while (el && el.nodeType === 1) {
      const tag = el.tagName.toLowerCase();
      const siblings = el.parentElement ? [...el.parentElement.children].filter(x => x.tagName === el.tagName) : [el];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(el) + 1})`);
      el = el.parentElement;
    }
    return parts.join(' > ');
  };
  const secretNodes = document.querySelectorAll('input[type="password"],[autocomplete*="password"],[data-cp-secret]');
  const visibleSecret = secretNodes.length > 10000 || [...secretNodes].some(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
    for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || Number(s.opacity) === 0) return false; }
    return true;
  });
  const elements = [];
  const controls = document.querySelectorAll('button,a[href],input,textarea,select,[role],[contenteditable="true"],h1,h2,h3,output,label');
  for (const el of controls) {
    if (elements.length >= maximumElements) break;
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight || style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0 || el.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
    const tag = el.tagName.toLowerCase(), isSecret = el.type === 'password' || el.autocomplete?.includes('password') || el.hasAttribute('data-cp-secret');
    const implicit = { button: 'button', a: 'link', textarea: 'textbox', input: ['checkbox','radio'].includes(el.type) ? el.type : 'textbox', select: 'combobox', output: 'status', label: 'label', h1: 'heading', h2: 'heading', h3: 'heading' }[tag] || (el.isContentEditable ? 'textbox' : 'generic');
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const name = cut(el.getAttribute('aria-label') || labelled || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.textContent);
    const bounds = [rect.x, rect.y, rect.width, rect.height].map(round);
    elements.push({ role: el.getAttribute('role') || implicit, name, bounds_css_px: bounds, bounds_px: bounds.map(n => round(n * devicePixelRatio)), source: 'DOM', confidence: 1, editable: !el.readOnly && (tag === 'textarea' || el.isContentEditable || tag === 'input' && ['text','search','url','tel','email','password'].includes(el.type)),
      locator: { kind: 'css', selector: selector(el) }, disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), checked: typeof el.checked === 'boolean' ? el.checked : null,
      value: isSecret ? '[REDACTED]' : ('value' in el ? cut(el.value, 256) : null), ['secret']: isSecret, focused: document.activeElement === el });
  }
  // Only rendered text nodes, never selectors, aria-label metadata or input values.
  const text = [], walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node, inspected = 0, textSize = 0;
  while ((node = walker.nextNode()) && inspected++ < 10000 && textSize < 8192) {
    const parent = node.parentElement, value = cut(node.textContent, 1024);
    if (!parent || !value || parent.closest('script,style,noscript,template,[hidden],[inert],[data-cp-secret],input[type="password"]')) continue;
    let visible = true;
    for (let el = parent; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) { visible = false; break; }
    }
    if (!visible) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    if (![...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight)) continue;
    const bounded = value.slice(0, 8192 - textSize); text.push(bounded); textSize += bounded.length + 1;
  }
  return { elements, visibleSecret, visible_text: text.join(' ').slice(0, 8192), geometry: { viewport_css_px: [innerWidth, innerHeight], dpi_scale: devicePixelRatio, scroll_css_px: [round(scrollX), round(scrollY)], visual_viewport: visualViewport ? [round(visualViewport.width),round(visualViewport.height),round(visualViewport.scale),round(visualViewport.offsetLeft),round(visualViewport.offsetTop)] : null }, document_time_origin: performance.timeOrigin, visibility: document.visibilityState, ready: document.readyState };
}

function beginCaptureEpoch(key){
  if(typeof MutationObserver!=='function'||Object.hasOwn(globalThis,key))throw Error('CAPTURE_EPOCH_UNAVAILABLE');
  const state={changed:false,observer:null,timer:null};
  const cleanup=()=>{state.observer?.disconnect();delete globalThis[key]};
  state.observer=new MutationObserver(()=>{state.changed=true});
  state.observer.observe(document.documentElement||document,{subtree:true,childList:true,attributes:true,characterData:true});
  state.timer=setTimeout(cleanup,30000);Object.defineProperty(globalThis,key,{value:state,configurable:true});return true;
}
function endCaptureEpoch(key){const state=globalThis[key];if(!state)throw Error('CAPTURE_EPOCH_LOST');const changed=state.changed||state.observer.takeRecords().length>0;clearTimeout(state.timer);state.observer.disconnect();delete globalThis[key];return changed;}

export function createAdapter(options = {}) {
  let browser = options.browser ?? null, ownConnection = false;
  let scopedPage = options.page ?? null, direct = null, directTarget = null;
  const sessions = new Map();
  const verify = async callback => { if (callback) await callback(); else if (options.verifyResource) await options.verifyResource(); };
  async function connect() {
    if (!browser) {
      if (!options.cdpUrl) fail('BLOCKED_SESSION', 'cdpUrl missing');
      const require = createRequire(import.meta.url);
      function loadPlaywrightCore() {
        const candidates = [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', 'C:\\temp\\msi-bin\\node_modules\\playwright-core'].filter(Boolean);
        let lastError;
        for (const candidate of candidates) {
          try { return require(candidate); } catch (error) { lastError = error; }
        }
        throw new Error('PLAYWRIGHT_CORE_NOT_FOUND: run `npm install` at the pai-cp repository root, or set PLAYWRIGHT_CORE_PATH. Last error: ' + lastError.message);
      }
      const pw = loadPlaywrightCore();
      browser = await pw.chromium.connectOverCDP(options.cdpUrl, { timeout: 10000 });
      ownConnection = true;
    }
    return browser;
  }
  async function resolve(target) {
    if (target?.surface !== 'web' || !target.host || !target.tab_id || !target.origin) fail('TARGET_MISMATCH', 'host/surface/tab_id/origin required');
    if (options.host && options.host !== target.host) fail('TARGET_MISMATCH', 'host binding');
    await verify();
    if (!scopedPage && !options.browser) {
      direct = await createExactPage({cdpUrl: options.cdpUrl, target, verifyResource: options.verifyResource});
      scopedPage = direct.page; directTarget = JSON.stringify([target.host,target.tab_id,target.origin,target.document_url??null]);
    }
    if (direct && directTarget !== JSON.stringify([target.host,target.tab_id,target.origin,target.document_url??null])) fail('TARGET_MISMATCH', 'adapter bound to one exact page');
    const b = scopedPage ? null : await connect();
    const rootSession = b?.newBrowserCDPSession ? await b.newBrowserCDPSession() : null;
    const deadline = Date.now() + 1000;
    try { do {
      if (rootSession) {
        try { const exact = await rootSession.send('Target.getTargetInfo', {targetId: target.tab_id}); if (exact.targetInfo.targetId !== target.tab_id) fail('TARGET_MISMATCH', 'exact target gone'); }
        catch (error) { if (/No target with given id|Target closed|Session closed|has been detached/i.test(String(error.message))) fail('TARGET_MISMATCH', 'exact target gone'); throw error; }
      }
    const pages = scopedPage ? [scopedPage] : b.contexts().flatMap(context => context.pages());
    for (const page of pages) {
      if (page.isClosed()) continue;
      let session = sessions.get(page);
      let targetInfo;
      try {
        if (!session) { session = await page.context().newCDPSession(page); sessions.set(page, session); }
        ({ targetInfo } = await session.send('Target.getTargetInfo'));
      } catch (error) {
        if (!/Target page, context or browser has been closed|Target closed|Session closed|has been detached/i.test(String(error.message))) throw error;
        sessions.delete(page);
        if (session) await session.detach().catch(() => {});
        continue; // Exact tab identity still required; a closed target fails below.
      }
      if (targetInfo.targetId !== target.tab_id) continue;
      let origin;
      try { origin = new URL(page.url()).origin; } catch { fail('TARGET_MISMATCH', 'invalid target URL'); }
      if (origin !== target.origin) fail('TARGET_MISMATCH', 'origin changed');
      if (origin === 'null' && (!target.document_url?.startsWith('file:///') || page.url() !== target.document_url)) fail('TARGET_MISMATCH', 'opaque origin requires exact file document_url');
      if (options.allowedOrigins && !options.allowedOrigins.includes(origin)) fail('BLOCKED_PERMISSION', 'origin not configured');
      return { page, session, targetInfo, origin };
    }
      if (!rootSession || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline-Date.now()))));
    } while (true);
    fail('TARGET_MISMATCH', 'exact CDP tab unavailable');
    } finally { if (rootSession) await rootSession.detach().catch(() => {}); }
  }
  async function observe(target, params = {}) {
    const { page, session, targetInfo, origin } = await resolve(target);
    const imageMode=params.include_image??'none',wantsImage=['auto','full','always',true].includes(imageMode),epochKey=wantsImage?'__pai_cp_capture_'+crypto.randomUUID():null;
    let epochOpen=false,captured=null;
    try{
    if(epochKey){if(await page.evaluate(beginCaptureEpoch,epochKey)!==true)fail('CAPTURE_EPOCH_UNAVAILABLE');epochOpen=true;}
    const dom = await page.evaluate(collectDOM, { maximumElements: Math.min(500, Math.max(1, params.maximum_elements ?? 500)) });
    const region=params.region==null?null:validateViewportRegion(params.region,...dom.geometry.viewport_css_px);
    const { frameTree } = await session.send('Page.getFrameTree');
    const window = { rect_px: [0,0,...dom.geometry.viewport_css_px.map(n => n * dom.geometry.dpi_scale)], display_id: 'browser-content-viewport', ...dom.geometry, coordinate_origin: 'content-viewport', screenshot_scale: 1 };
    const binding = { host: target.host, tab_id: targetInfo.targetId, origin, document_url: origin === 'null' ? target.document_url : undefined, browser_context: targetInfo.browserContextId || 'default', frame_id: frameTree.frame.id, loader_id: frameTree.frame.loaderId, document_time_origin: dom.document_time_origin, geometry: dom.geometry };
    const state = { target: binding, elements: dom.elements, visible_text: dom.visible_text, visibility: dom.visibility, ready: dom.ready };
    const result = { target_fingerprint: 'sha256:' + sha(binding), session_ref: `cdp:${binding.browser_context}:${binding.tab_id}:${binding.loader_id}`, window, elements: dom.elements, state,...(region?{region,image_geometry:null}:{}) };
    if (wantsImage) {
      if (dom.visibleSecret === true || dom.elements.some(el => el.secret)) { result.image_unavailable_reason = 'SECRET_CONTROL_VISIBLE'; }
      else{
        if(region){if(typeof page.captureViewportRegion!=='function')fail('REGION_CAPTURE_BACKEND_UNSUPPORTED');captured=await page.captureViewportRegion(region,{timeout:10000,expectedGeometry:dom.geometry});}
        else captured=await page.screenshot({type:'png',fullPage:false,scale:'css',timeout:10000});
        const afterDOM=await page.evaluate(collectDOM,{maximumElements:Math.min(500,Math.max(1,params.maximum_elements??500))});
        if(afterDOM.visibleSecret===true||afterDOM.elements.some(el=>el.secret))fail('SECRET_CONTROL_DURING_CAPTURE');
        if(JSON.stringify(afterDOM)!==JSON.stringify(dom))fail('STALE_SNAPSHOT','DOM changed during capture');
        const post=await resolve(target),{frameTree:afterFrame}=await post.session.send('Page.getFrameTree');
        const afterBinding={...binding,tab_id:post.targetInfo.targetId,origin:post.origin,browser_context:post.targetInfo.browserContextId||'default',frame_id:afterFrame.frame.id,loader_id:afterFrame.frame.loaderId,document_time_origin:afterDOM.document_time_origin,geometry:afterDOM.geometry};
        if(JSON.stringify(afterBinding)!==JSON.stringify(binding))fail('STALE_SNAPSHOT','target/frame changed during capture');
        const changed=await page.evaluate(endCaptureEpoch,epochKey);epochOpen=false;if(changed!==false)fail('CAPTURE_MUTATION_DURING_CAPTURE');
        result.image={bytes:captured,mime:'image/png',kind:region?'crop':'full'};if(region)result.image_geometry=regionMapping(region);
      }
    } else result.image_unavailable_reason = imageMode === 'auto' ? 'AUTO_IMAGE_NOT_QUALIFIED_REQUEST_FULL' : 'REQUESTED_NONE';
    await verify();
    return result;
    }catch(error){if(captured)captured.fill(0);throw error;}
    finally{if(epochOpen){try{await page.evaluate(endCaptureEpoch,epochKey)}catch{}}}
  }
  function expectedElement(action) {
    const el = action.resolved_element;
    if (!el?.locator || el.locator.kind !== 'css' || typeof el.locator.selector !== 'string' || !el.locator.selector) fail('INVALID_ELEMENT_REF', 'core-resolved DOM locator required');
    return el;
  }
  async function check(target, snapshot, action) {
    if (!kinds.includes(action.kind)) fail('UNSUPPORTED_ACTION');
    const region=snapshot.region==null?null:validateViewportRegion(snapshot.region,...snapshot.window.viewport_css_px);
    if(region){if(!['click','type','wait_for'].includes(action.kind)||action.kind==='type'&&action.clear!==true)fail('REGION_ACTION_UNSUPPORTED');if(typeof snapshot.image_ref!=='string'||!snapshot.image_ref||!/^sha256:[a-f0-9]{64}$/.test(snapshot.image_sha256||''))fail('BLOCKED_VISUAL_BINDING');validateRegionMapping(region,snapshot.image_geometry);}
    if (direct && action.kind === 'press') keySpec(action.key);
    const visualAction = Boolean(action.point || action.from || action.to);
    if (visualAction && !/^sha256:[a-f0-9]{64}$/.test(snapshot.image_sha256 || '')) fail('BLOCKED_VISUAL_BINDING', 'coordinate action requires persisted snapshot image hash');
    const current = await observe(target, { region, include_image: visualAction||region ? 'always' : 'none' });
    if (visualAction||region) {
      if (!current.image?.bytes) fail('BLOCKED_VISUAL_BINDING', current.image_unavailable_reason || 'current target image unavailable');
      const imageHash = 'sha256:' + crypto.createHash('sha256').update(current.image.bytes).digest('hex');
      if (imageHash !== snapshot.image_sha256) fail('STALE_SNAPSHOT', 'target pixels changed');
    }
    if (current.target_fingerprint !== snapshot.target_fingerprint) fail('STALE_SNAPSHOT', 'target/document/geometry changed');
    if (JSON.stringify(current.state) !== JSON.stringify(snapshot.state)) fail('STALE_SNAPSHOT', 'DOM state changed');
    const { page } = await resolve(target);
    let expected, point;
    if (action.resolved_element) {
      expected = expectedElement(action);
      const actual = current.elements.find(el => el.locator.selector === expected.locator.selector);
      if (!actual || JSON.stringify(actual) !== JSON.stringify(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'ref')))) fail('STALE_SNAPSHOT', 'element changed');
      if (actual.secret && action.kind === 'type') fail('BLOCKED_PERMISSION', 'secret entry unsupported');
      if (action.kind === 'type' && !actual.editable) fail('INVALID_ACTION', 'editable text control required');
      if (actual.disabled) fail('OCCLUDED', 'element disabled');
      const [x,y,w,h] = actual.bounds_css_px;
      point = [x + w / 2, y + h / 2];
    } else if (action.point) point = transformPoint(action.point, action.space, current.window,snapshot.image_geometry,region);
    else if (!['wait_for'].includes(action.kind)) fail('INVALID_ACTION', 'element or point required');
    if(point&&region)insideRegion(point,region);
    if (point && !['wait_for'].includes(action.kind)) {
      const hit = await page.evaluate(({ point, selector }) => {
        const hit = document.elementFromPoint(...point), el = selector ? document.querySelector(selector) : null;
        if (!hit) return { okay: false };
        if (el) return { okay: el === hit || el.contains(hit) };
        const styles = getComputedStyle(hit);
        const overlay = hit.closest('[aria-modal="true"],dialog[open]');
        return { okay: !overlay && styles.pointerEvents !== 'none' };
      }, { point, selector: expected?.locator.selector });
      if (!hit.okay) fail('OCCLUDED', 'hit-test mismatch/overlay');
    }
    if (['type','press'].includes(action.kind) && !expected) fail('INVALID_ACTION', 'type/press require element ref');
    if (action.kind === 'type' && (typeof action.text !== 'string' || action.text.length > 65536)) fail('INVALID_ACTION', 'bounded text required');
    if (action.kind === 'press' && (typeof action.key !== 'string' || !/^(?:(?:Control|Alt|Shift|Meta)\+)*(?:[A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(action.key))) fail('INVALID_ACTION', 'supported key required');
    if (action.kind === 'scroll' && (!Array.isArray(action.delta) || action.delta.length !== 2 || !action.delta.every(n => Number.isFinite(n) && Math.abs(n) <= 10000))) fail('INVALID_ACTION', 'bounded delta required');
    return { page, expected, point };
  }
  async function preflight(target, snapshot, action) { await check(target, snapshot, action); }
  async function execute(target, snapshot, action, context = {}) {
    await verify(context.verifyResource);
    const { page, expected, point } = await check(target, snapshot, action);
    const timeout = Math.min(30000, Math.max(1, context.timeout_ms ?? 5000));
    if (action.kind === 'wait_for') {
      if (!expected) fail('INVALID_ACTION', 'wait_for requires resolved element');
      await page.locator(expected.locator.selector).waitFor({ state: 'visible', timeout });
      return { action_state: 'NOT_DISPATCHED', effect_state: 'OBSERVED' };
    }
    if (typeof context.markAttempt !== 'function') fail('INVALID_ACTION', 'journal markAttempt required');
    let handle;
    if (expected) {
      handle = await page.$(expected.locator.selector);
      if (!handle) fail('STALE_SNAPSHOT');
    }
    try {
      await verify(context.verifyResource);
      await context.markAttempt({ host: target.host, surface: target.surface, tab_id: target.tab_id, origin: target.origin, target_fingerprint: snapshot.target_fingerprint, kind: action.kind });
      // One dispatch, concrete handle, no semantic fallback or uncertain retry.
      if (action.kind === 'click' || action.kind === 'double_click') {
        if (handle) await handle.click({ timeout, clickCount: action.kind === 'double_click' ? 2 : 1, noWaitAfter: true,...(snapshot.region?{cp_region:snapshot.region}:{}) });
        else await page.mouse.click(...point, { clickCount: action.kind === 'double_click' ? 2 : 1 });
      } else if (action.kind === 'type') {
        if (action.clear === true) await handle.fill(action.text, { timeout, noWaitAfter: true,...(snapshot.region?{cp_region:snapshot.region}:{}) });
        else {
          await handle.focus();
          await handle.evaluate(el => {
            if (typeof el.setSelectionRange === 'function' && ['text','search','url','tel','password'].includes(el.type) || el.tagName === 'TEXTAREA') el.setSelectionRange(el.value.length, el.value.length);
            else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
          });
          await page.keyboard.insertText(action.text);
        }
      }
      else if (action.kind === 'press') await handle.press(action.key, { timeout, noWaitAfter: true });
      else if (action.kind === 'scroll') { await page.mouse.move(...point); await page.mouse.wheel(...action.delta); }
      return { action_state: 'DISPATCHED', effect_state: 'UNVERIFIED' };
    } finally { if (handle) await handle.dispose(); }
  }
  async function close() {
    for (const session of sessions.values()) await session.detach().catch(() => {});
    sessions.clear();
    if (ownConnection && browser) await browser.close(); // CDP disconnect, never page close.
    if (direct) await direct.close();
    direct = null; scopedPage = options.page ?? null; directTarget = null;
    browser = options.browser ?? null; ownConnection = false;
  }
  function capabilities() { return { installed: true, reachable: Boolean(options.page || options.browser || options.cdpUrl), qualified: false, action_kinds: kinds, region:{candidate:true,space:'viewport_css_px',actions:['click','type(clear)','wait_for'],image_kind:'crop',pixel_delta:false},known_limits: ['Content viewport coordinates only; physical_screen_px unavailable', 'No shadow DOM/iframe traversal in v1', 'ROI capture requires exact-page captureViewportRegion hook and unpinched visual viewport; pixel delta unimplemented', 'Auto captures current pixels; unchanged images are reused by the existing engine', 'Production observe/step uses existing exact-page CDP with bounded protocol requests', 'Declared private geometry blocks screenshots conservatively; no arbitrary text/iframe/shadow redaction', 'Native qualification is fixture-specific, never implied by installed/reachable'] }; }
  return { observe, preflight, execute, close, capabilities };
}
