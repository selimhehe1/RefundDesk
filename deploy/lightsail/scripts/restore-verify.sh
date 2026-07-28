#!/usr/bin/env bash

# Offline, destructive-copy restore verification. The encrypted archive,
# native age identity and expected digest must already exist on this Linux
# operator host. The restored copy and disposable database never receive
# external network access.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

ARCHIVE_PATH=""
IDENTITY_PATH=""
EXPECTED_SHA256=""
POSTGRES_IMAGE="postgres:18.4-bookworm"
CONTAINER_NAME=""
WORK_DIRECTORY=""
TEMP_PARENT=""

usage() {
  printf '%s\n' \
    "Usage: sudo bash restore-verify.sh \\" \
    "  --archive /local/postgres-backup.tar.zst.age \\" \
    "  --identity /local/age-identity.txt \\" \
    "  --sha256 <expected-lowercase-sha256>"
}

while (( $# > 0 )); do
  case "$1" in
    --archive)
      (( $# >= 2 )) || die "--archive requires a value"
      ARCHIVE_PATH="$2"
      shift 2
      ;;
    --identity)
      (( $# >= 2 )) || die "--identity requires a value"
      IDENTITY_PATH="$2"
      shift 2
      ;;
    --sha256)
      (( $# >= 2 )) || die "--sha256 requires a value"
      EXPECTED_SHA256="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument"
      ;;
  esac
done

[[ -n "${ARCHIVE_PATH}" && -n "${IDENTITY_PATH}" && -n "${EXPECTED_SHA256}" ]] || {
  usage >&2
  die "archive, identity and out-of-band SHA-256 are required"
}
[[ "${ARCHIVE_PATH}" == *.tar.zst.age ]] || die "archive must use the .tar.zst.age suffix"
[[ "${EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]] ||
  die "expected SHA-256 must be 64 lowercase hexadecimal characters"

require_root
for command in age docker find grep install mktemp realpath sha256sum stat tar tr zstd; do
  require_command "${command}"
done
tar --version 2>/dev/null | head -n 1 | grep --quiet "GNU tar" ||
  die "GNU tar is required"
acquire_operator_lock

[[ -f "${ARCHIVE_PATH}" && ! -L "${ARCHIVE_PATH}" ]] ||
  die "archive must be a regular non-symlink file"
[[ -f "${IDENTITY_PATH}" && ! -L "${IDENTITY_PATH}" ]] ||
  die "age identity must be a regular non-symlink file"
[[ "$(stat --format='%u' -- "${ARCHIVE_PATH}")" == "0" ]] ||
  die "archive must be owned by root during verification"
archive_mode="$(stat --format='%a' -- "${ARCHIVE_PATH}")"
(( (8#${archive_mode} & 022) == 0 )) ||
  die "archive must not be group/world writable"
[[ "$(stat --format='%u' -- "${IDENTITY_PATH}")" == "0" ]] ||
  die "age identity must be owned by root"
identity_mode="$(stat --format='%a' -- "${IDENTITY_PATH}")"
(( (8#${identity_mode} & 077) == 0 )) ||
  die "age identity must not grant group/world access"
unset archive_mode identity_mode

for compose_project in refunddesk "${REFUNDDESK_COMPOSE_PROJECT}"; do
  if [[ -n "$(
    docker ps \
      --quiet \
      --filter "label=com.docker.compose.project=${compose_project}"
  )" ]]; then
    die "an active RefundDesk Compose project was detected"
  fi
  if [[ -n "$(docker ps --quiet --filter "name=^/${compose_project}[-_]")" ]]; then
    die "an active RefundDesk container was detected"
  fi
done

docker image inspect "${POSTGRES_IMAGE}" >/dev/null 2>&1 ||
  die "the exact PostgreSQL verification image is not available locally"

read -r actual_sha256 _ < <(sha256sum -- "${ARCHIVE_PATH}")
[[ "${actual_sha256}" == "${EXPECTED_SHA256}" ]] ||
  die "encrypted archive SHA-256 does not match the out-of-band value"
unset actual_sha256 EXPECTED_SHA256

safe_remove_work_directory() {
  local resolved

  [[ -n "${WORK_DIRECTORY}" && -d "${WORK_DIRECTORY}" && ! -L "${WORK_DIRECTORY}" ]] || return 0
  resolved="$(realpath --canonicalize-existing -- "${WORK_DIRECTORY}")" || return 1
  [[ "${resolved}" == "${WORK_DIRECTORY}" ]] || return 1
  [[ "${resolved}" == "${TEMP_PARENT}"/refunddesk-restore-verify.* ]] || return 1
  rm --recursive --force --one-file-system -- "${resolved}"
}

cleanup() {
  local status=$?

  trap - EXIT INT TERM
  if [[ -n "${CONTAINER_NAME}" ]] &&
    docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
    docker rm --force --volumes "${CONTAINER_NAME}" >/dev/null 2>&1 || status=1
  fi
  safe_remove_work_directory || status=1
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TEMP_PARENT="$(realpath --canonicalize-existing -- "${TMPDIR:-/tmp}")"
[[ -d "${TEMP_PARENT}" && ! -L "${TEMP_PARENT}" ]] ||
  die "temporary parent must be a real directory"
WORK_DIRECTORY="$(
  mktemp --directory --tmpdir="${TEMP_PARENT}" refunddesk-restore-verify.XXXXXXXX
)"
WORK_DIRECTORY="$(realpath --canonicalize-existing -- "${WORK_DIRECTORY}")"
[[ "${WORK_DIRECTORY}" == "${TEMP_PARENT}"/refunddesk-restore-verify.* ]] ||
  die "mktemp returned an unexpected directory"
[[ "$(stat --format='%u:%a' -- "${WORK_DIRECTORY}")" == "0:700" ]] ||
  die "temporary directory ownership or mode is unsafe"

decrypted_archive="${WORK_DIRECTORY}/postgres.tar.zst"
restored_pgdata="${WORK_DIRECTORY}/pgdata"
install -d -o root -g root -m 0700 "${restored_pgdata}"

if ! age \
  --decrypt \
  --identity "${IDENTITY_PATH}" \
  --output "${decrypted_archive}" \
  "${ARCHIVE_PATH}" 2>"${WORK_DIRECTORY}/age-error"; then
  die "encrypted archive decryption failed"
fi
chmod 0600 "${decrypted_archive}"
zstd --test --quiet -- "${decrypted_archive}" 2>/dev/null ||
  die "decrypted archive compression check failed"

if ! zstd --decompress --stdout --quiet -- "${decrypted_archive}" 2>/dev/null |
  tar \
    --extract \
    --file=- \
    --directory="${restored_pgdata}" \
    --numeric-owner \
    --same-owner \
    --same-permissions \
    --acls \
    --xattrs \
    --delay-directory-restore 2>/dev/null; then
  die "PostgreSQL archive extraction failed"
fi
rm --force -- "${decrypted_archive}" "${WORK_DIRECTORY}/age-error"

[[ "$(realpath --canonicalize-existing -- "${restored_pgdata}")" == "${restored_pgdata}" ]] ||
  die "restored PGDATA escaped the verified temporary directory"
[[ -f "${restored_pgdata}/PG_VERSION" && ! -L "${restored_pgdata}/PG_VERSION" ]] ||
  die "restored PGDATA has no regular PG_VERSION"
[[ "$(<"${restored_pgdata}/PG_VERSION")" == "18" ]] ||
  die "restored PGDATA is not PostgreSQL 18"
[[ ! -e "${restored_pgdata}/postmaster.pid" ]] ||
  die "restored cold backup unexpectedly contains postmaster.pid"
[[ "$(stat --format='%u:%g' -- "${restored_pgdata}")" == "999:999" ]] ||
  die "restored PGDATA does not preserve PostgreSQL UID/GID 999"
if find "${restored_pgdata}" -xdev \( \
  -type l -o -type b -o -type c -o -type p -o -type s \
  \) -print -quit | grep --quiet .; then
  die "restored PGDATA contains a link or special file"
fi
if find "${restored_pgdata}" -xdev \( ! -uid 999 -o ! -gid 999 \) -print -quit |
  grep --quiet .; then
  die "restored PGDATA contains an unexpected numeric owner"
fi
if find "${restored_pgdata}" -xdev -type f -links +1 -print -quit | grep --quiet .; then
  die "restored PGDATA contains a hard-linked file"
fi

if ! docker run \
  --rm \
  --pull never \
  --label com.refunddesk.restore-checksum-verification=true \
  --network none \
  --user 999:999 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 32 \
  --memory 128m \
  --cpus 0.5 \
  --mount "type=bind,source=${restored_pgdata},target=/var/lib/postgresql/data,readonly" \
  --entrypoint /usr/lib/postgresql/18/bin/pg_checksums \
  "${POSTGRES_IMAGE}" \
  --check \
  --pgdata=/var/lib/postgresql/data \
  >"${WORK_DIRECTORY}/checksum-output" \
  2>"${WORK_DIRECTORY}/checksum-error"; then
  die "restored PGDATA checksums are disabled or corrupt"
fi
rm --force -- "${WORK_DIRECTORY}/checksum-output" "${WORK_DIRECTORY}/checksum-error"

CONTAINER_NAME="refunddesk-restore-verify-$$-${RANDOM}"
docker run \
  --detach \
  --pull never \
  --name "${CONTAINER_NAME}" \
  --label com.refunddesk.restore-verification=true \
  --network none \
  --user 999:999 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 256m \
  --cpus 1 \
  --mount "type=bind,source=${restored_pgdata},target=/var/lib/postgresql/data" \
  --entrypoint /usr/lib/postgresql/18/bin/postgres \
  "${POSTGRES_IMAGE}" \
  -D /var/lib/postgresql/data \
  -c "listen_addresses=" \
  -c "unix_socket_directories=/var/lib/postgresql/data" \
  -c "unix_socket_permissions=0700" \
  -c "ssl=off" \
  -c "logging_collector=off" >/dev/null

psql_scalar() {
  local query="$1"

  docker exec \
    --user 999:999 \
    "${CONTAINER_NAME}" \
    psql \
    --host=/var/lib/postgresql/data \
    --port=5432 \
    --username=refunddesk_owner \
    --dbname=refunddesk \
    --no-password \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --command="${query}" 2>/dev/null |
    tr --delete '[:space:]'
}

database_ready=false
for _ in {1..60}; do
  if [[ "$(psql_scalar "SELECT 1" || true)" == "1" ]]; then
    database_ready=true
    break
  fi
  [[ "$(docker inspect --format='{{.State.Running}}' "${CONTAINER_NAME}")" == "true" ]] ||
    die "disposable PostgreSQL stopped before accepting local connections"
  sleep 1
done
[[ "${database_ready}" == "true" ]] ||
  die "disposable PostgreSQL did not accept a local connection"

version_and_connection="$(
  psql_scalar "
    SELECT
      current_setting('server_version_num')::integer >= 180000
      AND current_setting('server_version_num')::integer < 190000
      AND current_database() = 'refunddesk'
      AND current_user = 'refunddesk_owner'
  "
)" || die "PostgreSQL version and local connection verification failed"
[[ "${version_and_connection}" == "t" ]] ||
  die "restored database is not the expected PostgreSQL 18 owner database"

prisma_table_ready="$(
  psql_scalar "SELECT to_regclass('public.\"_prisma_migrations\"') IS NOT NULL"
)" || die "Prisma migration-table verification failed"
[[ "${prisma_table_ready}" == "t" ]] || die "Prisma migration table is missing"
prisma_migrations_ready="$(
  psql_scalar "
    SELECT
      count(*) > 0
      AND count(*) FILTER (
        WHERE finished_at IS NULL
          AND rolled_back_at IS NULL
      ) = 0
      AND coalesce(bool_and(
        migration_name <> ''
        AND checksum <> ''
        AND started_at IS NOT NULL
      ), false)
    FROM public.\"_prisma_migrations\"
  "
)" || die "Prisma migration-state verification failed"
[[ "${prisma_migrations_ready}" == "t" ]] ||
  die "Prisma migrations contain an incomplete or failed record"

runtime_roles_ready="$(
  psql_scalar "
    WITH expected_role(role_name) AS (
      VALUES
        ('refunddesk_web_login'),
        ('refunddesk_worker_login'),
        ('refunddesk_queue_login')
    )
    SELECT
      count(runtime_role.oid) = 3
      AND coalesce(bool_and(
        runtime_role.rolcanlogin
        AND NOT runtime_role.rolsuper
        AND NOT runtime_role.rolcreatedb
        AND NOT runtime_role.rolcreaterole
        AND runtime_role.rolinherit
        AND NOT runtime_role.rolreplication
        AND NOT runtime_role.rolbypassrls
      ), false)
    FROM expected_role
    LEFT JOIN pg_catalog.pg_roles AS runtime_role
      ON runtime_role.rolname = expected_role.role_name
  "
)" || die "runtime-role verification failed"
[[ "${runtime_roles_ready}" == "t" ]] ||
  die "runtime roles are missing or hold privileged PostgreSQL attributes"

docker stop --time 30 "${CONTAINER_NAME}" >/dev/null
log "offline PostgreSQL 18 restore verification passed"
