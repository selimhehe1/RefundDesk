#!/usr/bin/env bash

# Run the test/sandbox retention purge from the exact active immutable revision.
# This root wrapper validates host-controlled selection and secret topology; the
# unprivileged container validates database identity and SQL capabilities again.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_root
for command in cmp docker jq python3 readlink stat; do
  require_command "${command}"
done
acquire_operator_lock
assert_root_secret_directory "${REFUNDDESK_CONTROL_ROOT}"

TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"
readonly RELEASE_CONTRACT_VERSION="2"
readonly STABLE_RECOVERY_LAUNCHER="/usr/local/sbin/refunddesk-quiesce-recovery"
[[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]] ||
  die "retention is blocked while a release transition is unfinished"
[[ ! -e "${QUIESCE_JOURNAL}" && ! -L "${QUIESCE_JOURNAL}" ]] ||
  die "retention is blocked until an unfinished runtime quiescence is recovered"

ACTIVE_REVISION_FILE="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
CURRENT_LINK="${REFUNDDESK_ROOT}/current"
MAINTENANCE_ENV="${REFUNDDESK_CONFIG_ROOT}/maintenance.env"
MAINTENANCE_PASSWORD_FILE="${REFUNDDESK_CONFIG_ROOT}/secrets/postgres-maintenance-password"
POSTGRES_CA="${REFUNDDESK_CONFIG_ROOT}/tls/postgres/ca.crt"

assert_root_control_file "${ACTIVE_REVISION_FILE}"
assert_root_secret_file "${REFUNDDESK_RELEASE_ENV}"
assert_root_secret_file "${MAINTENANCE_ENV}"
assert_root_secret_file "${MAINTENANCE_PASSWORD_FILE}"
assert_root_control_file "${POSTGRES_CA}"
[[ -L "${CURRENT_LINK}" ]] || die "current source must be a symlink"
[[ "$(stat --format='%u' -- "${CURRENT_LINK}")" == "0" ]] ||
  die "current source symlink must be owned by root"

mapfile -t active_revision_lines <"${ACTIVE_REVISION_FILE}"
(( ${#active_revision_lines[@]} == 1 )) ||
  die "active revision marker must contain exactly one line"
revision="${active_revision_lines[0]}"
[[ "${revision}" =~ ^[0-9a-f]{40}$ ]] ||
  die "active revision marker is not a full lowercase Git SHA"

current_source="$(readlink --canonicalize-existing -- "${CURRENT_LINK}")"
expected_source="${REFUNDDESK_ROOT}/releases/${revision}/source"
[[ "${current_source}" == "${expected_source}" ]] ||
  die "current source and active revision differ"
[[ "${SCRIPT_DIR}" == "${current_source}/deploy/lightsail/scripts" ]] ||
  die "retention wrapper is not running from the active source"

source_revision_file="${current_source}/.refunddesk-revision"
DURABILITY_HELPER="${current_source}/deploy/lightsail/scripts/release-transition-journal.py"
RECOVERY_RUNNER="${current_source}/deploy/lightsail/scripts/recover-quiesced-runtime.sh"
assert_root_secret_file "${source_revision_file}"
assert_root_control_file "${DURABILITY_HELPER}"
assert_root_control_file "${RECOVERY_RUNNER}"
assert_root_control_entry \
  "${STABLE_RECOVERY_LAUNCHER}" \
  "${REFUNDDESK_CONTROL_PLANE_LINK}/scripts/quiesce-recovery-launcher.sh"
mapfile -t source_revision_lines <"${source_revision_file}"
(( ${#source_revision_lines[@]} == 1 )) ||
  die "source revision marker must contain exactly one line"
[[ "${source_revision_lines[0]}" == "${revision}" ]] ||
  die "source revision and active revision differ"

mapfile -t release_lines <"${REFUNDDESK_RELEASE_ENV}"
(( ${#release_lines[@]} == 2 )) ||
  die "release environment must contain exactly two lines"
[[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${revision}" ]] ||
  die "release image tag does not match the active revision"
[[ "${release_lines[1]}" == "REFUNDDESK_REVISION=${revision}" ]] ||
  die "release revision does not match the active revision"

python3 - "${MAINTENANCE_ENV}" "${MAINTENANCE_PASSWORD_FILE}" <<'PY' || die "maintenance environment or password binding is invalid"
import base64
import pathlib
import re
import sys
import urllib.parse

expected_names = {
    "NODE_ENV",
    "REFUNDDESK_MAINTENANCE_DATABASE_URL",
    "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1",
    "REFUNDDESK_RETENTION_BATCH_SIZE",
    "REFUNDDESK_RETENTION_SCOPE",
}

try:
    raw_environment = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
    if "\r" in raw_environment:
        raise ValueError
    lines = raw_environment.splitlines()
    values = {}
    for line in lines:
        if not line or line.startswith("#") or "=" not in line:
            raise ValueError
        name, value = line.split("=", 1)
        if name in values or name not in expected_names or not value:
            raise ValueError
        values[name] = value
    if set(values) != expected_names:
        raise ValueError
    if values["NODE_ENV"] != "production":
        raise ValueError
    if values["REFUNDDESK_RETENTION_SCOPE"] != "test_sandbox":
        raise ValueError
    if not values["REFUNDDESK_RETENTION_BATCH_SIZE"].isdigit():
        raise ValueError
    batch_size = int(values["REFUNDDESK_RETENTION_BATCH_SIZE"])
    if batch_size < 1 or batch_size > 100:
        raise ValueError
    pseudonym_key = base64.b64decode(
        values["REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1"],
        validate=True,
    )
    if len(pseudonym_key) != 32:
        raise ValueError
    database_url = urllib.parse.urlsplit(
        values["REFUNDDESK_MAINTENANCE_DATABASE_URL"]
    )
    if not re.fullmatch(
        r"(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+",
        database_url.password or "",
    ):
        raise ValueError
    if (
        database_url.scheme not in {"postgres", "postgresql"}
        or urllib.parse.unquote(database_url.username or "")
        != "refunddesk_maintenance_login"
        or database_url.hostname != "postgres.refunddesk.internal"
        or database_url.port != 5432
        or database_url.path != "/refunddesk"
        or database_url.query != "sslmode=verify-full"
        or database_url.fragment
    ):
        raise ValueError
    raw_password = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
    if "\r" in raw_password:
        raise ValueError
    password_lines = raw_password.splitlines()
    if (
        len(password_lines) != 1
        or len(password_lines[0]) < 32
        or urllib.parse.unquote(database_url.password or "") != password_lines[0]
    ):
        raise ValueError
except Exception:
    raise SystemExit(1)
PY

manifest="${REFUNDDESK_ROOT}/releases/${revision}/manifest.json"
assert_root_control_file "${manifest}"
image="refunddesk-migrate:sandbox-${revision}"
expected_image_id="$(
  jq --exit-status --raw-output \
    --arg revision "${revision}" \
    --arg image "${image}" '
      select(
        .schemaVersion == 1
        and .revision == $revision
        and .source == "https://github.com/selimhehe1/RefundDesk"
      )
      | .images
      | map(select(.role == "migrate" and .reference == $image))
      | select(length == 1)
      | .[0].imageId
      | select(test("^sha256:[0-9a-f]{64}$"))
    ' "${manifest}"
)" || die "active manifest has no unique maintenance image"
[[ -n "${expected_image_id}" ]] ||
  die "active manifest has no unique maintenance image"

inspect_json="$(docker image inspect "${image}")" ||
  die "exact active maintenance image is unavailable locally"
jq --exit-status \
  --arg id "${expected_image_id}" \
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
  die "local maintenance image does not match the active manifest"

refunddesk_compose config --quiet
postgres_container="$(service_container_id postgres)"
[[ -n "${postgres_container}" ]] || die "PostgreSQL container is absent"
[[ "$(docker inspect --format='{{.State.Running}}' "${postgres_container}")" == "true" ]] ||
  die "PostgreSQL container is not running"
[[ "$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${postgres_container}")" == "healthy" ]] ||
  die "PostgreSQL container is not healthy"

restore_worker() {
  local status=$?
  trap - EXIT

  if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]; then
    log "recovering the exact sandbox runtime after retention"
    if ! REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED=true \
      REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_CONTRACT="${RELEASE_CONTRACT_VERSION}" \
      REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_PATH="${STABLE_RECOVERY_LAUNCHER}" \
      REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_REVISION="${revision}" \
      bash "${RECOVERY_RUNNER}"; then
      status=1
    fi
  fi
  exit "${status}"
}
trap restore_worker EXIT

worker_container="$(service_container_id worker)"
[[ -n "${worker_container}" ]] ||
  die "worker must be present and running before retention"
worker_running="$(
  docker inspect --format='{{.State.Running}}' "${worker_container}"
)" || die "worker state cannot be inspected before retention"
[[ "${worker_running}" == "true" ]] ||
  die "worker must be present and running before retention"
python3 "${DURABILITY_HELPER}" prepare-quiesce \
  --path "${QUIESCE_JOURNAL}" \
  --operation retention \
  --revision "${revision}" >/dev/null ||
  die "durable retention quiescence could not be prepared"
log "quiescing the sandbox worker before retention"
refunddesk_compose stop --timeout 45 worker
service_is_running worker &&
  die "worker remained active after the retention quiescence boundary"
worker_container="$(service_container_id worker)" ||
  die "worker inventory cannot be read after the retention quiescence boundary"
if [[ -n "${worker_container}" ]]; then
  worker_running="$(
    docker inspect --format='{{.State.Running}}' "${worker_container}"
  )" || die "worker state cannot be inspected after the retention quiescence boundary"
  [[ "${worker_running}" != "true" ]] ||
    die "worker remained active after the retention quiescence boundary"
fi

log "starting isolated test/sandbox retention for revision ${revision}"
clear_database_owner_job_reservation
refunddesk_compose --profile maintenance run \
  --name "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" \
  --no-deps \
  --pull never \
  maintenance
seal_database_owner_job_reservation maintenance "${revision}"
assert_database_owner_job_reservation "${revision}"
log "isolated test/sandbox retention completed for revision ${revision}"
