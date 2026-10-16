# HOME Control Plane v1 (home-cp)

Control plane điều khiển PC HOME (`DESKTOP-0L1K3A7`, user `Tom`) — Tân duyệt
2026-10-12 để **Codex HOME dùng thay computer use** (lúc được lúc không).
Dựng theo đúng khuôn msi-cp: JSON vào stdin → 1 dòng JSON ra stdout, mỗi action
sinh evidence dir. CP là CLI tool, **không phải daemon** — mỗi lần chạy = 1
process node độc lập, chạy xong tự thoát.

Deploy dir trên HOME: `C:\temp\home-cp\`
Core dùng chung (browser-control-plane-core) được **vendor trong gói** tại
`core\` (site.mjs + proto/runner.mjs + watch/evidence.mjs +
primitives/primitives.mjs) để gói tự chứa — không ghi gì ngoài
`C:\temp\home-cp\` trên HOME. Khác biệt duy nhất trong core vendor:
`primitives.mjs` nạp playwright-core kiểu best-effort (HOME không có
`C:\temp\msi-bin`) — thiếu thì `connectCDP` báo lỗi rõ; home-cp không có
browser action nào dùng primitives nên sys.* không bị ảnh hưởng.

## Actions v1

| Action | Params | Mô tả |
|---|---|---|
| `sys.exec` | `{command, timeout_ms?}` | Chạy lệnh PowerShell local. Denylist lệnh destructive GIỮ NGUYÊN từ msi-cp (format, diskpart, shutdown, restart, bcdedit, reg HKLM, EncodedCommand, IEX...). Timeout 1s–300s (mặc định 30s). |
| `sys.processes` | `{name?}` | Liệt kê process (Name, Id, CPU, MemMB). Lọc theo tên nếu có. |
| `sys.tasks` | `{op, name?}` | Task Scheduler: `list` \| `run` \| `enable` \| `disable`. `name` bắt buộc trừ `list`. |
| `sys.screenshot` | `{port?, path?}` | Chụp màn hình Chrome qua agent-browser CLI (`--cdp http://127.0.0.1:<port>`). Mặc định port 9336, lưu `C:\temp\home-cp\screenshots\home-<ts>.png`. **HOME mặc định không có Chrome CDP thường trực** → action này báo lỗi rõ `SYS_SCREENSHOT_NEEDS_CHROME`; 4 action sys.* còn lại KHÔNG cần Chrome (đường lazy-CDP như msi-cp). |
| `sys.files` | `{op, path, content?}` | `read`/`write` file text. Giới hạn 5MB. **Read chỉ trong `C:\temp`**. Ghi bị chặn: `C:\Windows*`, `C:\Program Files*`, `C:\ProgramData*`, `*authorized_keys`, **`C:\scoring-service\*` và `C:\temp\sunolisten\*`** (hai hệ đang chạy trên HOME — cấm đụng). |

## Chạy 1 action (pattern chuẩn — pipe qua stdin, KHÔNG qua argv)

PowerShell 5.1 strip dấu `"` khi truyền qua argv → luôn ghi JSON ra file rồi
pipe qua stdin:

```powershell
'{"action":"sys.exec","params":{"command":"hostname"}}' | Out-File -Encoding utf8 C:\temp\smoke.json
cd C:\temp\home-cp
Get-Content C:\temp\smoke.json -Raw | node proto/run-action.mjs
```

Kết quả đúng 1 dòng JSON trên stdout: `{"ok":true,"data":{...},"evidence_dir":"..."}`
(hoặc `{"ok":false,"error":"..."}` + exit 1). Evidence từng lần chạy:
`C:\temp\home-cp\evidence\<ts>-<action>-<rand>\` (run.json + steps.jsonl + result.json + run.log).

## Codex HOME gọi thế nào (chạy LOCAL trên HOME — khỏi SSH)

Codex HOME chạy ngay trên máy này nên gọi thẳng, không qua SSH:

```powershell
cd C:\temp\home-cp
'{"action":"sys.exec","params":{"command":"$env:COMPUTERNAME"}}' | Out-File -Encoding utf8 C:\temp\s.json
Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
```

- Cần xem/chạm hệ thống HOME (process, task, file trong `C:\temp`, lệnh
  PowerShell) → dùng home-cp thay computer use: kết quả JSON có cấu trúc +
  evidence, tất định, không phụ thuộc trạng thái cửa sổ.
- Thêm `"idempotency_key":"<khóa>"` vào JSON khi action có side effect mà
  không muốn chạy trùng: runner giữ **claim cross-process** (có owner token)
  *trước* khi đối soát receipt và chạy (2 process cùng khóa không chạy
  trùng được), receipt gắn **digest canonical của action+params** (dùng lại
  khóa cho command khác → lỗi `IDEMPOTENCY_KEY_REUSED`). Claim **không tự
  hết hạn**: nếu một lần chạy chết giữa chừng, hoặc `sys.exec` keyed trả
  `exitCode != 0` (không cache được), claim được giữ và lần gọi lại nhận
  lỗi `IDEMPOTENCY_UNCERTAIN` — operator phải đối soát tay kết quả lần
  trước rồi mới xóa file claim trong `C:\temp\home-cp\claims\` để chạy lại.
- `sys.exec` **chặn mọi lệnh có tham chiếu path** tới `C:\scoring-service`
  hoặc `C:\temp\sunolisten` (kể cả đọc) và `sys.tasks` cấm `disable` task
  `UnifiedLaneWatch`. Đây vẫn là guardrail cho operator tin cậy, không phải
  sandbox: lệnh PowerShell động không thể chặn triệt để bằng quét chuỗi.
- Denylist của `sys.exec` là **guardrail chống nhầm lẫn, không phải security
  boundary**: caller (Codex HOME / Leona) là operator tin cậy. Đừng dùng
  home-cp để chạy input không tin cậy.
- TUYỆT ĐỐI không dùng home-cp để sửa `C:\scoring-service` hay
  `C:\temp\sunolisten` (đã bị write-block ở tầng code) và không restart tiến
  trình lạ đang chạy trên HOME.

## Smoke test (đã chạy thật 2026-10-12 sau deploy)

```powershell
cd C:\temp\home-cp
'{"action":"sys.exec","params":{"command":"$env:COMPUTERNAME"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
# ^ phải trả DESKTOP-0L1K3A7
'{"action":"sys.processes","params":{"name":"node"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
'{"action":"sys.files","params":{"op":"write","path":"C:\\temp\\home-cp\\smoke-test.txt","content":"home-cp v1 smoke OK"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
'{"action":"sys.files","params":{"op":"read","path":"C:\\temp\\home-cp\\smoke-test.txt"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
'{"action":"sys.exec","params":{"command":"format C:"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
# ^ phải trả ok:false SYS_EXEC_BLOCKED
```

## Lịch sử Codex review (2026-10-12)

Codex HOME review gói tại chỗ qua nhiều vòng — vòng 1: 13 findings;
vòng 2: 4 fixed / 9 partial + 7 defect mới (N1–N7); vòng 3: 7 fixed /
9 still-open + N8 (P1) / N9. Các fix chính đã áp: `sys.exec` quét path
bảo vệ + khớp đoạn tên vùng live + chặn kill process của stack đang sống
(F1); policy file áp trên **cả path gốc lẫn final path** (resolve đi bộ
lên ancestor, fail-closed với lỗi lạ) — chặn junction/symlink/hardlink ở
mức kiểm tra được, cú pháp ADS `::$DATA`, tên ngắn 8.3 (F2/F3/F4/N5);
vá các kiểu lách denylist (F5); screenshot page-less, ghi thẳng final
path + verify output (F6/N6); ghi file qua **staging + rename sau
validate** (N8); idempotency **claim-trước-recheck-sau** + owner token +
không tự takeover + digest canonical (kể cả `__proto__`, N9) + claims
neo theo receipt store đã resolve + artifact validate final path
(F7/F8/F11/N1–N4); không cache `exitCode != 0`, thêm opt-in
`fail_on_nonzero` cho `sys.exec` (F9); bootstrap queue (F10); timeout
giết cây process có hard deadline 15s (F12/N7); đọc file theo
`bytesRead` thật (F13).

**Giới hạn còn lại (nói thẳng, không claim quá):** (1) denylist/policy là
*guardrail cho operator tin cậy*, không phải sandbox — lệnh PowerShell
động (biến, ghép chuỗi, kill theo PID) không quét triệt để được.
(2) Timeout dùng `taskkill /T` theo PID + deadline cứng, **không có Job
Object containment** (cần native module) — tiến trình con tách rời hoàn
toàn (reparent) vẫn có thể sống sót. (3) Ghi file đã qua staging+rename
nên không truncate oan, nhưng vẫn còn cửa sổ race rất hẹp giữa lần
validate cuối và rename — caveat này áp cho cả read/screenshot checks và
trường hợp ancestor bị thay giữa chừng. (5) Task Scheduler: `sys.exec` và
`sys.tasks` dùng chung inventory bảo vệ — tên task chứa
`unified|scoring|musicintake|sunolisten` thì không disable được qua
home-cp. (4) `sys.exec` mặc định giữ contract CP chung:
`exitCode != 0` vẫn trả `ok:true` kèm exitCode trong data (giống msi-cp)
— muốn chặt thì dùng `fail_on_nonzero`.

## Ghi chú vòng cài đặt này (2026-10-12)

- **Không cài watchdog/task thường trực nào** trên HOME ở vòng này (khác
  msi-cp có MSI-ChromeWatchdog): `watch/watchdog.mjs` chỉ là stub giữ contract
  `runCli({watchdogUrl})` với gate `none`, không bao giờ được gọi trong luồng
  chuẩn.
- Nguồn gói: `~/workspace/home-control-plane/` trên máy Muse; deploy bằng
  `deploy.sh` trong thư mục đó (node --check → tar.gz → base64 qua SSH →
  giải nén → verify). `deploy.sh` **dừng ngay nếu `C:\temp\home-cp` đã tồn
  tại** — không ghi đè mù.
