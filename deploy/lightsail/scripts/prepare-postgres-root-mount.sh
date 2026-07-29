#!/usr/bin/env bash

# One-time PostgreSQL 18 storage-contract migration:
# - the host PGDATA path never moves;
# - an old child bind (/var/lib/postgresql/data) is replaced by an exact bind
#   over the image-declared VOLUME root (/var/lib/postgresql);
# - a cold, metadata-preserving clone must start and answer a catalogue query
#   before the old container or its anonymous parent volume can be removed.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

readonly POSTGRES_IMAGE="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
readonly OLD_CONTAINER_PGDATA="/var/lib/postgresql/data"
readonly MIGRATION_CONTRACT="${REFUNDDESK_POSTGRES_ROOT_MIGRATION_CONTRACT:-invalid}"
readonly MIGRATION_PARENT="${REFUNDDESK_POSTGRES_MIGRATION_PARENT:-/var/lib/refunddesk/postgres-migration-checks}"

require_root
for command in awk cp df docker du find grep jq readlink rm sha256sum sleep stat tar tr; do
  require_command "${command}"
done

if [[ "${MIGRATION_CONTRACT}" == "release-v2" ]]; then
  [[ "${REFUNDDESK_RELEASE_LAUNCHER_CONTRACT:-}" == "2" ]] ||
    die "PostgreSQL root-mount migration lacks the stable release contract"
  [[ "${REFUNDDESK_REVISION:-}" =~ ^[0-9a-f]{40}$ ]] ||
    die "PostgreSQL root-mount migration revision is invalid"
  EXPECTED_SOURCE="${REFUNDDESK_ROOT}/releases/${REFUNDDESK_REVISION}/source"
  [[ "${SCRIPT_DIR}" == "${EXPECTED_SOURCE}/deploy/lightsail/scripts" &&
    "${REFUNDDESK_COMPOSE_FILE}" == "${EXPECTED_SOURCE}/deploy/lightsail/compose.yml" &&
    "${REFUNDDESK_COMPOSE_PROJECT}" == "refunddesk" &&
    "${REFUNDDESK_POSTGRES_HOST_PGDATA}" == "/var/lib/refunddesk/postgres/data" &&
    "${MIGRATION_PARENT}" == "/var/lib/refunddesk/postgres-migration-checks" ]] ||
    die "PostgreSQL root-mount migration release paths are inconsistent"
  TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
  assert_root_secret_file "${TRANSITION_JOURNAL}"
  jq --exit-status --arg revision "${REFUNDDESK_REVISION}" '
    .schemaVersion == 1
    and .status == "in_progress"
    and .to.revision == $revision
  ' "${TRANSITION_JOURNAL}" >/dev/null ||
    die "PostgreSQL root-mount migration journal differs from the exact target"
elif [[ "${MIGRATION_CONTRACT}" == "ci-v2" ]]; then
  [[ "${CI:-}" == "true" && "${GITHUB_ACTIONS:-}" == "true" ]] ||
    die "CI PostgreSQL root-mount migration is restricted to GitHub Actions"
  [[ "${REFUNDDESK_COMPOSE_PROJECT}" == "refunddesk-ci-mount" &&
    -n "${RUNNER_TEMP:-}" &&
    "${REFUNDDESK_POSTGRES_HOST_PGDATA}" == "${RUNNER_TEMP}"/refunddesk-pg-root-mount.*"/data" &&
    "${MIGRATION_PARENT}" == "${RUNNER_TEMP}"/refunddesk-pg-root-mount.*"/checks" ]] ||
    die "CI PostgreSQL root-mount migration paths or project are inconsistent"
else
  die "PostgreSQL root-mount migration invocation contract is invalid"
fi

postgres_image_inspection="$(docker image inspect "${POSTGRES_IMAGE}")" ||
  die "the exact PostgreSQL 18 image is not available locally"
postgres_image_id="$(
  jq --exit-status --raw-output '
    select(length == 1 and (.[0].Id | test("^sha256:[0-9a-f]{64}$")))
    | .[0].Id
  ' <<<"${postgres_image_inspection}"
)" || die "the local PostgreSQL image ID is invalid"

WORK_DIRECTORY="${MIGRATION_PARENT}/check"
PROBE_CONTAINER="${REFUNDDESK_COMPOSE_PROJECT}-postgres-root-probe"
VOLUME_CHECK_CONTAINER="${REFUNDDESK_COMPOSE_PROJECT}-postgres-volume-check"
PROBE_OWNED=false
VOLUME_CHECK_OWNED=false
WORK_DIRECTORY_OWNED=false

assert_no_container_mounts_work_directory() {
  local container_id ids_output inspection
  local -a container_ids

  ids_output="$(docker container ls --all --quiet)" || return 1
  container_ids=()
  if [[ -n "${ids_output}" ]]; then
    mapfile -t container_ids <<<"${ids_output}"
  fi
  for container_id in "${container_ids[@]}"; do
    [[ -n "${container_id}" ]] || continue
    inspection="$(docker inspect "${container_id}")" || return 1
    if ! jq --exit-status --arg root "${WORK_DIRECTORY}" '
      all(.[0].Mounts[]?;
        .Type != "bind"
        or (
          .Source != $root
          and (.Source | startswith($root + "/") | not)
        )
      )
    ' <<<"${inspection}" >/dev/null; then
      return 1
    fi
  done
  return 0
}

safe_remove_work_directory() {
  local resolved

  [[ -n "${WORK_DIRECTORY}" ]] || return 0
  if [[ ! -e "${WORK_DIRECTORY}" && ! -L "${WORK_DIRECTORY}" ]]; then
    return 0
  fi
  [[ -d "${WORK_DIRECTORY}" && ! -L "${WORK_DIRECTORY}" ]] || return 1
  resolved="$(readlink --canonicalize-existing -- "${WORK_DIRECTORY}")" || return 1
  [[ "${resolved}" == "${WORK_DIRECTORY}" &&
    "${resolved}" == "${MIGRATION_PARENT}/check" ]] ||
    return 1
  assert_no_container_mounts_work_directory || return 1
  rm --recursive --force --one-file-system -- "${resolved}"
}

cleanup() {
  local status=$?

  trap - EXIT INT TERM
  if [[ "${PROBE_OWNED}" == "true" ]] &&
    docker container inspect "${PROBE_CONTAINER}" >/dev/null 2>&1; then
    docker rm --force "${PROBE_CONTAINER}" >/dev/null 2>&1 || status=1
  fi
  if [[ "${VOLUME_CHECK_OWNED}" == "true" ]] &&
    docker container inspect "${VOLUME_CHECK_CONTAINER}" >/dev/null 2>&1; then
    docker rm --force "${VOLUME_CHECK_CONTAINER}" >/dev/null 2>&1 || status=1
  fi
  if [[ "${WORK_DIRECTORY_OWNED}" == "true" ]]; then
    safe_remove_work_directory || status=1
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

volume_inventory() {
  docker volume ls --quiet | LC_ALL=C sort
}

recover_stale_helper_container() {
  local container_name="$1"
  local role="$2"
  local inspection running

  docker container inspect "${container_name}" >/dev/null 2>&1 || return 0
  inspection="$(docker inspect "${container_name}")" ||
    die "stale PostgreSQL migration helper container cannot be inspected"
  if [[ "${role}" == "probe" ]]; then
    jq --exit-status \
      --arg name "/${container_name}" \
      --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
      --arg image_id "${postgres_image_id}" \
      --arg source "${MIGRATION_PARENT}/check/pgdata" \
      --arg target "${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" '
        length == 1
        and .[0].Name == $name
        and .[0].Image == $image_id
        and .[0].Config.Labels["com.refunddesk.postgres-root-mount-helper"] == "true"
        and .[0].Config.Labels["com.refunddesk.postgres-root-mount-project"] == $project
        and .[0].Config.Labels["com.refunddesk.postgres-root-mount-role"] == "probe"
        and .[0].Config.User == "999:999"
        and .[0].Config.Entrypoint == ["/usr/lib/postgresql/18/bin/postgres"]
        and .[0].Config.Cmd == [
          "-D", $target,
          "-c", "listen_addresses=",
          "-c", ("unix_socket_directories=" + $target),
          "-c", "unix_socket_permissions=0700",
          "-c", "ssl=off",
          "-c", "logging_collector=off"
        ]
        and .[0].HostConfig.NetworkMode == "none"
        and .[0].HostConfig.RestartPolicy.Name == "no"
        and .[0].HostConfig.ReadonlyRootfs == true
        and .[0].HostConfig.CapDrop == ["ALL"]
        and .[0].HostConfig.SecurityOpt == ["no-new-privileges:true"]
        and .[0].HostConfig.PidsLimit == 128
        and .[0].HostConfig.Memory == 268435456
        and .[0].HostConfig.NanoCpus == 1000000000
        and .[0].HostConfig.PublishAllPorts == false
        and ((.[0].HostConfig.PortBindings // {}) | length == 0)
        and (.[0].Mounts | length) == 1
        and ([.[0].Mounts[] |
          select(
            .Type == "bind"
            and .Source == $source
            and .Destination == $target
            and .RW == true
          )] | length == 1)
        and all(.[0].Mounts[]?; .Type != "volume")
      ' <<<"${inspection}" >/dev/null ||
      die "deterministic PostgreSQL probe name is occupied outside the recovery contract"
    PROBE_OWNED=true
  else
    jq --exit-status \
      --arg name "/${container_name}" \
      --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
      --arg image_id "${postgres_image_id}" '
        length == 1
        and .[0].Name == $name
        and .[0].Image == $image_id
        and .[0].Config.Labels["com.refunddesk.postgres-root-mount-helper"] == "true"
        and .[0].Config.Labels["com.refunddesk.postgres-root-mount-project"] == $project
        and .[0].Config.Labels["com.refunddesk.postgres-root-mount-role"] == "volume-check"
        and (.[0].Config.User // "") == ""
        and .[0].Config.Entrypoint == ["/bin/sh"]
        and .[0].Config.Cmd
          == ["-ec", "test -z \"$(find /mnt/legacy -xdev -mindepth 1 ! -type d -print -quit)\""]
        and .[0].HostConfig.NetworkMode == "none"
        and .[0].HostConfig.RestartPolicy.Name == "no"
        and .[0].HostConfig.ReadonlyRootfs == true
        and .[0].HostConfig.CapDrop == ["ALL"]
        and .[0].HostConfig.SecurityOpt == ["no-new-privileges:true"]
        and .[0].HostConfig.PidsLimit == 16
        and .[0].HostConfig.Memory == 33554432
        and .[0].HostConfig.NanoCpus == 0
        and .[0].HostConfig.PublishAllPorts == false
        and ((.[0].HostConfig.PortBindings // {}) | length == 0)
        and .[0].HostConfig.Tmpfs
          == {"/var/lib/postgresql":"rw,nosuid,nodev,noexec,size=65536"}
        and ([.[0].Mounts[] |
          select(
            .Type == "volume"
            and .Destination == "/mnt/legacy"
            and .RW == false
            and (.Name | test("^[0-9a-f]{64}$"))
          )] | length == 1)
        and ([.[0].Mounts[] |
          select(.Type == "tmpfs" and .Destination == "/var/lib/postgresql")] | length == 1)
        and (.[0].Mounts | length) == 2
        and all(.[0].Mounts[]?; .Type != "bind")
      ' <<<"${inspection}" >/dev/null ||
      die "deterministic PostgreSQL volume-check name is occupied outside the recovery contract"
    VOLUME_CHECK_OWNED=true
  fi
  running="$(docker_running_state_from_inspection "${inspection}")" ||
    die "stale PostgreSQL helper state cannot be read"
  if [[ "${running}" == "true" ]]; then
    docker stop --time 60 "${container_name}" >/dev/null ||
      docker kill "${container_name}" >/dev/null ||
      die "stale PostgreSQL migration helper could not be stopped"
  fi
  docker rm --force "${container_name}" >/dev/null ||
    die "stale PostgreSQL migration helper could not be removed"
  if [[ "${role}" == "probe" ]]; then
    PROBE_OWNED=false
  else
    VOLUME_CHECK_OWNED=false
  fi
}

tree_fingerprint() {
  local root="$1"

  tar \
    --create \
    --file=- \
    --directory="${root}" \
    --numeric-owner \
    --one-file-system \
    --acls \
    --xattrs \
    --sort=name \
    . |
    sha256sum |
    awk '{print $1}'
}

install -d -o root -g root -m 0700 "${MIGRATION_PARENT}"
[[ -d "${MIGRATION_PARENT}" && ! -L "${MIGRATION_PARENT}" &&
  "$(stat --format='%u:%g:%a' -- "${MIGRATION_PARENT}")" == "0:0:700" ]] ||
  die "PostgreSQL migration-check parent is unsafe"
resolved_migration_parent="$(readlink --canonicalize-existing -- "${MIGRATION_PARENT}")" ||
  die "PostgreSQL migration-check parent cannot be resolved"
[[ "${resolved_migration_parent}" == "${MIGRATION_PARENT}" ]] ||
  die "PostgreSQL migration-check parent is not canonical"
recover_stale_helper_container "${PROBE_CONTAINER}" probe
recover_stale_helper_container "${VOLUME_CHECK_CONTAINER}" volume-check
if [[ -e "${WORK_DIRECTORY}" || -L "${WORK_DIRECTORY}" ]]; then
  [[ -d "${WORK_DIRECTORY}" && ! -L "${WORK_DIRECTORY}" ]] ||
    die "stale PostgreSQL migration clone is outside the recoverable contract"
  WORK_DIRECTORY_OWNED=true
  safe_remove_work_directory ||
    die "stale PostgreSQL migration clone is outside the recoverable contract"
  WORK_DIRECTORY_OWNED=false
fi

ids_output="$(
  docker container ls --all --quiet \
    --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=postgres"
)" || die "project PostgreSQL container inventory is unavailable"
postgres_ids=()
if [[ -n "${ids_output}" ]]; then
  mapfile -t postgres_ids <<<"${ids_output}"
fi
(( ${#postgres_ids[@]} <= 1 )) ||
  die "more than one project PostgreSQL container exists"

postgres_container=""
postgres_inspection="[]"
old_volume_names=()
if (( ${#postgres_ids[@]} == 1 )); then
  postgres_container="${postgres_ids[0]}"
  postgres_inspection="$(docker inspect "${postgres_container}")" ||
    die "project PostgreSQL container cannot be inspected"
  if jq --exit-status \
    --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
    --arg source "${REFUNDDESK_POSTGRES_HOST_PGDATA}" \
    --arg target "${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" '
      length == 1
      and .[0].Config.Labels["com.docker.compose.project"] == $project
      and .[0].Config.Labels["com.docker.compose.service"] == "postgres"
      and ([.[0].Config.Env[]? | select(startswith("PGDATA="))] == [("PGDATA=" + $target)])
      and ([.[0].Mounts[] |
        select(.Type == "bind" and .Source == $source and .Destination == $target)] | length == 1)
      and all(.[0].Mounts[]?; .Type != "volume")
    ' <<<"${postgres_inspection}" >/dev/null; then
    log "PostgreSQL already uses the exact root bind mount without Docker volumes"
    exit 0
  fi

  jq --exit-status \
    --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
    --arg source "${REFUNDDESK_POSTGRES_HOST_PGDATA}" \
    --arg oldTarget "${OLD_CONTAINER_PGDATA}" \
    --arg volumeTarget "${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" '
      length == 1
      and .[0].Config.Labels["com.docker.compose.project"] == $project
      and .[0].Config.Labels["com.docker.compose.service"] == "postgres"
      and ([.[0].Config.Env[]? | select(startswith("PGDATA="))] == [("PGDATA=" + $oldTarget)])
      and ([.[0].Mounts[] |
        select(.Type == "bind" and .Source == $source and .Destination == $oldTarget)] | length == 1)
      and ([.[0].Mounts[] | select(.Type == "volume")] |
        all(.Destination == $volumeTarget))
      and ([.[0].Mounts[] | select(.Type == "volume")] | length <= 1)
    ' <<<"${postgres_inspection}" >/dev/null ||
    die "existing PostgreSQL container matches neither the old nor new storage contract"
  mapfile -t old_volume_names < <(
    jq --raw-output \
      --arg target "${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" '
        .[0].Mounts[]
        | select(.Type == "volume" and .Destination == $target)
        | .Name
      ' <<<"${postgres_inspection}"
  )
fi

if [[ ! -e "${REFUNDDESK_POSTGRES_HOST_PGDATA}/PG_VERSION" ]]; then
  [[ -z "${postgres_container}" ]] ||
    die "existing PostgreSQL container points at a host directory without PG_VERSION"
  log "host PGDATA is empty; fresh PostgreSQL initialization will use the root bind contract"
  exit 0
fi

[[ -d "${REFUNDDESK_POSTGRES_HOST_PGDATA}" &&
  ! -L "${REFUNDDESK_POSTGRES_HOST_PGDATA}" ]] ||
  die "host PostgreSQL data path is not a real directory"
resolved_pgdata="$(readlink --canonicalize-existing -- "${REFUNDDESK_POSTGRES_HOST_PGDATA}")" ||
  die "host PostgreSQL data directory cannot be resolved"
[[ "${resolved_pgdata}" == "${REFUNDDESK_POSTGRES_HOST_PGDATA}" ]] ||
  die "host PostgreSQL data directory is not canonical"

if [[ -n "${postgres_container}" ]]; then
  postgres_running="$(docker_running_state_from_inspection "${postgres_inspection}")" ||
    die "existing PostgreSQL container running state is invalid"
  if [[ "${postgres_running}" == "true" ]]; then
    docker stop --time 60 "${postgres_container}" >/dev/null ||
      die "existing PostgreSQL container did not stop cleanly"
  fi
  postgres_inspection="$(docker inspect "${postgres_container}")" ||
    die "stopped PostgreSQL container cannot be inspected"
  jq --exit-status '
    .[0].State.Running == false
    and .[0].State.ExitCode == 0
    and (.[0].State.Error // "") == ""
  ' <<<"${postgres_inspection}" >/dev/null ||
    die "existing PostgreSQL container is not cleanly stopped"
fi

[[ -f "${resolved_pgdata}/PG_VERSION" && ! -L "${resolved_pgdata}/PG_VERSION" &&
  "$(<"${resolved_pgdata}/PG_VERSION")" == "18" ]] ||
  die "host PGDATA is not a regular PostgreSQL 18 cluster"
[[ ! -e "${resolved_pgdata}/postmaster.pid" ]] ||
  die "host PGDATA retains postmaster.pid after the clean stop"
[[ "$(stat --format='%u:%g:%a' -- "${resolved_pgdata}")" == "999:999:700" ]] ||
  die "host PGDATA must remain UID:GID 999:999 mode 0700"
if find "${resolved_pgdata}" -xdev \( \
  -type l -o -type b -o -type c -o -type p -o -type s \
  \) -print -quit | grep --quiet .; then
  die "host PGDATA contains a link or special file"
fi

for old_volume_name in "${old_volume_names[@]}"; do
  [[ "${old_volume_name}" =~ ^[0-9a-f]{64}$ ]] ||
    die "legacy PostgreSQL parent volume name is not an anonymous Docker ID"
  mapfile -t volume_users < <(
    docker container ls --all --quiet --filter "volume=${old_volume_name}"
  )
  (( ${#volume_users[@]} == 1 )) &&
    [[ "${volume_users[0]}" == "${postgres_container}" ]] ||
    die "legacy PostgreSQL parent volume is referenced outside its exact container"
  volume_check_id="$(
    docker create \
      --pull=never \
      --name "${VOLUME_CHECK_CONTAINER}" \
      --label com.refunddesk.postgres-root-mount-helper=true \
      --label "com.refunddesk.postgres-root-mount-project=${REFUNDDESK_COMPOSE_PROJECT}" \
      --label com.refunddesk.postgres-root-mount-role=volume-check \
      --network none \
      --read-only \
      --cap-drop ALL \
      --security-opt no-new-privileges:true \
      --pids-limit 16 \
      --memory 32m \
      --tmpfs /var/lib/postgresql:rw,nosuid,nodev,noexec,size=65536 \
      --mount "type=volume,source=${old_volume_name},target=/mnt/legacy,readonly" \
      --entrypoint /bin/sh \
      "${postgres_image_id}" \
      -ec 'test -z "$(find /mnt/legacy -xdev -mindepth 1 ! -type d -print -quit)"'
  )" || die "legacy PostgreSQL parent volume inspection could not be created"
  [[ -n "${volume_check_id}" ]] ||
    die "Docker returned no legacy volume inspection container ID"
  VOLUME_CHECK_OWNED=true
  docker start --attach "${VOLUME_CHECK_CONTAINER}" >/dev/null ||
    die "legacy PostgreSQL parent volume contains data and requires human recovery"
  docker rm "${VOLUME_CHECK_CONTAINER}" >/dev/null ||
    die "legacy PostgreSQL parent volume inspection container could not be removed"
  VOLUME_CHECK_OWNED=false
done

install -d -o root -g root -m 0700 "${WORK_DIRECTORY}"
WORK_DIRECTORY="$(readlink --canonicalize-existing -- "${WORK_DIRECTORY}")"
[[ "${WORK_DIRECTORY}" == "${MIGRATION_PARENT}/check" &&
  "$(stat --format='%u:%g:%a' -- "${WORK_DIRECTORY}")" == "0:0:700" ]] ||
  die "PostgreSQL migration-check work directory is unsafe"
WORK_DIRECTORY_OWNED=true
clone_pgdata="${WORK_DIRECTORY}/pgdata"
install -d -o 999 -g 999 -m 0700 "${clone_pgdata}"

data_bytes="$(du --summarize --block-size=1 -- "${resolved_pgdata}" | awk '{print $1}')"
available_bytes="$(df --output=avail --block-size=1 "${MIGRATION_PARENT}" | awk 'NR == 2 {print $1}')"
[[ "${data_bytes}" =~ ^[1-9][0-9]*$ && "${available_bytes}" =~ ^[1-9][0-9]*$ ]] ||
  die "PostgreSQL clone space requirement cannot be calculated"
required_bytes=$((data_bytes + 536870912))
(( available_bytes >= required_bytes )) ||
  die "insufficient free space for a full cold PostgreSQL clone plus 512 MiB margin"

cp --archive --reflink=auto --one-file-system \
  "${resolved_pgdata}/." "${clone_pgdata}/" ||
  die "cold PostgreSQL clone could not be created"
[[ "$(stat --format='%u:%g:%a' -- "${clone_pgdata}")" == "999:999:700" &&
  "$(<"${clone_pgdata}/PG_VERSION")" == "18" &&
  ! -e "${clone_pgdata}/postmaster.pid" ]] ||
  die "cold PostgreSQL clone does not preserve the cluster root contract"
[[ "$(tree_fingerprint "${resolved_pgdata}")" == "$(tree_fingerprint "${clone_pgdata}")" ]] ||
  die "cold PostgreSQL clone differs from its source data and metadata"

volumes_before_probe="$(volume_inventory)"
probe_id="$(
  docker create \
    --pull=never \
    --name "${PROBE_CONTAINER}" \
    --label com.refunddesk.postgres-root-mount-helper=true \
    --label "com.refunddesk.postgres-root-mount-project=${REFUNDDESK_COMPOSE_PROJECT}" \
    --label com.refunddesk.postgres-root-mount-role=probe \
    --network none \
    --user 999:999 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 128 \
    --memory 256m \
    --cpus 1 \
    --mount "type=bind,source=${clone_pgdata},target=${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" \
    --entrypoint /usr/lib/postgresql/18/bin/postgres \
    "${postgres_image_id}" \
    -D "${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" \
    -c "listen_addresses=" \
    -c "unix_socket_directories=${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" \
    -c "unix_socket_permissions=0700" \
    -c "ssl=off" \
    -c "logging_collector=off"
)" || die "cold PostgreSQL root-mount probe could not be created"
[[ -n "${probe_id}" ]] || die "Docker returned no PostgreSQL root-mount probe ID"
PROBE_OWNED=true
probe_inspection="$(docker inspect "${PROBE_CONTAINER}")" ||
  die "cold PostgreSQL root-mount probe cannot be inspected"
jq --exit-status \
  --arg id "${postgres_image_id}" \
  --arg source "${clone_pgdata}" \
  --arg target "${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" '
    length == 1
    and .[0].Image == $id
    and .[0].HostConfig.NetworkMode == "none"
    and .[0].HostConfig.PublishAllPorts == false
    and ((.[0].HostConfig.PortBindings // {}) | length == 0)
    and ([.[0].Mounts[] |
      select(.Type == "bind" and .Source == $source and .Destination == $target)] | length == 1)
    and all(.[0].Mounts[]?; .Type != "volume")
  ' <<<"${probe_inspection}" >/dev/null ||
  die "cold PostgreSQL probe is outside the exact offline root-mount contract"

docker start "${PROBE_CONTAINER}" >/dev/null ||
  die "cold PostgreSQL root-mount probe could not start"
probe_ready=false
for _ in {1..60}; do
  probe_result="$(
    docker exec \
      --user 999:999 \
      "${PROBE_CONTAINER}" \
      psql \
      --host="${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" \
      --port=5432 \
      --username=refunddesk_owner \
      --dbname=refunddesk \
      --no-password \
      --no-psqlrc \
      --set=ON_ERROR_STOP=1 \
      --tuples-only \
      --no-align \
      --command="
        SELECT
          current_user = 'refunddesk_owner'
          AND current_database() = 'refunddesk'
          AND current_setting('server_version_num')::integer >= 180000
          AND current_setting('server_version_num')::integer < 190000
          AND to_regclass('public._prisma_migrations') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public._prisma_migrations
            WHERE finished_at IS NULL
          );
      " 2>/dev/null |
      tr --delete '[:space:]'
  )" || probe_result=""
  if [[ "${probe_result}" == "t" ]]; then
    probe_ready=true
    break
  fi
  [[ "$(docker inspect --format='{{.State.Running}}' "${PROBE_CONTAINER}")" == "true" ]] ||
    die "cold PostgreSQL probe stopped before catalogue verification"
  sleep 1
done
[[ "${probe_ready}" == "true" ]] ||
  die "cold PostgreSQL probe did not verify the expected catalogue"

docker stop --time 60 "${PROBE_CONTAINER}" >/dev/null ||
  die "cold PostgreSQL probe did not stop cleanly"
probe_inspection="$(docker inspect "${PROBE_CONTAINER}")" ||
  die "stopped cold PostgreSQL probe cannot be inspected"
jq --exit-status '
  .[0].State.Running == false
  and .[0].State.ExitCode == 0
  and (.[0].State.Error // "") == ""
' <<<"${probe_inspection}" >/dev/null ||
  die "cold PostgreSQL probe has an unclean terminal state"
[[ ! -e "${clone_pgdata}/postmaster.pid" ]] ||
  die "cold PostgreSQL probe left postmaster.pid behind"
docker rm "${PROBE_CONTAINER}" >/dev/null ||
  die "cold PostgreSQL probe container could not be removed"
PROBE_OWNED=false

docker run \
  --rm \
  --pull never \
  --network none \
  --user 999:999 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 32 \
  --memory 128m \
  --cpus 0.5 \
  --mount "type=bind,source=${clone_pgdata},target=${REFUNDDESK_POSTGRES_CONTAINER_PGDATA},readonly" \
  --entrypoint /usr/lib/postgresql/18/bin/pg_checksums \
  "${postgres_image_id}" \
  --check \
  --pgdata="${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" >/dev/null ||
  die "cold PostgreSQL clone checksums are disabled or corrupt"
[[ "$(volume_inventory)" == "${volumes_before_probe}" ]] ||
  die "cold PostgreSQL root-mount probe leaked a Docker volume"

safe_remove_work_directory ||
  die "verified cold PostgreSQL clone could not be destroyed safely"
WORK_DIRECTORY_OWNED=false
WORK_DIRECTORY=""

if [[ -n "${postgres_container}" ]]; then
  docker rm --volumes "${postgres_container}" >/dev/null ||
    die "old PostgreSQL container could not be removed with its anonymous volumes"
fi
for old_volume_name in "${old_volume_names[@]}"; do
  if docker volume inspect "${old_volume_name}" >/dev/null 2>&1; then
    die "legacy PostgreSQL anonymous parent volume survived exact container removal"
  fi
done

log "cold PostgreSQL clone verified; old child-bind container and anonymous parent volume removed"
