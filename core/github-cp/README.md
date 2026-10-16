# GitHub Control Plane — README

**Web thứ 3 trong tầm nhìn "master control" của Tân (sau Suno, ChatGPT).**
Lý do tồn tại: tool `github call-tool` bị thẻ approve MỖI LẦN (Tân check kỹ 2026-10-10 23:35,
không có always-allow) — đi đường browser trên MSI để hết phiền. Read giữ nguyên tool API
(không bị approve), plane này chỉ bao phần **WRITE**.

Cùng kiến trúc 5 lớp, cùng luật cứng — điều khiển github.com trên MSI qua CDP như "tay robot từ xa",
không viết script rời rạc cho từng thao tác.

Build spec (Tân duyệt 2026-10-10 23:35): `GITHUB_CONTROL_PLANE_BUILD.md`.
Tham chiếu kiến trúc gốc: `~/workspace/zmedia-music/SUNO_CONTROL_PLANE_V1.md` (+ source `~/workspace/suno-control-plane/`,
`~/workspace/chatgpt-control-plane/`). `proto/`, `primitives/`, `watch/` tái dùng nguyên — chỉ viết mới
`actions-github/registry.mjs`.

## 1. Kiến trúc 5 lớp (tóm tắt)

```
[Máy Muse]  Lớp 1 — Mặt điều khiển (CLI: node proto/run-action.mjs '{"action":"..."}')
      │  JSON command {action, params, idempotency_key} qua SSH
      ▼
[MSI]       Lớp 2 — Action Registry (actions-github/registry.mjs):
              mỗi action = công thức đã verify gồm micro-bước;
              locate theo thứ tự fallback: accessibility role → text → JS evaluate → tọa độ calibrate
            Lớp 3 — Primitives (primitives/primitives.mjs): tay robot ở mức khớp
              goto, click, fill_robust, press_key, scroll_panel, screenshot, read_state, wait_state
            Lớp 4 — Session watchdog (watch/watchdog.mjs): trước job kiểm tra login github.com,
              rớt thì báo ngay, không chạy mù
            Lớp 5 — Evidence log (watch/evidence.mjs): screenshot + state JSON + thời gian mỗi action
      ▼
[github.com] Trang đích (Chrome CDP :9336, session Tân login tay 1 lần — PREREQUISITE, chưa confirm)
```

## 2. Cấu trúc thư mục (trên MSI: `C:\temp\github-cp\` — KHÔNG đè `C:\temp\suno-cp\`, `C:\temp\chatgpt-cp\`, `C:\temp\chatgpt\`, `C:\temp\social\`)

| File | Vai trò |
|------|---------|
| `config.mjs` | Cấu hình: CDP URL (port **9336**), đường dẫn deploy/evidence/idempotency. Nhịp người thật (500–1200ms) hardcode trong registry, không ở config |
| `proto/run-action.mjs` | Điểm vào CLI: nhận JSON command (argv hoặc stdin) → tra registry → chạy action → **stdout đúng 1 dòng JSON**, exit code 0/1 |
| `primitives/primitives.mjs` | Lớp 3: các thao tác CDP nguyên thủy (tay robot ở mức khớp) — tái dùng từ ChatGPT CP |
| `watch/evidence.mjs` | Lớp 5: `beginRun(action)` tạo `evidence/<runId>/`, lưu screenshot + steps.jsonl + kết quả — tái dùng |
| `watch/watchdog.mjs` | Lớp 4: `checkSession(page)` — phát hiện rớt login github.com trước khi chạy — tái dùng, đổi target site |
| `actions-github/registry.mjs` | Lớp 2: **4 actions GitHub (xem §3)** — viết mới duy nhất |
| `README.md`, `deploy.sh` | Tài liệu + script đóng gói/deploy từ máy Muse |

`run-action.mjs` đọc command theo 2 cách: `node proto/run-action.mjs '{"action":"..."}'` hoặc
pipe JSON qua stdin (`echo '...' | node proto/run-action.mjs`). Command là JSON object
`{action, params, idempotency_key}` — `idempotency_key` ở TOP-LEVEL (không trong params).
Khi `cmd.queue === true`, nó chạy tuần tự các file job trong thư mục `queue/`
(mỗi job 1 file JSON) rồi gom kết quả.

## 3. 4 actions + cách gọi CLI mẫu

Mọi lệnh chạy **trên MSI** trong `C:\temp\github-cp` (từ máy Muse gọi qua SSH — xem `deploy.sh` phần SSH template).

> Giả định giao diện từ ChatGPT Control Plane: thư mục gốc đọc từ env `GITHUB_CP_DIR`
> (mặc định `C:\temp\github-cp`), CDP cố định `http://127.0.0.1:9336`.
> **Quy tắc đặt tên CLI (QA ChatGPT): param names đúng như spec, `idempotency_key` ở TOP-LEVEL (không trong params).**
> Tên param `discussion_number` đã đối chiếu với code lane (b) (QA 2026-10-11): registry dùng
> `discussion_number`, khớp ví dụ ở mục 4 dưới. (Spec BUILD.md không ghi tên param cho discussion.)

```powershell
cd C:\temp\github-cp
```

1. **`session.check`** — kiểm tra đã login github.com chưa + user nào, không làm gì khác:
   ```powershell
   node proto/run-action.mjs '{"action":"session.check"}'
   ```
2. **`issue.comment`** — comment vào issue (dùng chính cho relay Issue #19). **Idempotency bắt buộc** vì là action ghi:
   ```powershell
   node proto/run-action.mjs '{"action":"issue.comment","params":{"owner":"tantanpq","repo":"pai-core-private","issue_number":19,"body":"Nightly update: lane github-cp docs done (README + deploy.sh). No changes to code."},"idempotency_key":"gh-issue-comment-20261011-01"}'
   ```
3. **`issue.create`** — tạo issue mới. **Idempotency bắt buộc** vì là action ghi:
   ```powershell
   node proto/run-action.mjs '{"action":"issue.create","params":{"owner":"tantanpq","repo":"pai-core-private","title":"[lane] Tiêu đề test vô hại","body":"Nội dung test dry-run."},"idempotency_key":"gh-issue-create-20261011-01"}'
   ```
4. **`discussion.comment`** — comment vào discussion (cho Council HQ). **Idempotency bắt buộc** vì là action ghi:
   ```powershell
   node proto/run-action.mjs '{"action":"discussion.comment","params":{"owner":"tantanpq","repo":"pai-core-private","discussion_number":1,"body":"Council HQ test comment — dry-run."},"idempotency_key":"gh-discussion-comment-20261011-01"}'
   ```

Kết quả mỗi action: 1 dòng JSON trên stdout, ví dụ:
`{"ok":true,"data":{"issue_url":"https://github.com/tantanpq/pai-core-private/issues/19#issuecomment-..."},"evidence_dir":"C:\\temp\\github-cp\\evidence\\20261011-071500-issue.comment-ab12"}`.

## 4. Evidence / Idempotency / Queue — ở đâu (trên MSI)

| Thành phần | Vị trí |
|-----------|--------|
| Evidence mỗi action | `C:\temp\github-cp\evidence\<runId>\` — screenshot từng bước + `steps.jsonl` + kết quả JSON. `runId` dạng `YYYYMMDD-HHMMSS-<action>-<hex4>`. Không có evidence = chưa xong. |
| Idempotency (chống double-comment) | `C:\temp\github-cp\idempotency.jsonl` — 1 dòng/receipt thành công cho mỗi `idempotency_key`. Action ghi (`issue.comment`, `issue.create`, `discussion.comment`) gửi lại cùng key → trả về kết quả cũ, không chạy lại. Receipt hỏng (JSON vỡ) thì BÁO LỖI, không cho phép chạy lại mù. |
| Queue (job xếp hàng) | `C:\temp\github-cp\queue\` — mỗi file 1 JSON command; `node proto/run-action.mjs '{"queue":true}'` chạy tuần tự, file xong thì xóa, log tổng vào evidence batch. |
| Log từng action | trong `evidence/<runId>/steps.jsonl` (ghi nối tiếp có thứ tự, flush trước khi thoát) |

## 5. Luật cứng

- **PHẠM VI CHỈ WRITE:** `issue.comment`, `issue.create`, `discussion.comment` — đúng việc Tân hay làm.
- **KHÔNG merge, KHÔNG close/reopen, KHÔNG xóa, KHÔNG push code, KHÔNG đụng setting repo** (BUILD.md). Action nào ngoài 4 cái trên bị registry từ chối.
- **CDP port 9336** cho Chrome chung của MSI (social + Suno + GitHub). Sai port = không chạy.
- **Retry tối đa 2 lần**, mỗi lần đổi chiến lược locate; lỗi lặp 2 lần → dừng, đổi cách (luật LANE_RULES_V1). Không spam retry.
- **Nhịp người thật** giữa các action (delay config trong `config.mjs`); github.com rate-limit IP lạ nhanh.
- Mọi action đều sinh evidence (screenshot + steps.jsonl).
- Deploy vào `C:\temp\github-cp\`, **tuyệt đối không đè** `C:\temp\suno-cp\`, `C:\temp\chatgpt-cp\`, `C:\temp\chatgpt\`, `C:\temp\social\`.
- **KHÔNG chạm trang thật trong build này** — viết code + docs, test dry-run sau.

## 6. Prerequisite + plan dry-run (sau khi em review)

**PREREQUISITE (chưa confirm): Tân login github.com 1 lần trên cửa sổ Chrome MSI port 9336**
(cửa sổ Chrome chung — TikTok/FB/Suno đã có session ở đó). Dry-run CHỈ chạy sau khi confirm login.

Chạy tuần tự trên MSI, từng bước kiểm tra `ok:true` + evidence trước khi bước tiếp:

1. `session.check` — xác nhận login OK, biết user nào.
2. `issue.comment` — **1 comment test vô hại lên issue RIÊNG (không phải #19)**, verify comment hiện đúng trên trang.
3. (tùy) `issue.create` — 1 issue test, Tân đóng tay trên github.com sau khi verify (plane không có action close theo luật cứng).
4. Verify evidence: screenshot thấy comment/issue đã hiện.

## Fallback thủ công (nếu `deploy.sh` lỗi)

1. Trên máy Muse: `cd ~/workspace/github-control-plane && tar -czf /tmp/github-cp.tar.gz config.mjs proto/run-action.mjs primitives/primitives.mjs watch/evidence.mjs watch/watchdog.mjs actions-github/registry.mjs`
2. `base64 /tmp/github-cp.tar.gz > /tmp/github-cp.b64`
3. SSH sang MSI (xem template SSH trong `deploy.sh`) → tạo thư mục `C:\temp\github-cp` → chép từng phần base64 → trên MSI: `[IO.File]::WriteAllBytes('C:\temp\github-cp\github-cp.tar.gz',[Convert]::FromBase64String('<base64>'))`
4. Trên MSI: `tar -xzf C:\temp\github-cp\github-cp.tar.gz -C C:\temp\github-cp`
5. Kiểm tra: `node --check` 6 file + `dir C:\temp\github-cp` — đủ 6 file mới xong.
