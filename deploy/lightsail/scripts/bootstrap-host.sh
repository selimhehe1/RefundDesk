#!/usr/bin/env bash

# Dedicated-host assumptions:
# - Ubuntu Server 24.04 on a Lightsail micro (1 GiB RAM, 40 GiB disk).
# - This is a fresh RefundDesk-only host; Docker daemon logging policy may be set.
# - Public ingress is 80/443. SSH is restricted to one explicit CIDR or the
#   current SSH client address. No secret is accepted by this script or user-data.
# - Application files live under /opt/refunddesk and root-only configuration
#   lives under /etc/refunddesk.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

SSH_CIDR=""
INSTALL_UNITS=true

usage() {
  cat <<'EOF'
Usage: sudo bash bootstrap-host.sh [--ssh-cidr ADDRESS/CIDR] [--no-systemd-units]

The SSH CIDR defaults to the current SSH_CONNECTION client as a /32 or /128.
This script never accepts application secrets and is safe to keep in source control.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --ssh-cidr)
      (( $# >= 2 )) || die "--ssh-cidr requires a value"
      SSH_CIDR="$2"
      shift 2
      ;;
    --no-systemd-units)
      INSTALL_UNITS=false
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

require_root

[[ -r /etc/os-release ]] || die "/etc/os-release is missing"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] ||
  die "bootstrap-host.sh supports Ubuntu 24.04 only"

if [[ -z "${SSH_CIDR}" ]]; then
  [[ -n "${SSH_CONNECTION:-}" ]] ||
    die "--ssh-cidr is required when SSH_CONNECTION is unavailable"
  SSH_CIDR="${SSH_CONNECTION%% *}"
  if [[ "${SSH_CIDR}" == *:* ]]; then
    SSH_CIDR="${SSH_CIDR}/128"
  else
    SSH_CIDR="${SSH_CIDR}/32"
  fi
fi

python3 - "${SSH_CIDR}" <<'PY' || die "invalid SSH CIDR"
import ipaddress
import sys

ipaddress.ip_network(sys.argv[1], strict=False)
PY

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends \
  age \
  awscli \
  ca-certificates \
  curl \
  docker-compose-v2 \
  docker.io \
  git \
  jq \
  logrotate \
  python3-minimal \
  ufw \
  zstd
apt-get clean
rm -rf /var/lib/apt/lists/*

systemctl enable --now docker.service
docker compose version >/dev/null
age --version >/dev/null
zstd --version >/dev/null
aws --version >/dev/null

install -d -o root -g root -m 0755 \
  "${REFUNDDESK_ROOT}" \
  "${REFUNDDESK_ROOT}/incoming" \
  "${REFUNDDESK_ROOT}/releases"
install -d -o root -g root -m 0700 \
  "${REFUNDDESK_CONFIG_ROOT}" \
  "${REFUNDDESK_CONFIG_ROOT}/aws" \
  "${REFUNDDESK_CONFIG_ROOT}/secrets" \
  /var/lib/refunddesk/backups
install -d -o root -g root -m 0755 "${REFUNDDESK_CONFIG_ROOT}/tls"
install -d -o root -g 999 -m 2750 "${REFUNDDESK_CONFIG_ROOT}/tls/postgres"
install -d -o root -g 1000 -m 2750 "${REFUNDDESK_CONFIG_ROOT}/tls/verifier"
install -d -o root -g root -m 0755 "${REFUNDDESK_CONFIG_ROOT}/tls/client"
install -d -o 999 -g 999 -m 0700 /var/lib/refunddesk/postgres/data
install -d -o 1000 -g 1000 -m 0700 \
  /var/lib/refunddesk/caddy-public/data \
  /var/lib/refunddesk/caddy-public/config
install -d -o root -g adm -m 0750 /var/log/refunddesk

if [[ ! -e /swapfile ]]; then
  log "creating the dedicated 2 GiB swapfile"
  if ! fallocate --length 2G /swapfile; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
  fi
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
else
  [[ -f /swapfile && ! -L /swapfile ]] || die "/swapfile is not a regular file"
  swap_bytes="$(stat --format='%s' /swapfile)"
  (( swap_bytes >= 2147483648 )) || die "existing /swapfile is smaller than 2 GiB"
  chmod 0600 /swapfile
fi

if ! swapon --show=NAME --noheadings | grep -Fxq '/swapfile'; then
  swapon /swapfile
fi
if ! grep -Eq '^[[:space:]]*/swapfile[[:space:]]+none[[:space:]]+swap([[:space:]]|$)' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
fi

cat >/etc/sysctl.d/60-refunddesk-memory.conf <<'EOF'
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
sysctl --system >/dev/null

daemon_file=/etc/docker/daemon.json
daemon_tmp="$(mktemp)"
trap 'rm -f -- "${daemon_tmp:-}"' EXIT
if [[ -e "${daemon_file}" ]]; then
  assert_regular_file "${daemon_file}"
  jq --exit-status 'type == "object"' "${daemon_file}" >/dev/null ||
    die "existing Docker daemon configuration is not a JSON object"
  existing_driver="$(jq --raw-output '."log-driver" // "local"' "${daemon_file}")"
  [[ "${existing_driver}" == "local" ]] ||
    die "existing Docker log driver is not local; refusing to overwrite it"
  jq \
    '."log-driver" = "local"
     | ."log-opts" = ((."log-opts" // {}) + {"max-size":"10m","max-file":"3"})' \
    "${daemon_file}" >"${daemon_tmp}"
else
  jq --null-input \
    '{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}' \
    >"${daemon_tmp}"
fi
install -o root -g root -m 0644 "${daemon_tmp}" "${daemon_file}"
systemctl restart docker.service

install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/refunddesk.conf <<'EOF'
[Journal]
SystemMaxUse=200M
SystemKeepFree=1G
MaxRetentionSec=7day
Compress=yes
EOF
systemctl restart systemd-journald.service

cat >/etc/logrotate.d/refunddesk-operator <<'EOF'
/var/log/refunddesk/*.log {
    daily
    rotate 14
    size 10M
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root adm
}
EOF

ufw default deny incoming
ufw default allow outgoing
ufw default deny routed
ufw allow proto tcp from "${SSH_CIDR}" to any port 22 comment 'RefundDesk operator SSH'
ufw allow 80/tcp comment 'RefundDesk HTTP ACME'
ufw allow 443/tcp comment 'RefundDesk HTTPS'
ufw --force enable

if [[ "${INSTALL_UNITS}" == "true" ]]; then
  SYSTEMD_SOURCE="${SCRIPT_DIR}/../systemd"
  if [[ -d "${SYSTEMD_SOURCE}" ]]; then
    install -o root -g root -m 0644 \
      "${SYSTEMD_SOURCE}/refunddesk-backup.service" \
      /etc/systemd/system/refunddesk-backup.service
    install -o root -g root -m 0644 \
      "${SYSTEMD_SOURCE}/refunddesk-backup.timer" \
      /etc/systemd/system/refunddesk-backup.timer
    systemctl daemon-reload
    log "backup units installed but not enabled; configure /etc/refunddesk/backup.env first"
  fi
fi

log "host bootstrap complete; public 80/443 and SSH from ${SSH_CIDR} are allowed"
