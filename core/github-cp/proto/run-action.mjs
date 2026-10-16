// run-action.mjs — GitHub Control Plane CLI (thin wrapper, B1).
// Logic nằm ở browser-control-plane-core/proto/runner.mjs.
// Contract CLI giữ nguyên: node proto/run-action.mjs '<json>' | stdin → 1 dòng JSON trên stdout.
// LƯU Ý behavior được giữ nguyên: ctx có thêm idempotencyKey (như bản cũ).
import { runCli } from '../../browser-control-plane-core/proto/runner.mjs';

let sharedConfig = {};
try {
  sharedConfig = await import(new URL('../config.mjs', import.meta.url).href);
} catch { /* config optional */ }

await runCli({
  prefix: 'GITHUB_CP',
  config: sharedConfig,
  actionsUrl: new URL('../actions-github/registry.mjs', import.meta.url),
  watchdogUrl: new URL('../watch/watchdog.mjs', import.meta.url),
  defaults: { dir: 'C:\\temp\\github-cp', cdp: 'http://127.0.0.1:9336' },
  gate: 'strict',
  ctxExtra: (cmd) => ({ idempotencyKey: cmd.idempotency_key ?? null }),
});
