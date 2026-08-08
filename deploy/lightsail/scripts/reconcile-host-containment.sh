#!/usr/bin/env bash

# One-time ADR 0035 reconciliation for the exact 8da RefundDesk sandbox host.
# This runner can only remove availability/effect surfaces. It never starts a
# container or unit, performs a release, contacts Stripe, or changes ingress.

set -uo pipefail
set +x
set +a
umask 077
export LC_ALL=C

readonly EXIT_FAIL=20
readonly EXIT_INCOMPLETE=21
readonly EXIT_USAGE=64
readonly MAX_OUTPUT_BYTES=131072
readonly EXACT_REVISION="8da280b78a9d1475c7bd79063e72c5af77121e8d"
readonly EXACT_MANIFEST_SHA256="e72319926d184db8e696c7d4d032d3f9e44cbabbde9b36e64c473da96ef241ca"
readonly EXACT_COMPOSE_SHA256="92a96553a38b226505957e717e2844960794256dceb5a5284fde0c00d22b4610"
readonly EXACT_COMMON_SHA256="e3582a5ccbac7be03731c1773cb3527c9ee6613796a131762b19041fa6918da6"
readonly EXACT_HELPER_SHA256="76fba53c93c450c202788a9fd12754e409e713a7b8407084723c440f01f7a6e6"
readonly POSTGRES_REFERENCE="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
readonly CADDY_REFERENCE="caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648"

if (( $# != 6 )) || [[ "$1" != "--nonce" || "$3" != "--expected-revision" ||
  "$5" != "--runner-sha256" || ! "$2" =~ ^[0-9a-f]{64}$ ||
  "$4" != "${EXACT_REVISION}" || ! "$6" =~ ^[0-9a-f]{64}$ ]]; then
  exit "${EXIT_USAGE}"
fi
readonly NONCE="$2"
readonly EXPECTED_REVISION="$4"
readonly RUNNER_SHA256="$6"

# Command diagnostics can contain paths, container IDs, environment values or
# Docker output. Only the allowlisted JSON diagnostics below may leave stdout.
exec 2>/dev/null

if [[ "${REFUNDDESK_CONTAINMENT_TEST_MODE:-}" == "1" ]]; then
  (( EUID != 0 )) || exit "${EXIT_USAGE}"
  ROOT="${REFUNDDESK_CONTAINMENT_ROOT:-}"
  CONFIG_ROOT="${REFUNDDESK_CONTAINMENT_CONFIG_ROOT:-}"
  CONTROL_ROOT="${REFUNDDESK_CONTAINMENT_CONTROL_ROOT:-}"
  RUNTIME_ROOT="${REFUNDDESK_CONTAINMENT_RUNTIME_ROOT:-}"
  OPERATOR_LOCK="${REFUNDDESK_CONTAINMENT_OPERATOR_LOCK:-}"
  EXPECTED_UID="$(id -u)"
  EXPECTED_GID="$(id -g)"
  SOURCE_MANIFEST_SHA256="${REFUNDDESK_CONTAINMENT_TEST_MANIFEST_SHA256:-}"
  [[ "${ROOT}" == /tmp/refunddesk-containment-test-* &&
    "${CONFIG_ROOT}" == /tmp/refunddesk-containment-test-* &&
    "${CONTROL_ROOT}" == /tmp/refunddesk-containment-test-* &&
    "${RUNTIME_ROOT}" == /tmp/refunddesk-containment-test-* &&
    "${OPERATOR_LOCK}" == /tmp/refunddesk-containment-test-* &&
    "${SOURCE_MANIFEST_SHA256}" =~ ^[0-9a-f]{64}$ ]] || exit "${EXIT_USAGE}"
  case "${REFUNDDESK_CONTAINMENT_TEST_KILL_POINT:-}" in
    ""|after_prepared|after_units|after_caddy|after_worker|after_contained_verified) ;;
    *) exit "${EXIT_USAGE}" ;;
  esac
else
  [[ -z "${REFUNDDESK_CONTAINMENT_ROOT:-}" &&
    -z "${REFUNDDESK_CONTAINMENT_CONFIG_ROOT:-}" &&
    -z "${REFUNDDESK_CONTAINMENT_CONTROL_ROOT:-}" &&
    -z "${REFUNDDESK_CONTAINMENT_RUNTIME_ROOT:-}" &&
    -z "${REFUNDDESK_CONTAINMENT_OPERATOR_LOCK:-}" &&
    -z "${REFUNDDESK_CONTAINMENT_TEST_MANIFEST_SHA256:-}" &&
    -z "${REFUNDDESK_CONTAINMENT_TEST_ABORT_AFTER_CLEAR:-}" &&
    -z "${REFUNDDESK_CONTAINMENT_TEST_KILL_POINT:-}" ]] || exit "${EXIT_USAGE}"
  (( EUID == 0 )) || exit "${EXIT_USAGE}"
  ROOT="/opt/refunddesk"
  CONFIG_ROOT="/etc/refunddesk"
  CONTROL_ROOT="/var/lib/refunddesk/control"
  RUNTIME_ROOT="/run"
  OPERATOR_LOCK="/run/refunddesk/operator.lock"
  EXPECTED_UID=0
  EXPECTED_GID=0
  SOURCE_MANIFEST_SHA256="${EXACT_MANIFEST_SHA256}"
fi
readonly ROOT CONFIG_ROOT CONTROL_ROOT RUNTIME_ROOT OPERATOR_LOCK
readonly EXPECTED_UID EXPECTED_GID SOURCE_MANIFEST_SHA256
readonly EXPECTED_MANIFEST_SHA256="${EXACT_MANIFEST_SHA256}"

readonly SOURCE_ROOT="${ROOT}/releases/${EXPECTED_REVISION}/source"
readonly COMPOSE_FILE="${SOURCE_ROOT}/deploy/lightsail/compose.yml"
readonly COMMON_FILE="${SOURCE_ROOT}/deploy/lightsail/scripts/_common.sh"
readonly HELPER_FILE="${SOURCE_ROOT}/deploy/lightsail/scripts/release-transition-journal.py"
readonly MANIFEST_FILE="${ROOT}/releases/${EXPECTED_REVISION}/manifest.json"
readonly RELEASE_ENV="${CONFIG_ROOT}/release.env"
readonly PLATFORM_ENV="${CONFIG_ROOT}/platform.env"
readonly WORKER_ENV="${CONFIG_ROOT}/worker.env"
readonly QUIESCE_JOURNAL="${CONTROL_ROOT}/runtime-quiesce-in-progress.json"
readonly SUCCESSOR_MARKER="${CONTROL_ROOT}/containment-reconciliation.json"
readonly APPLICATION_TRANSITION="${CONFIG_ROOT}/application-key-transition-in-progress.json"
readonly LEGACY_APP_TRANSITION="${CONFIG_ROOT}/stripe-app-id-transition-in-progress.json"
readonly MANAGED_TRANSITION="${CONFIG_ROOT}/managed-sandbox-three-binding-transition-in-progress.json"
readonly BACKUP_UPLOAD_JOURNAL="${CONTROL_ROOT}/backup-upload-in-progress.json"

STARTED_AT=""
OPERATION=""
JOURNAL_SHA256=""
MARKER_STATE="absent"
DIAGNOSTIC="CONTROL_STATE_UNAVAILABLE"
RESULT_EXIT="${EXIT_INCOMPLETE}"
FENCE_ARMED=false
OUTPUT_EMITTED=false
MUTATION_UNITS_STOP_REQUESTED=0
MUTATION_CONTAINERS_RESTART_FENCED=0
MUTATION_CONTAINERS_STOPPED=0
MUTATION_RESERVATION_RECONCILED=0
MUTATION_JOURNAL_CLEARED=0
MUTATION_MARKER_TRANSITIONS=0
declare -A MUTATED_UNIT_TARGETS=()
declare -A RESTART_FENCED_CONTAINER_IDS=()
declare -A STOPPED_CONTAINER_IDS=()
CAPTURE_ADMISSION=""
CAPTURE_BEFORE_A=""
CAPTURE_BEFORE_B=""
CAPTURE_AFTER=""
EXPECTED_POSTGRES_IMAGE=""
EXPECTED_CADDY_IMAGE=""
EXPECTED_WEB_IMAGE=""
EXPECTED_WORKER_IMAGE=""
EXPECTED_MIGRATE_IMAGE=""
RESUMED_FROM_STATE=""
JOURNAL_PRESENT_AT_INVOCATION_START=""
ADMISSION_INVARIANT_SHA256=""
CONTAINED_STATE_SHA256=""
SOURCE_VALIDATED=false

timestamp_now() {
  date --utc '+%Y-%m-%dT%H:%M:%SZ'
}

fail() {
  local requested="$1" requested_exit="${2:-${EXIT_FAIL}}" normalized
  case "${requested}" in
    TOOL_UNAVAILABLE|OPERATOR_LOCK_UNAVAILABLE|FINANCIAL_WORK_ACTIVE|CORE_IDENTITY_CHANGED)
      normalized="${requested}"
      ;;
    ACTIVE_REVISION_INVALID|SOURCE_REVISION_INVALID|CURRENT_SOURCE_INVALID|RELEASE_ENV_INVALID|SOURCE_PROVENANCE_INVALID|MANIFEST_INVALID)
      normalized=SOURCE_IDENTITY_INVALID
      ;;
    IMAGE_IDENTITY_INVALID|CONTAINER_FENCE_FAILED) normalized=CONTAINER_IDENTITY_INVALID ;;
    CONTROL_ROOT_INVALID) normalized=SOURCE_IDENTITY_INVALID ;;
    HOST_STATE_DIVERGED) normalized=UNEXPECTED_RUNNING_CONTAINER ;;
    INJECTED_POST_CLEAR_ABORT|OUTPUT_INVALID) normalized=CONTROL_STATE_UNAVAILABLE ;;
    RELEASE_TRANSITION_ACTIVE) normalized=RELEASE_FENCE_ACTIVE ;;
    LIVE_INTERLOCK_INVALID)
      if (( requested_exit == EXIT_INCOMPLETE )); then
        normalized=LIVE_INTERLOCK_UNAVAILABLE
      else
        normalized=LIVE_INTERLOCK_ENABLED
      fi
      ;;
    SUCCESSOR_MARKER_INVALID) normalized=MARKER_INVALID ;;
    MARKER_DURABILITY_FAILED) normalized=MARKER_TRANSITION_FAILED ;;
    QUIESCE_JOURNAL_INVALID) normalized=JOURNAL_INVALID ;;
    QUIESCE_JOURNAL_DIVERGED|QUIESCE_CLEAR_FAILED) normalized=JOURNAL_CHANGED ;;
    HOST_INVENTORY_UNAVAILABLE) normalized=CONTAINER_INVENTORY_UNAVAILABLE ;;
    UNIT_STOP_FAILED) normalized=MUTATION_FAILED ;;
    RESERVATION_RECONCILIATION_FAILED) normalized=RESERVATION_INVALID ;;
    CONTAINMENT_NOT_PROVEN) normalized=CORE_RUNTIME_INVALID ;;
    CONTAINMENT_SNAPSHOTS_DIVERGED) normalized=CAPTURE_CHANGED ;;
    FINANCIAL_SNAPSHOT_DIVERGED) normalized=FINANCIAL_STATE_CHANGED ;;
    *) normalized=CONTROL_STATE_UNAVAILABLE ;;
  esac
  if (( requested_exit == EXIT_INCOMPLETE )); then
    case "${normalized}" in
      TOOL_UNAVAILABLE|OPERATOR_LOCK_UNAVAILABLE|SOURCE_IDENTITY_UNAVAILABLE|JOURNAL_UNAVAILABLE|CONTROL_STATE_UNAVAILABLE|CONTAINER_INVENTORY_UNAVAILABLE|SYSTEMD_INVENTORY_UNAVAILABLE|LISTENER_INVENTORY_UNAVAILABLE|LIVE_INTERLOCK_UNAVAILABLE|DATABASE_SNAPSHOT_UNAVAILABLE) ;;
      CONTAINER_IDENTITY_INVALID) normalized=CONTAINER_INVENTORY_UNAVAILABLE ;;
      MARKER_TRANSITION_FAILED) normalized=CONTROL_STATE_UNAVAILABLE ;;
      *) normalized=CONTROL_STATE_UNAVAILABLE ;;
    esac
  fi
  DIAGNOSTIC="${normalized}"
  RESULT_EXIT="${requested_exit}"
  return 1
}

bounded_capture() {
  local limit="$1" output
  shift
  output="$(
    set +o pipefail
    "$@" | head --bytes "$((limit + 1))"
    pipeline_status=("${PIPESTATUS[@]}")
    (( pipeline_status[0] == 0 && pipeline_status[1] == 0 )) || exit 1
  )" || return 1
  (( ${#output} <= limit )) || return 1
  printf '%s' "${output}"
}

directory_is_controlled() {
  local path="$1" expected_mode="$2" metadata
  [[ -d "${path}" && ! -L "${path}" ]] || return 1
  metadata="$(stat --format='%u:%g:%a' -- "${path}")" || return 1
  [[ "${metadata}" == "${EXPECTED_UID}:${EXPECTED_GID}:${expected_mode}" ]]
}

directory_is_root_controlled() {
  local path="$1" metadata mode
  [[ -d "${path}" && ! -L "${path}" ]] || return 1
  [[ "$(readlink --canonicalize-existing -- "${path}")" == "${path}" ]] || return 1
  metadata="$(stat --format='%u:%g:%a' -- "${path}")" || return 1
  [[ "${metadata}" =~ ^${EXPECTED_UID}:${EXPECTED_GID}:([0-7]{3,4})$ ]] || return 1
  mode="${BASH_REMATCH[1]}"
  (( (8#${mode} & 022) == 0 ))
}

file_is_controlled() {
  local path="$1" metadata mode
  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  metadata="$(stat --format='%u:%g:%a' -- "${path}")" || return 1
  [[ "${metadata}" =~ ^${EXPECTED_UID}:${EXPECTED_GID}:([0-7]{3,4})$ ]] || return 1
  mode="${BASH_REMATCH[1]}"
  (( (8#${mode} & 022) == 0 ))
}

secret_file_is_controlled() {
  local path="$1"
  file_is_controlled "${path}" || return 1
  [[ "$(stat --format='%a' -- "${path}")" == "600" ]]
}

hash_file() {
  local path="$1" digest
  digest="$(sha256sum -- "${path}" | cut -d ' ' -f 1)" || return 1
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "${digest}"
}

read_exact_revision_file() {
  local path="$1" line
  local -a lines
  file_is_controlled "${path}" || return 1
  mapfile -t lines <"${path}" || return 1
  (( ${#lines[@]} == 1 )) || return 1
  line="${lines[0]}"
  [[ "${line}" == "${EXPECTED_REVISION}" ]] || return 1
  printf '%s' "${line}"
}

validate_source_contract() {
  local current_source active source compose_hash common_hash helper_hash manifest_hash
  local inspect reference expected_id role controlled_directory
  local -a release_lines

  for controlled_directory in \
    "${ROOT}" "${ROOT}/releases" "${ROOT}/releases/${EXPECTED_REVISION}" \
    "${SOURCE_ROOT}" "${SOURCE_ROOT}/deploy" "${SOURCE_ROOT}/deploy/lightsail" \
    "${SOURCE_ROOT}/deploy/lightsail/scripts"; do
    directory_is_root_controlled "${controlled_directory}" ||
      fail SOURCE_PROVENANCE_INVALID "${EXIT_FAIL}" || return 1
  done
  [[ -L "${ROOT}/current" &&
    "$(stat --format='%u:%g' -- "${ROOT}/current")" == "${EXPECTED_UID}:${EXPECTED_GID}" &&
    "$(readlink -- "${ROOT}/current")" == "${SOURCE_ROOT}" ]] ||
    fail CURRENT_SOURCE_INVALID "${EXIT_FAIL}" || return 1

  active="$(read_exact_revision_file "${ROOT}/ACTIVE_REVISION")" ||
    fail ACTIVE_REVISION_INVALID "${EXIT_FAIL}" || return 1
  source="$(read_exact_revision_file "${SOURCE_ROOT}/.refunddesk-revision")" ||
    fail SOURCE_REVISION_INVALID "${EXIT_FAIL}" || return 1
  [[ "${active}" == "${source}" ]] || fail SOURCE_REVISION_INVALID "${EXIT_FAIL}" || return 1
  current_source="$(readlink --canonicalize-existing -- "${ROOT}/current")" ||
    fail CURRENT_SOURCE_INVALID "${EXIT_FAIL}" || return 1
  [[ "${current_source}" == "${SOURCE_ROOT}" ]] ||
    fail CURRENT_SOURCE_INVALID "${EXIT_FAIL}" || return 1

  secret_file_is_controlled "${RELEASE_ENV}" ||
    fail RELEASE_ENV_INVALID "${EXIT_FAIL}" || return 1
  mapfile -t release_lines <"${RELEASE_ENV}" ||
    fail RELEASE_ENV_INVALID "${EXIT_FAIL}" || return 1
  (( ${#release_lines[@]} == 2 )) &&
    [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${EXPECTED_REVISION}" &&
      "${release_lines[1]}" == "REFUNDDESK_REVISION=${EXPECTED_REVISION}" ]] ||
    fail RELEASE_ENV_INVALID "${EXIT_FAIL}" || return 1

  for controlled in "${COMPOSE_FILE}" "${COMMON_FILE}" "${HELPER_FILE}" "${MANIFEST_FILE}"; do
    file_is_controlled "${controlled}" ||
      fail SOURCE_PROVENANCE_INVALID "${EXIT_FAIL}" || return 1
  done
  compose_hash="$(hash_file "${COMPOSE_FILE}")" ||
    fail SOURCE_PROVENANCE_INVALID "${EXIT_FAIL}" || return 1
  common_hash="$(hash_file "${COMMON_FILE}")" ||
    fail SOURCE_PROVENANCE_INVALID "${EXIT_FAIL}" || return 1
  helper_hash="$(hash_file "${HELPER_FILE}")" ||
    fail SOURCE_PROVENANCE_INVALID "${EXIT_FAIL}" || return 1
  manifest_hash="$(hash_file "${MANIFEST_FILE}")" ||
    fail SOURCE_PROVENANCE_INVALID "${EXIT_FAIL}" || return 1
  [[ "${compose_hash}" == "${EXACT_COMPOSE_SHA256}" &&
    "${common_hash}" == "${EXACT_COMMON_SHA256}" &&
    "${helper_hash}" == "${EXACT_HELPER_SHA256}" &&
    "${manifest_hash}" == "${SOURCE_MANIFEST_SHA256}" ]] ||
    fail SOURCE_PROVENANCE_INVALID "${EXIT_FAIL}" || return 1

  jq --exit-status --arg revision "${EXPECTED_REVISION}" '
    type == "object"
    and keys == ["bundle","createdAt","images","platform","revision","schemaVersion","source"]
    and .schemaVersion == 1
    and .revision == $revision
    and .platform == "linux/amd64"
    and .source == "https://github.com/selimhehe1/RefundDesk"
    and (.images | type == "array" and length == 3)
    and ([.images[].role] | sort == ["migrate","web","worker"])
    and all(.images[];
      type == "object"
      and keys == ["expectedUser","imageId","reference","role"]
      and .expectedUser == "node"
      and (.imageId | type == "string" and test("^sha256:[0-9a-f]{64}$"))
      and .reference == ("refunddesk-" + .role + ":sandbox-" + $revision))
  ' "${MANIFEST_FILE}" >/dev/null ||
    fail MANIFEST_INVALID "${EXIT_FAIL}" || return 1

  EXPECTED_WEB_IMAGE="$(jq --raw-output '.images[] | select(.role == "web") | .imageId' "${MANIFEST_FILE}")"
  EXPECTED_WORKER_IMAGE="$(jq --raw-output '.images[] | select(.role == "worker") | .imageId' "${MANIFEST_FILE}")"
  EXPECTED_MIGRATE_IMAGE="$(jq --raw-output '.images[] | select(.role == "migrate") | .imageId' "${MANIFEST_FILE}")"
  for role in web worker migrate; do
    reference="refunddesk-${role}:sandbox-${EXPECTED_REVISION}"
    case "${role}" in
      web) expected_id="${EXPECTED_WEB_IMAGE}" ;;
      worker) expected_id="${EXPECTED_WORKER_IMAGE}" ;;
      migrate) expected_id="${EXPECTED_MIGRATE_IMAGE}" ;;
    esac
    inspect="$(bounded_capture 65536 timeout 15 docker image inspect -- "${reference}")" ||
      fail IMAGE_IDENTITY_INVALID "${EXIT_INCOMPLETE}" || return 1
    jq --exit-status --arg id "${expected_id}" --arg revision "${EXPECTED_REVISION}" '
      length == 1
      and .[0].Id == $id
      and .[0].Os == "linux"
      and .[0].Architecture == "amd64"
      and .[0].Config.User == "node"
      and .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
      and .[0].Config.Labels["org.opencontainers.image.source"]
        == "https://github.com/selimhehe1/RefundDesk"
    ' <<<"${inspect}" >/dev/null ||
      fail IMAGE_IDENTITY_INVALID "${EXIT_FAIL}" || return 1
  done

  inspect="$(bounded_capture 65536 timeout 15 docker image inspect -- "${POSTGRES_REFERENCE}")" ||
    fail IMAGE_IDENTITY_INVALID "${EXIT_INCOMPLETE}" || return 1
  EXPECTED_POSTGRES_IMAGE="$(jq --exit-status --raw-output '
    select(length == 1 and (.[0].Id | type == "string" and test("^sha256:[0-9a-f]{64}$")))
    | .[0].Id
  ' <<<"${inspect}")" || fail IMAGE_IDENTITY_INVALID "${EXIT_FAIL}" || return 1
  inspect="$(bounded_capture 65536 timeout 15 docker image inspect -- "${CADDY_REFERENCE}")" ||
    fail IMAGE_IDENTITY_INVALID "${EXIT_INCOMPLETE}" || return 1
  EXPECTED_CADDY_IMAGE="$(jq --exit-status --raw-output '
    select(length == 1 and (.[0].Id | type == "string" and test("^sha256:[0-9a-f]{64}$")))
    | .[0].Id
  ' <<<"${inspect}")" || fail IMAGE_IDENTITY_INVALID "${EXIT_FAIL}" || return 1
}

source_contract_still_exact() {
  local current_source digest controlled_directory pair file expected
  local -a release_lines
  for controlled_directory in \
    "${ROOT}" "${ROOT}/releases" "${ROOT}/releases/${EXPECTED_REVISION}" \
    "${SOURCE_ROOT}" "${SOURCE_ROOT}/deploy" "${SOURCE_ROOT}/deploy/lightsail" \
    "${SOURCE_ROOT}/deploy/lightsail/scripts"; do
    directory_is_root_controlled "${controlled_directory}" || return 1
  done
  read_exact_revision_file "${ROOT}/ACTIVE_REVISION" >/dev/null || return 1
  read_exact_revision_file "${SOURCE_ROOT}/.refunddesk-revision" >/dev/null || return 1
  [[ -L "${ROOT}/current" &&
    "$(stat --format='%u:%g' -- "${ROOT}/current")" == "${EXPECTED_UID}:${EXPECTED_GID}" &&
    "$(readlink -- "${ROOT}/current")" == "${SOURCE_ROOT}" ]] || return 1
  current_source="$(readlink --canonicalize-existing -- "${ROOT}/current")" || return 1
  [[ "${current_source}" == "${SOURCE_ROOT}" ]] || return 1
  secret_file_is_controlled "${RELEASE_ENV}" || return 1
  mapfile -t release_lines <"${RELEASE_ENV}" || return 1
  (( ${#release_lines[@]} == 2 )) &&
    [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${EXPECTED_REVISION}" &&
      "${release_lines[1]}" == "REFUNDDESK_REVISION=${EXPECTED_REVISION}" ]] || return 1
  for pair in \
    "${COMPOSE_FILE}|${EXACT_COMPOSE_SHA256}" \
    "${COMMON_FILE}|${EXACT_COMMON_SHA256}" \
    "${HELPER_FILE}|${EXACT_HELPER_SHA256}" \
    "${MANIFEST_FILE}|${SOURCE_MANIFEST_SHA256}"; do
    file="${pair%%|*}"
    expected="${pair#*|}"
    file_is_controlled "${file}" || return 1
    digest="$(hash_file "${file}")" || return 1
    [[ "${digest}" == "${expected}" ]] || return 1
  done
}

acquire_exclusive_lock() {
  local directory lock_identity descriptor_identity
  directory="$(dirname -- "${OPERATOR_LOCK}")"
  directory_is_controlled "${directory}" 700 ||
    fail OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  secret_file_is_controlled "${OPERATOR_LOCK}" ||
    fail OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  lock_identity="$(stat --format='%d:%i' -- "${OPERATOR_LOCK}")" ||
    fail OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  exec 9<>"${OPERATOR_LOCK}" ||
    fail OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  descriptor_identity="$(stat --dereference --format='%d:%i' -- /proc/self/fd/9)" ||
    fail OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  [[ "${descriptor_identity}" == "${lock_identity}" &&
    "$(stat --format='%d:%i' -- "${OPERATOR_LOCK}")" == "${lock_identity}" ]] ||
    fail OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  flock --exclusive --timeout 30 9 ||
    fail OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
}

binding_disabled() {
  local path="$1" name="$2" expected="$3" count
  secret_file_is_controlled "${path}" || return 1
  count="$(grep --count --extended-regexp "^${name}=" "${path}")" || true
  [[ "${count}" == "1" ]] || return 1
  grep --quiet --fixed-strings --line-regexp "${name}=${expected}" "${path}"
}

validate_quiesce_journal() {
  local digest operation
  secret_file_is_controlled "${QUIESCE_JOURNAL}" || return 1
  operation="$(jq --exit-status --raw-output --arg revision "${EXPECTED_REVISION}" '
    select(
      type == "object"
      and keys == ["operation","revision","schemaVersion","status"]
      and .schemaVersion == 1
      and .status == "in_progress"
      and (.operation == "backup" or .operation == "retention")
      and .revision == $revision
    ) | .operation
  ' "${QUIESCE_JOURNAL}")" || return 1
  digest="$(hash_file "${QUIESCE_JOURNAL}")" || return 1
  printf '%s|%s' "${operation}" "${digest}"
}

release_controls_absent() {
  local output line unit marker count=0
  for path in "${APPLICATION_TRANSITION}" "${LEGACY_APP_TRANSITION}" \
    "${MANAGED_TRANSITION}" "${BACKUP_UPLOAD_JOURNAL}"; do
    [[ ! -e "${path}" && ! -L "${path}" ]] || return 1
  done
  output="$(bounded_capture 65536 timeout 10 systemctl list-units --type=service \
    --state=activating,active,reloading,deactivating --plain --no-legend \
    'refunddesk-release-*.service')" || return 1
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    unit="${line%% *}"
    [[ "${unit}" =~ ^refunddesk-release(-fence)?-[0-9a-f]{12}-[1-9][0-9]*\.service$ ]] || return 1
    count=$((count + 1))
  done <<<"${output}"
  (( count == 0 )) || return 1
  shopt -s nullglob
  for marker in "${RUNTIME_ROOT}"/refunddesk-release-fence-*.ready \
    "${RUNTIME_ROOT}"/refunddesk-release-candidate-*.admit; do
    [[ ! -e "${marker}" && ! -L "${marker}" ]] || {
      shopt -u nullglob
      return 1
    }
  done
  shopt -u nullglob
}

validate_marker() {
  local expected_state="${1:-}" marker_values
  secret_file_is_controlled "${SUCCESSOR_MARKER}" || return 1
  marker_values="$(jq --exit-status --raw-output \
    --arg revision "${EXPECTED_REVISION}" --arg runner "${RUNNER_SHA256}" \
    --arg manifest "${EXPECTED_MANIFEST_SHA256}" --arg compose "${EXACT_COMPOSE_SHA256}" \
    --arg common "${EXACT_COMMON_SHA256}" --arg helper "${EXACT_HELPER_SHA256}" '
      def timestamp:
        type == "string"
        and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
      select(
        type == "object"
        and keys == [
          "admissionInvariantSha256","commonSha256","completedAt","composeSha256","containedStateSha256",
          "containedVerifiedAt","helperSha256","journalSha256","kind","manifestSha256",
          "operation","preparedAt","quiesceClearedAt","revision","runnerSha256",
          "schemaVersion","state"
        ]
        and .schemaVersion == 1
        and .kind == "refunddesk.lightsail.containment-reconciliation-marker"
        and .revision == $revision
        and .runnerSha256 == $runner
        and .manifestSha256 == $manifest
        and .composeSha256 == $compose
        and .commonSha256 == $common
        and .helperSha256 == $helper
        and (.operation == "backup" or .operation == "retention")
        and (.journalSha256 | type == "string" and test("^[0-9a-f]{64}$"))
        and (.admissionInvariantSha256 | type == "string" and test("^[0-9a-f]{64}$"))
        and (.preparedAt | timestamp)
        and (.state == "prepared" or .state == "contained_verified"
          or .state == "quiesce_cleared" or .state == "complete")
        and (if .state == "prepared" then
          .containedStateSha256 == null
        else (.containedStateSha256 | type == "string" and test("^[0-9a-f]{64}$")) end)
        and (if .state == "prepared" then
          .containedVerifiedAt == null and .quiesceClearedAt == null and .completedAt == null
        elif .state == "contained_verified" then
          (.containedVerifiedAt | timestamp) and .containedVerifiedAt >= .preparedAt
          and .quiesceClearedAt == null and .completedAt == null
        elif .state == "quiesce_cleared" then
          (.containedVerifiedAt | timestamp) and (.quiesceClearedAt | timestamp)
          and .containedVerifiedAt >= .preparedAt
          and .quiesceClearedAt >= .containedVerifiedAt
          and .completedAt == null
        else
          (.containedVerifiedAt | timestamp) and (.quiesceClearedAt | timestamp)
          and (.completedAt | timestamp) and .containedVerifiedAt >= .preparedAt
          and .quiesceClearedAt >= .containedVerifiedAt
          and .completedAt >= .quiesceClearedAt
        end)
      ) | [
        .state,.operation,.journalSha256,.admissionInvariantSha256,
        (.containedStateSha256 // "")
      ] | join("|")
    ' "${SUCCESSOR_MARKER}")" || return 1
  IFS='|' read -r MARKER_STATE OPERATION JOURNAL_SHA256 ADMISSION_INVARIANT_SHA256 \
    CONTAINED_STATE_SHA256 <<<"${marker_values}"
  [[ -z "${expected_state}" || "${MARKER_STATE}" == "${expected_state}" ]]
}

write_marker_state() {
  local next_state="$1" now candidate old_state
  old_state="${MARKER_STATE}"
  case "${old_state}:${next_state}" in
    absent:prepared|prepared:contained_verified|contained_verified:quiesce_cleared|quiesce_cleared:complete) ;;
    *) return 1 ;;
  esac
  now="$(timestamp_now)" || return 1
  candidate="${CONTROL_ROOT}/.containment-reconciliation.${next_state}.$$"
  if [[ "${old_state}" == "absent" ]]; then
    (
      set -o noclobber
      jq --sort-keys --compact-output --null-input \
        --arg revision "${EXPECTED_REVISION}" --arg operation "${OPERATION}" \
        --arg runner "${RUNNER_SHA256}" --arg journal "${JOURNAL_SHA256}" \
        --arg manifest "${EXPECTED_MANIFEST_SHA256}" --arg compose "${EXACT_COMPOSE_SHA256}" \
        --arg common "${EXACT_COMMON_SHA256}" --arg helper "${EXACT_HELPER_SHA256}" \
        --arg now "${now}" --arg admission "${ADMISSION_INVARIANT_SHA256}" '{
          schemaVersion: 1,
          kind: "refunddesk.lightsail.containment-reconciliation-marker",
          state: "prepared",
          revision: $revision,
          operation: $operation,
          runnerSha256: $runner,
          journalSha256: $journal,
          manifestSha256: $manifest,
          composeSha256: $compose,
          commonSha256: $common,
          helperSha256: $helper,
          preparedAt: $now,
          admissionInvariantSha256: $admission,
          containedStateSha256: null,
          containedVerifiedAt: null,
          quiesceClearedAt: null,
          completedAt: null
        }' >"${candidate}"
    ) || return 1
  else
    (
      set -o noclobber
      jq --sort-keys --compact-output --arg state "${next_state}" --arg now "${now}" \
        --arg digest "${CONTAINED_STATE_SHA256}" '
        .state = $state
        | if $state == "contained_verified" then
            .containedVerifiedAt = $now | .containedStateSha256 = $digest
          elif $state == "quiesce_cleared" then .quiesceClearedAt = $now
          elif $state == "complete" then .completedAt = $now
          else . end
      ' "${SUCCESSOR_MARKER}" >"${candidate}"
    ) || return 1
  fi
  timeout 20 python3 "${HELPER_FILE}" durable-replace --source "${candidate}" \
    --target "${SUCCESSOR_MARKER}" --mode 0600 >/dev/null || return 1
  MARKER_STATE="${next_state}"
  validate_marker "${next_state}" || return 1
  MUTATION_MARKER_TRANSITIONS=$((MUTATION_MARKER_TRANSITIONS + 1))
}

container_snapshot() {
  local service="$1" expected_image="$2" expected_reference="$3"
  local ids_output inspect count id
  local -a ids
  ids_output="$(bounded_capture 65536 timeout 15 docker container ls --all --no-trunc --quiet \
    --filter 'label=com.docker.compose.project=refunddesk' \
    --filter "label=com.docker.compose.service=${service}")" || return 1
  ids=()
  [[ -z "${ids_output}" ]] || mapfile -t ids <<<"${ids_output}"
  count="${#ids[@]}"
  if (( count == 0 )); then
    jq --compact-output --null-input --arg service "${service}" '{
      service: $service, presentCount: 0, containerId: null, status: "MISSING",
      imageId: null, expectedImageId: null, health: "MISSING",
      restartPolicy: null, projectLabelMatches: false,
      serviceLabelMatches: false, revisionLabelMatches: false,
      imageIdentityMatches: false, imageReferenceMatches: false,
      noPublishedPorts: false, effectiveGlobalLiveDisabled: null,
      effectiveLiveWebhookDisabled: null
    }'
    return 0
  fi
  (( count == 1 )) && [[ "${ids[0]}" =~ ^[0-9a-f]{64}$ ]] || return 1
  id="${ids[0]}"
  inspect="$(bounded_capture 65536 timeout 15 docker inspect -- "${id}")" || return 1
  jq --compact-output --exit-status \
    --arg service "${service}" --arg id "${id}" --arg revision "${EXPECTED_REVISION}" \
    --arg image "${expected_image}" --arg reference "${expected_reference}" '
    select(length == 1 and .[0].Id == $id)
    | .[0] as $c
    | {
        service: $service,
        presentCount: 1,
        containerId: $id,
        imageId: $c.Image,
        expectedImageId: $image,
        status: (($c.State.Status // "unknown") | ascii_upcase),
        health: (($c.State.Health.Status // "none") | ascii_upcase),
        restartPolicy: ($c.HostConfig.RestartPolicy.Name // null),
        projectLabelMatches: ($c.Config.Labels["com.docker.compose.project"] == "refunddesk"),
        serviceLabelMatches: ($c.Config.Labels["com.docker.compose.service"] == $service),
        revisionLabelMatches: (if $service == "postgres" then
          ($c.Config.Labels["com.refunddesk.revision"] // null) == null
        else $c.Config.Labels["com.refunddesk.revision"] == $revision end),
        imageIdentityMatches: ($c.Image == $image),
        imageReferenceMatches: ($c.Config.Image == $reference),
        noPublishedPorts: (($c.HostConfig.PortBindings // {}) | length == 0),
        effectiveGlobalLiveDisabled: (if $service == "web" or $service == "worker" then
          ([$c.Config.Env[]? | select(startswith("REFUNDDESK_GLOBAL_LIVE_ENABLED="))]
            == ["REFUNDDESK_GLOBAL_LIVE_ENABLED=false"])
          else null end),
        effectiveLiveWebhookDisabled: (if $service == "web" then
          ([$c.Config.Env[]? | select(startswith("STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET="))]
            == ["STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled"])
          else null end)
      }
  ' <<<"${inspect}"
}

systemd_snapshot() {
  local available=true value output line unit release_count=0 fence_count=0
  local backup_timer=false retention_timer=false backup_service=false retention_service=false recovery=false
  for unit in refunddesk-backup.timer refunddesk-retention.timer refunddesk-backup.service \
    refunddesk-retention.service refunddesk-quiesce-recovery.service; do
    value="$(bounded_capture 128 timeout 10 systemctl show "${unit}" --property=ActiveState --value)" || {
      available=false
      value=unknown
    }
    case "${value}" in
      active|activating|reloading|deactivating)
        case "${unit}" in
          refunddesk-backup.timer) backup_timer=true ;;
          refunddesk-retention.timer) retention_timer=true ;;
          refunddesk-backup.service) backup_service=true ;;
          refunddesk-retention.service) retention_service=true ;;
          refunddesk-quiesce-recovery.service) recovery=true ;;
        esac
        ;;
      inactive|failed) ;;
      *) available=false ;;
    esac
  done
  output="$(bounded_capture 65536 timeout 10 systemctl list-units --type=service \
    --state=activating,active,reloading,deactivating --plain --no-legend \
    'refunddesk-release-*.service')" || {
    available=false
    output=""
  }
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    unit="${line%% *}"
    if [[ "${unit}" =~ ^refunddesk-release-fence-[0-9a-f]{12}-[1-9][0-9]*\.service$ ]]; then
      fence_count=$((fence_count + 1))
    elif [[ "${unit}" =~ ^refunddesk-release-[0-9a-f]{12}-[1-9][0-9]*\.service$ ]]; then
      release_count=$((release_count + 1))
    else
      available=false
    fi
  done <<<"${output}"
  jq --compact-output --null-input \
    --argjson available "${available}" --argjson backup_timer "${backup_timer}" \
    --argjson retention_timer "${retention_timer}" --argjson backup_service "${backup_service}" \
    --argjson retention_service "${retention_service}" --argjson recovery "${recovery}" \
    --argjson release_count "${release_count}" --argjson fence_count "${fence_count}" '{
      available: $available, backupTimerActive: $backup_timer,
      retentionTimerActive: $retention_timer, backupServiceActive: $backup_service,
      retentionServiceActive: $retention_service, quiesceRecoveryActive: $recovery,
      activeReleaseUnitCount: $release_count, activeFenceUnitCount: $fence_count
    }'
}

listener_snapshot() {
  local available=true tcp80=false tcp443=false udp80=false udp443=false output protocol port
  for protocol in tcp udp; do
    for port in 80 443; do
      if [[ "${protocol}" == "tcp" ]]; then
        output="$(bounded_capture 65536 timeout 10 ss -H -ltn "( sport = :${port} )")" || {
          available=false
          output=""
        }
      else
        output="$(bounded_capture 65536 timeout 10 ss -H -lun "( sport = :${port} )")" || {
          available=false
          output=""
        }
      fi
      [[ -z "${output}" ]] || {
        case "${protocol}:${port}" in
          tcp:80) tcp80=true ;;
          tcp:443) tcp443=true ;;
          udp:80) udp80=true ;;
          udp:443) udp443=true ;;
        esac
      }
    done
  done
  jq --compact-output --null-input --argjson available "${available}" \
    --argjson tcp80 "${tcp80}" --argjson tcp443 "${tcp443}" \
    --argjson udp80 "${udp80}" --argjson udp443 "${udp443}" '{
      available: $available, tcp80Listening: $tcp80, tcp443Listening: $tcp443,
      udp80Listening: $udp80, udp443Listening: $udp443
    }'
}

database_snapshot() {
  local postgres_id="$1" output compact
  output="$(bounded_capture 4096 timeout 25 docker exec --env PSQL_HISTORY=/dev/null \
    "${postgres_id}" psql --host=/var/run/postgresql --username=refunddesk_owner \
    --dbname=refunddesk --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
    --tuples-only --no-align --command="
      BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
      SET LOCAL statement_timeout = '15s';
      SET LOCAL lock_timeout = '5s';
      SET LOCAL transaction_read_only = on;
      SELECT concat_ws('|',
        (SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
        (SELECT count(*) FROM public.refund_requests WHERE workflow_status IN
          ('pending_approval','approved','executing','reconciliation_required')),
        (SELECT count(*) FROM public.refund_requests WHERE payment_guard_released_at IS NULL),
        (SELECT count(*) FROM pgboss.job WHERE name = 'refunddesk_refund_execute'
          AND state::text IN ('created','retry','active')),
        (SELECT count(*) FROM public.tenants WHERE live_enabled),
        (SELECT count(*) FROM public.stripe_installations WHERE environment = 'live'),
        (SELECT count(*) FROM pg_catalog.pg_prepared_xacts),
        (SELECT count(*) FROM public.refund_requests),
        (SELECT count(*) FROM public.audit_events));
      ROLLBACK;
    ")" || return 1
  compact="$(printf '%s' "${output}" | tr -d '[:space:]')"
  [[ "${compact}" =~ ^([1-9][0-9]{17,19})\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)$ ]] || return 1
  jq --compact-output --null-input --arg system "${BASH_REMATCH[1]}" \
    --argjson workflows "${BASH_REMATCH[2]}" --argjson guards "${BASH_REMATCH[3]}" \
    --argjson jobs "${BASH_REMATCH[4]}" --argjson tenants "${BASH_REMATCH[5]}" \
    --argjson installs "${BASH_REMATCH[6]}" --argjson prepared "${BASH_REMATCH[7]}" \
    --argjson requests "${BASH_REMATCH[8]}" --argjson audits "${BASH_REMATCH[9]}" '{
      snapshotAvailable: true, systemIdentifier: $system,
      activeWorkflows: $workflows, unreleasedPaymentGuards: $guards,
      activeFinancialJobs: $jobs, liveTenants: $tenants,
      liveInstallations: $installs, preparedTransactions: $prepared,
      refundRequests: $requests, auditEvents: $audits
    }'
}

inventory_aggregates() {
  local all_ids project_ids inspect id service running one_shots=0 one_shots_present=0
  local unexpected=0 unknown=0
  local -a ids
  project_ids="$(bounded_capture 65536 timeout 15 docker container ls --all --no-trunc --quiet \
    --filter 'label=com.docker.compose.project=refunddesk')" || return 1
  ids=()
  [[ -z "${project_ids}" ]] || mapfile -t ids <<<"${project_ids}"
  for id in "${ids[@]}"; do
    [[ "${id}" =~ ^[0-9a-f]{64}$ ]] || return 1
    inspect="$(bounded_capture 65536 timeout 15 docker inspect -- "${id}")" || return 1
    service="$(jq --exit-status --raw-output 'select(length == 1) | .[0].Config.Labels["com.docker.compose.service"]' <<<"${inspect}")" || return 1
    running="$(jq --exit-status --raw-output '
      select(length == 1 and (.[0].State.Running | type) == "boolean")
      | if .[0].State.Running then "true" else "false" end
    ' <<<"${inspect}")" || return 1
    case "${service}" in
      postgres|verifier|web|worker|caddy|database-owner-reservation) ;;
      bootstrap|migrate|maintenance)
        one_shots_present=$((one_shots_present + 1))
        [[ "${running}" == "false" ]] || one_shots=$((one_shots + 1))
        ;;
      *) unknown=$((unknown + 1)) ;;
    esac
  done
  all_ids="$(bounded_capture 65536 timeout 15 docker container ls --no-trunc --quiet)" || return 1
  ids=()
  [[ -z "${all_ids}" ]] || mapfile -t ids <<<"${all_ids}"
  for id in "${ids[@]}"; do
    [[ "${id}" =~ ^[0-9a-f]{64}$ ]] || return 1
    inspect="$(bounded_capture 65536 timeout 15 docker inspect -- "${id}")" || return 1
    if ! jq --exit-status '
      length == 1
      and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
      and (.[0].Config.Labels["com.docker.compose.service"]
        | . == "postgres" or . == "verifier" or . == "web"
          or . == "worker" or . == "caddy")
    ' <<<"${inspect}" >/dev/null; then
      unexpected=$((unexpected + 1))
    fi
  done
  (( unknown == 0 )) || return 1
  printf '%s|%s|%s' "${one_shots}" "${one_shots_present}" "${unexpected}"
}

reservation_valid() {
  local ids_output container_id inspection image_inspection
  local -a reservation_ids
  REFUNDDESK_ROOT="${ROOT}" REFUNDDESK_CONFIG_ROOT="${CONFIG_ROOT}" \
    REFUNDDESK_CONTROL_ROOT="${CONTROL_ROOT}" REFUNDDESK_COMPOSE_FILE="${COMPOSE_FILE}" \
    REFUNDDESK_OPERATOR_LOCK="${OPERATOR_LOCK}" timeout 90 bash -c '
      set -Eeuo pipefail
      # shellcheck disable=SC1090
      source "$1"
      assert_database_owner_job_reservation "$2"
    ' bash "${COMMON_FILE}" "${EXPECTED_REVISION}" >/dev/null || return 1

  ids_output="$(bounded_capture 65536 timeout 15 docker container ls --all --no-trunc --quiet \
    --filter 'name=^/refunddesk-database-owner-job$')" || return 1
  reservation_ids=()
  [[ -z "${ids_output}" ]] || mapfile -t reservation_ids <<<"${ids_output}"
  (( ${#reservation_ids[@]} == 1 )) || return 1
  container_id="${reservation_ids[0]}"
  [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] || return 1
  inspection="$(bounded_capture 65536 timeout 15 docker inspect -- "${container_id}")" ||
    return 1
  image_inspection="$(bounded_capture 65536 timeout 15 docker image inspect -- "${POSTGRES_REFERENCE}")" ||
    return 1
  jq --exit-status --slurp \
    --arg id "${container_id}" --arg image_id "${EXPECTED_POSTGRES_IMAGE}" \
    --arg reference "${POSTGRES_REFERENCE}" --arg revision "${EXPECTED_REVISION}" '
      select(length == 2 and (.[0] | length) == 1 and (.[1] | length) == 1)
      | .[0][0] as $c
      | .[1][0] as $i
      | $c.Id == $id
      and $c.Name == "/refunddesk-database-owner-job"
      and $c.Image == $image_id
      and $i.Id == $image_id
      and $c.Config.Image == $reference
      and $c.Config.Labels == {
        "com.docker.compose.project": "refunddesk",
        "com.docker.compose.service": "database-owner-reservation",
        "com.refunddesk.revision": $revision,
        "com.refunddesk.database-owner-reservation": "true"
      }
      and $c.Config.Entrypoint == ["/bin/true"]
      and $c.Config.Cmd == null
      and $c.Path == "/bin/true"
      and $c.Args == []
      and $c.Config.User == ($i.Config.User // "")
      and $c.Config.WorkingDir == ($i.Config.WorkingDir // "")
      and $c.Config.Env == [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/18/bin",
        "GOSU_VERSION=1.19",
        "LANG=en_US.utf8",
        "PG_MAJOR=18",
        "PG_VERSION=18.4-1.pgdg12+1",
        "PGDATA=/var/lib/postgresql/18/docker"
      ]
      and $c.Config.Env == ($i.Config.Env // [])
      and $c.Config.StopSignal == ($i.Config.StopSignal // "")
      and ($c.Config.Healthcheck // null) == ($i.Config.Healthcheck // null)
      and ($c.Config.Shell // null) == ($i.Config.Shell // null)
      and ($c.Config.ExposedPorts // null) == ($i.Config.ExposedPorts // null)
      and ($c.Config.Volumes // null) == ($i.Config.Volumes // null)
      and all(($c.Config.Env // [])[];
        (split("=")[0]
          | test("(PASSWORD|PASS|SECRET|TOKEN|DATABASE_URL|HMAC_KEY|ENCRYPTION_KEY|CREDENTIAL)"; "i")
          | not))
      and $c.Config.AttachStdin == false
      and $c.Config.AttachStdout == false
      and $c.Config.AttachStderr == false
      and $c.Config.Tty == false
      and $c.Config.OpenStdin == false
      and $c.Config.StdinOnce == false
      and $c.State.Running == false
      and $c.State.Paused == false
      and $c.State.Restarting == false
      and $c.State.OOMKilled == false
      and $c.State.Dead == false
      and $c.State.Status == "created"
      and $c.State.Pid == 0
      and $c.State.ExitCode == 0
      and ($c.State.Error // "") == ""
      and $c.HostConfig.RestartPolicy == {Name: "no", MaximumRetryCount: 0}
      and $c.HostConfig.AutoRemove == false
      and $c.HostConfig.NetworkMode == "none"
      and $c.HostConfig.ReadonlyRootfs == true
      and $c.HostConfig.Privileged == false
      and $c.HostConfig.PublishAllPorts == false
      and ($c.HostConfig.PortBindings // {}) == {}
      and (($c.HostConfig.Binds // []) | length) == 0
      and (($c.HostConfig.Mounts // []) | length) == 0
      and (($c.HostConfig.VolumesFrom // []) | length) == 0
      and (($c.HostConfig.CapAdd // []) | length) == 0
      and $c.HostConfig.CapDrop == ["ALL"]
      and $c.HostConfig.SecurityOpt == ["no-new-privileges:true"]
      and (($c.HostConfig.Devices // []) | length) == 0
      and (($c.HostConfig.DeviceRequests // []) | length) == 0
      and (($c.HostConfig.DeviceCgroupRules // []) | length) == 0
      and (($c.HostConfig.Links // []) | length) == 0
      and (($c.HostConfig.ExtraHosts // []) | length) == 0
      and (($c.HostConfig.GroupAdd // []) | length) == 0
      and $c.HostConfig.PidMode == ""
      and $c.HostConfig.IpcMode == "private"
      and $c.HostConfig.UTSMode == ""
      and $c.HostConfig.UsernsMode == ""
      and $c.HostConfig.CgroupnsMode == "private"
      and $c.HostConfig.Tmpfs
        == {"/var/lib/postgresql": "rw,nosuid,nodev,noexec,size=65536"}
      and $c.HostConfig.PidsLimit == 8
      and $c.HostConfig.Memory == 16777216
      and $c.HostConfig.MemoryReservation == 0
      and ($c.HostConfig.OomKillDisable // false) == false
      and $c.HostConfig.CpuShares == 0
      and $c.HostConfig.NanoCpus == 0
      and $c.HostConfig.CpuPeriod == 0
      and $c.HostConfig.CpuQuota == 0
      and ($c.HostConfig.CpusetCpus // "") == ""
      and ($c.HostConfig.CpusetMems // "") == ""
      and ($c.Mounts | type) == "array"
      and ($c.Mounts | length) <= 1
      and all($c.Mounts[];
        .Type == "tmpfs"
        and .Destination == "/var/lib/postgresql"
        and .RW == true)
      and (($c.NetworkSettings.Ports // {})
        | all(to_entries[]; .value == null))
    ' <<<"${inspection}"$'\n'"${image_inspection}" >/dev/null
}

capture_host() {
  local captured_at containers postgres verifier web worker caddy systemd listeners database
  local journal_present=false journal_operation="" journal_revision="" journal_status="" journal_sha=""
  local inventory one_shots one_shots_present unexpected reservation=false runtime_markers=0 marker
  local platform_disabled=false worker_disabled=false webhook_disabled=false
  local transition=false backup_upload=false managed_transition=false

  source_contract_still_exact || return 1
  captured_at="$(timestamp_now)" || return 1
  postgres="$(container_snapshot postgres "${EXPECTED_POSTGRES_IMAGE}" "${POSTGRES_REFERENCE}")" || return 1
  verifier="$(container_snapshot verifier "${EXPECTED_CADDY_IMAGE}" "${CADDY_REFERENCE}")" || return 1
  worker="$(container_snapshot worker "${EXPECTED_WORKER_IMAGE}" "refunddesk-worker:sandbox-${EXPECTED_REVISION}")" || return 1
  web="$(container_snapshot web "${EXPECTED_WEB_IMAGE}" "refunddesk-web:sandbox-${EXPECTED_REVISION}")" || return 1
  caddy="$(container_snapshot caddy "${EXPECTED_CADDY_IMAGE}" "${CADDY_REFERENCE}")" || return 1
  containers="$(printf '%s\n' "${postgres}" "${verifier}" "${worker}" "${web}" "${caddy}" | jq --slurp --compact-output '.')" || return 1
  systemd="$(systemd_snapshot)" || return 1
  listeners="$(listener_snapshot)" || return 1
  inventory="$(inventory_aggregates)" || return 1
  IFS='|' read -r one_shots one_shots_present unexpected <<<"${inventory}"
  reservation_valid && reservation=true

  if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]; then
    journal_sha="$(hash_file "${QUIESCE_JOURNAL}")" || return 1
    journal_operation="$(jq --raw-output '.operation // ""' "${QUIESCE_JOURNAL}")" || return 1
    journal_revision="$(jq --raw-output '.revision // ""' "${QUIESCE_JOURNAL}")" || return 1
    journal_status="$(jq --raw-output '.status // ""' "${QUIESCE_JOURNAL}")" || return 1
    journal_present=true
  fi
  binding_disabled "${PLATFORM_ENV}" REFUNDDESK_GLOBAL_LIVE_ENABLED false && platform_disabled=true
  binding_disabled "${WORKER_ENV}" REFUNDDESK_GLOBAL_LIVE_ENABLED false && worker_disabled=true
  binding_disabled "${PLATFORM_ENV}" STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET disabled && webhook_disabled=true
  [[ -e "${APPLICATION_TRANSITION}" || -L "${APPLICATION_TRANSITION}" ||
    -e "${LEGACY_APP_TRANSITION}" || -L "${LEGACY_APP_TRANSITION}" ]] && transition=true
  [[ -e "${BACKUP_UPLOAD_JOURNAL}" || -L "${BACKUP_UPLOAD_JOURNAL}" ]] && backup_upload=true
  [[ -e "${MANAGED_TRANSITION}" || -L "${MANAGED_TRANSITION}" ]] && managed_transition=true
  shopt -s nullglob
  for marker in "${RUNTIME_ROOT}"/refunddesk-release-fence-*.ready \
    "${RUNTIME_ROOT}"/refunddesk-release-candidate-*.admit; do
    [[ -e "${marker}" || -L "${marker}" ]] && runtime_markers=$((runtime_markers + 1))
  done
  shopt -u nullglob
  database="$(database_snapshot "$(jq --raw-output '.[0].containerId // ""' <<<"${containers}")")" || return 1

  jq --compact-output --null-input --arg captured "${captured_at}" \
    --arg revision "${EXPECTED_REVISION}" --arg manifest "${EXPECTED_MANIFEST_SHA256}" \
    --arg compose "${EXACT_COMPOSE_SHA256}" --arg common "${EXACT_COMMON_SHA256}" \
    --arg helper "${EXACT_HELPER_SHA256}" --argjson containers "${containers}" \
    --argjson systemd "${systemd}" --argjson listeners "${listeners}" \
    --argjson database "${database}" --argjson journal_present "${journal_present}" \
    --arg journal_operation "${journal_operation}" --arg journal_revision "${journal_revision}" \
    --arg journal_status "${journal_status}" --arg journal_sha "${journal_sha}" \
    --argjson reservation "${reservation}" --argjson one_shots "${one_shots}" \
    --argjson one_shots_present "${one_shots_present}" \
    --argjson unexpected "${unexpected}" --argjson runtime_markers "${runtime_markers}" \
    --argjson transition "${transition}" --argjson backup_upload "${backup_upload}" \
    --argjson managed_transition "${managed_transition}" \
    --argjson platform_disabled "${platform_disabled}" --argjson worker_disabled "${worker_disabled}" \
    --argjson webhook_disabled "${webhook_disabled}" '{
      capturedAt: $captured,
      identity: {
        activeRevision: $revision, currentRevision: $revision, sourceRevision: $revision,
        releaseEnvironmentRevision: $revision, manifestSha256: $manifest,
        composeSha256: $compose, commonSha256: $common, helperSha256: $helper
      },
      journal: {
        present: $journal_present,
        operation: (if $journal_operation == "" then null else $journal_operation end),
        revision: (if $journal_revision == "" then null else $journal_revision end),
        status: (if $journal_status == "" then null else $journal_status end),
        sha256: (if $journal_sha == "" then null else $journal_sha end)
      },
      control: {
        activeReleaseUnitCount: $systemd.activeReleaseUnitCount,
        activeFenceUnitCount: $systemd.activeFenceUnitCount,
        releaseRuntimeMarkerCount: $runtime_markers,
        transitionPresent: $transition,
        backupUploadJournalPresent: $backup_upload,
        managedTransitionPresent: $managed_transition,
        reservationValid: $reservation,
        knownOneShotsRunningCount: $one_shots,
        knownOneShotsPresentCount: $one_shots_present,
        unexpectedRunningContainerCount: $unexpected
      },
      containers: $containers,
      surface: {
        systemdInventoryAvailable: $systemd.available,
        listenerInventoryAvailable: $listeners.available,
        liveInterlocksAvailable: ($platform_disabled and $worker_disabled and $webhook_disabled),
        platformLiveDisabled: $platform_disabled,
        workerLiveDisabled: $worker_disabled,
        liveWebhookDisabled: $webhook_disabled,
        webEffectiveLiveDisabled: ($containers[] | select(.service == "web") | .effectiveGlobalLiveDisabled),
        workerEffectiveLiveDisabled: (if ($containers[] | select(.service == "worker") | .presentCount) == 0
          then true else ($containers[] | select(.service == "worker") | .effectiveGlobalLiveDisabled) end),
        backupTimerActive: $systemd.backupTimerActive,
        retentionTimerActive: $systemd.retentionTimerActive,
        backupServiceActive: $systemd.backupServiceActive,
        retentionServiceActive: $systemd.retentionServiceActive,
        quiesceRecoveryActive: $systemd.quiesceRecoveryActive,
        tcp80Listening: $listeners.tcp80Listening,
        tcp443Listening: $listeners.tcp443Listening,
        udp80Listening: $listeners.udp80Listening,
        udp443Listening: $listeners.udp443Listening
      },
      database: $database
    }'
}

capture_is_financially_quiescent() {
  jq --exit-status '
    .database.snapshotAvailable
    and .database.activeWorkflows == 0
    and .database.unreleasedPaymentGuards == 0
    and .database.activeFinancialJobs == 0
    and .database.liveTenants == 0
    and .database.liveInstallations == 0
    and .database.preparedTransactions == 0
  ' <<<"$1" >/dev/null
}

capture_is_live_disabled() {
  jq --exit-status '
    .surface.liveInterlocksAvailable
    and .surface.platformLiveDisabled
    and .surface.workerLiveDisabled
    and .surface.liveWebhookDisabled
    and .surface.webEffectiveLiveDisabled
    and .surface.workerEffectiveLiveDisabled
  ' <<<"$1" >/dev/null
}

capture_is_initial_coherent() {
  jq --exit-status '
    def container($capture; $service): $capture.containers[] | select(.service == $service);
    . as $capture
    | all(["postgres","verifier","worker","web","caddy"][];
      . as $service
      | container($capture; $service).presentCount == 1
        and container($capture; $service).status == "RUNNING"
        and container($capture; $service).health == "HEALTHY"
        and container($capture; $service).projectLabelMatches
        and container($capture; $service).serviceLabelMatches
        and container($capture; $service).revisionLabelMatches
        and container($capture; $service).imageIdentityMatches
        and container($capture; $service).imageReferenceMatches)
    and all(["postgres","verifier","worker","web"][];
      . as $service | container($capture; $service).noPublishedPorts)
    and $capture.control.reservationValid
    and $capture.control.knownOneShotsPresentCount == 0
    and $capture.control.knownOneShotsRunningCount == 0
    and $capture.surface.systemdInventoryAvailable
    and $capture.surface.listenerInventoryAvailable
    and $capture.surface.backupTimerActive
    and $capture.surface.retentionTimerActive
    and ($capture.surface.backupServiceActive | not)
    and ($capture.surface.retentionServiceActive | not)
    and ($capture.surface.quiesceRecoveryActive | not)
    and $capture.surface.tcp80Listening
    and $capture.surface.tcp443Listening
    and ($capture.surface.udp80Listening | not)
    and ($capture.surface.udp443Listening | not)
  ' <<<"$1" >/dev/null
}

capture_is_reconcilable() {
  jq --exit-status '
    def container($capture; $service): $capture.containers[] | select(.service == $service);
    def exact($capture; $service):
      container($capture; $service).presentCount == 1
      and container($capture; $service).projectLabelMatches
      and container($capture; $service).serviceLabelMatches
      and container($capture; $service).revisionLabelMatches
      and container($capture; $service).imageIdentityMatches
      and container($capture; $service).imageReferenceMatches;
    def healthy($capture; $service):
      exact($capture; $service) and container($capture; $service).status == "RUNNING"
      and container($capture; $service).health == "HEALTHY";
    def target($capture; $service):
      healthy($capture; $service)
      or (exact($capture; $service)
        and (container($capture; $service).status == "CREATED"
          or container($capture; $service).status == "EXITED")
        and container($capture; $service).restartPolicy == "no");
    . as $capture
    | healthy($capture; "postgres") and healthy($capture; "verifier")
    and healthy($capture; "web") and target($capture; "worker") and target($capture; "caddy")
    and all(["postgres","verifier","worker","web"][];
      . as $service | container($capture; $service).noPublishedPorts)
    and $capture.control.reservationValid
    and $capture.control.knownOneShotsPresentCount == 0
    and $capture.control.knownOneShotsRunningCount == 0
    and $capture.surface.systemdInventoryAvailable
    and $capture.surface.listenerInventoryAvailable
    and ($capture.surface.backupServiceActive | not)
    and ($capture.surface.retentionServiceActive | not)
    and ($capture.surface.quiesceRecoveryActive | not)
    and ($capture.surface.udp80Listening | not)
    and ($capture.surface.udp443Listening | not)
  ' <<<"$1" >/dev/null
}

capture_is_contained() {
  jq --exit-status '
    def container($service): .containers[] | select(.service == $service);
    def core($service):
      container($service).presentCount == 1
      and container($service).status == "RUNNING"
      and container($service).health == "HEALTHY"
      and container($service).projectLabelMatches
      and container($service).serviceLabelMatches
      and container($service).revisionLabelMatches
      and container($service).imageIdentityMatches
      and container($service).imageReferenceMatches
      and container($service).noPublishedPorts;
    def stopped($service):
      container($service).presentCount == 0
      or (container($service).presentCount == 1
        and (container($service).status == "CREATED" or container($service).status == "EXITED")
        and container($service).restartPolicy == "no"
        and container($service).projectLabelMatches
        and container($service).serviceLabelMatches
        and container($service).revisionLabelMatches
        and container($service).imageIdentityMatches
        and container($service).imageReferenceMatches);
    core("postgres") and core("verifier") and core("web")
    and stopped("worker") and stopped("caddy")
    and .control.reservationValid
    and .control.knownOneShotsPresentCount == 0
    and .control.knownOneShotsRunningCount == 0
    and .control.unexpectedRunningContainerCount == 0
    and .control.activeReleaseUnitCount == 0
    and .control.activeFenceUnitCount == 0
    and .control.releaseRuntimeMarkerCount == 0
    and (.control.transitionPresent | not)
    and (.control.backupUploadJournalPresent | not)
    and (.control.managedTransitionPresent | not)
    and .surface.systemdInventoryAvailable
    and .surface.listenerInventoryAvailable
    and (.surface.backupTimerActive | not)
    and (.surface.retentionTimerActive | not)
    and (.surface.backupServiceActive | not)
    and (.surface.retentionServiceActive | not)
    and (.surface.quiesceRecoveryActive | not)
    and (.surface.tcp80Listening | not)
    and (.surface.tcp443Listening | not)
    and (.surface.udp80Listening | not)
    and (.surface.udp443Listening | not)
  ' <<<"$1" >/dev/null && capture_is_live_disabled "$1" && capture_is_financially_quiescent "$1"
}

record_unit_stop() {
  local unit="$1"
  if [[ -z "${MUTATED_UNIT_TARGETS[${unit}]:-}" ]]; then
    MUTATED_UNIT_TARGETS["${unit}"]=1
    MUTATION_UNITS_STOP_REQUESTED=$((MUTATION_UNITS_STOP_REQUESTED + 1))
  fi
}

record_restart_fence() {
  local id="$1"
  if [[ -z "${RESTART_FENCED_CONTAINER_IDS[${id}]:-}" ]]; then
    RESTART_FENCED_CONTAINER_IDS["${id}"]=1
    MUTATION_CONTAINERS_RESTART_FENCED=$((MUTATION_CONTAINERS_RESTART_FENCED + 1))
  fi
}

record_container_stop() {
  local id="$1"
  if [[ -z "${STOPPED_CONTAINER_IDS[${id}]:-}" ]]; then
    STOPPED_CONTAINER_IDS["${id}"]=1
    MUTATION_CONTAINERS_STOPPED=$((MUTATION_CONTAINERS_STOPPED + 1))
  fi
}

stop_maintenance_units() {
  local unit
  for unit in refunddesk-backup.timer refunddesk-retention.timer \
    refunddesk-backup.service refunddesk-retention.service \
    refunddesk-quiesce-recovery.service; do
    timeout 20 systemctl stop "${unit}" >/dev/null || return 1
    record_unit_stop "${unit}"
  done
}

fence_service() {
  local service="$1" ids_output id inspect running expected_image expected_reference
  local -a ids
  case "${service}" in
    worker)
      expected_image="${EXPECTED_WORKER_IMAGE}"
      expected_reference="refunddesk-worker:sandbox-${EXPECTED_REVISION}"
      ;;
    caddy)
      expected_image="${EXPECTED_CADDY_IMAGE}"
      expected_reference="${CADDY_REFERENCE}"
      ;;
    bootstrap)
      expected_image="${EXPECTED_POSTGRES_IMAGE}"
      expected_reference="${POSTGRES_REFERENCE}"
      ;;
    migrate|maintenance)
      expected_image="${EXPECTED_MIGRATE_IMAGE}"
      expected_reference="refunddesk-migrate:sandbox-${EXPECTED_REVISION}"
      ;;
    *) return 1 ;;
  esac
  ids_output="$(bounded_capture 65536 timeout 15 docker container ls --all --no-trunc --quiet \
    --filter 'label=com.docker.compose.project=refunddesk' \
    --filter "label=com.docker.compose.service=${service}")" || return 1
  ids=()
  [[ -z "${ids_output}" ]] || mapfile -t ids <<<"${ids_output}"
  (( ${#ids[@]} <= 1 )) || return 1
  (( ${#ids[@]} == 1 )) || return 0
  id="${ids[0]}"
  [[ "${id}" =~ ^[0-9a-f]{64}$ ]] || return 1
  inspect="$(bounded_capture 65536 timeout 15 docker inspect -- "${id}")" || return 1
  jq --exit-status --arg id "${id}" --arg service "${service}" \
    --arg revision "${EXPECTED_REVISION}" --arg image "${expected_image}" \
    --arg reference "${expected_reference}" '
      length == 1 and .[0].Id == $id
      and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
      and .[0].Config.Labels["com.docker.compose.service"] == $service
      and .[0].Config.Labels["com.refunddesk.revision"] == $revision
      and .[0].Image == $image and .[0].Config.Image == $reference
      and (.[0].State.Running | type) == "boolean"
      and (.[0].HostConfig.RestartPolicy.Name | type) == "string"
    ' <<<"${inspect}" >/dev/null || return 1
  running="$(jq --raw-output '.[0].State.Running' <<<"${inspect}")"
  timeout 20 docker update --restart=no "${id}" >/dev/null || return 1
  if [[ "${running}" == "true" ]]; then
    if ! timeout 60 docker stop --time 45 "${id}" >/dev/null; then
      timeout 20 docker kill "${id}" >/dev/null || return 1
    fi
    record_container_stop "${id}"
  fi
  inspect="$(bounded_capture 65536 timeout 15 docker inspect -- "${id}")" || return 1
  jq --exit-status --arg id "${id}" --arg service "${service}" \
    --arg revision "${EXPECTED_REVISION}" '
      length == 1 and .[0].Id == $id
      and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
      and .[0].Config.Labels["com.docker.compose.service"] == $service
      and .[0].Config.Labels["com.refunddesk.revision"] == $revision
      and .[0].HostConfig.RestartPolicy.Name == "no"
      and .[0].State.Running == false
  ' <<<"${inspect}" >/dev/null || return 1
  record_restart_fence "${id}"
}

emergency_refence() {
  local unit service
  set +e
  for unit in refunddesk-backup.timer refunddesk-retention.timer \
    refunddesk-backup.service refunddesk-retention.service refunddesk-quiesce-recovery.service; do
    if timeout 20 systemctl stop "${unit}" >/dev/null 2>&1; then
      record_unit_stop "${unit}"
    fi
  done
  for service in caddy worker bootstrap migrate maintenance; do
    fence_service "${service}" >/dev/null 2>&1 || true
  done
}

empty_capture() {
  local fallback_journal=false
  if [[ "${JOURNAL_PRESENT_AT_INVOCATION_START}" == "true" &&
    ("${OPERATION}" == "backup" || "${OPERATION}" == "retention") &&
    "${JOURNAL_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
    fallback_journal=true
  fi
  jq --compact-output --null-input \
    --arg captured "$(timestamp_now 2>/dev/null || printf '1970-01-01T00:00:00Z')" \
    --argjson journal_present "${fallback_journal}" --arg operation "${OPERATION}" \
    --arg revision "${EXPECTED_REVISION}" --arg journal_sha "${JOURNAL_SHA256}" '{
    capturedAt: $captured,
    identity: {activeRevision:null,currentRevision:null,sourceRevision:null,
      releaseEnvironmentRevision:null,manifestSha256:null,composeSha256:null,commonSha256:null,helperSha256:null},
    journal: (if $journal_present then
      {present:true,operation:$operation,revision:$revision,status:"in_progress",sha256:$journal_sha}
    else {present:false,operation:null,revision:null,status:null,sha256:null} end),
    control: {activeReleaseUnitCount:null,activeFenceUnitCount:null,releaseRuntimeMarkerCount:null,
      transitionPresent:false,backupUploadJournalPresent:false,managedTransitionPresent:false,
      reservationValid:false,knownOneShotsRunningCount:null,knownOneShotsPresentCount:null,
      unexpectedRunningContainerCount:null},
    containers: ["postgres","verifier","worker","web","caddy"] | map({service:.,presentCount:0,
      containerId:null,imageId:null,expectedImageId:null,imageReferenceMatches:false,
      status:"MISSING",health:"MISSING",restartPolicy:null,projectLabelMatches:false,
      serviceLabelMatches:false,revisionLabelMatches:false,imageIdentityMatches:false,
      noPublishedPorts:false,effectiveGlobalLiveDisabled:null,
      effectiveLiveWebhookDisabled:null}),
    surface: {systemdInventoryAvailable:false,listenerInventoryAvailable:false,
      liveInterlocksAvailable:false,platformLiveDisabled:false,workerLiveDisabled:false,
      liveWebhookDisabled:false,webEffectiveLiveDisabled:false,workerEffectiveLiveDisabled:false,
      backupTimerActive:false,retentionTimerActive:false,backupServiceActive:false,
      retentionServiceActive:false,quiesceRecoveryActive:false,tcp80Listening:false,
      tcp443Listening:false,udp80Listening:false,udp443Listening:false},
    database: {snapshotAvailable:false,systemIdentifier:null,activeWorkflows:null,
      unreleasedPaymentGuards:null,activeFinancialJobs:null,liveTenants:null,
      liveInstallations:null,preparedTransactions:null,refundRequests:null,auditEvents:null}
  }'
}

public_capture() {
  jq --compact-output '
    .containers |= map({
      service, presentCount, containerId, imageId, expectedImageId,
      imageReferenceMatches, status, health, restartPolicy,
      projectLabelMatches, serviceLabelMatches, revisionLabelMatches
    })
  ' <<<"$1"
}

compact_json_sha256() {
  local value="$1" digest
  digest="$(printf '%s' "${value}" | sha256sum | cut -d ' ' -f 1)" || return 1
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "${digest}"
}

admission_invariant_sha256() {
  local public canonical
  public="$(public_capture "$1")" || return 1
  canonical="$(jq --compact-output --sort-keys '
    {
      identity,
      containers: [.containers[] | {
        service, presentCount, containerId, imageId, expectedImageId, imageReferenceMatches
      }],
      database,
      live: {
        liveInterlocksAvailable: .surface.liveInterlocksAvailable,
        platformLiveDisabled: .surface.platformLiveDisabled,
        workerLiveDisabled: .surface.workerLiveDisabled,
        liveWebhookDisabled: .surface.liveWebhookDisabled,
        webEffectiveLiveDisabled: .surface.webEffectiveLiveDisabled,
        workerEffectiveLiveDisabled: .surface.workerEffectiveLiveDisabled
      }
    }
  ' <<<"${public}")" || return 1
  compact_json_sha256 "${canonical}"
}

contained_state_sha256() {
  local public canonical
  public="$(public_capture "$1")" || return 1
  canonical="$(jq --compact-output --sort-keys 'del(.capturedAt,.journal)' <<<"${public}")" || return 1
  compact_json_sha256 "${canonical}"
}

test_kill_at() {
  local point="$1"
  if [[ "${REFUNDDESK_CONTAINMENT_TEST_MODE:-}" == "1" &&
    "${REFUNDDESK_CONTAINMENT_TEST_KILL_POINT:-}" == "${point}" ]]; then
    kill -KILL "$$"
  fi
}

emit_document() {
  local exit_code="$1" result code completed diagnostics admission a b after document marker_state
  local operation_json resumed_json journal_start_json marker_revision_json
  local marker_operation_json marker_runner_json marker_journal_json
  local marker_admission_json marker_contained_json
  if [[ -z "${CAPTURE_ADMISSION}" ]]; then
    if [[ -n "${CAPTURE_BEFORE_A}" ]]; then
      CAPTURE_ADMISSION="${CAPTURE_BEFORE_A}"
    else
      CAPTURE_ADMISSION="$(empty_capture)"
    fi
  fi
  [[ -n "${CAPTURE_BEFORE_A}" ]] || CAPTURE_BEFORE_A="${CAPTURE_ADMISSION}"
  [[ -n "${CAPTURE_BEFORE_B}" ]] || CAPTURE_BEFORE_B="${CAPTURE_BEFORE_A}"
  [[ -n "${CAPTURE_AFTER}" ]] || CAPTURE_AFTER="${CAPTURE_BEFORE_B}"
  admission="$(public_capture "${CAPTURE_ADMISSION}")" || return 1
  a="$(public_capture "${CAPTURE_BEFORE_A}")" || return 1
  b="$(public_capture "${CAPTURE_BEFORE_B}")" || return 1
  after="$(public_capture "${CAPTURE_AFTER}")" || return 1
  completed="$(timestamp_now 2>/dev/null || printf '1970-01-01T00:00:00Z')"
  if (( exit_code == 0 )); then
    result=PASS
    code=PASS_CONTAINED_JOURNAL_CLEARED
    diagnostics='[]'
  elif (( exit_code == EXIT_FAIL )); then
    result=FAIL
    code="${DIAGNOSTIC}"
    diagnostics="$(jq --compact-output --null-input --arg code "${DIAGNOSTIC}" '[$code]')"
  else
    result=INCOMPLETE
    code="${DIAGNOSTIC}"
    diagnostics="$(jq --compact-output --null-input --arg code "${DIAGNOSTIC}" '[$code]')"
  fi
  marker_state="${MARKER_STATE}"
  [[ -n "${OPERATION}" ]] && operation_json="$(jq --compact-output --null-input --arg value "${OPERATION}" '$value')" || operation_json=null
  [[ -n "${RESUMED_FROM_STATE}" ]] && resumed_json="$(jq --compact-output --null-input --arg value "${RESUMED_FROM_STATE}" '$value')" || resumed_json=null
  case "${JOURNAL_PRESENT_AT_INVOCATION_START}" in
    true|false) journal_start_json="${JOURNAL_PRESENT_AT_INVOCATION_START}" ;;
    *) journal_start_json=null ;;
  esac
  if [[ "${MARKER_STATE}" == "prepared" || "${MARKER_STATE}" == "contained_verified" ||
    "${MARKER_STATE}" == "quiesce_cleared" || "${MARKER_STATE}" == "complete" ]]; then
    marker_revision_json="$(jq --compact-output --null-input --arg value "${EXPECTED_REVISION}" '$value')"
    marker_operation_json="${operation_json}"
    marker_runner_json="$(jq --compact-output --null-input --arg value "${RUNNER_SHA256}" '$value')"
    [[ -n "${JOURNAL_SHA256}" ]] && marker_journal_json="$(jq --compact-output --null-input --arg value "${JOURNAL_SHA256}" '$value')" || marker_journal_json=null
    [[ -n "${ADMISSION_INVARIANT_SHA256}" ]] && marker_admission_json="$(jq --compact-output --null-input --arg value "${ADMISSION_INVARIANT_SHA256}" '$value')" || marker_admission_json=null
    [[ -n "${CONTAINED_STATE_SHA256}" ]] && marker_contained_json="$(jq --compact-output --null-input --arg value "${CONTAINED_STATE_SHA256}" '$value')" || marker_contained_json=null
  else
    marker_revision_json=null
    marker_operation_json=null
    marker_runner_json=null
    marker_journal_json=null
    marker_admission_json=null
    marker_contained_json=null
  fi
  document="$(jq --sort-keys --compact-output --null-input \
    --arg nonce "${NONCE}" --arg revision "${EXPECTED_REVISION}" \
    --arg started "${STARTED_AT}" --arg completed "${completed}" \
    --arg result "${result}" --arg code "${code}" --arg marker_state "${marker_state}" \
    --arg runner "${RUNNER_SHA256}" --arg journal "${JOURNAL_SHA256}" \
    --arg manifest "${EXPECTED_MANIFEST_SHA256}" --arg compose "${EXACT_COMPOSE_SHA256}" \
    --arg common "${EXACT_COMMON_SHA256}" --arg helper "${EXACT_HELPER_SHA256}" \
    --argjson exit_code "${exit_code}" --argjson diagnostics "${diagnostics}" \
    --argjson operation "${operation_json}" --argjson resumed "${resumed_json}" \
    --argjson journal_start "${journal_start_json}" --argjson admission "${admission}" \
    --argjson a "${a}" --argjson b "${b}" \
    --argjson marker_revision "${marker_revision_json}" --argjson marker_operation "${marker_operation_json}" \
    --argjson marker_runner "${marker_runner_json}" --argjson marker_journal "${marker_journal_json}" \
    --argjson marker_admission "${marker_admission_json}" \
    --argjson marker_contained "${marker_contained_json}" \
    --argjson after "${after}" --argjson units "${MUTATION_UNITS_STOP_REQUESTED}" \
    --argjson restart_fenced "${MUTATION_CONTAINERS_RESTART_FENCED}" \
    --argjson stopped "${MUTATION_CONTAINERS_STOPPED}" \
    --argjson reservation "${MUTATION_RESERVATION_RECONCILED}" \
    --argjson journal_cleared "${MUTATION_JOURNAL_CLEARED}" \
    --argjson marker_transitions "${MUTATION_MARKER_TRANSITIONS}" '
      def container($capture; $service): $capture.containers[] | select(.service == $service);
      def present_exact($container):
        $container.presentCount == 1 and $container.containerId != null
        and $container.imageId != null and $container.imageId == $container.expectedImageId
        and $container.imageReferenceMatches and $container.projectLabelMatches
        and $container.serviceLabelMatches and $container.revisionLabelMatches;
      def missing_exact($container):
        $container.presentCount == 0 and $container.containerId == null
        and $container.imageId == null and $container.expectedImageId == null
        and ($container.imageReferenceMatches | not) and $container.status == "MISSING"
        and $container.health == "MISSING" and $container.restartPolicy == null
        and ($container.projectLabelMatches | not) and ($container.serviceLabelMatches | not)
        and ($container.revisionLabelMatches | not);
      def core_healthy($capture):
        all(["postgres","verifier","web"][];
          . as $service
          | present_exact(container($capture; $service))
            and container($capture; $service).status == "RUNNING"
            and container($capture; $service).health == "HEALTHY");
      def stopped($capture; $service):
        missing_exact(container($capture; $service))
        or (present_exact(container($capture; $service))
          and (container($capture; $service).status == "CREATED"
            or container($capture; $service).status == "EXITED")
          and container($capture; $service).restartPolicy == "no");
      def finance_quiet($capture):
        $capture.database.snapshotAvailable and $capture.database.activeWorkflows == 0
        and $capture.database.unreleasedPaymentGuards == 0
        and $capture.database.activeFinancialJobs == 0 and $capture.database.liveTenants == 0
        and $capture.database.liveInstallations == 0 and $capture.database.preparedTransactions == 0;
      def live_disabled($capture):
        $capture.surface.liveInterlocksAvailable and $capture.surface.platformLiveDisabled
        and $capture.surface.workerLiveDisabled and $capture.surface.liveWebhookDisabled
        and $capture.surface.webEffectiveLiveDisabled and $capture.surface.workerEffectiveLiveDisabled;
      def maintenance_stopped($capture):
        $capture.surface.systemdInventoryAvailable
        and ($capture.surface.backupTimerActive | not)
        and ($capture.surface.retentionTimerActive | not)
        and ($capture.surface.backupServiceActive | not)
        and ($capture.surface.retentionServiceActive | not)
        and ($capture.surface.quiesceRecoveryActive | not);
      def listeners_closed($capture):
        $capture.surface.listenerInventoryAvailable and ($capture.surface.tcp80Listening | not)
        and ($capture.surface.tcp443Listening | not) and ($capture.surface.udp80Listening | not)
        and ($capture.surface.udp443Listening | not);
      def source_exact($capture):
        $capture.identity.activeRevision == $revision
        and $capture.identity.currentRevision == $revision
        and $capture.identity.sourceRevision == $revision
        and $capture.identity.releaseEnvironmentRevision == $revision
        and $capture.identity.manifestSha256 == $manifest
        and $capture.identity.composeSha256 == $compose
        and $capture.identity.commonSha256 == $common
        and $capture.identity.helperSha256 == $helper;
      def release_absent($capture):
        $capture.control.activeReleaseUnitCount == 0
        and $capture.control.activeFenceUnitCount == 0
        and $capture.control.releaseRuntimeMarkerCount == 0
        and ($capture.control.transitionPresent | not)
        and ($capture.control.backupUploadJournalPresent | not)
        and ($capture.control.managedTransitionPresent | not);
      def journal_absent($capture):
        ($capture.journal.present | not) and $capture.journal.operation == null
        and $capture.journal.revision == null and $capture.journal.status == null
        and $capture.journal.sha256 == null;
      ([$a,$b,$after]) as $all
      | ([$admission,$a,$b,$after]) as $evidence
      | ($evidence | all(.[]; .database.snapshotAvailable)
        and $admission.database == $a.database
        and $a.database == $b.database and $b.database == $after.database) as $financial_stable
      | ($evidence | all(.[]; core_healthy(.))) as $core_healthy
      | ($all | all(.[]; stopped(.; "worker"))) as $worker_stopped
      | ($all | all(.[]; stopped(.; "caddy"))) as $caddy_stopped
      | (($evidence | all(.[]; source_exact(.)))
        and $admission.identity == $a.identity
        and $a.identity == $b.identity and $b.identity == $after.identity) as $source_exact
      | (($evidence | all(.[];
          . as $capture
          | all(["postgres","verifier","web"][];
            . as $service | present_exact(container($capture; $service)))))
        and ([$admission.containers[] | select(.service == "postgres" or .service == "verifier" or .service == "web")
          | {service,containerId,imageId,expectedImageId,imageReferenceMatches}])
          == ([$a.containers[] | select(.service == "postgres" or .service == "verifier" or .service == "web")
          | {service,containerId,imageId,expectedImageId,imageReferenceMatches}])
        and ([$a.containers[] | select(.service == "postgres" or .service == "verifier" or .service == "web")
          | {service,containerId,imageId,expectedImageId,imageReferenceMatches}])
          == ([$b.containers[] | select(.service == "postgres" or .service == "verifier" or .service == "web")
          | {service,containerId,imageId,expectedImageId,imageReferenceMatches}])
        and ([$b.containers[] | select(.service == "postgres" or .service == "verifier" or .service == "web")
          | {service,containerId,imageId,expectedImageId,imageReferenceMatches}])
          == ([$after.containers[] | select(.service == "postgres" or .service == "verifier" or .service == "web")
          | {service,containerId,imageId,expectedImageId,imageReferenceMatches}])) as $core_stable
      | (($a.journal.present and $a.journal.operation == $operation
          and $a.journal.revision == $revision and $a.journal.status == "in_progress"
          and $a.journal.sha256 != null and $a.journal == $b.journal)
        or (journal_absent($a) and journal_absent($b) and $journal_start == false
          and ($resumed == "contained_verified" or $resumed == "quiesce_cleared" or $resumed == "complete")
          and $marker_journal != null and $marker_operation == $operation
          and $marker_revision == $revision and $marker_runner == $runner)) as $original_journal_known
      | {
          schemaVersion: 1,
          kind: "refunddesk.lightsail.containment-reconciliation",
          nonce: $nonce,
          expectedRevision: $revision,
          operation: $operation,
          startedAt: $started,
          completedAt: $completed,
          exitCode: $exit_code,
          result: $result,
          code: $code,
          diagnostics: $diagnostics,
          marker: {
            state: $marker_state, resumedFromState: $resumed,
            journalPresentAtInvocationStart: $journal_start,
            revision: $marker_revision, operation: $marker_operation,
            runnerSha256: $marker_runner,
            journalSha256: $marker_journal,
            admissionInvariantSha256: $marker_admission,
            containedStateSha256: $marker_contained
          },
          captures: {admission: $admission, before: {a: $a, b: $b}, after: $after},
          containment: {
            sourceExact: $source_exact,
            liveDisabled: ($evidence | all(.[]; live_disabled(.))),
            financialStable: $financial_stable,
            financialQuiescent: ($evidence | all(.[]; finance_quiet(.))),
            coreHealthy: $core_healthy,
            coreContainerIdentitiesStable: $core_stable,
            workerStopped: $worker_stopped,
            caddyStopped: $caddy_stopped,
            oneShotsStopped: ($evidence | all(.[];
              .control.knownOneShotsPresentCount == 0
              and .control.knownOneShotsRunningCount == 0
              and .control.unexpectedRunningContainerCount == 0)),
            maintenanceStopped: ($all | all(.[]; maintenance_stopped(.))),
            publicListenersClosed: ($all | all(.[]; listeners_closed(.))),
            releaseFenceAbsent: ($evidence | all(.[]; release_absent(.))),
            reservationValid: ($evidence | all(.[]; .control.reservationValid)),
            journalCleared: ($original_journal_known and journal_absent($after)),
            markerComplete: ($marker_state == "complete")
          },
          mutations: {
            unitsStopRequested: $units,
            containersRestartFenced: $restart_fenced,
            containersStopped: $stopped,
            reservationReconciled: $reservation,
            journalCleared: $journal_cleared,
            markerTransitions: $marker_transitions
          },
          redaction: {
            rawSecretPresent: false, rawApiKeyPresent: false, rawSignaturePresent: false,
            rawPayloadPresent: false, customerDataPresent: false, arbitraryPathPresent: false,
            ipAddressPresent: false, stderrPresent: false, keyDigestPresent: false
          }
        }
    ')" || return 1
  (( ${#document} > 0 && ${#document} < MAX_OUTPUT_BYTES )) || return 1
  OUTPUT_EMITTED=true
  printf '%s\n' "${document}"
}

on_exit() {
  local status=$? journal_values journal_operation journal_digest
  trap - EXIT
  set +e
  if [[ "${OUTPUT_EMITTED}" != "true" ]]; then
    if [[ "${FENCE_ARMED}" == "true" ]]; then emergency_refence; fi
    [[ -n "${STARTED_AT}" ]] || STARTED_AT="$(timestamp_now 2>/dev/null || printf '1970-01-01T00:00:00Z')"
    if [[ "${SOURCE_VALIDATED}" == "true" && -z "${OPERATION}" &&
      (-e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}") ]]; then
      journal_values="$(validate_quiesce_journal 2>/dev/null)" || journal_values=""
      if [[ -n "${journal_values}" ]]; then
        IFS='|' read -r journal_operation journal_digest <<<"${journal_values}"
        OPERATION="${journal_operation}"
        JOURNAL_SHA256="${journal_digest}"
        JOURNAL_PRESENT_AT_INVOCATION_START=true
      fi
    fi
    if [[ "${SOURCE_VALIDATED}" == "true" && -n "${EXPECTED_POSTGRES_IMAGE}" ]]; then
      CAPTURE_AFTER="$(capture_host 2>/dev/null)" || true
      if [[ -n "${CAPTURE_AFTER}" ]]; then
        [[ -n "${CAPTURE_ADMISSION}" ]] || CAPTURE_ADMISSION="${CAPTURE_AFTER}"
        if [[ -z "${CAPTURE_BEFORE_A}" ]]; then
          CAPTURE_BEFORE_A="${CAPTURE_ADMISSION}"
          CAPTURE_BEFORE_B="${CAPTURE_ADMISSION}"
        fi
      fi
    fi
    (( RESULT_EXIT == EXIT_FAIL || RESULT_EXIT == EXIT_INCOMPLETE )) || RESULT_EXIT="${EXIT_INCOMPLETE}"
    emit_document "${RESULT_EXIT}" || true
    status="${RESULT_EXIT}"
  fi
  exit "${status}"
}
trap on_exit EXIT

main() {
  local required service preflight journal_values journal_operation journal_digest
  local journal_expected=present
  local before_ids admission_ids after_ids admission_digest contained_digest_a
  local contained_digest_b contained_digest_after

  STARTED_AT="$(timestamp_now)" || fail TOOL_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  for required in bash cut date dirname docker flock grep head id jq python3 readlink sha256sum ss stat systemctl timeout tr; do
    command -v "${required}" >/dev/null 2>&1 ||
      fail TOOL_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  done
  directory_is_controlled "${CONTROL_ROOT}" 700 ||
    fail CONTROL_ROOT_INVALID "${EXIT_FAIL}" || return 1
  acquire_exclusive_lock || return 1
  validate_source_contract || return 1
  SOURCE_VALIDATED=true
  release_controls_absent || fail RELEASE_TRANSITION_ACTIVE "${EXIT_FAIL}" || return 1
  binding_disabled "${PLATFORM_ENV}" REFUNDDESK_GLOBAL_LIVE_ENABLED false &&
    binding_disabled "${WORKER_ENV}" REFUNDDESK_GLOBAL_LIVE_ENABLED false &&
    binding_disabled "${PLATFORM_ENV}" STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET disabled ||
    fail LIVE_INTERLOCK_INVALID "${EXIT_FAIL}" || return 1

  if [[ -e "${SUCCESSOR_MARKER}" || -L "${SUCCESSOR_MARKER}" ]]; then
    if ! validate_marker; then
      MARKER_STATE=invalid
      RESUMED_FROM_STATE=invalid
      fail SUCCESSOR_MARKER_INVALID "${EXIT_FAIL}" || return 1
    fi
    RESUMED_FROM_STATE="${MARKER_STATE}"
  else
    RESUMED_FROM_STATE=absent
    journal_values="$(validate_quiesce_journal)" ||
      fail QUIESCE_JOURNAL_INVALID "${EXIT_FAIL}" || return 1
    IFS='|' read -r journal_operation journal_digest <<<"${journal_values}"
    OPERATION="${journal_operation}"
    JOURNAL_SHA256="${journal_digest}"
  fi
  if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]; then
    JOURNAL_PRESENT_AT_INVOCATION_START=true
  else
    JOURNAL_PRESENT_AT_INVOCATION_START=false
  fi

  case "${MARKER_STATE}" in
    absent|prepared)
      journal_values="$(validate_quiesce_journal)" ||
        fail QUIESCE_JOURNAL_INVALID "${EXIT_FAIL}" || return 1
      IFS='|' read -r journal_operation journal_digest <<<"${journal_values}"
      [[ "${journal_operation}" == "${OPERATION}" && "${journal_digest}" == "${JOURNAL_SHA256}" ]] ||
        fail QUIESCE_JOURNAL_DIVERGED "${EXIT_FAIL}" || return 1
      ;;
    contained_verified)
      if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]; then
        journal_values="$(validate_quiesce_journal)" ||
          fail QUIESCE_JOURNAL_INVALID "${EXIT_FAIL}" || return 1
        IFS='|' read -r journal_operation journal_digest <<<"${journal_values}"
        [[ "${journal_operation}" == "${OPERATION}" && "${journal_digest}" == "${JOURNAL_SHA256}" ]] ||
          fail QUIESCE_JOURNAL_DIVERGED "${EXIT_FAIL}" || return 1
      else
        journal_expected=absent
      fi
      ;;
    quiesce_cleared|complete)
      [[ ! -e "${QUIESCE_JOURNAL}" && ! -L "${QUIESCE_JOURNAL}" ]] ||
        fail QUIESCE_JOURNAL_DIVERGED "${EXIT_FAIL}" || return 1
      journal_expected=absent
      ;;
    *) fail SUCCESSOR_MARKER_INVALID "${EXIT_FAIL}" || return 1 ;;
  esac
  case "${MARKER_STATE}" in
    absent) MUTATION_MARKER_TRANSITIONS=0 ;;
    prepared) MUTATION_MARKER_TRANSITIONS=1 ;;
    contained_verified)
      MUTATION_MARKER_TRANSITIONS=2
      ;;
    quiesce_cleared)
      MUTATION_MARKER_TRANSITIONS=3
      MUTATION_JOURNAL_CLEARED=1
      ;;
    complete)
      MUTATION_MARKER_TRANSITIONS=4
      MUTATION_JOURNAL_CLEARED=1
      ;;
  esac
  if [[ "${MARKER_STATE}" == "contained_verified" &&
    "${JOURNAL_PRESENT_AT_INVOCATION_START}" == "false" ]]; then
    MUTATION_JOURNAL_CLEARED=1
  fi

  preflight="$(capture_host)" || fail HOST_INVENTORY_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  CAPTURE_ADMISSION="${preflight}"
  CAPTURE_BEFORE_A="${preflight}"
  CAPTURE_BEFORE_B="${preflight}"
  CAPTURE_AFTER="${preflight}"
  jq --exit-status --arg expected "${journal_expected}" --arg operation "${OPERATION}" \
    --arg revision "${EXPECTED_REVISION}" --arg sha "${JOURNAL_SHA256}" '
      if $expected == "present" then
        .journal.present and .journal.operation == $operation and .journal.revision == $revision
        and .journal.status == "in_progress" and .journal.sha256 == $sha
      else
        (.journal.present | not) and .journal.operation == null and .journal.revision == null
        and .journal.status == null and .journal.sha256 == null
      end
    ' <<<"${preflight}" >/dev/null ||
    fail QUIESCE_JOURNAL_DIVERGED "${EXIT_FAIL}" || return 1
  capture_is_live_disabled "${preflight}" || fail LIVE_INTERLOCK_INVALID "${EXIT_FAIL}" || return 1
  capture_is_financially_quiescent "${preflight}" || fail FINANCIAL_WORK_ACTIVE "${EXIT_FAIL}" || return 1
  case "${RESUMED_FROM_STATE}" in
    absent) capture_is_initial_coherent "${preflight}" ;;
    prepared) capture_is_reconcilable "${preflight}" ;;
    contained_verified|quiesce_cleared|complete) capture_is_contained "${preflight}" ;;
    *) false ;;
  esac || fail CONTAINMENT_NOT_PROVEN "${EXIT_FAIL}" || return 1
  jq --exit-status '
    .control.activeReleaseUnitCount == 0 and .control.activeFenceUnitCount == 0
    and .control.releaseRuntimeMarkerCount == 0 and (.control.transitionPresent | not)
    and (.control.backupUploadJournalPresent | not) and (.control.managedTransitionPresent | not)
    and .control.reservationValid
    and .control.knownOneShotsPresentCount == 0
    and .control.knownOneShotsRunningCount == 0
    and .control.unexpectedRunningContainerCount == 0
  ' <<<"${preflight}" >/dev/null || fail HOST_STATE_DIVERGED "${EXIT_FAIL}" || return 1
  admission_digest="$(admission_invariant_sha256 "${preflight}")" ||
    fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  if [[ "${MARKER_STATE}" == "absent" ]]; then
    ADMISSION_INVARIANT_SHA256="${admission_digest}"
  else
    [[ "${admission_digest}" == "${ADMISSION_INVARIANT_SHA256}" ]] ||
      fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  fi
  case "${MARKER_STATE}" in
    contained_verified|quiesce_cleared|complete)
      contained_digest_a="$(contained_state_sha256 "${preflight}")" ||
        fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
      [[ "${contained_digest_a}" == "${CONTAINED_STATE_SHA256}" ]] ||
        fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
      ;;
  esac

  # Admission is complete: exact source/control, no release transition, live
  # disabled and a quiescent database were all proven under the exclusive lock.
  FENCE_ARMED=true

  if [[ "${MARKER_STATE}" == "absent" ]]; then
    write_marker_state prepared || fail MARKER_DURABILITY_FAILED "${EXIT_INCOMPLETE}" || return 1
    test_kill_at after_prepared
  fi
  stop_maintenance_units || fail UNIT_STOP_FAILED "${EXIT_FAIL}" || return 1
  test_kill_at after_units
  for service in caddy worker bootstrap migrate maintenance; do
    fence_service "${service}" || fail CONTAINER_FENCE_FAILED "${EXIT_FAIL}" || return 1
    case "${service}" in
      caddy) test_kill_at after_caddy ;;
      worker) test_kill_at after_worker ;;
    esac
  done
  reservation_valid || fail RESERVATION_RECONCILIATION_FAILED "${EXIT_FAIL}" || return 1
  release_controls_absent || fail RELEASE_TRANSITION_ACTIVE "${EXIT_FAIL}" || return 1

  CAPTURE_BEFORE_A="$(capture_host)" || fail HOST_INVENTORY_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  CAPTURE_BEFORE_B="${CAPTURE_BEFORE_A}"
  CAPTURE_AFTER="${CAPTURE_BEFORE_A}"
  CAPTURE_BEFORE_B="$(capture_host)" || fail HOST_INVENTORY_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  CAPTURE_AFTER="${CAPTURE_BEFORE_B}"
  capture_is_contained "${CAPTURE_BEFORE_A}" && capture_is_contained "${CAPTURE_BEFORE_B}" ||
    fail CONTAINMENT_NOT_PROVEN "${EXIT_FAIL}" || return 1
  [[ "$(admission_invariant_sha256 "${CAPTURE_BEFORE_A}")" == "${ADMISSION_INVARIANT_SHA256}" &&
    "$(admission_invariant_sha256 "${CAPTURE_BEFORE_B}")" == "${ADMISSION_INVARIANT_SHA256}" ]] ||
    fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  jq --exit-status --arg expected "${journal_expected}" --arg operation "${OPERATION}" \
    --arg revision "${EXPECTED_REVISION}" --arg sha "${JOURNAL_SHA256}" '
      if $expected == "present" then
        .journal.present and .journal.operation == $operation and .journal.revision == $revision
        and .journal.status == "in_progress" and .journal.sha256 == $sha
      else (.journal.present | not) end
    ' <<<"${CAPTURE_BEFORE_A}" >/dev/null &&
    jq --exit-status --argjson a "${CAPTURE_BEFORE_A}" '
      (. | del(.capturedAt)) == ($a | del(.capturedAt))
    ' <<<"${CAPTURE_BEFORE_B}" >/dev/null ||
    fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1

  contained_digest_a="$(contained_state_sha256 "${CAPTURE_BEFORE_A}")" ||
    fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  contained_digest_b="$(contained_state_sha256 "${CAPTURE_BEFORE_B}")" ||
    fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  [[ "${contained_digest_a}" == "${contained_digest_b}" ]] ||
    fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  if [[ "${MARKER_STATE}" == "prepared" ]]; then
    CONTAINED_STATE_SHA256="${contained_digest_a}"
  else
    [[ "${contained_digest_a}" == "${CONTAINED_STATE_SHA256}" ]] ||
      fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  fi
  admission_ids="$(jq --compact-output '[.containers[] | select(.service == "postgres" or .service == "verifier" or .service == "web") | .containerId]' <<<"${CAPTURE_ADMISSION}")"
  before_ids="$(jq --compact-output '[.containers[] | select(.service == "postgres" or .service == "verifier" or .service == "web") | .containerId]' <<<"${CAPTURE_BEFORE_A}")"
  [[ "${admission_ids}" == "${before_ids}" ]] ||
    fail CORE_IDENTITY_CHANGED "${EXIT_FAIL}" || return 1
  if [[ "${MARKER_STATE}" == "prepared" ]]; then
    write_marker_state contained_verified || fail MARKER_DURABILITY_FAILED "${EXIT_INCOMPLETE}" || return 1
    test_kill_at after_contained_verified
  fi
  if [[ "${MARKER_STATE}" == "contained_verified" ]]; then
    if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]; then
      timeout 20 python3 "${HELPER_FILE}" clear-quiesce --path "${QUIESCE_JOURNAL}" \
        --operation "${OPERATION}" --revision "${EXPECTED_REVISION}" >/dev/null ||
        fail QUIESCE_CLEAR_FAILED "${EXIT_FAIL}" || return 1
      MUTATION_JOURNAL_CLEARED=1
    fi
    [[ ! -e "${QUIESCE_JOURNAL}" && ! -L "${QUIESCE_JOURNAL}" ]] ||
      fail QUIESCE_CLEAR_FAILED "${EXIT_FAIL}" || return 1
    if [[ "${REFUNDDESK_CONTAINMENT_TEST_MODE:-}" == "1" &&
      "${REFUNDDESK_CONTAINMENT_TEST_ABORT_AFTER_CLEAR:-}" == "1" ]]; then
      fail INJECTED_POST_CLEAR_ABORT "${EXIT_INCOMPLETE}" || return 1
    fi
    write_marker_state quiesce_cleared || fail MARKER_DURABILITY_FAILED "${EXIT_INCOMPLETE}" || return 1
  fi

  CAPTURE_AFTER="$(capture_host)" || fail HOST_INVENTORY_UNAVAILABLE "${EXIT_INCOMPLETE}" || return 1
  capture_is_contained "${CAPTURE_AFTER}" || fail CONTAINMENT_NOT_PROVEN "${EXIT_FAIL}" || return 1
  jq --exit-status '.journal.present | not' <<<"${CAPTURE_AFTER}" >/dev/null ||
    fail QUIESCE_JOURNAL_DIVERGED "${EXIT_FAIL}" || return 1
  [[ "$(admission_invariant_sha256 "${CAPTURE_AFTER}")" == "${ADMISSION_INVARIANT_SHA256}" ]] ||
    fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  contained_digest_after="$(contained_state_sha256 "${CAPTURE_AFTER}")" ||
    fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  [[ "${contained_digest_after}" == "${CONTAINED_STATE_SHA256}" ]] ||
    fail CONTAINMENT_SNAPSHOTS_DIVERGED "${EXIT_FAIL}" || return 1
  jq --exit-status --argjson admission "${CAPTURE_ADMISSION}" \
    --argjson a "${CAPTURE_BEFORE_A}" --argjson b "${CAPTURE_BEFORE_B}" '
    .database == $admission.database and .database == $a.database and .database == $b.database
  ' <<<"${CAPTURE_AFTER}" >/dev/null || fail FINANCIAL_SNAPSHOT_DIVERGED "${EXIT_FAIL}" || return 1
  after_ids="$(jq --compact-output '[.containers[] | select(.service == "postgres" or .service == "verifier" or .service == "web") | .containerId]' <<<"${CAPTURE_AFTER}")"
  [[ "${admission_ids}" == "${before_ids}" && "${before_ids}" == "${after_ids}" ]] ||
    fail CORE_IDENTITY_CHANGED "${EXIT_FAIL}" || return 1
  if [[ "${MARKER_STATE}" == "quiesce_cleared" ]]; then
    write_marker_state complete || fail MARKER_DURABILITY_FAILED "${EXIT_INCOMPLETE}" || return 1
  fi
  [[ "${MARKER_STATE}" == "complete" ]] || fail SUCCESSOR_MARKER_INVALID "${EXIT_FAIL}" || return 1
  # These counters describe the validated durable operation, so a crash-resume
  # reports the same completed four-transition/journal-retirement semantics.
  MUTATION_JOURNAL_CLEARED=1
  MUTATION_MARKER_TRANSITIONS=4
  MUTATION_RESERVATION_RECONCILED=0
}

if main; then
  DIAGNOSTIC=PASS_CONTAINED_JOURNAL_CLEARED
  RESULT_EXIT=0
  emit_document 0 || {
    OUTPUT_EMITTED=false
    DIAGNOSTIC=OUTPUT_INVALID
    RESULT_EXIT="${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
  trap - EXIT
  exit 0
else
  exit "${RESULT_EXIT}"
fi
