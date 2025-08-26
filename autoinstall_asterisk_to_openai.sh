#!/bin/bash
# Asterisk ↔ OpenAI Realtime installer (Debian & FreePBX)
# Safe for FreePBX (writes only to *_custom.conf). Idempotent.
# Creates/keeps ARI user [openai_rt] with plain password.
# Includes end-of-run verification and FreePBX GUI manual.

set -Eeuo pipefail

# ========== Logging & traps ==========
TS="$(date +%Y%m%d-%H%M%S)"
LOGFILE="/root/asterisk-openai-install-${TS}.log"
# Mirror all stdout/stderr to a logfile
exec > >(tee -a "$LOGFILE") 2>&1

if [[ "${DEBUG:-0}" != "0" ]]; then set -x; fi

err() {
  local ec=$?
  echo -e "\n\033[0;31mERROR:\033[0m command failed with exit code ${ec}"
  echo -e "  Line: ${BASH_LINENO[0]}  Cmd: ${BASH_COMMAND}\n"
  echo "See log: $LOGFILE"
  exit $ec
}
trap err ERR

# ========== Colors & symbols ==========
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
OK="${GREEN}✔${NC}"; FAIL="${RED}✖${NC}"; WARN="${YELLOW}!${NC}"

# ========== Globals ==========
ENV="unknown"
HTTP_ADDR="127.0.0.1"; HTTP_PORT="8088"; ARI_URL="http://127.0.0.1:8088"
ARI_USERNAME="openai_rt"; ARI_PASSWORD=""
PUBLIC_IP=""; LOCAL_CIDR=""
DEBIAN_SIP_PASS=""
PASS_COUNT=0; FAIL_COUNT=0; WARN_COUNT=0

# ========== Helpers ==========
log() { echo -e "$@"; }
inc_pass(){ PASS_COUNT=$((PASS_COUNT+1)); }
inc_fail(){ FAIL_COUNT=$((FAIL_COUNT+1)); }
inc_warn(){ WARN_COUNT=$((WARN_COUNT+1)); }

check_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo -e "${RED}Run as root (use sudo).${NC}"; exit 1
  fi
}

# Generate a 16-char alphanumeric string (pipefail-safe)
rand16() {
  local r
  r="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9')"
  printf '%s' "${r:0:16}"
}

is_freepbx() { command -v fwconsole >/dev/null 2>&1; }
ensure_pkg() { apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"; }

get_public_ip() {
  for s in "https://icanhazip.com" "https://ifconfig.me"; do
    ip=$(curl -s --max-time 5 "$s" 2>/dev/null || true)
    if [ -n "$ip" ]; then echo "${ip%%[$'\r\n']*}"; return; fi
  done
  echo "192.168.1.100"
}

get_local_cidr() {
  # Prefer RFC1918 range if present; else first global IPv4 or a sane default
  local cidr rfc1918
  rfc1918=$(ip -4 addr show | awk '/inet /{print $2}' | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)' | head -n1 || true)
  if [ -n "$rfc1918" ]; then
    echo "$rfc1918"
    return
  fi
  cidr=$(ip -4 addr show scope global | awk '/inet /{print $2; exit}')
  [ -n "${cidr:-}" ] && echo "$cidr" || echo "192.168.1.0/24"
}

append_unique() {
  local file="$1" pattern="$2" block="$3"
  touch "$file"
  if ! grep -qE "$pattern" "$file" 2>/dev/null; then printf "\n%s\n" "$block" >> "$file"; fi
}

safe_backup() { [ -f "$1" ] && cp -a "$1" "$1.bak.$(date +%s)" || true; }

ensure_http_conf() {
  local f="/etc/asterisk/http.conf"
  touch "$f"; safe_backup "$f"
  grep -q '^\[general\]' "$f" || sed -i '1i [general]' "$f"
  if grep -q '^[[:space:]]*enabled[[:space:]]*=' "$f"; then
    sed -i 's/^\s*enabled\s*=.*/enabled=yes/' "$f"
  else
    echo "enabled=yes" >> "$f"
  fi
  grep -q '^[[:space:]]*bindaddr[[:space:]]*=' "$f" || echo "bindaddr=127.0.0.1" >> "$f"
  grep -q '^[[:space:]]*bindport[[:space:]]*=' "$f" || echo "bindport=8088" >> "$f"
}

read_http_bind() {
  local f="/etc/asterisk/http.conf" addr port
  addr=$(awk -F= '/^\s*bindaddr\s*=/ {gsub(/[ \t]/,"",$2); v=$2} END{print v}' "$f")
  port=$(awk -F= '/^\s*bindport\s*=/ {gsub(/[ \t]/,"",$2); v=$2} END{print v}' "$f")
  [ -z "$addr" ] && addr="127.0.0.1"
  [ -z "$port" ] && port="8088"
  echo "${addr}:${port}"
}

read_ari_user_from_ari_conf() {
  # echo "password:format" for given user if exists; else empty
  local user="$1" f="/etc/asterisk/ari.conf"
  [ -f "$f" ] || return 0
  awk -v WANT="$user" '
    /^\[[^]]+\]/ { sect=$0; gsub(/^\[|\]$/,"",sect); fmt="plain"; pass=""; inuser=(sect==WANT) }
    inuser && /^[ \t]*password_format[ \t]*=/ { sub(/^[^=]*=/,""); gsub(/[ \t]/,""); fmt=$0 }
    inuser && /^[ \t]*password[ \t]*=/ { sub(/^[^=]*=/,""); gsub(/^[ \t]+|[ \t]+$/,""); pass=$0 }
    END { if(pass!="") print pass ":" fmt }
  ' "$f"
}

ensure_ari_plain_user() {
  # Ensure [openai_rt] with plain password exists (idempotent).
  local existing pass fmt
  existing=$(read_ari_user_from_ari_conf "openai_rt" || true)
  if [ -n "$existing" ]; then
    pass="${existing%%:*}"; fmt="${existing##*:}"
    if [ "${fmt:-plain}" = "plain" ]; then
      ARI_PASSWORD="$pass"
      return
    fi
    # Replace crypt-format section with a plain one
    ARI_PASSWORD="$(rand16)"
    safe_backup "/etc/asterisk/ari.conf"
    awk -v RS= -v ORS= '
      {
        gsub(/\r/,"")
        n=split($0, a, /\n\[/); out=""
        for(i=1;i<=n;i++){
          s=a[i]
          if (i>1) { s="[" s }
          if (match(s, /^\[openai_rt\][\s\S]*/)) { s="" }
          out=out s
        }
        print out
      }' /etc/asterisk/ari.conf > /etc/asterisk/ari.conf.tmp || true
    mv -f /etc/asterisk/ari.conf.tmp /etc/asterisk/ari.conf
    cat >>/etc/asterisk/ari.conf <<EOF

[openai_rt]
type=user
password=${ARI_PASSWORD}
read_only=no
password_format=plain
EOF
  else
    # Create fresh section
    ARI_PASSWORD="$(rand16)"
    touch /etc/asterisk/ari.conf
    safe_backup "/etc/asterisk/ari.conf"
    grep -q '^\[general\]' /etc/asterisk/ari.conf || echo "[general]" >> /etc/asterisk/ari.conf
    grep -q '^\s*enabled\s*=' /etc/asterisk/ari.conf || echo "enabled=yes" >> /etc/asterisk/ari.conf
    grep -q '^\s*pretty\s*=' /etc/asterisk/ari.conf || echo "pretty=yes" >> /etc/asterisk/ari.conf
    cat >>/etc/asterisk/ari.conf <<EOF

[openai_rt]
type=user
password=${ARI_PASSWORD}
read_only=no
password_format=plain
EOF
  fi
}

set_kv_in_file() {
  local file="$1" key="$2" val="$3"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

has_pjsip_object_type() {
  # has_pjsip_object_type FILE SECTION TYPE -> 0 if exists
  local f="$1" sect="$2" typ="$3"
  awk -v S="$sect" -v T="$typ" '
    BEGIN{in=0;found=0}
    /^\[[^]]+\]/ {name=substr($0,2,length($0)-2); in=(name==S); next}
    in && $0 ~ /^type[ \t]*=[ \t]*([^#;]+)/ {
      gsub(/^type[ \t]*=[ \t]*/,"",$0); gsub(/[ \t].*$/,"",$0)
      if ($0==T) {found=1; exit 0}
    }
    END{exit found?0:1}
  ' "$f"
}

get_pjsip_auth_password() {
  local f="/etc/asterisk/pjsip_custom.conf"
  [ -f "$f" ] || return 0
  awk '
    /^\[1005\]$/ {in=1; next}
    /^\[/ {in=0}
    in && /^type[ \t]*=/ { if ($0 ~ /auth/) ta=1 }
    in && /^password[ \t]*=/ { sub(/^[^=]*=/,""); gsub(/^[ \t]+|[ \t]+$/,""); if (ta) {print $0; exit} }
  ' "$f"
}

ensure_debian_pjsip_custom() {
  local f="/etc/asterisk/pjsip_custom.conf"
  touch "$f"; safe_backup "$f"

  append_unique "$f" '^\[transport-udp\][[:space:]]*$' "[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0
external_media_address=${PUBLIC_IP}
external_signaling_address=${PUBLIC_IP}
local_net=${LOCAL_CIDR}
"

  if has_pjsip_object_type "$f" "1005" "endpoint"; then :; else
    cat >>"$f" <<'EOF'
[1005]
type=endpoint
context=default
disallow=all
allow=ulaw
auth=1005
aors=1005
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
EOF
  fi

  if has_pjsip_object_type "$f" "1005" "auth"; then :; else
    DEBIAN_SIP_PASS="$(rand16)"
    cat >>"$f" <<EOF
[1005]
type=auth
auth_type=userpass
password=${DEBIAN_SIP_PASS}
username=1005
EOF
  fi

  if has_pjsip_object_type "$f" "1005" "aor"; then :; else
    cat >>"$f" <<'EOF'
[1005]
type=aor
max_contacts=2
EOF
  fi

  if [ -z "${DEBIAN_SIP_PASS}" ]; then
    DEBIAN_SIP_PASS="$(get_pjsip_auth_password || true)"
  fi
}

ensure_dialplan() {
  if is_freepbx; then
    local f="/etc/asterisk/extensions_custom.conf"
    touch "$f"
    append_unique "$f" 'OPENAI_RT_AUTOCONFIG' "; BEGIN OPENAI_RT_AUTOCONFIG
[from-internal-custom]
exten => 9999,1,NoOp(OpenAI Realtime)
 same => n,Answer()
 same => n,Stasis(asterisk_to_openai_rt)
 same => n,Hangup()
; END OPENAI_RT_AUTOCONFIG"
  else
    local f="/etc/asterisk/extensions.conf"
    safe_backup "$f"
    if ! grep -q 'OPENAI_RT_AUTOCONFIG' "$f" 2>/dev/null; then
      cat >>"$f" <<'EOF'

; BEGIN OPENAI_RT_AUTOCONFIG
[default]
exten => 9999,1,Answer()
 same => n,Stasis(asterisk_to_openai_rt)
 same => n,Hangup()
; END OPENAI_RT_AUTOCONFIG
EOF
    fi
  fi
}

# ========== Verification ==========
verify_http_enabled() {
  set +e
  local out rc
  out=$(asterisk -rx "http show status" 2>/dev/null); rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -qiE 'Server Enabled|Enabled[[:space:]]+and Bound|Enabled:.*Yes'; then
    echo -e "${OK} HTTP server enabled"; inc_pass
  else
    echo -e "${FAIL} HTTP server NOT enabled (check: asterisk -rx \"http show status\")"; inc_fail
  fi
  set -e
}

verify_ari_user_plain() {
  set +e
  local existing fmt
  existing=$(read_ari_user_from_ari_conf "openai_rt")
  fmt="${existing##*:}"
  if [ -n "$existing" ] && [ "${fmt:-plain}" = "plain" ]; then
    echo -e "${OK} ARI user 'openai_rt' present with plain password"; inc_pass
  else
    echo -e "${FAIL} ARI user 'openai_rt' missing or not plain"; inc_fail
  fi
  set -e
}

verify_dialplan_loaded() {
  set +e
  local out rc
  if [ "$ENV" = "freepbx" ]; then
    out=$(asterisk -rx "dialplan show from-internal-custom" 2>/dev/null); rc=$?
  else
    out=$(asterisk -rx "dialplan show default" 2>/dev/null); rc=$?
  fi
  if [ $rc -eq 0 ] && echo "$out" | grep -q "Stasis(asterisk_to_openai_rt)"; then
    echo -e "${OK} Dialplan 9999 loaded (Stasis)"; inc_pass
  else
    echo -e "${FAIL} Dialplan 9999 NOT found in loaded plan"; inc_fail
  fi
  set -e
}

verify_service_active() {
  set +e
  if systemctl is-enabled --quiet asterisk-openai.service && systemctl is-active --quiet asterisk-openai.service; then
    echo -e "${OK} systemd service 'asterisk-openai.service' active & enabled"; inc_pass
  else
    echo -e "${WARN} service not active yet (maybe missing OPENAI_API_KEY). Check: systemctl status asterisk-openai.service"; inc_warn
  fi
  set -e
}

verify_ari_http_auth() {
  set +e
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -u "${ARI_USERNAME}:${ARI_PASSWORD}" "${ARI_URL}/ari/applications" || true)
  if [ "$code" = "200" ]; then
    echo -e "${OK} ARI HTTP auth works (${ARI_URL}/ari/applications → 200)"; inc_pass
  else
    echo -e "${WARN} ARI HTTP auth HTTP ${code} (verify user/pass & http.conf)"; inc_warn
  fi
  set -e
}

print_verification_summary() {
  echo -e "\n${BOLD}Post-install verification:${NC}"
  echo -e "- Passed: ${GREEN}${PASS_COUNT}${NC}  Failed: ${RED}${FAIL_COUNT}${NC}  Warnings: ${YELLOW}${WARN_COUNT}${NC}"
  if [ $FAIL_COUNT -gt 0 ]; then
    echo -e "${RED}Some critical checks failed. Fix issues above and re-run the script.${NC}"
  fi
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
     - Feature Code: *9999   (or 9999 if you prefer)
     - Destination: Custom Destinations → OpenAI Realtime (9999)
     - Submit, then Apply Config

  Now dialing *9999 (or 9999) from an internal phone will hit:
     Stasis(asterisk_to_openai_rt)

Option C) Inbound Route → Destination
  - To point an external DID to the app:
    Connectivity → Inbound Routes → (pick your DID)
    - Set Destination: Custom Destinations → OpenAI Realtime (9999)
    - Submit, then Apply Config

Notes:
  - We never write to extensions_additional.conf or pjsip.conf. FreePBX generates them.
  - ARI user 'openai_rt' is stored in /etc/asterisk/ari.conf with a plain password.
  - After you add OPENAI_API_KEY to the app config, restart the service.

--------------------------------------------------------------------------------
HOWTO
}

# ========== Main ==========
check_root
log "${CYAN}${BOLD}Starting installation...${NC}"
log "Full log: ${LOGFILE}"

log "${CYAN}Installing prerequisites (curl git openssl iproute2 nodejs npm)...${NC}"
ensure_pkg curl git openssl iproute2 nodejs npm

# Detect environment
if is_freepbx; then ENV="freepbx"; else ENV="debian"; fi
log "Environment detected: ${ENV}"

# Networking
PUBLIC_IP=$(get_public_ip)
LOCAL_CIDR=$(get_local_cidr)
log "Detected PUBLIC_IP=${PUBLIC_IP}  LOCAL_CIDR=${LOCAL_CIDR}"

# HTTP for ARI
log "${CYAN}Ensuring Asterisk HTTP server is enabled...${NC}"
ensure_http_conf
BIND="$(read_http_bind)"; HTTP_ADDR="${BIND%%:*}"; HTTP_PORT="${BIND##*:}"
ARI_URL="http://${HTTP_ADDR}:${HTTP_PORT}"
log "ARI_URL set to ${ARI_URL}"

# ARI user (plain)
log "${CYAN}Ensuring ARI user 'openai_rt' (plain password)...${NC}"
ensure_ari_plain_user
log "Using ARI credentials: ${ARI_USERNAME} / ${ARI_PASSWORD}"

# Dialplan
log "${CYAN}Ensuring dialplan (extension 9999)...${NC}"
ensure_dialplan

# SIP (Debian only)
if [ "$ENV" = "debian" ]; then
  log "${CYAN}Ensuring SIP (pjsip_custom.conf) on Debian...${NC}"
  ensure_debian_pjsip_custom
  [ -n "${DEBIAN_SIP_PASS}" ] && log "Endpoint 1005 password: ${DEBIAN_SIP_PASS}"
else
  log "${YELLOW}Skipping SIP endpoint writes on FreePBX (manage via GUI).${NC}"
fi

# Reload Asterisk
log "${CYAN}Reloading Asterisk configuration...${NC}"
if [ "$ENV" = "freepbx" ]; then fwconsole reload; else systemctl restart asterisk; fi

# Clone/update app
log "${CYAN}Cloning/updating application repo...${NC}"
mkdir -p /opt
if [ -d /opt/asterisk_to_openai_rt_community/.git ]; then
  git -C /opt/asterisk_to_openai_rt_community pull --ff-only || true
else
  git clone https://github.com/maladrill/asterisk_to_openai_rt_community.git /opt/asterisk_to_openai_rt_community
fi
cd /opt/asterisk_to_openai_rt_community
# Prefer npm install; if package-lock exists and you want stricter, switch to npm ci
npm install

# Update app config
log "${CYAN}Updating application config.conf...${NC}"
touch config.conf
set_kv_in_file config.conf "ARI_USERNAME" "$ARI_USERNAME"
set_kv_in_file config.conf "ARI_PASSWORD" "$ARI_PASSWORD"
set_kv_in_file config.conf "ARI_URL" "$ARI_URL"
# NOTE: You must add OPENAI_API_KEY manually.

# systemd service
log "${CYAN}Configuring systemd service asterisk-openai.service...${NC}"
RUN_USER="root"; id -u asterisk >/dev/null 2>&1 && RUN_USER="asterisk"
SERVICE_FILE="/etc/systemd/system/asterisk-openai.service"
safe_backup "$SERVICE_FILE"
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Asterisk to OpenAI Realtime Service
After=network.target asterisk.service

[Service]
ExecStart=/usr/bin/node /opt/asterisk_to_openai_rt_community/index.js
WorkingDirectory=/opt/asterisk_to_openai_rt_community
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
echo -e "\n${GREEN}${BOLD}Installation Summary:${NC}"
echo "- Environment: ${ENV}"
echo "- ARI URL: ${ARI_URL}"
echo "- ARI user: ${ARI_USERNAME} / ${ARI_PASSWORD}"
if [ "$ENV" = "freepbx" ]; then
  echo "- Dialplan: [from-internal-custom] exten 9999 (extensions_custom.conf)"
  echo "- SIP: manage endpoints from FreePBX GUI (no pjsip.conf writes)"
else
  echo "- Dialplan: [default] exten 9999 (extensions.conf)"
  [ -n "${DEBIAN_SIP_PASS}" ] && echo "- SIP endpoint 1005 password: ${DEBIAN_SIP_PASS}"
  echo "- SIP: written to pjsip_custom.conf (transport-udp, 1005 endpoint/auth/aor)"
fi
echo "- Service: systemd unit asterisk-openai.service"
echo "- App path: /opt/asterisk_to_openai_rt_community"
echo "- Full log: ${LOGFILE}"

# ===== Verification =====
echo -e "\n${BOLD}Running post-install checks...${NC}"
verify_http_enabled
verify_ari_user_plain
verify_dialplan_loaded
verify_ari_http_auth
verify_service_active
print_verification_summary

# ===== FreePBX manual =====
if [ "$ENV" = "freepbx" ]; then
  print_freepbx_manual
fi

echo -e "${GREEN}Done.${NC}"
