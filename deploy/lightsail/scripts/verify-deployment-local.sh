#!/usr/bin/env bash

# Contained candidate verification.  Every probe stays inside an existing
# container or a disposable Docker network-none Caddy process.  This script has
# no viewer/public endpoint argument and cannot authorize ingress.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
REVISION=""
EXPECTED_POSTGRES_ID=""
EXPECTED_DATABASE_SHA256=""
COMPOSE_FILE="${SOURCE_ROOT}/deploy/lightsail/compose.yml"
RELEASE_ENV="${REFUNDDESK_RELEASE_ENV:-${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}/release.env}"
readonly CADDY_REFERENCE="caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648"

usage() {
  cat <<'EOF'
Usage: sudo bash verify-deployment-local.sh \
  --revision FULL_SHA --expected-postgres-id 64HEX --expected-database-sha256 64HEX \
  [--compose-file FILE] [--release-env FILE]

Only the contained postgres/verifier/web runtime and the isolated origin-token
fixture are tested. There is deliberately no public hostname or edge option.
EOF
}

die_early() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

while (( $# > 0 )); do
  case "$1" in
    --revision)
      (( $# >= 2 )) || die_early "--revision requires a value"
      REVISION="$2"
      shift 2
      ;;
    --expected-postgres-id)
      (( $# >= 2 )) || die_early "--expected-postgres-id requires a value"
      EXPECTED_POSTGRES_ID="$2"
      shift 2
      ;;
    --expected-database-sha256)
      (( $# >= 2 )) || die_early "--expected-database-sha256 requires a value"
      EXPECTED_DATABASE_SHA256="$2"
      shift 2
      ;;
    --compose-file)
      (( $# >= 2 )) || die_early "--compose-file requires a value"
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --release-env)
      (( $# >= 2 )) || die_early "--release-env requires a value"
      RELEASE_ENV="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die_early "unknown argument: $1" ;;
  esac
done

[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || die_early "revision must be a full lowercase Git SHA"
[[ "${EXPECTED_POSTGRES_ID}" =~ ^[0-9a-f]{64}$ ]] || die_early "expected PostgreSQL ID is invalid"
[[ "${EXPECTED_DATABASE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die_early "expected database SHA-256 is invalid"
export REFUNDDESK_COMPOSE_FILE="${COMPOSE_FILE}"
export REFUNDDESK_RELEASE_ENV="${RELEASE_ENV}"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_root
for command_name in awk docker grep jq sha256sum ss systemctl timeout tr; do
  require_command "${command_name}"
done
assert_root_control_file "${COMPOSE_FILE}"
assert_root_secret_file "${RELEASE_ENV}"
assert_root_secret_file "${SOURCE_ROOT}/.refunddesk-revision"
[[ "$(<"${SOURCE_ROOT}/.refunddesk-revision")" == "${REVISION}" ]] ||
  die "source revision marker differs from the candidate"

mapfile -t release_lines <"${RELEASE_ENV}"
(( ${#release_lines[@]} == 3 || ${#release_lines[@]} == 4 )) ||
  die "contained release environment must contain three or four exact lines"
[[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${REVISION}" &&
  "${release_lines[1]}" == "REFUNDDESK_REVISION=${REVISION}" ]] ||
  die "contained release environment is not revision-bound"
if (( ${#release_lines[@]} == 4 )); then
  [[ "${release_lines[2]}" == "REFUNDDESK_RUNTIME_RESTART_POLICY=no" ]] ||
    die "contained release environment has an unsafe third line"
  [[ "${release_lines[3]}" == "REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission" ]] ||
    die "contained release environment has an invalid worker mode"
else
  [[ "${release_lines[2]}" == "REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission" ]] ||
    die "contained release environment has an invalid worker mode"
fi

database_snapshot() {
  local postgres_id="$1" output compact
  output="$(timeout 25 docker exec --env PSQL_HISTORY=/dev/null "${postgres_id}" \
    psql --host=/var/run/postgresql --username=refunddesk_owner --dbname=refunddesk \
      --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
      --command="
        BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
        SET LOCAL statement_timeout = '15s';
        SET LOCAL lock_timeout = '5s';
        SET LOCAL transaction_read_only = on;
        SELECT concat_ws('|',
          (SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
          (SELECT count(*) FROM public.refund_requests WHERE workflow_status IN
            ('pending_approval','approved','executing','reconciliation_required')),
          (SELECT count(*) FROM public.refund_requests WHERE payment_guard_released_at IS NULL),
          (SELECT count(*) FROM pgboss.job WHERE name = 'refunddesk_refund_execute'
            AND state::text IN ('created','retry','active')),
          (SELECT count(*) FROM public.tenants WHERE live_enabled),
          (SELECT count(*) FROM public.stripe_installations WHERE environment = 'live'),
          (SELECT count(*) FROM pg_catalog.pg_prepared_xacts),
          (SELECT count(*) FROM public.refund_requests),
          (SELECT count(*) FROM public.refund_executions),
          (SELECT count(*) FROM public.refund_execution_attempts),
          (SELECT count(*) FROM public.webhook_receipts),
          (SELECT count(*) FROM public.api_mutation_receipts),
          (SELECT count(*) FROM public.audit_events));
        ROLLBACK;
      ")" || die "database containment snapshot is unavailable"
  compact="$(printf '%s' "${output}" | tr -d '[:space:]')"
  [[ "${compact}" =~ ^[1-9][0-9]{17,19}(\|[0-9]+){12}$ ]] ||
    die "database containment snapshot is malformed"
  printf '%s' "${compact}"
}

container_id_for() {
  local service="$1" ids
  ids="$(docker container ls --all --no-trunc --quiet \
    --filter "label=com.docker.compose.project=${REFUNDDESK_COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=${service}")" ||
    die "${service} inventory is unavailable"
  [[ "${ids}" =~ ^[0-9a-f]{64}$ ]] || die "exactly one ${service} container is required"
  printf '%s' "${ids}"
}

assert_service() {
  local service="$1" expected_running="$2" expected_reference="$3" id inspection expected_image_id
  id="$(container_id_for "${service}")"
  expected_image_id="$(docker image inspect --format '{{.Id}}' -- "${expected_reference}")" ||
    die "${service} expected image is unavailable"
  [[ "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "${service} expected image ID is invalid"
  inspection="$(docker inspect "${id}")" || die "${service} inspection failed"
  jq --exit-status \
    --arg project "${REFUNDDESK_COMPOSE_PROJECT}" \
    --arg revision "${REVISION}" \
    --arg service "${service}" \
    --arg reference "${expected_reference}" \
    --arg imageId "${expected_image_id}" \
    --argjson running "${expected_running}" '
      length == 1
      and .[0].Config.Labels["com.docker.compose.project"] == $project
      and .[0].Config.Labels["com.docker.compose.service"] == $service
      and .[0].Config.Labels["com.refunddesk.revision"] == $revision
      and .[0].Config.Image == $reference
      and .[0].Image == $imageId
      and .[0].HostConfig.RestartPolicy.Name == "no"
      and (if $service == "worker" then
        ([.[0].Config.Env[]? | select(startswith("REFUNDDESK_WORKER_RUNTIME_MODE="))]
          == ["REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission"])
      else true end)
      and .[0].State.Running == $running
      and (if $running then .[0].State.Status == "running" else .[0].State.Status != "running" end)
      and (if $running and .[0].State.Health != null then .[0].State.Health.Status == "healthy" else true end)
    ' <<<"${inspection}" >/dev/null || die "${service} violates the contained runtime contract"
  printf '%s' "${id}"
}

postgres_id="$(container_id_for postgres)"
[[ "${postgres_id}" == "${EXPECTED_POSTGRES_ID}" ]] || die "PostgreSQL container identity changed"
postgres_reference="$(docker inspect --format '{{.Config.Image}}' "${postgres_id}")"
[[ "${postgres_reference}" == postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296 ]] ||
  die "PostgreSQL image reference changed"
postgres_image_id="$(docker image inspect --format '{{.Id}}' -- "${postgres_reference}")"
postgres_inspection="$(docker inspect "${postgres_id}")"
jq --exit-status --arg imageId "${postgres_image_id}" '
  length == 1
  and .[0].Image == $imageId
  and .[0].State.Running == true
  and .[0].State.Health.Status == "healthy"
' <<<"${postgres_inspection}" >/dev/null || die "PostgreSQL is not healthy"

web_id="$(assert_service web true "refunddesk-web:sandbox-${REVISION}")"
verifier_id="$(assert_service verifier true "${CADDY_REFERENCE}")"
worker_id="$(assert_service worker false "refunddesk-worker:sandbox-${REVISION}")"
caddy_id="$(assert_service caddy false "${CADDY_REFERENCE}")"

docker exec "${web_id}" node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:3000/api/ready", {
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200) process.exit(1);
' >/dev/null || die "internal web readiness probe failed"
docker exec "${verifier_id}" wget --quiet --spider http://127.0.0.1:2019/config/ ||
  die "internal verifier administration probe failed"

for environment_file in \
  "${REFUNDDESK_CONFIG_ROOT}/platform.env" \
  "${REFUNDDESK_CONFIG_ROOT}/worker.env"; do
  assert_root_secret_file "${environment_file}"
  [[ "$(grep --count --fixed-strings --line-regexp 'REFUNDDESK_GLOBAL_LIVE_ENABLED=false' "${environment_file}")" == "1" ]] ||
    die "global live interlock is not disabled"
done
[[ "$(grep --count --fixed-strings --line-regexp 'STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled' \
  "${REFUNDDESK_CONFIG_ROOT}/platform.env")" == "1" ]] || die "live webhook interlock is not disabled"

for unit in refunddesk-backup.timer refunddesk-retention.timer; do
  [[ "$(systemctl is-enabled "${unit}" 2>/dev/null || true)" == "disabled" ]] ||
    die "${unit} is not disabled"
done
for unit in \
  refunddesk-backup.timer refunddesk-retention.timer \
  refunddesk-backup.service refunddesk-retention.service \
  refunddesk-quiesce-recovery.service; do
  systemctl is-active --quiet "${unit}" && die "${unit} is active"
done
for protocol in tcp udp; do
  for port in 80 443; do
    if [[ "${protocol}" == "tcp" ]]; then
      listener="$(ss -H -ltn "( sport = :${port} )")" || die "TCP listener inventory failed"
    else
      listener="$(ss -H -lun "( sport = :${port} )")" || die "UDP listener inventory failed"
    fi
    [[ -z "${listener}" ]] || die "a forbidden ${protocol}/${port} listener is active"
  done
done

database_line="$(database_snapshot "${postgres_id}")"
database_sha256="$(printf '%s' "${database_line}" | sha256sum | awk '{print $1}')"
[[ "${database_sha256}" == "${EXPECTED_DATABASE_SHA256}" ]] ||
  die "database identity or financial counts changed"
IFS='|' read -r system_identifier active_workflows unreleased_guards active_jobs \
  live_tenants live_installations prepared_transactions refund_requests refund_executions \
  refund_execution_attempts webhook_receipts api_mutation_receipts audit_events <<<"${database_line}"
(( active_workflows == 0 && unreleased_guards == 0 && active_jobs == 0 &&
  live_tenants == 0 && live_installations == 0 && prepared_transactions == 0 )) ||
  die "database is not financially quiescent"

"${SCRIPT_DIR}/test-caddy-origin-contract.sh" \
  --revision "${REVISION}" \
  --caddyfile "${SOURCE_ROOT}/deploy/lightsail/Caddyfile.public" \
  --caddy-env "${REFUNDDESK_CONFIG_ROOT}/caddy.env" >/dev/null ||
  die "isolated Caddy origin contract failed"

jq --compact-output --sort-keys --null-input \
  --arg revision "${REVISION}" \
  --arg databaseSha256 "${database_sha256}" \
  --arg systemIdentifier "${system_identifier}" \
  --arg postgres "${postgres_id}" --arg verifier "${verifier_id}" --arg web "${web_id}" \
  --arg worker "${worker_id}" --arg caddy "${caddy_id}" \
  --argjson activeWorkflows "${active_workflows}" \
  --argjson unreleasedPaymentGuards "${unreleased_guards}" \
  --argjson activeFinancialJobs "${active_jobs}" \
  --argjson liveTenants "${live_tenants}" \
  --argjson liveInstallations "${live_installations}" \
  --argjson preparedTransactions "${prepared_transactions}" \
  --argjson refundRequests "${refund_requests}" \
  --argjson refundExecutions "${refund_executions}" \
  --argjson refundExecutionAttempts "${refund_execution_attempts}" \
  --argjson webhookReceipts "${webhook_receipts}" \
  --argjson apiMutationReceipts "${api_mutation_receipts}" \
  --argjson auditEvents "${audit_events}" '{
    database: {
      activeFinancialJobs: $activeFinancialJobs,
      activeWorkflows: $activeWorkflows,
      apiMutationReceipts: $apiMutationReceipts,
      auditEvents: $auditEvents,
      liveInstallations: $liveInstallations,
      liveTenants: $liveTenants,
      preparedTransactions: $preparedTransactions,
      refundExecutionAttempts: $refundExecutionAttempts,
      refundExecutions: $refundExecutions,
      refundRequests: $refundRequests,
      snapshotSha256: $databaseSha256,
      stable: true,
      systemIdentifier: $systemIdentifier,
      unreleasedPaymentGuards: $unreleasedPaymentGuards,
      webhookReceipts: $webhookReceipts
    },
    kind: "refunddesk-contained-local-verification",
    revision: $revision,
    runtime: {
      caddyContainerId: $caddy,
      postgresContainerId: $postgres,
      verifierContainerId: $verifier,
      webContainerId: $web,
      workerContainerId: $worker,
      workerRuntimeMode: "incident_admission"
    },
    schemaVersion: 1
  }'
