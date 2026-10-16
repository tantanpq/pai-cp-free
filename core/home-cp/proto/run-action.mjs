// run-action.mjs — HOME Control Plane CLI (thin wrapper, chuẩn CP B1).
// Logic nằm ở core/proto/runner.mjs (core vendor trong gói, xem ..\core\).
// Contract CLI giữ nguyên: node proto/run-action.mjs '<json>' | stdin → 1 dòng JSON trên stdout.
import { runCli } from '../core/proto/runner.mjs';

let sharedConfig = {};
try {
  sharedConfig = await import(new URL('../config.mjs', import.meta.url).href);
} catch (e) {
  // Chỉ fallback khi config.mjs thực sự không tồn tại; lỗi khác (syntax, deploy hỏng) phải fail rõ.
  const msg = String(e?.message || '');
  if (!(e?.code === 'ERR_MODULE_NOT_FOUND' && msg.includes('config.mjs'))) throw e;
}

await runCli({
  prefix: 'HOME_CP',
  config: sharedConfig,
  actionsUrl: new URL('../actions-home/registry.mjs', import.meta.url),
  watchdogUrl: new URL('../watch/watchdog.mjs', import.meta.url),
  defaults: { dir: 'C:\\temp\\home-cp', cdp: 'http://127.0.0.1:9336' },
  gate: 'none', // home-cp không có browser session gate (giống msi-cp/suno-cp)
  ctxExtra: null,
});
