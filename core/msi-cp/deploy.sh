#!/usr/bin/env bash
#
# deploy.sh — Đóng gói MSI Control Plane và deploy lên MSI.
# Chạy TRÊN MÁY MUSE (bash).
#
# Luồng: node --check → tar.gz 4 file → base64 → SSH sang MSI (user@<CP_MSI_HOST>) →
#        PowerShell WriteAllBytes → tar -xzf vào C:\temp\msi-cp\
# TUYỆT ĐỐI không đụng C:\temp\chatgpt\ (worker) và 4 thư mục *-cp đang chạy.
#
set -euo pipefail

# ---------------- cấu hình ----------------
SRC="$HOME/workspace/msi-control-plane"
TMP_TAR="/tmp/msi-cp.tar.gz"
MSI_USER="${CP_MSI_USER:?CP_MSI_USER not set - see package README}"
MSI_HOST="${CP_MSI_HOST:?CP_MSI_HOST not set - see package README}"
MSI_DIR='C:\temp\msi-cp'
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
  watch/chrome-watchdog.ps1
  actions-msi/registry.mjs
)

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] LỖI: %s\n' "$*" >&2; exit 1; }

# ---------------- 1. kiểm tra file ----------------
log "Kiểm tra file nguồn trong $SRC"
for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || die "thiếu file: $f (DỪNG, không deploy thiếu)"
done

command -v node >/dev/null 2>&1 || die "không có node trên máy Muse — cần node --check trước khi đóng gói"
log "node --check từng file .mjs (bỏ qua .ps1)..."
for f in "${FILES[@]}"; do
  [[ "$f" == *.mjs ]] || continue
  node --check "$SRC/$f" || die "node --check FAIL: $f"
done
log "syntax OK (${#FILES[@]}/${#FILES[@]})"

# ---------------- 2. đóng gói ----------------
log "Đóng gói tar.gz..."
rm -f "$TMP_TAR"
tar -czf "$TMP_TAR" -C "$SRC" "${FILES[@]}"
tar -tzf "$TMP_TAR"
SZ=$(stat -c%s "$TMP_TAR")
log "tar.gz xong: $TMP_TAR ($SZ bytes)"

# ---------------- 3. preflight MSI ----------------
ssh_ps() { # $1 = câu lệnh PowerShell (một dòng)
  ssh "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
    "powershell -NoProfile -NonInteractive -Command \"$1\"" < /dev/null
}
log "Tạo thư mục $MSI_DIR trên MSI..."
ssh_ps "New-Item -ItemType Directory -Force '$MSI_DIR' | Out-Null; 'DIR_OK'"

log "Preflight: kiểm tra browser-control-plane-core trên MSI..."
CORE_OK=$(ssh "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
  "powershell -NoProfile -NonInteractive -Command \"if (Test-Path 'C:\\\\temp\\\\browser-control-plane-core\\\\site.mjs') { 'CORE_OK' } else { 'CORE_MISSING' }\"" < /dev/null | tr -d "\r")
if [[ "$CORE_OK" != *CORE_OK* ]]; then
  die "thiếu C:\\\\temp\\\\browser-control-plane-core trên MSI — chạy browser-control-plane-core/deploy-core.sh TRƯỚC"
fi
log "core OK"

# Snapshot nếu thư mục đã có file (không ghi đè mù)
HAS_FILES=$(ssh "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
  "powershell -NoProfile -NonInteractive -Command \"if ((Get-ChildItem '$MSI_DIR' -Force | Measure-Object).Count -gt 0) { 'HAS_FILES' } else { 'EMPTY' }\"" < /dev/null | tr -d "\r")
if [[ "$HAS_FILES" == *HAS_FILES* ]]; then
  SNAP="C:/temp/msi-cp-snapshot-$(date +%Y%m%d-%H%M%S).zip"
  log "Thư mục đã có file → snapshot trước: $SNAP"
  ssh_ps "Compress-Archive -Path '$MSI_DIR\\\\*' -DestinationPath '$SNAP' -Force; 'SNAP_OK'"
else
  log "Thư mục trống/mới — không cần snapshot"
fi

# ---------------- 4. chuyển file qua base64 (chunk 6000 qua command argument) ----------------
log "Chuyển tar.gz sang MSI qua base64..."
B64_TAR=$(base64 -w0 "$TMP_TAR")
CHUNK=6000
CP_B64='C:/temp/msi-cp/msi-cp.tar.gz.b64'
ssh "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
  "powershell -NoProfile -NonInteractive -Command \"Remove-Item '$CP_B64' -Force -ErrorAction SilentlyContinue; 'CLEAN_OK'\"" < /dev/null
i=0
len=${#B64_TAR}
while [ $i -lt $len ]; do
  part="${B64_TAR:$i:$CHUNK}"
  ssh "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
    "powershell -NoProfile -NonInteractive -Command \"[IO.File]::AppendAllText('$CP_B64','$part'); 'PART_OK'\"" < /dev/null
  i=$((i + CHUNK))
done
ssh "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
  "powershell -NoProfile -NonInteractive -Command \"[IO.File]::WriteAllBytes('C:/temp/msi-cp/msi-cp.tar.gz',[Convert]::FromBase64String([IO.File]::ReadAllText('$CP_B64'))); Remove-Item '$CP_B64' -Force; 'DECODE_OK'\"" < /dev/null
log "upload xong"

# ---------------- 5. giải nén + verify ----------------
log "Giải nén vào $MSI_DIR..."
ssh_ps "tar -xzf '$MSI_DIR\\\\msi-cp.tar.gz' -C '$MSI_DIR'; Remove-Item '$MSI_DIR\\\\msi-cp.tar.gz' -Force; 'EXTRACT_OK'"

log "Verify file trên MSI (tồn tại + node --check)..."
VERIFY_PS="\$ok=\$true; foreach (\$f in @('config.mjs','proto/run-action.mjs','watch/watchdog.mjs','watch/chrome-watchdog.ps1','actions-msi/registry.mjs')) { \$p=Join-Path '$MSI_DIR' \$f; if (-not (Test-Path \$p)) { Write-Host \"MISSING: \$f\"; \$ok=\$false } }; if (\$ok) { 'FILES_OK' } else { exit 1 }"
ssh_ps "$VERIFY_PS"

NODECHECK_PS="foreach (\$f in @('config.mjs','proto/run-action.mjs','watch/watchdog.mjs','actions-msi/registry.mjs')) { node --check (Join-Path '$MSI_DIR' \$f) }; 'NODECHECK_OK'"
ssh_ps "$NODECHECK_PS"

log "DEPLOY XONG → $MSI_DIR"
log "Bước tiếp: smoke test từng action theo README.md § Smoke test"
