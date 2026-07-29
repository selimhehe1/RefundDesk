#!/usr/bin/env bash

# Stable host-side entrypoint for recovering an exact active runtime after a
# cold-backup or retention quiescence was interrupted.

set -Eeuo pipefail
umask 077

readonly REFUNDDESK_ROOT="${REFUNDDESK_ROOT:-/opt/refunddesk}"
readonly REFUNDDESK_CONFIG_ROOT="${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}"
readonly REFUNDDESK_CONTROL_ROOT="${REFUNDDESK_CONTROL_ROOT:-/var/lib/refunddesk/control}"
readonly STABLE_LAUNCHER_PATH="/usr/local/sbin/refunddesk-quiesce-recovery"
readonly CONTROL_PLANE_LINK="${REFUNDDESK_ROOT}/control-plane-current"
readonly EXPECTED_LAUNCHER_LINK="${CONTROL_PLANE_LINK}/scripts/quiesce-recovery-launcher.sh"
readonly RELEASE_CONTRACT_VERSION="2"
readonly QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"

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
    die "runtime recovery must run through ${STABLE_LAUNCHER_PATH}"
  if [[ -f "${STABLE_LAUNCHER_PATH}" && ! -L "${STABLE_LAUNCHER_PATH}" ]]; then
    assert_root_control_file "${STABLE_LAUNCHER_PATH}"
    if [[ ! -e "${CONTROL_PLANE_LINK}" && ! -L "${CONTROL_PLANE_LINK}" ]]; then
      return 0
    fi
    control_plane_root="$(readlink --canonicalize-existing -- "${CONTROL_PLANE_LINK}")" ||
      die "legacy control-plane generation cannot be resolved"
    cmp --silent \
      "${STABLE_LAUNCHER_PATH}" \
      "${control_plane_root}/scripts/quiesce-recovery-launcher.sh" ||
      die "legacy recovery launcher differs from its migration generation"
    return 0
  fi
  [[ -L "${STABLE_LAUNCHER_PATH}" &&
    "$(stat --format='%u' -- "${STABLE_LAUNCHER_PATH}")" == "0" &&
    "$(readlink -- "${STABLE_LAUNCHER_PATH}")" == "${EXPECTED_LAUNCHER_LINK}" ]] ||
    die "stable recovery launcher is not the exact root-owned generation symlink"
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
    die "stable recovery launcher cannot be resolved"
  [[ "${resolved_self}" == "${control_plane_root}/scripts/quiesce-recovery-launcher.sh" ]] ||
    die "stable recovery launcher escaped the active generation"
  assert_root_control_file "${resolved_self}"
}

[[ "${EUID}" -eq 0 ]] || die "this command must run as root"
(( $# == 0 )) || die "the quiesce recovery launcher accepts no arguments"
for command in bash cmp jq readlink stat; do
  command -v "${command}" >/dev/null 2>&1 ||
    die "required command is unavailable: ${command}"
done

assert_stable_self
[[ -d "${REFUNDDESK_CONTROL_ROOT}" && ! -L "${REFUNDDESK_CONTROL_ROOT}" ]] ||
  die "runtime control root must be a non-symlink directory"
[[ "$(readlink --canonicalize-existing -- "${REFUNDDESK_CONTROL_ROOT}")" == \
  "${REFUNDDESK_CONTROL_ROOT}" ]] ||
  die "runtime control root must be canonical"
[[ "$(stat --format='%u:%g:%a' -- "${REFUNDDESK_CONTROL_ROOT}")" == "0:0:700" ]] ||
  die "runtime control root must be root-owned mode 0700"
assert_root_secret_file "${QUIESCE_JOURNAL}"

active_revision_file="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
assert_root_control_file "${active_revision_file}"
mapfile -t active_revision_lines <"${active_revision_file}"
(( ${#active_revision_lines[@]} == 1 )) ||
  die "active revision marker must contain exactly one line"
revision="${active_revision_lines[0]}"
[[ "${revision}" =~ ^[0-9a-f]{40}$ ]] || die "active revision marker is invalid"

jq --exit-status --arg revision "${revision}" '
  type == "object"
  and keys == ["operation","revision","schemaVersion","status"]
  and .schemaVersion == 1
  and .status == "in_progress"
  and (.operation == "backup" or .operation == "retention")
  and .revision == $revision
' "${QUIESCE_JOURNAL}" >/dev/null ||
  die "runtime quiesce journal is invalid or differs from the active revision"

current_link="${REFUNDDESK_ROOT}/current"
[[ -L "${current_link}" ]] || die "current source path must be a symlink"
[[ "$(stat --format='%u' -- "${current_link}")" == "0" ]] ||
  die "current source symlink must be owned by root"
current_source="$(readlink --canonicalize-existing -- "${current_link}")"
expected_source="${REFUNDDESK_ROOT}/releases/${revision}/source"
[[ "${current_source}" == "${expected_source}" ]] ||
  die "active revision and current source differ"

revision_marker="${current_source}/.refunddesk-revision"
contract_marker="${current_source}/deploy/lightsail/RELEASE_CONTRACT_VERSION"
runner="${current_source}/deploy/lightsail/scripts/recover-quiesced-runtime.sh"
for control_file in "${revision_marker}" "${contract_marker}" "${runner}"; do
  assert_root_control_file "${control_file}"
done
mapfile -t source_revision_lines <"${revision_marker}"
(( ${#source_revision_lines[@]} == 1 )) &&
  [[ "${source_revision_lines[0]}" == "${revision}" ]] ||
  die "current source revision marker differs from the active revision"
mapfile -t contract_lines <"${contract_marker}"
(( ${#contract_lines[@]} == 1 )) &&
  [[ "${contract_lines[0]}" == "${RELEASE_CONTRACT_VERSION}" ]] ||
  die "current source release contract is unsupported"

export REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_CONTRACT="${RELEASE_CONTRACT_VERSION}"
export REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_PATH="${STABLE_LAUNCHER_PATH}"
export REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_REVISION="${revision}"
exec /usr/bin/bash "${runner}"
