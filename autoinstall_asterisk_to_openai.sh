#!/bin/bash
# Asterisk ↔ OpenAI Realtime installer (FreePBX-only)
# FreePBX-safe: writes only *_custom.conf (never touches ari.conf/http.conf).
# Creates/keeps ARI user [openai_rt] in ari_additional_custom.conf (plain).
# Updates only selected keys in app's config.conf (from repo), without recreating it.
# Adds a 30 ms silence WAV in /var/lib/asterisk/sounds/custom and plays it
# in dialplan before Stasis() to prime RTP without a full 1-second gap.

set -Eeuo pipefail

# ========= Logging & traps =========
TS="$(date +%Y%m%d-%H%M%S)"
LOGFILE="/root/asterisk-openai-install-${TS}.log"
exec > >(tee -a "$LOGFILE") 2>&1
if [[ "${DEBUG:-0}" != "0" ]]; then set -x; fi
err() {
  local ec=$?
  echo
  echo "ERROR: command failed with exit code ${ec}"
  echo "  Line: ${BASH_LINENO[0]}  Cmd: ${BASH_COMMAND}"
  echo "Log: $LOGFILE"
  exit $ec
}
trap err ERR

# ========= Colors (ANSI) =========
ESC=$(printf '\033')
RED="${ESC}[0;31m"; GREEN="${ESC}[0;32m"; YELLOW="${ESC}[1;33m"; CYAN="${ESC}[0;36m"; BOLD="${ESC}[1m"; NC="${ESC}[0m"
OK="${GREEN}OK${NC}"; FAIL="${RED}FAIL${NC}"; WARN="${YELLOW}WARN${NC}"

# ========= Globals =========
HTTP_ADDR="127.0.0.1"
HTTP_PORT="8088"
ARI_URL="http://127.0.0.1:8088"

ARI_USERNAME="openai_rt"
ARI_PASSWORD=""             # will be read or generated

PASS_COUNT=0; FAIL_COUNT=0; WARN_COUNT=0

APP_DIR="/opt/asterisk_to_openai_rt_community"
SERVICE_FILE="/etc/systemd/system/asterisk-openai.service"
RUN_USER="asterisk"         # FreePBX default

SOUNDS_DIR="/var/lib/asterisk/sounds/custom"
SILENCE_WAV="${SOUNDS_DIR}/openai_silence_30ms.wav"

# ========= Helpers =========
log() { echo -e "$@"; }
inc_pass(){ PASS_COUNT=$((PASS_COUNT+1)); }
inc_fail(){ FAIL_COUNT=$((FAIL_COUNT+1)); }
inc_warn(){ WARN_COUNT=$((WARN_COUNT+1)); }

check_root() { [ "${EUID:-$(id -u)}" -eq 0 ] || { echo "Run as root (sudo)."; exit 1; }; }

require_freepbx() {
  if ! command -v fwconsole >/dev/null 2>&1; then
    echo "This installer is FreePBX-only. 'fwconsole' not found. Aborting."
    exit 1
  fi
}

ensure_pkg() { apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"; }

rand16() {
  local r
  r="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9')"
  printf '%s' "${r:0:16}"
}

safe_backup() { [ -f "$1" ] && cp -a "$1" "$1.bak.$(date +%s)" || true; }

# Replace or append KEY=VALUE in .env-like file without touching other lines
update_env_kv() {
  local file="$1" key="$2" val="$3" tmp
  touch "$file"
  tmp="$(mktemp "${file}.XXXX")"
  awk -v k="$key" -v v="$val" '
    BEGIN{done=0}
    $0 ~ ("^"k"=") && !done { print k"="v; done=1; next }
    { print }
    END{ if(!done) print k"="v }
  ' "$file" > "$tmp"
  mv -f "$tmp" "$file"
}

# Read ARI password from existing files (custom first)
get_existing_ari_pass() {
  local line f
  for f in /etc/asterisk/ari_additional_custom.conf /etc/asterisk/ari_additional.conf; do
    [ -f "$f" ] || continue
    # Extract "password = ..." from [openai_rt] block
    line="$(sed -n '/^\[openai_rt\]/,/^\[/{/^\[/b; /password[[:space:]]*=/p}' "$f" | head -n1)"
    if [ -n "$line" ]; then
      printf '%s\n' "${line#*=}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
      return 0
    fi
  done
  return 1
}
get_ari_password_format() {
  local line f
  for f in /etc/asterisk/ari_additional_custom.conf /etc/asterisk/ari_additional.conf; do
    [ -f "$f" ] || continue
    line="$(sed -n '/^\[openai_rt\]/,/^\[/{/^\[/b; /password_format[[:space:]]*=/p}' "$f" | head -n1)"
    if [ -n "$line" ]; then
      printf '%s\n' "${line#*=}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
      return 0
    fi
  done
  return 1
}

# ========= FreePBX-safe Asterisk configs =========
ensure_http_conf_freepbx() {
  local f="/etc/asterisk/http_custom.conf"
  safe_backup "$f"
  cat > "$f" <<EOF
[general]
enabled=yes
bindaddr=127.0.0.1
bindport=8088
enable_status=yes
EOF
}

ensure_ari_general_custom() {
  local f="/etc/asterisk/ari_general_custom.conf"
  touch "$f"
  if ! grep -q '^\[general\]' "$f" 2>/dev/null; then
    cat >> "$f" <<EOF
[general]
enabled = yes
pretty  = yes
EOF
  else
    grep -q '^[[:space:]]*enabled[[:space:]]*=' "$f" || echo "enabled = yes" >> "$f"
    grep -q '^[[:space:]]*pretty[[:space:]]*='  "$f" || echo "pretty  = yes" >> "$f"
  fi
}

ensure_ari_user_custom() {
  local f="/etc/asterisk/ari_additional_custom.conf"
  touch "$f"; safe_backup "$f"

  if [ -z "${ARI_PASSWORD}" ]; then
    if ARI_PASSWORD="$(get_existing_ari_pass)"; then :; else ARI_PASSWORD="$(rand16)"; fi
  fi

  # Remove any existing [openai_rt] block in custom file, then write fresh plain one
  awk -v RS= -v ORS= '
    {
      gsub(/\r/, "")
      n=split($0, a, /\n\[/); out=""
      for(i=1;i<=n;i++){
        s=a[i]; if (i>1) s="[" s
        if (match(s, /^\[openai_rt\][\s\S]*/)) s=""
        out=out s
      } print out
    }' "$f" > "${f}.tmp" || true
  mv -f "${f}.tmp" "$f"

  cat >>"$f" <<EOF

[openai_rt]
type=user
password=${ARI_PASSWORD}
read_only=no
password_format=plain
EOF
}

# Ensure /var/lib/asterisk/sounds/custom exists and generate a ~30ms silence WAV if missing
ensure_custom_silence_wav() {
  mkdir -p "${SOUNDS_DIR}"
  if [ ! -f "${SILENCE_WAV}" ]; then
    if command -v sox >/dev/null 2>&1; then
      # 8kHz, mono, ~0.03s digital silence
      sox -n -r 8000 -c 1 -b 16 "${SILENCE_WAV}" trim 0 0.03
    elif command -v ffmpeg >/dev/null 2>&1; then
      ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=8000:cl=mono -t 0.03 -acodec pcm_s16le "${SILENCE_WAV}"
    else
      echo "${FAIL} Neither 'sox' nor 'ffmpeg' is available to generate ${SILENCE_WAV}"
      return 1
    fi
    chown asterisk:asterisk "${SILENCE_WAV}" 2>/dev/null || true
    chmod 0644 "${SILENCE_WAV}" 2>/dev/null || true
    echo "${OK} Created ${SILENCE_WAV} (30 ms)"
  else
    echo "${OK} Silence file already exists: ${SILENCE_WAV}"
  fi
}

# Create or update a dedicated dialplan block. It plays ~30ms silence before Stasis().
ensure_dialplan_freepbx() {
  local f="/etc/asterisk/extensions_custom.conf"
  touch "$f"

  # Remove existing block between markers (if present)
  if grep -q 'BEGIN OPENAI_RT_AUTOCONFIG' "$f" 2>/dev/null; then
    awk '
      BEGIN { skip=0 }
      /BEGIN OPENAI_RT_AUTOCONFIG/ { skip=1; next }
      /END OPENAI_RT_AUTOCONFIG/ { skip=0; next }
      skip==0 { print }
    ' "$f" > "${f}.tmp" && mv -f "${f}.tmp" "$f"
  fi

  # Append fresh block
  cat >>"$f" <<'EOF'

; BEGIN OPENAI_RT_AUTOCONFIG
[from-internal-custom]
exten => 9999,1,NoOp(OpenAI Realtime)
 same => n,Answer()
 same => n,Playback(custom/openai_silence_30ms) ; ~30 ms priming tone (no 1s delay)
 same => n,Stasis(asterisk_to_openai_rt)
 same => n,Hangup()
; END OPENAI_RT_AUTOCONFIG
EOF
}

read_http_bind_from_status() {
  local status line hostport
  status="$(asterisk -rx 'http show status' 2>/dev/null || true)"
  # Only the HTTP line, not HTTPS; first match wins
  line="$(printf '%s\n' "$status" | grep -m1 '^Server Enabled and Bound to ')"
  if [ -n "$line" ]; then
    hostport="$(printf '%s\n' "$line" | awk '{print $6}')"
    printf '%s' "$hostport"
  else
    printf '%s' "127.0.0.1:8088"
  fi
}

# ========= Verification =========
verify_http_enabled() {
  local out rc
  set +e
  out=$(asterisk -rx "http show status" 2>/dev/null); rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -qiE 'Server Enabled and Bound|Enabled:.*Yes'; then
    echo "${OK} HTTP server enabled"
    inc_pass
  else
    echo "${FAIL} HTTP server NOT enabled (check: asterisk -rx \"http show status\")"
    inc_fail
  fi
  set -e
}

verify_ari_user_plain() {
  set +e
  local pass fmt
  pass="$(get_existing_ari_pass || true)"
  fmt="$(get_ari_password_format || true)"
  if [ -n "$pass" ] && { [ -z "$fmt" ] || [ "$fmt" = "plain" ]; }; then
    echo "${OK} ARI user 'openai_rt' present with plain password"
    inc_pass
  else
    echo "${FAIL} ARI user 'openai_rt' missing or not plain"
    inc_fail
  fi
  set -e
}

verify_dialplan_loaded() {
  local out rc
  set +e
  out=$(asterisk -rx "dialplan show from-internal-custom" 2>/dev/null); rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "Playback(custom/openai_silence_30ms)" && echo "$out" | grep -q "Stasis(asterisk_to_openai_rt)"; then
    echo "${OK} Dialplan 9999 loaded with short silence and Stasis"
    inc_pass
  else
    echo "${FAIL} Dialplan 9999 not found or missing silence/Stasis lines"
    inc_fail
  fi
  set -e
}

verify_silence_file() {
  if [ -f "${SILENCE_WAV}" ]; then
    echo "${OK} Silence WAV present: ${SILENCE_WAV}"
    inc_pass
  else
    echo "${FAIL} Silence WAV missing: ${SILENCE_WAV}"
    inc_fail
  fi
}

verify_ari_http_auth() {
  set +e
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -u "${ARI_USERNAME}:${ARI_PASSWORD}" "${ARI_URL}/ari/applications" || true)
  if [ "$code" = "200" ]; then
    echo "${OK} ARI HTTP auth works (${ARI_URL}/ari/applications → 200)"
    inc_pass
  else
    echo "${WARN} ARI HTTP auth HTTP ${code} (verify user/pass & http settings)"
    inc_warn
  fi
  set -e
}

verify_service_active_or_report() {
  set +e
  if systemctl is-enabled --quiet asterisk-openai.service && systemctl is-active --quiet asterisk-openai.service; then
    echo "${OK} systemd service 'asterisk-openai.service' active & enabled"
    inc_pass
    set -e; return
  fi

  # Validate required keys to avoid restart loop
  local cfg="${APP_DIR}/config.conf"
  local miss=()
  for k in OPENAI_API_KEY ARI_URL ARI_USERNAME ARI_PASSWORD; do
    if ! grep -q "^${k}=" "$cfg" 2>/dev/null || [ -z "$(grep "^${k}=" "$cfg" | sed 's/^[^=]*=//')" ]; then
      miss+=("$k")
    fi
  done
  if [ ${#miss[@]} -gt 0 ]; then
    echo "${FAIL} Service not running. Missing keys in config.conf: ${miss[*]}"
  else
    echo "${FAIL} Service not running. See recent logs:"
  fi

  journalctl -u asterisk-openai.service -n 50 --no-pager || true
  systemctl stop asterisk-openai.service || true
  systemctl reset-failed asterisk-openai.service || true
  inc_fail
  set -e
}

print_verification_summary() {
  echo
  echo "${BOLD}Post-install verification:${NC}"
  echo "- Passed: ${PASS_COUNT}  Failed: ${FAIL_COUNT}  Warnings: ${WARN_COUNT}"
}

print_freepbx_manual() {
  cat <<'HOWTO'

--------------------------------------------------------------------------------
FreePBX GUI manual: Route calls to the custom dialplan (9999)
--------------------------------------------------------------------------------

Option A) Quick test from any internal phone
  - Dial: 9999     (context: from-internal)

Option B) Create a Custom Destination and a Misc Application
  1) Admin → Custom Destinations → Add
     - Custom Destination: from-internal-custom,9999,1
     - Description: OpenAI Realtime (9999)
     - Return: No
     - Submit, then Apply Config

  2) Applications → Misc Applications → Add
     - Description: OpenAI Realtime
     - Feature Code: *9999   (or 9999)
     - Destination: Custom Destinations → OpenAI Realtime (9999)
     - Submit, then Apply Config

Option C) Inbound Route → Destination
  - To point an external DID to the app:
    Connectivity → Inbound Routes → (pick your DID)
    - Set Destination: Custom Destinations → OpenAI Realtime (9999)
    - Submit, then Apply Config

Notes:
  - The dialplan 9999 answers the call and immediately plays ~30 ms of audio
    from custom/openai_silence_30ms.wav to prime RTP, then enters Stasis.
  - Only *_custom.conf files are modified (http_custom.conf, ari_general_custom.conf,
    ari_additional_custom.conf, extensions_custom.conf).
  - The app reads config from /opt/asterisk_to_openai_rt_community/config.conf.
--------------------------------------------------------------------------------
HOWTO
}

# ========= Main =========
check_root
require_freepbx

log "${CYAN}${BOLD}Starting installation (FreePBX-only)...${NC}"
log "Full log: ${LOGFILE}"

# Install prerequisites. We ensure 'sox' to generate the 30 ms WAV.
log "${CYAN}Installing prerequisites (curl git openssl iproute2 nodejs npm sox)...${NC}"
ensure_pkg curl git openssl iproute2 nodejs npm sox

# HTTP + ARI configs (custom-only)
log "${CYAN}Ensuring HTTP server (http_custom.conf)...${NC}"
ensure_http_conf_freepbx

log "${CYAN}Ensuring ARI general (ari_general_custom.conf)...${NC}"
ensure_ari_general_custom

log "${CYAN}Ensuring ARI user '${ARI_USERNAME}' in ari_additional_custom.conf...${NC}"
ensure_ari_user_custom

# Prepare short-silence WAV
log "${CYAN}Ensuring 30 ms silence WAV in ${SOUNDS_DIR}...${NC}"
ensure_custom_silence_wav

# Dialplan with short media kick
log "${CYAN}Ensuring dialplan (extensions_custom.conf -> 9999 with short silence)...${NC}"
ensure_dialplan_freepbx

# Reload Asterisk via FreePBX
log "${CYAN}Reloading Asterisk via fwconsole...${NC}"
fwconsole reload

# Determine runtime HTTP bind
BIND="$(read_http_bind_from_status)"; HTTP_ADDR="${BIND%%:*}"; HTTP_PORT="${BIND##*:}"
ARI_URL="http://${HTTP_ADDR}:${HTTP_PORT}"
log "ARI_URL detected: ${ARI_URL}"

# Clone/update app (your fork)
log "${CYAN}Cloning/updating application repo...${NC}"
mkdir -p /opt
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" pull --ff-only || true
else
  git clone https://github.com/maladrill/asterisk_to_openai_rt_community.git "${APP_DIR}"
fi
cd "${APP_DIR}"
npm install

# Update existing config.conf from repo (do not recreate)
log "${CYAN}Updating application config.conf...${NC}"
if [ ! -f config.conf ]; then
  echo -e "${RED}config.conf not found in ${APP_DIR}. Aborting.${NC}"
  exit 1
fi
cp -a config.conf "config.conf.bak.$(date +%s)" || true

# Prompt for OPENAI_API_KEY (optional: blank = keep current)
if [ -t 0 ]; then
  echo -n "Enter your OPENAI_API_KEY (leave blank to keep existing): "
  read -rs _KEY; echo
  if [ -n "${_KEY}" ]; then
    update_env_kv config.conf "OPENAI_API_KEY" "${_KEY}"
  fi
fi

# Write only the keys the app expects
update_env_kv config.conf "ARI_URL"       "${ARI_URL}"
update_env_kv config.conf "ARI_USERNAME"  "${ARI_USERNAME}"
update_env_kv config.conf "ARI_PASSWORD"  "${ARI_PASSWORD}"

# Permissions
chown "${RUN_USER}:${RUN_USER}" config.conf 2>/dev/null || true
chmod 600 config.conf 2>/dev/null || true

# systemd service
log "${CYAN}Configuring systemd service asterisk-openai.service...${NC}"
safe_backup "$SERVICE_FILE"
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Asterisk to OpenAI Realtime Service
After=network.target asterisk.service

[Service]
ExecStart=/usr/bin/node ${APP_DIR}/index.js
WorkingDirectory=${APP_DIR}
Restart=always
User=${RUN_USER}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable asterisk-openai.service
systemctl restart asterisk-openai.service || true

# ===== Summary =====
echo
echo "${GREEN}${BOLD}Installation Summary:${NC}"
echo "- Files used: http_custom.conf, ari_general_custom.conf, ari_additional_custom.conf"
echo "- ARI URL: ${ARI_URL}"
echo "- ARI user: ${ARI_USERNAME} / ${ARI_PASSWORD}"
echo "- Dialplan: [from-internal-custom] exten 9999 with Playback(custom/openai_silence_30ms) before Stasis"
echo "- Silence WAV: ${SILENCE_WAV}"
echo "- Service: systemd unit asterisk-openai.service"
echo "- App path: ${APP_DIR}"
echo "- Full log: ${LOGFILE}"

# ===== Verification =====
echo
echo "${BOLD}Running post-install checks...${NC}"
verify_http_enabled
verify_ari_user_plain
verify_silence_file
verify_dialplan_loaded
verify_ari_http_auth
verify_service_active_or_report
print_verification_summary

print_freepbx_manual

echo "${GREEN}Done.${NC}"

print_freepbx_manual

echo -e "${GREEN}Done.${NC}"
