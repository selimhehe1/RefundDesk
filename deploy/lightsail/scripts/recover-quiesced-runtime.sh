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
readonly EDGE_WINDOW_LEASE="${REFUNDDESK_CONTROL_ROOT}/edge-window-lease.json"

edge_window_allows_runtime_start() {
  if [[ ! -e "${EDGE_WINDOW_LEASE}" && ! -L "${EDGE_WINDOW_LEASE}" ]]; then
    return 0
  fi
  [[ -f "${EDGE_WINDOW_LEASE}" && ! -L "${EDGE_WINDOW_LEASE}" ]] || return 1
  [[ "$(stat --format='%u:%g:%a' -- "${EDGE_WINDOW_LEASE}")" == "0:0:600" ]] || return 1
  python3 - "${EDGE_WINDOW_LEASE}" <<'PY' >/dev/null 2>&1
import datetime, json, re, sys
path = sys.argv[1]
raw = open(path, "rb").read()
if not raw or len(raw) > 2048 or b"\x00" in raw:
    raise SystemExit(1)
try:
    document = json.loads(raw.decode("utf-8"))
except (UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
if raw != (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode():
    raise SystemExit(1)
if set(document) != {"completedAt", "expectedRevision", "kind", "nonce", "schemaVersion", "state"}:
    raise SystemExit(1)
if document.get("schemaVersion") != 1 or document.get("kind") != "refunddesk.edge-window-host-lease" or document.get("state") != "complete":
    raise SystemExit(1)
if re.fullmatch(r"[0-9a-f]{40}", document.get("expectedRevision", "")) is None or re.fullmatch(r"[0-9a-f]{64}", document.get("nonce", "")) is None:
    raise SystemExit(1)
try:
    parsed = datetime.datetime.strptime(document.get("completedAt", ""), "%Y-%m-%dT%H:%M:%SZ")
except ValueError:
    raise SystemExit(1)
if parsed.strftime("%Y-%m-%dT%H:%M:%SZ") != document["completedAt"]:
    raise SystemExit(1)
PY
}

require_root
for command in cmp docker jq python3 readlink stat; do
  require_command "${command}"
done

edge_window_allows_runtime_start ||
  die "runtime recovery is blocked by an active or invalid edge-window interlock"

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
edge_window_allows_runtime_start ||
  die "runtime recovery is blocked by an edge-window interlock acquired during lock handoff"
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
expected_compose_file="${current_source}/deploy/lightsail/compose.yml"
[[ "${REFUNDDESK_COMPOSE_FILE}" == "${expected_compose_file}" ]] ||
  die "recovery Compose file is not bound to the canonical active source"
assert_root_control_file "${REFUNDDESK_COMPOSE_FILE}"
release_worker_mode="$(
  standard_release_environment_worker_mode \
    "${REFUNDDESK_COMPOSE_FILE}" \
    "${RELEASE_ENV_FILE}" \
    "${revision}"
)" ||
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
refunddesk_compose up --no-start --no-deps --no-build --pull never verifier worker web >/dev/null
worker_container_id="$(exact_project_service_container_id worker)" ||
  die "runtime recovery did not reserve exactly one worker container"
worker_inspection="$(docker inspect "${worker_container_id}")" ||
  die "runtime recovery worker mode cannot be inspected"
assert_standard_worker_runtime_mode_from_inspection \
  "${worker_inspection}" \
  "${release_worker_mode}"
refunddesk_compose start verifier worker web >/dev/null
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
