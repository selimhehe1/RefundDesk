#!/usr/bin/env bash

# Database bootstrap contract:
# - Compose project/file come from _common.sh.
# - /etc/refunddesk/postgres.env contains only non-runtime settings and
#   POSTGRES_PASSWORD_FILE; it is root:root 0600.
# - Five root-only files below /etc/refunddesk/secrets are mounted only into
#   one-shot bootstrap (and the owner file into PostgreSQL for initdb).
# - The Compose bootstrap service uses postgres:18.4, TLS verify-full and psql
#   to create/repair exactly four restricted LOGIN roles. It receives no password through
#   argv or a long-lived container environment.
# - Only the maintenance capability role and its login membership are created
#   before migration so a fresh database can authenticate the isolated runner.
#   All schemas, RLS and capability grants remain owned by the release migration.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_root
for command in docker jq readlink stat; do
  require_command "${command}"
done

TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
DATABASE_BOOTSTRAP_CONTRACT="${REFUNDDESK_DATABASE_BOOTSTRAP_CONTRACT:-standalone}"
if [[ "${DATABASE_BOOTSTRAP_CONTRACT}" == "release-v2" ]]; then
  [[ "${REFUNDDESK_RELEASE_LAUNCHER_CONTRACT:-}" == "2" ]] ||
    die "release database bootstrap lacks the stable launcher contract"
  [[ "${REFUNDDESK_REVISION:-}" =~ ^[0-9a-f]{40}$ ]] ||
    die "release database bootstrap revision is invalid"
  EXPECTED_SOURCE="${REFUNDDESK_ROOT}/releases/${REFUNDDESK_REVISION}/source"
  [[ "${SCRIPT_DIR}" == "${EXPECTED_SOURCE}/deploy/lightsail/scripts" ]] ||
    die "release database bootstrap is not running from the exact target source"
  [[ "${REFUNDDESK_COMPOSE_FILE}" == "${EXPECTED_SOURCE}/deploy/lightsail/compose.yml" ]] ||
    die "release database bootstrap Compose file differs from its target source"
  assert_root_secret_file "${TRANSITION_JOURNAL}"
  jq --exit-status --arg revision "${REFUNDDESK_REVISION}" '
    type == "object"
    and keys == ["from","schemaVersion","status","to"]
    and .schemaVersion == 1
    and .status == "in_progress"
    and .to.revision == $revision
  ' "${TRANSITION_JOURNAL}" >/dev/null ||
    die "release database bootstrap journal differs from the exact target"
  mapfile -t release_lines <"${REFUNDDESK_RELEASE_ENV}"
  (( ${#release_lines[@]} == 3 )) &&
    [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${REFUNDDESK_REVISION}" ]] &&
    [[ "${release_lines[1]}" == "REFUNDDESK_REVISION=${REFUNDDESK_REVISION}" ]] &&
  [[ "${release_lines[2]}" == "REFUNDDESK_RUNTIME_RESTART_POLICY=no" ]] ||
    die "release database bootstrap environment is not transition-fenced"
  DATABASE_OWNER_REVISION="${REFUNDDESK_REVISION}"
elif [[ "${DATABASE_BOOTSTRAP_CONTRACT}" == "ci-v2" ]]; then
  [[ "${CI:-}" == "true" && "${GITHUB_ACTIONS:-}" == "true" ]] ||
    die "CI database bootstrap is restricted to GitHub Actions"
  [[ -n "${GITHUB_WORKSPACE:-}" &&
    "${REFUNDDESK_ROOT}" == "${GITHUB_WORKSPACE}" &&
    "${SCRIPT_DIR}" == "${GITHUB_WORKSPACE}/deploy/lightsail/scripts" &&
    "${REFUNDDESK_COMPOSE_FILE}" == "${GITHUB_WORKSPACE}/deploy/lightsail/compose.yml" &&
    "${REFUNDDESK_COMPOSE_PROJECT}" == "refunddesk-ci" ]] ||
    die "CI database bootstrap paths or project are inconsistent"
  acquire_operator_lock
  [[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]] ||
    die "CI database bootstrap is blocked by an unfinished release"
  assert_root_secret_file "${REFUNDDESK_RELEASE_ENV}"
  mapfile -t release_lines <"${REFUNDDESK_RELEASE_ENV}"
  (( ${#release_lines[@]} == 2 )) &&
    [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-ci" ]] &&
  [[ "${release_lines[1]}" == "REFUNDDESK_REVISION=0000000000000000000000000000000000000000" ]] ||
    die "CI database bootstrap release environment is inconsistent"
  DATABASE_OWNER_REVISION="0000000000000000000000000000000000000000"
elif [[ "${DATABASE_BOOTSTRAP_CONTRACT}" == "standalone" ]]; then
  acquire_operator_lock
  [[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]] ||
    die "standalone database bootstrap is blocked by an unfinished release"
  ACTIVE_REVISION_FILE="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
  CURRENT_LINK="${REFUNDDESK_ROOT}/current"
  assert_root_control_file "${ACTIVE_REVISION_FILE}"
  assert_root_secret_file "${REFUNDDESK_RELEASE_ENV}"
  mapfile -t active_lines <"${ACTIVE_REVISION_FILE}"
  (( ${#active_lines[@]} == 1 )) &&
    [[ "${active_lines[0]}" =~ ^[0-9a-f]{40}$ ]] ||
    die "standalone database bootstrap active revision is invalid"
  ACTIVE_REVISION="${active_lines[0]}"
  [[ -L "${CURRENT_LINK}" && "$(stat --format='%u' -- "${CURRENT_LINK}")" == "0" ]] ||
    die "standalone database bootstrap current source is not root-owned"
  CURRENT_SOURCE="$(readlink --canonicalize-existing -- "${CURRENT_LINK}")"
  EXPECTED_SOURCE="${REFUNDDESK_ROOT}/releases/${ACTIVE_REVISION}/source"
  [[ "${CURRENT_SOURCE}" == "${EXPECTED_SOURCE}" &&
    "${SCRIPT_DIR}" == "${EXPECTED_SOURCE}/deploy/lightsail/scripts" ]] ||
    die "standalone database bootstrap source selection is inconsistent"
  RESOLVED_COMPOSE_FILE="$(
    readlink --canonicalize-existing -- "${REFUNDDESK_COMPOSE_FILE}"
  )"
  [[ "${RESOLVED_COMPOSE_FILE}" == "${EXPECTED_SOURCE}/deploy/lightsail/compose.yml" ]] ||
    die "standalone database bootstrap Compose selection is inconsistent"
  mapfile -t release_lines <"${REFUNDDESK_RELEASE_ENV}"
  (( ${#release_lines[@]} == 2 )) &&
    [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${ACTIVE_REVISION}" ]] &&
    [[ "${release_lines[1]}" == "REFUNDDESK_REVISION=${ACTIVE_REVISION}" ]] ||
    die "standalone database bootstrap release environment is inconsistent"
  DATABASE_OWNER_REVISION="${ACTIVE_REVISION}"
else
  die "database bootstrap invocation contract is invalid"
fi

POSTGRES_ENV="${REFUNDDESK_CONFIG_ROOT}/postgres.env"
assert_root_secret_file "${POSTGRES_ENV}"
SECRETS_ROOT="${REFUNDDESK_CONFIG_ROOT}/secrets"
for secret_name in \
  postgres-owner-password \
  postgres-web-password \
  postgres-worker-password \
  postgres-queue-password \
  postgres-maintenance-password; do
  assert_root_secret_file "${SECRETS_ROOT}/${secret_name}"
done

refunddesk_compose config --quiet
refunddesk_compose up --detach --no-build --pull never postgres
assert_postgres_root_mount_contract

deadline=$((SECONDS + 120))
until refunddesk_compose exec --no-TTY postgres \
  pg_isready --quiet --username=refunddesk_owner --dbname=refunddesk; do
  (( SECONDS < deadline )) || die "PostgreSQL did not become ready within 120 seconds"
  sleep 2
done

clear_database_owner_job_reservation
refunddesk_compose --profile release run \
  --name "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" \
  --no-deps \
  --pull never \
  bootstrap
seal_database_owner_job_reservation bootstrap "${DATABASE_OWNER_REVISION}"

log "PostgreSQL is ready and exactly four restricted application logins were repaired"
