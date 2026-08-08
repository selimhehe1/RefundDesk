#!/usr/bin/env bash

# CI-only destructive contract test for the global database-owner Docker name.
# It proves that the PostgreSQL 18 image VOLUME declaration cannot leave an
# anonymous volume on either the completed synthetic job or the inert sentinel.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

[[ "${CI:-}" == "true" && "${GITHUB_ACTIONS:-}" == "true" ]] ||
  die "database-owner reservation contract test is CI-only"
[[ "${REFUNDDESK_COMPOSE_PROJECT}" == "refunddesk-ci" ]] ||
  die "database-owner reservation contract test requires the isolated refunddesk-ci project"

require_root
require_command docker
require_command jq

readonly TEST_REVISION="0000000000000000000000000000000000000000"

volume_inventory() {
  docker volume ls --quiet | LC_ALL=C sort
}

remove_test_containers() {
  local container_id ids_output service
  local -a container_ids

  for service in migrate database-owner-reservation; do
    ids_output="$(
      docker container ls --all --quiet \
        --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
        --filter "label=com.docker.compose.service=${service}"
    )" || continue
    container_ids=()
    if [[ -n "${ids_output}" ]]; then
      mapfile -t container_ids <<<"${ids_output}"
    fi
    for container_id in "${container_ids[@]}"; do
      [[ -n "${container_id}" ]] || continue
      docker rm --force --volumes "${container_id}" >/dev/null 2>&1 || true
    done
  done
}

finish() {
  local status="$?"

  trap - EXIT
  remove_test_containers
  exit "${status}"
}
trap finish EXIT

remove_test_containers
before_volumes="$(volume_inventory)"

completed_id="$(
  docker create \
    --pull=never \
    --name "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" \
    --label "com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
    --label "com.docker.compose.service=migrate" \
    --label "com.refunddesk.revision=${TEST_REVISION}" \
    --network none \
    --restart=no \
    --entrypoint /bin/true \
    postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296
)" || die "synthetic completed database-owner job could not be created"
[[ -n "${completed_id}" ]] || die "Docker returned no synthetic completed job ID"

docker inspect "${completed_id}" |
  jq --exit-status 'any(.[0].Mounts[]?; .Type == "volume")' >/dev/null ||
  die "synthetic PostgreSQL 18 job did not exercise its declared anonymous VOLUME"
docker start --attach "${completed_id}" >/dev/null ||
  die "synthetic database-owner job did not complete successfully"

seal_database_owner_job_reservation migrate "${TEST_REVISION}"
assert_database_owner_job_reservation "${TEST_REVISION}"
docker inspect -- "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}" |
  jq --exit-status '
    length == 1
    and .[0].Config.AttachStdin == false
    and .[0].Config.AttachStdout == true
    and .[0].Config.AttachStderr == true
    and .[0].Config.Tty == false
    and .[0].Config.OpenStdin == false
    and .[0].Config.StdinOnce == false
  ' >/dev/null ||
  die "database-owner reservation attachment contract is not canonical"
[[ "$(volume_inventory)" == "${before_volumes}" ]] ||
  die "sealing the database-owner reservation leaked an anonymous Docker volume"

clear_database_owner_job_reservation
[[ "$(volume_inventory)" == "${before_volumes}" ]] ||
  die "clearing the database-owner reservation leaked an anonymous Docker volume"

log "database-owner reservation leaves no anonymous PostgreSQL 18 volume"
