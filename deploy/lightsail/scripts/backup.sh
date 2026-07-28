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
for command in age aws base64 docker jq sha256sum tar zstd; do
  require_command "${command}"
done
acquire_operator_lock
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
aws sts get-caller-identity --output json >/dev/null ||
  die "non-static AWS credential provider is unavailable"
aws s3api head-bucket --bucket "${REFUNDDESK_BACKUP_BUCKET}" >/dev/null ||
  die "backup bucket is unavailable"

PGDATA="${REFUNDDESK_PGDATA:-/var/lib/refunddesk/postgres/data}"
BACKUP_DIR="${REFUNDDESK_BACKUP_LOCAL_DIR:-/var/lib/refunddesk/backups}"
assert_safe_directory "${PGDATA}"
[[ "$(cat "${PGDATA}/PG_VERSION")" == "18" ]] || die "PGDATA is not PostgreSQL 18"
install -d -o root -g root -m 0700 "${BACKUP_DIR}"
assert_safe_directory "${BACKUP_DIR}"

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

STACK_QUIESCED=false
UPLOAD_CREATED=false
UPLOAD_COMMITTED=false
UPLOADED_VERSION_ID=""

delete_uploaded_object() {
  if [[ -n "${UPLOADED_VERSION_ID}" ]]; then
    aws s3api delete-object \
      --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
      --key "${object_key}" \
      --version-id "${UPLOADED_VERSION_ID}" >/dev/null
  else
    aws s3api delete-object \
      --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
      --key "${object_key}" >/dev/null
  fi
  UPLOAD_CREATED=false
}

restore_stack() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) &&
    [[ "${UPLOAD_CREATED}" == "true" && "${UPLOAD_COMMITTED}" != "true" ]]; then
    log "removing the uncommitted backup object after validation failure"
    delete_uploaded_object || status=1
  fi
  if [[ "${STACK_QUIESCED}" == "true" ]]; then
    log "restarting the sandbox stack after cold backup"
    refunddesk_compose up --detach --no-build postgres >/dev/null 2>&1 || status=1
    wait_for_container_health postgres 120 || status=1
    refunddesk_compose up --detach --no-deps --no-build verifier worker web >/dev/null 2>&1 || status=1
    wait_for_container_health verifier 90 || status=1
    wait_for_container_health worker 180 || status=1
    wait_for_container_health web 120 || status=1
    refunddesk_compose up --detach --no-deps --no-build caddy >/dev/null 2>&1 || status=1
    wait_for_container_health caddy 120 || status=1
    if (( status == 0 )); then
      bash "${SCRIPT_DIR}/verify-deployment.sh" || status=1
    fi
  fi
  rm -f -- "${archive_partial}" "${versions_file}"
  exit "${status}"
}
trap restore_stack EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "quiescing ingress, worker, web, verifier and PostgreSQL"
STACK_QUIESCED=true
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

list_versions() {
  aws s3api list-object-versions \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --output json >"${versions_file}"
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
    if [[ "${version_id}" == "null" || -z "${version_id}" ]]; then
      aws s3api delete-object \
        --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
        --key "${key}" >/dev/null
    else
      aws s3api delete-object \
        --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
        --key "${key}" \
        --version-id "${version_id}" >/dev/null
    fi
  done
}

multipart_count="$(
  aws s3api list-multipart-uploads \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --query 'length(Uploads || `[]`)' \
    --output text
)"
[[ "${multipart_count}" == "0" ]] ||
  die "bucket has incomplete multipart uploads; storage cap cannot be proven"

list_versions
rotate_to_count "$((REFUNDDESK_BACKUP_RETENTION_COUNT - 1))"
list_versions
bucket_bytes="$(jq '[.Versions[]?.Size] | add // 0' "${versions_file}")"
MAX_BUCKET_BYTES=4294967296
(( bucket_bytes + archive_bytes < MAX_BUCKET_BYTES )) ||
  die "upload would make total versioned bucket storage reach 4 GiB"

aws s3 cp \
  "${archive_path}" \
  "s3://${REFUNDDESK_BACKUP_BUCKET}/${object_key}" \
  --only-show-errors \
  --no-progress \
  --server-side-encryption AES256 \
  --metadata "sha256=${archive_sha256},revision=${revision}"
UPLOAD_CREATED=true

remote_head="$(
  aws s3api head-object \
    --bucket "${REFUNDDESK_BACKUP_BUCKET}" \
    --key "${object_key}" \
    --output json
)"
remote_length="$(jq --raw-output '.ContentLength' <<<"${remote_head}")"
remote_sha256="$(jq --raw-output '.Metadata.sha256 // empty' <<<"${remote_head}")"
UPLOADED_VERSION_ID="$(jq --raw-output '.VersionId // empty' <<<"${remote_head}")"
[[ "${remote_length}" == "${archive_bytes}" && "${remote_sha256}" == "${archive_sha256}" ]] ||
  die "uploaded backup verification failed"

list_versions
bucket_bytes="$(jq '[.Versions[]?.Size] | add // 0' "${versions_file}")"
(( bucket_bytes < MAX_BUCKET_BYTES )) || die "bucket storage cap was exceeded"
UPLOAD_COMMITTED=true

rm -f -- "${archive_path}"
log "encrypted PostgreSQL 18 cold backup uploaded and verified"
