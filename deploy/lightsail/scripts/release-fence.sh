#!/usr/bin/env bash

# Stable host-side monitor for an in-progress release. The release itself runs
# in a transient systemd service with KillMode=control-group. This independent
# unit watches the exact main PID plus Linux starttime and continuously fences
# any late candidate container while the durable transition journal remains.

set -Eeuo pipefail
umask 077

readonly REFUNDDESK_ROOT="${REFUNDDESK_ROOT:-/opt/refunddesk}"
readonly REFUNDDESK_CONFIG_ROOT="${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}"
readonly STABLE_FENCE_PATH="/usr/local/sbin/refunddesk-release-fence"
readonly CONTROL_PLANE_LINK="${REFUNDDESK_ROOT}/control-plane-current"
readonly EXPECTED_FENCE_LINK="${CONTROL_PLANE_LINK}/scripts/release-fence.sh"
readonly TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
readonly TRANSITION_JOURNAL_LOCK="${REFUNDDESK_CONFIG_ROOT}/application-key-transition.lock"
readonly COMPOSE_PROJECT="refunddesk"

RELEASE_PID=""
RELEASE_STARTTIME=""
RELEASE_UNIT=""
REVISION=""
READY_FILE=""
ADMISSION_FILE=""

log() {
  printf '%s %s\n' "$(date --utc '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

control_file_is_root_owned() {
  local path="$1"
  local mode owner

  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  owner="$(stat --format='%u' -- "${path}")" || return 1
  mode="$(stat --format='%a' -- "${path}")" || return 1
  [[ "${owner}" == "0" ]] || return 1
  (( (8#${mode} & 022) == 0 ))
}

secret_file_is_root_owned() {
  local path="$1"
  local mode

  control_file_is_root_owned "${path}" || return 1
  mode="$(stat --format='%a' -- "${path}")" || return 1
  (( (8#${mode} & 077) == 0 ))
}

stable_self_is_root_owned() {
  local control_plane_root resolved_self

  [[ "$0" == "${STABLE_FENCE_PATH}" ]] || return 1
  if [[ -f "${STABLE_FENCE_PATH}" && ! -L "${STABLE_FENCE_PATH}" ]]; then
    control_file_is_root_owned "${STABLE_FENCE_PATH}" || return 1
    if [[ ! -e "${CONTROL_PLANE_LINK}" && ! -L "${CONTROL_PLANE_LINK}" ]]; then
      return 0
    fi
    control_plane_root="$(readlink --canonicalize-existing -- "${CONTROL_PLANE_LINK}")" ||
      return 1
    cmp --silent \
      "${STABLE_FENCE_PATH}" "${control_plane_root}/scripts/release-fence.sh" ||
      return 1
    return 0
  fi
  [[ -L "${STABLE_FENCE_PATH}" ]] || return 1
  [[ "$(stat --format='%u' -- "${STABLE_FENCE_PATH}")" == "0" ]] || return 1
  [[ "$(readlink -- "${STABLE_FENCE_PATH}")" == "${EXPECTED_FENCE_LINK}" ]] || return 1
  [[ -L "${CONTROL_PLANE_LINK}" ]] || return 1
  [[ "$(stat --format='%u' -- "${CONTROL_PLANE_LINK}")" == "0" ]] || return 1
  control_plane_root="$(readlink --canonicalize-existing -- "${CONTROL_PLANE_LINK}")" ||
    return 1
  case "${control_plane_root}" in
    "${REFUNDDESK_ROOT}"/releases/*/source/deploy/lightsail | \
      "${REFUNDDESK_ROOT}"/control-plane-generations/*)
      ;;
    *)
      return 1
      ;;
  esac
  resolved_self="$(readlink --canonicalize-existing -- "${STABLE_FENCE_PATH}")" ||
    return 1
  [[ "${resolved_self}" == "${control_plane_root}/scripts/release-fence.sh" ]] ||
    return 1
  control_file_is_root_owned "${resolved_self}"
}

usage() {
  printf '%s\n' \
    "Usage: ${STABLE_FENCE_PATH} --release-pid PID --release-starttime TICKS --release-unit UNIT --revision FULL_SHA --ready-file /run/FILE --admission-file /run/FILE"
}

release_pid_count=0
release_starttime_count=0
release_unit_count=0
revision_count=0
ready_file_count=0
admission_file_count=0
while (( $# > 0 )); do
  case "$1" in
    --release-pid)
      (( $# >= 2 )) || die "--release-pid requires a value"
      RELEASE_PID="$2"
      release_pid_count=$((release_pid_count + 1))
      shift 2
      ;;
    --release-starttime)
      (( $# >= 2 )) || die "--release-starttime requires a value"
      RELEASE_STARTTIME="$2"
      release_starttime_count=$((release_starttime_count + 1))
      shift 2
      ;;
    --release-unit)
      (( $# >= 2 )) || die "--release-unit requires a value"
      RELEASE_UNIT="$2"
      release_unit_count=$((release_unit_count + 1))
      shift 2
      ;;
    --revision)
      (( $# >= 2 )) || die "--revision requires a value"
      REVISION="$2"
      revision_count=$((revision_count + 1))
      shift 2
      ;;
    --ready-file)
      (( $# >= 2 )) || die "--ready-file requires a value"
      READY_FILE="$2"
      ready_file_count=$((ready_file_count + 1))
      shift 2
      ;;
    --admission-file)
      (( $# >= 2 )) || die "--admission-file requires a value"
      ADMISSION_FILE="$2"
      admission_file_count=$((admission_file_count + 1))
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

[[ "${EUID}" -eq 0 ]] || die "this command must run as root"
(( release_pid_count == 1 )) || die "exactly one --release-pid is required"
(( release_starttime_count == 1 )) ||
  die "exactly one --release-starttime is required"
(( release_unit_count == 1 )) || die "exactly one --release-unit is required"
(( revision_count == 1 )) || die "exactly one --revision is required"
(( ready_file_count == 1 )) || die "exactly one --ready-file is required"
(( admission_file_count == 1 )) || die "exactly one --admission-file is required"
[[ "${RELEASE_PID}" =~ ^[1-9][0-9]*$ ]] || die "release PID is invalid"
[[ "${RELEASE_STARTTIME}" =~ ^[1-9][0-9]*$ ]] ||
  die "release process start time is invalid"
[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || die "release revision is invalid"
[[ "${RELEASE_UNIT}" =~ ^refunddesk-release-${REVISION:0:12}-[1-9][0-9]*\.service$ ]] ||
  die "release systemd unit does not bind the exact revision and PID"
[[ "${READY_FILE}" == "/run/refunddesk-release-fence-${REVISION:0:12}-${RELEASE_PID}.ready" ]] ||
  die "release fence readiness path does not bind the exact revision and PID"
expected_admission_file="/run/refunddesk-release-candidate-${REVISION:0:12}-${RELEASE_PID}.admit"
[[ "${ADMISSION_FILE}" == "${expected_admission_file}" ]] ||
  die "candidate admission path does not bind the exact revision and PID"
for command in cmp docker flock jq readlink sleep stat systemctl; do
  command -v "${command}" >/dev/null 2>&1 ||
    die "required command is unavailable: ${command}"
done

stable_self_is_root_owned ||
  die "stable release fence is not root-controlled"
if [[ ! -e "${TRANSITION_JOURNAL_LOCK}" && ! -L "${TRANSITION_JOURNAL_LOCK}" ]]; then
  (
    set -o noclobber
    : >"${TRANSITION_JOURNAL_LOCK}"
  ) 2>/dev/null || true
fi
secret_file_is_root_owned "${TRANSITION_JOURNAL_LOCK}" ||
  die "release transition coordination lock is not root-controlled"
[[ "$(stat --format='%u:%g:%a' -- "${TRANSITION_JOURNAL_LOCK}")" == "0:0:600" ]] ||
  die "release transition coordination lock metadata is unsafe"
exec 8<>"${TRANSITION_JOURNAL_LOCK}"
[[ "$(stat --format='%d:%i' -- "${TRANSITION_JOURNAL_LOCK}")" == \
  "$(stat --dereference --format='%d:%i' -- /proc/self/fd/8)" ]] ||
  die "release transition coordination lock changed during secure open"

journal_matches_revision() {
  secret_file_is_root_owned "${TRANSITION_JOURNAL}" || return 1
  jq --exit-status --arg revision "${REVISION}" '
    def fingerprint:
      . == null
      or (type == "string" and test("^sha256:[0-9a-f]{64}$"));
    def fingerprints:
      type == "object"
      and keys == ["approvalAttestation","field","proof"]
      and all(.[];
        type == "object"
        and keys == ["v1","v2"]
        and all(.[]; fingerprint));
    def states:
      type == "object"
      and keys == ["approvalAttestation","field","proof"]
      and all(.[];
        . == null
        or (. == "legacy" or . == "staged" or . == "active"
          or . == "rollback" or . == "retired"));
    def side:
      type == "object"
      and keys == ["fingerprints","recorded","revision","states"]
      and (.recorded | type == "boolean")
      and (.revision == null
        or (.revision | type == "string" and test("^[0-9a-f]{40}$")))
      and (.fingerprints | fingerprints)
      and (.states | states);
    type == "object"
    and keys == ["from","schemaVersion","status","to"]
    and .schemaVersion == 1
    and .status == "in_progress"
    and (.from | side)
    and (.to | side)
    and .to.recorded == true
    and .to.revision == $revision
  ' "${TRANSITION_JOURNAL}" >/dev/null 2>&1
}

observed_process_starttime() {
  local process_stat process_suffix
  local -a process_fields

  [[ -r "/proc/${RELEASE_PID}/stat" ]] || return 1
  IFS= read -r process_stat <"/proc/${RELEASE_PID}/stat" || return 1
  process_suffix="${process_stat##*) }"
  read -r -a process_fields <<<"${process_suffix}"
  (( ${#process_fields[@]} >= 20 )) || return 1
  [[ "${process_fields[19]}" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "${process_fields[19]}"
}

candidate_container_ids() {
  local service="$1"
  local output
  local -a filters

  filters=(
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}"
    --filter "label=com.docker.compose.service=${service}"
  )
  output="$(docker container ls --all --quiet "${filters[@]}")" || return 1
  if [[ -n "${output}" ]]; then
    printf '%s\n' "${output}"
  fi
}

container_is_fenced() {
  local container_id="$1"
  local service="$2"
  local inspection

  inspection="$(docker inspect "${container_id}")" || return 1
  jq --exit-status \
    --arg project "${COMPOSE_PROJECT}" \
    --arg service "${service}" '
      length == 1
      and .[0].Config.Labels["com.docker.compose.project"] == $project
      and .[0].Config.Labels["com.docker.compose.service"] == $service
      and .[0].HostConfig.RestartPolicy.Name == "no"
      and .[0].State.Running == false
    ' <<<"${inspection}" >/dev/null
}

fence_candidates_once() {
  local container_id ids_output inspection running service
  local all_fenced=true
  local -a candidate_ids

  for service in \
    caddy web verifier worker \
    bootstrap migrate maintenance database-owner-reservation; do
    if ! ids_output="$(candidate_container_ids "${service}")"; then
      log "Docker is unavailable while enumerating candidate ${service} containers"
      return 1
    fi
    candidate_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t candidate_ids <<<"${ids_output}"
    fi
    for container_id in "${candidate_ids[@]}"; do
      [[ -n "${container_id}" ]] || continue
      if ! docker update --restart=no "${container_id}" >/dev/null 2>&1; then
        all_fenced=false
        continue
      fi
      inspection="$(docker inspect "${container_id}" 2>/dev/null)" || {
        all_fenced=false
        continue
      }
      running="$(jq --exit-status --raw-output '.[0].State.Running' <<<"${inspection}")" || {
        all_fenced=false
        continue
      }
      if [[ "${running}" == "true" ]] &&
        ! docker stop --time 45 "${container_id}" >/dev/null 2>&1; then
        docker kill "${container_id}" >/dev/null 2>&1 || all_fenced=false
      fi
    done
  done

  for service in \
    caddy web verifier worker \
    bootstrap migrate maintenance database-owner-reservation; do
    if ! ids_output="$(candidate_container_ids "${service}")"; then
      log "Docker is unavailable while verifying candidate ${service} containers"
      return 1
    fi
    candidate_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t candidate_ids <<<"${ids_output}"
    fi
    for container_id in "${candidate_ids[@]}"; do
      [[ -n "${container_id}" ]] || continue
      if container_is_fenced "${container_id}" "${service}"; then
        if [[ "${service}" == "bootstrap" ||
          "${service}" == "migrate" ||
          "${service}" == "maintenance" ]]; then
          docker rm --volumes "${container_id}" >/dev/null 2>&1 || all_fenced=false
        fi
      else
        all_fenced=false
      fi
    done
  done
  [[ "${all_fenced}" == "true" ]]
}

candidate_admission_is_valid() {
  local -a admission_lines

  secret_file_is_root_owned "${ADMISSION_FILE}" || return 1
  mapfile -t admission_lines <"${ADMISSION_FILE}" || return 1
  (( ${#admission_lines[@]} == 1 )) &&
    [[ "${admission_lines[0]}" == "revision=${REVISION}" ]]
}

enforce_runtime_admission_once() {
  local admitted=false container_id ids_output inspection observed_revision observed_running service
  local -a candidate_ids

  if [[ -e "${ADMISSION_FILE}" || -L "${ADMISSION_FILE}" ]]; then
    candidate_admission_is_valid || return 1
    admitted=true
  fi

  for service in caddy web verifier worker; do
    ids_output="$(candidate_container_ids "${service}")" || return 1
    candidate_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t candidate_ids <<<"${ids_output}"
    fi
    for container_id in "${candidate_ids[@]}"; do
      [[ -n "${container_id}" ]] || continue
      inspection="$(docker inspect "${container_id}")" || return 1
      observed_revision="$(
        jq --exit-status --raw-output \
          --arg project "${COMPOSE_PROJECT}" \
          --arg service "${service}" '
            select(
              length == 1
              and .[0].Config.Labels["com.docker.compose.project"] == $project
              and .[0].Config.Labels["com.docker.compose.service"] == $service
            )
            | .[0].Config.Labels["com.refunddesk.revision"] // "unversioned"
          ' <<<"${inspection}"
      )" || return 1
      observed_running="$(jq --exit-status --raw-output '.[0].State.Running' <<<"${inspection}")" ||
        return 1
      docker update --restart=no "${container_id}" >/dev/null 2>&1 || return 1
      if [[ "${admitted}" != "true" || "${observed_revision}" != "${REVISION}" ]]; then
        if [[ "${observed_running}" == "true" ]]; then
          docker stop --time 45 "${container_id}" >/dev/null 2>&1 ||
            docker kill "${container_id}" >/dev/null 2>&1 ||
            return 1
        fi
        container_is_fenced "${container_id}" "${service}" || return 1
      fi
    done
  done
}

remove_runtime_markers() {
  rm -f -- "${READY_FILE}" "${ADMISSION_FILE}"
}

stop_requested() {
  trap - EXIT HUP INT TERM
  log "release fence replacement requested; applying one final fence pass"
  fence_candidates_once || true
  remove_runtime_markers
  exit 0
}

trap remove_runtime_markers EXIT
trap stop_requested HUP INT TERM

enter_emergency_fence() {
  local reason="$1"

  log "${reason}; killing the release cgroup and persistently fencing candidates"
  systemctl kill --kill-whom=all --signal=KILL "${RELEASE_UNIT}" >/dev/null 2>&1 || true
  flock --unlock 8
  while [[ -e "${TRANSITION_JOURNAL}" || -L "${TRANSITION_JOURNAL}" ]]; do
    if ! fence_candidates_once; then
      log "candidate fence pass failed; retrying while the journal remains open"
    fi
    sleep 1
  done
  log "transition journal was closed after emergency fencing"
  exit 0
}

flock --exclusive 8
if [[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]]; then
  flock --unlock 8
  log "release transition journal is absent; release fence is already disarmed"
  remove_runtime_markers
  exit 0
fi
if ! journal_matches_revision; then
  enter_emergency_fence "release transition journal is invalid or divergent before arming"
fi
if ! observed_starttime="$(observed_process_starttime)"; then
  enter_emergency_fence "release process disappeared before the fence was armed"
fi
if [[ "${observed_starttime}" != "${RELEASE_STARTTIME}" ]]; then
  enter_emergency_fence "release process identity changed before the fence was armed"
fi
if ! enforce_runtime_admission_once; then
  enter_emergency_fence "candidate runtime admission could not be enforced before arming"
fi

ready_tmp="${READY_FILE}.$$"
rm -f -- "${ready_tmp}"
printf 'revision=%s\npid=%s\nstarttime=%s\nunit=%s\nadmission=%s\n' \
  "${REVISION}" "${RELEASE_PID}" "${RELEASE_STARTTIME}" "${RELEASE_UNIT}" \
  "${ADMISSION_FILE}" >"${ready_tmp}"
chown root:root "${ready_tmp}"
chmod 0600 "${ready_tmp}"
mv --force --no-target-directory -- "${ready_tmp}" "${READY_FILE}"
flock --unlock 8

while true; do
  flock --exclusive 8
  if [[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]]; then
    flock --unlock 8
    break
  fi
  if ! journal_matches_revision; then
    enter_emergency_fence "release transition journal became invalid or divergent"
  fi
  if ! observed_starttime="$(observed_process_starttime)" ||
    [[ "${observed_starttime}" != "${RELEASE_STARTTIME}" ]]; then
    enter_emergency_fence "release process identity disappeared"
  fi
  if ! enforce_runtime_admission_once; then
    enter_emergency_fence "candidate runtime admission could not be enforced"
  fi
  flock --unlock 8
  sleep 1
done

log "release transition journal closed; release fence disarmed"
