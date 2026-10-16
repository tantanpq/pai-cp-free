# chrome-watchdog.ps1 — MSI Chrome :9336 watchdog (Tân duyệt 2026-10-11).
# Chạy bởi Task Scheduler 'MSI-ChromeWatchdog' mỗi 5 phút (SYSTEM, hidden).
# Việc: probe CDP :9336 → chết thì restart task MSI-SocialChrome → chờ tối đa 90s → log kết quả.
# Chống restart loop: tối đa 3 lần restart trong 30 phút (ghi attempt TRƯỚC khi restart).
# (Codex review 2026-10-11: 5 findings đã sửa — xem cuối file.)

$Port = 9336
$SocialTask = 'MSI-SocialChrome'
$LogDir = 'C:\temp\msi-cp'
$LogFile = 'C:\temp\msi-cp\watchdog.log'
$StateFile = 'C:\temp\msi-cp\watchdog-state.json'
$MaxRestartsPer30Min = 3
$WaitSeconds = 90

# Đảm bảo thư mục log tồn tại ngay từ đầu (finding #4: lỗi sớm không bị mất log).
try { if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null } } catch { }

function WLog($msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  try { Add-Content -Path $LogFile -Value $line -ErrorAction Stop }
  catch { Write-Error $line }  # log file chết thì còn stderr (Task Scheduler history thấy được)
}

function Test-Cdp {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -ne 200) { return $false }
    # Validate đúng CDP thật, không phải proxy/process lạ chiếm port (finding #5).
    # Parse URI chuẩn thay vì regex mù (re-review finding: chuỗi giả chứa IP vẫn lọt).
    $j = $r.Content | ConvertFrom-Json
    if ($null -eq $j.webSocketDebuggerUrl) { return $false }
    $u = [uri]$j.webSocketDebuggerUrl
    return (($u.Host -eq '127.0.0.1' -or $u.Host -eq 'localhost') -and $u.Port -eq $Port)
  } catch { return $false }
}

# Chống 2 instance watchdog chạy chồng nhau: named mutex (finding #3).
$mutex = $null
try {
  $mutex = New-Object System.Threading.Mutex($false, 'Global\MSI-ChromeWatchdog')
  if (-not $mutex.WaitOne(0)) { exit 0 }  # instance khác đang chạy → im lặng thoát
} catch { }

function Get-RestartTimes {
  try {
    $raw = Get-Content -Path $StateFile -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    $arr = @($raw | ConvertFrom-Json)
    $cutoff = (Get-Date).AddMinutes(-30)
    return @($arr | Where-Object { $_ -is [string] -and [datetime]$_ -gt $cutoff })
  } catch { return @() }
}

function Save-RestartTimes($times) {
  # Ghi atomic: temp file rồi replace (finding #3).
  # Trả $true/$false — caller KHÔNG restart mù nếu ghi attempt thất bại (re-review finding).
  try {
    $tmp = "$StateFile.tmp"
    ($times | ConvertTo-Json -Compress) | Set-Content -Path $tmp -Force
    Move-Item -Path $tmp -Destination $StateFile -Force
    return $true
  } catch { return $false }
}

try {
  # CDP sống → im lặng, không log (tránh rác log mỗi 5 phút)
  if (Test-Cdp) { exit 0 }

  WLog "CDP :$Port không phản hồi — chuẩn bị restart $SocialTask"

  $recent = Get-RestartTimes
  if ($recent.Count -ge $MaxRestartsPer30Min) {
    WLog "RESTART_LOOP_GUARD: đã restart $($recent.Count) lần trong 30 phút — DỪNG, cần can thiệp tay"
    exit 1
  }

  # Ghi attempt TRƯỚC khi restart (finding #2: fail cũng tính vào guard).
  # Nếu ghi attempt thất bại → DỪNG, không restart mù (re-review finding).
  $now = (Get-Date).ToString('o')
  if (-not (Save-RestartTimes (@($recent) + @($now)))) {
    WLog 'RESTART_ABORTED: không ghi được attempt vào state file — dừng để tránh restart loop mù'
    exit 1
  }

  # schtasks.exe không throw exception khi exit non-zero → check $LASTEXITCODE (finding #1)
  $out = schtasks /run /tn $SocialTask 2>&1
  if ($LASTEXITCODE -ne 0) {
    WLog "RESTART_FAILED: không trigger được ${SocialTask} (exit=$LASTEXITCODE): $($out -join ' ' | ForEach-Object { $_.ToString().Substring(0, [Math]::Min(200, $_.ToString().Length)) })"
    exit 1
  }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (Test-Cdp) {
      WLog 'RESTART_OK: CDP :9336 đã sống lại'
      exit 0
    }
  }

  WLog "RESTART_FAILED: CDP :$Port vẫn chết sau ${WaitSeconds}s — cần can thiệp tay"
  exit 1
} finally {
  try { if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() } } catch { }
}

# --- Lịch sử Codex review (2026-10-11, sửa hết 7/7) ---
# 1. [MEDIUM] schtasks không throw → check $LASTEXITCODE ngay sau khi chạy.
# 2. [MEDIUM] loop guard chỉ đếm restart thành công → ghi attempt TRƯỚC khi restart.
# 3. [MEDIUM] state file read-modify-write không lock → named mutex + ghi atomic (tmp+replace).
# 4. [LOW] thư mục log chỉ tạo ở nhánh thành công → tạo ngay từ đầu, log fail thì ra stderr.
# 5. [LOW] /json/version 200 mù → parse URI chuẩn, check Host+Port.
# 6. [MEDIUM re-review] Save-RestartTimes nuốt lỗi → trả $true/$false, fail thì abort không restart mù.
# 7. [LOW re-review] regex webSocketDebuggerUrl không neo → dùng [uri] parse Host/Port.
