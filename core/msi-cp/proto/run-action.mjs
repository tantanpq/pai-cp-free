// run-action.mjs — MSI Control Plane CLI (thin wrapper, chuẩn CP B1).
// Logic nằm ở browser-control-plane-core/proto/runner.mjs.
// Contract CLI giữ nguyên: node proto/run-action.mjs '<json>' | stdin → 1 dòng JSON trên stdout.
import { runCli } from '../../browser-control-plane-core/proto/runner.mjs';

let sharedConfig = {};
try {
  sharedConfig = await import(new URL('../config.mjs', import.meta.url).href);
} catch (e) {
  // Chỉ fallback khi config.mjs thực sự không tồn tại; lỗi khác (syntax, deploy hỏng) phải fail rõ (finding #11).
  const msg = String(e?.message || '');
  if (!(e?.code === 'ERR_MODULE_NOT_FOUND' && msg.includes('config.mjs'))) throw e;
}

await runCli({
  prefix: 'MSI_CP',
  config: sharedConfig,
  actionsUrl: new URL('../actions-msi/registry.mjs', import.meta.url),
  watchdogUrl: new URL('../watch/watchdog.mjs', import.meta.url),
  defaults: { dir: 'C:\\temp\\msi-cp', cdp: 'http://127.0.0.1:9336' },
  gate: 'none', // msi-cp không có browser session gate (giống suno-cp)
  ctxExtra: null,
});
