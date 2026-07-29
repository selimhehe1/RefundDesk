#!/usr/bin/env bash

# Release contract:
# - The artifact directory contains three sibling files produced by CI:
#   refunddesk-sandbox-<40hex>.images.tar.zst, its .sha256 file, and
#   refunddesk-sandbox-<40hex>.manifest.json.
# - The manifest schema is version 1 and names exactly web/worker/migrate images.
# - Compose and operator scripts come from the immutable source directory whose
#   revision is promoted only after the deployment verifies successfully.
# - Root-only platform, worker, migration and maintenance environments exist.
# - The stable launcher already validated this source's release contract.
# - Database preparation is deliberately executed twice under one host flock to
#   prove idempotence. A root-only transition journal is durable before any new
#   verifier/worker/web process starts. A failed promotion stops every
#   public/effect process and permits only an exact journal-bound resume.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
export REFUNDDESK_COMPOSE_FILE="${SOURCE_ROOT}/deploy/lightsail/compose.yml"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

ARTIFACT_DIR=""
REVISION=""
PUBLIC_ORIGIN=""
EXPECTED_BUNDLE_SHA256=""
PROMOTION_STARTED=false
PROMOTION_COMPLETE=false
RELEASE_ENV_CHANGED=false
PREVIOUS_RELEASE_ENV_PRESENT=false
PREVIOUS_RELEASE_ENV_BACKUP=""
RELEASE_ENV_TMP=""
CURRENT_LINK_CHANGED=false
PREVIOUS_CURRENT_PRESENT=false
PREVIOUS_CURRENT_TARGET=""
CURRENT_LINK_TMP=""
ACTIVE_REVISION_CHANGED=false
PREVIOUS_ACTIVE_REVISION_PRESENT=false
PREVIOUS_ACTIVE_REVISION_BACKUP=""
ACTIVE_REVISION_TMP=""
MANIFEST_TMP=""
ROTATION_STATE_FILE="${REFUNDDESK_CONFIG_ROOT}/application-key-rotation-state.json"
ROTATION_STATE_CHANGED=false
PREVIOUS_ROTATION_STATE_PRESENT=false
PREVIOUS_ROTATION_STATE_BACKUP=""
ROTATION_STATE_TMP=""
TRANSITION_JOURNAL_FILE="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
TRANSITION_COMMIT_MARKER="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-committed.json"
TRANSITION_CANDIDATE_FILE=""
TARGET_FINGERPRINTS_FILE=""
PREVIOUS_FINGERPRINTS_FILE=""
TRANSITION_COMMITTED=false
RELEASE_FENCE_UNIT=""
RELEASE_FENCE_READY_FILE=""
RELEASE_CANDIDATE_ADMISSION_FILE=""
RELEASE_PROCESS_STARTTIME=""
BACKUP_CONFIGURATION_VALID=false
readonly RELEASE_CONTRACT_VERSION="2"
readonly STABLE_RELEASE_FENCE="/usr/local/sbin/refunddesk-release-fence"

usage() {
  cat <<'EOF'
Usage: sudo bash release.sh --artifact-dir DIR --expected-sha256 SHA256 [--revision FULL_SHA] [--origin HTTPS_ORIGIN]

If --revision is omitted, DIR must contain exactly one schema-v1 manifest.
If --origin is omitted, /etc/refunddesk/public-origin must contain one HTTPS origin.
SHA256 must come from the authenticated operator workstation, not the adjacent checksum file.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --artifact-dir)
      (( $# >= 2 )) || die "--artifact-dir requires a value"
      ARTIFACT_DIR="$2"
      shift 2
      ;;
    --revision)
      (( $# >= 2 )) || die "--revision requires a value"
      REVISION="$2"
      shift 2
      ;;
    --origin)
      (( $# >= 2 )) || die "--origin requires a value"
      PUBLIC_ORIGIN="$2"
      shift 2
      ;;
    --expected-sha256)
      (( $# >= 2 )) || die "--expected-sha256 requires a value"
      EXPECTED_BUNDLE_SHA256="$2"
      shift 2
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
require_command cmp
require_command docker
require_command jq
require_command python3
require_command sha256sum
require_command systemctl
require_command systemd-run
require_command zstd
acquire_operator_lock
install -d -o root -g root -m 0700 "${REFUNDDESK_CONTROL_ROOT}"
assert_root_secret_directory "${REFUNDDESK_CONTROL_ROOT}"
QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"
[[ ! -e "${QUIESCE_JOURNAL}" && ! -L "${QUIESCE_JOURNAL}" ]] ||
  die "release is blocked until an unfinished runtime quiescence is recovered"

[[ -n "${ARTIFACT_DIR}" ]] || die "--artifact-dir is required"
[[ "${EXPECTED_BUNDLE_SHA256}" =~ ^[0-9a-f]{64}$ ]] ||
  die "--expected-sha256 must be a lowercase SHA-256 supplied out of band"
ARTIFACT_DIR="$(readlink --canonicalize-existing -- "${ARTIFACT_DIR}")"
assert_safe_directory "${ARTIFACT_DIR}"

if [[ -z "${REVISION}" ]]; then
  mapfile -t manifests < <(
    find "${ARTIFACT_DIR}" -maxdepth 1 -type f \
      -name 'refunddesk-sandbox-*.manifest.json' -printf '%f\n'
  )
  (( ${#manifests[@]} == 1 )) ||
    die "artifact directory must contain exactly one manifest when --revision is omitted"
  REVISION="${manifests[0]#refunddesk-sandbox-}"
  REVISION="${REVISION%.manifest.json}"
fi
[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || die "revision must be a full lowercase 40-hex Git SHA"
[[ "${REFUNDDESK_COMPOSE_PROJECT}" == "refunddesk" ]] ||
  die "release fencing requires the fixed refunddesk Compose project"
[[ "${REFUNDDESK_RELEASE_SYSTEMD_UNIT:-}" =~ ^refunddesk-release-${REVISION:0:12}-[1-9][0-9]*\.service$ ]] ||
  die "release must run in its revision-bound transient systemd service"
[[ "$(systemctl show "${REFUNDDESK_RELEASE_SYSTEMD_UNIT}" --property=MainPID --value)" == "$$" ]] ||
  die "release systemd service does not own the current process"
[[ "$(systemctl show "${REFUNDDESK_RELEASE_SYSTEMD_UNIT}" --property=KillMode --value)" == "control-group" ]] ||
  die "release systemd service must kill its complete process cgroup"

EXPECTED_SOURCE_ROOT="${REFUNDDESK_ROOT}/releases/${REVISION}/source"
[[ "${SOURCE_ROOT}" == "${EXPECTED_SOURCE_ROOT}" ]] ||
  die "release script is not running from the revision-scoped source directory"
[[ "${REFUNDDESK_RELEASE_LAUNCHER_CONTRACT:-}" == "${RELEASE_CONTRACT_VERSION}" &&
  "${REFUNDDESK_RELEASE_LAUNCHER_PATH:-}" == "/usr/local/sbin/refunddesk-release" ]] ||
  die "release must be invoked by the stable host-side launcher"
assert_root_control_symlink \
  /usr/local/sbin/refunddesk-release \
  "${REFUNDDESK_CONTROL_PLANE_LINK}/scripts/release-launcher.sh"
assert_root_control_symlink \
  "${STABLE_RELEASE_FENCE}" \
  "${REFUNDDESK_CONTROL_PLANE_LINK}/scripts/release-fence.sh"
RELEASE_CONTRACT_FILE="${SOURCE_ROOT}/deploy/lightsail/RELEASE_CONTRACT_VERSION"
assert_root_control_file "${RELEASE_CONTRACT_FILE}"
mapfile -t release_contract_lines <"${RELEASE_CONTRACT_FILE}"
(( ${#release_contract_lines[@]} == 1 )) &&
  [[ "${release_contract_lines[0]}" == "${RELEASE_CONTRACT_VERSION}" ]] ||
  die "target source release contract is unsupported"
SOURCE_REVISION_FILE="${SOURCE_ROOT}/.refunddesk-revision"
assert_root_secret_file "${SOURCE_REVISION_FILE}"
mapfile -t source_revision_lines <"${SOURCE_REVISION_FILE}"
(( ${#source_revision_lines[@]} == 1 )) ||
  die "current deployment source revision marker must contain exactly one line"
[[ "${source_revision_lines[0]}" == "${REVISION}" ]] ||
  die "deployment source and image bundle revisions differ"

BUNDLE_NAME="refunddesk-sandbox-${REVISION}.images.tar.zst"
MANIFEST_NAME="refunddesk-sandbox-${REVISION}.manifest.json"
BUNDLE_PATH="${ARTIFACT_DIR}/${BUNDLE_NAME}"
MANIFEST_PATH="${ARTIFACT_DIR}/${MANIFEST_NAME}"
CHECKSUM_PATH="${BUNDLE_PATH}.sha256"

assert_regular_file "${BUNDLE_PATH}"
assert_regular_file "${MANIFEST_PATH}"
assert_regular_file "${CHECKSUM_PATH}"
for artifact_path in "${ARTIFACT_DIR}" "${BUNDLE_PATH}" "${MANIFEST_PATH}" "${CHECKSUM_PATH}"; do
  [[ "$(stat --format='%u' -- "${artifact_path}")" == "0" ]] ||
    die "release artifacts and their directory must be owned by root: ${artifact_path}"
  artifact_mode="$(stat --format='%a' -- "${artifact_path}")"
  (( (8#${artifact_mode} & 022) == 0 )) ||
    die "release artifacts must not be group/world writable: ${artifact_path}"
done

read -r checksum_file_hash checksum_file_name checksum_extra <"${CHECKSUM_PATH}"
checksum_file_name="${checksum_file_name#\\*}"
[[ "${checksum_file_hash}" =~ ^[0-9a-f]{64}$ &&
  "${checksum_file_hash}" == "${EXPECTED_BUNDLE_SHA256}" &&
  "${checksum_file_name}" == "${BUNDLE_NAME}" &&
  -z "${checksum_extra:-}" ]] ||
  die "checksum file has an unexpected shape or filename"
(
  cd -- "${ARTIFACT_DIR}"
  sha256sum --check --strict --status -- "${BUNDLE_NAME}.sha256"
) || die "bundle checksum verification failed"
zstd --test --quiet -- "${BUNDLE_PATH}" || die "bundle zstd integrity verification failed"

jq --exit-status \
  --arg revision "${REVISION}" \
  --arg bundle "${BUNDLE_NAME}" \
  --arg sha256 "${checksum_file_hash}" '
    type == "object"
    and keys == ["bundle","createdAt","images","platform","revision","schemaVersion","source"]
    and .schemaVersion == 1
    and .revision == $revision
    and .platform == "linux/amd64"
    and .source == "https://github.com/selimhehe1/RefundDesk"
    and (.createdAt | type == "string")
    and (.bundle | type == "object"
      and keys == ["file","sha256"]
      and .file == $bundle
      and .sha256 == $sha256)
    and (.images | type == "array" and length == 3)
    and ([.images[].role] | sort == ["migrate","web","worker"])
    and (all(.images[];
      type == "object"
      and keys == ["expectedUser","imageId","reference","role"]
      and .expectedUser == "node"
      and (.imageId | test("^sha256:[0-9a-f]{64}$"))
      and .reference == ("refunddesk-" + .role + ":sandbox-" + $revision)))
  ' "${MANIFEST_PATH}" >/dev/null ||
  die "manifest validation failed"

manifest_source="$(jq --raw-output '.source' "${MANIFEST_PATH}")"
date --date="$(jq --raw-output '.createdAt' "${MANIFEST_PATH}")" >/dev/null ||
  die "manifest createdAt is not a valid timestamp"

log "loading verified OCI bundle for revision ${REVISION}"
zstd --decompress --stdout -- "${BUNDLE_PATH}" | docker image load >/dev/null

for role in web worker migrate; do
  reference="refunddesk-${role}:sandbox-${REVISION}"
  expected_id="$(jq --raw-output --arg role "${role}" '.images[] | select(.role == $role) | .imageId' "${MANIFEST_PATH}")"
  inspect_json="$(docker image inspect "${reference}")"
  jq --exit-status \
    --arg id "${expected_id}" \
    --arg revision "${REVISION}" \
    --arg source "${manifest_source}" '
      length == 1
      and .[0].Id == $id
      and .[0].Os == "linux"
      and .[0].Architecture == "amd64"
      and .[0].Config.User == "node"
      and .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
      and .[0].Config.Labels["org.opencontainers.image.source"] == $source
    ' <<<"${inspect_json}" >/dev/null ||
    die "loaded ${role} image does not match its manifest contract"
done

PLATFORM_ENV="${REFUNDDESK_CONFIG_ROOT}/platform.env"
WORKER_ENV="${REFUNDDESK_CONFIG_ROOT}/worker.env"
MIGRATION_ENV="${REFUNDDESK_CONFIG_ROOT}/migration.env"
MAINTENANCE_ENV="${REFUNDDESK_CONFIG_ROOT}/maintenance.env"
CADDY_ENV="${REFUNDDESK_CONFIG_ROOT}/caddy.env"
ORIGIN_FILE="${REFUNDDESK_CONFIG_ROOT}/public-origin"
for environment_file in \
  "${PLATFORM_ENV}" \
  "${WORKER_ENV}" \
  "${MIGRATION_ENV}" \
  "${MAINTENANCE_ENV}" \
  "${CADDY_ENV}" \
  "${ORIGIN_FILE}"; do
  assert_root_secret_file "${environment_file}"
done
POSTGRES_SECRET_FILES=(
  "${REFUNDDESK_CONFIG_ROOT}/secrets/postgres-owner-password"
  "${REFUNDDESK_CONFIG_ROOT}/secrets/postgres-web-password"
  "${REFUNDDESK_CONFIG_ROOT}/secrets/postgres-worker-password"
  "${REFUNDDESK_CONFIG_ROOT}/secrets/postgres-queue-password"
  "${REFUNDDESK_CONFIG_ROOT}/secrets/postgres-maintenance-password"
)
for postgres_secret_file in "${POSTGRES_SECRET_FILES[@]}"; do
  assert_root_secret_file "${postgres_secret_file}"
done

IFS= read -r CONFIGURED_PUBLIC_ORIGIN <"${ORIGIN_FILE}"
[[ "${CONFIGURED_PUBLIC_ORIGIN}" =~ ^https://[A-Za-z0-9.-]+$ ]] ||
  die "root-owned public origin must be HTTPS without port, path, query or credentials"
if [[ -n "${PUBLIC_ORIGIN}" && "${PUBLIC_ORIGIN}" != "${CONFIGURED_PUBLIC_ORIGIN}" ]]; then
  die "supplied public origin differs from the root-owned origin file"
fi
PUBLIC_ORIGIN="${CONFIGURED_PUBLIC_ORIGIN}"

MIGRATE_IMAGE="refunddesk-migrate:sandbox-${REVISION}"
RELEASE_CONFIG_SUMMARY="$(
  docker run --rm \
  --network none \
  --user 0:0 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 384m \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  --mount "type=bind,source=${PLATFORM_ENV},target=/run/refunddesk/platform.env,readonly" \
  --mount "type=bind,source=${WORKER_ENV},target=/run/refunddesk/worker.env,readonly" \
  --mount "type=bind,source=${MIGRATION_ENV},target=/run/refunddesk/migration.env,readonly" \
  --mount "type=bind,source=${MAINTENANCE_ENV},target=/run/refunddesk/maintenance.env,readonly" \
  --mount "type=bind,source=${CADDY_ENV},target=/run/refunddesk/caddy.env,readonly" \
  --mount "type=bind,source=${ORIGIN_FILE},target=/run/refunddesk/public-origin,readonly" \
  "${MIGRATE_IMAGE}" \
  node packages/config/dist/check-release.js \
    /run/refunddesk/platform.env \
    /run/refunddesk/worker.env \
    /run/refunddesk/migration.env \
    /run/refunddesk/maintenance.env \
    /run/refunddesk/caddy.env \
    /run/refunddesk/public-origin
)" || die "release configuration validation failed"

jq --exit-status '
  type == "object"
  and keys == ["component","keyRotation","status"]
  and .component == "release-config"
  and .status == "separated"
  and (.keyRotation | type == "object"
    and keys == ["approvalAttestation","field","proof"]
    and all(.[]; . == "legacy" or . == "staged" or . == "active" or . == "rollback" or . == "retired"))
' <<<"${RELEASE_CONFIG_SUMMARY}" >/dev/null ||
  die "release configuration summary is invalid"

TARGET_FIELD_ROTATION_STATE="$(jq --raw-output '.keyRotation.field' <<<"${RELEASE_CONFIG_SUMMARY}")"
TARGET_PROOF_ROTATION_STATE="$(jq --raw-output '.keyRotation.proof' <<<"${RELEASE_CONFIG_SUMMARY}")"
TARGET_APPROVAL_ROTATION_STATE="$(
  jq --raw-output '.keyRotation.approvalAttestation' <<<"${RELEASE_CONFIG_SUMMARY}"
)"
for target_rotation_state in \
  "${TARGET_FIELD_ROTATION_STATE}" \
  "${TARGET_PROOF_ROTATION_STATE}" \
  "${TARGET_APPROVAL_ROTATION_STATE}"; do
  [[ "${target_rotation_state}" != "retired" ]] ||
    die "key retirement is disabled until retained rows and backups prove old-key independence"
done

TRANSITION_HELPER="${SOURCE_ROOT}/deploy/lightsail/scripts/release-transition-journal.py"
assert_root_control_file "${TRANSITION_HELPER}"
python3 "${TRANSITION_HELPER}" validate-maintenance \
  --environment "${MAINTENANCE_ENV}" \
  --password "${REFUNDDESK_CONFIG_ROOT}/secrets/postgres-maintenance-password" >/dev/null ||
  die "maintenance database authority is not bound to its exact host secret"
BACKUP_ENVIRONMENT="${REFUNDDESK_CONFIG_ROOT}/backup.env"
BACKUP_AWS_CONFIG="${REFUNDDESK_CONFIG_ROOT}/aws/config"
if [[ -e "${BACKUP_ENVIRONMENT}" || -L "${BACKUP_ENVIRONMENT}" ]]; then
  python3 "${TRANSITION_HELPER}" validate-backup \
    --environment "${BACKUP_ENVIRONMENT}" \
    --aws-config "${BACKUP_AWS_CONFIG}" >/dev/null ||
    die "backup scheduling configuration is invalid"
  BACKUP_CONFIGURATION_VALID=true
fi

durability_arguments=(
  fsync-paths
  --path "${PLATFORM_ENV}"
  --path "${WORKER_ENV}"
  --path "${MIGRATION_ENV}"
  --path "${MAINTENANCE_ENV}"
  --path "${CADDY_ENV}"
  --path "${ORIGIN_FILE}"
)
for postgres_secret_file in "${POSTGRES_SECRET_FILES[@]}"; do
  durability_arguments+=(--path "${postgres_secret_file}")
done
durability_arguments+=(
  --directory "${REFUNDDESK_CONFIG_ROOT}"
  --directory "${REFUNDDESK_CONFIG_ROOT}/secrets"
)
python3 "${TRANSITION_HELPER}" "${durability_arguments[@]}" >/dev/null ||
  die "release configuration and secret files could not be synchronized durably"
unset durability_arguments
cleanup_preflight_files() {
  [[ -z "${TRANSITION_CANDIDATE_FILE}" ]] || rm -f -- "${TRANSITION_CANDIDATE_FILE}"
  [[ -z "${TARGET_FINGERPRINTS_FILE}" ]] || rm -f -- "${TARGET_FINGERPRINTS_FILE}"
  [[ -z "${PREVIOUS_FINGERPRINTS_FILE}" ]] || rm -f -- "${PREVIOUS_FINGERPRINTS_FILE}"
}
trap cleanup_preflight_files EXIT
TARGET_FINGERPRINTS_FILE="$(
  mktemp "${REFUNDDESK_CONFIG_ROOT}/.application-key-target-fingerprints.XXXXXX"
)"
python3 "${TRANSITION_HELPER}" fingerprint-env \
  --platform "${PLATFORM_ENV}" \
  --worker "${WORKER_ENV}" >"${TARGET_FINGERPRINTS_FILE}" ||
  die "target application-key fingerprints are invalid"
chown root:root "${TARGET_FINGERPRINTS_FILE}"
chmod 0600 "${TARGET_FINGERPRINTS_FILE}"

ACTIVE_REVISION_FOR_ROTATION="none"
ACTIVE_REVISION_FILE="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
if [[ -e "${ACTIVE_REVISION_FILE}" || -L "${ACTIVE_REVISION_FILE}" ]]; then
  assert_root_control_file "${ACTIVE_REVISION_FILE}"
  mapfile -t active_revision_lines <"${ACTIVE_REVISION_FILE}"
  (( ${#active_revision_lines[@]} == 1 )) ||
    die "active revision marker must contain exactly one line"
  [[ "${active_revision_lines[0]}" =~ ^[0-9a-f]{40}$ ]] ||
    die "active revision marker is invalid"
  ACTIVE_REVISION_FOR_ROTATION="${active_revision_lines[0]}"
fi

CURRENT_SOURCE_REVISION_FOR_ROTATION="none"
CURRENT_SOURCE_LINK="${REFUNDDESK_ROOT}/current"
if [[ -L "${CURRENT_SOURCE_LINK}" ]]; then
  [[ "$(stat --format='%u' -- "${CURRENT_SOURCE_LINK}")" == "0" ]] ||
    die "current source symlink must be owned by root"
  CURRENT_SOURCE_ROOT="$(readlink --canonicalize-existing -- "${CURRENT_SOURCE_LINK}")"
  assert_safe_directory "${CURRENT_SOURCE_ROOT}"
  CURRENT_SOURCE_REVISION_FILE="${CURRENT_SOURCE_ROOT}/.refunddesk-revision"
  assert_root_secret_file "${CURRENT_SOURCE_REVISION_FILE}"
  mapfile -t current_source_revision_lines <"${CURRENT_SOURCE_REVISION_FILE}"
  (( ${#current_source_revision_lines[@]} == 1 )) ||
    die "current source revision marker must contain exactly one line"
  [[ "${current_source_revision_lines[0]}" =~ ^[0-9a-f]{40}$ ]] ||
    die "current source revision marker is invalid"
  CURRENT_SOURCE_REVISION_FOR_ROTATION="${current_source_revision_lines[0]}"
elif [[ -e "${CURRENT_SOURCE_LINK}" ]]; then
  die "current source path must be absent or a symlink"
fi

RECORDED_ROTATION_REVISION="none"
PREVIOUS_FIELD_ROTATION_STATE="none"
PREVIOUS_PROOF_ROTATION_STATE="none"
PREVIOUS_APPROVAL_ROTATION_STATE="none"
OBSERVED_ROTATION_STATE_PRESENT=false
OBSERVED_ROTATION_STATE_SCHEMA="none"
if [[ -e "${ROTATION_STATE_FILE}" || -L "${ROTATION_STATE_FILE}" ]]; then
  assert_root_secret_file "${ROTATION_STATE_FILE}"
  ROTATION_STATE_JSON="$(<"${ROTATION_STATE_FILE}")"
  jq --exit-status '
    type == "object"
    and (
      (.schemaVersion == 1 and keys == ["revision","schemaVersion","states"])
      or
      (.schemaVersion == 2 and keys == ["fingerprints","revision","schemaVersion","states"])
    )
    and (.revision | type == "string" and test("^[0-9a-f]{40}$"))
    and (.states | type == "object"
      and keys == ["approvalAttestation","field","proof"]
      and all(.[]; . == "legacy" or . == "staged" or . == "active" or . == "rollback" or . == "retired"))
    and (
      .schemaVersion == 1
      or
      (.fingerprints | type == "object"
        and keys == ["approvalAttestation","field","proof"]
        and all(.[];
          type == "object"
          and keys == ["v1","v2"]
          and all(.[];
            . == null
            or (type == "string" and test("^sha256:[0-9a-f]{64}$")))))
    )
  ' <<<"${ROTATION_STATE_JSON}" >/dev/null ||
    die "application key rotation state is invalid"
  OBSERVED_ROTATION_STATE_PRESENT=true
  OBSERVED_ROTATION_STATE_SCHEMA="$(jq --raw-output '.schemaVersion' <<<"${ROTATION_STATE_JSON}")"
  RECORDED_ROTATION_REVISION="$(jq --raw-output '.revision' <<<"${ROTATION_STATE_JSON}")"
  PREVIOUS_FIELD_ROTATION_STATE="$(jq --raw-output '.states.field' <<<"${ROTATION_STATE_JSON}")"
  PREVIOUS_PROOF_ROTATION_STATE="$(jq --raw-output '.states.proof' <<<"${ROTATION_STATE_JSON}")"
  PREVIOUS_APPROVAL_ROTATION_STATE="$(
    jq --raw-output '.states.approvalAttestation' <<<"${ROTATION_STATE_JSON}"
  )"
fi

PREVIOUS_FINGERPRINTS_FILE="$(
  mktemp "${REFUNDDESK_CONFIG_ROOT}/.application-key-previous-fingerprints.XXXXXX"
)"
chown root:root "${PREVIOUS_FINGERPRINTS_FILE}"
chmod 0600 "${PREVIOUS_FINGERPRINTS_FILE}"

write_empty_fingerprints() {
  jq --compact-output --null-input '{
    approvalAttestation: {v1: null, v2: null},
    field: {v1: null, v2: null},
    proof: {v1: null, v2: null}
  }' >"$1"
}

fingerprint_active_containers() {
  local active_revision="$1"
  local web_container worker_container

  web_container="$(service_container_id web)"
  worker_container="$(service_container_id worker)"
  [[ -n "${web_container}" && -n "${worker_container}" ]] ||
    die "active web and worker containers are required to verify prior key continuity"
  docker inspect "${web_container}" "${worker_container}" |
    python3 "${TRANSITION_HELPER}" fingerprint-inspect \
      --expected-revision "${active_revision}"
}

if [[ -e "${TRANSITION_JOURNAL_FILE}" || -L "${TRANSITION_JOURNAL_FILE}" ]]; then
  assert_root_secret_file "${TRANSITION_JOURNAL_FILE}"
  python3 "${TRANSITION_HELPER}" prepare \
    --path "${TRANSITION_JOURNAL_FILE}" \
    --candidate "${TRANSITION_JOURNAL_FILE}" >/dev/null ||
    die "unfinished application-key transition journal is invalid"
  jq --exit-status \
    --arg revision "${REVISION}" \
    --arg field "${TARGET_FIELD_ROTATION_STATE}" \
    --arg proof "${TARGET_PROOF_ROTATION_STATE}" \
    --arg approval "${TARGET_APPROVAL_ROTATION_STATE}" \
    --slurpfile fingerprints "${TARGET_FINGERPRINTS_FILE}" '
      .to.revision == $revision
      and .to.recorded == true
      and .to.states == {
        approvalAttestation: $approval,
        field: $field,
        proof: $proof
      }
      and .to.fingerprints == $fingerprints[0]
    ' "${TRANSITION_JOURNAL_FILE}" >/dev/null ||
    die "unfinished transition differs from the requested revision, states or keys"

  FROM_REVISION="$(
    jq --raw-output '.from.revision // "none"' "${TRANSITION_JOURNAL_FILE}"
  )"
  FROM_ROTATION_RECORDED="$(
    jq --raw-output '.from.recorded' "${TRANSITION_JOURNAL_FILE}"
  )"
  FROM_FIELD_ROTATION_STATE="$(
    jq --raw-output '.from.states.field // "none"' "${TRANSITION_JOURNAL_FILE}"
  )"
  FROM_PROOF_ROTATION_STATE="$(
    jq --raw-output '.from.states.proof // "none"' "${TRANSITION_JOURNAL_FILE}"
  )"
  FROM_APPROVAL_ROTATION_STATE="$(
    jq --raw-output '.from.states.approvalAttestation // "none"' \
      "${TRANSITION_JOURNAL_FILE}"
  )"
  jq --compact-output '.from.fingerprints' \
    "${TRANSITION_JOURNAL_FILE}" >"${PREVIOUS_FINGERPRINTS_FILE}"

  for observed_revision in \
    "${ACTIVE_REVISION_FOR_ROTATION}" \
    "${CURRENT_SOURCE_REVISION_FOR_ROTATION}"; do
    [[ "${observed_revision}" == "${FROM_REVISION}" ||
      "${observed_revision}" == "${REVISION}" ]] ||
      die "release metadata diverged from both sides of the unfinished transition"
  done

  OBSERVED_ROTATION_PHASE="invalid"
  if [[ "${OBSERVED_ROTATION_STATE_PRESENT}" == "false" &&
    "${FROM_ROTATION_RECORDED}" == "false" ]]; then
    OBSERVED_ROTATION_PHASE="from"
  elif [[ "${OBSERVED_ROTATION_STATE_PRESENT}" == "true" ]]; then
    if jq --exit-status \
      --arg revision "${REVISION}" \
      --arg field "${TARGET_FIELD_ROTATION_STATE}" \
      --arg proof "${TARGET_PROOF_ROTATION_STATE}" \
      --arg approval "${TARGET_APPROVAL_ROTATION_STATE}" \
      --slurpfile fingerprints "${TARGET_FINGERPRINTS_FILE}" '
        .schemaVersion == 2
        and .revision == $revision
        and .states == {
          approvalAttestation: $approval,
          field: $field,
          proof: $proof
        }
        and .fingerprints == $fingerprints[0]
      ' <<<"${ROTATION_STATE_JSON}" >/dev/null; then
      OBSERVED_ROTATION_PHASE="to"
    elif [[ "${FROM_ROTATION_RECORDED}" == "true" ]] &&
      jq --exit-status \
        --arg revision "${FROM_REVISION}" \
        --arg field "${FROM_FIELD_ROTATION_STATE}" \
        --arg proof "${FROM_PROOF_ROTATION_STATE}" \
        --arg approval "${FROM_APPROVAL_ROTATION_STATE}" \
        --slurpfile fingerprints "${PREVIOUS_FINGERPRINTS_FILE}" '
          .revision == $revision
          and .states == {
            approvalAttestation: $approval,
            field: $field,
            proof: $proof
          }
          and (
            .schemaVersion == 1
            or (.schemaVersion == 2 and .fingerprints == $fingerprints[0])
          )
        ' <<<"${ROTATION_STATE_JSON}" >/dev/null; then
      OBSERVED_ROTATION_PHASE="from"
    fi
  fi
  [[ "${OBSERVED_ROTATION_PHASE}" != "invalid" ]] ||
    die "rotation state diverged from both sides of the unfinished transition"

  if [[ "${FROM_REVISION}" != "${REVISION}" ]]; then
    if [[ "${ACTIVE_REVISION_FOR_ROTATION}" == "${FROM_REVISION}" ]]; then
      [[ "${CURRENT_SOURCE_REVISION_FOR_ROTATION}" == "${FROM_REVISION}" &&
        "${OBSERVED_ROTATION_PHASE}" == "from" ]] ||
        die "unfinished transition metadata violates commit ordering"
    elif [[ "${CURRENT_SOURCE_REVISION_FOR_ROTATION}" == "${FROM_REVISION}" ]]; then
      [[ "${ACTIVE_REVISION_FOR_ROTATION}" == "${REVISION}" &&
        "${OBSERVED_ROTATION_PHASE}" == "from" ]] ||
        die "unfinished transition metadata violates commit ordering"
    elif [[ "${CURRENT_SOURCE_REVISION_FOR_ROTATION}" == "${REVISION}" ]]; then
      [[ "${ACTIVE_REVISION_FOR_ROTATION}" == "${REVISION}" ]] ||
        die "unfinished transition metadata violates commit ordering"
    fi
  fi

  ACTIVE_REVISION_FOR_ROTATION="${FROM_REVISION}"
  if [[ "${FROM_ROTATION_RECORDED}" == "true" ]]; then
    RECORDED_ROTATION_REVISION="${FROM_REVISION}"
    PREVIOUS_FIELD_ROTATION_STATE="${FROM_FIELD_ROTATION_STATE}"
    PREVIOUS_PROOF_ROTATION_STATE="${FROM_PROOF_ROTATION_STATE}"
    PREVIOUS_APPROVAL_ROTATION_STATE="${FROM_APPROVAL_ROTATION_STATE}"
  else
    RECORDED_ROTATION_REVISION="none"
    PREVIOUS_FIELD_ROTATION_STATE="none"
    PREVIOUS_PROOF_ROTATION_STATE="none"
    PREVIOUS_APPROVAL_ROTATION_STATE="none"
  fi
else
  [[ "${CURRENT_SOURCE_REVISION_FOR_ROTATION}" == "${ACTIVE_REVISION_FOR_ROTATION}" ]] ||
    die "active revision marker and current source revision differ"
  [[ "${RECORDED_ROTATION_REVISION}" == "none" ||
    "${RECORDED_ROTATION_REVISION}" == "${ACTIVE_REVISION_FOR_ROTATION}" ]] ||
    die "recorded rotation revision differs from the active revision"

  FROM_REVISION="${ACTIVE_REVISION_FOR_ROTATION}"
  FROM_ROTATION_RECORDED="${OBSERVED_ROTATION_STATE_PRESENT}"
  if [[ "${ACTIVE_REVISION_FOR_ROTATION}" == "none" ]]; then
    [[ "${OBSERVED_ROTATION_STATE_PRESENT}" == "false" ]] ||
      die "fresh host unexpectedly contains application-key rotation state"
    FROM_FIELD_ROTATION_STATE="none"
    FROM_PROOF_ROTATION_STATE="none"
    FROM_APPROVAL_ROTATION_STATE="none"
    write_empty_fingerprints "${PREVIOUS_FINGERPRINTS_FILE}"
  else
    fingerprint_active_containers \
      "${ACTIVE_REVISION_FOR_ROTATION}" >"${PREVIOUS_FINGERPRINTS_FILE}" ||
      die "active application-key fingerprints cannot be established"
    if [[ "${OBSERVED_ROTATION_STATE_PRESENT}" == "true" ]]; then
      FROM_FIELD_ROTATION_STATE="${PREVIOUS_FIELD_ROTATION_STATE}"
      FROM_PROOF_ROTATION_STATE="${PREVIOUS_PROOF_ROTATION_STATE}"
      FROM_APPROVAL_ROTATION_STATE="${PREVIOUS_APPROVAL_ROTATION_STATE}"
      if [[ "${OBSERVED_ROTATION_STATE_SCHEMA}" == "2" ]]; then
        jq --exit-status \
          --slurpfile fingerprints "${PREVIOUS_FINGERPRINTS_FILE}" \
          '.fingerprints == $fingerprints[0]' <<<"${ROTATION_STATE_JSON}" >/dev/null ||
          die "active containers differ from the recorded application-key fingerprints"
      fi
    else
      FROM_FIELD_ROTATION_STATE="legacy"
      FROM_PROOF_ROTATION_STATE="legacy"
      FROM_APPROVAL_ROTATION_STATE="legacy"
    fi
  fi
fi

python3 "${TRANSITION_HELPER}" assert-union \
  --previous "${PREVIOUS_FINGERPRINTS_FILE}" \
  --target "${TARGET_FINGERPRINTS_FILE}" >/dev/null ||
  die "target release does not preserve every previously accepted application key"

docker run --rm \
  --network none \
  --user 0:0 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 384m \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  "${MIGRATE_IMAGE}" \
  node packages/config/dist/check-key-rotation-transition.js \
    "${ACTIVE_REVISION_FOR_ROTATION}" \
    "${RECORDED_ROTATION_REVISION}" \
    "${PREVIOUS_FIELD_ROTATION_STATE}" \
    "${PREVIOUS_PROOF_ROTATION_STATE}" \
    "${PREVIOUS_APPROVAL_ROTATION_STATE}" \
    "${TARGET_FIELD_ROTATION_STATE}" \
    "${TARGET_PROOF_ROTATION_STATE}" \
    "${TARGET_APPROVAL_ROTATION_STATE}" >/dev/null ||
  die "application key rotation transition is not authorized"

TRANSITION_CANDIDATE_FILE="$(
  mktemp "${REFUNDDESK_CONFIG_ROOT}/.application-key-transition.XXXXXX"
)"
jq --compact-output --null-input \
  --arg fromRevision "${FROM_REVISION}" \
  --argjson fromRecorded "${FROM_ROTATION_RECORDED}" \
  --arg fromField "${FROM_FIELD_ROTATION_STATE}" \
  --arg fromProof "${FROM_PROOF_ROTATION_STATE}" \
  --arg fromApproval "${FROM_APPROVAL_ROTATION_STATE}" \
  --arg toRevision "${REVISION}" \
  --arg toField "${TARGET_FIELD_ROTATION_STATE}" \
  --arg toProof "${TARGET_PROOF_ROTATION_STATE}" \
  --arg toApproval "${TARGET_APPROVAL_ROTATION_STATE}" \
  --slurpfile fromFingerprints "${PREVIOUS_FINGERPRINTS_FILE}" \
  --slurpfile toFingerprints "${TARGET_FINGERPRINTS_FILE}" '
    {
      from: {
        fingerprints: $fromFingerprints[0],
        recorded: $fromRecorded,
        revision: (if $fromRevision == "none" then null else $fromRevision end),
        states: {
          approvalAttestation: (if $fromApproval == "none" then null else $fromApproval end),
          field: (if $fromField == "none" then null else $fromField end),
          proof: (if $fromProof == "none" then null else $fromProof end)
        }
      },
      schemaVersion: 1,
      status: "in_progress",
      to: {
        fingerprints: $toFingerprints[0],
        recorded: true,
        revision: $toRevision,
        states: {
          approvalAttestation: $toApproval,
          field: $toField,
          proof: $toProof
        }
      }
    }
  ' >"${TRANSITION_CANDIDATE_FILE}"
chown root:root "${TRANSITION_CANDIDATE_FILE}"
chmod 0600 "${TRANSITION_CANDIDATE_FILE}"

observed_release_process_starttime() {
  local process_stat process_suffix
  local -a process_fields

  [[ -r "/proc/$$/stat" ]] || return 1
  IFS= read -r process_stat <"/proc/$$/stat" || return 1
  process_suffix="${process_stat##*) }"
  read -r -a process_fields <<<"${process_suffix}"
  (( ${#process_fields[@]} >= 20 )) || return 1
  [[ "${process_fields[19]}" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "${process_fields[19]}"
}

target_container_ids() {
  local service="$1"
  local output

  output="$(
    docker container ls --all --quiet \
      --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
      --filter "label=com.docker.compose.service=${service}" \
      --filter "label=com.refunddesk.revision=${REVISION}"
  )" || return 1
  if [[ -n "${output}" ]]; then
    printf '%s\n' "${output}"
  fi
}

project_service_container_ids() {
  local service="$1"
  local output

  output="$(
    docker container ls --all --quiet \
      --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
      --filter "label=com.docker.compose.service=${service}"
  )" || return 1
  if [[ -n "${output}" ]]; then
    printf '%s\n' "${output}"
  fi
}

fence_target_candidates() {
  local container_id ids_output inspection running service
  local -a candidate_ids

  for service in \
    caddy web verifier worker \
    bootstrap migrate maintenance database-owner-reservation; do
    ids_output="$(project_service_container_ids "${service}")" ||
      die "Docker is unavailable during release-fence takeover"
    candidate_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t candidate_ids <<<"${ids_output}"
    fi
    for container_id in "${candidate_ids[@]}"; do
      [[ -n "${container_id}" ]] || continue
      docker update --restart=no "${container_id}" >/dev/null ||
        die "candidate ${service} restart policy could not be fenced"
      inspection="$(docker inspect "${container_id}")" ||
        die "candidate ${service} state could not be inspected before fencing"
      running="$(docker_running_state_from_inspection "${inspection}")" ||
        die "candidate ${service} running state is invalid"
      if [[ "${running}" == "true" ]]; then
        docker stop --time 45 "${container_id}" >/dev/null ||
          docker kill "${container_id}" >/dev/null ||
          die "candidate ${service} container could not be stopped"
      fi
    done
  done

  for service in \
    caddy web verifier worker \
    bootstrap migrate maintenance database-owner-reservation; do
    ids_output="$(project_service_container_ids "${service}")" ||
      die "Docker is unavailable during release-fence takeover verification"
    candidate_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t candidate_ids <<<"${ids_output}"
    fi
    for container_id in "${candidate_ids[@]}"; do
      [[ -n "${container_id}" ]] || continue
      inspection="$(docker inspect "${container_id}")" ||
        die "candidate ${service} fence inspection failed"
      jq --exit-status \
        --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
        --arg service "${service}" '
          length == 1
          and .[0].Config.Labels["com.docker.compose.project"] == $project
          and .[0].Config.Labels["com.docker.compose.service"] == $service
          and .[0].HostConfig.RestartPolicy.Name == "no"
          and .[0].State.Running == false
        ' <<<"${inspection}" >/dev/null ||
        die "candidate ${service} is not durably fenced"
      if [[ "${service}" == "bootstrap" ||
        "${service}" == "migrate" ||
        "${service}" == "maintenance" ]]; then
        docker rm --volumes "${container_id}" >/dev/null ||
          die "stopped candidate ${service} one-shot could not be removed"
      fi
    done
  done
}

assert_transition_jobs_reserved() {
  local ids_output service

  for service in bootstrap migrate maintenance; do
    ids_output="$(project_service_container_ids "${service}")" ||
      die "Docker is unavailable while proving one-shot release jobs absent"
    [[ -z "${ids_output}" ]] ||
      die "candidate ${service} one-shot remains after its serialized execution"
  done
  assert_database_owner_job_reservation "${REVISION}"
}

stop_stale_release_fences() {
  local fence_units unit

  fence_units="$(
    systemctl list-units --all --full --no-legend --plain \
      'refunddesk-release-fence-*.service'
  )" || die "existing release-fence units could not be enumerated"
  while read -r unit _; do
    [[ -n "${unit}" ]] || continue
    [[ "${unit}" =~ ^refunddesk-release-fence-[0-9a-f]{12}-[1-9][0-9]*\.service$ ]] ||
      die "unexpected release-fence unit name: ${unit}"
    systemctl stop "${unit}" ||
      die "existing release fence could not be stopped for exact takeover"
  done <<<"${fence_units}"
}

assert_release_fence_armed() {
  local -a admission_lines ready_lines

  systemctl is-active --quiet "${RELEASE_FENCE_UNIT}" ||
    die "release fence systemd unit is not active"
  assert_root_secret_file "${RELEASE_FENCE_READY_FILE}"
  mapfile -t ready_lines <"${RELEASE_FENCE_READY_FILE}"
  (( ${#ready_lines[@]} == 5 )) &&
    [[ "${ready_lines[0]}" == "revision=${REVISION}" ]] &&
    [[ "${ready_lines[1]}" == "pid=$$" ]] &&
    [[ "${ready_lines[2]}" == "starttime=${RELEASE_PROCESS_STARTTIME}" ]] &&
    [[ "${ready_lines[3]}" == "unit=${REFUNDDESK_RELEASE_SYSTEMD_UNIT}" ]] &&
    [[ "${ready_lines[4]}" == "admission=${RELEASE_CANDIDATE_ADMISSION_FILE}" ]] ||
    die "release fence readiness proof is invalid"
  if [[ -e "${RELEASE_CANDIDATE_ADMISSION_FILE}" ||
    -L "${RELEASE_CANDIDATE_ADMISSION_FILE}" ]]; then
    assert_root_secret_file "${RELEASE_CANDIDATE_ADMISSION_FILE}"
    mapfile -t admission_lines <"${RELEASE_CANDIDATE_ADMISSION_FILE}"
    (( ${#admission_lines[@]} == 1 )) &&
      [[ "${admission_lines[0]}" == "revision=${REVISION}" ]] ||
      die "candidate runtime admission proof is invalid"
  fi
}

arm_release_fence() {
  local deadline

  RELEASE_PROCESS_STARTTIME="$(observed_release_process_starttime)" ||
    die "release process starttime cannot be observed"
  RELEASE_FENCE_UNIT="refunddesk-release-fence-${REVISION:0:12}-$$.service"
  RELEASE_FENCE_READY_FILE="/run/refunddesk-release-fence-${REVISION:0:12}-$$.ready"
  RELEASE_CANDIDATE_ADMISSION_FILE="/run/refunddesk-release-candidate-${REVISION:0:12}-$$.admit"
  [[ ! -e "${RELEASE_FENCE_READY_FILE}" && ! -L "${RELEASE_FENCE_READY_FILE}" ]] ||
    die "release fence readiness path already exists"
  [[ ! -e "${RELEASE_CANDIDATE_ADMISSION_FILE}" &&
    ! -L "${RELEASE_CANDIDATE_ADMISSION_FILE}" ]] ||
    die "candidate runtime admission path already exists"

  systemd-run \
    --quiet \
    --collect \
    --unit="${RELEASE_FENCE_UNIT}" \
    --property=Type=exec \
    --property=Restart=on-failure \
    --property=RestartSec=1s \
    --property=TimeoutStopSec=5min \
    --setenv="REFUNDDESK_CONFIG_ROOT=${REFUNDDESK_CONFIG_ROOT}" \
    -- \
    "${STABLE_RELEASE_FENCE}" \
    --release-pid "$$" \
    --release-starttime "${RELEASE_PROCESS_STARTTIME}" \
    --release-unit "${REFUNDDESK_RELEASE_SYSTEMD_UNIT}" \
    --revision "${REVISION}" \
    --ready-file "${RELEASE_FENCE_READY_FILE}" \
    --admission-file "${RELEASE_CANDIDATE_ADMISSION_FILE}" ||
    die "release fence systemd unit could not be started"

  deadline=$((SECONDS + 15))
  while (( SECONDS < deadline )); do
    if [[ -f "${RELEASE_FENCE_READY_FILE}" && ! -L "${RELEASE_FENCE_READY_FILE}" ]]; then
      assert_release_fence_armed
      return 0
    fi
    systemctl is-active --quiet "${RELEASE_FENCE_UNIT}" ||
      die "release fence exited before becoming ready"
    sleep 1
  done
  die "release fence did not become ready"
}

prove_candidate_created_contract() {
  local container_id ids_output inspection service
  local -a candidate_ids

  for service in caddy web verifier worker; do
    ids_output="$(target_container_ids "${service}")" ||
      die "Docker is unavailable during candidate creation proof"
    candidate_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t candidate_ids <<<"${ids_output}"
    fi
    (( ${#candidate_ids[@]} == 1 )) ||
      die "candidate ${service} must reserve exactly one revision-bound container"
    container_id="${candidate_ids[0]}"
    inspection="$(docker inspect "${container_id}")" ||
      die "candidate ${service} creation inspection failed"
    jq --exit-status \
      --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
      --arg revision "${REVISION}" \
      --arg service "${service}" '
        length == 1
        and .[0].Config.Labels["com.docker.compose.project"] == $project
        and .[0].Config.Labels["com.docker.compose.service"] == $service
        and .[0].Config.Labels["com.refunddesk.revision"] == $revision
        and .[0].HostConfig.RestartPolicy.Name == "no"
        and .[0].State.Running == false
        and .[0].State.Status == "created"
      ' <<<"${inspection}" >/dev/null ||
      die "candidate ${service} was not created as an inert name reservation"
  done
}

enable_candidate_runtime() {
  local admission_tmp

  [[ ! -e "${RELEASE_CANDIDATE_ADMISSION_FILE}" &&
    ! -L "${RELEASE_CANDIDATE_ADMISSION_FILE}" ]] ||
    die "candidate runtime admission already exists"
  admission_tmp="${RELEASE_CANDIDATE_ADMISSION_FILE}.$$"
  rm -f -- "${admission_tmp}"
  printf 'revision=%s\n' "${REVISION}" >"${admission_tmp}"
  chown root:root "${admission_tmp}"
  chmod 0600 "${admission_tmp}"
  mv --no-target-directory -- "${admission_tmp}" "${RELEASE_CANDIDATE_ADMISSION_FILE}"
  assert_release_fence_armed
}

prove_candidate_runtime_contract() {
  local candidate_web_id="" candidate_worker_id=""
  local container_id ids_output inspection service runtime_fingerprints
  local -a candidate_ids

  for service in caddy web verifier worker; do
    ids_output="$(target_container_ids "${service}")" ||
      die "Docker is unavailable during candidate runtime proof"
    candidate_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t candidate_ids <<<"${ids_output}"
    fi
    (( ${#candidate_ids[@]} == 1 )) ||
      die "candidate ${service} must have exactly one revision-bound container"
    container_id="${candidate_ids[0]}"
    inspection="$(docker inspect "${container_id}")" ||
      die "candidate ${service} runtime inspection failed"
    jq --exit-status \
      --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
      --arg revision "${REVISION}" \
      --arg service "${service}" '
        length == 1
        and .[0].Config.Labels["com.docker.compose.project"] == $project
        and .[0].Config.Labels["com.docker.compose.service"] == $service
        and .[0].Config.Labels["com.refunddesk.revision"] == $revision
        and .[0].HostConfig.RestartPolicy.Name == "no"
        and .[0].State.Running == true
      ' <<<"${inspection}" >/dev/null ||
      die "candidate ${service} runtime is outside the transition contract"
    if [[ "${service}" == "web" ]]; then
      candidate_web_id="${container_id}"
    elif [[ "${service}" == "worker" ]]; then
      candidate_worker_id="${container_id}"
    fi
  done

  runtime_fingerprints="$(
    docker inspect "${candidate_web_id}" "${candidate_worker_id}" |
      python3 "${TRANSITION_HELPER}" fingerprint-inspect \
        --expected-revision "${REVISION}"
  )" || die "candidate web/worker application-key fingerprints are invalid"
  cmp --silent \
    <(printf '%s\n' "${runtime_fingerprints}") \
    "${TARGET_FINGERPRINTS_FILE}" ||
    die "candidate web/worker key fingerprints differ from the target configuration"
}

commit_release_environment() {
  RELEASE_ENV_TMP="$(mktemp "${REFUNDDESK_CONFIG_ROOT}/.release.env.XXXXXX")"
  printf 'REFUNDDESK_IMAGE_TAG=sandbox-%s\nREFUNDDESK_REVISION=%s\n' \
    "${REVISION}" "${REVISION}" >"${RELEASE_ENV_TMP}"
  chown root:root "${RELEASE_ENV_TMP}"
  chmod 0600 "${RELEASE_ENV_TMP}"
  python3 "${TRANSITION_HELPER}" durable-replace \
    --source "${RELEASE_ENV_TMP}" \
    --target "${REFUNDDESK_RELEASE_ENV}" \
    --mode 0600 >/dev/null ||
    die "committed release environment could not be synchronized durably"
  RELEASE_ENV_TMP=""
}

restore_runtime_restart_policies() {
  local container_id ids_output inspection service
  local -a candidate_ids

  for service in caddy web verifier worker; do
    ids_output="$(target_container_ids "${service}")" ||
      die "Docker is unavailable while restoring runtime restart policies"
    candidate_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t candidate_ids <<<"${ids_output}"
    fi
    (( ${#candidate_ids[@]} == 1 )) ||
      die "verified candidate ${service} disappeared after durable commit"
    container_id="${candidate_ids[0]}"
    docker update --restart=unless-stopped "${container_id}" >/dev/null ||
      die "candidate ${service} restart policy could not be restored"
    inspection="$(docker inspect "${container_id}")" ||
      die "candidate ${service} restart policy could not be inspected"
    jq --exit-status \
      --arg revision "${REVISION}" \
      --arg service "${service}" '
        length == 1
        and .[0].Config.Labels["com.docker.compose.service"] == $service
        and .[0].Config.Labels["com.refunddesk.revision"] == $revision
        and .[0].HostConfig.RestartPolicy.Name == "unless-stopped"
        and .[0].State.Running == true
      ' <<<"${inspection}" >/dev/null ||
      die "candidate ${service} restart policy restoration is unproven"
  done
}

wait_for_release_fence_disarm() {
  local deadline

  deadline=$((SECONDS + 15))
  while (( SECONDS < deadline )); do
    if ! systemctl is-active --quiet "${RELEASE_FENCE_UNIT}"; then
      [[ ! -e "${RELEASE_FENCE_READY_FILE}" &&
        ! -L "${RELEASE_FENCE_READY_FILE}" &&
        ! -e "${RELEASE_CANDIDATE_ADMISSION_FILE}" &&
        ! -L "${RELEASE_CANDIDATE_ADMISSION_FILE}" ]] ||
        die "inactive release fence left a runtime marker"
      systemctl is-failed --quiet "${RELEASE_FENCE_UNIT}" &&
        die "release fence failed while the journal was closing"
      return 0
    fi
    sleep 1
  done
  die "release fence did not disarm after durable journal closure"
}

fail_closed() {
  local status=$?
  local ids_output
  local metadata_rollback_ok=true
  local -a failed_runtime_ids
  trap - EXIT

  if [[ "${TRANSITION_COMMITTED}" != "true" &&
    -n "${TRANSITION_CANDIDATE_FILE}" &&
    -f "${TRANSITION_COMMIT_MARKER}" &&
    ! -L "${TRANSITION_COMMIT_MARKER}" ]] &&
    python3 "${TRANSITION_HELPER}" assert-commit \
      --marker "${TRANSITION_COMMIT_MARKER}" \
      --candidate "${TRANSITION_CANDIDATE_FILE}" >/dev/null 2>&1; then
    TRANSITION_COMMITTED=true
    log "durable transition commit marker recovered the post-commit failure state"
  fi

  [[ -z "${RELEASE_ENV_TMP}" ]] || rm -f -- "${RELEASE_ENV_TMP}"
  [[ -z "${CURRENT_LINK_TMP}" ]] || rm -f -- "${CURRENT_LINK_TMP}"
  [[ -z "${ACTIVE_REVISION_TMP}" ]] || rm -f -- "${ACTIVE_REVISION_TMP}"
  [[ -z "${MANIFEST_TMP}" ]] || rm -f -- "${MANIFEST_TMP}"
  [[ -z "${ROTATION_STATE_TMP}" ]] || rm -f -- "${ROTATION_STATE_TMP}"
  [[ -z "${TRANSITION_CANDIDATE_FILE}" ]] || rm -f -- "${TRANSITION_CANDIDATE_FILE}"
  [[ -z "${TARGET_FINGERPRINTS_FILE}" ]] || rm -f -- "${TARGET_FINGERPRINTS_FILE}"
  [[ -z "${PREVIOUS_FINGERPRINTS_FILE}" ]] || rm -f -- "${PREVIOUS_FINGERPRINTS_FILE}"

  if (( status != 0 )) &&
    [[ "${metadata_rollback_ok}" == "true" ]] &&
    [[ "${TRANSITION_COMMITTED}" != "true" && "${ROTATION_STATE_CHANGED}" == "true" ]]; then
    if [[ "${PREVIOUS_ROTATION_STATE_PRESENT}" == "true" ]]; then
      if python3 "${TRANSITION_HELPER}" durable-replace \
        --source "${PREVIOUS_ROTATION_STATE_BACKUP}" \
        --target "${ROTATION_STATE_FILE}" \
        --mode 0600 >/dev/null; then
        PREVIOUS_ROTATION_STATE_BACKUP=""
      else
        status=1
        metadata_rollback_ok=false
      fi
    else
      if ! python3 "${TRANSITION_HELPER}" durable-unlink \
        --target "${ROTATION_STATE_FILE}" >/dev/null; then
        status=1
        metadata_rollback_ok=false
      fi
    fi
  fi

  if (( status != 0 )) &&
    [[ "${metadata_rollback_ok}" == "true" ]] &&
    [[ "${TRANSITION_COMMITTED}" != "true" && "${CURRENT_LINK_CHANGED}" == "true" ]]; then
    log "restoring the previously active operator source"
    if [[ "${PREVIOUS_CURRENT_PRESENT}" == "true" ]]; then
      if ! python3 "${TRANSITION_HELPER}" durable-symlink \
        --target "${REFUNDDESK_ROOT}/current" \
        --value "${PREVIOUS_CURRENT_TARGET}" >/dev/null; then
        status=1
        metadata_rollback_ok=false
      fi
    else
      if ! python3 "${TRANSITION_HELPER}" durable-unlink \
        --target "${REFUNDDESK_ROOT}/current" >/dev/null; then
        status=1
        metadata_rollback_ok=false
      fi
    fi
  fi

  if (( status != 0 )) &&
    [[ "${metadata_rollback_ok}" == "true" ]] &&
    [[ "${TRANSITION_COMMITTED}" != "true" && "${ACTIVE_REVISION_CHANGED}" == "true" ]]; then
    if [[ "${PREVIOUS_ACTIVE_REVISION_PRESENT}" == "true" ]]; then
      if python3 "${TRANSITION_HELPER}" durable-replace \
        --source "${PREVIOUS_ACTIVE_REVISION_BACKUP}" \
        --target "${REFUNDDESK_ROOT}/ACTIVE_REVISION" \
        --mode 0644 >/dev/null; then
        PREVIOUS_ACTIVE_REVISION_BACKUP=""
      else
        status=1
        metadata_rollback_ok=false
      fi
    else
      if ! python3 "${TRANSITION_HELPER}" durable-unlink \
        --target "${REFUNDDESK_ROOT}/ACTIVE_REVISION" >/dev/null; then
        status=1
        metadata_rollback_ok=false
      fi
    fi
  fi

  if (( status != 0 )) &&
    [[ "${metadata_rollback_ok}" == "true" ]] &&
    [[ "${TRANSITION_COMMITTED}" != "true" && "${RELEASE_ENV_CHANGED}" == "true" ]]; then
    log "restoring the previously active image selection"
    if [[ "${PREVIOUS_RELEASE_ENV_PRESENT}" == "true" ]]; then
      if python3 "${TRANSITION_HELPER}" durable-replace \
        --source "${PREVIOUS_RELEASE_ENV_BACKUP}" \
        --target "${REFUNDDESK_RELEASE_ENV}" \
        --mode 0600 >/dev/null; then
        PREVIOUS_RELEASE_ENV_BACKUP=""
      else
        status=1
        metadata_rollback_ok=false
      fi
    else
      if ! python3 "${TRANSITION_HELPER}" durable-unlink \
        --target "${REFUNDDESK_RELEASE_ENV}" >/dev/null; then
        status=1
        metadata_rollback_ok=false
      fi
    fi
  fi

  if (( status != 0 )) &&
    [[ "${PROMOTION_STARTED}" == "true" && "${PROMOTION_COMPLETE}" != "true" ]]; then
    log "release validation failed; stopping public and effect-capable services"
    ids_output="$(
      docker container ls --all --quiet \
        --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
        --filter "label=com.refunddesk.revision=${REVISION}"
    )" || ids_output=""
    if [[ -n "${ids_output}" ]]; then
      mapfile -t failed_runtime_ids <<<"${ids_output}"
      docker update --restart=no "${failed_runtime_ids[@]}" >/dev/null 2>&1 || status=1
    fi
    refunddesk_compose stop --timeout 45 caddy web verifier worker >/dev/null 2>&1 ||
      status=1
    if [[ "${TRANSITION_COMMITTED}" == "true" ]]; then
      log "post-commit finalization failed; committed metadata is preserved and runtime remains stopped"
    fi
  fi

  if [[ "${TRANSITION_COMMITTED}" == "true" ]]; then
    [[ -z "${PREVIOUS_RELEASE_ENV_BACKUP}" ]] ||
      rm -f -- "${PREVIOUS_RELEASE_ENV_BACKUP}"
    [[ -z "${PREVIOUS_ACTIVE_REVISION_BACKUP}" ]] ||
      rm -f -- "${PREVIOUS_ACTIVE_REVISION_BACKUP}"
    [[ -z "${PREVIOUS_ROTATION_STATE_BACKUP}" ]] ||
      rm -f -- "${PREVIOUS_ROTATION_STATE_BACKUP}"
  else
    for recovery_artifact in \
      "${PREVIOUS_ROTATION_STATE_BACKUP}" \
      "${PREVIOUS_ACTIVE_REVISION_BACKUP}" \
      "${PREVIOUS_RELEASE_ENV_BACKUP}"; do
      [[ -z "${recovery_artifact}" ]] ||
        log "preserving root-only recovery artifact after incomplete rollback: ${recovery_artifact}"
    done
  fi
  exit "${status}"
}
trap fail_closed EXIT

PROMOTION_STARTED=true
fence_target_candidates
stop_stale_release_fences
fence_target_candidates

python3 "${TRANSITION_HELPER}" prepare \
  --path "${TRANSITION_JOURNAL_FILE}" \
  --candidate "${TRANSITION_CANDIDATE_FILE}" >/dev/null ||
  die "application-key transition journal could not be prepared"
arm_release_fence

if [[ -e "${REFUNDDESK_RELEASE_ENV}" || -L "${REFUNDDESK_RELEASE_ENV}" ]]; then
  assert_root_secret_file "${REFUNDDESK_RELEASE_ENV}"
  PREVIOUS_RELEASE_ENV_BACKUP="$(
    mktemp "${REFUNDDESK_CONFIG_ROOT}/.release.env.previous.XXXXXX"
  )"
  install -o root -g root -m 0600 \
    "${REFUNDDESK_RELEASE_ENV}" "${PREVIOUS_RELEASE_ENV_BACKUP}"
  PREVIOUS_RELEASE_ENV_PRESENT=true
fi

RELEASE_ENV_TMP="$(mktemp "${REFUNDDESK_CONFIG_ROOT}/.release.env.XXXXXX")"
printf 'REFUNDDESK_IMAGE_TAG=sandbox-%s\nREFUNDDESK_REVISION=%s\nREFUNDDESK_RUNTIME_RESTART_POLICY=no\n' \
  "${REVISION}" "${REVISION}" >"${RELEASE_ENV_TMP}"
RELEASE_ENV_CHANGED=true
chown root:root "${RELEASE_ENV_TMP}"
chmod 0600 "${RELEASE_ENV_TMP}"
python3 "${TRANSITION_HELPER}" durable-replace \
  --source "${RELEASE_ENV_TMP}" \
  --target "${REFUNDDESK_RELEASE_ENV}" \
  --mode 0600 >/dev/null ||
  die "transition release environment could not be synchronized durably"
RELEASE_ENV_TMP=""
export REFUNDDESK_IMAGE_TAG="sandbox-${REVISION}"
export REFUNDDESK_REVISION="${REVISION}"
export REFUNDDESK_RUNTIME_RESTART_POLICY=no

refunddesk_compose config --quiet
assert_release_fence_armed
refunddesk_compose create --no-deps --no-build --pull never verifier worker web caddy
prove_candidate_created_contract

log "proving the PostgreSQL 18 root-mount storage contract"
REFUNDDESK_POSTGRES_ROOT_MIGRATION_CONTRACT=release-v2 \
  bash "${SCRIPT_DIR}/prepare-postgres-root-mount.sh"

log "repairing the four restricted PostgreSQL application logins"
REFUNDDESK_DATABASE_BOOTSTRAP_CONTRACT=release-v2 \
  bash "${SCRIPT_DIR}/bootstrap-database.sh"

log "running serialized canonical database preparation (pass 1/2)"
clear_database_owner_job_reservation
refunddesk_compose --profile release run \
  --name "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" \
  --no-deps \
  --pull never \
  migrate
seal_database_owner_job_reservation migrate "${REVISION}"
log "running serialized canonical database preparation (pass 2/2)"
clear_database_owner_job_reservation
refunddesk_compose --profile release run \
  --name "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" \
  --no-deps \
  --pull never \
  migrate
seal_database_owner_job_reservation migrate "${REVISION}"

assert_transition_jobs_reserved
assert_release_fence_armed
enable_candidate_runtime
refunddesk_compose start worker web verifier
wait_for_container_health verifier 90 || die "private verifier proxy is not healthy"
wait_for_container_health worker 180 || die "worker is not healthy"
wait_for_container_health web 120 || die "web is not healthy"
refunddesk_compose start caddy
wait_for_container_health caddy 120 || die "public proxy is not healthy"
assert_release_fence_armed
prove_candidate_runtime_contract

REFUNDDESK_VERIFY_CONTRACT=release-v2 \
  bash "${SCRIPT_DIR}/verify-deployment.sh" --origin "${PUBLIC_ORIGIN}"
assert_release_fence_armed

RELEASE_DIR="${REFUNDDESK_ROOT}/releases/${REVISION}"
install -d -o root -g root -m 0755 "${RELEASE_DIR}"
MANIFEST_TMP="$(mktemp "${RELEASE_DIR}/.manifest.XXXXXX")"
install -o root -g root -m 0644 "${MANIFEST_PATH}" "${MANIFEST_TMP}"
python3 "${TRANSITION_HELPER}" durable-replace \
  --source "${MANIFEST_TMP}" \
  --target "${RELEASE_DIR}/manifest.json" \
  --mode 0644 >/dev/null ||
  die "release manifest could not be synchronized durably"
MANIFEST_TMP=""

if [[ -L "${REFUNDDESK_ROOT}/current" ]]; then
  [[ "$(stat --format='%u' -- "${REFUNDDESK_ROOT}/current")" == "0" ]] ||
    die "current source symlink must be owned by root"
  PREVIOUS_CURRENT_TARGET="$(readlink -- "${REFUNDDESK_ROOT}/current")"
  [[ "${PREVIOUS_CURRENT_TARGET}" == /* ]] ||
    die "current source symlink must use an absolute target"
  PREVIOUS_CURRENT_PRESENT=true
elif [[ -e "${REFUNDDESK_ROOT}/current" ]]; then
  die "current source path must be absent or a symlink"
fi

if [[ -e "${REFUNDDESK_ROOT}/ACTIVE_REVISION" ||
  -L "${REFUNDDESK_ROOT}/ACTIVE_REVISION" ]]; then
  assert_root_control_file "${REFUNDDESK_ROOT}/ACTIVE_REVISION"
  PREVIOUS_ACTIVE_REVISION_BACKUP="$(
    mktemp "${REFUNDDESK_ROOT}/.active-revision.previous.XXXXXX"
  )"
  install -o root -g root -m 0600 \
    "${REFUNDDESK_ROOT}/ACTIVE_REVISION" "${PREVIOUS_ACTIVE_REVISION_BACKUP}"
  PREVIOUS_ACTIVE_REVISION_PRESENT=true
fi

ACTIVE_REVISION_TMP="$(mktemp "${REFUNDDESK_ROOT}/.active-revision.XXXXXX")"
printf '%s\n' "${REVISION}" >"${ACTIVE_REVISION_TMP}"
chown root:root "${ACTIVE_REVISION_TMP}"
chmod 0644 "${ACTIVE_REVISION_TMP}"
ACTIVE_REVISION_CHANGED=true
python3 "${TRANSITION_HELPER}" durable-replace \
  --source "${ACTIVE_REVISION_TMP}" \
  --target "${REFUNDDESK_ROOT}/ACTIVE_REVISION" \
  --mode 0644 >/dev/null ||
  die "active revision marker could not be synchronized durably"
ACTIVE_REVISION_TMP=""

CURRENT_LINK_CHANGED=true
python3 "${TRANSITION_HELPER}" durable-symlink \
  --target "${REFUNDDESK_ROOT}/current" \
  --value "${SOURCE_ROOT}" >/dev/null ||
  die "current source symlink could not be synchronized durably"

if [[ -e "${ROTATION_STATE_FILE}" || -L "${ROTATION_STATE_FILE}" ]]; then
  assert_root_secret_file "${ROTATION_STATE_FILE}"
  PREVIOUS_ROTATION_STATE_BACKUP="$(
    mktemp "${REFUNDDESK_CONFIG_ROOT}/.application-key-rotation.previous.XXXXXX"
  )"
  install -o root -g root -m 0600 \
    "${ROTATION_STATE_FILE}" "${PREVIOUS_ROTATION_STATE_BACKUP}"
  PREVIOUS_ROTATION_STATE_PRESENT=true
fi
ROTATION_STATE_TMP="$(
  mktemp "${REFUNDDESK_CONFIG_ROOT}/.application-key-rotation.XXXXXX"
)"
jq --compact-output --null-input \
  --arg revision "${REVISION}" \
  --arg field "${TARGET_FIELD_ROTATION_STATE}" \
  --arg proof "${TARGET_PROOF_ROTATION_STATE}" \
  --arg approval "${TARGET_APPROVAL_ROTATION_STATE}" \
  --slurpfile fingerprints "${TARGET_FINGERPRINTS_FILE}" \
  '{
    fingerprints: $fingerprints[0],
    revision: $revision,
    schemaVersion: 2,
    states: {
      approvalAttestation: $approval,
      field: $field,
      proof: $proof
    }
  }' >"${ROTATION_STATE_TMP}"
chown root:root "${ROTATION_STATE_TMP}"
chmod 0600 "${ROTATION_STATE_TMP}"
ROTATION_STATE_CHANGED=true
python3 "${TRANSITION_HELPER}" durable-replace \
  --source "${ROTATION_STATE_TMP}" \
  --target "${ROTATION_STATE_FILE}" \
  --mode 0600 >/dev/null ||
  die "application-key rotation state could not be synchronized durably"
ROTATION_STATE_TMP=""

commit_release_environment

CONTROL_PLANE_TARGET="${SOURCE_ROOT}/deploy/lightsail"
for control_plane_mapping in \
  "scripts/release-launcher.sh|/usr/local/sbin/refunddesk-release" \
  "scripts/release-fence.sh|/usr/local/sbin/refunddesk-release-fence" \
  "scripts/backup-launcher.sh|/usr/local/sbin/refunddesk-backup" \
  "scripts/retention-launcher.sh|/usr/local/sbin/refunddesk-retention" \
  "scripts/quiesce-recovery-launcher.sh|/usr/local/sbin/refunddesk-quiesce-recovery" \
  "systemd/refunddesk-backup.service|/etc/systemd/system/refunddesk-backup.service" \
  "systemd/refunddesk-backup.timer|/etc/systemd/system/refunddesk-backup.timer" \
  "systemd/refunddesk-retention.service|/etc/systemd/system/refunddesk-retention.service" \
  "systemd/refunddesk-retention.timer|/etc/systemd/system/refunddesk-retention.timer" \
  "systemd/refunddesk-quiesce-recovery.service|/etc/systemd/system/refunddesk-quiesce-recovery.service"; do
  control_plane_relative="${control_plane_mapping%%|*}"
  assert_root_control_file "${CONTROL_PLANE_TARGET}/${control_plane_relative}"
done
python3 "${TRANSITION_HELPER}" durable-symlink \
  --target "${REFUNDDESK_CONTROL_PLANE_LINK}" \
  --value "${CONTROL_PLANE_TARGET}" >/dev/null ||
  die "verified control-plane generation could not be activated atomically"
[[ "$(readlink --canonicalize-existing -- "${REFUNDDESK_CONTROL_PLANE_LINK}")" == \
  "${CONTROL_PLANE_TARGET}" ]] ||
  die "active control-plane generation differs from the verified release"
for control_plane_mapping in \
  "scripts/release-launcher.sh|/usr/local/sbin/refunddesk-release" \
  "scripts/release-fence.sh|/usr/local/sbin/refunddesk-release-fence" \
  "scripts/backup-launcher.sh|/usr/local/sbin/refunddesk-backup" \
  "scripts/retention-launcher.sh|/usr/local/sbin/refunddesk-retention" \
  "scripts/quiesce-recovery-launcher.sh|/usr/local/sbin/refunddesk-quiesce-recovery" \
  "systemd/refunddesk-backup.service|/etc/systemd/system/refunddesk-backup.service" \
  "systemd/refunddesk-backup.timer|/etc/systemd/system/refunddesk-backup.timer" \
  "systemd/refunddesk-retention.service|/etc/systemd/system/refunddesk-retention.service" \
  "systemd/refunddesk-retention.timer|/etc/systemd/system/refunddesk-retention.timer" \
  "systemd/refunddesk-quiesce-recovery.service|/etc/systemd/system/refunddesk-quiesce-recovery.service"; do
  control_plane_relative="${control_plane_mapping%%|*}"
  installed_control_path="${control_plane_mapping#*|}"
  assert_root_control_symlink \
    "${installed_control_path}" \
    "${REFUNDDESK_CONTROL_PLANE_LINK}/${control_plane_relative}"
done

TRANSITION_JOURNAL_LOCK="${REFUNDDESK_CONFIG_ROOT}/application-key-transition.lock"
if [[ ! -e "${TRANSITION_JOURNAL_LOCK}" && ! -L "${TRANSITION_JOURNAL_LOCK}" ]]; then
  (
    set -o noclobber
    : >"${TRANSITION_JOURNAL_LOCK}"
  ) 2>/dev/null || true
fi
assert_root_secret_file "${TRANSITION_JOURNAL_LOCK}"
[[ "$(stat --format='%u:%g:%a' -- "${TRANSITION_JOURNAL_LOCK}")" == "0:0:600" ]] ||
  die "release transition coordination lock metadata is unsafe"
exec 8<>"${TRANSITION_JOURNAL_LOCK}"
[[ "$(stat --format='%d:%i' -- "${TRANSITION_JOURNAL_LOCK}")" == \
  "$(stat --dereference --format='%d:%i' -- /proc/self/fd/8)" ]] ||
  die "release transition coordination lock changed during secure open"
flock --exclusive 8
restore_runtime_restart_policies
unset REFUNDDESK_RUNTIME_RESTART_POLICY
systemctl daemon-reload ||
  die "systemd could not reload the verified control-plane generation"
systemctl enable refunddesk-quiesce-recovery.service ||
  die "runtime-quiescence boot recovery could not be enabled"
systemctl is-enabled --quiet refunddesk-quiesce-recovery.service ||
  die "runtime-quiescence boot recovery is not enabled"
systemctl enable --now refunddesk-retention.timer ||
  die "retention schedule could not be activated"
systemctl is-enabled --quiet refunddesk-retention.timer &&
  systemctl is-active --quiet refunddesk-retention.timer ||
  die "retention schedule activation is unproven"
if [[ "${BACKUP_CONFIGURATION_VALID}" == "true" ]]; then
  systemctl enable --now refunddesk-backup.timer ||
    die "valid backup schedule could not be activated"
  systemctl is-enabled --quiet refunddesk-backup.timer &&
    systemctl is-active --quiet refunddesk-backup.timer ||
    die "backup schedule activation is unproven"
else
  systemctl disable --now refunddesk-backup.timer ||
    die "unconfigured backup schedule could not be disabled"
  ! systemctl is-enabled --quiet refunddesk-backup.timer ||
    die "unconfigured backup schedule remained enabled"
fi
if ! python3 "${TRANSITION_HELPER}" complete \
  --path "${TRANSITION_JOURNAL_FILE}" \
  --candidate "${TRANSITION_CANDIDATE_FILE}" \
  --commit-marker "${TRANSITION_COMMIT_MARKER}" >/dev/null; then
  flock --unlock 8
  die "verified release metadata committed but transition journal could not be closed"
fi
TRANSITION_COMMITTED=true
flock --unlock 8
wait_for_release_fence_disarm
PROMOTION_COMPLETE=true
log "sandbox release ${REVISION} is active with verified retention, recovery and backup scheduling state"
