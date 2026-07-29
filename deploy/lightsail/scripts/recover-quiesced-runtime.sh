#!/usr/bin/env bash

# Recover the exact active sandbox revision after an interrupted backup or
# retention run. The quiesce journal is removed only after full runtime and
# external deployment verification succeeds.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

readonly RELEASE_CONTRACT_VERSION="2"
readonly STABLE_RECOVERY_LAUNCHER="/usr/local/sbin/refunddesk-quiesce-recovery"
readonly QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"
readonly TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"

require_root
for command in cmp docker jq python3 readlink stat; do
  require_command "${command}"
done

if [[ "${REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED:-}" == "true" ]]; then
  [[ -e /proc/self/fd/9 ]] ||
    die "inherited quiesce recovery has no operator-lock descriptor"
  lock_inode="$(stat --format='%d:%i' -- "${REFUNDDESK_OPERATOR_LOCK}")"
  descriptor_inode="$(stat --dereference --format='%d:%i' -- /proc/self/fd/9)"
  [[ "${lock_inode}" == "${descriptor_inode}" ]] ||
    die "inherited quiesce recovery operator lock changed"
  flock --exclusive --nonblock 9 ||
    die "inherited quiesce recovery does not hold the operator lock"
else
  acquire_operator_lock
fi
assert_root_secret_directory "${REFUNDDESK_CONTROL_ROOT}"

[[ "${REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_CONTRACT:-}" == "${RELEASE_CONTRACT_VERSION}" &&
  "${REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_PATH:-}" == "${STABLE_RECOVERY_LAUNCHER}" &&
  "${REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_REVISION:-}" =~ ^[0-9a-f]{40}$ ]] ||
  die "runtime recovery must be selected by the stable host-side launcher"
assert_root_control_entry \
  "${STABLE_RECOVERY_LAUNCHER}" \
  "${REFUNDDESK_CONTROL_PLANE_LINK}/scripts/quiesce-recovery-launcher.sh"
[[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]] ||
  die "runtime recovery is blocked by an unfinished release transition"

revision="${REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_REVISION}"
ACTIVE_REVISION_FILE="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
CURRENT_LINK="${REFUNDDESK_ROOT}/current"
RELEASE_ENV_FILE="${REFUNDDESK_CONFIG_ROOT}/release.env"
assert_root_control_file "${ACTIVE_REVISION_FILE}"
assert_root_secret_file "${RELEASE_ENV_FILE}"
mapfile -t active_revision_lines <"${ACTIVE_REVISION_FILE}"
(( ${#active_revision_lines[@]} == 1 )) &&
  [[ "${active_revision_lines[0]}" == "${revision}" ]] ||
  die "active revision changed before runtime recovery"
[[ -L "${CURRENT_LINK}" && "$(stat --format='%u' -- "${CURRENT_LINK}")" == "0" ]] ||
  die "current source must be a root-owned symlink"
current_source="$(readlink --canonicalize-existing -- "${CURRENT_LINK}")"
expected_source="${REFUNDDESK_ROOT}/releases/${revision}/source"
[[ "${current_source}" == "${expected_source}" &&
  "${SCRIPT_DIR}" == "${current_source}/deploy/lightsail/scripts" ]] ||
  die "current source changed before runtime recovery"
mapfile -t release_lines <"${RELEASE_ENV_FILE}"
(( ${#release_lines[@]} == 2 )) &&
  [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${revision}" ]] &&
  [[ "${release_lines[1]}" == "REFUNDDESK_REVISION=${revision}" ]] ||
  die "release environment changed before runtime recovery"

DURABILITY_HELPER="${current_source}/deploy/lightsail/scripts/release-transition-journal.py"
MANIFEST="${REFUNDDESK_ROOT}/releases/${revision}/manifest.json"
assert_root_control_file "${DURABILITY_HELPER}"
assert_root_control_file "${MANIFEST}"
operation="$(
  jq --exit-status --raw-output --arg revision "${revision}" '
    select(
      type == "object"
      and keys == ["operation","revision","schemaVersion","status"]
      and .schemaVersion == 1
      and .status == "in_progress"
      and (.operation == "backup" or .operation == "retention")
      and .revision == $revision
    )
    | .operation
  ' "${QUIESCE_JOURNAL}"
)" || die "runtime quiesce journal is invalid"
python3 "${DURABILITY_HELPER}" assert-quiesce \
  --path "${QUIESCE_JOURNAL}" \
  --operation "${operation}" \
  --revision "${revision}" >/dev/null ||
  die "runtime quiesce journal failed its exact contract"

jq --exit-status \
  --arg revision "${revision}" '
    type == "object"
    and .schemaVersion == 1
    and .revision == $revision
    and .source == "https://github.com/selimhehe1/RefundDesk"
    and (.images | type == "array" and length == 3)
    and ([.images[].role] | sort == ["migrate","web","worker"])
    and all(.images[];
      type == "object"
      and keys == ["expectedUser","imageId","reference","role"]
      and .expectedUser == "node"
      and (.imageId | test("^sha256:[0-9a-f]{64}$"))
      and .reference == ("refunddesk-" + .role + ":sandbox-" + $revision))
  ' "${MANIFEST}" >/dev/null ||
  die "active release manifest changed before runtime recovery"
for role in web worker migrate; do
  reference="refunddesk-${role}:sandbox-${revision}"
  expected_id="$(
    jq --raw-output --arg role "${role}" \
      '.images[] | select(.role == $role) | .imageId' "${MANIFEST}"
  )"
  inspect_json="$(docker image inspect "${reference}")" ||
    die "active ${role} image disappeared before runtime recovery"
  jq --exit-status \
    --arg id "${expected_id}" \
    --arg revision "${revision}" '
      length == 1
      and .[0].Id == $id
      and .[0].Os == "linux"
      and .[0].Architecture == "amd64"
      and .[0].Config.User == "node"
      and .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
      and .[0].Config.Labels["org.opencontainers.image.source"]
        == "https://github.com/selimhehe1/RefundDesk"
    ' <<<"${inspect_json}" >/dev/null ||
    die "active ${role} image changed before runtime recovery"
done

if [[ "${operation}" == "retention" ]]; then
  maintenance_image_id="$(
    jq --raw-output '.images[] | select(.role == "migrate") | .imageId' "${MANIFEST}"
  )"
  recover_retention_database_owner_job "${revision}" "${maintenance_image_id}"
else
  assert_database_owner_job_reservation "${revision}"
fi

log "recovering exact sandbox revision ${revision} after interrupted ${operation}"
refunddesk_compose up --detach --no-build --pull never postgres >/dev/null
wait_for_container_health postgres 120 ||
  die "PostgreSQL did not become healthy during runtime recovery"
assert_postgres_root_mount_contract
refunddesk_compose up --detach --no-deps --no-build --pull never verifier worker web >/dev/null
wait_for_container_health verifier 90 ||
  die "verifier did not become healthy during runtime recovery"
wait_for_container_health worker 180 ||
  die "worker did not become healthy during runtime recovery"
wait_for_container_health web 120 ||
  die "web did not become healthy during runtime recovery"
refunddesk_compose up --detach --no-deps --no-build --pull never caddy >/dev/null
wait_for_container_health caddy 120 ||
  die "Caddy did not become healthy during runtime recovery"
REFUNDDESK_OPERATOR_LOCK_INHERITED=true \
  bash "${SCRIPT_DIR}/verify-deployment.sh" ||
  die "exact deployment verification failed during runtime recovery"

python3 "${DURABILITY_HELPER}" clear-quiesce \
  --path "${QUIESCE_JOURNAL}" \
  --operation "${operation}" \
  --revision "${revision}" >/dev/null ||
  die "verified runtime quiesce journal could not be cleared durably"
log "exact sandbox revision ${revision} recovered after interrupted ${operation}"
