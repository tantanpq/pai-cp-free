#!/usr/bin/env bash
#
# deploy.sh — Đóng gói HOME Control Plane và deploy lên HOME (DESKTOP-0L1K3A7).
# Chạy TRÊN MÁY MUSE (bash). Mẫu: msi-control-plane/deploy.sh.
#
# Luồng: node --check → tar.gz → base64 → SSH sang HOME (user@<CP_HOME_HOST>) →
#        PowerShell WriteAllBytes → tar -xzf vào C:\temp\home-cp\
# RÀO: DỪNG NGAY nếu C:\temp\home-cp đã tồn tại (không ghi đè mù).
# TUYỆT ĐỐI không đụng C:\scoring-service, C:\temp\sunolisten, Ollama.
#
set -euo pipefail

# ---------------- cấu hình ----------------
SRC="$HOME/workspace/home-control-plane"
TMP_TAR="/tmp/home-cp.tar.gz"
HOME_USER="${CP_HOME_USER:?CP_HOME_USER not set - see package README}"
HOME_HOST="${CP_HOME_HOST:?CP_HOME_HOST not set - see package README}"
HOME_DIR='C:\temp\home-cp'
SSH_OPTS=(
  -o ProxyCommand="nc -X connect -x hatch-egress-proxy:3130 %h %p"
  -o ConnectTimeout=20
  -o UserKnownHostsFile=/home/hatch/.ssh/known_hosts
  -i "$HOME/.ssh/id_ed25519"
)
FILES=(
  config.mjs
  README.md
  proto/run-action.mjs
  actions-home/registry.mjs
  watch/watchdog.mjs
  core/site.mjs
  core/proto/runner.mjs
  core/watch/evidence.mjs
  core/primitives/primitives.mjs
)

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] LỖI: %s\n' "$*" >&2; exit 1; }

ssh_ps() { # $1 = câu lệnh PowerShell (một dòng)
  ssh -n "${SSH_OPTS[@]}" "$HOME_USER@$HOME_HOST" \
    "powershell -NoProfile -NonInteractive -Command \"$1\""
}

# ---------------- 1. kiểm tra file ----------------
log "Kiểm tra file nguồn trong $SRC"
for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || die "thiếu file: $f (DỪNG, không deploy thiếu)"
done

command -v node >/dev/null 2>&1 || die "không có node trên máy Muse — cần node --check trước khi đóng gói"
log "node --check từng file .mjs..."
for f in "${FILES[@]}"; do
  [[ "$f" == *.mjs ]] || continue
  node --check "$SRC/$f" || die "node --check FAIL: $f"
done
log "syntax OK (${#FILES[@]}/${#FILES[@]})"

# ---------------- 2. preflight HOME ----------------
log "Preflight HOME: thư mục đích + node..."
EXIST=$(ssh_ps "if (Test-Path '$HOME_DIR') { 'EXISTS' } else { 'ABSENT' }" | tr -d '\r')
[[ "$EXIST" == *ABSENT* ]] || die "C:\\temp\\home-cp ĐÃ TỒN TẠI trên HOME — DỪNG theo rào an toàn, báo trước khi đụng"
NODEV=$(ssh_ps "node --version" | tr -d '\r')
[[ "$NODEV" == v* ]] || die "không thấy node trên HOME (trả: $NODEV)"
log "đích chưa tồn tại; node trên HOME: $NODEV"

# ---------------- 3. đóng gói ----------------
log "Đóng gói tar.gz..."
rm -f "$TMP_TAR"
tar -czf "$TMP_TAR" -C "$SRC" "${FILES[@]}"
tar -tzf "$TMP_TAR"
SZ=$(stat -c%s "$TMP_TAR")
log "tar.gz xong: $TMP_TAR ($SZ bytes)"

# ---------------- 4. tạo thư mục + chuyển file qua base64 ----------------
log "Tạo thư mục $HOME_DIR trên HOME..."
ssh_ps "New-Item -ItemType Directory -Force '$HOME_DIR' | Out-Null; 'DIR_OK'"

log "Chuyển tar.gz sang HOME qua base64 (chunk 6000)..."
B64_TAR=$(base64 -w0 "$TMP_TAR")
CHUNK=6000
CP_B64='C:/temp/home-cp/home-cp.tar.gz.b64'
ssh_ps "Remove-Item '$CP_B64' -Force -ErrorAction SilentlyContinue; 'CLEAN_OK'"
i=0
len=${#B64_TAR}
while [ $i -lt $len ]; do
  part="${B64_TAR:$i:$CHUNK}"
  ssh -n "${SSH_OPTS[@]}" "$HOME_USER@$HOME_HOST" \
    "powershell -NoProfile -NonInteractive -Command \"[IO.File]::AppendAllText('$CP_B64','$part'); 'PART_OK'\""
  i=$((i + CHUNK))
done
ssh_ps "[IO.File]::WriteAllBytes('C:/temp/home-cp/home-cp.tar.gz',[Convert]::FromBase64String([IO.File]::ReadAllText('$CP_B64'))); Remove-Item '$CP_B64' -Force; 'DECODE_OK'"
log "upload xong"

# ---------------- 5. giải nén + verify ----------------
log "Giải nén vào $HOME_DIR..."
ssh_ps "tar -xzf '$HOME_DIR\\\\home-cp.tar.gz' -C '$HOME_DIR'; Remove-Item '$HOME_DIR\\\\home-cp.tar.gz' -Force; 'EXTRACT_OK'"

log "Verify file trên HOME (tồn tại + node --check)..."
VERIFY_PS="\$ok=\$true; foreach (\$f in @('config.mjs','README.md','proto/run-action.mjs','actions-home/registry.mjs','watch/watchdog.mjs','core/site.mjs','core/proto/runner.mjs','core/watch/evidence.mjs','core/primitives/primitives.mjs')) { \$p=Join-Path '$HOME_DIR' \$f; if (-not (Test-Path \$p)) { Write-Host \"MISSING: \$f\"; \$ok=\$false } }; if (\$ok) { 'FILES_OK' } else { exit 1 }"
ssh_ps "$VERIFY_PS"

NODECHECK_PS="foreach (\$f in @('config.mjs','proto/run-action.mjs','actions-home/registry.mjs','watch/watchdog.mjs','core/site.mjs','core/proto/runner.mjs','core/watch/evidence.mjs','core/primitives/primitives.mjs')) { node --check (Join-Path '$HOME_DIR' \$f) }; 'NODECHECK_OK'"
ssh_ps "$NODECHECK_PS"

log "DEPLOY XONG → $HOME_DIR"
log "Bước tiếp: smoke test từng action theo README.md § Smoke test"
