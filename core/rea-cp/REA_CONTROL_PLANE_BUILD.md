# REA Control Plane (`rea-cp`) — build doc

**Ngày build:** 2026-10-11. **Trạng thái:** code complete, chưa live-test.

## 1. Nó là gì

`rea-cp` là **build-time map tool**, KHÔNG phải runtime service plane như
`suno-cp` / `chatgpt-cp` / `github-cp` / `grok-cp`. Nhiệm vụ duy nhất: quét
một trang web qua REA (`inspect-web-page` trên CDP) → trả bản đồ JSON
(structure, scripts, network, accessibility) → coding agent dùng bản đồ đó
để build control plane, không đoán selector.

Pipeline build lane mới rút gọn:
1. `rea-cp map.scan` → bản đồ thật của target (evidence JSON)
2. Coding agent (Codex trên MSI) build control plane từ bản đồ
3. Muse review QA → deploy

## 2. Phạm vi

Actions (2):
- `map.scan` — CDP endpoint + URL + observationMs → JSON evidence
  (`C:\temp\rea-cp\evidence\<runId>\`). **Read-only**: mở trang, quan sát,
  không click, không điền, không submit, không paid action.
- `map.diff` — đối chiếu selector chain với map JSON →
  `VERIFIED` / `NEEDS-CHANGE` (+ candidate names) / `NOT-FOUND`.

## 3. Hard exclusions

- **Không** rewrite config agent (`npx rea-agents setup` cấm dùng — CLI only).
- **Không** anti-bot / CAPTCHA evasion dưới mọi hình thức.
- **Không** paid action trên target (không generate, không mua, không subscribe).
- **Không** phân tích native binary trong plane này (chi phí Hopper/Ghidra/IDA —
  nếu cần, là lane riêng, Tân approve riêng).
- **Không** dùng output REA làm verdict — nó là evidence + limitations, agent
  vẫn phải verify bằng mắt/screenshot.

## 4. Kỹ thuật

- MSI: `npx.cmd` (không phải `npx.ps1` — execution policy chặn).
- REA CLI: `list-browser-targets <endpoint>` → tìm targetId trùng URL →
  `inspect-web-page <endpoint> <targetId> --observation-ms N
  --include-accessibility-text --format json`.
- `--token-limit` không tương thích `--format json` → bỏ.
- Output JSON đọc từ stdout của child_process (KHÔNG `>` PowerShell — nó ghi UTF-16).
- REA DOM export chỉ có attribute NAMES, không có values.
- **Stale tab treo inspect (2026-10-11):** `inspect-web-page` treo vô thời hạn
  trên tab background/stale — `map.scan` LUÔN lấy targetId từ chính page nó
  navigate (CDP `Target.getTargetInfo`), không đoán từ `list-browser-targets`;
  đóng tab sau scan để browser sạch.
- CDP mặc định: port 9336 (shared Chrome MSI). Env override: `REA_CP_CDP`, `REA_CP_ENDPOINT`.
- Retry phẳng tối đa 2 attempt. Idempotency + evidence theo chuẩn family.
- Gate khác family: chỉ chặn khi có Cloudflare; login là thông tin, không bắt buộc
  (trang public vẫn quét được).

## 5. Khách hàng đầu tiên

`grok-cp` — calibrate selector từ `rea-map-20261011.json`
(xem `~/workspace/grok-control-plane/SELECTOR_CALIBRATION.md`):
Video mode radio (không phải tab), prompt "Ask Grok anything",
upload button "Upload". Tiếp theo: `chatgpt-cp`, `github-cp`.

## 6. Test đã chạy (evidence)

- 2026-10-11: REA test lane quét thật `grok.com/imagine` trên MSI — 1090
  accessibility nodes, 1982 DOM nodes, ~2 phút, zero config, read-only,
  không Cloudflare, login verified (không đụng quota).
