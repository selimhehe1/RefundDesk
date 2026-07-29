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

readonly AWS_CLI_VERSION="2.36.9"
readonly AWS_CLI_SIGNING_KEY_FINGERPRINT="FB5DB77FD5C118B80511ADA8A6310ACC4672475C"
readonly AWS_CLI_X86_64_SHA256="9b92ccb50dfc55479ac14c4ba1bb36f603a1cbfb004b50e4a50b1592ffad3da0"

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
acquire_operator_lock
BOOTSTRAP_TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
BOOTSTRAP_QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"
[[ ! -e "${BOOTSTRAP_TRANSITION_JOURNAL}" && ! -L "${BOOTSTRAP_TRANSITION_JOURNAL}" ]] ||
  die "host bootstrap is blocked while a release transition is unfinished"
[[ ! -e "${BOOTSTRAP_QUIESCE_JOURNAL}" && ! -L "${BOOTSTRAP_QUIESCE_JOURNAL}" ]] ||
  die "host bootstrap is blocked until runtime quiescence is recovered"

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

install_aws_cli_v2() (
  local archive download_url existing_aws gpg_home
  local imported_fingerprint installed_version installer signature signature_status work_directory
  local -a curl_arguments

  if [[ -x /usr/local/bin/aws ]]; then
    installed_version="$(/usr/local/bin/aws --version 2>&1)" ||
      die "refusing to replace an AWS CLI installation that cannot report its version"
    if [[ "${installed_version}" == "aws-cli/${AWS_CLI_VERSION} "* ]]; then
      log "AWS CLI v${AWS_CLI_VERSION} is already installed"
      return 0
    fi
    die "refusing to replace an unexpected AWS CLI version at /usr/local/bin/aws"
  fi
  if existing_aws="$(command -v aws 2>/dev/null)"; then
    die "refusing to replace AWS CLI installation at ${existing_aws}"
  fi
  if [[ -e /usr/local/bin/aws || -L /usr/local/bin/aws || -e /usr/local/aws-cli ]]; then
    die "refusing to overwrite incomplete AWS CLI installation paths"
  fi

  [[ "$(uname --machine)" == "x86_64" ]] ||
    die "RefundDesk sandbox images and AWS CLI require x86_64"

  work_directory="$(mktemp --directory /tmp/refunddesk-aws-cli.XXXXXX)"
  trap 'rm -rf -- "${work_directory}"' EXIT
  archive="${work_directory}/awscliv2.zip"
  signature="${archive}.sig"
  signature_status="${work_directory}/signature.status"
  gpg_home="${work_directory}/gnupg"
  download_url="https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip"
  curl_arguments=(
    --fail
    --silent
    --show-error
    --location
    --proto '=https'
    --proto-redir '=https'
    --connect-timeout 15
    --max-time 600
    --retry 3
    --retry-all-errors
  )

  log "downloading AWS CLI v${AWS_CLI_VERSION} for x86_64"
  curl "${curl_arguments[@]}" --output "${archive}" "${download_url}"
  curl "${curl_arguments[@]}" --output "${signature}" "${download_url}.sig"
  printf '%s  %s\n' "${AWS_CLI_X86_64_SHA256}" "${archive}" |
    sha256sum --check --strict --status ||
    die "AWS CLI archive SHA-256 verification failed"

  install -d -o root -g root -m 0700 "${gpg_home}"
  cat >"${work_directory}/aws-cli-public-key.asc" <<'EOF'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBF2Cr7UBEADJZHcgusOJl7ENSyumXh85z0TRV0xJorM2B/JL0kHOyigQluUG
ZMLhENaG0bYatdrKP+3H91lvK050pXwnO/R7fB/FSTouki4ciIx5OuLlnJZIxSzx
PqGl0mkxImLNbGWoi6Lto0LYxqHN2iQtzlwTVmq9733zd3XfcXrZ3+LblHAgEt5G
TfNxEKJ8soPLyWmwDH6HWCnjZ/aIQRBTIQ05uVeEoYxSh6wOai7ss/KveoSNBbYz
gbdzoqI2Y8cgH2nbfgp3DSasaLZEdCSsIsK1u05CinE7k2qZ7KgKAUIcT/cR/grk
C6VwsnDU0OUCideXcQ8WeHutqvgZH1JgKDbznoIzeQHJD238GEu+eKhRHcz8/jeG
94zkcgJOz3KbZGYMiTh277Fvj9zzvZsbMBCedV1BTg3TqgvdX4bdkhf5cH+7NtWO
lrFj6UwAsGukBTAOxC0l/dnSmZhJ7Z1KmEWilro/gOrjtOxqRQutlIqG22TaqoPG
fYVN+en3Zwbt97kcgZDwqbuykNt64oZWc4XKCa3mprEGC3IbJTBFqglXmZ7l9ywG
EEUJYOlb2XrSuPWml39beWdKM8kzr1OjnlOm6+lpTRCBfo0wa9F8YZRhHPAkwKkX
XDeOGpWRj4ohOx0d2GWkyV5xyN14p2tQOCdOODmz80yUTgRpPVQUtOEhXQARAQAB
tCFBV1MgQ0xJIFRlYW0gPGF3cy1jbGlAYW1hem9uLmNvbT6JAlQEEwEIAD4CGwMF
CwkIBwIGFQoJCAsCBBYCAwECHgECF4AWIQT7Xbd/1cEYuAURraimMQrMRnJHXAUC
akV0ygUJDqP4lQAKCRCmMQrMRnJHXFHjD/9eyZLYcKuQOlLvtqSDtUBiEZf6ZZjM
i3ygYH8rJNtuToUH+HvSpe819urJCquXhDrlK6N+aqW0hCLtNABJG/vsafIgvIYJ
hSGgpgtNnQyMV1jViRWqPjbouw8OkYKBThUfT1i2Y+wn58ifs6ODBCmTexWtXspA
Si+Gt49xDOW0APmbOPnI+a4HJW6tVEo6MWS0WjzpiBayR3d1A4pt4YrPfSdDgpLo
h2SLQqlRqvvVZJaWBjhkErNFpfsBA06sDcPEOb0G8LBUbR4WOcdvhe5LubJbZuxC
AG9kNPCVeQP1ixwjgjXKysaxeQ6rv0VzIQgRp6tLVLWhy6AKDNvLjFSsmXZ1Wl08
Y/RlOHXlzLuQMRE6sR1wOdRxc9TsrNWTGiBK65cvSWOy03JeBkQQ8pesqltiyxI9
U21kkgiXtTSKNGfKK8pO27D81YANhRqPK7iTp6kuFiY2WtOg90KTMNlIT+Ff85Y2
b1rHj6Z0SrCkJujhWk3IBPic/wJgz01LEc/OAdUPlby90RJZcIBhSlWhT7mXnXIO
c0HWlNQrns2s3CTyYwZSiSlYe9ApeLwhjDo8NhbFuCAy61l6O5UsR4AfZxx/rGKv
2wFb1/RN/P4gNe6vmxZAPjR0AQcwD3tc2McimOLr/22kmPz8IH3I0X7WoSFr0Biz
E91G7bb0hOb/cA==
=knv7
-----END PGP PUBLIC KEY BLOCK-----
EOF

  gpg --batch --no-options --homedir "${gpg_home}" \
    --import "${work_directory}/aws-cli-public-key.asc" >/dev/null 2>&1 ||
    die "AWS CLI signing key import failed"
  imported_fingerprint="$(
    gpg --batch --no-options --homedir "${gpg_home}" --with-colons \
      --fingerprint "${AWS_CLI_SIGNING_KEY_FINGERPRINT}" |
      awk -F: '$1 == "fpr" { print $10 }'
  )"
  [[ "${imported_fingerprint}" == "${AWS_CLI_SIGNING_KEY_FINGERPRINT}" ]] ||
    die "AWS CLI signing key fingerprint mismatch"

  gpg --batch --no-options --no-auto-key-retrieve --homedir "${gpg_home}" \
    --status-fd 1 --verify "${signature}" "${archive}" \
    >"${signature_status}" 2>/dev/null ||
    die "AWS CLI archive signature verification failed"
  grep -Eq \
    "^\[GNUPG:\] VALIDSIG ${AWS_CLI_SIGNING_KEY_FINGERPRINT}([[:space:]]|$)" \
    "${signature_status}" ||
    die "AWS CLI archive was not signed by the pinned AWS CLI key"

  unzip -q "${archive}" -d "${work_directory}"
  installer="${work_directory}/aws/install"
  [[ -f "${installer}" && ! -L "${installer}" && -x "${installer}" ]] ||
    die "AWS CLI installer is not a regular executable file"

  "${installer}" \
    --bin-dir /usr/local/bin \
    --install-dir /usr/local/aws-cli \
    >/dev/null
  hash -r

  installed_version="$(/usr/local/bin/aws --version 2>&1)" ||
    die "AWS CLI installation cannot report its version"
  [[ "${installed_version}" == "aws-cli/${AWS_CLI_VERSION} "* ]] ||
    die "unexpected AWS CLI version after installation: ${installed_version}"
)

if [[ ! -e /swapfile ]]; then
  log "creating the dedicated 2304 MiB swapfile with headroom for 2 GiB usable swap"
  if ! fallocate --length 2304M /swapfile; then
    dd if=/dev/zero of=/swapfile bs=1M count=2304 status=progress
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

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends \
  age \
  ca-certificates \
  curl \
  docker-compose-v2 \
  docker.io \
  git \
  gnupg \
  jq \
  logrotate \
  python3-minimal \
  unzip \
  ufw \
  zstd
apt-get clean
rm -rf /var/lib/apt/lists/*

install_aws_cli_v2

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
  /var/lib/refunddesk/backups \
  /var/lib/refunddesk/control
install -d -o root -g root -m 0755 "${REFUNDDESK_CONFIG_ROOT}/tls"
install -d -o root -g 999 -m 2750 "${REFUNDDESK_CONFIG_ROOT}/tls/postgres"
install -d -o root -g 1000 -m 2750 "${REFUNDDESK_CONFIG_ROOT}/tls/verifier"
install -d -o root -g root -m 0755 "${REFUNDDESK_CONFIG_ROOT}/tls/client"
install -d -o 999 -g 999 -m 0700 /var/lib/refunddesk/postgres/data
install -d -o 1000 -g 1000 -m 0700 \
  /var/lib/refunddesk/caddy-public/data \
  /var/lib/refunddesk/caddy-public/config
install -d -o root -g adm -m 0750 /var/log/refunddesk

RELEASE_CONTRACT_MARKER="${SCRIPT_DIR}/../RELEASE_CONTRACT_VERSION"
assert_root_control_file "${RELEASE_CONTRACT_MARKER}"
mapfile -t release_contract_lines <"${RELEASE_CONTRACT_MARKER}"
(( ${#release_contract_lines[@]} == 1 )) &&
  [[ "${release_contract_lines[0]}" == "2" ]] ||
  die "bootstrap source does not implement release contract 2"
for stable_launcher in \
  "${SCRIPT_DIR}/release-launcher.sh" \
  "${SCRIPT_DIR}/release-fence.sh" \
  "${SCRIPT_DIR}/backup-launcher.sh" \
  "${SCRIPT_DIR}/retention-launcher.sh" \
  "${SCRIPT_DIR}/quiesce-recovery-launcher.sh"; do
  assert_root_control_file "${stable_launcher}"
done
BOOTSTRAP_DURABILITY_HELPER="${SCRIPT_DIR}/release-transition-journal.py"
assert_root_control_file "${BOOTSTRAP_DURABILITY_HELPER}"
atomic_bootstrap_install() {
  local source_path="$1"
  local target_path="$2"
  local mode="$3"
  local expected_link relative_path temporary_path

  if [[ -L "${target_path}" ]]; then
    case "${target_path}" in
      /usr/local/sbin/*)
        relative_path="scripts/${source_path##*/}"
        ;;
      /etc/systemd/system/*)
        relative_path="systemd/${source_path##*/}"
        ;;
      *)
        die "bootstrap refuses an unrecognized generated control-plane path"
        ;;
    esac
    expected_link="${REFUNDDESK_CONTROL_PLANE_LINK}/${relative_path}"
    assert_root_control_symlink "${target_path}" "${expected_link}"
    cmp --silent "${source_path}" "${target_path}" ||
      die "bootstrap source differs from the active control-plane generation: ${target_path}"
    return 0
  fi

  temporary_path="$(mktemp "$(dirname -- "${target_path}")/.${target_path##*/}.XXXXXX")"
  if ! install -o root -g root -m "${mode}" "${source_path}" "${temporary_path}"; then
    rm -f -- "${temporary_path}"
    die "bootstrap control-plane staging failed: ${target_path}"
  fi
  if ! python3 "${BOOTSTRAP_DURABILITY_HELPER}" durable-replace \
    --source "${temporary_path}" \
    --target "${target_path}" \
    --mode "${mode}" >/dev/null; then
    rm -f -- "${temporary_path}"
    die "bootstrap control-plane activation failed: ${target_path}"
  fi
  cmp --silent "${source_path}" "${target_path}" ||
    die "bootstrap control-plane bytes differ after activation: ${target_path}"
}

bootstrap_systemd_unit_property() {
  local property="$1"
  local unit="$2"
  local value

  value="$(systemctl show "${unit}" --property="${property}" --value)" ||
    die "systemd property ${property} is unavailable for ${unit}"
  [[ -n "${value}" && "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] ||
    die "systemd property ${property} has an invalid shape for ${unit}"
  printf '%s\n' "${value}"
}

bootstrap_ensure_systemd_wants_directory() {
  local wants_directory="$1"
  local directory_mode directory_parent
  local created=false

  directory_parent="$(dirname -- "${wants_directory}")"
  assert_safe_directory "${directory_parent}"
  if [[ ! -e "${wants_directory}" && ! -L "${wants_directory}" ]]; then
    install -d -o root -g root -m 0755 -- "${wants_directory}"
    created=true
    python3 "${BOOTSTRAP_DURABILITY_HELPER}" fsync-directory \
      --path "${wants_directory}" >/dev/null &&
      python3 "${BOOTSTRAP_DURABILITY_HELPER}" fsync-directory \
        --path "${directory_parent}" >/dev/null ||
      die "new systemd wants directory could not be synchronized"
  fi

  assert_safe_directory "${wants_directory}"
  directory_mode="$(stat --format='%a' -- "${wants_directory}")"
  [[ "$(stat --format='%u:%g' -- "${wants_directory}")" == "0:0" &&
    "${directory_mode}" =~ ^[0-7]{3,4}$ ]] ||
    die "systemd wants directory ownership or mode is invalid: ${wants_directory}"
  (( (8#${directory_mode} & 8#022) == 0 )) ||
    die "systemd wants directory is writable outside root: ${wants_directory}"
  if [[ "${created}" == "true" ]]; then
    [[ "${directory_mode}" == "755" ]] ||
      die "new systemd wants directory does not have mode 0755: ${wants_directory}"
  fi
}

bootstrap_sync_systemd_wants() {
  local stable_unit="$1"
  local wants_path="$2"
  local desired_state="$3"
  local active_unit relative_path stable_target
  local -a stable_target_arguments=()

  if [[ -L "${stable_unit}" ]]; then
    relative_path="systemd/${stable_unit##*/}"
    stable_target="${REFUNDDESK_CONTROL_PLANE_LINK}/${relative_path}"
    assert_root_control_symlink "${stable_unit}" "${stable_target}"
    active_unit="$(readlink --canonicalize-existing -- "${stable_unit}")" ||
      die "stable systemd unit cannot be resolved: ${stable_unit}"
    stable_target_arguments=(--stable-target "${stable_target}")
  else
    assert_root_control_file "${stable_unit}"
    active_unit="$(readlink --canonicalize-existing -- "${stable_unit}")" ||
      die "bootstrap systemd unit cannot be resolved: ${stable_unit}"
    [[ "${active_unit}" == "${stable_unit}" ]] ||
      die "bootstrap systemd unit path is not canonical: ${stable_unit}"
  fi

  python3 "${BOOTSTRAP_DURABILITY_HELPER}" sync-systemd-wants \
    --wants "${wants_path}" \
    --stable-unit "${stable_unit}" \
    --active-unit "${active_unit}" \
    "${stable_target_arguments[@]}" \
    --control-root "${REFUNDDESK_ROOT}" \
    --state "${desired_state}" >/dev/null ||
    die "bootstrap systemd wants synchronization failed: ${wants_path}"
  if [[ "${desired_state}" == "present" ]]; then
    [[ -L "${wants_path}" &&
      "$(stat --format='%u' -- "${wants_path}")" == "0" &&
      "$(readlink -- "${wants_path}")" == "${stable_unit}" &&
      "$(readlink --canonicalize-existing -- "${wants_path}")" == \
      "${active_unit}" ]] ||
      die "bootstrap systemd wants activation is unproven: ${wants_path}"
  else
    [[ ! -e "${wants_path}" && ! -L "${wants_path}" ]] ||
      die "bootstrap systemd wants removal is unproven: ${wants_path}"
    [[ -e "${stable_unit}" || -L "${stable_unit}" ]] ||
      die "stable unit was removed with its wants entry: ${stable_unit}"
  fi
}

bootstrap_prove_systemd_fragment() {
  local stable_unit="$1"
  local relative_path
  local unit="${stable_unit##*/}"

  if [[ -L "${stable_unit}" ]]; then
    relative_path="systemd/${unit}"
    assert_root_control_symlink \
      "${stable_unit}" \
      "${REFUNDDESK_CONTROL_PLANE_LINK}/${relative_path}"
  else
    assert_root_control_file "${stable_unit}"
  fi
  [[ "$(stat --dereference --format='%u:%g:%a' -- "${stable_unit}")" == \
    "0:0:644" ]] ||
    die "systemd fragment ownership or mode differs: ${unit}"
  [[ "$(bootstrap_systemd_unit_property FragmentPath "${unit}")" == \
    "${stable_unit}" ]] ||
    die "systemd loaded an unexpected fragment path for ${unit}"
  [[ "$(bootstrap_systemd_unit_property NeedDaemonReload "${unit}")" == "no" ]] ||
    die "systemd still requires a daemon reload for ${unit}"
}

bootstrap_prove_systemd_unit_state() {
  local stable_unit="$1"
  local wants_path="$2"
  local wants_state="$3"
  local expected_active_state="$4"
  local expected_unit_file_state="$5"
  local unit="${stable_unit##*/}"

  bootstrap_prove_systemd_fragment "${stable_unit}"
  if [[ "${wants_state}" == "present" ]]; then
    [[ -L "${wants_path}" &&
      "$(stat --format='%u' -- "${wants_path}")" == "0" &&
      "$(readlink -- "${wants_path}")" == "${stable_unit}" &&
      "$(readlink --canonicalize-existing -- "${wants_path}")" == \
      "$(readlink --canonicalize-existing -- "${stable_unit}")" ]] ||
      die "active systemd wants mapping is unproven: ${wants_path}"
  else
    [[ ! -e "${wants_path}" && ! -L "${wants_path}" ]] ||
      die "inactive systemd wants mapping remained: ${wants_path}"
  fi
  [[ "$(bootstrap_systemd_unit_property ActiveState "${unit}")" == \
    "${expected_active_state}" ]] ||
    die "systemd active state differs for ${unit}"
  [[ "$(bootstrap_systemd_unit_property UnitFileState "${unit}")" == \
    "${expected_unit_file_state}" ]] ||
    die "systemd unit-file state differs for ${unit}"
}

atomic_bootstrap_install \
  "${SCRIPT_DIR}/release-launcher.sh" /usr/local/sbin/refunddesk-release 0755
atomic_bootstrap_install \
  "${SCRIPT_DIR}/release-fence.sh" /usr/local/sbin/refunddesk-release-fence 0755
atomic_bootstrap_install \
  "${SCRIPT_DIR}/backup-launcher.sh" /usr/local/sbin/refunddesk-backup 0755
atomic_bootstrap_install \
  "${SCRIPT_DIR}/retention-launcher.sh" /usr/local/sbin/refunddesk-retention 0755
atomic_bootstrap_install \
  "${SCRIPT_DIR}/quiesce-recovery-launcher.sh" \
  /usr/local/sbin/refunddesk-quiesce-recovery 0755

daemon_file=/etc/docker/daemon.json
daemon_tmp="$(mktemp)"
trap 'rm -f -- "${daemon_tmp:-}"' EXIT
if [[ -e "${daemon_file}" ]]; then
  assert_regular_file "${daemon_file}"
  jq --exit-status '
    type == "object"
    and ((."log-opts" // {}) | type == "object")
    and ((.features // {}) | type == "object")
  ' "${daemon_file}" >/dev/null ||
    die "existing Docker daemon configuration has incompatible types"
  existing_driver="$(jq --raw-output '."log-driver" // "local"' "${daemon_file}")"
  [[ "${existing_driver}" == "local" ]] ||
    die "existing Docker log driver is not local; refusing to overwrite it"
  jq \
    '."log-driver" = "local"
     | ."log-opts" = ((."log-opts" // {}) + {"max-size":"10m","max-file":"3"})
     | .features = ((.features // {}) + {"containerd-snapshotter":false})' \
    "${daemon_file}" >"${daemon_tmp}"
else
  jq --null-input \
    '{"features":{"containerd-snapshotter":false},"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}' \
    >"${daemon_tmp}"
fi

current_driver_status="$(docker info --format '{{json .DriverStatus}}')" ||
  die "Docker daemon information is unavailable"
if grep -Fq 'io.containerd.snapshotter.v1' <<<"${current_driver_status}"; then
  current_containers="$(docker ps --all --quiet)" ||
    die "Docker container inventory is unavailable"
  [[ -z "${current_containers}" ]] ||
    die "refusing to hide containers while switching Docker image stores"
  current_images="$(docker image ls --quiet)" ||
    die "Docker image inventory is unavailable"
  [[ -z "${current_images}" ]] ||
    die "refusing to hide images while switching Docker image stores"
fi

dockerd --validate --config-file="${daemon_tmp}" >/dev/null ||
  die "generated Docker daemon configuration is invalid"
install -o root -g root -m 0644 "${daemon_tmp}" "${daemon_file}"
systemctl restart docker.service
docker_driver="$(docker info --format '{{.Driver}}')" ||
  die "Docker daemon did not recover after restart"
[[ "${docker_driver}" == "overlay2" ]] ||
  die "Docker classic overlay2 image store is required for verified RefundDesk image IDs"
docker_driver_status="$(docker info --format '{{json .DriverStatus}}')" ||
  die "Docker driver status is unavailable after restart"
if grep -Fq 'io.containerd.snapshotter.v1' <<<"${docker_driver_status}"; then
  die "Docker containerd image store remained active after restart"
fi

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
    atomic_bootstrap_install \
      "${SYSTEMD_SOURCE}/refunddesk-backup.service" \
      /etc/systemd/system/refunddesk-backup.service 0644
    atomic_bootstrap_install \
      "${SYSTEMD_SOURCE}/refunddesk-backup.timer" \
      /etc/systemd/system/refunddesk-backup.timer 0644
    atomic_bootstrap_install \
      "${SYSTEMD_SOURCE}/refunddesk-retention.service" \
      /etc/systemd/system/refunddesk-retention.service 0644
    atomic_bootstrap_install \
      "${SYSTEMD_SOURCE}/refunddesk-retention.timer" \
      /etc/systemd/system/refunddesk-retention.timer 0644
    atomic_bootstrap_install \
      "${SYSTEMD_SOURCE}/refunddesk-quiesce-recovery.service" \
      /etc/systemd/system/refunddesk-quiesce-recovery.service 0644

    BOOTSTRAP_QUIESCE_UNIT=/etc/systemd/system/refunddesk-quiesce-recovery.service
    BOOTSTRAP_QUIESCE_WANTS=/etc/systemd/system/multi-user.target.wants/refunddesk-quiesce-recovery.service
    BOOTSTRAP_RETENTION_UNIT=/etc/systemd/system/refunddesk-retention.timer
    BOOTSTRAP_RETENTION_WANTS=/etc/systemd/system/timers.target.wants/refunddesk-retention.timer
    BOOTSTRAP_BACKUP_UNIT=/etc/systemd/system/refunddesk-backup.timer
    BOOTSTRAP_BACKUP_WANTS=/etc/systemd/system/timers.target.wants/refunddesk-backup.timer
    bootstrap_ensure_systemd_wants_directory \
      /etc/systemd/system/multi-user.target.wants
    bootstrap_ensure_systemd_wants_directory \
      /etc/systemd/system/timers.target.wants
    BOOTSTRAP_BACKUP_ENVIRONMENT="${REFUNDDESK_CONFIG_ROOT}/backup.env"
    BOOTSTRAP_BACKUP_AWS_CONFIG="${REFUNDDESK_CONFIG_ROOT}/aws/config"
    BOOTSTRAP_BACKUP_CONFIGURATION_VALID=false
    if [[ -e "${BOOTSTRAP_BACKUP_ENVIRONMENT}" ||
      -L "${BOOTSTRAP_BACKUP_ENVIRONMENT}" ]]; then
      python3 "${BOOTSTRAP_DURABILITY_HELPER}" validate-backup \
        --environment "${BOOTSTRAP_BACKUP_ENVIRONMENT}" \
        --aws-config "${BOOTSTRAP_BACKUP_AWS_CONFIG}" >/dev/null ||
        die "backup scheduling configuration is invalid"
      BOOTSTRAP_BACKUP_CONFIGURATION_VALID=true
    fi

    bootstrap_sync_systemd_wants \
      "${BOOTSTRAP_QUIESCE_UNIT}" "${BOOTSTRAP_QUIESCE_WANTS}" present
    bootstrap_sync_systemd_wants \
      "${BOOTSTRAP_RETENTION_UNIT}" "${BOOTSTRAP_RETENTION_WANTS}" present
    if [[ "${BOOTSTRAP_BACKUP_CONFIGURATION_VALID}" == "true" ]]; then
      bootstrap_sync_systemd_wants \
        "${BOOTSTRAP_BACKUP_UNIT}" "${BOOTSTRAP_BACKUP_WANTS}" present
    else
      BOOTSTRAP_BACKUP_LOAD_STATE="$(
        systemctl show refunddesk-backup.timer --property=LoadState --value 2>/dev/null ||
          true
      )"
      if [[ -n "${BOOTSTRAP_BACKUP_LOAD_STATE}" &&
        "${BOOTSTRAP_BACKUP_LOAD_STATE}" != "not-found" ]]; then
        systemctl stop refunddesk-backup.timer ||
          die "loaded unconfigured backup schedule could not be stopped"
      fi
      bootstrap_sync_systemd_wants \
        "${BOOTSTRAP_BACKUP_UNIT}" "${BOOTSTRAP_BACKUP_WANTS}" absent
    fi

    systemctl daemon-reload
    bootstrap_prove_systemd_fragment \
      /etc/systemd/system/refunddesk-backup.service
    bootstrap_prove_systemd_fragment \
      /etc/systemd/system/refunddesk-retention.service
    systemctl start refunddesk-retention.timer
    if [[ "${BOOTSTRAP_BACKUP_CONFIGURATION_VALID}" == "true" ]]; then
      systemctl start refunddesk-backup.timer
    else
      systemctl stop refunddesk-backup.timer
    fi

    bootstrap_prove_systemd_unit_state \
      "${BOOTSTRAP_QUIESCE_UNIT}" \
      "${BOOTSTRAP_QUIESCE_WANTS}" \
      present inactive enabled
    bootstrap_prove_systemd_unit_state \
      "${BOOTSTRAP_RETENTION_UNIT}" \
      "${BOOTSTRAP_RETENTION_WANTS}" \
      present active enabled
    if [[ "${BOOTSTRAP_BACKUP_CONFIGURATION_VALID}" == "true" ]]; then
      bootstrap_prove_systemd_unit_state \
        "${BOOTSTRAP_BACKUP_UNIT}" \
        "${BOOTSTRAP_BACKUP_WANTS}" \
        present active enabled
      log "valid backup schedule enabled and active"
    else
      if [[ -L "${BOOTSTRAP_BACKUP_UNIT}" ]]; then
        BOOTSTRAP_BACKUP_DISABLED_STATE=linked
      else
        BOOTSTRAP_BACKUP_DISABLED_STATE=disabled
      fi
      bootstrap_prove_systemd_unit_state \
        "${BOOTSTRAP_BACKUP_UNIT}" \
        "${BOOTSTRAP_BACKUP_WANTS}" \
        absent inactive "${BOOTSTRAP_BACKUP_DISABLED_STATE}"
      log "backup units installed but inactive until strict backup configuration exists"
    fi
    log "retention timer and runtime-quiescence boot recovery enabled"
  fi
fi

log "host bootstrap complete; public 80/443 and SSH from ${SSH_CIDR} are allowed"
