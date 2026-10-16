#!/usr/bin/env bash
#
# deploy.sh — Đóng gói GitHub Control Plane và deploy lên MSI.
# Chạy TRÊN MÁY MUSE (bash). KHÔNG chạy trong làn viết docs này — chỉ viết script.
#
# Luồng: tar.gz 6 file → base64 → SSH sang MSI (user@<CP_MSI_HOST>) →
#        PowerShell WriteAllBytes → tar -xzf vào C:\temp\github-cp\
# TUYỆT ĐỐI không đụng C:\temp\suno-cp\, C:\temp\chatgpt-cp\, C:\temp\chatgpt\, C:\temp\social\.
#
# Yêu cầu: ssh, tar, base64, node (để node --check trước khi đóng gói).
# Fallback thủ công nếu script lỗi: xem mục "FALLBACK THỦ CÔNG" cuối file
# (và README.md §Fallback).
#
set -euo pipefail

# ---------------- cấu hình ----------------
SRC="$HOME/workspace/github-control-plane"
TMP_TAR="/tmp/github-cp.tar.gz"
MSI_USER="${CP_MSI_USER:?CP_MSI_USER not set - see package README}"
MSI_HOST="${CP_MSI_HOST:?CP_MSI_HOST not set - see package README}"
MSI_DIR='C:\temp\github-cp'
SSH_OPTS=(
  -o ProxyCommand="nc -X connect -x hatch-egress-proxy:3130 %h %p"
  -o ConnectTimeout=20
  -o UserKnownHostsFile=/home/hatch/.ssh/known_hosts
  -i "$HOME/.ssh/id_ed25519"
)
FILES=(
  config.mjs
  proto/run-action.mjs
  watch/watchdog.mjs
  actions-github/registry.mjs
)

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] LỖI: %s\n' "$*" >&2; exit 1; }

# ---------------- 1. kiểm tra 6 file ----------------
log "Kiểm tra file nguồn trong $SRC"
for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || die "thiếu file: $f (lane code chưa giao? DỪNG, không deploy thiếu)"
done

command -v node >/dev/null 2>&1 || die "không có node trên máy Muse — cần node --check trước khi đóng gói"
log "node --check từng file..."
for f in "${FILES[@]}"; do
  node --check "$SRC/$f" || die "node --check FAIL: $f"
done
log "syntax OK (4/4)"

# ---------------- 2. đóng gói ----------------
log "Đóng gói tar.gz..."
rm -f "$TMP_TAR"
tar -czf "$TMP_TAR" -C "$SRC" "${FILES[@]}"
tar -tzf "$TMP_TAR"
SZ=$(stat -c%s "$TMP_TAR")
log "tar.gz xong: $TMP_TAR ($SZ bytes)"

# ---------------- 3. tạo thư mục trên MSI ----------------
ssh_ps() { # $1 = câu lệnh PowerShell (một dòng). -n: không đọc stdin (stdin dành cho bước base64).
  ssh -n "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
    "powershell -NoProfile -NonInteractive -Command \"$1\""
}
log "Tạo thư mục $MSI_DIR trên MSI..."
ssh_ps "New-Item -ItemType Directory -Force '$MSI_DIR' | Out-Null; 'DIR_OK'"

# B1: site import từ browser-control-plane-core — core phải có trên MSI trước.
log "Preflight: kiểm tra browser-control-plane-core trên MSI..."
CORE_OK=$(ssh "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
  "powershell -NoProfile -NonInteractive -Command \"if (Test-Path 'C:\\temp\\browser-control-plane-core\\site.mjs') { 'CORE_OK' } else { 'CORE_MISSING' }\"" < /dev/null | tr -d "\r")
if [[ "$CORE_OK" != *CORE_OK* ]]; then
  die "thiếu C:\\temp\\browser-control-plane-core trên MSI — chạy browser-control-plane-core/deploy-core.sh TRƯỚC rồi deploy site lại"
fi
log "core OK"


# ---------------- 4. chuyển file qua base64 ----------------
# base64 đi qua COMMAND ARGUMENT (không qua stdin SSH):
# [Console]::In.ReadToEnd() trên stdin SSH không ổn định trong môi trường này
# (treo/empty file) — bài học từ probe 2026-10-11.
log "Chuyển tar.gz sang MSI qua base64 (chia chunk qua command argument)..."
log "Lý do: stdin SSH treo; 1 argument >8191 ký tự bị cmd.exe từ chối — chia chunk 6000."
B64_TAR=$(base64 -w0 "$TMP_TAR")
CHUNK=6000
CP_B64='C:/temp/github-cp/github-cp.tar.gz.b64'
ssh -n "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
  "powershell -NoProfile -NonInteractive -Command \"Remove-Item '$CP_B64' -Force -ErrorAction SilentlyContinue; 'CLEAN_OK'\"" < /dev/null
i=0
len=${#B64_TAR}
while [ $i -lt $len ]; do
  part="${B64_TAR:$i:$CHUNK}"
  ssh -n "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
    "powershell -NoProfile -NonInteractive -Command \"[IO.File]::AppendAllText('$CP_B64','$part'); 'PART_OK'\"" < /dev/null
  i=$((i + CHUNK))
done
ssh -n "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
  "powershell -NoProfile -NonInteractive -Command \"[IO.File]::WriteAllBytes('C:/temp/github-cp/github-cp.tar.gz',[Convert]::FromBase64String([IO.File]::ReadAllText('$CP_B64'))); Remove-Item '$CP_B64' -Force; 'DECODE_OK'\"" < /dev/null
log "upload xong"

# ---------------- 5. giải nén + verify trên MSI ----------------
log "Giải nén vào $MSI_DIR..."
ssh_ps "tar -xzf '$MSI_DIR\\github-cp.tar.gz' -C '$MSI_DIR'; Remove-Item '$MSI_DIR\\github-cp.tar.gz' -Force; 'EXTRACT_OK'"

log "Verify 6 file trên MSI (tồn tại + node --check)..."
VERIFY_PS="\$ok=\$true; foreach (\$f in @('config.mjs','proto/run-action.mjs','watch/watchdog.mjs','actions-github/registry.mjs')) { \$p=Join-Path '$MSI_DIR' \$f; if (-not (Test-Path \$p)) { Write-Host \"MISSING: \$f\"; \$ok=\$false } }; if (\$ok) { 'FILES_OK' } else { exit 1 }"
ssh_ps "$VERIFY_PS"

NODECHECK_PS="foreach (\$f in @('config.mjs','proto/run-action.mjs','watch/watchdog.mjs','actions-github/registry.mjs')) { node --check (Join-Path '$MSI_DIR' \$f) }; 'NODECHECK_OK'"
ssh_ps "$NODECHECK_PS"

log "Liệt kê thư mục đích:"
ssh_ps "Get-ChildItem -Recurse '$MSI_DIR' | Select-Object FullName, Length | Format-Table -AutoSize"

log "DEPLOY XONG → $MSI_DIR (C:\\temp\\suno-cp\\, C:\\temp\\chatgpt-cp\\, C:\\temp\\chatgpt\\, C:\\temp\\social\\ không bị đụng)"
log "Bước tiếp: dry-run theo README.md §6 (prerequisite: Tân login github.com 1 lần trên Chrome MSI port 9336)"

# ============================================================================
# FALLBACK THỦ CÔNG (khi script lỗi — chạy từng bước tay)
# ============================================================================
# 1) Trên máy Muse, đóng gói:
#      cd ~/workspace/github-control-plane
#      tar -czf /tmp/github-cp.tar.gz config.mjs proto/run-action.mjs \
#        primitives/primitives.mjs watch/evidence.mjs watch/watchdog.mjs \
#        actions-github/registry.mjs
# 2) Tạo base64:
#      base64 /tmp/github-cp.tar.gz > /tmp/github-cp.b64
# 3) SSH sang MSI (template từ ~/TOOLS.md):
#      ssh -o ProxyCommand="nc -X connect -x hatch-egress-proxy:3130 %h %p" \
#          -o ConnectTimeout=20 -o UserKnownHostsFile=/home/hatch/.ssh/known_hosts \
#          -i ~/.ssh/id_ed25519 user@<CP_MSI_HOST>
# 4) Trên PowerShell của MSI, tạo thư mục:
#      New-Item -ItemType Directory -Force 'C:\temp\github-cp'
# 5) Chia base64 thành từng đoạn ~50KB (nếu file lớn), mỗi đoạn chạy:
#      [IO.File]::WriteAllBytes('C:\temp\github-cp\part.b64', [Text.Encoding]::ASCII.GetBytes('<đoạn base64>'))
#    rồi nối lại trên MSI — hoặc đơn giản: copy nội dung /tmp/github-cp.b64,
#    dán vào lệnh một lần:
#      [IO.File]::WriteAllBytes('C:\temp\github-cp\github-cp.tar.gz',
#        [Convert]::FromBase64String('<toàn bộ base64>'))
# 6) Giải nén:
#      tar -xzf C:\temp\github-cp\github-cp.tar.gz -C C:\temp\github-cp
#      Remove-Item C:\temp\github-cp\github-cp.tar.gz
# 7) Verify: dir C:\temp\github-cp + node --check từng file trong 6 file.
# 8) CẢNH BÁO: không bao giờ giải nén vào C:\temp\suno-cp\, C:\temp\chatgpt-cp\,
#    C:\temp\chatgpt\ hay C:\temp\social\.
