// run-action.mjs — REA Control Plane CLI (thin wrapper, B1).
// Logic nằm ở browser-control-plane-core/proto/runner.mjs.
// Contract CLI giữ nguyên: node proto/run-action.mjs '<json>' | stdin → 1 dòng JSON trên stdout.
// LƯU Ý behavior được giữ nguyên: gate 'cloudflare-only' — rea là map tool, login chỉ là
// thông tin (ghi evidence), không bắt buộc; trang public vẫn quét được.
import { runCli } from '../../browser-control-plane-core/proto/runner.mjs';

let sharedConfig = {};
try {
  sharedConfig = await import(new URL('../config.mjs', import.meta.url).href);
} catch { /* config optional */ }

await runCli({
  prefix: 'REA_CP',
  config: sharedConfig,
  actionsUrl: new URL('../actions-rea/registry.mjs', import.meta.url),
  watchdogUrl: new URL('../watch/watchdog.mjs', import.meta.url),
  defaults: { dir: 'C:\\temp\\rea-cp', cdp: 'http://127.0.0.1:9333' },
  gate: 'cloudflare-only',
  ctxExtra: null,
});
