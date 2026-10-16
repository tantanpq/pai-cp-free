# MSI Control Plane v1

Control plane điều khiển PC MSI (`<CP_MSI_USER>@<CP_MSI_HOST>`) — Tân duyệt 2026-10-11
("nhà em rồi, tự xoay được"). Gom các thao tác SSH ad-hoc thành 1 interface
chuẩn CP (giống chatgpt/github/grok/rea-cp): JSON vào stdin → 1 dòng JSON ra stdout.

Deploy dir trên MSI: `C:\temp\msi-cp\`

## Actions v1

| Action | Params | Mô tả |
|---|---|---|
| `sys.exec` | `{command, timeout_ms?}` | Chạy lệnh PowerShell/cmd local. Block lệnh destructive (format, diskpart, shutdown, restart, bcdedit, reg HKLM, xóa C:\Windows/drive root...). Timeout 1s–300s (mặc định 30s). |
| `sys.processes` | `{name?}` | Liệt kê process (Name, Id, CPU, MemMB). Lọc theo tên nếu có. |
| `sys.tasks` | `{op, name?}` | Task Scheduler: `list` \| `run` \| `enable` \| `disable`. `name` bắt buộc trừ `list`. |
| `sys.screenshot` | `{port?, path?}` | Chụp màn hình Chrome qua agent-browser CLI (`--cdp http://127.0.0.1:<port>`). Mặc định port 9336, lưu `C:\temp\msi-cp\screenshots\msi-<ts>.png`. |
| `sys.files` | `{op, path, content?}` | `read`/`write` file text. Giới hạn 5MB. Ghi bị chặn: `C:\Windows*`, `C:\Program Files*`, `*authorized_keys`, `C:\temp\chatgpt\`. |

## Chạy 1 action (pattern chuẩn — pipe qua stdin, KHÔNG qua argv)

```powershell
'{"action":"sys.exec","params":{"command":"hostname"}}' | Out-File -Encoding utf8 C:\temp\smoke.json
cd C:\temp\msi-cp
Get-Content C:\temp\smoke.json -Raw | node proto/run-action.mjs
```

## Smoke test (sau deploy — chạy THẬT từng action)

```powershell
cd C:\temp\msi-cp
'{"action":"sys.exec","params":{"command":"$env:COMPUTERNAME"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
'{"action":"sys.processes","params":{"name":"chrome"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
'{"action":"sys.tasks","params":{"op":"list"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
'{"action":"sys.screenshot","params":{}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
'{"action":"sys.files","params":{"op":"write","path":"C:\\temp\\msi-cp\\smoke-test.txt","content":"msi-cp v1 smoke OK"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
'{"action":"sys.files","params":{"op":"read","path":"C:\\temp\\msi-cp\\smoke-test.txt"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
'{"action":"sys.exec","params":{"command":"format C:"}}' | Out-File C:\temp\s.json; Get-Content C:\temp\s.json -Raw | node proto/run-action.mjs
# ^ phải trả ok:false SYS_EXEC_BLOCKED
```

## Đường backup khi CDP chết (v1.1, 2026-10-11)

- Runner core hỗ trợ **lazy CDP**: registry nào export `cdpNotRequired` (Set/Array tên
  action) thì các action đó thử nối CDP, fail thì log + chạy tiếp với `page=null`.
  msi-cp export `cdpNotRequired = ['sys.exec','sys.processes','sys.tasks','sys.files']`
  → Chrome 9336 sập thì 4 action này **vẫn chạy** (đã test thật: kill Chrome,
  `sys.exec` trả `ok:true`).
- Chỉ `sys.screenshot` bắt buộc CDP → fail với lỗi rõ `CDP_UNREACHABLE at
  http://127.0.0.1:9336 — cần browser sống: ...` (không còn lỗi playwright thô).
- Registry không export `cdpNotRequired` giữ nguyên hành vi cũ (4 CP còn lại không ảnh hưởng).

## Watchdog Chrome :9336 (2026-10-11)

- Task Scheduler **`MSI-ChromeWatchdog`** trên MSI: chạy `watch/chrome-watchdog.ps1`
  (SYSTEM, hidden) **mỗi 5 phút**. Không dùng cron phía Muse — Task Scheduler sống
  cả khi VM Muse down, local với thứ nó canh.
- Logic: probe `http://127.0.0.1:9336/json/version` (validate `webSocketDebuggerUrl`
  đúng host:port) → chết thì `schtasks /run /tn MSI-SocialChrome` → chờ tối đa 90s →
  log `C:\temp\msi-cp\watchdog.log`. Chống restart loop: tối đa 3 attempt/30 phút
  (ghi attempt TRƯỚC khi restart; ghi state fail thì abort).
- Đã test thật end-to-end 2026-10-11: kill Chrome → watchdog phát hiện → Chrome sống
  lại sau ~5s, log `RESTART_OK`, `sys.screenshot` chạy lại bình thường.
- Lưu ý deploy: file `.ps1` phải có **UTF-8 BOM** (PowerShell 5.1 không BOM đọc sai
  UTF-8 → parse error); task phải có `-ExecutionPolicy Bypass` (policy mặc định
  Restricted chặn script).

## Caveat đã biết (v1.1)

- `sys.screenshot` chụp tab ĐANG ACTIVE trên Chrome port đó — không chọn tab.
- Không mở port ra ngoài tailnet: mọi thứ chạy local trên MSI, điều khiển qua SSH như cũ.
