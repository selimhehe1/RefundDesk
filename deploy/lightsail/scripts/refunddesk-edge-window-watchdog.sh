#!/usr/bin/env bash

# Durable ADR 0037 host-side deadline fence. The local orchestrator owns the
# AWS firewall; this watchdog independently guarantees that host listeners and
# financial workers cannot outlive the bounded edge window.

set -uo pipefail
set +x
set +a
umask 077
export LC_ALL=C
export PATH=/usr/bin:/bin

readonly EXIT_FAIL=20
readonly EXIT_INCOMPLETE=21
readonly EXIT_USAGE=64
readonly DEADLINE_CONTAINMENT_GUARD_MILLISECONDS=25000
readonly DEADLINE_HARD_FENCE_WORST_CASE_SECONDS=8
readonly DOCKER_BIN=/usr/bin/docker
readonly DOCKER_SOCKET=/run/docker.sock
readonly DOCKER_HOST_VALUE=unix:///run/docker.sock
(( DEADLINE_HARD_FENCE_WORST_CASE_SECONDS * 1000 < DEADLINE_CONTAINMENT_GUARD_MILLISECONDS )) ||
  exit "${EXIT_USAGE}"

FORCE=false
FORCE_NONCE=""
if (( $# == 2 )) && [[ "$1" == "--force" && "$2" =~ ^[0-9a-f]{64}$ ]]; then
  FORCE=true
  FORCE_NONCE="$2"
elif (( $# != 0 )); then
  exit "${EXIT_USAGE}"
fi
readonly FORCE FORCE_NONCE

exec 1>/dev/null 2>/dev/null

if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ]]; then
  (( EUID != 0 )) || exit "${EXIT_USAGE}"
  CONTROL_ROOT="${REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT:-}"
  RUNTIME_ROOT="${REFUNDDESK_EDGE_WINDOW_RUNTIME_ROOT:-}"
  COMMAND_ADAPTER="${REFUNDDESK_EDGE_WINDOW_COMMAND:-}"
  [[ "${CONTROL_ROOT}" == /tmp/refunddesk-edge-window-test-* &&
    "${RUNTIME_ROOT}" == /tmp/refunddesk-edge-window-test-* &&
    -x "${COMMAND_ADAPTER}" ]] || exit "${EXIT_USAGE}"
else
  [[ -z "${REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT:-}" &&
    -z "${REFUNDDESK_EDGE_WINDOW_RUNTIME_ROOT:-}" &&
    -z "${REFUNDDESK_EDGE_WINDOW_COMMAND:-}" &&
    -z "${REFUNDDESK_EDGE_WINDOW_TEST_LOCK_WAIT_SECONDS:-}" ]] || exit "${EXIT_USAGE}"
  (( EUID == 0 )) || exit "${EXIT_USAGE}"
  CONTROL_ROOT="/var/lib/refunddesk/control"
  RUNTIME_ROOT="/run/refunddesk"
  COMMAND_ADAPTER=""
fi
readonly CONTROL_ROOT RUNTIME_ROOT COMMAND_ADAPTER
readonly DOCKER_CONFIG_ROOT="${RUNTIME_ROOT}/edge-window-watchdog-docker-config"
LOCK_WAIT_SECONDS=55
if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
  -n "${REFUNDDESK_EDGE_WINDOW_TEST_LOCK_WAIT_SECONDS:-}" ]]; then
  [[ "${REFUNDDESK_EDGE_WINDOW_TEST_LOCK_WAIT_SECONDS}" =~ ^[1-5]$ ]] || exit "${EXIT_USAGE}"
  LOCK_WAIT_SECONDS="${REFUNDDESK_EDGE_WINDOW_TEST_LOCK_WAIT_SECONDS}"
fi
readonly LOCK_WAIT_SECONDS
readonly MARKER="${CONTROL_ROOT}/edge-window-watchdog.json"
readonly PREFLIGHT_RECEIPT="${CONTROL_ROOT}/edge-window-watchdog-preflight.json"
readonly LOCK="${RUNTIME_ROOT}/edge-window-watchdog.lock"
readonly RUNTIME_TRIGGER_SENTINEL="${RUNTIME_ROOT}/edge-window-watchdog-triggered"
readonly CONTROL_TRIGGER_SENTINEL="${CONTROL_ROOT}/edge-window-watchdog-triggered"
STOPPED_CONTAINER_COUNT=0
FENCED_CONTAINER_COUNT=0
STOPPED_UNIT_COUNT=0
DOCKER_API_FENCED=false
DOCKER_CLI_ENVIRONMENT_VALID=false

docker_cli_environment_valid() {
  local expected_uid expected_gid metadata entry
  [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" != "1" ]] || return 0
  [[ -x "${DOCKER_BIN}" && -f "${DOCKER_BIN}" && ! -L "${DOCKER_BIN}" ]] || return 1
  [[ -S "${DOCKER_SOCKET}" && ! -L "${DOCKER_SOCKET}" ]] || return 1
  [[ -d "${DOCKER_CONFIG_ROOT}" && ! -L "${DOCKER_CONFIG_ROOT}" ]] || return 1
  expected_uid=0
  expected_gid=0
  metadata="$(stat --format='%u:%g:%a:%h' -- "${DOCKER_CONFIG_ROOT}")" || return 1
  [[ "${metadata}" == "${expected_uid}:${expected_gid}:555:2" ]] || return 1
  entry="$(find "${DOCKER_CONFIG_ROOT}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" || return 1
  [[ -z "${entry}" ]]
}

docker_cli_bounded() {
  local duration="$1"
  shift
  [[ "${DOCKER_CLI_ENVIRONMENT_VALID}" == true ]] || return 1
  docker_cli_environment_valid || return 1
  timeout --signal=TERM --kill-after=1s "${duration}" \
    env -i PATH=/usr/bin:/bin HOME=/nonexistent LC_ALL=C \
    DOCKER_HOST="${DOCKER_HOST_VALUE}" DOCKER_CONFIG="${DOCKER_CONFIG_ROOT}" \
    "${DOCKER_BIN}" --host "${DOCKER_HOST_VALUE}" --config "${DOCKER_CONFIG_ROOT}" "$@"
}

record_fail_safe_trigger() {
  local path
  for path in "${RUNTIME_TRIGGER_SENTINEL}" "${CONTROL_TRIGGER_SENTINEL}"; do
    if [[ ! -e "${path}" && ! -L "${path}" ]]; then
      (set -o noclobber; umask 077; printf 'triggered\n' >"${path}") 2>/dev/null || true
    fi
    [[ -f "${path}" && ! -L "${path}" ]] && chmod 0600 "${path}" 2>/dev/null || true
    if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" && -n "${COMMAND_ADAPTER}" ]]; then
      timeout --signal=TERM --kill-after=1s 1s "${COMMAND_ADAPTER}" trigger-sync "${path}" >/dev/null 2>&1 || true
    elif command -v timeout >/dev/null 2>&1 && command -v sync >/dev/null 2>&1; then
      timeout --signal=TERM --kill-after=1s 1s sync "${path}" 2>/dev/null || true
    fi
  done
}

edge_command() {
  local operation="$1"
  shift
  if [[ "${DOCKER_API_FENCED}" == true ]]; then
    case "${operation}" in
      list-container|fence-containers|stop-containers|kill-containers|containers-state) return 1 ;;
    esac
  fi
  if [[ -n "${COMMAND_ADAPTER}" ]]; then
    case "${operation}" in
      disable-unit) timeout --signal=TERM --kill-after=1s 3s "${COMMAND_ADAPTER}" "${operation}" "$@" ;;
      stop-unit) timeout --signal=TERM --kill-after=1s 2s "${COMMAND_ADAPTER}" "${operation}" "$@" ;;
      stop-containers)
        timeout --signal=TERM --kill-after=1s 5s "${COMMAND_ADAPTER}" "${operation}" "$@" ||
          timeout --signal=TERM --kill-after=1s 2s "${COMMAND_ADAPTER}" kill-containers "$@"
        ;;
      kill-container-scope) timeout --signal=KILL 1s "${COMMAND_ADAPTER}" "${operation}" "$@" ;;
      stop-docker-socket) timeout --signal=KILL 1s "${COMMAND_ADAPTER}" "${operation}" ;;
      kill-all-container-scopes) timeout --signal=KILL 1s "${COMMAND_ADAPTER}" "${operation}" ;;
      kill-docker-daemon) timeout --signal=KILL 2s "${COMMAND_ADAPTER}" "${operation}" ;;
      public-listeners) timeout --signal=KILL 1s "${COMMAND_ADAPTER}" "${operation}" | head --bytes=1 ;;
      listener) timeout --signal=TERM --kill-after=1s 2s "${COMMAND_ADAPTER}" "${operation}" "$@" | head --bytes=1 ;;
      list-container) timeout --signal=TERM --kill-after=1s 2s "${COMMAND_ADAPTER}" "${operation}" "$@" | head --bytes=16385 ;;
      *) timeout --signal=TERM --kill-after=1s 2s "${COMMAND_ADAPTER}" "${operation}" "$@" ;;
    esac
    return
  fi
  case "${operation}" in
    now-epoch) date --utc '+%s' ;;
    boot-id) tr -d '\n' </proc/sys/kernel/random/boot_id ;;
    boottime-ms) awk '{printf "%.0f\n", $1 * 1000}' /proc/uptime ;;
    stop-unit)
      timeout --signal=TERM --kill-after=1s 2s systemctl stop -- "$1" || {
        timeout --signal=TERM --kill-after=1s 1s systemctl kill --kill-who=all --signal=KILL -- "$1" >/dev/null 2>&1 || true
        timeout --signal=TERM --kill-after=1s 1s systemctl stop -- "$1"
      }
      ;;
    disable-unit)
      timeout --signal=TERM --kill-after=1s 3s systemctl disable --now -- "$1" || {
        timeout --signal=TERM --kill-after=1s 1s systemctl kill --kill-who=all --signal=KILL -- "$1" >/dev/null 2>&1 || true
        timeout --signal=TERM --kill-after=1s 1s systemctl stop -- "$1" >/dev/null 2>&1 || true
        [[ "$(timeout --signal=TERM --kill-after=1s 1s systemctl is-enabled -- "$1" 2>/dev/null || true)" == disabled ]]
      }
      ;;
    unit-state) timeout --signal=TERM --kill-after=1s 1s systemctl show --property=ActiveState --value -- "$1" ;;
    unit-enabled) timeout --signal=TERM --kill-after=1s 1s systemctl is-enabled -- "$1" 2>/dev/null ;;
    unit-contract) return 64 ;;
    list-release-units)
      timeout --signal=TERM --kill-after=1s 2s systemctl list-units --type=service --all --no-legend --no-pager \
        'refunddesk-release-*.service' | awk '{print $1}' | head --bytes=16385
      ;;
    list-active-release-units)
      timeout --signal=TERM --kill-after=1s 2s systemctl list-units --type=service --all \
        --state=activating,active,reloading,deactivating,failed --no-legend --no-pager \
        'refunddesk-release-*.service' | awk '{print $1}' | head --bytes=16385
      ;;
    stop-release-surface)
      timeout --signal=TERM --kill-after=1s 12s systemctl stop 'refunddesk-release-*.service' || {
        timeout --signal=TERM --kill-after=1s 2s systemctl kill --kill-who=all --signal=KILL \
          'refunddesk-release-*.service' >/dev/null 2>&1 || true
        timeout --signal=TERM --kill-after=1s 3s systemctl stop 'refunddesk-release-*.service'
      }
      ;;
    list-container)
      docker_cli_bounded 2s container ls --all --quiet --no-trunc \
        --filter 'label=com.docker.compose.project=refunddesk' \
        --filter "label=com.docker.compose.service=$1" | head --bytes=16385
      ;;
    fence-containers) docker_cli_bounded 2s update --restart=no -- "$@" ;;
    stop-containers)
      docker_cli_bounded 5s stop --time 3 -- "$@" >/dev/null ||
        docker_cli_bounded 2s kill -- "$@" >/dev/null
      ;;
    kill-containers) docker_cli_bounded 2s kill -- "$@" >/dev/null ;;
    kill-container-scope)
      [[ "$1" =~ ^[0-9a-f]{64}$ ]] || return 64
      # Docker's systemd cgroup scope remains killable by PID 1 when dockerd
      # and /run/docker.sock are unavailable.  This is the independent public
      # listener fence bound to the exact pre-armed container identity.
      timeout --signal=KILL 1s systemctl kill --kill-who=all --signal=KILL -- "docker-$1.scope"
      ;;
    stop-docker-socket)
      # Mask the activation socket before touching dockerd or any container
      # scope. No later Docker API call is permitted in this invocation.
      timeout --signal=KILL 1s bash -seu -c '
        load_state="$(systemctl show --property=LoadState --value -- docker.socket 2>/dev/null)"
        if [[ "${load_state}" == not-found ]]; then exit 0; fi
        [[ "${load_state}" == loaded ]]
        systemctl mask --runtime --now -- docker.socket >/dev/null
        load_state="$(systemctl show --property=LoadState --value -- docker.socket)"
        socket_state="$(systemctl show --property=ActiveState --value -- docker.socket)"
        socket_enabled="$(systemctl is-enabled -- docker.socket 2>/dev/null || true)"
        [[ "${load_state}" == masked || "${load_state}" == loaded ]]
        [[ "${socket_state}" == inactive || "${socket_state}" == failed ]]
        [[ "${socket_enabled}" == masked || "${socket_enabled}" == masked-runtime ]]
      '
      ;;
    docker-socket-fenced)
      # Detect a broad fence left by an earlier runner/tick without touching
      # the Docker API. A later contained-state tick must not socket-activate
      # a new daemon merely to refresh its receipt.
      timeout --signal=TERM --kill-after=1s 2s bash -seu -c '
        socket_load="$(systemctl show --property=LoadState --value -- docker.socket 2>/dev/null)"
        service_load="$(systemctl show --property=LoadState --value -- docker.service 2>/dev/null)"
        service_state="$(systemctl show --property=ActiveState --value -- docker.service 2>/dev/null)"
        socket_safe=false
        service_safe=false
        if [[ "${socket_load}" == not-found ]]; then
          socket_safe=true
        elif [[ "${socket_load}" == masked || "${socket_load}" == loaded ]]; then
          socket_state="$(systemctl show --property=ActiveState --value -- docker.socket)"
          socket_enabled="$(systemctl is-enabled -- docker.socket 2>/dev/null || true)"
          if [[ "${socket_state}" == inactive || "${socket_state}" == failed ]] &&
            [[ "${socket_enabled}" == masked || "${socket_enabled}" == masked-runtime ]]; then
            socket_safe=true
          fi
        fi
        if [[ "${service_load}" == not-found ]] || {
          [[ "${service_load}" == loaded ]] &&
            [[ "${service_state}" == inactive || "${service_state}" == failed ]]
        }; then
          service_safe=true
        fi
        [[ "${socket_safe}" == true && "${service_safe}" == true ]]
        printf "true\n"
      '
      ;;
    kill-all-container-scopes)
      # If both durable identity documents are unavailable, availability is
      # already lost. Fence every loaded Docker scope in one bounded call
      # rather than trusting an unvalidated marker or an unbounded inventory.
      timeout --signal=KILL 1s systemctl kill --kill-who=all --signal=KILL -- 'docker-*.scope'
      ;;
    kill-docker-daemon)
      # docker-proxy processes live under docker.service rather than the
      # container scope. If the daemon API is unavailable, fence that entire
      # service cgroup as well so published host sockets cannot outlive Caddy.
      timeout --signal=KILL 2s bash -seu -c '
        systemctl kill --kill-who=all --signal=KILL -- docker.service >/dev/null 2>&1 || true
        systemctl stop -- docker.service >/dev/null 2>&1 || true
        docker_state="$(systemctl show --property=ActiveState --value -- docker.service)"
        [[ "${docker_state}" == inactive || "${docker_state}" == failed ]]
      '
      ;;
    public-listeners)
      # One process-group budget covers all four public sockets. Sequential
      # per-port timeouts cannot fit the deadline containment guard.
      timeout --signal=KILL 1s bash -o pipefail -c \
        '{ ss -H -ltn "( sport = :80 or sport = :443 )"; ss -H -lun "( sport = :80 or sport = :443 )"; } | head --bytes=1'
      ;;
    containers-state)
      docker_cli_bounded 2s inspect --format '{{.Id}}:{{.HostConfig.RestartPolicy.Name}}:{{.State.Running}}' -- "$@"
      ;;
    listener)
      local protocol="$1" port="$2"
      if [[ "${protocol}" == "tcp" ]]; then
        timeout --signal=TERM --kill-after=1s 2s ss -H -ltn "sport = :${port}" | head --bytes=1
      else
        timeout --signal=TERM --kill-after=1s 2s ss -H -lun "sport = :${port}" | head --bytes=1
      fi
      ;;
    *) return 64 ;;
  esac
}

effective_units_valid() {
  if [[ -n "${COMMAND_ADAPTER}" ]]; then
    edge_command unit-contract
    return
  fi
  local service=refunddesk-edge-window-watchdog.service
  local timer=refunddesk-edge-window-watchdog.timer
  local service_path=/etc/systemd/system/refunddesk-edge-window-watchdog.service
  local timer_path=/etc/systemd/system/refunddesk-edge-window-watchdog.timer
  local service_contract timer_contract exec_start
  service_contract="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --no-pager \
    --property=FragmentPath --property=DropInPaths --property=User --property=Group \
    --property=Type --property=NoNewPrivileges --property=ProtectSystem \
    --property=ProtectClock --property=ExecStart --property=Environment \
    --property=UnsetEnvironment --property=ExecSearchPath -- "${service}")" || return 1
  timer_contract="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --no-pager \
    --property=FragmentPath --property=DropInPaths --property=Unit --property=OnBootUSec \
    --property=OnUnitActiveUSec --property=AccuracyUSec --property=RandomizedDelayUSec \
    --property=Persistent -- "${timer}")" || return 1
  (( $(wc --lines <<<"${service_contract}") == 12 )) || return 1
  (( $(wc --lines <<<"${timer_contract}") == 8 )) || return 1
  [[ "$(grep --fixed-strings --line-regexp --count "FragmentPath=${service_path}" <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'DropInPaths=' <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'User=root' <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'Group=root' <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'Type=oneshot' <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'NoNewPrivileges=yes' <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'ProtectSystem=strict' <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'ProtectClock=yes' <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'Environment=PATH=/usr/bin:/bin DOCKER_HOST=unix:///run/docker.sock DOCKER_CONFIG=/run/refunddesk/edge-window-watchdog-docker-config' <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'UnsetEnvironment=DOCKER_CONTEXT DOCKER_CERT_PATH DOCKER_TLS_VERIFY DOCKER_TLS' <<<"${service_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'ExecSearchPath=/usr/bin:/bin' <<<"${service_contract}")" == 1 ]] || return 1
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" != "1" ]]; then
    docker_cli_environment_valid || return 1
    DOCKER_CLI_ENVIRONMENT_VALID=true
  fi
  exec_start="$(grep --fixed-strings -- 'ExecStart=' <<<"${service_contract}")" || return 1
  [[ "${exec_start}" != *$'\n'* ]] || return 1
  [[ "${exec_start}" != *'} ; {'* ]] || return 1
  [[ "$(grep --only-matching --fixed-strings 'path=' <<<"${exec_start}" | wc --lines)" == 1 ]] || return 1
  [[ "$(grep --only-matching --fixed-strings 'argv[]=' <<<"${exec_start}" | wc --lines)" == 1 ]] || return 1
  [[ "${exec_start}" == "ExecStart={ path=/usr/local/libexec/refunddesk-edge-window-watchdog.sh ; argv[]=/usr/local/libexec/refunddesk-edge-window-watchdog.sh ; ignore_errors=no ;"*" }" ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count "FragmentPath=${timer_path}" <<<"${timer_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'DropInPaths=' <<<"${timer_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count "Unit=${service}" <<<"${timer_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'OnBootUSec=1s' <<<"${timer_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'OnUnitActiveUSec=1s' <<<"${timer_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'AccuracyUSec=1ms' <<<"${timer_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'RandomizedDelayUSec=0' <<<"${timer_contract}")" == 1 ]] || return 1
  [[ "$(grep --fixed-strings --line-regexp --count 'Persistent=no' <<<"${timer_contract}")" == 1 ]] || return 1
}

directory_controlled() {
  local path="$1" metadata mode expected_uid
  [[ -d "${path}" && ! -L "${path}" ]] || return 1
  expected_uid=0
  [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ]] && expected_uid="$(id -u)"
  metadata="$(stat --format='%u:%a' -- "${path}")" || return 1
  [[ "${metadata}" =~ ^${expected_uid}:([0-7]{3,4})$ ]] || return 1
  mode="${BASH_REMATCH[1]}"
  (( (8#${mode} & 022) == 0 ))
}

marker_valid() {
  local expected_sha actual_sha service_sha timer_sha expected_uid expected_gid metadata
  [[ -f "${MARKER}" && ! -L "${MARKER}" ]] || return 1
  expected_uid=0
  expected_gid=0
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ]]; then
    expected_uid="$(id -u)"
    expected_gid="$(id -g)"
  fi
  metadata="$(stat --format='%u:%g:%a:%h' -- "${MARKER}")" || return 1
  [[ "${metadata}" == "${expected_uid}:${expected_gid}:600:1" ]] || return 1
  (( $(wc --bytes <"${MARKER}") <= 4096 )) || return 1
  python3 - "${MARKER}" <<'PY' || return 1
import json, pathlib, sys

path = pathlib.Path(sys.argv[1])
raw = path.read_bytes()
def strict_pairs(items):
    document = {}
    for key, value in items:
        if key in document:
            raise ValueError("duplicate key")
        document[key] = value
    return document
try:
    document = json.loads(raw.decode("utf-8"), object_pairs_hook=strict_pairs)
except Exception:
    raise SystemExit(1)
canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
if raw != canonical:
    raise SystemExit(1)
PY
  jq --exit-status '
    type == "object"
    and keys == ["armedBoottimeMilliseconds","bootId","caddyContainerId","deadlineBoottimeMilliseconds","deadlineEpoch","expectedRevision","kind","metrics","nonce","schemaVersion","serviceSha256","startDeadlineBoottimeMilliseconds","state","timerSha256","triggered","watchdogSha256","windowSeconds","workerContainerId"]
    and .schemaVersion == 1
    and .kind == "refunddesk.edge-window-watchdog"
    and (.nonce | type == "string" and test("^[0-9a-f]{64}$"))
    and (.expectedRevision | type == "string" and test("^[0-9a-f]{40}$"))
    and (.deadlineEpoch | type == "number" and floor == . and . > 0)
    and (.bootId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))
    and (.windowSeconds | type == "number" and floor == . and . >= 30 and . <= 300)
    and (.armedBoottimeMilliseconds | type == "number" and floor == . and . >= 0)
    and (.deadlineBoottimeMilliseconds | type == "number" and floor == . and . == (.armedBoottimeMilliseconds + (.windowSeconds * 1000)))
    and (.watchdogSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.serviceSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.timerSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.caddyContainerId | type == "string" and test("^[0-9a-f]{64}$"))
    and (.workerContainerId | type == "string" and test("^[0-9a-f]{64}$"))
    and .caddyContainerId != .workerContainerId
    and (.metrics | type == "object"
      and keys == ["containersRestartFenced","containersStopped","unitsStopRequested"]
      and all(.[]; type == "number" and floor == . and . >= 0))
    and (.state | IN("armed","armed_running","starting","contained"))
    and (if .state == "starting" then
      (.startDeadlineBoottimeMilliseconds as $start
        | ($start | type == "number" and floor == .)
        and $start > .armedBoottimeMilliseconds and $start < .deadlineBoottimeMilliseconds)
    else .startDeadlineBoottimeMilliseconds == null end)
    and (.triggered | type == "boolean")
  ' "${MARKER}" >/dev/null
  expected_sha="$(jq --raw-output '.watchdogSha256' "${MARKER}")" || return 1
  actual_sha="$(sha256sum -- "$0" | cut -d ' ' -f 1)" || return 1
  [[ "${actual_sha}" == "${expected_sha}" ]] || return 1
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" != "1" ]]; then
    service_sha="$(sha256sum -- /etc/systemd/system/refunddesk-edge-window-watchdog.service | cut -d ' ' -f 1)" || return 1
    timer_sha="$(sha256sum -- /etc/systemd/system/refunddesk-edge-window-watchdog.timer | cut -d ' ' -f 1)" || return 1
    [[ "${service_sha}" == "$(jq --raw-output '.serviceSha256' "${MARKER}")" ]] || return 1
    [[ "${timer_sha}" == "$(jq --raw-output '.timerSha256' "${MARKER}")" ]] || return 1
  fi
}

preflight_receipt_valid() {
  local expected_uid metadata
  [[ -f "${PREFLIGHT_RECEIPT}" && ! -L "${PREFLIGHT_RECEIPT}" ]] || return 1
  expected_uid=0
  [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ]] && expected_uid="$(id -u)"
  metadata="$(stat --format='%u:%a:%h' -- "${PREFLIGHT_RECEIPT}")" || return 1
  [[ "${metadata}" == "${expected_uid}:600:1" ]] || return 1
  (( $(wc --bytes <"${PREFLIGHT_RECEIPT}") <= 4096 )) || return 1
  python3 - "${PREFLIGHT_RECEIPT}" <<'PY' || return 1
import json, pathlib, sys

path = pathlib.Path(sys.argv[1])
raw = path.read_bytes()
def strict_pairs(items):
    document = {}
    for key, value in items:
        if key in document:
            raise ValueError("duplicate key")
        document[key] = value
    return document
try:
    document = json.loads(raw.decode("ascii"), object_pairs_hook=strict_pairs)
except Exception:
    raise SystemExit(1)
canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
if raw != canonical:
    raise SystemExit(1)
PY
  jq --exit-status '
    type == "object"
    and keys == ["bootIdSha256","caddyContainerId","expectedRevision","kind","markerSha256","nonce","observedAtEpoch","observedBoottimeMilliseconds","schemaVersion","workerContainerId"]
    and .schemaVersion == 1
    and .kind == "refunddesk.edge-window-watchdog-preflight"
    and (.nonce | type == "string" and test("^[0-9a-f]{64}$"))
    and (.expectedRevision | type == "string" and test("^[0-9a-f]{40}$"))
    and (.markerSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.bootIdSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.caddyContainerId | type == "string" and test("^[0-9a-f]{64}$"))
    and (.workerContainerId | type == "string" and test("^[0-9a-f]{64}$"))
    and .caddyContainerId != .workerContainerId
    and (.observedAtEpoch | type == "number" and floor == . and . > 0)
    and (.observedBoottimeMilliseconds | type == "number" and floor == . and . >= 0)
  ' "${PREFLIGHT_RECEIPT}" >/dev/null
}

preflight_receipt_identity_matches_marker() {
  local boot_sha
  preflight_receipt_valid || return 1
  boot_sha="$(jq --raw-output '.bootId' "${MARKER}" | tr -d '\n' | sha256sum | cut -d ' ' -f 1)" || return 1
  jq --exit-status --slurpfile marker "${MARKER}" --arg bootSha "${boot_sha}" '
    .nonce == $marker[0].nonce
    and .expectedRevision == $marker[0].expectedRevision
    and .bootIdSha256 == $bootSha
    and .caddyContainerId == $marker[0].caddyContainerId
    and .workerContainerId == $marker[0].workerContainerId
  ' "${PREFLIGHT_RECEIPT}" >/dev/null
}

preflight_receipt_matches_marker() {
  local marker_sha
  preflight_receipt_identity_matches_marker || return 1
  marker_sha="$(sha256sum -- "${MARKER}" | cut -d ' ' -f 1)" || return 1
  [[ "$(jq --raw-output '.markerSha256' "${PREFLIGHT_RECEIPT}")" == "${marker_sha}" ]]
}

preflight_receipt_pending_absent() {
  # A published receipt is not the sole authority while any publication or
  # refresh pending survives.  Inspect that namespace before the healthy
  # heartbeat fast path; otherwise a second canonical inode could be ignored
  # forever even though durable_preflight_receipt would reject it strictly.
  timeout --signal=TERM --kill-after=1s 2s python3 - "${CONTROL_ROOT}" <<'PY'
import os
import sys

with os.scandir(sys.argv[1]) as entries:
    for entry in entries:
        if entry.name.startswith(".edge-window-watchdog-preflight."):
            raise SystemExit(1)
PY
}

identity_transition_present() {
  local -a transitions
  shopt -s nullglob
  transitions=(
    "${CONTROL_ROOT}"/edge-window-caddy-identity-transition-*.json
    "${CONTROL_ROOT}"/.edge-window-caddy-identity-transition-*.json.*
  )
  shopt -u nullglob
  (( ${#transitions[@]} > 0 ))
}

durable_receipt_binding_refresh() {
  # A marker transition and its receipt binding form one recoverable pair.  A
  # crash after the marker replace may leave the old (otherwise valid) receipt;
  # the next tick deterministically rewrites only markerSha256 while preserving
  # the original preflight observation clocks.  A partial refresh pending is
  # derived state and is safe to discard only while the authoritative receipt
  # is still a controlled, valid file.
  python3 - "${MARKER}" "${PREFLIGHT_RECEIPT}" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

marker_path = pathlib.Path(sys.argv[1])
receipt_path = pathlib.Path(sys.argv[2])
pending_path = receipt_path.parent / ".edge-window-watchdog-preflight-refresh.pending"
expected_uid = os.geteuid()

def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result

def read_controlled(path, maximum):
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_nlink != 1
        or info.st_size < 2
        or info.st_size > maximum
    ):
        raise SystemExit(1)
    raw = path.read_bytes()
    if len(raw) != info.st_size:
        raise SystemExit(1)
    document = json.loads(raw.decode("ascii"), object_pairs_hook=pairs)
    canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
    if raw != canonical:
        raise SystemExit(1)
    return raw, document

def fsync_directory():
    descriptor = os.open(receipt_path.parent, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

marker_raw, marker = read_controlled(marker_path, 4096)
if not os.path.lexists(receipt_path):
    # A crash before the first receipt publication must not prevent physical
    # containment.  There is no receipt authority to refresh; later cleanup
    # records continuity false and removes the marker without promoting PASS.
    if os.path.lexists(pending_path):
        raise SystemExit(1)
    raise SystemExit(0)
receipt_raw, receipt = read_controlled(receipt_path, 4096)
marker_keys = {
    "armedBoottimeMilliseconds", "bootId", "caddyContainerId",
    "deadlineBoottimeMilliseconds", "deadlineEpoch", "expectedRevision",
    "kind", "metrics", "nonce", "schemaVersion", "serviceSha256",
    "startDeadlineBoottimeMilliseconds", "state", "timerSha256", "triggered",
    "watchdogSha256", "windowSeconds", "workerContainerId",
}
receipt_keys = {
    "bootIdSha256", "caddyContainerId", "expectedRevision", "kind",
    "markerSha256", "nonce", "observedAtEpoch", "observedBoottimeMilliseconds",
    "schemaVersion", "workerContainerId",
}
if set(marker) != marker_keys or set(receipt) != receipt_keys:
    raise SystemExit(1)
if marker.get("schemaVersion") != 1 or marker.get("kind") != "refunddesk.edge-window-watchdog":
    raise SystemExit(1)
if marker.get("state") not in {"armed", "armed_running", "contained"}:
    raise SystemExit(1)
if receipt.get("schemaVersion") != 1 or receipt.get("kind") != "refunddesk.edge-window-watchdog-preflight":
    raise SystemExit(1)
expected = {
    "bootIdSha256": hashlib.sha256(marker["bootId"].encode("ascii")).hexdigest(),
    "caddyContainerId": marker["caddyContainerId"],
    "expectedRevision": marker["expectedRevision"],
    "nonce": marker["nonce"],
    "workerContainerId": marker["workerContainerId"],
}
if any(receipt.get(key) != value for key, value in expected.items()):
    raise SystemExit(1)
if not isinstance(receipt.get("observedAtEpoch"), int) or isinstance(receipt.get("observedAtEpoch"), bool):
    raise SystemExit(1)
if not isinstance(receipt.get("observedBoottimeMilliseconds"), int) or isinstance(receipt.get("observedBoottimeMilliseconds"), bool):
    raise SystemExit(1)
old_sha = receipt.get("markerSha256")
if not isinstance(old_sha, str) or len(old_sha) != 64 or any(char not in "0123456789abcdef" for char in old_sha):
    raise SystemExit(1)

# If power failed while writing a derived refresh, the old receipt remains the
# authority.  Remove only the exact controlled pending pathname before retry.
if os.path.lexists(pending_path):
    pending_info = os.lstat(pending_path)
    if (
        not stat.S_ISREG(pending_info.st_mode)
        or pending_info.st_uid != expected_uid
        or stat.S_IMODE(pending_info.st_mode) != 0o600
        or pending_info.st_nlink != 1
        or pending_info.st_size > 4096
    ):
        raise SystemExit(1)
    os.unlink(pending_path)
    fsync_directory()

receipt["markerSha256"] = hashlib.sha256(marker_raw).hexdigest()
raw = (json.dumps(receipt, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
descriptor = os.open(
    pending_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    0o600,
)
try:
    offset = 0
    while offset < len(raw):
        written = os.write(descriptor, raw[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
fsync_directory()
os.replace(pending_path, receipt_path)
fsync_directory()

published_raw, published = read_controlled(receipt_path, 4096)
if published_raw != raw or published.get("markerSha256") != hashlib.sha256(marker_raw).hexdigest():
    raise SystemExit(1)
PY
}

durable_marker_state() {
  local state="$1" triggered="${2:-false}" temporary
  [[ "${triggered}" == true || "${triggered}" == false ]] || return 1
  temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-watchdog.XXXXXXXXXX')" || return 1
  jq --compact-output --sort-keys --arg state "${state}" \
    --argjson triggered "${triggered}" \
    --argjson containersRestartFenced "${FENCED_CONTAINER_COUNT}" \
    --argjson containersStopped "${STOPPED_CONTAINER_COUNT}" \
    --argjson unitsStopRequested "${STOPPED_UNIT_COUNT}" \
    '.state = $state | .startDeadlineBoottimeMilliseconds = null | .triggered = (.triggered or $triggered) | .metrics = {containersRestartFenced:$containersRestartFenced,containersStopped:$containersStopped,unitsStopRequested:$unitsStopRequested}' \
    "${MARKER}" >"${temporary}" || return 1
  chmod 600 "${temporary}" || return 1
  sync --file-system "${temporary}" 2>/dev/null || sync "${temporary}" || return 1
  mv --no-target-directory -- "${temporary}" "${MARKER}" || return 1
  sync --file-system "${CONTROL_ROOT}" 2>/dev/null || sync "${CONTROL_ROOT}" || return 1
  durable_receipt_binding_refresh || return 1
}

durable_preflight_receipt() {
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
    "${REFUNDDESK_EDGE_WINDOW_TEST_RECEIPT_PUBLISH_HANG:-}" == "1" ]]; then
    edge_command receipt-publish-sync >/dev/null || return 1
  fi
  timeout --signal=TERM --kill-after=1s 2s python3 - "${MARKER}" "${PREFLIGHT_RECEIPT}" "${CURRENT_BOOT_ID}" \
    "${CURRENT_BOOTTIME_MS}" "${NOW_EPOCH}" <<'PY'
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import stat
import sys
import tempfile

marker_path = pathlib.Path(sys.argv[1])
receipt_path = pathlib.Path(sys.argv[2])
current_boot = sys.argv[3]
current_boottime = int(sys.argv[4])
current_epoch = int(sys.argv[5])
marker_raw = marker_path.read_bytes()
marker = json.loads(marker_raw.decode("ascii"))
if marker.get("state") not in {"armed", "armed_running"} or marker.get("bootId") != current_boot:
    raise SystemExit(1)
armed = marker.get("armedBoottimeMilliseconds")
deadline = marker.get("deadlineBoottimeMilliseconds")
wall_deadline = marker.get("deadlineEpoch")
if not all(isinstance(value, int) and not isinstance(value, bool) for value in (armed, deadline, wall_deadline)):
    raise SystemExit(1)
if not (armed <= current_boottime < deadline and current_epoch < wall_deadline):
    raise SystemExit(1)
boot_sha = hashlib.sha256(current_boot.encode("ascii")).hexdigest()
marker_sha = hashlib.sha256(marker_raw).hexdigest()
base = {
    "bootIdSha256": boot_sha,
    "caddyContainerId": marker["caddyContainerId"],
    "expectedRevision": marker["expectedRevision"],
    "kind": "refunddesk.edge-window-watchdog-preflight",
    "markerSha256": marker_sha,
    "nonce": marker["nonce"],
    "schemaVersion": 1,
    "workerContainerId": marker["workerContainerId"],
}

def pairs(items):
    out = {}
    for key, value in items:
        if key in out:
            raise ValueError("duplicate")
        out[key] = value
    return out

def read_canonical(path):
    info = path.lstat()
    expected_uid = os.geteuid()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_nlink != 1
        or info.st_size > 4096
    ):
        raise SystemExit(1)
    raw = path.read_bytes()
    document = json.loads(raw.decode("ascii"), object_pairs_hook=pairs)
    canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
    if raw != canonical:
        raise SystemExit(1)
    return raw, document

def validate_existing(path=receipt_path) -> None:
    _, document = read_canonical(path)
    if set(document) != set(base) | {"observedAtEpoch", "observedBoottimeMilliseconds"}:
        raise SystemExit(1)
    for key, value in base.items():
        if key == "markerSha256" and marker.get("state") == "armed_running":
            observed_marker_sha = document.get(key)
            if not isinstance(observed_marker_sha, str) or len(observed_marker_sha) != 64 or any(char not in "0123456789abcdef" for char in observed_marker_sha):
                raise SystemExit(1)
            continue
        if document.get(key) != value:
            raise SystemExit(1)
    observed_epoch = document.get("observedAtEpoch")
    observed_boottime = document.get("observedBoottimeMilliseconds")
    if not all(isinstance(value, int) and not isinstance(value, bool) for value in (observed_epoch, observed_boottime)):
        raise SystemExit(1)
    if not (armed <= observed_boottime < deadline and observed_epoch < wall_deadline):
        raise SystemExit(1)

def fsync_directory() -> None:
    directory = os.open(receipt_path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def rename_noreplace(source, destination) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOSYS, errno.EINVAL}:
            raise SystemExit(1)
        raise OSError(error, os.strerror(error))

pending_paths = sorted(receipt_path.parent.glob(".edge-window-watchdog-preflight.*"))
if len(pending_paths) > 1:
    raise SystemExit(1)
if receipt_path.exists() or receipt_path.is_symlink():
    if pending_paths:
        # Recover both the legacy link-before-unlink boundary and a crash in a
        # new private write. The published receipt remains authoritative: a
        # controlled partial pending may be removed, while a complete
        # canonical receipt for another binding is preserved and rejected.
        pending_info = pending_paths[0].lstat()
        receipt_info = receipt_path.lstat()
        if (
            pending_info.st_dev != receipt_info.st_dev
            or pending_info.st_ino != receipt_info.st_ino
            or pending_info.st_nlink != 2
            or receipt_info.st_nlink != 2
        ):
            validate_existing()
            try:
                read_canonical(pending_paths[0])
            except (SystemExit, UnicodeError, ValueError, json.JSONDecodeError):
                pending_paths[0].unlink()
                fsync_directory()
            else:
                # A complete second inode is never cleanup debris, even when
                # it currently repeats the published receipt bytes.
                raise SystemExit(1)
        else:
            pending_paths[0].unlink()
            fsync_directory()
            validate_existing()
    else:
        validate_existing()
elif pending_paths:
    # The pending entry was made durable before a power loss at rename.  Its
    # nonce/revision/marker binding is revalidated before publication.
    try:
        validate_existing(pending_paths[0])
    except (SystemExit, UnicodeError, ValueError, json.JSONDecodeError):
        # An incomplete pending has never been authoritative. The exact marker
        # and current monotonic clocks remain the authority for a retry.
        try:
            read_canonical(pending_paths[0])
        except (SystemExit, UnicodeError, ValueError, json.JSONDecodeError):
            pending_paths[0].unlink()
            fsync_directory()
        else:
            # Canonical bytes with a different binding belong to neither this
            # marker nor this retry and must be retained as an ambiguity.
            raise SystemExit(1)
    else:
        fsync_directory()
        rename_noreplace(pending_paths[0], receipt_path)
        fsync_directory()
        validate_existing()

document = {
    **base,
    "observedAtEpoch": current_epoch,
    "observedBoottimeMilliseconds": current_boottime,
}
raw = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
descriptor, temporary = tempfile.mkstemp(prefix=".edge-window-watchdog-preflight.", dir=receipt_path.parent)
try:
    os.fchmod(descriptor, 0o600)
    offset = 0
    while offset < len(raw):
        written = os.write(descriptor, raw[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written
    os.fsync(descriptor)
    os.close(descriptor)
    descriptor = -1
    # Persist the pending directory entry before publication.  Refreshes of an
    # already validated receipt use atomic replace; the first publication uses
    # RENAME_NOREPLACE so an unrelated path can never be consumed.
    fsync_directory()
    if receipt_path.exists():
        os.replace(temporary, receipt_path)
    else:
        rename_noreplace(temporary, receipt_path)
    fsync_directory()
finally:
    if descriptor >= 0:
        os.close(descriptor)
    if os.path.exists(temporary):
        os.unlink(temporary)
validate_existing()
PY
}

containment_container_id() {
  local service="$1" source value other other_service
  [[ "${service}" == caddy || "${service}" == worker ]] || return 1
  if [[ "${service}" == caddy ]]; then other_service=worker; else other_service=caddy; fi
  if marker_valid; then
    source="${MARKER}"
  elif preflight_receipt_valid; then
    source="${PREFLIGHT_RECEIPT}"
  else
    return 1
  fi
  value="$(jq --raw-output ".${service}ContainerId" "${source}")" || return 1
  other="$(jq --raw-output ".${other_service}ContainerId" "${source}")" || return 1
  [[ "${value}" =~ ^[0-9a-f]{64}$ && "${other}" =~ ^[0-9a-f]{64}$ && "${value}" != "${other}" ]] || return 1
  printf '%s\n' "${value}"
}

deadline_public_hard_fence() {
  local expected_caddy expected_worker output
  local status=0 broad_required=false broad_fenced="${DOCKER_API_FENCED}"
  broad_deadline_fence() {
    [[ "${broad_fenced}" != true ]] || return 0
    # This transition is forward-only and happens before the socket operation:
    # even a failed/timeout mask must never permit a later Docker API call.
    broad_fenced=true
    DOCKER_API_FENCED=true
    edge_command stop-docker-socket >/dev/null || status=1
    edge_command kill-all-container-scopes >/dev/null || status=1
    edge_command kill-docker-daemon >/dev/null || status=1
    output="$(edge_command public-listeners)" || {
      output="unavailable"
      status=1
    }
    [[ -z "${output}" ]] || status=1
  }

  # At the deadline, availability is already forfeit. Kill the exact armed
  # Caddy cgroup immediately; never spend the reserve on Docker inventory,
  # graceful stop, marker fsync or unrelated units before this fence.
  expected_caddy="$(containment_container_id caddy 2>/dev/null)" || expected_caddy=""
  if [[ "${expected_caddy}" =~ ^[0-9a-f]{64}$ ]]; then
    edge_command kill-container-scope "${expected_caddy}" >/dev/null || {
      status=1
      broad_required=true
    }
  else
    status=1
    broad_required=true
  fi

  output="$(edge_command public-listeners)" || {
    output="unavailable"
    status=1
    broad_required=true
  }
  if [[ -n "${output}" ]]; then
    status=1
    broad_required=true
  fi

  if [[ "${broad_required}" == true ]]; then
    broad_deadline_fence
  fi

  # The financial worker is the next deadline surface. Its exact preflight
  # identity is killed before any full inventory or systemd maintenance pass.
  expected_worker="$(containment_container_id worker 2>/dev/null)" || expected_worker=""
  if [[ "${expected_worker}" =~ ^[0-9a-f]{64}$ ]]; then
    if ! edge_command kill-container-scope "${expected_worker}" >/dev/null; then
      status=1
      broad_deadline_fence
    fi
  else
    status=1
    broad_deadline_fence
  fi
  return "${status}"
}

stop_surface() {
  local unit service container release_unit line output unit_state states state_id state_restart state_running
  local expected_container group_ok docker_daemon_fenced=false
  local all_container_scopes_fenced=false
  local status=0 release_inventory_ok=true
  local running_count state_count
  local -a containers=() valid_containers=() release_units=()
  listener_surface_closed() {
    local line output listeners_closed=true
    for line in "$@"; do
      output="$(edge_command listener "${line%%:*}" "${line##*:}")" || {
        output="unavailable"
        listeners_closed=false
      }
      [[ -z "${output}" ]] || listeners_closed=false
    done
    [[ "${listeners_closed}" == true ]]
  }
  broad_docker_fence() {
    if [[ "${DOCKER_API_FENCED}" != true ]]; then
      edge_command stop-docker-socket >/dev/null || status=1
      DOCKER_API_FENCED=true
    fi
    if [[ "${all_container_scopes_fenced}" != true ]]; then
      edge_command kill-all-container-scopes >/dev/null || status=1
      all_container_scopes_fenced=true
    fi
    if [[ "${docker_daemon_fenced}" != true ]]; then
      edge_command kill-docker-daemon >/dev/null || status=1
      docker_daemon_fenced=true
    fi
  }
  if marker_valid; then
    FENCED_CONTAINER_COUNT="$(jq --raw-output '.metrics.containersRestartFenced' "${MARKER}")" || status=1
    STOPPED_CONTAINER_COUNT="$(jq --raw-output '.metrics.containersStopped' "${MARKER}")" || status=1
    STOPPED_UNIT_COUNT="$(jq --raw-output '.metrics.unitsStopRequested' "${MARKER}")" || status=1
  fi
  # The public listener is the deadline-critical surface.  Fence and stop
  # Caddy before any maintenance/release unit so a slow unrelated unit cannot
  # extend ingress.  The durable deadline is deliberately armed with a
  # separate containment reserve, and the timer ticks every second.
  for service in caddy worker; do
    if [[ "${DOCKER_API_FENCED}" == true ]]; then
      if [[ "${service}" == worker ]]; then
        listener_surface_closed tcp:80 tcp:443 udp:80 udp:443 || status=1
        expected_container="$(containment_container_id worker 2>/dev/null)" || expected_container=""
        if [[ "${expected_container}" =~ ^[0-9a-f]{64}$ ]]; then
          edge_command kill-container-scope "${expected_container}" >/dev/null || status=1
        else
          status=1
        fi
      fi
      continue
    fi
    group_ok=true
    containers=()
    valid_containers=()
    output="$(edge_command list-container "${service}")" || {
      output=""
      status=1
      group_ok=false
    }
    if [[ -n "${output}" ]]; then
      mapfile -t containers <<<"${output}"
    fi
    if (( ${#output} >= 16385 || ${#containers[@]} > 64 )); then
      # Never iterate or pass an oversized, truncated Docker inventory to a
      # later command. Treat the daemon as ambiguous and jump directly to the
      # exact pre-armed scope plus docker.service fences.
      status=1
      group_ok=false
      containers=()
    fi
    (( ${#containers[@]} == 1 )) || { status=1; group_ok=false; }
    for container in "${containers[@]}"; do
      if [[ ! "${container}" =~ ^[0-9a-f]{64}$ ]]; then
        status=1
        group_ok=false
        continue
      fi
      valid_containers+=("${container}")
    done
    expected_container="$(containment_container_id "${service}" 2>/dev/null)" || expected_container=""
    [[ "${expected_container}" =~ ^[0-9a-f]{64}$ ]] || { status=1; group_ok=false; }
    if [[ -n "${expected_container}" && " ${valid_containers[*]} " != *" ${expected_container} "* ]]; then
      status=1
      group_ok=false
    fi

    # All Docker calls below are aggregate, fixed-time commands. Cardinality
    # drift is a terminal error, but it can never multiply the deadline path by
    # N containers or leave a later Caddy ID listening while an earlier stop
    # consumes the containment reserve.
    running_count=0
    state_count=0
    states=""
    if (( ${#valid_containers[@]} > 0 )); then
      states="$(edge_command containers-state "${valid_containers[@]}" 2>/dev/null)" || {
        states=""
        status=1
        group_ok=false
      }
      while IFS=: read -r state_id state_restart state_running; do
        [[ -n "${state_id}" ]] || continue
        ((state_count += 1))
        [[ "${state_id}" =~ ^[0-9a-f]{64}$ && ( "${state_restart}" == no || "${state_restart}" == always || "${state_restart}" == unless-stopped || "${state_restart}" == on-failure ) && ( "${state_running}" == true || "${state_running}" == false ) ]] || {
          status=1
          group_ok=false
          continue
        }
        [[ " ${valid_containers[*]} " == *" ${state_id} "* ]] || { status=1; group_ok=false; }
        [[ "${state_running}" != true ]] || ((running_count += 1))
      done <<<"${states}"
      (( state_count == ${#valid_containers[@]} )) || { status=1; group_ok=false; }
      if edge_command fence-containers "${valid_containers[@]}" >/dev/null; then
        ((FENCED_CONTAINER_COUNT += ${#valid_containers[@]}))
      else
        status=1
        group_ok=false
      fi
      if (( running_count > 0 )); then
        if edge_command stop-containers "${valid_containers[@]}" >/dev/null; then
          ((STOPPED_CONTAINER_COUNT += running_count))
        else
          status=1
          group_ok=false
        fi
      fi
      states="$(edge_command containers-state "${valid_containers[@]}" 2>/dev/null)" || {
        states=""
        status=1
        group_ok=false
      }
      state_count=0
      while IFS=: read -r state_id state_restart state_running; do
        [[ -n "${state_id}" ]] || continue
        ((state_count += 1))
        [[ "${state_id}" =~ ^[0-9a-f]{64}$ && "${state_restart}" == no && "${state_running}" == false ]] || { status=1; group_ok=false; }
        [[ " ${valid_containers[*]} " == *" ${state_id} "* ]] || { status=1; group_ok=false; }
      done <<<"${states}"
      (( state_count == ${#valid_containers[@]} )) || { status=1; group_ok=false; }
    fi
    if [[ "${group_ok}" != true && "${expected_container}" =~ ^[0-9a-f]{64}$ ]]; then
      # Docker may have failed after the exact container was started. PID 1
      # still owns docker-<id>.scope, so kill that pre-armed identity directly
      # and continue to the independent ss readback. This operation never
      # upgrades the tick to success: Docker ambiguity remains a terminal 20.
      edge_command kill-container-scope "${expected_container}" >/dev/null || status=1
    fi
    if [[ "${group_ok}" != true ]]; then
      # Docker cannot authoritatively prove the exact singleton stopped and
      # fenced. Even when a durable receipt supplied the expected identity, a
      # drift scope or live-restore shim could remain. Kill every loaded
      # Docker scope in one bounded fail-safe call; never extract an ID from a
      # malformed marker.
      broad_docker_fence
    fi
    if [[ "${service}" == caddy ]] &&
      ! listener_surface_closed tcp:80 tcp:443 udp:80 udp:443; then
      # All four public sockets are checked immediately after Caddy, before a
      # slow worker, maintenance unit or release fence can spend the deadline
      # reserve. A surviving proxy/DNAT listener triggers the broad fence.
      status=1
      broad_docker_fence
      listener_surface_closed tcp:80 tcp:443 udp:80 udp:443 || status=1
    fi
    [[ "${DOCKER_API_FENCED}" != true ]] || continue
  done
  for unit in refunddesk-backup.timer refunddesk-retention.timer; do
    unit_state="$(edge_command unit-state "${unit}" 2>/dev/null)" || {
      unit_state="unknown"
      status=1
    }
    if edge_command disable-unit "${unit}" >/dev/null; then
      [[ "${unit_state}" == "inactive" ]] || ((STOPPED_UNIT_COUNT += 1))
    else
      status=1
    fi
  done
  for unit in \
    refunddesk-backup.service \
    refunddesk-retention.service \
    refunddesk-quiesce-recovery.service; do
    unit_state="$(edge_command unit-state "${unit}" 2>/dev/null)" || {
      unit_state="unknown"
      status=1
    }
    if edge_command stop-unit "${unit}" >/dev/null; then
      [[ "${unit_state}" == "inactive" ]] || ((STOPPED_UNIT_COUNT += 1))
    else
      status=1
    fi
  done
  output="$(edge_command list-release-units)" || {
    output=""
    status=1
    release_inventory_ok=false
  }
  if [[ -n "${output}" ]]; then
    mapfile -t release_units <<<"${output}"
  fi
  (( ${#output} < 16385 )) || status=1
  (( ${#release_units[@]} <= 64 )) || status=1
  for release_unit in "${release_units[@]}"; do
    if [[ ! "${release_unit}" =~ ^refunddesk-release-(fence-)?[0-9a-f]{12}-[0-9]+\.service$ ]]; then
      status=1
      continue
    fi
  done
  if (( ${#release_units[@]} > 0 )) || [[ "${release_inventory_ok}" != true ]]; then
    if edge_command stop-release-surface >/dev/null; then
      ((STOPPED_UNIT_COUNT += ${#release_units[@]}))
    else
      status=1
    fi
  fi
  for unit in \
    refunddesk-backup.timer \
    refunddesk-backup.service \
    refunddesk-retention.timer \
    refunddesk-retention.service \
    refunddesk-quiesce-recovery.service; do
    [[ "$(edge_command unit-state "${unit}" 2>/dev/null)" == "inactive" ]] || status=1
  done
  for unit in refunddesk-backup.timer refunddesk-retention.timer; do
    [[ "$(edge_command unit-enabled "${unit}" 2>/dev/null)" == "disabled" ]] || status=1
  done
  output="$(edge_command list-active-release-units)" || {
    output="unavailable"
    status=1
  }
  [[ -z "${output}" ]] || status=1
  if ! listener_surface_closed tcp:80 tcp:443 udp:80 udp:443; then
    status=1
    # Docker may report the exact containers stopped while a userland proxy,
    # stale DNAT target or unlabeled scope still serves the public ports. The
    # listener readback itself therefore escalates to the broad fail-safe and
    # is repeated after that fence.
    broad_docker_fence
    listener_surface_closed tcp:80 tcp:443 udp:80 udp:443 || status=1
  fi
  return "${status}"
}

prerequisites_ok=true
for required in chmod cut env find flock head id jq mktemp mv python3 sha256sum stat sync timeout wc; do
  command -v "${required}" >/dev/null 2>&1 || prerequisites_ok=false
done
if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" != "1" ]]; then
  for required in awk date ss systemctl; do
    command -v "${required}" >/dev/null 2>&1 || prerequisites_ok=false
  done
fi
if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
  "${REFUNDDESK_EDGE_WINDOW_TEST_PREREQUISITE_FAILURE:-}" == "1" ]]; then
  prerequisites_ok=false
fi
if [[ "${prerequisites_ok}" != true ]]; then
  deadline_public_hard_fence || true
  stop_surface || true
  record_fail_safe_trigger
  exit "${EXIT_INCOMPLETE}"
fi
directory_controlled "${CONTROL_ROOT}" || {
  deadline_public_hard_fence || true
  stop_surface || true
  record_fail_safe_trigger
  exit "${EXIT_INCOMPLETE}"
}
directory_controlled "${RUNTIME_ROOT}" || {
  deadline_public_hard_fence || true
  stop_surface || true
  record_fail_safe_trigger
  exit "${EXIT_INCOMPLETE}"
}

exec 9>"${LOCK}" || exit "${EXIT_INCOMPLETE}"
if [[ "${FORCE}" == true ]]; then
  flock --exclusive --wait "${LOCK_WAIT_SECONDS}" 9 || exit "${EXIT_INCOMPLETE}"
else
  flock --exclusive --nonblock 9 || exit 0
fi
if [[ ! -e "${MARKER}" ]]; then
  # Clean disarm disables the timer before removing the marker, so an invoked
  # service with no marker is never a benign armed state.  Contain on both
  # scheduled and forced invocations and fail closed because no nonce-bound
  # marker can be durably advanced.
  deadline_public_hard_fence || true
  stop_surface || true
  record_fail_safe_trigger
  exit "${EXIT_FAIL}"
fi
if ! marker_valid; then
  deadline_public_hard_fence || true
  stop_surface || true
  record_fail_safe_trigger
  exit "${EXIT_FAIL}"
fi
# Origin cleanup transfers the stopped final Caddy identity under this same
# lock. A crash may leave its durable transition pending or split across the
# marker/receipt pair. Re-fence without mutating either authority so the exact
# transition hashes remain repairable on replay.
if identity_transition_present; then
  stop_surface || true
  exit "${EXIT_FAIL}"
fi
if [[ "${FORCE}" == true ]]; then
  [[ "$(jq --raw-output '.nonce' "${MARKER}")" == "${FORCE_NONCE}" ]] || exit "${EXIT_FAIL}"
  marker_transition_ok=true
  deadline_public_hard_fence || marker_transition_ok=false
  stop_surface || marker_transition_ok=false
  record_fail_safe_trigger
  durable_marker_state contained true || marker_transition_ok=false
  [[ "${marker_transition_ok}" == true ]] || exit "${EXIT_FAIL}"
  exit 0
fi
if [[ "$(jq --raw-output '.state' "${MARKER}")" == "contained" ]]; then
  # A retained marker means the AWS close was not yet proved or cleanup was
  # interrupted.  Re-fence on every timer tick so a later manual/container
  # restart cannot re-expose the host while edge state is ambiguous.
  FENCED_CONTAINER_COUNT="$(jq --raw-output '.metrics.containersRestartFenced' "${MARKER}")" || exit "${EXIT_FAIL}"
  STOPPED_CONTAINER_COUNT="$(jq --raw-output '.metrics.containersStopped' "${MARKER}")" || exit "${EXIT_FAIL}"
  STOPPED_UNIT_COUNT="$(jq --raw-output '.metrics.unitsStopRequested' "${MARKER}")" || exit "${EXIT_FAIL}"
  socket_fenced="$(edge_command docker-socket-fenced 2>/dev/null)" || socket_fenced=false
  if [[ "${socket_fenced}" == true ]]; then
    DOCKER_API_FENCED=true
  fi
  deadline_public_hard_fence || true
  stop_surface || exit "${EXIT_FAIL}"
  durable_marker_state contained false || exit "${EXIT_FAIL}"
  exit 0
fi
clock_incomplete() {
  deadline_public_hard_fence || true
  record_fail_safe_trigger
  durable_marker_state contained true || true
  stop_surface || true
  durable_marker_state contained true || true
  exit "${EXIT_INCOMPLETE}"
}
contain_now() {
  hard_fence_ok=true
  deadline_public_hard_fence || hard_fence_ok=false
  record_fail_safe_trigger
  marker_transition_ok=true
  [[ "${hard_fence_ok}" == true ]] || marker_transition_ok=false
  durable_marker_state contained true || marker_transition_ok=false
  stop_surface || marker_transition_ok=false
  durable_marker_state contained true || marker_transition_ok=false
  [[ "${marker_transition_ok}" == true ]] || exit "${EXIT_FAIL}"
  exit 0
}
load_clock_state() {
  NOW_EPOCH="$(edge_command now-epoch)" || return 1
  DEADLINE_EPOCH="$(jq --raw-output '.deadlineEpoch' "${MARKER}")" || return 1
  CURRENT_BOOT_ID="$(edge_command boot-id)" || return 1
  CURRENT_BOOTTIME_MS="$(edge_command boottime-ms)" || return 1
  MARKER_BOOT_ID="$(jq --raw-output '.bootId' "${MARKER}")" || return 1
  DEADLINE_BOOTTIME_MS="$(jq --raw-output '.deadlineBoottimeMilliseconds' "${MARKER}")" || return 1
  ARMED_BOOTTIME_MS="$(jq --raw-output '.armedBoottimeMilliseconds' "${MARKER}")" || return 1
  [[ "${NOW_EPOCH}" =~ ^[0-9]{10,}$ && "${DEADLINE_EPOCH}" =~ ^[0-9]{10,}$ &&
    "${CURRENT_BOOTTIME_MS}" =~ ^[0-9]+$ && "${DEADLINE_BOOTTIME_MS}" =~ ^[0-9]+$ &&
    "${ARMED_BOOTTIME_MS}" =~ ^[0-9]+$ ]]
}
deadline_requires_containment() {
  local wall_remaining_milliseconds boottime_remaining_milliseconds
  [[ "${CURRENT_BOOT_ID}" == "${MARKER_BOOT_ID}" ]] || return 0
  (( CURRENT_BOOTTIME_MS >= ARMED_BOOTTIME_MS )) || return 0
  wall_remaining_milliseconds=$(((DEADLINE_EPOCH - NOW_EPOCH) * 1000))
  boottime_remaining_milliseconds=$((DEADLINE_BOOTTIME_MS - CURRENT_BOOTTIME_MS))
  (( wall_remaining_milliseconds <= DEADLINE_CONTAINMENT_GUARD_MILLISECONDS ||
    boottime_remaining_milliseconds <= DEADLINE_CONTAINMENT_GUARD_MILLISECONDS ))
}

# The deadline is evaluated before any potentially slow systemd introspection.
# At or near either clock bound, Caddy is fenced immediately; the conservative
# deadline leaves a 30-second reserve and this 25-second guard bounds the
# deadline-critical stop path inside that reserve.
load_clock_state || clock_incomplete
if [[ "$(jq --raw-output '.state' "${MARKER}")" == "starting" ]]; then
  deadline_requires_containment && contain_now
  START_DEADLINE_BOOTTIME_MS="$(jq --raw-output '.startDeadlineBoottimeMilliseconds' "${MARKER}")" || clock_incomplete
  [[ "${START_DEADLINE_BOOTTIME_MS}" =~ ^[0-9]+$ ]] || clock_incomplete
  [[ "${CURRENT_BOOT_ID}" == "${MARKER_BOOT_ID}" ]] || contain_now
  (( CURRENT_BOOTTIME_MS >= ARMED_BOOTTIME_MS && CURRENT_BOOTTIME_MS < START_DEADLINE_BOOTTIME_MS )) || contain_now
  # The bounded Docker start owns no watchdog lock. While it is inside this
  # five-second mini-window, scheduled ticks remain live but need not refresh
  # the receipt. The runner must publish `armed_running` before ingress.
  exit 0
fi
deadline_requires_containment && contain_now

# Only a comfortably pre-deadline tick performs the effective-unit audit.  The
# production path reads each unit in one bounded systemctl call, not one call
# per property. Re-read both clocks afterwards so slow-but-successful
# introspection can only shorten, never extend, the public interval.
effective_units_valid || clock_incomplete
load_clock_state || clock_incomplete
deadline_requires_containment && contain_now

if preflight_receipt_matches_marker && preflight_receipt_pending_absent; then
  exit 0
fi
marker_state="$(jq --raw-output '.state' "${MARKER}")" || clock_incomplete
if [[ "${marker_state}" == "armed_running" ]]; then
  # The runner's bounded start transition changes only the marker hash. A
  # controlled receipt with the exact immutable identity may be rebound once;
  # a missing/substituted receipt after Caddy starts is containment, not a new
  # authority publication.
  preflight_receipt_identity_matches_marker || clock_incomplete
elif [[ "${marker_state}" != "armed" ]]; then
  clock_incomplete
fi
durable_preflight_receipt || clock_incomplete
exit 0
