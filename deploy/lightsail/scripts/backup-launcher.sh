#!/usr/bin/env bash

# Stable host-side entrypoint for cold backups. It selects backup code only
# after proving that the active deployment is fully committed and image-bound.

set -Eeuo pipefail
umask 077

readonly REFUNDDESK_ROOT="${REFUNDDESK_ROOT:-/opt/refunddesk}"
readonly REFUNDDESK_CONFIG_ROOT="${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}"
readonly REFUNDDESK_CONTROL_ROOT="${REFUNDDESK_CONTROL_ROOT:-/var/lib/refunddesk/control}"
readonly STABLE_LAUNCHER_PATH="/usr/local/sbin/refunddesk-backup"
readonly CONTROL_PLANE_LINK="${REFUNDDESK_ROOT}/control-plane-current"
readonly EXPECTED_LAUNCHER_LINK="${CONTROL_PLANE_LINK}/scripts/backup-launcher.sh"
readonly RELEASE_CONTRACT_VERSION="2"
readonly TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
readonly QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"
readonly BACKUP_UPLOAD_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/backup-upload-in-progress.json"
readonly RECOVERY_LAUNCHER="/usr/local/sbin/refunddesk-quiesce-recovery"
readonly EXPECTED_SOURCE="https://github.com/selimhehe1/RefundDesk"

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
    die "backups must run through ${STABLE_LAUNCHER_PATH}"
  if [[ -f "${STABLE_LAUNCHER_PATH}" && ! -L "${STABLE_LAUNCHER_PATH}" ]]; then
    assert_root_control_file "${STABLE_LAUNCHER_PATH}"
    if [[ ! -e "${CONTROL_PLANE_LINK}" && ! -L "${CONTROL_PLANE_LINK}" ]]; then
      return 0
    fi
    control_plane_root="$(readlink --canonicalize-existing -- "${CONTROL_PLANE_LINK}")" ||
      die "legacy control-plane generation cannot be resolved"
    cmp --silent \
      "${STABLE_LAUNCHER_PATH}" "${control_plane_root}/scripts/backup-launcher.sh" ||
      die "legacy backup launcher differs from its migration generation"
    return 0
  fi
  [[ -L "${STABLE_LAUNCHER_PATH}" &&
    "$(stat --format='%u' -- "${STABLE_LAUNCHER_PATH}")" == "0" &&
    "$(readlink -- "${STABLE_LAUNCHER_PATH}")" == "${EXPECTED_LAUNCHER_LINK}" ]] ||
    die "stable backup launcher is not the exact root-owned generation symlink"
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
    die "stable backup launcher cannot be resolved"
  [[ "${resolved_self}" == "${control_plane_root}/scripts/backup-launcher.sh" ]] ||
    die "stable backup launcher escaped the active generation"
  assert_root_control_file "${resolved_self}"
}

[[ "${EUID}" -eq 0 ]] || die "this command must run as root"
(( $# == 0 )) || die "the backup launcher accepts no arguments"
for command in bash cmp docker jq readlink stat; do
  command -v "${command}" >/dev/null 2>&1 ||
    die "required command is unavailable: ${command}"
done

assert_stable_self
[[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]] ||
  die "backup is blocked while a release transition is unfinished"
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
    die "unfinished runtime quiescence could not be recovered before backup"
fi
[[ ! -e "${QUIESCE_JOURNAL}" && ! -L "${QUIESCE_JOURNAL}" ]] ||
  die "runtime quiescence remained after backup preflight recovery"
[[ ! -e "${BACKUP_UPLOAD_JOURNAL}" && ! -L "${BACKUP_UPLOAD_JOURNAL}" ]] ||
  die "backup is blocked until an unfinished upload is reconciled"

active_revision_file="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
release_environment="${REFUNDDESK_CONFIG_ROOT}/release.env"
backup_environment="${REFUNDDESK_CONFIG_ROOT}/backup.env"
assert_root_control_file "${active_revision_file}"
assert_root_secret_file "${release_environment}"
assert_root_secret_file "${backup_environment}"
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
expected_source_root="${REFUNDDESK_ROOT}/releases/${revision}/source"
[[ "${current_source}" == "${expected_source_root}" ]] ||
  die "active revision and current source differ"

revision_marker="${current_source}/.refunddesk-revision"
contract_marker="${current_source}/deploy/lightsail/RELEASE_CONTRACT_VERSION"
runner="${current_source}/deploy/lightsail/scripts/backup.sh"
manifest="${REFUNDDESK_ROOT}/releases/${revision}/manifest.json"
for control_file in "${revision_marker}" "${contract_marker}" "${runner}" "${manifest}"; do
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
mapfile -t release_lines <"${release_environment}"
(( ${#release_lines[@]} == 2 )) &&
  [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${revision}" ]] &&
  [[ "${release_lines[1]}" == "REFUNDDESK_REVISION=${revision}" ]] ||
  die "release environment is not committed to the active revision"

jq --exit-status \
  --arg revision "${revision}" \
  --arg source "${EXPECTED_SOURCE}" '
    type == "object"
    and .schemaVersion == 1
    and .revision == $revision
    and .source == $source
    and (.images | type == "array" and length == 3)
    and ([.images[].role] | sort == ["migrate","web","worker"])
    and all(.images[];
      type == "object"
      and keys == ["expectedUser","imageId","reference","role"]
      and .expectedUser == "node"
      and (.imageId | test("^sha256:[0-9a-f]{64}$"))
      and .reference == ("refunddesk-" + .role + ":sandbox-" + $revision))
  ' "${manifest}" >/dev/null ||
  die "active release manifest is invalid"

for role in web worker migrate; do
  reference="refunddesk-${role}:sandbox-${revision}"
  expected_id="$(
    jq --raw-output --arg role "${role}" \
      '.images[] | select(.role == $role) | .imageId' "${manifest}"
  )"
  inspect_json="$(docker image inspect "${reference}")" ||
    die "active ${role} image is unavailable"
  jq --exit-status \
    --arg id "${expected_id}" \
    --arg revision "${revision}" \
    --arg source "${EXPECTED_SOURCE}" '
      length == 1
      and .[0].Id == $id
      and .[0].Os == "linux"
      and .[0].Architecture == "amd64"
      and .[0].Config.User == "node"
      and .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
      and .[0].Config.Labels["org.opencontainers.image.source"] == $source
    ' <<<"${inspect_json}" >/dev/null ||
    die "active ${role} image differs from its manifest"
done

export REFUNDDESK_BACKUP_LAUNCHER_CONTRACT="${RELEASE_CONTRACT_VERSION}"
export REFUNDDESK_BACKUP_LAUNCHER_PATH="${STABLE_LAUNCHER_PATH}"
export REFUNDDESK_BACKUP_LAUNCHER_REVISION="${revision}"
exec /usr/bin/bash "${runner}"
