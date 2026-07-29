#!/usr/bin/env bash

# GitHub Actions-only real Docker regression for the PostgreSQL 18 parent
# VOLUME migration. It creates the former child-bind layout, proves that Docker
# added an anonymous parent volume, runs the cold-clone migration, then starts
# the same cluster through the new exact root bind with no volume leak.

set -Eeuo pipefail
umask 077

[[ "${EUID}" -eq 0 ]] || {
  printf '%s\n' "this contract test must run as root" >&2
  exit 1
}
[[ "${CI:-}" == "true" && "${GITHUB_ACTIONS:-}" == "true" &&
  -n "${GITHUB_WORKSPACE:-}" && -n "${RUNNER_TEMP:-}" ]] || {
  printf '%s\n' "this contract test is restricted to GitHub Actions" >&2
  exit 1
}

readonly PROJECT="refunddesk-ci-mount"
readonly POSTGRES_IMAGE="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
readonly OLD_CONTAINER="refunddesk-ci-postgres-old"
readonly NEW_CONTAINER="refunddesk-ci-postgres-root"

TEST_ROOT=""
BASELINE_VOLUMES=""
BASELINE_CAPTURED=false

project_container_ids() {
  docker container ls --all --quiet \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=postgres"
}

remove_project_containers() {
  local container_id ids_output
  local -a container_ids

  ids_output="$(project_container_ids)" || return 1
  container_ids=()
  if [[ -n "${ids_output}" ]]; then
    mapfile -t container_ids <<<"${ids_output}"
  fi
  for container_id in "${container_ids[@]}"; do
    [[ -n "${container_id}" ]] || continue
    docker rm --force --volumes "${container_id}" >/dev/null 2>&1 || return 1
  done
}

safe_remove_test_root() {
  local resolved

  [[ -n "${TEST_ROOT}" && -d "${TEST_ROOT}" && ! -L "${TEST_ROOT}" ]] || return 0
  resolved="$(readlink --canonicalize-existing -- "${TEST_ROOT}")" || return 1
  [[ "${resolved}" == "${TEST_ROOT}" &&
    "${resolved}" == "${RUNNER_TEMP}"/refunddesk-pg-root-mount.* ]] ||
    return 1
  rm --recursive --force --one-file-system -- "${resolved}"
}

finish() {
  local status=$?

  trap - EXIT
  remove_project_containers || status=1
  safe_remove_test_root || status=1
  if [[ "${BASELINE_CAPTURED}" == "true" &&
    "$(docker volume ls --quiet | LC_ALL=C sort)" != "${BASELINE_VOLUMES}" ]]; then
    status=1
  fi
  exit "${status}"
}
trap finish EXIT

remove_project_containers
BASELINE_VOLUMES="$(docker volume ls --quiet | LC_ALL=C sort)"
BASELINE_CAPTURED=true
TEST_ROOT="$(mktemp --directory "${RUNNER_TEMP}/refunddesk-pg-root-mount.XXXXXXXX")"
TEST_ROOT="$(readlink --canonicalize-existing -- "${TEST_ROOT}")"
[[ "${TEST_ROOT}" == "${RUNNER_TEMP}"/refunddesk-pg-root-mount.* ]] ||
  exit 1
HOST_PGDATA="${TEST_ROOT}/data"
MIGRATION_PARENT="${TEST_ROOT}/checks"
install -d -o 999 -g 999 -m 0700 "${HOST_PGDATA}"

docker run \
  --detach \
  --pull never \
  --name "${OLD_CONTAINER}" \
  --label "com.docker.compose.project=${PROJECT}" \
  --label "com.docker.compose.service=postgres" \
  --network none \
  --restart=no \
  --pids-limit 128 \
  --memory 256m \
  --env POSTGRES_DB=refunddesk \
  --env POSTGRES_USER=refunddesk_owner \
  --env POSTGRES_PASSWORD=ci_root_mount_password \
  --env POSTGRES_INITDB_ARGS=--data-checksums \
  --env PGDATA=/var/lib/postgresql/data \
  --mount "type=bind,source=${HOST_PGDATA},target=/var/lib/postgresql/data" \
  "${POSTGRES_IMAGE}" >/dev/null

old_ready=false
for _ in {1..60}; do
  if docker exec "${OLD_CONTAINER}" \
    pg_isready --quiet --username=refunddesk_owner --dbname=refunddesk; then
    old_ready=true
    break
  fi
  [[ "$(docker inspect --format='{{.State.Running}}' "${OLD_CONTAINER}")" == "true" ]] ||
    exit 1
  sleep 1
done
[[ "${old_ready}" == "true" ]] || exit 1
docker exec "${OLD_CONTAINER}" \
  psql \
  --username=refunddesk_owner \
  --dbname=refunddesk \
  --set=ON_ERROR_STOP=1 \
  --command='CREATE TABLE public._prisma_migrations (finished_at timestamptz);' >/dev/null

old_inspection="$(docker inspect "${OLD_CONTAINER}")"
jq --exit-status \
  --arg source "${HOST_PGDATA}" '
    ([.[0].Mounts[] |
      select(
        .Type == "bind"
        and .Source == $source
        and .Destination == "/var/lib/postgresql/data"
      )] | length == 1)
    and ([.[0].Mounts[] |
      select(.Type == "volume" and .Destination == "/var/lib/postgresql")] | length == 1)
  ' <<<"${old_inspection}" >/dev/null

install -d -o root -g root -m 0700 "${MIGRATION_PARENT}/check"
install -d -o 999 -g 999 -m 0700 "${MIGRATION_PARENT}/check/pgdata"
printf '%s\n' stale >"${MIGRATION_PARENT}/check/pgdata/interrupted-clone"

docker create \
  --pull=never \
  --name "${PROJECT}-postgres-root-probe" \
  --label com.refunddesk.postgres-root-mount-helper=false \
  --network none \
  --read-only \
  --mount "type=bind,source=${MIGRATION_PARENT}/check/pgdata,target=/var/lib/postgresql" \
  --entrypoint /bin/true \
  "${POSTGRES_IMAGE}" >/dev/null

if env \
  REFUNDDESK_ROOT="${GITHUB_WORKSPACE}" \
  REFUNDDESK_CONFIG_ROOT=/etc/refunddesk \
  REFUNDDESK_COMPOSE_FILE="${GITHUB_WORKSPACE}/deploy/lightsail/compose.yml" \
  REFUNDDESK_COMPOSE_PROJECT="${PROJECT}" \
  REFUNDDESK_POSTGRES_HOST_PGDATA="${HOST_PGDATA}" \
  REFUNDDESK_POSTGRES_MIGRATION_PARENT="${MIGRATION_PARENT}" \
  REFUNDDESK_POSTGRES_ROOT_MIGRATION_CONTRACT=ci-v2 \
  CI=true \
  GITHUB_ACTIONS=true \
  GITHUB_WORKSPACE="${GITHUB_WORKSPACE}" \
  RUNNER_TEMP="${RUNNER_TEMP}" \
  bash "${GITHUB_WORKSPACE}/deploy/lightsail/scripts/prepare-postgres-root-mount.sh"; then
  exit 1
fi
docker container inspect "${PROJECT}-postgres-root-probe" >/dev/null
[[ -f "${MIGRATION_PARENT}/check/pgdata/interrupted-clone" ]] || exit 1
docker rm --force "${PROJECT}-postgres-root-probe" >/dev/null

docker create \
  --pull=never \
  --name "${PROJECT}-postgres-root-probe" \
  --label com.refunddesk.postgres-root-mount-helper=true \
  --label "com.refunddesk.postgres-root-mount-project=${PROJECT}" \
  --label com.refunddesk.postgres-root-mount-role=probe \
  --network none \
  --restart=no \
  --user 999:999 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 256m \
  --cpus 1 \
  --mount "type=bind,source=${MIGRATION_PARENT}/check/pgdata,target=/var/lib/postgresql" \
  --entrypoint /usr/lib/postgresql/18/bin/postgres \
  "${POSTGRES_IMAGE}" \
  -D /var/lib/postgresql \
  -c "listen_addresses=" \
  -c "unix_socket_directories=/var/lib/postgresql" \
  -c "unix_socket_permissions=0700" \
  -c "ssl=off" \
  -c "logging_collector=off" >/dev/null

env \
  REFUNDDESK_ROOT="${GITHUB_WORKSPACE}" \
  REFUNDDESK_CONFIG_ROOT=/etc/refunddesk \
  REFUNDDESK_COMPOSE_FILE="${GITHUB_WORKSPACE}/deploy/lightsail/compose.yml" \
  REFUNDDESK_COMPOSE_PROJECT="${PROJECT}" \
  REFUNDDESK_POSTGRES_HOST_PGDATA="${HOST_PGDATA}" \
  REFUNDDESK_POSTGRES_MIGRATION_PARENT="${MIGRATION_PARENT}" \
  REFUNDDESK_POSTGRES_ROOT_MIGRATION_CONTRACT=ci-v2 \
  CI=true \
  GITHUB_ACTIONS=true \
  GITHUB_WORKSPACE="${GITHUB_WORKSPACE}" \
  RUNNER_TEMP="${RUNNER_TEMP}" \
  bash "${GITHUB_WORKSPACE}/deploy/lightsail/scripts/prepare-postgres-root-mount.sh"

[[ -f "${HOST_PGDATA}/PG_VERSION" && "$(<"${HOST_PGDATA}/PG_VERSION")" == "18" ]] ||
  exit 1
[[ -z "$(project_container_ids)" ]] || exit 1
[[ "$(docker volume ls --quiet | LC_ALL=C sort)" == "${BASELINE_VOLUMES}" ]] || exit 1

docker run \
  --detach \
  --pull never \
  --name "${NEW_CONTAINER}" \
  --label "com.docker.compose.project=${PROJECT}" \
  --label "com.docker.compose.service=postgres" \
  --network none \
  --restart=no \
  --pids-limit 128 \
  --memory 256m \
  --env PGDATA=/var/lib/postgresql \
  --mount "type=bind,source=${HOST_PGDATA},target=/var/lib/postgresql" \
  "${POSTGRES_IMAGE}" >/dev/null

new_inspection="$(docker inspect "${NEW_CONTAINER}")"
jq --exit-status \
  --arg source "${HOST_PGDATA}" '
    ([.[0].Mounts[] |
      select(
        .Type == "bind"
        and .Source == $source
        and .Destination == "/var/lib/postgresql"
      )] | length == 1)
    and all(.[0].Mounts[]?; .Type != "volume")
  ' <<<"${new_inspection}" >/dev/null
new_ready=false
for _ in {1..60}; do
  result="$(
    docker exec "${NEW_CONTAINER}" \
      psql \
      --host=/var/run/postgresql \
      --username=refunddesk_owner \
      --dbname=refunddesk \
      --tuples-only \
      --no-align \
      --command="SELECT to_regclass('public._prisma_migrations') IS NOT NULL;" 2>/dev/null |
      tr --delete '[:space:]'
  )" || result=""
  if [[ "${result}" == "t" ]]; then
    new_ready=true
    break
  fi
  [[ "$(docker inspect --format='{{.State.Running}}' "${NEW_CONTAINER}")" == "true" ]] ||
    exit 1
  sleep 1
done
[[ "${new_ready}" == "true" ]] || exit 1
[[ "$(docker volume ls --quiet | LC_ALL=C sort)" == "${BASELINE_VOLUMES}" ]] || exit 1
