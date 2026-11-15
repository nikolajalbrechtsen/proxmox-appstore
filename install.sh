#!/usr/bin/env bash
# Proxmox App Store installer.
#
# Run it in the Proxmox host's shell (select your node in the Proxmox web UI, then Shell):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/nikolajalbrechtsen/proxmox-appstore/main/install.sh)"
#
# It creates a small Debian container, installs the App Store in it, and creates the limited
# Proxmox API token the App Store works with. At the end it prints the address to open.
#
# Optional settings, given in front of the command, for example  CTID=150 STORAGE=local-zfs bash -c "..."
#   CTID      container ID                         (default: the next free ID)
#   STORAGE   storage for the container's disk     (default: local-lvm, or the first one that fits)
#   BRIDGE    network bridge                       (default: vmbr0)
#   CT_NAME   container name                       (default: appstore)
#   REPO_URL  repository to install from           (default: the official one; use your fork's URL)
#   NO_COLOR  set to anything for plain output without colors or animation
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/nikolajalbrechtsen/proxmox-appstore.git}"
CT_NAME="${CT_NAME:-appstore}"
BRIDGE="${BRIDGE:-vmbr0}"
ROLE_PRIVS="VM.Allocate,VM.Audit,VM.PowerMgmt,VM.Config.Disk,VM.Config.CPU,VM.Config.Memory,VM.Config.Network,VM.Config.Options,VM.GuestAgent.Audit,Datastore.Allocate,Datastore.AllocateSpace,Datastore.AllocateTemplate,Datastore.Audit,Sys.Audit,Sys.AccessNetwork,SDN.Use"

# ---------- look ----------
# Colors and the spinner are only used on a real terminal; a pipe or NO_COLOR gets plain lines.
if { [ -t 1 ] || [ -n "${FORCE_COLOR:-}" ]; } && [ -z "${NO_COLOR:-}" ]; then
  FANCY=1; B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  ORANGE=$'\033[38;5;208m'; GREEN=$'\033[32m'; RED=$'\033[31m'; CYAN=$'\033[36m'
else
  FANCY=""; B=""; DIM=""; R=""; ORANGE=""; GREEN=""; RED=""; CYAN=""
fi
OK="${GREEN}✔${R}"; BAD="${RED}✖${R}"

banner() {
  printf '\n'
  printf '  %s╭────────────────────────────────────────────╮%s\n' "$ORANGE" "$R"
  printf '  %s│%s   %s▣  Proxmox App Store%s   %sinstaller%s         %s│%s\n' "$ORANGE" "$R" "$B" "$R" "$DIM" "$R" "$ORANGE" "$R"
  printf '  %s╰────────────────────────────────────────────╯%s\n\n' "$ORANGE" "$R"
}
row()  { printf '  %s%-11s%s %s\n' "$DIM" "$1" "$R" "$2"; }
die()  { printf '\n  %s %sError:%s %s\n\n' "$BAD" "$B" "$R" "$*" >&2; exit 1; }
# Asks on the terminal even when the script itself arrives through a pipe. Without a terminal, the default applies.
ask() {
  local a
  printf '  %s?%s %s%s%s %s%s%s ' "$ORANGE" "$R" "$B" "$1" "$R" "$DIM" "$2" "$R" >&2
  { read -r a </dev/tty; } 2>/dev/null || { a=""; printf '\n' >&2; }
  printf '%s' "$a"
}

LOG="$(mktemp /tmp/appstore-install.XXXXXX)"; chmod 600 "$LOG"
SPIN_PID=""; CREATED=""; STEP=0; STEPS=6; T0=$SECONDS
spin_stop() {
  [ -n "$SPIN_PID" ] || return 0
  kill "$SPIN_PID" 2>/dev/null || true; wait "$SPIN_PID" 2>/dev/null || true; SPIN_PID=""
  printf '\r\033[K\033[?25h'
}
# run "What is happening" function-or-command...
# Shows a spinner while it works and a check mark with the time it took. Its output goes to the log;
# when it fails, the end of the log is shown. Functions used here must `return 1` on failure.
run() {
  local msg="$1" t=$SECONDS f from; shift
  STEP=$((STEP + 1))
  local label="${DIM}[$STEP/$STEPS]${R} $msg"
  printf '\n--- %s\n' "$msg" >> "$LOG"
  from=$(($(wc -l < "$LOG") + 1))   # where this step's own output starts in the log
  if [ -n "$FANCY" ]; then
    printf '\033[?25l'
    ( while :; do for f in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do printf '\r  %s%s%s %s' "$ORANGE" "$f" "$R" "$label"; sleep 0.1; done; done ) &
    SPIN_PID=$!
  else
    printf '  - %s\n' "$msg"
  fi
  if "$@" >> "$LOG" 2>&1; then
    spin_stop
    printf '  %s %s %s%ss%s\n' "$OK" "$label" "$DIM" "$((SECONDS - t))" "$R"
  else
    spin_stop
    printf '  %s %s\n\n' "$BAD" "$label"
    printf '  %sWhat it said:%s\n' "$B" "$R"
    tail -n "+$from" "$LOG" | grep -v '^[[:space:]]*$' | tail -n 12 | sed 's/^/    /' || true
    printf '\n  %sThe full log is in %s%s\n' "$DIM" "$LOG" "$R"
    exit 1
  fi
}
why() { echo "$*"; return 1; }   # a step's own explanation of why it failed

on_exit() {
  local code=$?
  spin_stop
  if [ "$code" -ne 0 ] && [ -n "$CREATED" ]; then
    printf '\n  The install stopped before it finished. Container %s was created; remove it with:\n\n    %spct stop %s; pct destroy %s%s\n\n' "$CTID" "$CYAN" "$CTID" "$CTID" "$R" >&2
  fi
  [ "$code" -eq 0 ] && rm -f "$LOG"
  return 0
}
trap on_exit EXIT
trap 'exit 130' INT TERM

banner

# ---------- checks ----------
[ "$(id -u)" = 0 ] || die "Run this as root in the Proxmox host's shell."
for c in pct pveam pvesm pveum pvesh pveversion; do
  command -v "$c" >/dev/null || die "'$c' was not found. This script must run on the Proxmox host, not inside a container or VM."
done
PVE_VER="$(pveversion | sed -n 's#^pve-manager/\([0-9]*\.[0-9]*\).*#\1#p')"
[ -n "$PVE_VER" ] || die "Could not read the Proxmox version."
if [ "${PVE_VER%%.*}" -lt 9 ] || { [ "${PVE_VER%%.*}" -eq 9 ] && [ "${PVE_VER#*.}" -lt 1 ]; }; then
  die "Proxmox VE 9.1 or newer is needed (this host runs $PVE_VER). The store installs apps from Docker/OCI images, which older versions cannot do."
fi

# First storage that can hold the given kind of content, preferring the usual default.
pick_storage() {
  local list; list="$(pvesm status --content "$1" 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}')"
  if printf '%s\n' "$list" | grep -qx "$2"; then printf '%s' "$2"; else printf '%s\n' "$list" | head -n1; fi
}
STORAGE="${STORAGE:-$(pick_storage rootdir local-lvm)}"
TMPL_STORAGE="$(pick_storage vztmpl local)"
[ -n "$STORAGE" ] || die "No storage that can hold container disks was found."
[ -n "$TMPL_STORAGE" ] || die "No storage that can hold container templates was found."
ip link show "$BRIDGE" >/dev/null 2>&1 || die "Network bridge '$BRIDGE' does not exist. Set BRIDGE=<name> in front of the command."
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
[[ "$CTID" =~ ^[1-9][0-9]{2,8}$ ]] || die "'$CTID' is not a valid container ID."
if pct status "$CTID" >/dev/null 2>&1 || qm status "$CTID" >/dev/null 2>&1; then die "ID $CTID is already in use. Set CTID=<free ID> in front of the command."; fi
# The address the container will reach this host's API on.
HOST_IP="$(ip -4 -o addr show "$BRIDGE" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
[ -n "$HOST_IP" ] || HOST_IP="$(hostname -I | awk '{print $1}')"
[ -n "$HOST_IP" ] || die "Could not find this host's IP address."

printf '  %sThis is what will be set up:%s\n\n' "$B" "$R"
row "Host"      "Proxmox VE $PVE_VER at $HOST_IP"
row "Container" "$CTID \"$CT_NAME\" · Debian 13 · 1 core · 512 MB memory · 4 GB disk"
row "Storage"   "$STORAGE"
row "Network"   "$BRIDGE, address from DHCP"
row "Source"    "$REPO_URL"
row "Proxmox"   "user appstore@pve with a limited role and an API token"
printf '\n'

case "$(ask 'Continue?' '[Y/n]')" in n*|N*) printf '\n  Nothing was changed.\n\n'; exit 0 ;; esac
printf '\n  %sThe file browser lets the App Store read and change files inside your\n  running containers. You can also turn it on later.%s\n' "$DIM" "$R"
case "$(ask 'Set up the file browser too?' '[y/N]')" in y*|Y*) FILES=1; STEPS=7 ;; *) FILES="" ;; esac
printf '\n'

# ---------- steps ----------
get_template() {
  pveam update || true
  TMPL="$(pveam available --section system | awk '{print $2}' | grep '^debian-13-standard' | sort -V | tail -n1)"
  [ -n "$TMPL" ] || { why "The Debian 13 template is not in Proxmox's template list. Check the host's internet connection."; return 1; }
  pveam list "$TMPL_STORAGE" 2>/dev/null | grep -q "$TMPL" || pveam download "$TMPL_STORAGE" "$TMPL" || return 1
}
create_container() {
  pct create "$CTID" "$TMPL_STORAGE:vztmpl/$TMPL" --hostname "$CT_NAME" --cores 1 --memory 512 --swap 0 \
    --rootfs "$STORAGE:4" --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" --unprivileged 1 --onboot 1 --tags appstore || return 1
  CREATED=1
  pct start "$CTID" || return 1
}
wait_network() {
  local i
  for i in $(seq 1 45); do
    CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')" || CT_IP=""
    if [ -n "$CT_IP" ] && pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  why "The container got no working network within 90 seconds. Is there a DHCP server on $BRIDGE?"
}
install_app() {
  pct exec "$CTID" -- env DEBIAN_FRONTEND=noninteractive REPO_URL="$REPO_URL" bash -c '
    set -e
    apt-get -q update
    apt-get -q install -y nodejs git ca-certificates openssh-client
    git clone -q "$REPO_URL" /opt/appstore
    useradd -r -s /usr/sbin/nologin appstore
    mkdir -p /var/lib/appstore && chown appstore: /var/lib/appstore && chmod 700 /var/lib/appstore
    cp /opt/appstore/appstore.service /etc/systemd/system/
    # Lets the Update button in the App Store install new versions.
    cp /opt/appstore/autoupdate/appstore-update /usr/local/bin/ && chmod +x /usr/local/bin/appstore-update
    cp /opt/appstore/autoupdate/appstore-update.service /opt/appstore/autoupdate/appstore-update.path /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable -q appstore-update.path
  ' || return 1
}
create_token() {
  local name="ct$CTID" secret tmp   # one token per install, so a second App Store does not break the first
  pveum role add AppStore -privs "$ROLE_PRIVS" 2>/dev/null || pveum role modify AppStore -privs "$ROLE_PRIVS" || return 1
  pveum user add appstore@pve 2>/dev/null || true
  pveum acl modify / -user appstore@pve -role AppStore || return 1
  pveum user token remove appstore@pve "$name" >/dev/null 2>&1 || true
  # The secret goes straight into a variable, never into the log.
  secret="$(pveum user token add appstore@pve "$name" --privsep 0 --output-format json 2>/dev/null | sed -n 's/.*"value" *: *"\([^"]*\)".*/\1/p')" || secret=""
  [ -n "$secret" ] || { why "The API token could not be created."; return 1; }
  # Hand the connection details to the App Store, so its setup page only asks for a password.
  tmp="$(mktemp)" && chmod 600 "$tmp" || return 1
  printf '{"host":"%s","tokenId":"appstore@pve!%s","secret":"%s"}\n' "$HOST_IP" "$name" "$secret" > "$tmp"
  pct push "$CTID" "$tmp" /var/lib/appstore/preseed.json --user appstore --group appstore --perms 600 || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
}
setup_files() {
  local pub
  pct exec "$CTID" -- su -s /bin/sh appstore -c "ssh-keygen -q -t ed25519 -N '' -C appstore-files -f /var/lib/appstore/files_key" || return 1
  pub="$(pct exec "$CTID" -- cat /var/lib/appstore/files_key.pub)" || return 1
  [ -n "$pub" ] || return 1
  pct pull "$CTID" /opt/appstore/host/appstore-files /usr/local/bin/appstore-files || return 1
  chmod 755 /usr/local/bin/appstore-files || return 1
  mkdir -p /root/.ssh
  grep -qF "$(printf '%s' "$pub" | awk '{print $2}')" /root/.ssh/authorized_keys 2>/dev/null \
    || echo "command=\"/usr/local/bin/appstore-files\",restrict $pub" >> /root/.ssh/authorized_keys || return 1
}
start_app() { pct exec "$CTID" -- systemctl enable -q --now appstore || return 1; }

TMPL=""; CT_IP=""
run "Getting the Debian 13 template"        get_template
run "Creating container $CTID"              create_container
run "Waiting for the container's network"   wait_network
run "Installing the App Store"              install_app
run "Creating the Proxmox API token"        create_token
[ -z "$FILES" ] || run "Setting up the file browser" setup_files
run "Starting the App Store"                start_app
CREATED=""

# ---------- done ----------
URL="http://$CT_IP"
printf '\n  %s╭────────────────────────────────────────────╮%s\n' "$GREEN" "$R"
printf '  %s│%s  %s✔ Installed in %-4s%s                       %s│%s\n' "$GREEN" "$R" "$B" "$((SECONDS - T0))s" "$R" "$GREEN" "$R"
printf '  %s│%s                                            %s│%s\n' "$GREEN" "$R" "$GREEN" "$R"
printf '  %s│%s  Open this and choose a password:          %s│%s\n' "$GREEN" "$R" "$GREEN" "$R"
printf '  %s│%s  %s%-42s%s%s│%s\n' "$GREEN" "$R" "$CYAN$B" "$URL" "$R" "$GREEN" "$R"
printf '  %s╰────────────────────────────────────────────╯%s\n\n' "$GREEN" "$R"
printf '  %s!%s Do that now: until a password is set, anyone on your network\n    who opens the page can set one.\n' "$ORANGE" "$R"
printf '  %s!%s The address comes from DHCP. Reserve it in your router so it\n    stays the same.\n\n' "$ORANGE" "$R"
row "Container" "$CTID \"$CT_NAME\"   ${DIM}console: pct enter $CTID${R}"
row "Files"     "$([ -n "$FILES" ] && echo 'on' || echo 'off, turn it on under Manage → Files')"
printf '\n'
