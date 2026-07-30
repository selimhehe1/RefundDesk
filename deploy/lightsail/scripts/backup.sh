#!/usr/bin/env bash

# Cold-backup contract:
# - PostgreSQL 18 PGDATA is the host bind /var/lib/refunddesk/postgres/data.
# - The full sandbox stack is quiesced before a GNU-tar physical archive.
# - Compression is single-threaded for the 1 GiB host and encryption uses only
#   an age *public recipient*. No age private identity belongs on the server.
# - S3 authentication must come from a non-static provider (for example
#   credential_process/IAM Roles Anywhere or web identity). Static AWS access
#   keys and shared credentials files are rejected.
# - Rotation is restricted to generated objects below the configured
#   refunddesk-sandbox/ prefix. Total bucket versions must stay below 4 GiB.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

BACKUP_ENV="${REFUNDDESK_CONFIG_ROOT}/backup.env"

while (( $# > 0 )); do
  case "$1" in
    --env-file)
      (( $# >= 2 )) || die "--env-file requires a value"
      BACKUP_ENV="$2"
      shift 2
      ;;
    --help|-h)
      printf 'Usage: sudo bash backup.sh [--env-file /etc/refunddesk/backup.env]\n'
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

require_root
for command in age aws base64 cmp date docker jq readlink sha256sum tar zstd; do
  require_command "${command}"
done
acquire_operator_lock

readonly RELEASE_CONTRACT_VERSION="2"
readonly STABLE_BACKUP_LAUNCHER="/usr/local/sbin/refunddesk-backup"
readonly STABLE_RECOVERY_LAUNCHER="/usr/local/sbin/refunddesk-quiesce-recovery"
TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"
BACKUP_UPLOAD_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/backup-upload-in-progress.json"
[[ "${REFUNDDESK_BACKUP_LAUNCHER_CONTRACT:-}" == "${RELEASE_CONTRACT_VERSION}" &&
  "${REFUNDDESK_BACKUP_LAUNCHER_PATH:-}" == "${STABLE_BACKUP_LAUNCHER}" &&
  "${REFUNDDESK_BACKUP_LAUNCHER_REVISION:-}" =~ ^[0-9a-f]{40}$ ]] ||
  die "backup must be invoked by the stable host-side launcher"
assert_root_control_entry \
  "${STABLE_BACKUP_LAUNCHER}" \
  "${REFUNDDESK_CONTROL_PLANE_LINK}/scripts/backup-launcher.sh"
assert_root_control_entry \
  "${STABLE_RECOVERY_LAUNCHER}" \
  "${REFUNDDESK_CONTROL_PLANE_LINK}/scripts/quiesce-recovery-launcher.sh"
assert_root_secret_directory "${REFUNDDESK_CONTROL_ROOT}"
[[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]] ||
  die "backup is blocked while a release transition is unfinished"
[[ ! -e "${QUIESCE_JOURNAL}" && ! -L "${QUIESCE_JOURNAL}" ]] ||
  die "backup is blocked until an unfinished runtime quiescence is recovered"
[[ ! -e "${BACKUP_UPLOAD_JOURNAL}" && ! -L "${BACKUP_UPLOAD_JOURNAL}" ]] ||
  die "backup is blocked until an unfinished upload is reconciled"
[[ "${BACKUP_ENV}" == "${REFUNDDESK_CONFIG_ROOT}/backup.env" ]] ||
  die "stable backup invocation requires the canonical backup environment"

ACTIVE_REVISION_FILE="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
CURRENT_LINK="${REFUNDDESK_ROOT}/current"
RELEASE_ENV_FILE="${REFUNDDESK_CONFIG_ROOT}/release.env"
assert_root_control_file "${ACTIVE_REVISION_FILE}"
assert_root_secret_file "${RELEASE_ENV_FILE}"
mapfile -t active_revision_lines <"${ACTIVE_REVISION_FILE}"
(( ${#active_revision_lines[@]} == 1 )) &&
  [[ "${active_revision_lines[0]}" == "${REFUNDDESK_BACKUP_LAUNCHER_REVISION}" ]] ||
  die "active revision changed after backup launcher validation"
[[ -L "${CURRENT_LINK}" && "$(stat --format='%u' -- "${CURRENT_LINK}")" == "0" ]] ||
  die "current source must be a root-owned symlink"
current_source="$(readlink --canonicalize-existing -- "${CURRENT_LINK}")"
expected_source="${REFUNDDESK_ROOT}/releases/${REFUNDDESK_BACKUP_LAUNCHER_REVISION}/source"
[[ "${current_source}" == "${expected_source}" &&
  "${SCRIPT_DIR}" == "${current_source}/deploy/lightsail/scripts" ]] ||
  die "current source changed after backup launcher validation"
CONTRACT_MARKER="${current_source}/deploy/lightsail/RELEASE_CONTRACT_VERSION"
DURABILITY_HELPER="${current_source}/deploy/lightsail/scripts/release-transition-journal.py"
RECOVERY_RUNNER="${current_source}/deploy/lightsail/scripts/recover-quiesced-runtime.sh"
assert_root_control_file "${CONTRACT_MARKER}"
assert_root_control_file "${DURABILITY_HELPER}"
assert_root_control_file "${RECOVERY_RUNNER}"
mapfile -t contract_lines <"${CONTRACT_MARKER}"
(( ${#contract_lines[@]} == 1 )) &&
  [[ "${contract_lines[0]}" == "${RELEASE_CONTRACT_VERSION}" ]] ||
  die "current source release contract changed after backup launcher validation"
mapfile -t release_lines <"${RELEASE_ENV_FILE}"
(( ${#release_lines[@]} == 2 )) &&
  [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${REFUNDDESK_BACKUP_LAUNCHER_REVISION}" ]] &&
  [[ "${release_lines[1]}" == "REFUNDDESK_REVISION=${REFUNDDESK_BACKUP_LAUNCHER_REVISION}" ]] ||
  die "release environment changed after backup launcher validation"

MANIFEST="${REFUNDDESK_ROOT}/releases/${REFUNDDESK_BACKUP_LAUNCHER_REVISION}/manifest.json"
assert_root_control_file "${MANIFEST}"
jq --exit-status \
  --arg revision "${REFUNDDESK_BACKUP_LAUNCHER_REVISION}" '
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
  die "active release manifest changed after backup launcher validation"
for role in web worker migrate; do
  reference="refunddesk-${role}:sandbox-${REFUNDDESK_BACKUP_LAUNCHER_REVISION}"
  expected_id="$(
    jq --raw-output --arg role "${role}" \
      '.images[] | select(.role == $role) | .imageId' "${MANIFEST}"
  )"
  inspect_json="$(docker image inspect "${reference}")" ||
    die "active ${role} image disappeared after backup launcher validation"
  jq --exit-status \
    --arg id "${expected_id}" \
    --arg revision "${REFUNDDESK_BACKUP_LAUNCHER_REVISION}" '
      length == 1
      and .[0].Id == $id
      and .[0].Os == "linux"
      and .[0].Architecture == "amd64"
      and .[0].Config.User == "node"
      and .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
      and .[0].Config.Labels["org.opencontainers.image.source"]
        == "https://github.com/selimhehe1/RefundDesk"
    ' <<<"${inspect_json}" >/dev/null ||
    die "active ${role} image changed after backup launcher validation"
done

assert_root_secret_file "${BACKUP_ENV}"

if [[ -n "${AWS_ACCESS_KEY_ID:-}" || -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  die "static AWS credentials in the process environment are prohibited"
fi

set -o allexport
# Root-owned 0600 operator configuration; it must contain no application secret.
# shellcheck disable=SC1090
source "${BACKUP_ENV}"
set +o allexport

: "${REFUNDDESK_BACKUP_BUCKET:?REFUNDDESK_BACKUP_BUCKET is required}"
: "${REFUNDDESK_BACKUP_AGE_RECIPIENT:?REFUNDDESK_BACKUP_AGE_RECIPIENT is required}"
: "${AWS_CONFIG_FILE:?AWS_CONFIG_FILE is required}"

REFUNDDESK_BACKUP_PREFIX="${REFUNDDESK_BACKUP_PREFIX:-refunddesk-sandbox/postgres/}"
REFUNDDESK_BACKUP_RETENTION_COUNT="${REFUNDDESK_BACKUP_RETENTION_COUNT:-7}"
AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_SHARED_CREDENTIALS_FILE

if [[ -n "${AWS_ACCESS_KEY_ID:-}" ||
  -n "${AWS_SECRET_ACCESS_KEY:-}" ||
  -n "${AWS_SESSION_TOKEN:-}" ]]; then
  die "static or preloaded AWS credentials are prohibited"
fi

[[ "${REFUNDDESK_BACKUP_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
  die "backup bucket name is invalid"
[[ "${REFUNDDESK_BACKUP_PREFIX}" =~ ^refunddesk-sandbox/[A-Za-z0-9._/-]*/$ &&
  "${REFUNDDESK_BACKUP_PREFIX}" != *".."* ]] ||
  die "backup prefix must be a safe directory below refunddesk-sandbox/"
[[ "${REFUNDDESK_BACKUP_AGE_RECIPIENT}" =~ ^age1[0-9a-z]+$ ]] ||
  die "only a native age public recipient is accepted"
[[ "${REFUNDDESK_BACKUP_RETENTION_COUNT}" =~ ^[1-9][0-9]?$ ]] ||
  die "retention count must be between 1 and 99"
assert_root_secret_file "${AWS_CONFIG_FILE}"
if grep -Eiq '(^|[[:space:]])aws_(access_key_id|secret_access_key)[[:space:]]*=' "${AWS_CONFIG_FILE}"; then
  die "static AWS keys are prohibited in AWS_CONFIG_FILE"
fi

valid_version_id() {
  local version_id="$1"

  [[ -n "${version_id}" &&
    "${version_id}" != "null" &&
    ${#version_id} -le 1024 &&
    "${version_id}" != *[[:space:]]* &&
    "${version_id}" != *[[:cntrl:]]* ]]
}

aws sts get-caller-identity --output json >/dev/null ||
  die "non-static AWS credential provider is unavailable"
aws s3api head-bucket --bucket "${REFUNDDESK_BACKUP_BUCKET}" >/dev/null ||
  die "backup bucket is unavailable"
versioning_probe_timestamp="$(date --utc '+%Y%m%dT%H%M%SZ')"
versioning_probe_key="${REFUNDDESK_BACKUP_PREFIX}.versioning-probe-${versioning_probe_timestamp}-${REFUNDDESK_BACKUP_LAUNCHER_REVISION}-$$"
versioning_probe_inventory="$(
  aws s3api list-object-versions \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --prefix "${versioning_probe_key}" \
    --no-paginate \
    --output json
)" || die "backup versioning-probe inventory is unavailable"
jq --exit-status '
  type == "object"
  and (.IsTruncated // false) == false
  and ([.Versions[]?, .DeleteMarkers[]?] | length) == 0
' <<<"${versioning_probe_inventory}" >/dev/null ||
  die "backup versioning-probe key is not fresh"

# Lightsail resource-access credentials expose the supported object-version
# APIs, but not S3 GetBucketVersioning or the Lightsail control plane. Prove
# the current state before quiescence with a uniquely keyed, revision-bound
# object. A missing/null VersionId is fail-closed and preserves the tiny probe
# for explicit reconciliation; a valid version is verified, deleted exactly
# and proven absent before any service is stopped.
if ! versioning_probe_result="$(
  aws s3api put-object \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --key "${versioning_probe_key}" \
    --body "${ACTIVE_REVISION_FILE}" \
    --server-side-encryption AES256 \
    --metadata \
      "purpose=versioning-preflight,revision=${REFUNDDESK_BACKUP_LAUNCHER_REVISION}" \
    --output json
)"; then
  die "backup versioning probe returned an ambiguous result; reconcile ${versioning_probe_key}"
fi
versioning_probe_id="$(
  jq --raw-output '.VersionId // empty' <<<"${versioning_probe_result}"
)"
valid_version_id "${versioning_probe_id}" ||
  die "backup bucket did not return an enabled-version ID; reconcile ${versioning_probe_key}"
versioning_probe_head="$(
  aws s3api head-object \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --key "${versioning_probe_key}" \
    --version-id "${versioning_probe_id}" \
    --output json
)" || die "versioned backup preflight probe is unreadable"
versioning_probe_bytes="$(stat --format='%s' -- "${ACTIVE_REVISION_FILE}")"
jq --exit-status \
  --argjson bytes "${versioning_probe_bytes}" \
  --arg revision "${REFUNDDESK_BACKUP_LAUNCHER_REVISION}" '
    .ContentLength == $bytes
    and (.Metadata.purpose // "") == "versioning-preflight"
    and (.Metadata.revision // "") == $revision
    and (.ServerSideEncryption // "") == "AES256"
  ' <<<"${versioning_probe_head}" >/dev/null ||
  die "versioned backup preflight probe metadata differs"
versioning_probe_delete="$(
  aws s3api delete-object \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --key "${versioning_probe_key}" \
    --version-id "${versioning_probe_id}" \
    --output json
)" || die "versioned backup preflight probe deletion is ambiguous"
jq --exit-status --arg version_id "${versioning_probe_id}" '
  (.VersionId // "") == $version_id
  and (.DeleteMarker // false) == false
' <<<"${versioning_probe_delete}" >/dev/null ||
  die "S3 did not confirm exact versioning-probe deletion"
versioning_probe_inventory="$(
  aws s3api list-object-versions \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --prefix "${versioning_probe_key}" \
    --no-paginate \
    --output json
)" || die "post-delete versioning-probe inventory is unavailable"
jq --exit-status '
  type == "object"
  and (.IsTruncated // false) == false
  and ([.Versions[]?, .DeleteMarkers[]?] | length) == 0
' <<<"${versioning_probe_inventory}" >/dev/null ||
  die "versioning-probe object remains after exact deletion"

PGDATA="${REFUNDDESK_PGDATA:-/var/lib/refunddesk/postgres/data}"
BACKUP_DIR="${REFUNDDESK_BACKUP_LOCAL_DIR:-/var/lib/refunddesk/backups}"
assert_safe_directory "${PGDATA}"
[[ "$(cat "${PGDATA}/PG_VERSION")" == "18" ]] || die "PGDATA is not PostgreSQL 18"
install -d -o root -g root -m 0700 "${BACKUP_DIR}"
assert_safe_directory "${BACKUP_DIR}"
shopt -s nullglob
unreconciled_local_backups=(
  "${BACKUP_DIR}"/postgres-*.tar.zst.age
  "${BACKUP_DIR}"/.postgres-*.tar.zst.age.partial
)
shopt -u nullglob
(( ${#unreconciled_local_backups[@]} == 0 )) ||
  die "an unreconciled local backup artifact requires operator recovery"

for service in postgres verifier worker web caddy; do
  service_is_running "${service}" || die "cold backup requires ${service} to be running"
done

timestamp="$(date --utc '+%Y%m%dT%H%M%SZ')"
revision="$(tr -d '\r\n' <"${REFUNDDESK_ROOT}/ACTIVE_REVISION")"
[[ "${revision}" =~ ^[0-9a-f]{40}$ ]] || die "ACTIVE_REVISION is missing or invalid"
archive_name="postgres-${timestamp}-${revision}.tar.zst.age"
archive_partial="${BACKUP_DIR}/.${archive_name}.partial"
archive_path="${BACKUP_DIR}/${archive_name}"
object_key="${REFUNDDESK_BACKUP_PREFIX}${archive_name}"
versions_file="$(mktemp "${BACKUP_DIR}/.s3-versions.XXXXXX")"

UPLOAD_ATTEMPTED=false
UPLOAD_COMMITTED=false
UPLOAD_JOURNAL_PREPARED=false
UPLOAD_JOURNAL_CLEARED=false
UPLOADED_VERSION_ID=""
DISCOVERED_UPLOAD_STATE=""

delete_uploaded_object() {
  local delete_result

  if [[ -z "${UPLOADED_VERSION_ID}" ]]; then
    if ! discover_uploaded_version_id; then
      log "uncommitted backup version cannot be identified safely; preserving it for recovery"
      return 1
    fi
    if [[ "${DISCOVERED_UPLOAD_STATE}" == "absent" ]]; then
      if ! assert_no_exact_multipart_upload; then
        log "an incomplete upload may still exist for the uncommitted backup key"
        return 1
      fi
      UPLOAD_ATTEMPTED=false
      return 0
    fi
  fi
  if ! valid_version_id "${UPLOADED_VERSION_ID}"; then
    log "uncommitted backup version ID is invalid; preserving it for recovery"
    return 1
  fi
  if ! delete_result="$(
    aws s3api delete-object \
      --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
      --key "${object_key}" \
      --version-id "${UPLOADED_VERSION_ID}" \
      --output json
  )"; then
    log "uncommitted backup version could not be deleted safely"
    return 1
  fi
  if ! jq --exit-status \
    --arg version_id "${UPLOADED_VERSION_ID}" '
      (.VersionId // "") == $version_id
      and (.DeleteMarker // false) == false
    ' <<<"${delete_result}" >/dev/null; then
    log "S3 did not confirm deletion of the exact uncommitted backup version"
    return 1
  fi
  UPLOADED_VERSION_ID=""
  if ! discover_uploaded_version_id; then
    log "uncommitted backup deletion could not be reconciled"
    return 1
  fi
  if [[ "${DISCOVERED_UPLOAD_STATE}" != "absent" ]]; then
    log "an uncommitted matching backup version remains after exact deletion"
    return 1
  fi
  if ! assert_no_exact_multipart_upload; then
    log "an incomplete upload remains for the uncommitted backup key"
    return 1
  fi
  UPLOAD_ATTEMPTED=false
  return 0
}

restore_stack() {
  local status=$?
  trap - EXIT
  if [[ -e "${BACKUP_UPLOAD_JOURNAL}" || -L "${BACKUP_UPLOAD_JOURNAL}" ]]; then
    UPLOAD_JOURNAL_PREPARED=true
  fi
  if (( status != 0 )) &&
    [[ "${UPLOAD_ATTEMPTED}" == "true" && "${UPLOAD_COMMITTED}" != "true" ]]; then
    log "reconciling the uncommitted backup upload after failure"
    if ! delete_uploaded_object; then
      status=1
    fi
  fi
  if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]; then
    log "recovering the exact sandbox runtime after cold backup"
    if ! REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED=true \
      REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_CONTRACT="${RELEASE_CONTRACT_VERSION}" \
      REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_PATH="${STABLE_RECOVERY_LAUNCHER}" \
      REFUNDDESK_QUIESCE_RECOVERY_LAUNCHER_REVISION="${revision}" \
      bash "${RECOVERY_RUNNER}"; then
      status=1
    fi
  fi
  if [[ "${UPLOAD_JOURNAL_PREPARED}" == "true" &&
    ( "${UPLOAD_COMMITTED}" == "true" || "${UPLOAD_ATTEMPTED}" == "false" ) ]]; then
    if python3 "${DURABILITY_HELPER}" clear-backup-upload \
      --path "${BACKUP_UPLOAD_JOURNAL}" \
      --archive "${archive_path}" \
      --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
      --bytes "${archive_bytes}" \
      --object-key "${object_key}" \
      --revision "${revision}" \
      --sha256 "${archive_sha256}" >/dev/null; then
      UPLOAD_JOURNAL_CLEARED=true
    else
      log "ERROR: verified backup upload intent could not be cleared durably"
      status=1
    fi
  fi
  local -a cleanup_paths=("${archive_partial}" "${versions_file}")
  if [[ "${UPLOAD_JOURNAL_PREPARED}" == "false" ||
    ( "${UPLOAD_JOURNAL_CLEARED}" == "true" &&
      ( "${UPLOAD_COMMITTED}" == "true" || "${UPLOAD_ATTEMPTED}" == "false" ) ) ]]; then
    cleanup_paths+=("${archive_path}")
  else
    log "ERROR: preserving the encrypted local archive and upload intent for S3 reconciliation"
    status=1
  fi
  if ! rm -f -- "${cleanup_paths[@]}"; then
    log "ERROR: local backup artifacts could not be removed"
    status=1
  fi
  exit "${status}"
}
trap restore_stack EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "quiescing ingress, worker, web, verifier and PostgreSQL"
python3 "${DURABILITY_HELPER}" prepare-quiesce \
  --path "${QUIESCE_JOURNAL}" \
  --operation backup \
  --revision "${revision}" >/dev/null ||
  die "durable backup quiescence could not be prepared"
refunddesk_compose stop --timeout 45 caddy
refunddesk_compose stop --timeout 45 worker
refunddesk_compose stop --timeout 45 web
refunddesk_compose stop --timeout 45 verifier
refunddesk_compose stop --timeout 60 postgres

[[ ! -e "${PGDATA}/postmaster.pid" ]] ||
  die "PostgreSQL postmaster.pid remains after a clean stop"

tar \
  --create \
  --file=- \
  --directory="${PGDATA}" \
  --numeric-owner \
  --one-file-system \
  --acls \
  --xattrs \
  . |
  zstd --compress --threads=1 -7 --quiet |
  age --encrypt --recipient "${REFUNDDESK_BACKUP_AGE_RECIPIENT}" --output "${archive_partial}"

chmod 0600 "${archive_partial}"
mv -- "${archive_partial}" "${archive_path}"
archive_bytes="$(stat --format='%s' -- "${archive_path}")"
archive_sha256="$(sha256sum -- "${archive_path}" | awk '{print $1}')"
python3 "${DURABILITY_HELPER}" fsync-paths \
  --path "${archive_path}" \
  --directory "${BACKUP_DIR}" >/dev/null ||
  die "encrypted backup archive could not be synchronized durably"

list_versions() {
  if ! aws s3api list-object-versions \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --no-paginate \
    --output json >"${versions_file}"; then
    return 1
  fi
  if ! jq --exit-status '(.IsTruncated // false) == false' "${versions_file}" >/dev/null; then
    log "backup version inventory is truncated; refusing an incomplete storage decision"
    return 1
  fi
}

discover_uploaded_version_id() {
  local candidate_head candidate_id versions_json
  local -a candidate_ids matching_ids

  DISCOVERED_UPLOAD_STATE=""
  UPLOADED_VERSION_ID=""
  if ! versions_json="$(
    aws s3api list-object-versions \
      --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
      --prefix "${object_key}" \
      --no-paginate \
      --output json
  )"; then
    return 1
  fi
  if ! jq --exit-status '(.IsTruncated // false) == false' <<<"${versions_json}" >/dev/null; then
    log "exact backup-key version inventory is truncated"
    return 1
  fi
  mapfile -t candidate_ids < <(
    jq --raw-output --arg key "${object_key}" '
      .Versions[]?
      | select(.Key == $key)
      | .VersionId
    ' <<<"${versions_json}"
  )
  matching_ids=()
  for candidate_id in "${candidate_ids[@]}"; do
    if ! valid_version_id "${candidate_id}"; then
      log "exact backup-key inventory contains an invalid version ID"
      return 1
    fi
    if ! candidate_head="$(
      aws s3api head-object \
        --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
        --key "${object_key}" \
        --version-id "${candidate_id}" \
        --output json
    )"; then
      return 1
    fi
    if jq --exit-status \
      --argjson bytes "${archive_bytes}" \
      --arg sha256 "${archive_sha256}" \
      --arg revision "${revision}" '
        .ContentLength == $bytes
        and (.Metadata.sha256 // "") == $sha256
        and (.Metadata.revision // "") == $revision
        and (.ServerSideEncryption // "") == "AES256"
      ' <<<"${candidate_head}" >/dev/null; then
      matching_ids+=("${candidate_id}")
    fi
  done
  if (( ${#matching_ids[@]} == 0 )); then
    DISCOVERED_UPLOAD_STATE="absent"
    return 0
  fi
  if (( ${#matching_ids[@]} != 1 )); then
    log "multiple exact matching backup versions make cleanup ambiguous"
    return 1
  fi
  DISCOVERED_UPLOAD_STATE="found"
  UPLOADED_VERSION_ID="${matching_ids[0]}"
  return 0
}

assert_no_exact_multipart_upload() {
  local multipart_json

  if ! multipart_json="$(
    aws s3api list-multipart-uploads \
      --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
      --prefix "${object_key}" \
      --no-paginate \
      --output json
  )"; then
    return 1
  fi
  if ! jq --exit-status \
    --arg key "${object_key}" '
      (.IsTruncated // false) == false
      and ([.Uploads[]? | select(.Key == $key)] | length) == 0
    ' <<<"${multipart_json}" >/dev/null; then
    return 1
  fi
  return 0
}

rotate_to_count() {
  local keep="$1"
  local encoded key version_id
  mapfile -t stale_versions < <(
    jq --raw-output \
      --arg prefix "${REFUNDDESK_BACKUP_PREFIX}" \
      --argjson keep "${keep}" '
        [.Versions[]?
          | select(.Key | startswith($prefix))
          | select((.Key | ltrimstr($prefix)) | test("^postgres-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}\\.tar\\.zst\\.age$"))
        ]
        | sort_by(.LastModified)
        | reverse
        | .[$keep:]
        | .[]
        | @base64
      ' "${versions_file}"
  )
  for encoded in "${stale_versions[@]}"; do
    key="$(base64 --decode <<<"${encoded}" | jq --raw-output '.Key')"
    version_id="$(base64 --decode <<<"${encoded}" | jq --raw-output '.VersionId')"
    [[ "${key}" == "${REFUNDDESK_BACKUP_PREFIX}"postgres-*.tar.zst.age ]] ||
      die "rotation selected an unexpected object key"
    valid_version_id "${version_id}" ||
      die "rotation selected an object without an exact version ID"
    aws s3api delete-object \
      --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
      --key "${key}" \
      --version-id "${version_id}" >/dev/null
  done
}

multipart_inventory="$(
  aws s3api list-multipart-uploads \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --no-paginate \
    --output json
)"
jq --exit-status '
  (.IsTruncated // false) == false
  and ([.Uploads[]?] | length) == 0
' <<<"${multipart_inventory}" >/dev/null ||
  die "bucket has incomplete multipart uploads; storage cap cannot be proven"

list_versions || die "complete backup version inventory is unavailable"
bucket_bytes="$(jq '[.Versions[]?.Size] | add // 0' "${versions_file}")"
MAX_BUCKET_BYTES=4294967296
(( bucket_bytes + archive_bytes < MAX_BUCKET_BYTES )) ||
  die "upload would make total versioned bucket storage reach 4 GiB"

python3 "${DURABILITY_HELPER}" prepare-backup-upload \
  --path "${BACKUP_UPLOAD_JOURNAL}" \
  --archive "${archive_path}" \
  --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
  --bytes "${archive_bytes}" \
  --object-key "${object_key}" \
  --revision "${revision}" \
  --sha256 "${archive_sha256}" >/dev/null ||
  die "durable backup upload intent could not be prepared"
UPLOAD_JOURNAL_PREPARED=true
UPLOAD_ATTEMPTED=true
if upload_result="$(
  aws s3api put-object \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --key "${object_key}" \
    --body "${archive_path}" \
    --content-length "${archive_bytes}" \
    --server-side-encryption AES256 \
    --metadata "sha256=${archive_sha256},revision=${revision}" \
    --output json
)"; then
  UPLOADED_VERSION_ID="$(jq --raw-output '.VersionId // empty' <<<"${upload_result}")"
else
  die "backup upload did not return a definitive response; cleanup reconciliation is required"
fi
valid_version_id "${UPLOADED_VERSION_ID}" ||
  die "uploaded backup has no exact S3 version ID"
remote_head="$(
  aws s3api head-object \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --key "${object_key}" \
    --version-id "${UPLOADED_VERSION_ID}" \
    --output json
)"
remote_length="$(jq --raw-output '.ContentLength' <<<"${remote_head}")"
remote_sha256="$(jq --raw-output '.Metadata.sha256 // empty' <<<"${remote_head}")"
remote_revision="$(jq --raw-output '.Metadata.revision // empty' <<<"${remote_head}")"
remote_sse="$(jq --raw-output '.ServerSideEncryption // empty' <<<"${remote_head}")"
[[ "${remote_length}" == "${archive_bytes}" &&
  "${remote_sha256}" == "${archive_sha256}" &&
  "${remote_revision}" == "${revision}" &&
  "${remote_sse}" == "AES256" ]] ||
  die "uploaded backup verification failed"

UPLOAD_COMMITTED=true
list_versions || die "complete backup version inventory is unavailable after upload"
rotate_to_count "${REFUNDDESK_BACKUP_RETENTION_COUNT}"
list_versions || die "complete backup version inventory is unavailable after rotation"
bucket_bytes="$(jq '[.Versions[]?.Size] | add // 0' "${versions_file}")"
(( bucket_bytes < MAX_BUCKET_BYTES )) || die "bucket storage cap was exceeded"

log "encrypted PostgreSQL 18 cold backup uploaded and verified"
