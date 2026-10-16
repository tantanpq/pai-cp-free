#!/usr/bin/env bash
#
# deploy-core.sh — Deploy browser-control-plane-core lên MSI.
# Chạy TRÊN MÁY MUSE (bash). Deploy core TRƯỚC khi deploy bất kỳ site CP nào
# (site deploy.sh có preflight check và sẽ DỪNG nếu thiếu core trên MSI).
#
# Đích: C:\temp\browser-control-plane-core\  (dùng chung cho 5 site)
# KHÔNG public, không commit đi đâu — chỉ copy nội bộ sang máy MSI của Tân.
#
set -euo pipefail

SRC="$HOME/workspace/browser-control-plane-core"
TMP_TAR="/tmp/browser-control-plane-core.tar.gz"
MSI_USER="${CP_MSI_USER:?CP_MSI_USER not set - see package README}"
MSI_HOST="${CP_MSI_HOST:?CP_MSI_HOST not set - see package README}"
MSI_DIR='C:\temp\browser-control-plane-core'
SSH_OPTS=(
  -o ProxyCommand="nc -X connect -x hatch-egress-proxy:3130 %h %p"
  -o ConnectTimeout=20
  -o UserKnownHostsFile=/home/hatch/.ssh/known_hosts
  -i "$HOME/.ssh/id_ed25519"
)
FILES=(
  site.mjs
  primitives/primitives.mjs
  proto/runner.mjs
  watch/evidence.mjs
  README.md
)

log() { printf '[deploy-core] %s\n' "$*"; }
die() { printf '[deploy-core] LỖI: %s\n' "$*" >&2; exit 1; }

log "Kiểm tra file nguồn trong $SRC"
for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || die "thiếu file: $f (DỪNG, không deploy thiếu)"
done

command -v node >/dev/null 2>&1 || die "cần node --check trước khi đóng gói"
log "node --check từng file .mjs..."
for f in "${FILES[@]}"; do
  [[ "$f" == *.mjs ]] || continue
  node --check "$SRC/$f" || die "node --check FAIL: $f"
done
log "syntax OK"

log "Đóng gói tar.gz..."
rm -f "$TMP_TAR"
tar -czf "$TMP_TAR" -C "$SRC" "${FILES[@]}"
tar -tzf "$TMP_TAR"
log "tar.gz xong: $TMP_TAR ($(stat -c%s "$TMP_TAR") bytes)"

ssh_ps() {
  ssh "${SSH_OPTS[@]}" "$MSI_USER@$MSI_HOST" \
    "powershell -NoProfile -NonInteractive -Command \"$1\"" < /dev/null
}

log "Tạo thư mục $MSI_DIR trên MSI..."
ssh_ps "New-Item -ItemType Directory -Force '$MSI_DIR' | Out-Null; 'DIR_OK'"

log "Chuyển tar.gz sang MSI qua base64 (chunk 6000 qua command argument)..."
B64_TAR=$(base64 -w0 "$TMP_TAR")
CHUNK=6000
CP_B64='C:/temp/browser-control-plane-core/core.tar.gz.b64'
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
  "powershell -NoProfile -NonInteractive -Command \"[IO.File]::WriteAllBytes('C:/temp/browser-control-plane-core/core.tar.gz',[Convert]::FromBase64String([IO.File]::ReadAllText('$CP_B64'))); Remove-Item '$CP_B64' -Force; 'DECODE_OK'\"" < /dev/null
log "upload xong"

log "Giải nén vào $MSI_DIR..."
ssh_ps "tar -xzf '$MSI_DIR\\\\core.tar.gz' -C '$MSI_DIR'; Remove-Item '$MSI_DIR\\\\core.tar.gz' -Force; 'EXTRACT_OK'"

log "Verify trên MSI (tồn tại + node --check)..."
VERIFY_PS="\$ok=\$true; foreach (\$f in @('site.mjs','primitives/primitives.mjs','proto/runner.mjs','watch/evidence.mjs')) { \$p=Join-Path '$MSI_DIR' \$f; if (-not (Test-Path \$p)) { Write-Host \"MISSING: \$f\"; \$ok=\$false } }; if (\$ok) { 'FILES_OK' } else { exit 1 }"
ssh_ps "$VERIFY_PS"
NODECHECK_PS="foreach (\$f in @('site.mjs','primitives/primitives.mjs','proto/runner.mjs','watch/evidence.mjs')) { node --check (Join-Path '$MSI_DIR' \$f) }; 'NODECHECK_OK'"
ssh_ps "$NODECHECK_PS"

log "DEPLOY CORE XONG → $MSI_DIR"
log "Bước tiếp: deploy từng site (site deploy.sh đã có preflight check core)."
