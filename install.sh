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
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/nikolajalbrechtsen/proxmox-appstore.git}"
CT_NAME="${CT_NAME:-appstore}"
BRIDGE="${BRIDGE:-vmbr0}"
ROLE_PRIVS="VM.Allocate,VM.Audit,VM.PowerMgmt,VM.Config.Disk,VM.Config.CPU,VM.Config.Memory,VM.Config.Network,VM.Config.Options,VM.GuestAgent.Audit,Datastore.AllocateSpace,Datastore.AllocateTemplate,Datastore.Audit,Sys.Audit,Sys.AccessNetwork,SDN.Use"

step() { printf '\n\033[1;33m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { local a; read -r -p "$1 " a </dev/tty || a=""; printf '%s' "$a"; }

CREATED=""
trap 'code=$?; if [ "$code" -ne 0 ] && [ -n "$CREATED" ]; then printf "\nThe install stopped before it finished. Container %s was created; remove it with:\n  pct stop %s; pct destroy %s\n" "$CTID" "$CTID" "$CTID" >&2; fi' EXIT

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

cat <<EOF

Proxmox App Store installer

This will:
  - create container $CTID "$CT_NAME" (Debian 13, 1 core, 512 MB memory, 4 GB disk on $STORAGE, DHCP on $BRIDGE)
  - install the App Store in it from $REPO_URL
  - create the Proxmox user appstore@pve with a limited role and an API token for the App Store

EOF
case "$(ask 'Continue? [Y/n]')" in n*|N*) echo "Nothing was changed."; exit 0 ;; esac
FILES="$(ask 'Also set up the file browser? It lets the App Store read and change files inside your running containers. [y/N]')"

# ---------- container ----------
step "Getting the Debian 13 template"
pveam update >/dev/null || true
TMPL="$(pveam available --section system | awk '{print $2}' | grep '^debian-13-standard' | sort -V | tail -n1)"
[ -n "$TMPL" ] || die "The Debian 13 template is not in Proxmox's template list. Check the host's internet connection."
pveam list "$TMPL_STORAGE" 2>/dev/null | grep -q "$TMPL" || pveam download "$TMPL_STORAGE" "$TMPL"

step "Creating container $CTID"
pct create "$CTID" "$TMPL_STORAGE:vztmpl/$TMPL" --hostname "$CT_NAME" --cores 1 --memory 512 --swap 0 \
  --rootfs "$STORAGE:4" --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" --unprivileged 1 --onboot 1 --tags appstore
CREATED=1
pct start "$CTID"

step "Waiting for the container's network"
CT_IP=""
for _ in $(seq 1 45); do
  CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$CT_IP" ] && pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  CT_IP=""; sleep 2
done
[ -n "$CT_IP" ] || die "The container got no working network within 90 seconds. Is there a DHCP server on $BRIDGE?"

step "Installing the App Store in the container"
pct exec "$CTID" -- env DEBIAN_FRONTEND=noninteractive REPO_URL="$REPO_URL" bash -c '
  set -e
  apt-get -qq update
  apt-get -qq install -y nodejs git ca-certificates openssh-client >/dev/null
  git clone -q "$REPO_URL" /opt/appstore
  useradd -r -s /usr/sbin/nologin appstore
  mkdir -p /var/lib/appstore && chown appstore: /var/lib/appstore && chmod 700 /var/lib/appstore
  cp /opt/appstore/appstore.service /etc/systemd/system/
  # Lets the Update button in the App Store install new versions.
  cp /opt/appstore/autoupdate/appstore-update /usr/local/bin/ && chmod +x /usr/local/bin/appstore-update
  cp /opt/appstore/autoupdate/appstore-update.service /opt/appstore/autoupdate/appstore-update.path /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable -q appstore-update.path
'

# ---------- API token ----------
step "Creating the API token"
pveum role add AppStore -privs "$ROLE_PRIVS" 2>/dev/null || pveum role modify AppStore -privs "$ROLE_PRIVS"
pveum user add appstore@pve 2>/dev/null || true
pveum acl modify / -user appstore@pve -role AppStore
TOKEN_NAME="ct$CTID"   # one token per install, so a second App Store does not break the first
pveum user token remove appstore@pve "$TOKEN_NAME" >/dev/null 2>&1 || true
SECRET="$(pveum user token add appstore@pve "$TOKEN_NAME" --privsep 0 --output-format json | sed -n 's/.*"value" *: *"\([^"]*\)".*/\1/p')"
[ -n "$SECRET" ] || die "The API token could not be created."

# Hand the connection details to the App Store, so its setup page only asks for a password.
PRESEED="$(mktemp)"; chmod 600 "$PRESEED"
printf '{"host":"%s","tokenId":"appstore@pve!%s","secret":"%s"}\n' "$HOST_IP" "$TOKEN_NAME" "$SECRET" > "$PRESEED"
pct push "$CTID" "$PRESEED" /var/lib/appstore/preseed.json --user appstore --group appstore --perms 600
rm -f "$PRESEED"

# ---------- file browser (optional) ----------
case "$FILES" in y*|Y*)
  step "Setting up the file browser"
  pct exec "$CTID" -- su -s /bin/sh appstore -c "ssh-keygen -q -t ed25519 -N '' -C appstore-files -f /var/lib/appstore/files_key"
  PUB="$(pct exec "$CTID" -- cat /var/lib/appstore/files_key.pub)"
  pct pull "$CTID" /opt/appstore/host/appstore-files /usr/local/bin/appstore-files
  chmod 755 /usr/local/bin/appstore-files
  mkdir -p /root/.ssh
  grep -qF "$(printf '%s' "$PUB" | awk '{print $2}')" /root/.ssh/authorized_keys 2>/dev/null \
    || echo "command=\"/usr/local/bin/appstore-files\",restrict $PUB" >> /root/.ssh/authorized_keys
  ;;
esac

step "Starting the App Store"
pct exec "$CTID" -- systemctl enable -q --now appstore
CREATED=""

cat <<EOF

Done. Open the App Store in your browser and choose a password:

    http://$CT_IP

Do that now: until a password is set, anyone on your network who opens the page can set one.
The address comes from DHCP. Reserve it in your router so it stays the same.

EOF
