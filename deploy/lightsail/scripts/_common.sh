#!/usr/bin/env bash

# Shared, non-secret operator contract for the dedicated RefundDesk sandbox host.
# Defaults are intentionally fixed so an accidental invocation cannot target an
# unrelated Compose project. Callers may override paths through the documented
# REFUNDDESK_* variables only when testing a disposable host.

set -Eeuo pipefail
umask 077

readonly REFUNDDESK_ROOT="${REFUNDDESK_ROOT:-/opt/refunddesk}"
readonly REFUNDDESK_CONFIG_ROOT="${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}"
readonly REFUNDDESK_CONTROL_ROOT="${REFUNDDESK_CONTROL_ROOT:-/var/lib/refunddesk/control}"
readonly REFUNDDESK_CONTROL_PLANE_LINK="${REFUNDDESK_ROOT}/control-plane-current"
readonly REFUNDDESK_COMPOSE_FILE="${REFUNDDESK_COMPOSE_FILE:-${REFUNDDESK_ROOT}/current/deploy/lightsail/compose.yml}"
readonly REFUNDDESK_COMPOSE_PROJECT="${REFUNDDESK_COMPOSE_PROJECT:-refunddesk}"
readonly REFUNDDESK_RELEASE_ENV="${REFUNDDESK_RELEASE_ENV:-${REFUNDDESK_CONFIG_ROOT}/release.env}"
readonly REFUNDDESK_OPERATOR_LOCK="${REFUNDDESK_OPERATOR_LOCK:-/run/refunddesk/operator.lock}"
readonly REFUNDDESK_DATABASE_OWNER_JOB_NAME="refunddesk-database-owner-job"
readonly REFUNDDESK_POSTGRES_HOST_PGDATA="${REFUNDDESK_POSTGRES_HOST_PGDATA:-/var/lib/refunddesk/postgres/data}"
readonly REFUNDDESK_POSTGRES_CONTAINER_PGDATA="/var/lib/postgresql"

log() {
  printf '%s %s\n' "$(date --utc '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "this command must run as root"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

docker_running_state_from_inspection() {
  local inspection="$1"

  jq --exit-status --raw-output --slurp '
    if length == 1
      and (.[0] | type) == "array"
      and (.[0] | length) == 1
      and (.[0][0].State.Running | type) == "boolean"
    then (.[0][0].State.Running | tostring)
    else error("invalid Docker running state")
    end
  ' <<<"${inspection}"
}

assert_regular_file() {
  local path="$1"
  [[ -f "${path}" && ! -L "${path}" ]] || die "expected a regular non-symlink file: ${path}"
}

assert_root_control_file() {
  local path="$1"
  local owner mode

  assert_regular_file "${path}"
  owner="$(stat --format='%u' -- "${path}")"
  mode="$(stat --format='%a' -- "${path}")"
  [[ "${owner}" == "0" ]] || die "control file must be owned by root: ${path}"
  (( (8#${mode} & 022) == 0 )) || die "control file must not be group/world writable: ${path}"
}

assert_root_secret_file() {
  local path="$1"
  local mode

  assert_root_control_file "${path}"
  mode="$(stat --format='%a' -- "${path}")"
  (( (8#${mode} & 077) == 0 )) || die "secret file must not grant group/world access: ${path}"
}

assert_safe_directory() {
  local path="$1"
  [[ -d "${path}" && ! -L "${path}" ]] || die "expected a non-symlink directory: ${path}"
}

assert_root_secret_directory() {
  local path="$1"

  assert_safe_directory "${path}"
  [[ "$(stat --format='%u:%g:%a' -- "${path}")" == "0:0:700" ]] ||
    die "secret control directory must be root-owned mode 0700: ${path}"
}

assert_root_control_symlink() {
  local path="$1"
  local expected_value="$2"
  local control_plane_root resolved_path relative_path

  [[ -L "${path}" ]] || die "expected a stable control-plane symlink: ${path}"
  [[ "$(stat --format='%u' -- "${path}")" == "0" ]] ||
    die "stable control-plane symlink must be owned by root: ${path}"
  [[ "$(readlink -- "${path}")" == "${expected_value}" ]] ||
    die "stable control-plane symlink has an unexpected target: ${path}"
  [[ -L "${REFUNDDESK_CONTROL_PLANE_LINK}" ]] ||
    die "control-plane generation pointer must be a symlink"
  [[ "$(stat --format='%u' -- "${REFUNDDESK_CONTROL_PLANE_LINK}")" == "0" ]] ||
    die "control-plane generation pointer must be owned by root"
  control_plane_root="$(
    readlink --canonicalize-existing -- "${REFUNDDESK_CONTROL_PLANE_LINK}"
  )" || die "control-plane generation cannot be resolved"
  case "${control_plane_root}" in
    "${REFUNDDESK_ROOT}"/releases/*/source/deploy/lightsail | \
      "${REFUNDDESK_ROOT}"/control-plane-generations/*)
      ;;
    *)
      die "control-plane generation escaped its root-controlled namespace"
      ;;
  esac
  [[ "${expected_value}" == "${REFUNDDESK_CONTROL_PLANE_LINK}/"* ]] ||
    die "stable control-plane target does not use the generation pointer"
  relative_path="${expected_value#"${REFUNDDESK_CONTROL_PLANE_LINK}/"}"
  resolved_path="$(readlink --canonicalize-existing -- "${path}")" ||
    die "stable control-plane target cannot be resolved: ${path}"
  [[ "${resolved_path}" == "${control_plane_root}/${relative_path}" ]] ||
    die "stable control-plane target escaped the active generation: ${path}"
  assert_root_control_file "${resolved_path}"
}

assert_root_control_entry() {
  local path="$1"
  local expected_value="$2"
  local control_plane_root relative_path

  if [[ -f "${path}" && ! -L "${path}" ]]; then
    assert_root_control_file "${path}"
    if [[ ! -e "${REFUNDDESK_CONTROL_PLANE_LINK}" &&
      ! -L "${REFUNDDESK_CONTROL_PLANE_LINK}" ]]; then
      return 0
    fi
    [[ -L "${REFUNDDESK_CONTROL_PLANE_LINK}" ]] ||
      die "control-plane generation pointer has an unsafe type"
    control_plane_root="$(
      readlink --canonicalize-existing -- "${REFUNDDESK_CONTROL_PLANE_LINK}"
    )" || die "control-plane generation cannot be resolved"
    [[ "${expected_value}" == "${REFUNDDESK_CONTROL_PLANE_LINK}/"* ]] ||
      die "stable control-plane target does not use the generation pointer"
    relative_path="${expected_value#"${REFUNDDESK_CONTROL_PLANE_LINK}/"}"
    assert_root_control_file "${control_plane_root}/${relative_path}"
    cmp --silent "${path}" "${control_plane_root}/${relative_path}" ||
      die "legacy control-plane entry differs from the migration generation: ${path}"
    return 0
  fi
  assert_root_control_symlink "${path}" "${expected_value}"
}

refunddesk_compose() {
  local -a command=(docker compose --project-name "${REFUNDDESK_COMPOSE_PROJECT}")

  assert_regular_file "${REFUNDDESK_COMPOSE_FILE}"
  if [[ -f "${REFUNDDESK_RELEASE_ENV}" ]]; then
    assert_root_secret_file "${REFUNDDESK_RELEASE_ENV}"
    command+=(--env-file "${REFUNDDESK_RELEASE_ENV}")
  fi
  command+=(--file "${REFUNDDESK_COMPOSE_FILE}")
  "${command[@]}" "$@"
}

service_container_id() {
  local service="$1"
  refunddesk_compose ps --all --quiet "${service}" | head -n 1
}

service_is_running() {
  local container_id
  container_id="$(service_container_id "$1")"
  [[ -n "${container_id}" ]] &&
    [[ "$(docker inspect --format='{{.State.Running}}' "${container_id}")" == "true" ]]
}

wait_for_container_health() {
  local service="$1"
  local timeout_seconds="${2:-120}"
  local deadline container_id state health

  deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    container_id="$(service_container_id "${service}")"
    if [[ -n "${container_id}" ]]; then
      state="$(docker inspect --format='{{.State.Status}}' "${container_id}")"
      health="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_id}")"
      if [[ "${state}" == "running" && ( "${health}" == "healthy" || "${health}" == "none" ) ]]; then
        return 0
      fi
      if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
        return 1
      fi
    fi
    sleep 2
  done
  return 1
}

assert_postgres_root_mount_contract() {
  local container_id ids_output inspection resolved_pgdata
  local -a postgres_ids

  resolved_pgdata="$(readlink --canonicalize-existing -- "${REFUNDDESK_POSTGRES_HOST_PGDATA}")" ||
    die "host PostgreSQL data directory cannot be resolved"
  [[ "${resolved_pgdata}" == "${REFUNDDESK_POSTGRES_HOST_PGDATA}" ]] ||
    die "host PostgreSQL data directory is not canonical"
  ids_output="$(
    docker container ls --all --quiet \
      --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
      --filter "label=com.docker.compose.service=postgres"
  )" || die "PostgreSQL container inventory is unavailable"
  postgres_ids=()
  if [[ -n "${ids_output}" ]]; then
    mapfile -t postgres_ids <<<"${ids_output}"
  fi
  (( ${#postgres_ids[@]} == 1 )) ||
    die "exactly one project PostgreSQL container is required"
  container_id="${postgres_ids[0]}"
  inspection="$(docker inspect "${container_id}")" ||
    die "PostgreSQL storage contract cannot be inspected"
  jq --exit-status \
    --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
    --arg source "${resolved_pgdata}" \
    --arg target "${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}" '
      length == 1
      and .[0].Config.Labels["com.docker.compose.project"] == $project
      and .[0].Config.Labels["com.docker.compose.service"] == "postgres"
      and .[0].State.Running == true
      and ([.[0].Config.Env[]? | select(startswith("PGDATA="))] == [("PGDATA=" + $target)])
      and ([.[0].Mounts[] |
        select(.Type == "bind" and .Source == $source and .Destination == $target)] | length == 1)
      and ([.[0].Mounts[] | select(.Destination == ($target + "/data"))] | length == 0)
      and all(.[0].Mounts[]?; .Type != "volume")
    ' <<<"${inspection}" >/dev/null ||
    die "PostgreSQL does not use the exact root bind mount without Docker volumes"
}

acquire_operator_lock() {
  local lock_device_inode lock_directory lock_mode lock_owner descriptor_device_inode

  require_command flock
  require_command install
  require_command readlink
  require_command stat
  lock_directory="$(dirname -- "${REFUNDDESK_OPERATOR_LOCK}")"
  [[ "${lock_directory}" == /* && "${lock_directory}" != "/" ]] ||
    die "operator lock directory is unsafe"
  if [[ ! -e "${lock_directory}" && ! -L "${lock_directory}" ]]; then
    install -d -o root -g root -m 0700 "${lock_directory}"
  fi
  [[ -d "${lock_directory}" && ! -L "${lock_directory}" ]] ||
    die "operator lock directory must be a non-symlink directory"
  [[ "$(readlink --canonicalize-existing -- "${lock_directory}")" == "${lock_directory}" ]] ||
    die "operator lock directory must be canonical"
  lock_owner="$(stat --format='%u:%g' -- "${lock_directory}")"
  lock_mode="$(stat --format='%a' -- "${lock_directory}")"
  [[ "${lock_owner}" == "0:0" && "${lock_mode}" == "700" ]] ||
    die "operator lock directory must be root-owned mode 0700"

  if [[ -e "${REFUNDDESK_OPERATOR_LOCK}" || -L "${REFUNDDESK_OPERATOR_LOCK}" ]]; then
    [[ -f "${REFUNDDESK_OPERATOR_LOCK}" && ! -L "${REFUNDDESK_OPERATOR_LOCK}" ]] ||
      die "operator lock must be a regular non-symlink file"
  else
    (
      set -o noclobber
      : >"${REFUNDDESK_OPERATOR_LOCK}"
    ) 2>/dev/null || die "operator lock could not be created safely"
  fi
  [[ "$(stat --format='%u:%g:%a' -- "${REFUNDDESK_OPERATOR_LOCK}")" == "0:0:600" ]] ||
    die "operator lock file must be root-owned mode 0600"
  exec 9<>"${REFUNDDESK_OPERATOR_LOCK}"
  lock_device_inode="$(stat --format='%d:%i' -- "${REFUNDDESK_OPERATOR_LOCK}")"
  descriptor_device_inode="$(stat --dereference --format='%d:%i' -- "/proc/self/fd/9")"
  [[ "${descriptor_device_inode}" == "${lock_device_inode}" ]] ||
    die "operator lock descriptor changed during secure open"
  flock --exclusive --timeout 30 9 || die "another RefundDesk operator action holds the lock"
}

clear_database_owner_job_reservation() {
  local container_id ids_output inspection service
  local -a job_ids

  for service in bootstrap migrate maintenance database-owner-reservation; do
    ids_output="$(
      docker container ls --all --quiet \
        --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
        --filter "label=com.docker.compose.service=${service}"
    )" || die "database-owner job inventory is unavailable"
    job_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t job_ids <<<"${ids_output}"
    fi
    for container_id in "${job_ids[@]}"; do
      [[ -n "${container_id}" ]] || continue
      inspection="$(docker inspect "${container_id}")" ||
        die "database-owner job reservation cannot be inspected"
      jq --exit-status \
        --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
        --arg service "${service}" '
          length == 1
          and .[0].Config.Labels["com.docker.compose.project"] == $project
          and .[0].Config.Labels["com.docker.compose.service"] == $service
          and .[0].HostConfig.RestartPolicy.Name == "no"
          and .[0].State.Running == false
          and (
            $service == "database-owner-reservation"
            or (
              .[0].State.ExitCode == 0
              and (.[0].State.Error // "") == ""
            )
          )
        ' <<<"${inspection}" >/dev/null ||
        die "database-owner job is active or outside the removable reservation contract"
      if [[ "${service}" == "database-owner-reservation" ]]; then
        jq --exit-status '
          .[0].Config.Labels["com.refunddesk.database-owner-reservation"] == "true"
          and .[0].HostConfig.NetworkMode == "none"
          and .[0].HostConfig.ReadonlyRootfs == true
          and .[0].HostConfig.Tmpfs
            == {"/var/lib/postgresql":"rw,nosuid,nodev,noexec,size=65536"}
          and all(.[0].Mounts[]?; .Type != "volume")
          and all(.[0].Config.Env[]?;
            (split("=")[0] | test("(PASSWORD|SECRET|TOKEN|DATABASE_URL|HMAC_KEY|ENCRYPTION_KEY)") | not))
        ' <<<"${inspection}" >/dev/null ||
          die "database-owner sentinel reservation is not harmless"
      fi
      docker rm --volumes "${container_id}" >/dev/null ||
        die "stopped database-owner job reservation could not be removed"
    done
  done
}

seal_database_owner_job_reservation() {
  local expected_service="$1"
  local expected_revision="$2"
  local completed_name container_id ids_output inspection
  local -a reservation_ids

  ids_output="$(
    docker container ls --all --quiet \
      --filter "name=^/${REFUNDDESK_DATABASE_OWNER_JOB_NAME}$"
  )" || die "database-owner reservation inventory is unavailable"
  reservation_ids=()
  if [[ -n "${ids_output}" ]]; then
    mapfile -t reservation_ids <<<"${ids_output}"
  fi
  (( ${#reservation_ids[@]} == 1 )) ||
    die "database-owner job did not leave exactly one deterministic reservation"
  container_id="${reservation_ids[0]}"
  inspection="$(docker inspect "${container_id}")" ||
    die "completed database-owner job cannot be inspected"
  jq --exit-status \
    --arg name "/${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" \
    --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
    --arg revision "${expected_revision}" \
    --arg service "${expected_service}" '
      length == 1
      and .[0].Name == $name
      and .[0].Config.Labels["com.docker.compose.project"] == $project
      and .[0].Config.Labels["com.docker.compose.service"] == $service
      and .[0].Config.Labels["com.refunddesk.revision"] == $revision
      and .[0].HostConfig.RestartPolicy.Name == "no"
      and .[0].State.Running == false
      and .[0].State.ExitCode == 0
      and (.[0].State.Error // "") == ""
    ' <<<"${inspection}" >/dev/null ||
    die "completed database-owner job is outside the exact stopped contract"

  completed_name="refunddesk-database-owner-completed-$$-${RANDOM}"
  docker rename "${container_id}" "${completed_name}" ||
    die "completed database-owner job could not release the global name"
  create_database_owner_job_reservation "${expected_revision}"
  docker rm --volumes "${completed_name}" >/dev/null ||
    die "secret-bearing completed database-owner job could not be destroyed"
  assert_database_owner_job_reservation "${expected_revision}"
}

create_database_owner_job_reservation() {
  local expected_revision="$1"
  local existing_ids reservation_id

  [[ "${expected_revision}" =~ ^[0-9a-f]{40}$ ]] ||
    die "database-owner reservation revision is invalid"
  existing_ids="$(
    docker container ls --all --quiet \
      --filter "name=^/${REFUNDDESK_DATABASE_OWNER_JOB_NAME}$"
  )" || die "database-owner reservation inventory is unavailable"
  [[ -z "${existing_ids}" ]] ||
    die "database-owner global name must be free before reservation"
  reservation_id="$(
    docker create \
      --pull=never \
      --name "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" \
      --label "com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
      --label "com.docker.compose.service=database-owner-reservation" \
      --label "com.refunddesk.revision=${expected_revision}" \
      --label "com.refunddesk.database-owner-reservation=true" \
      --network none \
      --read-only \
      --restart=no \
      --cap-drop ALL \
      --security-opt no-new-privileges:true \
      --pids-limit 8 \
      --memory 16m \
      --tmpfs /var/lib/postgresql:rw,nosuid,nodev,noexec,size=65536 \
      --entrypoint /bin/true \
      postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296
  )" || die "harmless database-owner name reservation could not be created"
  [[ -n "${reservation_id}" ]] ||
    die "Docker returned no harmless database-owner reservation ID"
}

recover_retention_database_owner_job() {
  local expected_revision="$1"
  local expected_image_id="$2"
  local container_id ids_output inspection running
  local -a maintenance_ids

  [[ "${expected_revision}" =~ ^[0-9a-f]{40}$ ]] ||
    die "retention recovery revision is invalid"
  [[ "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    die "retention recovery image ID is invalid"
  ids_output="$(
    docker container ls --all --quiet \
      --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
      --filter "label=com.docker.compose.service=maintenance"
  )" || die "retention recovery job inventory is unavailable"
  maintenance_ids=()
  if [[ -n "${ids_output}" ]]; then
    mapfile -t maintenance_ids <<<"${ids_output}"
  fi
  (( ${#maintenance_ids[@]} <= 1 )) ||
    die "multiple retention maintenance jobs exist during recovery"
  for container_id in "${maintenance_ids[@]}"; do
    [[ -n "${container_id}" ]] || continue
    inspection="$(docker inspect "${container_id}")" ||
      die "retention recovery job cannot be inspected"
    jq --exit-status \
      --arg id "${expected_image_id}" \
      --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
      --arg reference "refunddesk-migrate:sandbox-${expected_revision}" \
      --arg revision "${expected_revision}" '
        length == 1
        and (
          .[0].Name == "/refunddesk-database-owner-job"
          or (
            .[0].Name
            | test("^/refunddesk-database-owner-completed-[1-9][0-9]*-[0-9]+$")
          )
        )
        and .[0].Image == $id
        and .[0].Config.Image == $reference
        and .[0].Config.User == "1000:1000"
        and .[0].Config.Labels["com.docker.compose.project"] == $project
        and .[0].Config.Labels["com.docker.compose.service"] == "maintenance"
        and .[0].Config.Labels["com.refunddesk.revision"] == $revision
        and .[0].HostConfig.RestartPolicy.Name == "no"
        and .[0].HostConfig.ReadonlyRootfs == true
        and all(.[0].Mounts[]?; .Type == "bind")
      ' <<<"${inspection}" >/dev/null ||
      die "retention recovery refuses an unexpected maintenance container"
    running="$(docker_running_state_from_inspection "${inspection}")" ||
      die "retention recovery job running state is invalid"
    if [[ "${running}" == "true" ]]; then
      docker stop --time 35 "${container_id}" >/dev/null ||
        die "active retention maintenance job could not be stopped"
    fi
    docker rm --volumes "${container_id}" >/dev/null ||
      die "retention maintenance job could not be destroyed during recovery"
  done

  clear_database_owner_job_reservation
  create_database_owner_job_reservation "${expected_revision}"
  assert_database_owner_job_reservation "${expected_revision}"
}

assert_database_owner_job_reservation() {
  local expected_revision="$1"
  local container_id ids_output inspection service
  local -a job_ids reservation_ids

  ids_output="$(
    docker container ls --all --quiet \
      --filter "name=^/${REFUNDDESK_DATABASE_OWNER_JOB_NAME}$"
  )" || die "database-owner reservation inventory is unavailable"
  reservation_ids=()
  if [[ -n "${ids_output}" ]]; then
    mapfile -t reservation_ids <<<"${ids_output}"
  fi
  (( ${#reservation_ids[@]} == 1 )) ||
    die "database-owner sentinel did not reserve the global Docker name"
  container_id="${reservation_ids[0]}"
  inspection="$(docker inspect "${container_id}")" ||
    die "database-owner sentinel cannot be inspected"
  jq --exit-status \
    --arg name "/${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" \
    --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
    --arg revision "${expected_revision}" '
      length == 1
      and .[0].Name == $name
      and .[0].Config.Labels["com.docker.compose.project"] == $project
      and .[0].Config.Labels["com.docker.compose.service"]
        == "database-owner-reservation"
      and .[0].Config.Labels["com.refunddesk.revision"] == $revision
      and .[0].Config.Labels["com.refunddesk.database-owner-reservation"] == "true"
      and .[0].HostConfig.RestartPolicy.Name == "no"
      and .[0].HostConfig.NetworkMode == "none"
      and .[0].HostConfig.ReadonlyRootfs == true
      and .[0].State.Running == false
      and .[0].State.Status == "created"
      and .[0].HostConfig.Tmpfs
        == {"/var/lib/postgresql":"rw,nosuid,nodev,noexec,size=65536"}
      and all(.[0].Mounts[]?; .Type != "volume")
      and all(.[0].Config.Env[]?;
        (split("=")[0] | test("(PASSWORD|SECRET|TOKEN|DATABASE_URL|HMAC_KEY|ENCRYPTION_KEY)") | not))
    ' <<<"${inspection}" >/dev/null ||
    die "database-owner sentinel is outside the harmless stopped contract"

  for service in bootstrap migrate maintenance database-owner-reservation; do
    ids_output="$(
      docker container ls --all --quiet \
        --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
        --filter "label=com.docker.compose.service=${service}"
    )" || die "database-owner job inventory is unavailable"
    job_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t job_ids <<<"${ids_output}"
    fi
    for job_id in "${job_ids[@]}"; do
      [[ "${job_id}" == "${container_id}" ]] ||
        die "an extra database-owner one-shot exists outside the global reservation"
    done
  done
}
