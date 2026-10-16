# browser-control-plane-core

Core framework dùng chung cho 5 control plane của Tân
(suno / chatgpt / github / grok / rea). Tách ra trong B1 (2026-10-11) từ các bản
copy-paste `proto/`, `primitives/`, `watch/` ở mỗi site.

## Cấu trúc

```
browser-control-plane-core/
  site.mjs                 — per-process bootstrap: configureSite({prefix, cdpUrl, deployDir, evidenceDir, preferUrl})
  primitives/primitives.mjs— clickLocate, fillRobust, pressKey, readState, waitState, shot,
                             loadCalibration/saveCalibration, uploadFile, connectCDP
  proto/runner.mjs         — runCli(): CLI engine (idempotency, queue, evidence, session gate)
  watch/evidence.mjs       — beginRun, logStep, endRun
  deploy-core.sh           — deploy core lên MSI: C:\temp\browser-control-plane-core\
```

## Contract cho site plugin

Mỗi site giữ: `config.mjs`, `actions-<site>/registry.mjs`, `proto/run-action.mjs`
(wrapper mỏng gọi `runCli`), `watch/watchdog.mjs` (site-specific — KHÔNG gộp vì
mỗi site có login signal khác nhau), docs.

1. `registry.mjs` gọi ở ĐẦU module:
   ```js
   import { configureSite } from '../../browser-control-plane-core/site.mjs';
   import { cdpUrl, deployDir, evidenceDir } from '../config.mjs';
   configureSite({ prefix: 'SUNO_CP', cdpUrl, deployDir, evidenceDir, preferUrl: 'suno.com' });
   ```
2. `proto/run-action.mjs`:
   ```js
   import { runCli } from '../../browser-control-plane-core/proto/runner.mjs';
   await runCli({ prefix: 'SUNO_CP', config: sharedConfig, actionsUrl, watchdogUrl,
                  defaults: { dir: 'C:\\temp\\suno-cp', cdp: 'http://127.0.0.1:9336' },
                  gate: 'strict' | 'cloudflare-only' | 'none', ctxExtra: null });
   ```
3. Deploy layout trên MSI: core ở `C:\temp\browser-control-plane-core\`, mỗi site ở
   `C:\temp\<site>-cp\`. Import tương đối `../../browser-control-plane-core/...`
   đúng ở cả workspace lẫn MSI.

## Env var contract (giữ nguyên, không đổi tên)

`<PREFIX>_DIR`, `<PREFIX>_CDP`, `<PREFIX>_REGISTRY`, `<PREFIX>_DEBUG`,
`<PREFIX>_PREFER_URL`, `<PREFIX>_EVIDENCE_DIR` — vd `SUNO_CP_DEBUG`.

## Lưu ý B1

- `watch/watchdog.mjs` KHÔNG gộp (site-specific). `rea` primitives từng đọc nhầm
  `CHATGPT_CP_*` (copy-paste bug) — sau B1 đọc đúng `REA_CP_*`; không ảnh hưởng prod
  vì worker không set các env này (verify trong báo cáo B1).
- `require('C:\temp\msi-bin\node_modules\playwright-core')` giữ nguyên trong core (B2 mới env-driven).
- Backup bản cũ: `_backup-20261011/<site>/`.
