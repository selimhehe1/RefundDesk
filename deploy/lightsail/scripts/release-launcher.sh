#!/usr/bin/env bash

# Stable, host-owned entrypoint for every RefundDesk sandbox release. The
# launcher lives outside /opt/refunddesk/current so a target revision cannot
# select its own release policy.

set -Eeuo pipefail
umask 077

readonly REFUNDDESK_ROOT="${REFUNDDESK_ROOT:-/opt/refunddesk}"
readonly REFUNDDESK_CONFIG_ROOT="${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}"
readonly REFUNDDESK_CONTROL_ROOT="${REFUNDDESK_CONTROL_ROOT:-/var/lib/refunddesk/control}"
readonly STABLE_LAUNCHER_PATH="/usr/local/sbin/refunddesk-release"
readonly CONTROL_PLANE_LINK="${REFUNDDESK_ROOT}/control-plane-current"
readonly EXPECTED_LAUNCHER_LINK="${CONTROL_PLANE_LINK}/scripts/release-launcher.sh"
readonly RELEASE_CONTRACT_VERSION="2"
readonly TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
readonly QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"
readonly RECOVERY_LAUNCHER="/usr/local/sbin/refunddesk-quiesce-recovery"
readonly COMPOSE_PROJECT="refunddesk"

log() {
  printf '%s %s\n' "$(date --utc '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

assert_root_control_file() {
  local path="$1"
  local mode owner

  [[ -f "${path}" && ! -L "${path}" ]] ||
    die "expected a regular non-symlink control file: ${path}"
  owner="$(stat --format='%u' -- "${path}")"
  mode="$(stat --format='%a' -- "${path}")"
  [[ "${owner}" == "0" ]] || die "control file must be owned by root: ${path}"
  (( (8#${mode} & 022) == 0 )) ||
    die "control file must not be group/world writable: ${path}"
}

assert_root_secret_file() {
  local path="$1"
  local mode

  assert_root_control_file "${path}"
  mode="$(stat --format='%a' -- "${path}")"
  (( (8#${mode} & 077) == 0 )) ||
    die "secret file must not grant group/world access: ${path}"
}

assert_stable_self() {
  local control_plane_root resolved_self

  [[ "$0" == "${STABLE_LAUNCHER_PATH}" ]] ||
    die "releases must run through ${STABLE_LAUNCHER_PATH}"
  if [[ -f "${STABLE_LAUNCHER_PATH}" && ! -L "${STABLE_LAUNCHER_PATH}" ]]; then
    assert_root_control_file "${STABLE_LAUNCHER_PATH}"
    if [[ ! -e "${CONTROL_PLANE_LINK}" && ! -L "${CONTROL_PLANE_LINK}" ]]; then
      return 0
    fi
    control_plane_root="$(readlink --canonicalize-existing -- "${CONTROL_PLANE_LINK}")" ||
      die "legacy control-plane generation cannot be resolved"
    cmp --silent \
      "${STABLE_LAUNCHER_PATH}" "${control_plane_root}/scripts/release-launcher.sh" ||
      die "legacy release launcher differs from its migration generation"
    return 0
  fi
  [[ -L "${STABLE_LAUNCHER_PATH}" &&
    "$(stat --format='%u' -- "${STABLE_LAUNCHER_PATH}")" == "0" &&
    "$(readlink -- "${STABLE_LAUNCHER_PATH}")" == "${EXPECTED_LAUNCHER_LINK}" ]] ||
    die "stable release launcher is not the exact root-owned generation symlink"
  [[ -L "${CONTROL_PLANE_LINK}" &&
    "$(stat --format='%u' -- "${CONTROL_PLANE_LINK}")" == "0" ]] ||
    die "control-plane generation pointer is not a root-owned symlink"
  control_plane_root="$(readlink --canonicalize-existing -- "${CONTROL_PLANE_LINK}")" ||
    die "control-plane generation cannot be resolved"
  case "${control_plane_root}" in
    "${REFUNDDESK_ROOT}"/releases/*/source/deploy/lightsail | \
      "${REFUNDDESK_ROOT}"/control-plane-generations/*)
      ;;
    *)
      die "control-plane generation escaped its root-controlled namespace"
      ;;
  esac
  resolved_self="$(readlink --canonicalize-existing -- "${STABLE_LAUNCHER_PATH}")" ||
    die "stable release launcher cannot be resolved"
  [[ "${resolved_self}" == "${control_plane_root}/scripts/release-launcher.sh" ]] ||
    die "stable release launcher escaped the active generation"
  assert_root_control_file "${resolved_self}"
}

usage() {
  cat <<'EOF'
Usage: sudo refunddesk-release --artifact-dir DIR --revision FULL_SHA --expected-sha256 SHA256 [--origin HTTPS_ORIGIN]

The revision is mandatory because this stable launcher validates the immutable
target source and its release contract before any target-owned script runs.
EOF
}

if (( $# == 1 )) && [[ "$1" == "--help" || "$1" == "-h" ]]; then
  usage
  exit 0
fi

[[ "${EUID}" -eq 0 ]] || die "this command must run as root"
for command in bash cmp jq readlink stat systemd-run; do
  command -v "${command}" >/dev/null 2>&1 ||
    die "required command is unavailable: ${command}"
done
[[ "${REFUNDDESK_ROOT}" == "/opt/refunddesk" ]] ||
  die "stable releases require REFUNDDESK_ROOT=/opt/refunddesk"
[[ "${REFUNDDESK_CONFIG_ROOT}" == "/etc/refunddesk" ]] ||
  die "stable releases require REFUNDDESK_CONFIG_ROOT=/etc/refunddesk"
[[ "${REFUNDDESK_CONTROL_ROOT}" == "/var/lib/refunddesk/control" ]] ||
  die "stable releases require REFUNDDESK_CONTROL_ROOT=/var/lib/refunddesk/control"
[[ "${REFUNDDESK_COMPOSE_PROJECT:-${COMPOSE_PROJECT}}" == "${COMPOSE_PROJECT}" ]] ||
  die "stable releases require the refunddesk Compose project"
expected_release_environment="${REFUNDDESK_CONFIG_ROOT}/release.env"
[[ "${REFUNDDESK_RELEASE_ENV:-${expected_release_environment}}" == \
  "${expected_release_environment}" ]] ||
  die "stable releases require the canonical release environment"
expected_operator_lock="/run/refunddesk/operator.lock"
[[ "${REFUNDDESK_OPERATOR_LOCK:-${expected_operator_lock}}" == "${expected_operator_lock}" ]] ||
  die "stable releases require the canonical operator lock"

assert_stable_self
if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]; then
  if [[ -L "${RECOVERY_LAUNCHER}" ]]; then
    [[ "$(stat --format='%u' -- "${RECOVERY_LAUNCHER}")" == "0" &&
      "$(readlink -- "${RECOVERY_LAUNCHER}")" == \
        "${CONTROL_PLANE_LINK}/scripts/quiesce-recovery-launcher.sh" ]] ||
      die "runtime recovery launcher is not the exact generation symlink"
  else
    [[ ! -e "${CONTROL_PLANE_LINK}" && ! -L "${CONTROL_PLANE_LINK}" ]] ||
      die "legacy runtime recovery launcher remained after generation activation"
    assert_root_control_file "${RECOVERY_LAUNCHER}"
  fi
  "${RECOVERY_LAUNCHER}" ||
    die "unfinished runtime quiescence could not be recovered before release"
fi
[[ ! -e "${QUIESCE_JOURNAL}" && ! -L "${QUIESCE_JOURNAL}" ]] ||
  die "runtime quiescence remained after release preflight recovery"

revision=""
revision_count=0
artifact_directory_count=0
expected_sha256_count=0
origin_count=0
arguments=("$@")
while (( $# > 0 )); do
  case "$1" in
    --revision)
      (( $# >= 2 )) || die "--revision requires a value"
      revision="$2"
      revision_count=$((revision_count + 1))
      shift 2
      ;;
    --artifact-dir)
      (( $# >= 2 )) || die "$1 requires a value"
      artifact_directory_count=$((artifact_directory_count + 1))
      shift 2
      ;;
    --expected-sha256)
      (( $# >= 2 )) || die "$1 requires a value"
      expected_sha256_count=$((expected_sha256_count + 1))
      shift 2
      ;;
    --origin)
      (( $# >= 2 )) || die "$1 requires a value"
      origin_count=$((origin_count + 1))
      shift 2
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

(( revision_count == 1 )) || die "exactly one --revision argument is required"
(( artifact_directory_count == 1 )) || die "exactly one --artifact-dir argument is required"
(( expected_sha256_count == 1 )) || die "exactly one --expected-sha256 argument is required"
(( origin_count <= 1 )) || die "at most one --origin argument is accepted"
[[ "${revision}" =~ ^[0-9a-f]{40}$ ]] ||
  die "revision must be a full lowercase 40-hex Git SHA"

expected_source="${REFUNDDESK_ROOT}/releases/${revision}/source"
[[ -d "${expected_source}" && ! -L "${expected_source}" ]] ||
  die "target source is not an installed non-symlink directory"
source_root="$(readlink --canonicalize-existing -- "${expected_source}")"
[[ "${source_root}" == "${expected_source}" ]] ||
  die "target source escaped its revision-scoped directory"

revision_marker="${source_root}/.refunddesk-revision"
contract_marker="${source_root}/deploy/lightsail/RELEASE_CONTRACT_VERSION"
release_script="${source_root}/deploy/lightsail/scripts/release.sh"
assert_root_secret_file "${revision_marker}"
assert_root_control_file "${contract_marker}"
assert_root_control_file "${release_script}"

mapfile -t revision_lines <"${revision_marker}"
(( ${#revision_lines[@]} == 1 )) && [[ "${revision_lines[0]}" == "${revision}" ]] ||
  die "target source revision marker differs from the requested revision"
mapfile -t contract_lines <"${contract_marker}"
(( ${#contract_lines[@]} == 1 )) &&
  [[ "${contract_lines[0]}" == "${RELEASE_CONTRACT_VERSION}" ]] ||
  die "target source does not implement release contract ${RELEASE_CONTRACT_VERSION}"

if [[ -e "${TRANSITION_JOURNAL}" || -L "${TRANSITION_JOURNAL}" ]]; then
  assert_root_secret_file "${TRANSITION_JOURNAL}"
  jq --exit-status --arg revision "${revision}" '
    type == "object"
    and .schemaVersion == 1
    and .status == "in_progress"
    and .to.revision == $revision
  ' "${TRANSITION_JOURNAL}" >/dev/null ||
    die "an unfinished release transition permits only its exact target revision"
fi

release_unit="refunddesk-release-${revision:0:12}-$$.service"
exec systemd-run \
  --quiet \
  --wait \
  --pipe \
  --collect \
  --unit="${release_unit}" \
  --property=Type=exec \
  --property=KillMode=control-group \
  --property=Restart=no \
  --property=TimeoutStopSec=5min \
  --setenv="REFUNDDESK_ROOT=${REFUNDDESK_ROOT}" \
  --setenv="REFUNDDESK_CONFIG_ROOT=${REFUNDDESK_CONFIG_ROOT}" \
  --setenv="REFUNDDESK_COMPOSE_PROJECT=${COMPOSE_PROJECT}" \
  --setenv="REFUNDDESK_RELEASE_LAUNCHER_CONTRACT=${RELEASE_CONTRACT_VERSION}" \
  --setenv="REFUNDDESK_RELEASE_LAUNCHER_PATH=${STABLE_LAUNCHER_PATH}" \
  --setenv="REFUNDDESK_RELEASE_SYSTEMD_UNIT=${release_unit}" \
  -- \
  /usr/bin/bash "${release_script}" "${arguments[@]}"
