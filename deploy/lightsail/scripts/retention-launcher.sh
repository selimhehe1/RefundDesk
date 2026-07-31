#!/usr/bin/env bash

# Stable host-side entrypoint for the daily retention runner. It validates the
# active revision and contract before selecting any code beneath /current.

set -Eeuo pipefail
umask 077

readonly REFUNDDESK_ROOT="${REFUNDDESK_ROOT:-/opt/refunddesk}"
readonly REFUNDDESK_CONFIG_ROOT="${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}"
readonly REFUNDDESK_CONTROL_ROOT="${REFUNDDESK_CONTROL_ROOT:-/var/lib/refunddesk/control}"
readonly STABLE_LAUNCHER_PATH="/usr/local/sbin/refunddesk-retention"
readonly CONTROL_PLANE_LINK="${REFUNDDESK_ROOT}/control-plane-current"
readonly EXPECTED_LAUNCHER_LINK="${CONTROL_PLANE_LINK}/scripts/retention-launcher.sh"
readonly MINIMUM_RELEASE_CONTRACT_VERSION=2
readonly MAXIMUM_RELEASE_CONTRACT_VERSION=2
readonly TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
readonly QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"
readonly RECOVERY_LAUNCHER="/usr/local/sbin/refunddesk-quiesce-recovery"

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

assert_stable_self() {
  local control_plane_root resolved_self

  [[ "$0" == "${STABLE_LAUNCHER_PATH}" ]] ||
    die "retention must run through ${STABLE_LAUNCHER_PATH}"
  if [[ -f "${STABLE_LAUNCHER_PATH}" && ! -L "${STABLE_LAUNCHER_PATH}" ]]; then
    assert_root_control_file "${STABLE_LAUNCHER_PATH}"
    if [[ ! -e "${CONTROL_PLANE_LINK}" && ! -L "${CONTROL_PLANE_LINK}" ]]; then
      return 0
    fi
    control_plane_root="$(readlink --canonicalize-existing -- "${CONTROL_PLANE_LINK}")" ||
      die "legacy control-plane generation cannot be resolved"
    cmp --silent \
      "${STABLE_LAUNCHER_PATH}" "${control_plane_root}/scripts/retention-launcher.sh" ||
      die "legacy retention launcher differs from its migration generation"
    return 0
  fi
  [[ -L "${STABLE_LAUNCHER_PATH}" &&
    "$(stat --format='%u' -- "${STABLE_LAUNCHER_PATH}")" == "0" &&
    "$(readlink -- "${STABLE_LAUNCHER_PATH}")" == "${EXPECTED_LAUNCHER_LINK}" ]] ||
    die "stable retention launcher is not the exact root-owned generation symlink"
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
    die "stable retention launcher cannot be resolved"
  [[ "${resolved_self}" == "${control_plane_root}/scripts/retention-launcher.sh" ]] ||
    die "stable retention launcher escaped the active generation"
  assert_root_control_file "${resolved_self}"
}

[[ "${EUID}" -eq 0 ]] || die "this command must run as root"
(( $# == 0 )) || die "the retention launcher accepts no arguments"
for command in bash cmp readlink stat; do
  command -v "${command}" >/dev/null 2>&1 ||
    die "required command is unavailable: ${command}"
done

assert_stable_self

[[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]] ||
  die "retention is blocked while a release transition is unfinished"
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
    die "unfinished runtime quiescence could not be recovered before retention"
fi
[[ ! -e "${QUIESCE_JOURNAL}" && ! -L "${QUIESCE_JOURNAL}" ]] ||
  die "runtime quiescence remained after retention preflight recovery"

active_revision_file="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
assert_root_control_file "${active_revision_file}"
mapfile -t active_revision_lines <"${active_revision_file}"
(( ${#active_revision_lines[@]} == 1 )) ||
  die "active revision marker must contain exactly one line"
revision="${active_revision_lines[0]}"
[[ "${revision}" =~ ^[0-9a-f]{40}$ ]] || die "active revision marker is invalid"

current_link="${REFUNDDESK_ROOT}/current"
[[ -L "${current_link}" ]] || die "current source path must be a symlink"
[[ "$(stat --format='%u' -- "${current_link}")" == "0" ]] ||
  die "current source symlink must be owned by root"
current_source="$(readlink --canonicalize-existing -- "${current_link}")"
expected_source="${REFUNDDESK_ROOT}/releases/${revision}/source"
[[ "${current_source}" == "${expected_source}" ]] ||
  die "active revision and current source differ"
canonical_compose_file="${current_source}/deploy/lightsail/compose.yml"

revision_marker="${current_source}/.refunddesk-revision"
contract_marker="${current_source}/deploy/lightsail/RELEASE_CONTRACT_VERSION"
runner="${current_source}/deploy/lightsail/scripts/run-retention.sh"
assert_root_control_file "${canonical_compose_file}"
assert_root_control_file "${revision_marker}"
assert_root_control_file "${contract_marker}"
assert_root_control_file "${runner}"

mapfile -t revision_lines <"${revision_marker}"
(( ${#revision_lines[@]} == 1 )) && [[ "${revision_lines[0]}" == "${revision}" ]] ||
  die "current source revision marker differs from the active revision"
mapfile -t contract_lines <"${contract_marker}"
(( ${#contract_lines[@]} == 1 )) &&
  [[ "${contract_lines[0]}" =~ ^[1-9][0-9]*$ ]] ||
  die "current source release contract marker is invalid"
contract_version="${contract_lines[0]}"
(( contract_version >= MINIMUM_RELEASE_CONTRACT_VERSION &&
  contract_version <= MAXIMUM_RELEASE_CONTRACT_VERSION )) ||
  die "current source release contract is outside the supported range"

export REFUNDDESK_COMPOSE_FILE="${canonical_compose_file}"
exec /usr/bin/bash "${runner}"
