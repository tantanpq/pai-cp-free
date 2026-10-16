// Candidate Windows adapter. No daemon, helper protocol, implicit focus or backend fallback.
import { createHash } from 'node:crypto';

const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rectOK = r => Array.isArray(r) && r.length === 4 && r.every(finite) && r[2] > 0 && r[3] > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const controls = f => (f.elements ?? []).slice(0,500).map(e=>({...e,source:e.source ?? 'UIA',confidence:e.confidence ?? 1}));
const identity = f => ({ host:f.host, session_ref:f.session_ref, pid:f.pid, process_started_at:f.process_started_at,
  app:f.app, window_ref:f.window_ref, window_id:f.window_id, executable:f.executable });
const geometry = f => ({ rect_px:f.rect_px, dpi_scale:f.dpi_scale, display_id:f.display_id,
  screenshot_width:f.screenshot_width, screenshot_height:f.screenshot_height });

export function toWindowPoint(point, space, window) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(finite)) fail('UNSUPPORTED', 'Finite XY point required');
  const [ox,oy,w,h] = window.rect_px; let [x,y] = point;
  if (space === 'physical_screen_px') { x -= ox; y -= oy; }
  else if (space === 'window_normalized') { x *= w; y *= h; }
  else if (space === 'screenshot_px') {
    if (!(window.screenshot_width > 0 && window.screenshot_height > 0)) fail('UNSUPPORTED', 'Screenshot geometry unavailable');
    x *= w/window.screenshot_width; y *= h/window.screenshot_height;
  } else if (space !== 'physical_window_px') fail('UNSUPPORTED', 'Explicit coordinate space required');
  if (x < 0 || y < 0 || x >= w || y >= h) fail('TARGET_MISMATCH', 'Point outside exact target window');
  return [x,y];
}

/** PAI CP session integration supplies read-only read(target, params), perform(binding, action),
 * describe() and optional disconnect(). read MUST provide authoritative identity/geometry/session,
 * permission, focus and occlusion facts from the bound native backend. */
export function createAdapter(options = {}) {
  const backend = options.backend;
  const requireBackend = () => {
    if (!backend || typeof backend.read !== 'function' || typeof backend.perform !== 'function')
      fail('BLOCKED_SESSION', 'No interactive native backend bound to this adapter');
  };
  const validate = (target, f, mutation = false) => {
    if (f?.permission_allowed !== true) fail('BLOCKED_PERMISSION', 'Target permission not affirmatively allowed');
    if (f.interactive !== true || f.locked !== false || !f.session_ref) fail('BLOCKED_SESSION', 'Unlocked interactive target session required');
    if (f.host !== target.host || f.app !== target.app || f.window_ref !== target.window_ref)
      fail('TARGET_MISMATCH', 'Host/app/window identity mismatch');
    if (!Number.isInteger(f.pid) || f.pid <= 0 || !f.process_started_at || !f.executable || f.window_id == null)
      fail('BLOCKED_SESSION', 'Authoritative process/start/window binding unavailable');
    if (!rectOK(f.rect_px) || !finite(f.dpi_scale) || f.dpi_scale <= 0 || f.display_id == null)
      fail('BLOCKED_SESSION', 'Authoritative target geometry/DPI/display unavailable');
    if (mutation) {
      if (f.foreground !== true) fail('BLOCKED_SESSION', 'Target lost foreground; user takeover takes priority');
      if (f.occluded !== false || f.modal_blocked !== false) fail('OCCLUDED', 'Target occlusion/modal state not clear');
    }
  };
  const read = async (target, params={}) => {
    requireBackend(); await options.verifyResource?.();
    const f = await backend.read(target, params); validate(target,f); return f;
  };
  const preflight = async (target,snapshot,action) => {
    const f = await read(target,{include_image:'never',preflight:true}); validate(target,f,action.kind !== 'wait_for');
    const fingerprint = hash(identity(f));
    if (fingerprint !== snapshot.target_fingerprint) fail('TARGET_MISMATCH', 'Process/window/session changed since snapshot');
    const expected = snapshot.state?.geometry ?? { ...snapshot.window,
      screenshot_width:snapshot.window?.screenshot_width, screenshot_height:snapshot.window?.screenshot_height };
    if (!same(geometry(f),expected)) fail('STALE_SNAPSHOT', 'Window moved/resized, DPI or display changed');
    if (!(typeof f.input_tick==='string' && /^\d{1,10}$/.test(f.input_tick) && Number(f.input_tick)<=4294967295) || snapshot.state?.input_tick !== f.input_tick) fail('BLOCKED_SESSION','User input epoch changed since snapshot');
    if (snapshot.state?.controls && !same(controls(f),snapshot.state.controls)) fail('STALE_SNAPSHOT','UIA controls changed');
    const kinds = backend.describe?.().action_kinds ?? [];
    if (!kinds.includes(action.kind)) fail('UNSUPPORTED', 'Action unsupported by bound backend');
    let resolved = {...action};
    if (action.element_ref) {
      const element = snapshot.elements?.find(e => e.ref === action.element_ref);
      if (!element?.locator || !same(element.locator,action.resolved_element?.locator)) fail('STALE_SNAPSHOT', 'Exact snapshot UIA locator required');
      resolved.locator = element.locator;
    } else if (['click','double_click','scroll'].includes(action.kind)) {
      resolved.point = toWindowPoint(action.point,action.space,geometry(f)); resolved.space='physical_window_px';
    } else if (action.kind === 'drag') {
      resolved.from=toWindowPoint(action.from,action.space,geometry(f)); resolved.to=toWindowPoint(action.to,action.space,geometry(f)); resolved.space='physical_window_px';
      if (!finite(action.duration_ms) || action.duration_ms <= 0 || action.duration_ms > 30000) fail('UNSUPPORTED','Bounded drag duration required');
    }
    if (action.kind === 'type' && (!f.focused_locator || (resolved.locator && !same(f.focused_locator,resolved.locator))))
      fail('BLOCKED_SESSION','Editable work-surface focus must already be observed');
    if (action.kind === 'type' && action.clear === true && backend.describe?.().supports_clear !== true)
      fail('UNSUPPORTED','Backend does not provide explicit clear/fill');
    if (typeof backend.preflight !== 'function') fail('BLOCKED_SESSION','Read-only native preflight required');
    try { await backend.preflight(f,resolved); } catch(e) { const code=e.code||'NATIVE_PREFLIGHT_FAILED'; const error=new Error(code+': '+e.message);error.code=code;error.cpData={status:'FAILED',transport:'OK',action_state:'NOT_DISPATCHED',effect_state:'NO_EFFECT',postcondition:'UNKNOWN',reason:code};throw error; }
    return {facts:f,action:resolved,fingerprint};
  };
  return {
    async observe(target,params={}) {
      const f = await read(target,params);
      const elements=controls(f);
      if (params.region) fail('UNSUPPORTED','Region capture not qualified by this adapter');
      return { target_fingerprint:hash(identity(f)),session_ref:f.session_ref,
        window:geometry(f),elements,state:{identity:identity(f),geometry:geometry(f),controls:structuredClone(elements),
          focused_locator:f.focused_locator ?? null,input_tick:f.input_tick,visible_text:f.visible_text ?? f.document_text ?? '',document_text:f.document_text ?? null},
        ...(f.image ? {image:f.image} : {image_unavailable_reason:'Backend returned no scoped screenshot; native image gate unqualified'}) };
    },
    async preflight(target,snapshot,action) { await preflight(target,snapshot,action); },
    async execute(target,snapshot,action,{markAttempt,verifyResource}={}) {
      const bound=await preflight(target,snapshot,action); await verifyResource?.();
      if (action.kind === 'wait_for') {
        if (typeof backend.waitFor !== 'function') fail('UNSUPPORTED','Read-only wait backend missing');
        await backend.waitFor(bound.facts,bound.action);
        return {action_state:'READ_ONLY',effect_state:'UNVERIFIED'};
      }
      if (typeof markAttempt !== 'function') fail('BLOCKED_SESSION','Existing journal markAttempt required');
      await markAttempt({target_fingerprint:bound.fingerprint,session_ref:bound.facts.session_ref,window_ref:bound.facts.window_ref});
      try { await backend.perform(bound.facts,bound.action); }
      catch (cause) { const e = new Error('Native action outcome unknown; readback required', {cause}); e.code='UNKNOWN_EFFECT'; throw e; }
      return {action_state:'DISPATCHED',effect_state:'UNVERIFIED'};
    },
    capabilities() {
      const d=backend?.describe?.() ?? {};
      return {installed:!!backend,reachable:d.reachable === true,qualified:d.qualified === true,
        action_kinds:d.action_kinds ?? [],known_limits:[
          'An exact configured process/window/session binding and resource lease are required',
          'No implicit activation, retries, broad desktop capture or denial fallback',
          'Native postcondition and next snapshot are owned by existing core',
          'Qualification is limited to the bound backend scope and its native test evidence',...(d.known_limits ?? [])]};
    },
    async close() { await backend?.disconnect?.(); }
  };
}
