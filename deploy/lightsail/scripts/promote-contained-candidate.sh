#!/usr/bin/env bash

# Promote one authenticated sandbox candidate while preserving containment.
# This is intentionally independent from release.sh and
# recover-quiesced-runtime.sh: it never starts the worker or public Caddy, never
# enables maintenance, and has no edge/cloud API capability.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
ARTIFACT_DIR=""
REVISION=""
EXPECTED_BUNDLE_SHA256=""
EXPECTED_MANIFEST_SHA256=""
EXPECTED_SOURCE_SHA256=""
PROVENANCE_FILE=""
EXPECTED_PROVENANCE_SHA256=""
NONCE=""
OPERATOR_LOCK_INHERITED=false
readonly CADDY_REFERENCE="caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648"
readonly POSTGRES_REFERENCE="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
readonly PHASE_PREPARED=10
readonly PHASE_CONTAINED=20
readonly PHASE_IMAGES_LOADED=30
readonly PHASE_DATABASE_PREPARED=40
readonly PHASE_CANDIDATE_INERT=50
readonly PHASE_CANDIDATE_VERIFIED=55
readonly PHASE_COMMITTING=60
readonly PHASE_METADATA_COMMITTED=70
readonly PHASE_COMPLETE=80

usage() {
  cat <<'EOF'
Usage: sudo bash promote-contained-candidate.sh \
  --artifact-dir DIR --revision FULL_SHA \
  --expected-bundle-sha256 SHA256 --expected-manifest-sha256 SHA256 \
  --expected-source-sha256 SHA256 \
  --provenance-file FILE --expected-provenance-sha256 SHA256 \
  --nonce 64HEX [--operator-lock-inherited]

All hashes are authenticated local-operator inputs. The runner performs no
network request and leaves postgres/verifier/web only; worker, Caddy,
maintenance and host listeners remain stopped. Remote usage errors exit 64.
EOF
}

usage_error() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 64
}

while (( $# > 0 )); do
  case "$1" in
    --artifact-dir) (( $# >= 2 )) || usage_error "--artifact-dir requires a value"; ARTIFACT_DIR="$2"; shift 2 ;;
    --revision) (( $# >= 2 )) || usage_error "--revision requires a value"; REVISION="$2"; shift 2 ;;
    --expected-bundle-sha256) (( $# >= 2 )) || usage_error "--expected-bundle-sha256 requires a value"; EXPECTED_BUNDLE_SHA256="$2"; shift 2 ;;
    --expected-manifest-sha256) (( $# >= 2 )) || usage_error "--expected-manifest-sha256 requires a value"; EXPECTED_MANIFEST_SHA256="$2"; shift 2 ;;
    --expected-source-sha256) (( $# >= 2 )) || usage_error "--expected-source-sha256 requires a value"; EXPECTED_SOURCE_SHA256="$2"; shift 2 ;;
    --provenance-file) (( $# >= 2 )) || usage_error "--provenance-file requires a value"; PROVENANCE_FILE="$2"; shift 2 ;;
    --expected-provenance-sha256) (( $# >= 2 )) || usage_error "--expected-provenance-sha256 requires a value"; EXPECTED_PROVENANCE_SHA256="$2"; shift 2 ;;
    --nonce) (( $# >= 2 )) || usage_error "--nonce requires a value"; NONCE="$2"; shift 2 ;;
    --operator-lock-inherited)
      [[ "${OPERATOR_LOCK_INHERITED}" == "false" ]] || usage_error "--operator-lock-inherited may be supplied only once"
      OPERATOR_LOCK_INHERITED=true
      shift
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || usage_error "revision must be full lowercase 40-hex"
for digest in "${EXPECTED_BUNDLE_SHA256}" "${EXPECTED_MANIFEST_SHA256}" \
  "${EXPECTED_SOURCE_SHA256}" "${EXPECTED_PROVENANCE_SHA256}" "${NONCE}"; do
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || usage_error "hashes and nonce must be lowercase 64-hex"
done
[[ -n "${ARTIFACT_DIR}" && -n "${PROVENANCE_FILE}" ]] || usage_error "artifact and provenance paths are required"

export REFUNDDESK_COMPOSE_FILE="${SOURCE_ROOT}/deploy/lightsail/compose.yml"
export REFUNDDESK_RELEASE_ENV="${REFUNDDESK_CONTROL_ROOT:-/var/lib/refunddesk/control}/contained-promotion-release.env"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

TEST_MODE="${REFUNDDESK_CONTAINED_PROMOTION_TEST_MODE:-0}"
HOST_COMMAND="${REFUNDDESK_CONTAINED_PROMOTION_HOST_COMMAND:-}"
if [[ "${TEST_MODE}" != "1" ]]; then
  [[ -z "${HOST_COMMAND}" ]] || die "host-command override is forbidden outside contract tests"
  require_root
fi
for command_name in awk cmp date docker flock grep jq python3 readlink sha256sum sort ss stat systemctl timeout tr zstd; do
  if [[ "${TEST_MODE}" != "1" || "${command_name}" =~ ^(flock|jq|python3|readlink|sha256sum|stat)$ ]]; then
    require_command "${command_name}"
  fi
done

adopt_test_inherited_operator_lock() {
  local descriptor_device_inode lock_device_inode lock_directory test_base

  # The production helper stays root-only. This branch exists solely so the
  # disposable contract can run as an unprivileged UID in a network-none
  # container; every path and owner is bound to that UID's exact /tmp fixture.
  (( EUID != 0 )) || die "the non-root inherited-lock fixture unexpectedly runs as root"
  [[ "${REFUNDDESK_ROOT}" =~ ^/tmp/refunddesk-contained-promotion-test-[A-Za-z0-9]+/host$ ]] ||
    die "the inherited-lock fixture root is outside its disposable namespace"
  test_base="${REFUNDDESK_ROOT%/host}"
  [[ "${REFUNDDESK_OPERATOR_LOCK}" == "${test_base}/run/operator.lock" ]] ||
    die "the inherited-lock fixture targets a non-canonical lock"
  [[ -e /proc/self/fd/9 ]] || die "the inherited-lock fixture descriptor is absent"
  lock_directory="${test_base}/run"
  [[ -d "${lock_directory}" && ! -L "${lock_directory}" ]] || die "the inherited-lock fixture directory is unsafe"
  [[ "$(readlink --canonicalize-existing -- "${lock_directory}")" == "${lock_directory}" ]] ||
    die "the inherited-lock fixture directory is not canonical"
  [[ "$(stat --format='%u:%a' -- "${lock_directory}")" == "${EUID}:700" ]] ||
    die "the inherited-lock fixture directory owner or mode differs"
  [[ -f "${REFUNDDESK_OPERATOR_LOCK}" && ! -L "${REFUNDDESK_OPERATOR_LOCK}" ]] ||
    die "the inherited-lock fixture file is unsafe"
  [[ "$(stat --format='%u:%a' -- "${REFUNDDESK_OPERATOR_LOCK}")" == "${EUID}:600" ]] ||
    die "the inherited-lock fixture file owner or mode differs"
  [[ "$(readlink --canonicalize-existing -- /proc/self/fd/9)" == "${REFUNDDESK_OPERATOR_LOCK}" ]] ||
    die "the inherited-lock fixture descriptor targets another path"
  lock_device_inode="$(stat --format='%d:%i' -- "${REFUNDDESK_OPERATOR_LOCK}")"
  descriptor_device_inode="$(stat --dereference --format='%d:%i' -- /proc/self/fd/9)"
  [[ "${descriptor_device_inode}" == "${lock_device_inode}" ]] ||
    die "the inherited-lock fixture descriptor changed"
  flock --exclusive --nonblock 9 || die "another fixture operator holds the lock"
}

if [[ "${OPERATOR_LOCK_INHERITED}" == "true" && "${TEST_MODE}" == "1" ]] && (( EUID != 0 )); then
  adopt_test_inherited_operator_lock
elif [[ "${OPERATOR_LOCK_INHERITED}" == "true" ]]; then
  adopt_inherited_operator_lock
elif [[ "${TEST_MODE}" == "1" ]]; then
  [[ -n "${HOST_COMMAND}" && "${REFUNDDESK_ROOT}" == /tmp/refunddesk-contained-promotion-test-* ]] ||
    die "contained promotion test hook escaped its disposable namespace"
  mkdir -p -- "$(dirname -- "${REFUNDDESK_OPERATOR_LOCK}")"
  exec 9>"${REFUNDDESK_OPERATOR_LOCK}"
  flock --exclusive --timeout 30 9 || die "another contained promotion holds the test operator lock"
else
  acquire_operator_lock
fi

if [[ "${TEST_MODE}" == "1" ]]; then
  mkdir -p -- "${REFUNDDESK_CONTROL_ROOT}"
  chmod 0700 "${REFUNDDESK_CONTROL_ROOT}"
else
  install -d -o root -g root -m 0700 "${REFUNDDESK_CONTROL_ROOT}"
  assert_root_secret_directory "${REFUNDDESK_CONTROL_ROOT}"
fi

readonly JOURNAL_FILE="${REFUNDDESK_CONTROL_ROOT}/contained-promotion-in-progress.json"
readonly FAILURE_FILE="${REFUNDDESK_CONTROL_ROOT}/contained-promotion-${REVISION}-${NONCE:0:12}.failure.json"
readonly EVIDENCE_FILE="${REFUNDDESK_CONTROL_ROOT}/contained-promotion-${REVISION}-${NONCE:0:12}.json"
readonly STAGING_RELEASE_ENV="${REFUNDDESK_RELEASE_ENV}"
readonly BUNDLE_NAME="refunddesk-sandbox-${REVISION}.images.tar.zst"
readonly MANIFEST_NAME="refunddesk-sandbox-${REVISION}.manifest.json"
readonly BUNDLE_PATH="${ARTIFACT_DIR}/${BUNDLE_NAME}"
readonly CHECKSUM_PATH="${BUNDLE_PATH}.sha256"
readonly MANIFEST_PATH="${ARTIFACT_DIR}/${MANIFEST_NAME}"
readonly SOURCE_REVISION_FILE="${SOURCE_ROOT}/.refunddesk-revision"
readonly SOURCE_DIGEST_FILE="${SOURCE_ROOT}/.refunddesk-source-sha256"
readonly ROTATION_STATE_FILE="${REFUNDDESK_CONFIG_ROOT}/application-key-rotation-state.json"
readonly ROTATION_COMMIT_FILE="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-committed.json"
readonly CANONICAL_RELEASE_ENV="${REFUNDDESK_CONFIG_ROOT}/release.env"
readonly ACTIVE_REVISION_FILE="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
readonly CURRENT_LINK="${REFUNDDESK_ROOT}/current"
readonly TARGET_RELEASE_DIR="${REFUNDDESK_ROOT}/releases/${REVISION}"
readonly INSTALLED_MANIFEST="${TARGET_RELEASE_DIR}/manifest.json"
readonly TRANSITION_HELPER="${SOURCE_ROOT}/deploy/lightsail/scripts/release-transition-journal.py"

for incompatible_journal in \
  "${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json" \
  "${REFUNDDESK_CONTROL_ROOT}/backup-upload-in-progress.json" \
  "${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json" \
  "${REFUNDDESK_CONFIG_ROOT}/managed-sandbox-three-binding-transition-in-progress.json"; do
  [[ ! -e "${incompatible_journal}" && ! -L "${incompatible_journal}" ]] ||
    die "contained promotion refuses an unresolved operational journal"
done

atomic_install() {
  local source="$1" target="$2" mode="$3"
  python3 - "${source}" "${target}" "${mode}" <<'PY'
import os
import sys
from pathlib import Path

source, target, mode = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3], 8)
target.parent.mkdir(parents=True, exist_ok=True)
temporary = target.parent / f".{target.name}.{os.getpid()}.tmp"
with source.open("rb") as input_stream, temporary.open("xb") as output_stream:
    while block := input_stream.read(1024 * 1024):
        output_stream.write(block)
    output_stream.flush()
    os.fsync(output_stream.fileno())
os.chmod(temporary, mode)
if os.geteuid() == 0:
    os.chown(temporary, 0, 0)
os.replace(temporary, target)
directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

atomic_text() {
  local target="$1" mode="$2" temporary
  temporary="$(mktemp "${REFUNDDESK_CONTROL_ROOT}/.contained-text.XXXXXX")"
  cat >"${temporary}"
  atomic_install "${temporary}" "${target}" "${mode}"
  rm -f -- "${temporary}"
}

durable_unlink() {
  local target="$1"
  python3 - "${target}" <<'PY'
import os
import sys
from pathlib import Path
path = Path(sys.argv[1])
try:
    path.unlink()
except FileNotFoundError:
    pass
descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

host_call() {
  local operation="$1"
  shift
  if [[ "${TEST_MODE}" == "1" ]]; then
    "${HOST_COMMAND}" "${operation}" "$@"
    return
  fi
  case "${operation}" in
    assert-inventory)
      local expected_revision="$1" ids all_ids id inspection service
      ids="$(docker container ls --all --no-trunc --quiet \
        --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}")" ||
        die "project container inventory is unavailable"
      local -a project_ids=()
      [[ -z "${ids}" ]] || mapfile -t project_ids <<<"${ids}"
      (( ${#project_ids[@]} == 6 )) ||
        die "project must contain exact five runtime containers plus the owner reservation"
      all_ids="$(docker container ls --all --no-trunc --quiet)" || die "global container inventory is unavailable"
      local -a global_ids=()
      [[ -z "${all_ids}" ]] || mapfile -t global_ids <<<"${all_ids}"
      (( ${#global_ids[@]} == 6 )) || die "foreign Docker containers are forbidden during contained promotion"
      [[ "$(printf '%s\n' "${project_ids[@]}" | sort)" == "$(printf '%s\n' "${global_ids[@]}" | sort)" ]] ||
        die "global Docker inventory differs from the exact project inventory"
      for service in postgres verifier worker web caddy; do
        ids="$(docker container ls --all --no-trunc --quiet \
          --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
          --filter "label=com.docker.compose.service=${service}")"
        [[ "${ids}" =~ ^[0-9a-f]{64}$ ]] || die "runtime inventory requires exactly one ${service}"
        inspection="$(docker inspect "${ids}")"
        if [[ "${service}" != postgres ]]; then
          jq --exit-status --arg revision "${expected_revision}" --arg service "${service}" '
            length == 1 and .[0].Config.Labels["com.docker.compose.service"] == $service
            and .[0].Config.Labels["com.refunddesk.revision"] == $revision
          ' <<<"${inspection}" >/dev/null || die "${service} revision identity differs"
        fi
      done
      ids="$(docker container ls --all --no-trunc --quiet \
        --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
        --filter "label=com.docker.compose.service=database-owner-reservation")"
      [[ "${ids}" =~ ^[0-9a-f]{64}$ ]] || die "owner reservation cardinality differs"
      ;;
    assert-owner-reservation)
      assert_database_owner_job_reservation "$1"
      ;;
    assert-completed-state)
      local expected_revision="$1" expected_postgres="$2" expected_verifier="$3" \
        expected_web="$4" expected_worker="$5" expected_caddy="$6"
      host_call assert-inventory "${expected_revision}"
      host_call assert-owner-reservation "${expected_revision}"
      local service expected_id expected_running expected_reference actual_id expected_image_id inspection
      for service in postgres verifier web worker caddy; do
        case "${service}" in
          postgres) expected_id="${expected_postgres}"; expected_running=true; expected_reference="${POSTGRES_REFERENCE}" ;;
          verifier) expected_id="${expected_verifier}"; expected_running=true; expected_reference="${CADDY_REFERENCE}" ;;
          web) expected_id="${expected_web}"; expected_running=true; expected_reference="refunddesk-web:sandbox-${expected_revision}" ;;
          worker) expected_id="${expected_worker}"; expected_running=false; expected_reference="refunddesk-worker:sandbox-${expected_revision}" ;;
          caddy) expected_id="${expected_caddy}"; expected_running=false; expected_reference="${CADDY_REFERENCE}" ;;
        esac
        actual_id="$(service_container_id "${service}")"
        [[ "${actual_id}" == "${expected_id}" ]] || die "completed ${service} container identity differs"
        expected_image_id="$(docker image inspect --format '{{.Id}}' -- "${expected_reference}")" ||
          die "completed ${service} image is unavailable"
        inspection="$(docker inspect "${actual_id}")" || die "completed ${service} inspection failed"
        jq --exit-status --arg project "${REFUNDDESK_COMPOSE_PROJECT}" --arg service "${service}" \
          --arg revision "${expected_revision}" --arg reference "${expected_reference}" \
          --arg imageId "${expected_image_id}" --argjson running "${expected_running}" '
          length == 1
          and .[0].Config.Labels["com.docker.compose.project"] == $project
          and .[0].Config.Labels["com.docker.compose.service"] == $service
          and (if $service == "postgres" then true else .[0].Config.Labels["com.refunddesk.revision"] == $revision end)
          and .[0].Config.Image == $reference and .[0].Image == $imageId
          and (if $service == "postgres" then true else .[0].HostConfig.RestartPolicy.Name == "no" end)
          and (if $service == "worker" then
            ([.[0].Config.Env[]? | select(startswith("REFUNDDESK_WORKER_RUNTIME_MODE="))]
              == ["REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission"])
          else true end)
          and .[0].State.Running == $running
          and (if $running and .[0].State.Health != null then .[0].State.Health.Status == "healthy" else true end)
        ' <<<"${inspection}" >/dev/null || die "completed ${service} runtime differs"
      done
      for unit in refunddesk-backup.timer refunddesk-retention.timer; do
        [[ "$(systemctl is-enabled "${unit}" 2>/dev/null || true)" == disabled ]] ||
          die "completed ${unit} is not disabled"
      done
      for unit in refunddesk-backup.timer refunddesk-retention.timer refunddesk-backup.service \
        refunddesk-retention.service refunddesk-quiesce-recovery.service; do
        systemctl is-active --quiet "${unit}" && die "completed ${unit} is active"
      done
      local environment_file
      for environment_file in "${REFUNDDESK_CONFIG_ROOT}/platform.env" "${REFUNDDESK_CONFIG_ROOT}/worker.env"; do
        assert_root_secret_file "${environment_file}"
        [[ "$(grep --count --fixed-strings --line-regexp 'REFUNDDESK_GLOBAL_LIVE_ENABLED=false' "${environment_file}")" == 1 ]] ||
          die "completed live interlock is not disabled"
      done
      [[ "$(grep --count --fixed-strings --line-regexp 'STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled' \
        "${REFUNDDESK_CONFIG_ROOT}/platform.env")" == 1 ]] || die "completed live webhook interlock is not disabled"
      for protocol in tcp udp; do
        for port in 80 443; do
          if [[ "${protocol}" == tcp ]]; then
            [[ -z "$(ss -H -ltn "( sport = :${port} )")" ]] || die "completed TCP/${port} listener exists"
          else
            [[ -z "$(ss -H -lun "( sport = :${port} )")" ]] || die "completed UDP/${port} listener exists"
          fi
        done
      done
      ;;
    contain)
      systemctl disable --now refunddesk-backup.timer refunddesk-retention.timer >/dev/null
      systemctl stop refunddesk-backup.service refunddesk-retention.service \
        refunddesk-quiesce-recovery.service >/dev/null
      local service ids id
      for service in caddy worker web verifier; do
        ids="$(docker container ls --all --no-trunc --quiet \
          --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
          --filter "label=com.docker.compose.service=${service}")"
        while IFS= read -r id; do
          [[ -n "${id}" ]] || continue
          docker update --restart=no "${id}" >/dev/null
          if [[ "$(docker inspect --format '{{.State.Running}}' "${id}")" == "true" ]]; then
            docker stop --time 45 "${id}" >/dev/null || docker kill "${id}" >/dev/null
          fi
        done <<<"${ids}"
      done
      for protocol in tcp udp; do
        for port in 80 443; do
          if [[ "${protocol}" == tcp ]]; then
            [[ -z "$(ss -H -ltn "( sport = :${port} )")" ]] || die "TCP/${port} listener remains"
          else
            [[ -z "$(ss -H -lun "( sport = :${port} )")" ]] || die "UDP/${port} listener remains"
          fi
        done
      done
      ;;
    snapshot)
      local postgres_id output compact
      postgres_id="$(service_container_id postgres)"
      [[ "${postgres_id}" =~ ^[0-9a-f]{64}$ ]] || die "PostgreSQL container is unavailable"
      output="$(timeout 25 docker exec --env PSQL_HISTORY=/dev/null "${postgres_id}" \
        psql --host=/var/run/postgresql --username=refunddesk_owner --dbname=refunddesk \
        --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
        --command="BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
        SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s';
        SELECT concat_ws('|',(SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
        (SELECT count(*) FROM public.refund_requests WHERE workflow_status IN ('pending_approval','approved','executing','reconciliation_required')),
        (SELECT count(*) FROM public.refund_requests WHERE payment_guard_released_at IS NULL),
        (SELECT count(*) FROM pgboss.job WHERE name='refunddesk_refund_execute' AND state::text IN ('created','retry','active')),
        (SELECT count(*) FROM public.tenants WHERE live_enabled),
        (SELECT count(*) FROM public.stripe_installations WHERE environment='live'),
        (SELECT count(*) FROM pg_catalog.pg_prepared_xacts),(SELECT count(*) FROM public.refund_requests),
        (SELECT count(*) FROM public.refund_executions),
        (SELECT count(*) FROM public.refund_execution_attempts),
        (SELECT count(*) FROM public.webhook_receipts),
        (SELECT count(*) FROM public.api_mutation_receipts),
        (SELECT count(*) FROM public.audit_events)); ROLLBACK;")"
      compact="$(printf '%s' "${output}" | tr -d '[:space:]')"
      [[ "${compact}" =~ ^[1-9][0-9]{17,19}(\|[0-9]+){12}$ ]] ||
        die "database snapshot is malformed"
      printf '%s|%s\n' "${postgres_id}" "${compact}"
      ;;
    load-images)
      zstd --decompress --stdout -- "${BUNDLE_PATH}" | docker image load >/dev/null
      local role reference expected inspection
      for role in web worker migrate; do
        reference="refunddesk-${role}:sandbox-${REVISION}"
        expected="$(jq --raw-output --arg role "${role}" '.images[] | select(.role == $role) | .imageId' "${MANIFEST_PATH}")"
        inspection="$(docker image inspect "${reference}")"
        jq --exit-status --arg id "${expected}" --arg revision "${REVISION}" '
          length == 1 and .[0].Id == $id and .[0].Os == "linux" and .[0].Architecture == "amd64"
          and .[0].Config.User == "node"
          and .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
        ' <<<"${inspection}" >/dev/null || die "loaded ${role} image violates its manifest"
      done
      ;;
    validate-config)
      docker run --rm --pull never --network none --user 0:0 --read-only --cap-drop ALL \
        --security-opt no-new-privileges --pids-limit 128 --memory 384m \
        --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
        --mount "type=bind,source=${REFUNDDESK_CONFIG_ROOT}/platform.env,target=/run/refunddesk/platform.env,readonly" \
        --mount "type=bind,source=${REFUNDDESK_CONFIG_ROOT}/worker.env,target=/run/refunddesk/worker.env,readonly" \
        --mount "type=bind,source=${REFUNDDESK_CONFIG_ROOT}/migration.env,target=/run/refunddesk/migration.env,readonly" \
        --mount "type=bind,source=${REFUNDDESK_CONFIG_ROOT}/maintenance.env,target=/run/refunddesk/maintenance.env,readonly" \
        --mount "type=bind,source=${REFUNDDESK_CONFIG_ROOT}/caddy.env,target=/run/refunddesk/caddy.env,readonly" \
        --mount "type=bind,source=${REFUNDDESK_CONFIG_ROOT}/public-origin,target=/run/refunddesk/public-origin,readonly" \
        "refunddesk-migrate:sandbox-${REVISION}" node packages/config/dist/check-release.js \
        /run/refunddesk/platform.env /run/refunddesk/worker.env /run/refunddesk/migration.env \
        /run/refunddesk/maintenance.env /run/refunddesk/caddy.env /run/refunddesk/public-origin >/dev/null
      ;;
    migrate)
      assert_database_owner_job_reservation "${FROM_REVISION}"
      clear_database_owner_job_reservation
      refunddesk_compose --profile release run --name "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" \
        --no-deps --pull never migrate
      seal_database_owner_job_reservation migrate "${REVISION}"
      ;;
    recreate)
      refunddesk_compose up --no-start --no-deps --no-build --pull never --force-recreate \
        verifier worker web caddy
      local id
      for service in verifier worker web caddy; do
        id="$(service_container_id "${service}")"
        [[ "${id}" =~ ^[0-9a-f]{64}$ ]] || die "candidate ${service} was not created"
        docker update --restart=no "${id}" >/dev/null
      done
      ;;
    start-core)
      refunddesk_compose start web verifier >/dev/null
      wait_for_container_health web 180 || die "candidate web did not become healthy"
      wait_for_container_health verifier 120 || die "candidate verifier did not become healthy"
      ;;
    verify-local)
      "${SCRIPT_DIR}/verify-deployment-local.sh" --revision "${REVISION}" \
        --compose-file "${REFUNDDESK_COMPOSE_FILE}" --release-env "$1" \
        --expected-postgres-id "$2" --expected-database-sha256 "$3"
      ;;
    *) die "unknown contained host operation: ${operation}" ;;
  esac
}

assert_input_file() {
  local path="$1"
  [[ -f "${path}" && ! -L "${path}" ]] || die "input must be a regular non-symlink file: ${path}"
  if [[ "${TEST_MODE}" != "1" ]]; then
    assert_root_control_file "${path}"
  fi
}

ARTIFACT_DIR="$(readlink --canonicalize-existing -- "${ARTIFACT_DIR}")"
PROVENANCE_FILE="$(readlink --canonicalize-existing -- "${PROVENANCE_FILE}")"
[[ -d "${ARTIFACT_DIR}" && ! -L "${ARTIFACT_DIR}" ]] || die "artifact directory is unsafe"
for path in "${BUNDLE_PATH}" "${CHECKSUM_PATH}" "${MANIFEST_PATH}" "${PROVENANCE_FILE}" \
  "${SOURCE_REVISION_FILE}" "${SOURCE_DIGEST_FILE}" "${REFUNDDESK_COMPOSE_FILE}" \
  "${ROTATION_STATE_FILE}" "${TRANSITION_HELPER}"; do
  assert_input_file "${path}"
done
[[ "$(<"${SOURCE_REVISION_FILE}")" == "${REVISION}" ]] || die "installed source revision differs"
[[ "$(<"${SOURCE_DIGEST_FILE}")" == "${EXPECTED_SOURCE_SHA256}" ]] || die "installed source digest differs"
[[ "$(sha256sum -- "${BUNDLE_PATH}" | awk '{print $1}')" == "${EXPECTED_BUNDLE_SHA256}" ]] || die "bundle digest differs"
[[ "$(sha256sum -- "${MANIFEST_PATH}" | awk '{print $1}')" == "${EXPECTED_MANIFEST_SHA256}" ]] || die "manifest digest differs"
[[ "$(sha256sum -- "${PROVENANCE_FILE}" | awk '{print $1}')" == "${EXPECTED_PROVENANCE_SHA256}" ]] || die "provenance digest differs"
read -r adjacent_hash adjacent_name adjacent_extra <"${CHECKSUM_PATH}"
adjacent_name="${adjacent_name#\\*}"
[[ "${adjacent_hash}" == "${EXPECTED_BUNDLE_SHA256}" && "${adjacent_name}" == "${BUNDLE_NAME}" && -z "${adjacent_extra:-}" ]] ||
  die "adjacent bundle checksum is invalid"
if [[ "${TEST_MODE}" != "1" ]]; then zstd --test --quiet -- "${BUNDLE_PATH}" || die "bundle integrity failed"; fi

jq --exit-status --arg revision "${REVISION}" --arg bundle "${BUNDLE_NAME}" --arg sha "${EXPECTED_BUNDLE_SHA256}" '
  type == "object" and keys == ["bundle","createdAt","images","platform","revision","schemaVersion","source"]
  and .schemaVersion == 1 and .revision == $revision and .platform == "linux/amd64"
  and .source == "https://github.com/selimhehe1/RefundDesk"
  and (.createdAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  and .bundle == {file:$bundle,sha256:$sha}
  and (.images | length == 3) and ([.images[].role] | sort == ["migrate","web","worker"])
  and all(.images[]; keys == ["expectedUser","imageId","reference","role"] and .expectedUser == "node"
    and (.imageId | test("^sha256:[0-9a-f]{64}$"))
    and .reference == ("refunddesk-" + .role + ":sandbox-" + $revision))
' "${MANIFEST_PATH}" >/dev/null || die "manifest contract is invalid"

jq --exit-status --arg revision "${REVISION}" --arg source "${EXPECTED_SOURCE_SHA256}" \
  --arg manifest "${EXPECTED_MANIFEST_SHA256}" --arg bundle "${EXPECTED_BUNDLE_SHA256}" '
  type == "object" and keys == ["artifactId","attestationBundleSha256","attestationId","bundleEvent","bundleRunId","bundleSha256","bundleWorkflowPath","ciEvent","ciRunId","ciWorkflowPath","kind","manifestSha256","rekorEntryIndex","repository","revision","schemaVersion","sourceSha256","verification","verifiedAt"]
  and .schemaVersion == 1 and .kind == "refunddesk-contained-promotion-input-provenance"
  and .repository == "selimhehe1/RefundDesk" and .revision == $revision
  and .sourceSha256 == $source and .manifestSha256 == $manifest and .bundleSha256 == $bundle
  and (.attestationBundleSha256 | type == "string" and test("^[0-9a-f]{64}$"))
  and .verification == "github-cli-sigstore-and-actions-api-verified"
  and .ciWorkflowPath == ".github/workflows/ci.yml" and .bundleWorkflowPath == ".github/workflows/sandbox-images.yml"
  and .ciEvent == "push" and .bundleEvent == "workflow_dispatch"
  and (.verifiedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  and all(.artifactId,.attestationId,.bundleRunId,.ciRunId,.rekorEntryIndex; type == "number" and floor == . and . > 0)
' "${PROVENANCE_FILE}" >/dev/null || die "candidate provenance contract is invalid"

FROM_REVISION=""
PHASE=0
RESUMED=false
STARTED_AT=""
OPERATION_STARTED_AT=""
POSTGRES_ID=""
DATABASE_LINE=""
DATABASE_SHA256=""
PROMOTION_STARTED=false
COMMIT_STARTED=false
DATABASE_MIGRATION_ATTEMPTED=false

valid_invocation_timestamps() {
  python3 - "$1" "$2" "$3" <<'PY'
from datetime import datetime
import sys

operation_started = datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ")
invocation_started = datetime.strptime(sys.argv[2], "%Y-%m-%dT%H:%M:%SZ")
completed = datetime.strptime(sys.argv[3], "%Y-%m-%dT%H:%M:%SZ")
valid = (
    operation_started <= invocation_started <= completed
    and (completed - invocation_started).total_seconds() <= 900
)
raise SystemExit(0 if valid else 1)
PY
}

write_journal() {
  local phase_name="$1" sequence="$2" temporary
  temporary="$(mktemp "${REFUNDDESK_CONTROL_ROOT}/.contained-journal.XXXXXX")"
  jq --compact-output --sort-keys --null-input \
    --arg kind "refunddesk-contained-promotion-journal" --arg nonce "${NONCE}" \
    --arg revision "${REVISION}" --arg fromRevision "${FROM_REVISION}" \
    --arg operationStartedAt "${OPERATION_STARTED_AT}" --arg startedAt "${STARTED_AT}" \
    --arg bundle "${EXPECTED_BUNDLE_SHA256}" --arg manifest "${EXPECTED_MANIFEST_SHA256}" \
    --arg source "${EXPECTED_SOURCE_SHA256}" --arg provenance "${EXPECTED_PROVENANCE_SHA256}" \
    --arg phase "${phase_name}" --argjson sequence "${sequence}" \
    --arg postgres "${POSTGRES_ID}" --arg databaseLine "${DATABASE_LINE}" \
    --arg databaseSha256 "${DATABASE_SHA256}" '{
      baseline:{databaseLine:$databaseLine,databaseSha256:$databaseSha256,postgresContainerId:$postgres},
      fromRevision:$fromRevision,
      inputs:{bundleSha256:$bundle,manifestSha256:$manifest,provenanceSha256:$provenance,sourceSha256:$source},
      kind:$kind,nonce:$nonce,operationStartedAt:$operationStartedAt,revision:$revision,
      schemaVersion:1,startedAt:$startedAt,state:{phase:$phase,sequence:$sequence}
    }' >"${temporary}"
  atomic_install "${temporary}" "${JOURNAL_FILE}" 0600
  rm -f -- "${temporary}"
  PHASE="${sequence}"
  if [[ "${TEST_MODE}" == "1" && "${REFUNDDESK_CONTAINED_PROMOTION_TEST_CRASH_AFTER:-}" == "${phase_name}" ]]; then
    kill -KILL "$$"
  fi
}

load_journal() {
  local persisted_started_at
  jq --exit-status --arg nonce "${NONCE}" --arg revision "${REVISION}" \
    --arg bundle "${EXPECTED_BUNDLE_SHA256}" --arg manifest "${EXPECTED_MANIFEST_SHA256}" \
    --arg source "${EXPECTED_SOURCE_SHA256}" --arg provenance "${EXPECTED_PROVENANCE_SHA256}" '
    type == "object" and keys == ["baseline","fromRevision","inputs","kind","nonce","operationStartedAt","revision","schemaVersion","startedAt","state"]
    and .schemaVersion == 1 and .kind == "refunddesk-contained-promotion-journal"
    and .nonce == $nonce and .revision == $revision
    and .inputs == {bundleSha256:$bundle,manifestSha256:$manifest,provenanceSha256:$provenance,sourceSha256:$source}
    and (.fromRevision | test("^[0-9a-f]{40}$"))
    and (.baseline.postgresContainerId | test("^[0-9a-f]{64}$"))
    and (.baseline.databaseLine | test("^[1-9][0-9]{17,19}(\\|[0-9]+){12}$"))
    and (.baseline.databaseSha256 | test("^[0-9a-f]{64}$"))
    and (.operationStartedAt | test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and (.startedAt | test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and (.state.sequence == 10 or .state.sequence == 20 or .state.sequence == 30 or .state.sequence == 40 or .state.sequence == 50 or .state.sequence == 55 or .state.sequence == 60 or .state.sequence == 70 or .state.sequence == 80)
  ' "${JOURNAL_FILE}" >/dev/null || die "unfinished contained promotion differs from this exact invocation"
  FROM_REVISION="$(jq -r '.fromRevision' "${JOURNAL_FILE}")"
  POSTGRES_ID="$(jq -r '.baseline.postgresContainerId' "${JOURNAL_FILE}")"
  DATABASE_LINE="$(jq -r '.baseline.databaseLine' "${JOURNAL_FILE}")"
  DATABASE_SHA256="$(jq -r '.baseline.databaseSha256' "${JOURNAL_FILE}")"
  PHASE="$(jq -r '.state.sequence' "${JOURNAL_FILE}")"
  OPERATION_STARTED_AT="$(jq -r '.operationStartedAt' "${JOURNAL_FILE}")"
  persisted_started_at="$(jq -r '.startedAt' "${JOURNAL_FILE}")"
  valid_invocation_timestamps "${OPERATION_STARTED_AT}" "${persisted_started_at}" "${persisted_started_at}" ||
    die "unfinished promotion timestamps are invalid"
  STARTED_AT="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  valid_invocation_timestamps "${OPERATION_STARTED_AT}" "${STARTED_AT}" "${STARTED_AT}" ||
    die "system clock precedes the durable promotion start"
  RESUMED=true
  (( PHASE < PHASE_DATABASE_PREPARED )) || DATABASE_MIGRATION_ATTEMPTED=true
  (( PHASE < PHASE_COMMITTING )) || COMMIT_STARTED=true
}

replay_completed_evidence() {
  local canonical_tmp evidence_line evidence_sha current_target snapshot runtime_ids
  assert_input_file "${EVIDENCE_FILE}"
  canonical_tmp="$(mktemp "${REFUNDDESK_CONTROL_ROOT}/.contained-canonical.XXXXXX")"
  jq --sort-keys --compact-output . "${EVIDENCE_FILE}" >"${canonical_tmp}" ||
    die "completed promotion evidence is not valid JSON"
  cmp --silent "${canonical_tmp}" "${EVIDENCE_FILE}" || die "completed promotion evidence is not canonical"
  rm -f -- "${canonical_tmp}"
  jq --exit-status --arg revision "${REVISION}" --arg nonce "${NONCE}" \
    --arg bundle "${EXPECTED_BUNDLE_SHA256}" --arg manifest "${EXPECTED_MANIFEST_SHA256}" \
    --arg source "${EXPECTED_SOURCE_SHA256}" --arg provenance "${EXPECTED_PROVENANCE_SHA256}" '
    type == "object"
    and keys == ["code","completedAt","containment","database","fromRevision","inputs","kind","nonce","operationStartedAt","phase","redaction","result","resumed","revision","runtime","schemaVersion","startedAt"]
    and .schemaVersion == 1 and .kind == "refunddesk-contained-promotion"
    and .result == "PASS" and .code == "PASS_CONTAINED_CANDIDATE_PROMOTED" and .phase == "complete"
    and .revision == $revision and .nonce == $nonce and .fromRevision != $revision
    and (.fromRevision | test("^[0-9a-f]{40}$")) and (.resumed | type == "boolean")
    and .inputs == {bundleSha256:$bundle,manifestSha256:$manifest,provenanceSha256:$provenance,sourceSha256:$source}
    and .containment == {caddyStopped:true,liveDisabled:true,maintenanceDisabled:true,maintenanceStopped:true,publicListenersAbsent:true,timersDisabled:true,verifierHealthy:true,webHealthy:true,workerStopped:true}
    and .redaction == {customerDataPresent:false,rawApiKeyPresent:false,rawPayloadPresent:false,rawSecretPresent:false,rawSignaturePresent:false,stderrPresent:false}
    and (.operationStartedAt | test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and (.startedAt | test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and (.completedAt | test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and (.resumed == true or .operationStartedAt == .startedAt)
    and (.database | keys == ["activeFinancialJobs","activeWorkflows","apiMutationReceipts","auditEvents","liveInstallations","liveTenants","preparedTransactions","refundExecutionAttempts","refundExecutions","refundRequests","snapshotSha256","stable","systemIdentifier","unreleasedPaymentGuards","webhookReceipts"])
    and .database.stable == true and (.database.systemIdentifier | test("^[1-9][0-9]{17,19}$"))
    and (.database.snapshotSha256 | test("^[0-9a-f]{64}$"))
    and all(.database.activeFinancialJobs,.database.activeWorkflows,.database.apiMutationReceipts,
      .database.auditEvents,.database.liveInstallations,.database.liveTenants,.database.preparedTransactions,
      .database.refundExecutionAttempts,.database.refundExecutions,.database.refundRequests,
      .database.unreleasedPaymentGuards,.database.webhookReceipts; type == "number" and floor == . and . >= 0)
    and .database.activeFinancialJobs == 0 and .database.activeWorkflows == 0
    and .database.liveInstallations == 0 and .database.liveTenants == 0
    and .database.preparedTransactions == 0 and .database.unreleasedPaymentGuards == 0
    and (.runtime | keys == ["caddyContainerId","postgresContainerId","verifierContainerId","webContainerId","workerContainerId","workerRuntimeMode"])
    and all([.runtime.caddyContainerId,.runtime.postgresContainerId,.runtime.verifierContainerId,.runtime.webContainerId,.runtime.workerContainerId][];
      type == "string" and test("^[0-9a-f]{64}$"))
    and ([.runtime.caddyContainerId,.runtime.postgresContainerId,.runtime.verifierContainerId,.runtime.webContainerId,.runtime.workerContainerId] | unique | length == 5)
    and .runtime.workerRuntimeMode == "incident_admission"
  ' "${EVIDENCE_FILE}" >/dev/null || die "completed promotion evidence differs from this exact invocation"
  valid_invocation_timestamps \
    "$(jq -r '.operationStartedAt' "${EVIDENCE_FILE}")" \
    "$(jq -r '.startedAt' "${EVIDENCE_FILE}")" \
    "$(jq -r '.completedAt' "${EVIDENCE_FILE}")" ||
    die "completed promotion timestamps are unordered"
  FROM_REVISION="$(jq -r '.fromRevision' "${EVIDENCE_FILE}")"
  STARTED_AT="$(jq -r '.startedAt' "${EVIDENCE_FILE}")"
  OPERATION_STARTED_AT="$(jq -r '.operationStartedAt' "${EVIDENCE_FILE}")"
  POSTGRES_ID="$(jq -r '.runtime.postgresContainerId' "${EVIDENCE_FILE}")"
  evidence_line="$(jq -r '[.database.systemIdentifier,.database.activeWorkflows,.database.unreleasedPaymentGuards,.database.activeFinancialJobs,.database.liveTenants,.database.liveInstallations,.database.preparedTransactions,.database.refundRequests,.database.refundExecutions,.database.refundExecutionAttempts,.database.webhookReceipts,.database.apiMutationReceipts,.database.auditEvents] | map(tostring) | join("|")' "${EVIDENCE_FILE}")"
  evidence_sha="$(printf '%s' "${evidence_line}" | sha256sum | awk '{print $1}')"
  [[ "${evidence_sha}" == "$(jq -r '.database.snapshotSha256' "${EVIDENCE_FILE}")" ]] ||
    die "completed promotion database digest is incoherent"
  DATABASE_LINE="${evidence_line}"
  DATABASE_SHA256="${evidence_sha}"
  if [[ -e "${JOURNAL_FILE}" || -L "${JOURNAL_FILE}" ]]; then
    assert_input_file "${JOURNAL_FILE}"
    load_journal
    (( PHASE == PHASE_COMPLETE )) || die "completed evidence has an unfinished journal"
    [[ "${POSTGRES_ID}" == "$(jq -r '.runtime.postgresContainerId' "${EVIDENCE_FILE}")" &&
      "${DATABASE_LINE}" == "${evidence_line}" && "${DATABASE_SHA256}" == "${evidence_sha}" ]] ||
      die "completed journal differs from immutable evidence"
  fi
  assert_input_file "${ACTIVE_REVISION_FILE}"
  [[ "$(<"${ACTIVE_REVISION_FILE}")" == "${REVISION}" ]] || die "completed active revision differs"
  [[ -L "${CURRENT_LINK}" ]] || die "completed current source link is absent"
  current_target="$(readlink --canonicalize-existing -- "${CURRENT_LINK}")"
  [[ "${current_target}" == "${SOURCE_ROOT}" ]] || die "completed current source differs"
  assert_input_file "${CANONICAL_RELEASE_ENV}"
  mapfile -t completed_release_lines <"${CANONICAL_RELEASE_ENV}"
  (( ${#completed_release_lines[@]} == 3 )) || die "completed release environment cardinality differs"
  [[ "${completed_release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${REVISION}" &&
    "${completed_release_lines[1]}" == "REFUNDDESK_REVISION=${REVISION}" &&
    "${completed_release_lines[2]}" == "REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission" ]] ||
    die "completed release environment differs"
  assert_input_file "${INSTALLED_MANIFEST}"
  cmp --silent "${MANIFEST_PATH}" "${INSTALLED_MANIFEST}" || die "completed installed manifest differs"
  assert_input_file "${ROTATION_STATE_FILE}"
  assert_input_file "${ROTATION_COMMIT_FILE}"
  jq --exit-status --arg revision "${REVISION}" '
    type == "object" and keys == ["fingerprints","revision","schemaVersion","states"]
    and .schemaVersion == 2 and .revision == $revision
    and (.fingerprints | keys == ["approvalAttestation","field","proof"])
    and all(.fingerprints[]; keys == ["v1","v2"] and all(.[]; . == null or (type == "string" and test("^sha256:[0-9a-f]{64}$"))))
    and (.states | keys == ["approvalAttestation","field","proof"])
    and all(.states[]; . == "legacy" or . == "staged" or . == "active" or . == "rollback")
  ' "${ROTATION_STATE_FILE}" >/dev/null || die "completed application-key authority differs"
  jq --exit-status --arg from "${FROM_REVISION}" --arg to "${REVISION}" --slurpfile state "${ROTATION_STATE_FILE}" '
    type == "object" and keys == ["from","schemaVersion","status","to"]
    and .schemaVersion == 1 and .status == "committed"
    and .from == {fingerprints:$state[0].fingerprints,recorded:true,revision:$from,states:$state[0].states}
    and .to == {fingerprints:$state[0].fingerprints,recorded:true,revision:$to,states:$state[0].states}
  ' "${ROTATION_COMMIT_FILE}" >/dev/null || die "completed application-key commit differs"
  mapfile -t runtime_ids < <(jq -r '.runtime | [.postgresContainerId,.verifierContainerId,.webContainerId,.workerContainerId,.caddyContainerId][]' "${EVIDENCE_FILE}")
  host_call assert-completed-state "${REVISION}" "${runtime_ids[@]}"
  snapshot="$(host_call snapshot)"
  [[ "${snapshot}" == "${POSTGRES_ID}|${DATABASE_LINE}" ]] || die "completed database or identity changed"
  if [[ -e "${JOURNAL_FILE}" || -L "${JOURNAL_FILE}" ]]; then durable_unlink "${JOURNAL_FILE}"; fi
  if [[ -e "${STAGING_RELEASE_ENV}" || -L "${STAGING_RELEASE_ENV}" ]]; then durable_unlink "${STAGING_RELEASE_ENV}"; fi
}

emit_failure() {
  local containment_reasserted="$1" code result phase_name temporary completed_at
  if [[ "${COMMIT_STARTED}" == "true" ]]; then
    code="INCOMPLETE_CONTAINED_PROMOTION_POST_COMMIT"
    result="INCOMPLETE"
  else
    code="FAIL_CONTAINED_PROMOTION_PRE_COMMIT"
    result="FAIL"
  fi
  phase_name="$(jq -r '.state.phase // "pre_journal"' "${JOURNAL_FILE}" 2>/dev/null || printf pre_journal)"
  completed_at="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  if ! valid_invocation_timestamps "${OPERATION_STARTED_AT}" "${STARTED_AT}" "${completed_at}"; then
    log "promotion invocation timestamps exceed their admissible window; no terminal evidence was written"
    return 1
  fi
  temporary="$(mktemp "${REFUNDDESK_CONTROL_ROOT}/.contained-failure.XXXXXX")"
  jq -S -c -n --arg code "${code}" --arg result "${result}" --arg nonce "${NONCE}" \
    --arg revision "${REVISION}" --arg fromRevision "${FROM_REVISION}" \
    --arg phase "${phase_name}" --arg operationStartedAt "${OPERATION_STARTED_AT}" \
    --arg startedAt "${STARTED_AT}" --arg completedAt "${completed_at}" \
    --arg bundle "${EXPECTED_BUNDLE_SHA256}" --arg manifest "${EXPECTED_MANIFEST_SHA256}" \
    --arg provenance "${EXPECTED_PROVENANCE_SHA256}" --arg source "${EXPECTED_SOURCE_SHA256}" \
    --argjson commitReached "${COMMIT_STARTED}" --argjson containmentReasserted "${containment_reasserted}" \
    --argjson migrationAttempted "${DATABASE_MIGRATION_ATTEMPTED}" '{
      code:$code,completedAt:$completedAt,
      effects:{caddyStarted:false,commitReached:$commitReached,containmentReasserted:$containmentReasserted,databaseMigrationAttempted:$migrationAttempted,edgeChanged:false,financialEffectAttempted:false,publicServicesStarted:false,remotePromotionPassed:false,sourceInstalled:true,workerStarted:false},
      fromRevision:$fromRevision,
      inputs:{bundleSha256:$bundle,manifestSha256:$manifest,provenanceSha256:$provenance,sourceSha256:$source},
      kind:"refunddesk-contained-promotion",nonce:$nonce,operationStartedAt:$operationStartedAt,phase:$phase,
      redaction:{customerDataPresent:false,rawApiKeyPresent:false,rawPayloadPresent:false,rawSecretPresent:false,rawSignaturePresent:false,stderrPresent:false},
      result:$result,revision:$revision,schemaVersion:1,startedAt:$startedAt
    }' >"${temporary}"
  atomic_install "${temporary}" "${FAILURE_FILE}" 0600 || { rm -f -- "${temporary}"; return 1; }
  rm -f -- "${temporary}"
}

cleanup() {
  local status=$? containment_reasserted=false contract_status
  trap - EXIT
  if (( status != 0 )) && [[ "${PROMOTION_STARTED}" == "true" ]]; then
    if host_call contain >/dev/null 2>&1; then containment_reasserted=true; fi
    if emit_failure "${containment_reasserted}"; then
      cat "${FAILURE_FILE}"
    else
      log "contained promotion failed without terminal evidence; the durable journal was preserved"
    fi
    log "contained promotion failed; journal and stopped candidate evidence were preserved"
    if [[ "${COMMIT_STARTED}" == "true" ]]; then contract_status=21; else contract_status=20; fi
    exit "${contract_status}"
  fi
  exit "${status}"
}
trap cleanup EXIT

if [[ -e "${EVIDENCE_FILE}" || -L "${EVIDENCE_FILE}" ]]; then
  replay_completed_evidence
  trap - EXIT
  cat "${EVIDENCE_FILE}"
  exit 0
fi

if [[ -e "${JOURNAL_FILE}" || -L "${JOURNAL_FILE}" ]]; then
  assert_input_file "${JOURNAL_FILE}"
  load_journal
else
  assert_input_file "${ACTIVE_REVISION_FILE}"
  FROM_REVISION="$(<"${ACTIVE_REVISION_FILE}")"
  [[ "${FROM_REVISION}" =~ ^[0-9a-f]{40}$ ]] || die "active revision marker is invalid"
  [[ "${FROM_REVISION}" != "${REVISION}" ]] || die "candidate is already the active revision without exact promotion evidence"
  STARTED_AT="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  OPERATION_STARTED_AT="${STARTED_AT}"
  jq --exit-status --arg revision "${FROM_REVISION}" '
    type == "object" and keys == ["fingerprints","revision","schemaVersion","states"]
    and .schemaVersion == 2 and .revision == $revision
    and (.fingerprints | keys == ["approvalAttestation","field","proof"])
    and all(.fingerprints[]; keys == ["v1","v2"] and all(.[]; . == null or (type == "string" and test("^sha256:[0-9a-f]{64}$"))))
    and (.states | keys == ["approvalAttestation","field","proof"])
    and all(.states[]; . == "legacy" or . == "staged" or . == "active" or . == "rollback")
  ' "${ROTATION_STATE_FILE}" >/dev/null || die "existing application-key authority is not an exact forwardable state"
  if [[ "${TEST_MODE}" != "1" ]]; then
    target_fingerprints="$(mktemp "${REFUNDDESK_CONTROL_ROOT}/.target-fingerprints.XXXXXX")"
    python3 "${TRANSITION_HELPER}" fingerprint-env \
      --platform "${REFUNDDESK_CONFIG_ROOT}/platform.env" \
      --worker "${REFUNDDESK_CONFIG_ROOT}/worker.env" >"${target_fingerprints}" ||
      die "candidate application-key fingerprints are unavailable"
    jq --exit-status --slurpfile target "${target_fingerprints}" '.fingerprints == $target[0]' \
      "${ROTATION_STATE_FILE}" >/dev/null || die "candidate would change application-key authority"
    rm -f -- "${target_fingerprints}"
  fi
  host_call assert-inventory "${FROM_REVISION}"
  host_call assert-owner-reservation "${FROM_REVISION}"
  snapshot="$(host_call snapshot)"
  POSTGRES_ID="${snapshot%%|*}"
  DATABASE_LINE="${snapshot#*|}"
  [[ "${POSTGRES_ID}" =~ ^[0-9a-f]{64}$ && "${DATABASE_LINE}" =~ ^[1-9][0-9]{17,19}(\|[0-9]+){12}$ ]] ||
    die "baseline database snapshot is invalid"
  IFS='|' read -r _baseline_system baseline_active baseline_guards baseline_jobs \
    baseline_live_tenants baseline_live_installations baseline_prepared \
    _baseline_refund_requests _baseline_refund_executions _baseline_refund_execution_attempts \
    _baseline_webhook_receipts _baseline_api_mutation_receipts _baseline_audit_events <<<"${DATABASE_LINE}"
  (( baseline_active == 0 && baseline_guards == 0 && baseline_jobs == 0 &&
    baseline_live_tenants == 0 && baseline_live_installations == 0 && baseline_prepared == 0 )) ||
    die "baseline database is not financially quiescent"
  DATABASE_SHA256="$(printf '%s' "${DATABASE_LINE}" | sha256sum | awk '{print $1}')"
  PROMOTION_STARTED=true
  write_journal prepared "${PHASE_PREPARED}"
fi
PROMOTION_STARTED=true

printf 'REFUNDDESK_IMAGE_TAG=sandbox-%s\nREFUNDDESK_REVISION=%s\nREFUNDDESK_RUNTIME_RESTART_POLICY=no\nREFUNDDESK_WORKER_RUNTIME_MODE=incident_admission\n' \
  "${REVISION}" "${REVISION}" | atomic_text "${STAGING_RELEASE_ENV}" 0600

if (( PHASE < PHASE_CONTAINED )); then host_call contain; write_journal contained "${PHASE_CONTAINED}"; fi
if (( PHASE < PHASE_IMAGES_LOADED )); then
  host_call load-images
  host_call validate-config
  write_journal images_loaded "${PHASE_IMAGES_LOADED}"
fi
if (( PHASE < PHASE_DATABASE_PREPARED )); then
  DATABASE_MIGRATION_ATTEMPTED=true
  host_call migrate
  after_migration="$(host_call snapshot)"
  [[ "${after_migration}" == "${POSTGRES_ID}|${DATABASE_LINE}" ]] || die "database identity or counts changed during owner migration"
  write_journal database_prepared "${PHASE_DATABASE_PREPARED}"
fi
if (( PHASE < PHASE_CANDIDATE_INERT )); then
  host_call recreate
  write_journal candidate_inert "${PHASE_CANDIDATE_INERT}"
fi
if (( PHASE < PHASE_CANDIDATE_VERIFIED )); then
  host_call start-core
  verification_json="$(host_call verify-local "${STAGING_RELEASE_ENV}" "${POSTGRES_ID}" "${DATABASE_SHA256}")"
  jq --exit-status --arg revision "${REVISION}" --arg database "${DATABASE_SHA256}" '
    .kind == "refunddesk-contained-local-verification" and .schemaVersion == 1
    and .revision == $revision and .database.stable == true and .database.snapshotSha256 == $database
    and .runtime.workerRuntimeMode == "incident_admission"
  ' <<<"${verification_json}" >/dev/null || die "local candidate verification result is invalid"
  write_journal candidate_verified "${PHASE_CANDIDATE_VERIFIED}"
fi

if (( PHASE < PHASE_COMMITTING )); then
  write_journal committing "${PHASE_COMMITTING}"
  COMMIT_STARTED=true
fi

commit_metadata() {
  local temporary current_tmp rotation_target commit_target
  mkdir -p -- "${TARGET_RELEASE_DIR}"
  if [[ -e "${INSTALLED_MANIFEST}" || -L "${INSTALLED_MANIFEST}" ]]; then
    assert_input_file "${INSTALLED_MANIFEST}"
    cmp --silent "${MANIFEST_PATH}" "${INSTALLED_MANIFEST}" || die "installed manifest differs from candidate"
  else
    atomic_install "${MANIFEST_PATH}" "${INSTALLED_MANIFEST}" 0644
  fi
  current_tmp="${REFUNDDESK_ROOT}/.current-contained-${NONCE:0:12}"
  rm -f -- "${current_tmp}"
  ln -s "${SOURCE_ROOT}" "${current_tmp}"
  mv -Tf -- "${current_tmp}" "${CURRENT_LINK}"
  python3 - "${REFUNDDESK_ROOT}" <<'PY'
import os, sys
d = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try: os.fsync(d)
finally: os.close(d)
PY
  printf 'REFUNDDESK_IMAGE_TAG=sandbox-%s\nREFUNDDESK_REVISION=%s\nREFUNDDESK_WORKER_RUNTIME_MODE=incident_admission\n' "${REVISION}" "${REVISION}" |
    atomic_text "${CANONICAL_RELEASE_ENV}" 0600

  temporary="$(mktemp "${REFUNDDESK_CONTROL_ROOT}/.rotation-target.XXXXXX")"
  if [[ -f "${ROTATION_STATE_FILE}" && ! -L "${ROTATION_STATE_FILE}" ]]; then
    jq --exit-status '
      .schemaVersion == 2 and keys == ["fingerprints","revision","schemaVersion","states"]
    ' "${ROTATION_STATE_FILE}" >/dev/null || die "rotation state cannot be forwarded"
    jq -S -c --arg revision "${REVISION}" '.revision=$revision' "${ROTATION_STATE_FILE}" >"${temporary}"
  else
    die "rotation state disappeared during contained promotion"
  fi
  rotation_target="$(<"${temporary}")"
  commit_target="$(jq -S -c -n --arg from "${FROM_REVISION}" --arg to "${REVISION}" --argjson target "${rotation_target}" '
    def side($revision;$value): {fingerprints:$value.fingerprints,recorded:true,revision:$revision,states:$value.states};
    {from:side($from;$target),schemaVersion:1,status:"committed",to:side($to;$target)}')"
  atomic_install "${temporary}" "${ROTATION_STATE_FILE}" 0600
  printf '%s\n' "${commit_target}" | atomic_text "${ROTATION_COMMIT_FILE}" 0600
  rm -f -- "${temporary}"
  printf '%s\n' "${REVISION}" | atomic_text "${ACTIVE_REVISION_FILE}" 0644
}

if (( PHASE < PHASE_METADATA_COMMITTED )); then
  commit_metadata
  write_journal metadata_committed "${PHASE_METADATA_COMMITTED}"
fi

# Forward recovery always reasserts the committed candidate and contained core.
commit_metadata
host_call contain
host_call start-core
verification_json="$(host_call verify-local "${CANONICAL_RELEASE_ENV}" "${POSTGRES_ID}" "${DATABASE_SHA256}")"
jq --exit-status --arg revision "${REVISION}" --arg database "${DATABASE_SHA256}" '
  .kind == "refunddesk-contained-local-verification" and .schemaVersion == 1
  and .revision == $revision and .database.stable == true and .database.snapshotSha256 == $database
  and .runtime.workerRuntimeMode == "incident_admission"
' <<<"${verification_json}" >/dev/null || die "committed local verification result is invalid"
final_snapshot="$(host_call snapshot)"
[[ "${final_snapshot}" == "${POSTGRES_ID}|${DATABASE_LINE}" ]] || die "final database identity or counts changed"
host_call assert-inventory "${REVISION}"
host_call assert-owner-reservation "${REVISION}"

write_journal complete "${PHASE_COMPLETE}"
IFS='|' read -r system_identifier active_workflows unreleased_guards active_jobs live_tenants \
  live_installations prepared_transactions refund_requests refund_executions \
  refund_execution_attempts webhook_receipts api_mutation_receipts audit_events <<<"${DATABASE_LINE}"
temporary="$(mktemp "${REFUNDDESK_CONTROL_ROOT}/.contained-evidence.XXXXXX")"
COMPLETED_AT="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
valid_invocation_timestamps "${OPERATION_STARTED_AT}" "${STARTED_AT}" "${COMPLETED_AT}" ||
  die "promotion invocation timestamps exceed their admissible window"
jq -S -c -n \
  --arg revision "${REVISION}" --arg fromRevision "${FROM_REVISION}" --arg nonce "${NONCE}" \
  --arg operationStartedAt "${OPERATION_STARTED_AT}" \
  --arg startedAt "${STARTED_AT}" --arg completedAt "${COMPLETED_AT}" \
  --arg bundle "${EXPECTED_BUNDLE_SHA256}" --arg manifest "${EXPECTED_MANIFEST_SHA256}" \
  --arg provenance "${EXPECTED_PROVENANCE_SHA256}" --arg source "${EXPECTED_SOURCE_SHA256}" \
  --arg databaseSha256 "${DATABASE_SHA256}" --arg systemIdentifier "${system_identifier}" \
  --argjson resumed "${RESUMED}" \
  --argjson activeWorkflows "${active_workflows}" --argjson unreleasedPaymentGuards "${unreleased_guards}" \
  --argjson activeFinancialJobs "${active_jobs}" --argjson liveTenants "${live_tenants}" \
  --argjson liveInstallations "${live_installations}" --argjson preparedTransactions "${prepared_transactions}" \
  --argjson refundRequests "${refund_requests}" --argjson refundExecutions "${refund_executions}" \
  --argjson refundExecutionAttempts "${refund_execution_attempts}" --argjson webhookReceipts "${webhook_receipts}" \
  --argjson apiMutationReceipts "${api_mutation_receipts}" --argjson auditEvents "${audit_events}" \
  --arg postgres "$(jq -r '.runtime.postgresContainerId' <<<"${verification_json}")" \
  --arg verifier "$(jq -r '.runtime.verifierContainerId' <<<"${verification_json}")" \
  --arg web "$(jq -r '.runtime.webContainerId' <<<"${verification_json}")" \
  --arg worker "$(jq -r '.runtime.workerContainerId' <<<"${verification_json}")" \
  --arg caddy "$(jq -r '.runtime.caddyContainerId' <<<"${verification_json}")" '{
    code:"PASS_CONTAINED_CANDIDATE_PROMOTED",completedAt:$completedAt,
    containment:{caddyStopped:true,liveDisabled:true,maintenanceDisabled:true,maintenanceStopped:true,publicListenersAbsent:true,timersDisabled:true,verifierHealthy:true,webHealthy:true,workerStopped:true},
    database:{activeFinancialJobs:$activeFinancialJobs,activeWorkflows:$activeWorkflows,apiMutationReceipts:$apiMutationReceipts,auditEvents:$auditEvents,liveInstallations:$liveInstallations,liveTenants:$liveTenants,preparedTransactions:$preparedTransactions,refundExecutionAttempts:$refundExecutionAttempts,refundExecutions:$refundExecutions,refundRequests:$refundRequests,snapshotSha256:$databaseSha256,stable:true,systemIdentifier:$systemIdentifier,unreleasedPaymentGuards:$unreleasedPaymentGuards,webhookReceipts:$webhookReceipts},
    fromRevision:$fromRevision,
    inputs:{bundleSha256:$bundle,manifestSha256:$manifest,provenanceSha256:$provenance,sourceSha256:$source},
    kind:"refunddesk-contained-promotion",nonce:$nonce,operationStartedAt:$operationStartedAt,phase:"complete",
    redaction:{customerDataPresent:false,rawApiKeyPresent:false,rawPayloadPresent:false,rawSecretPresent:false,rawSignaturePresent:false,stderrPresent:false},
    result:"PASS",resumed:$resumed,revision:$revision,
    runtime:{caddyContainerId:$caddy,postgresContainerId:$postgres,verifierContainerId:$verifier,webContainerId:$web,workerContainerId:$worker,workerRuntimeMode:"incident_admission"},
    schemaVersion:1,startedAt:$startedAt
  }' >"${temporary}"
atomic_install "${temporary}" "${EVIDENCE_FILE}" 0600
rm -f -- "${temporary}"
if [[ "${TEST_MODE}" == "1" && "${REFUNDDESK_CONTAINED_PROMOTION_TEST_CRASH_AFTER:-}" == evidence_written ]]; then
  kill -KILL "$$"
fi
durable_unlink "${JOURNAL_FILE}"
durable_unlink "${STAGING_RELEASE_ENV}"
PROMOTION_STARTED=false
trap - EXIT
cat "${EVIDENCE_FILE}"
