#!/usr/bin/env bash

# Shared, non-secret operator contract for the dedicated RefundDesk sandbox host.
# Defaults are intentionally fixed so an accidental invocation cannot target an
# unrelated Compose project. Callers may override paths through the documented
# REFUNDDESK_* variables only when testing a disposable host.

set -Eeuo pipefail
umask 077

readonly REFUNDDESK_ROOT="${REFUNDDESK_ROOT:-/opt/refunddesk}"
readonly REFUNDDESK_CONFIG_ROOT="${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}"
readonly REFUNDDESK_COMPOSE_FILE="${REFUNDDESK_COMPOSE_FILE:-${REFUNDDESK_ROOT}/current/deploy/lightsail/compose.yml}"
readonly REFUNDDESK_COMPOSE_PROJECT="${REFUNDDESK_COMPOSE_PROJECT:-refunddesk}"
readonly REFUNDDESK_RELEASE_ENV="${REFUNDDESK_RELEASE_ENV:-${REFUNDDESK_CONFIG_ROOT}/release.env}"
readonly REFUNDDESK_OPERATOR_LOCK="${REFUNDDESK_OPERATOR_LOCK:-/run/lock/refunddesk-operator.lock}"

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

acquire_operator_lock() {
  require_command flock
  mkdir -p -- "$(dirname -- "${REFUNDDESK_OPERATOR_LOCK}")"
  exec 9>"${REFUNDDESK_OPERATOR_LOCK}"
  flock --exclusive --timeout 30 9 || die "another RefundDesk operator action holds the lock"
}
