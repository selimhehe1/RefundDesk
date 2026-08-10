#!/usr/bin/env bash

# ADR 0037 bounded CloudFront-to-Lightsail evidence runner. Every external
# boundary is expressed as a small command operation so contract tests can run
# without AWS, SSH, payment-provider or network access. The production wrapper pins the
# exact runner and invokes the same operation order with real command tools.

set -Eeuo pipefail
set +x
set +a
umask 077
export LC_ALL=C

readonly EXIT_FAIL=20
readonly EXIT_INCOMPLETE=21
readonly EXIT_USAGE=64
readonly CHECKPOINT_TIMEOUT_STATUS=22
readonly MAX_WINDOW_SECONDS=300
readonly MIN_WINDOW_SECONDS=60
readonly WATCHDOG_CONTAINMENT_RESERVE_SECONDS=30
readonly MAX_FRAGMENT_BYTES=32768
readonly MAX_OUTPUT_BYTES=262144
readonly FINAL_POSTFLIGHT_WAIT_SECONDS=300
readonly MIN_POSTFLIGHT_REMAINING_SECONDS=720
readonly MAX_ADMISSION_REMAINING_SECONDS=900
readonly EXECUTION_MAX_SECONDS=2100
readonly OPERATOR_HANDOFF_RESERVE_SECONDS=240
# Six production legs can precede a completed origin bind: AWS get (30+5),
# host token install (210+5), AWS update (30+5), deploy wait (420+5), AWS
# readback (30+5), and stopped-Caddy recreation (210+5). Keep their exact
# 960-second process budget plus 60 seconds for bounded local publication and
# parsing before creating the first origin intent.
readonly ORIGIN_BIND_MINIMUM_REMAINING_SECONDS=1020
readonly WATCHDOG_ARM_MINIMUM_REMAINING_SECONDS=30
readonly CADDY_START_MINIMUM_REMAINING_SECONDS=30
readonly FIREWALL_OPEN_MINIMUM_REMAINING_SECONDS=30
readonly FIREWALL_OPEN_MUTATION_SECONDS=10
readonly FIREWALL_OPEN_READBACK_SECONDS=10
readonly FIREWALL_CLOSE_RESERVE_SECONDS=10
readonly FIREWALL_CLOSE_TOTAL_SECONDS=45
readonly FIREWALL_CLOSE_MUTATION_SECONDS=8
readonly FIREWALL_CLOSE_READBACK_SECONDS=8
readonly FIREWALL_CLOSE_EXTRA_LIMIT=8
readonly ADAPTER_OPERATION_TIMEOUT_SECONDS=5
readonly PASS_CODE="PASS_EDGE_WINDOW_RECONTAINED"

usage() {
  exit "${EXIT_USAGE}"
}

MODE="run"
NONCE=""
EXPECTED_REVISION=""
CONTROL_FILE=""
CHECKPOINT_FILE=""
CHECKPOINT_REQUEST_FILE=""
TRANSPORT_FILE=""
LOCAL_CONTROL_ROOT=""
LOCAL_RUNTIME_ROOT=""
while (( $# > 0 )); do
  case "$1" in
    --mode)
      (( $# >= 2 )) || usage
      MODE="$2"
      shift 2
      ;;
    --nonce)
      (( $# >= 2 )) || usage
      NONCE="$2"
      shift 2
      ;;
    --expected-revision)
      (( $# >= 2 )) || usage
      EXPECTED_REVISION="$2"
      shift 2
      ;;
    --control-file)
      (( $# >= 2 )) || usage
      CONTROL_FILE="$2"
      shift 2
      ;;
    --workbench-checkpoint)
      (( $# >= 2 )) || usage
      CHECKPOINT_FILE="$2"
      shift 2
      ;;
    --checkpoint-request)
      (( $# >= 2 )) || usage
      CHECKPOINT_REQUEST_FILE="$2"
      shift 2
      ;;
    --transport-file)
      (( $# >= 2 )) || usage
      TRANSPORT_FILE="$2"
      shift 2
      ;;
    --control-root)
      (( $# >= 2 )) || usage
      LOCAL_CONTROL_ROOT="$2"
      shift 2
      ;;
    --runtime-root)
      (( $# >= 2 )) || usage
      LOCAL_RUNTIME_ROOT="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done
[[ "${MODE}" == "run" || "${MODE}" == "cleanup" ]] || usage
[[ "${NONCE}" =~ ^[0-9a-f]{64}$ && "${EXPECTED_REVISION}" =~ ^[0-9a-f]{40}$ ]] || usage
[[ -n "${CONTROL_FILE}" && -n "${CHECKPOINT_FILE}" && -n "${CHECKPOINT_REQUEST_FILE}" ]] || usage

# No command stderr, secret, CIDR, identifier, path or provider payload may
# enter the evidence channel. stdout is reserved for one canonical JSON line.
exec 3>&1
exec 1>/dev/null 2>/dev/null

if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ]]; then
  (( EUID != 0 )) || usage
  TRANSPORT_FILE="${TRANSPORT_FILE:-${REFUNDDESK_EDGE_WINDOW_TRANSPORT_FILE:-}}"
  CONTROL_ROOT="${REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT:-}"
  RUNTIME_ROOT="${REFUNDDESK_EDGE_WINDOW_RUNTIME_ROOT:-}"
  COMMAND_ADAPTER="${REFUNDDESK_EDGE_WINDOW_COMMAND:-}"
  [[ "${CONTROL_ROOT}" == /tmp/refunddesk-edge-window-test-* &&
    "${RUNTIME_ROOT}" == /tmp/refunddesk-edge-window-test-* &&
    -x "${COMMAND_ADAPTER}" ]] || usage
elif [[ "${REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-}" == "1" ]]; then
  (( EUID == 10001 )) || usage
  [[ "$(id -g 2>/dev/null)" == "10001" ]] || usage
  [[ -z "${REFUNDDESK_EDGE_WINDOW_COMMAND:-}" &&
    -z "${REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT:-}" &&
    -z "${REFUNDDESK_EDGE_WINDOW_TEST_FINAL_REQUEST_CRASH:-}" &&
    -n "${TRANSPORT_FILE}" &&
    "${CONTROL_FILE}" == "/var/lib/refunddesk/input/control-${NONCE}.json" &&
    "${TRANSPORT_FILE}" == "/var/lib/refunddesk/input/transport-${NONCE}.json" &&
    "${AWS_CONFIG_FILE:-}" == "/var/lib/refunddesk/input/aws-config" &&
    "${LOCAL_CONTROL_ROOT}" == "/var/lib/refunddesk/control" &&
    "${LOCAL_RUNTIME_ROOT}" == "/run/refunddesk" ]] || usage
  CONTROL_ROOT="${LOCAL_CONTROL_ROOT}"
  RUNTIME_ROOT="${LOCAL_RUNTIME_ROOT}"
  COMMAND_ADAPTER=""
else
  usage
fi
readonly CONTROL_ROOT RUNTIME_ROOT COMMAND_ADAPTER
readonly RUN_MARKER="${CONTROL_ROOT}/edge-window-run.json"
readonly WATCHDOG_MARKER="${CONTROL_ROOT}/edge-window-watchdog.json"
readonly FACTS_FILE="${CONTROL_ROOT}/edge-window-facts-${NONCE}.json"
readonly OPERATOR_LOCK="${RUNTIME_ROOT}/operator.lock"
readonly OPERATION_ROOT="${CONTROL_ROOT}/edge-window-operation-${NONCE}"
readonly EVIDENCE_FILE="${OPERATION_ROOT}/evidence.json"

input_boundary_failure() {
  # Usage is only a fresh, provably pre-effect classification.  Once anything
  # exists at this nonce-bound durable operation path, missing/corrupt sealed
  # inputs or their ownership/mode drift are recovery ambiguity and must keep
  # the state volumes plus host interlocks intact as INCOMPLETE/21.
  if [[ -e "${OPERATION_ROOT}" || -L "${OPERATION_ROOT}" ]]; then
    exit "${EXIT_INCOMPLETE}"
  fi
  exit "${EXIT_USAGE}"
}

control_clock_contract_failure() {
  # A structurally sealed control whose monotonic grant is outside the exact
  # production contract is a complete pre-effect failure for a fresh nonce.
  # Once a durable operation exists, the same mismatch is recovery ambiguity
  # and must retain state/interlocks as INCOMPLETE/21.
  if [[ -e "${OPERATION_ROOT}" || -L "${OPERATION_ROOT}" ]]; then
    exit "${EXIT_INCOMPLETE}"
  fi
  exit "${EXIT_FAIL}"
}

OPERATION_STARTED_AT=""
OPERATION_DEADLINE_AT=""
CONTROL_OPERATION_REMAINING_SECONDS=""
CONTROL_OPERATOR_BOOT_IDENTIFIER_SHA256=""
CONTROL_OPERATOR_CONTROL_CALCULATED_MONOTONIC_MILLISECONDS=""
CONTROL_OPERATOR_STARTED_MONOTONIC_MILLISECONDS=""
CONTROL_OPERATOR_DEADLINE_MONOTONIC_MILLISECONDS=""
RUNNER_BOOT_IDENTIFIER_SHA256=""
RUNNER_STARTED_BOOTTIME_MILLISECONDS=""
RUNNER_DEADLINE_BOOTTIME_MILLISECONDS=""
RUNNER_CLOCK_OBSERVED_BOOT_IDENTIFIER_SHA256=""
RUNNER_CLOCK_OBSERVED_BOOTTIME_MILLISECONDS=""
OPERATION_CLOCK_VALID=true
STARTED_AT=""
INVOCATION_STARTED_AT=""
CONTROL_OPERATION_STARTED_AT=""
ARMED_AT=""
DEADLINE_AT=""
WINDOW_SECONDS=0
EFFECTIVE_WINDOW_SECONDS=0
WINDOW_MONOTONIC_STARTED_SECONDS=""
OPENED_AT=""
CLOSED_AT=""
COMPLETED_AT=""
RESULT="FAIL"
CODE="CONTROL_PLANE_UNAVAILABLE"
RESULT_EXIT="${EXIT_INCOMPLETE}"
STATE="prepared"
CLEANUP_STARTED=false
CLEANUP_CONVERGED=false
OUTPUT_EMITTED=false
FUNCTIONAL_GATE_PASSED=false
HOST_LEASE_ACQUIRED=false
HOST_LEASE_RECOVERY_REQUIRED=false
LOCAL_SOURCES_VALID=true
FAILURE_DIAGNOSTICS=()
LAST_OPERATION_ERROR=""
EVIDENCE_PENDING_FILE=""
EVIDENCE_AUTHORITY_SHA=""
EVIDENCE_AUTHORITY_BYTES=""
EFFECT_BUDGET_ACTIVE=false

timestamp_now() {
  if [[ -n "${COMMAND_ADAPTER}" ]]; then
    timeout --signal=TERM --kill-after=1s "${ADAPTER_OPERATION_TIMEOUT_SECONDS}s" "${COMMAND_ADAPTER}" timestamp
  else
    date --utc '+%Y-%m-%dT%H:%M:%SZ'
  fi
}

timestamp_epoch() {
  local value="$1"
  date --utc --date="${value}" '+%s'
}

timestamp_add_seconds() {
  local value="$1" seconds="$2"
  local epoch
  epoch="$(timestamp_epoch "${value}")" || return 1
  date --utc --date="@$((epoch + seconds))" '+%Y-%m-%dT%H:%M:%SZ'
}

operation_clock_epoch() {
  local observed
  if [[ -n "${COMMAND_ADAPTER}" ]]; then
    observed="$(timeout --signal=TERM --kill-after=1s "${ADAPTER_OPERATION_TIMEOUT_SECONDS}s" \
      "${COMMAND_ADAPTER}" operation-clock)" || return 1
  else
    observed="$(date --utc '+%s')" || return 1
  fi
  [[ "${observed}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${observed}"
}

read_runner_boot_clock() {
  local boot_before boot_after boottime
  if [[ -n "${COMMAND_ADAPTER}" ]]; then
    boot_before="$(timeout --signal=TERM --kill-after=1s "${ADAPTER_OPERATION_TIMEOUT_SECONDS}s" \
      "${COMMAND_ADAPTER}" boot-id)" || return 1
    boottime="$(timeout --signal=TERM --kill-after=1s "${ADAPTER_OPERATION_TIMEOUT_SECONDS}s" \
      "${COMMAND_ADAPTER}" boottime-ms)" || return 1
    boot_after="$(timeout --signal=TERM --kill-after=1s "${ADAPTER_OPERATION_TIMEOUT_SECONDS}s" \
      "${COMMAND_ADAPTER}" boot-id)" || return 1
  else
    boot_before="$(tr -d '\n' </proc/sys/kernel/random/boot_id)" || return 1
    boottime="$(awk '{printf "%.0f\n", $1 * 1000}' /proc/uptime)" || return 1
    boot_after="$(tr -d '\n' </proc/sys/kernel/random/boot_id)" || return 1
  fi
  [[ "${boot_before}" == "${boot_after}" ]] || return 1
  [[ "${boot_before}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || return 1
  [[ "${boottime}" =~ ^[0-9]+$ ]] || return 1
  RUNNER_CLOCK_OBSERVED_BOOT_IDENTIFIER_SHA256="$(printf '%s' "${boot_before}" | sha256sum | cut -d ' ' -f 1)" ||
    return 1
  [[ "${RUNNER_CLOCK_OBSERVED_BOOT_IDENTIFIER_SHA256}" =~ ^[0-9a-f]{64}$ ]] || return 1
  RUNNER_CLOCK_OBSERVED_BOOTTIME_MILLISECONDS="${boottime}"
}

initialize_runner_operation_clock() {
  local observed_epoch wall_remaining remaining
  [[ "${CONTROL_OPERATION_REMAINING_SECONDS}" =~ ^[0-9]+$ ]] || return 1
  read_runner_boot_clock || return 1
  observed_epoch="$(operation_clock_epoch)" || return 1
  wall_remaining=$(( $(timestamp_epoch "${OPERATION_DEADLINE_AT}") - observed_epoch ))
  remaining="${CONTROL_OPERATION_REMAINING_SECONDS}"
  (( wall_remaining < remaining )) && remaining="${wall_remaining}"
  (( remaining >= 1 && remaining <= EXECUTION_MAX_SECONDS - OPERATOR_HANDOFF_RESERVE_SECONDS )) || return 1
  (( RUNNER_CLOCK_OBSERVED_BOOTTIME_MILLISECONDS <= 9007199254740991 - remaining * 1000 )) || return 1
  RUNNER_BOOT_IDENTIFIER_SHA256="${RUNNER_CLOCK_OBSERVED_BOOT_IDENTIFIER_SHA256}"
  RUNNER_STARTED_BOOTTIME_MILLISECONDS="${RUNNER_CLOCK_OBSERVED_BOOTTIME_MILLISECONDS}"
  RUNNER_DEADLINE_BOOTTIME_MILLISECONDS=$((RUNNER_STARTED_BOOTTIME_MILLISECONDS + remaining * 1000))
  OPERATION_CLOCK_VALID=true
}

runner_operation_clock_still_valid() {
  read_runner_boot_clock || return 1
  [[ "${RUNNER_CLOCK_OBSERVED_BOOT_IDENTIFIER_SHA256}" == "${RUNNER_BOOT_IDENTIFIER_SHA256}" ]] || return 1
  (( RUNNER_CLOCK_OBSERVED_BOOTTIME_MILLISECONDS >= RUNNER_STARTED_BOOTTIME_MILLISECONDS )) || return 1
  (( RUNNER_CLOCK_OBSERVED_BOOTTIME_MILLISECONDS <= RUNNER_DEADLINE_BOOTTIME_MILLISECONDS ))
}

operation_budget_remaining_seconds() {
  local deadline_epoch observed_epoch wall_remaining boottime_remaining
  [[ -n "${OPERATION_DEADLINE_AT}" && "${RUNNER_STARTED_BOOTTIME_MILLISECONDS}" =~ ^[0-9]+$ &&
    "${RUNNER_DEADLINE_BOOTTIME_MILLISECONDS}" =~ ^[0-9]+$ &&
    "${RUNNER_BOOT_IDENTIFIER_SHA256}" =~ ^[0-9a-f]{64}$ ]] || return 1
  runner_operation_clock_still_valid || return 1
  deadline_epoch="$(timestamp_epoch "${OPERATION_DEADLINE_AT}")" || return 1
  observed_epoch="$(operation_clock_epoch)" || return 1
  wall_remaining=$((deadline_epoch - observed_epoch))
  boottime_remaining=$(((RUNNER_DEADLINE_BOOTTIME_MILLISECONDS - RUNNER_CLOCK_OBSERVED_BOOTTIME_MILLISECONDS) / 1000))
  (( wall_remaining < boottime_remaining )) && printf '%s\n' "${wall_remaining}" ||
    printf '%s\n' "${boottime_remaining}"
}

begin_pre_effect_budget() {
  local minimum_seconds="$1" remaining
  [[ "${minimum_seconds}" =~ ^[1-9][0-9]*$ ]] || return 1
  remaining="$(operation_budget_remaining_seconds)" || return 1
  (( remaining >= minimum_seconds )) || return 1
  EFFECT_BUDGET_ACTIVE=true
}

end_pre_effect_budget() {
  EFFECT_BUDGET_ACTIVE=false
}

abort_pre_effect_run() {
  end_pre_effect_budget
  abort_run "$@"
}

effect_timeout_seconds() {
  local requested_seconds="$1" kill_after_seconds="$2" remaining permitted
  [[ "${requested_seconds}" =~ ^[1-9][0-9]*$ && "${kill_after_seconds}" =~ ^[1-9][0-9]*$ ]] || return 1
  if [[ "${EFFECT_BUDGET_ACTIVE}" != true ]]; then
    printf '%s\n' "${requested_seconds}"
    return
  fi
  remaining="$(operation_budget_remaining_seconds)" || return 1
  permitted=$((remaining - kill_after_seconds))
  (( permitted >= 1 )) || return 1
  (( requested_seconds < permitted )) && permitted="${requested_seconds}"
  printf '%s\n' "${permitted}"
}

hash_file() {
  sha256sum -- "$1" | cut -d ' ' -f 1
}

hash_text() {
  printf '%s' "$1" | sha256sum | cut -d ' ' -f 1
}

transport_value() {
  jq --raw-output --arg name "$1" '.[$name]' "${TRANSPORT_FILE}"
}

aws_command() {
  bounded_aws_command 30 "$@"
}

bounded_aws_command() {
  local requested_seconds="$1" seconds
  shift
  seconds="$(effect_timeout_seconds "${requested_seconds}" 5)" || return 124
  timeout --signal=TERM --kill-after=5s "${seconds}s" aws --no-cli-pager --cli-connect-timeout 5 --cli-read-timeout 20 \
    --region "$(transport_value awsRegion)" "$@"
}

ssh_command() {
  local seconds
  seconds="$(effect_timeout_seconds 210 5)" || return 124
  timeout --signal=TERM --kill-after=5s "${seconds}s" ssh \
    -F "$(transport_value sshConfigPath)" \
    -o BatchMode=yes \
    -o ClearAllForwardings=yes \
    -o ConnectTimeout=10 \
    -o ConnectionAttempts=1 \
    -o IdentityAgent=none \
    -o PermitLocalCommand=no \
    -o RequestTTY=no \
    -o ServerAliveCountMax=3 \
    -o ServerAliveInterval=5 \
    -o SendEnv=-\* \
    -- "$(transport_value sshHost)" "$@"
}

production_error() {
  jq --null-input --compact-output --sort-keys --arg error "$1" '{error:$error}'
}

validate_cloudfront_route_projection() {
  local document="$1" distribution="$2" origin="$3" hostname="$4" host="$5" filter
  # shellcheck disable=SC2016 # jq variables are bound by --arg below.
  filter='
# REFUNDDESK_EDGE_CLOUDFRONT_ROUTE_BINDING_BEGIN
      def zero_associations:
        type == "object"
        and .Quantity == 0
        and ((.Items // []) == [])
        and ((keys == ["Quantity"]) or (keys == ["Items","Quantity"]));
      type == "object"
      and keys == ["Aliases","ContinuousDeploymentPolicyId","CustomErrorResponses","DefaultCacheBehavior","Enabled","Id","OrderedCacheBehaviors","OriginGroups","Origins","Staging","Status","WebACLId"]
      and .Id == $distribution and .Status == "Deployed" and .Enabled == true
      and .Staging == false
      and (.WebACLId == null or .WebACLId == "")
      and (.ContinuousDeploymentPolicyId == null or .ContinuousDeploymentPolicyId == "")
      and (.CustomErrorResponses | zero_associations)
      and (.Aliases | type == "array" and all(.[]; type == "string") and (map(ascii_downcase) | map(select(. == $hostname)) | length) == 1 and all(.[]; startswith("*.") | not))
      and (.Origins | type == "array" and (map(select(.Id == $origin)) | length) == 1)
      and ((.Origins | map(select(.Id == $origin))[0].DomainName | ascii_downcase | rtrimstr(".")) == ($host | rtrimstr(".")))
      and (.DefaultCacheBehavior | type == "object" and keys == ["FunctionAssociations","LambdaFunctionAssociations","TargetOriginId"])
      and .DefaultCacheBehavior.TargetOriginId == $origin
      and (.DefaultCacheBehavior.FunctionAssociations | zero_associations)
      and (.DefaultCacheBehavior.LambdaFunctionAssociations | zero_associations)
      and (.OriginGroups | zero_associations)
      and (.OrderedCacheBehaviors | type == "object" and (.Quantity | type == "number") and .Quantity >= 0)
      and ((.OrderedCacheBehaviors.Items // []) | type == "array")
      and ((.OrderedCacheBehaviors.Items // []) | length) == .OrderedCacheBehaviors.Quantity
      and all((.OrderedCacheBehaviors.Items // [])[];
        type == "object"
        and .TargetOriginId == $origin
        and (.FunctionAssociations | zero_associations)
        and (.LambdaFunctionAssociations | zero_associations))
# REFUNDDESK_EDGE_CLOUDFRONT_ROUTE_BINDING_END
  '
  jq --exit-status \
    --arg distribution "${distribution}" --arg origin "${origin}" \
    --arg hostname "${hostname}" --arg host "${host}" \
    "${filter}" "${document}" >/dev/null
}

production_aws_baseline() {
  local identity="${OPERATION_ROOT}/aws-identity.json"
  local instance_document="${OPERATION_ROOT}/aws-instance.json"
  local distribution_document="${OPERATION_ROOT}/aws-distribution.json"
  local account instance distribution origin public_base public_hostname resolved_host ssh_projection
  local compose_sha caddy_sha common_sha recovery_sha release_sha account_sha region_sha ssh_cidr_sha
  aws_command sts get-caller-identity --output json >"${identity}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  (( $(wc --bytes <"${identity}") <= 16384 )) || {
    production_error TOOL_UNAVAILABLE
    return
  }
  account="$(transport_value awsAccountId)"
  jq --exit-status --arg account "${account}" '
    type == "object" and keys == ["Account","Arn","UserId"]
    and .Account == $account
    and (.Arn | type == "string" and test("^arn:aws:iam::[0-9]{12}:(user|role)/"))
    and (.UserId | type == "string" and test("^[A-Z0-9:+_-]{8,128}$"))
  ' "${identity}" >/dev/null || {
    production_error TOOL_UNAVAILABLE
    return
  }
  instance="$(transport_value instanceName)"
  distribution="$(transport_value distributionId)"
  origin="$(transport_value originId)"
  public_base="$(transport_value publicBaseUrl)"
  public_hostname="$(python3 - "${public_base}" <<'PY'
import sys, urllib.parse
value=urllib.parse.urlsplit(sys.argv[1])
if value.scheme != "https" or value.username is not None or value.password is not None or value.port is not None or value.path or value.query or value.fragment or not value.hostname:
    raise SystemExit(1)
print(value.hostname.lower())
PY
)" || {
    production_error TOPOLOGY_INVALID
    return
  }
  ssh_projection="$(timeout --signal=TERM --kill-after=2s 10s ssh -G \
    -F "$(transport_value sshConfigPath)" -- "$(transport_value sshHost)" 2>/dev/null)" || {
    production_error TOPOLOGY_INVALID
    return
  }
  resolved_host="$(awk '$1 == "hostname" { if (seen++) exit 65; print tolower($2) } END { if (seen != 1) exit 65 }' <<<"${ssh_projection}")" || {
    production_error TOPOLOGY_INVALID
    return
  }
  [[ "${resolved_host}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "${resolved_host}" =~ ^[a-z0-9.-]{1,253}$ ]] || {
    production_error TOPOLOGY_INVALID
    return
  }
  [[ "${resolved_host}" == "$(transport_value targetHost | tr '[:upper:]' '[:lower:]')" ]] || {
    production_error TOPOLOGY_INVALID
    return
  }
  aws_command lightsail get-instance --instance-name "${instance}" \
    --query '{name:instance.name,publicIpAddress:instance.publicIpAddress,regionName:instance.location.regionName,state:instance.state.name}' \
    --output json >"${instance_document}" || {
    production_error TOPOLOGY_INVALID
    return
  }
  jq --exit-status --arg instance "${instance}" --arg region "$(transport_value awsRegion)" --arg host "${resolved_host}" '
    type == "object" and keys == ["name","publicIpAddress","regionName","state"]
    and .name == $instance and .regionName == $region and .state == "running"
    and (.publicIpAddress | ascii_downcase) == $host
  ' "${instance_document}" >/dev/null || {
    production_error TOPOLOGY_INVALID
    return
  }
  aws_command cloudfront get-distribution --id "${distribution}" \
    --query 'Distribution.{Aliases:DistributionConfig.Aliases.Items,ContinuousDeploymentPolicyId:DistributionConfig.ContinuousDeploymentPolicyId,CustomErrorResponses:DistributionConfig.CustomErrorResponses,DefaultCacheBehavior:DistributionConfig.DefaultCacheBehavior.{FunctionAssociations:FunctionAssociations,LambdaFunctionAssociations:LambdaFunctionAssociations,TargetOriginId:TargetOriginId},Enabled:DistributionConfig.Enabled,Id:Id,OrderedCacheBehaviors:DistributionConfig.CacheBehaviors,OriginGroups:DistributionConfig.OriginGroups,Origins:DistributionConfig.Origins.Items[].{DomainName:DomainName,Id:Id},Staging:DistributionConfig.Staging,Status:Status,WebACLId:DistributionConfig.WebACLId}' \
    --output json >"${distribution_document}" || {
    production_error TOPOLOGY_INVALID
    return
  }
  (( $(wc --bytes <"${distribution_document}") <= 2097152 )) || {
    production_error TOPOLOGY_INVALID
    return
  }
  validate_cloudfront_route_projection "${distribution_document}" "${distribution}" "${origin}" "${public_hostname}" "${resolved_host}" || {
    production_error TOPOLOGY_INVALID
    return
  }
  compose_sha="$(jq --raw-output '.provenance.sources[] | select(.path == "deploy/lightsail/compose.yml") | .sourceSha256' "${CONTROL_FILE}")"
  caddy_sha="$(jq --raw-output '.provenance.sources[] | select(.path == "deploy/lightsail/Caddyfile.public") | .sourceSha256' "${CONTROL_FILE}")"
  common_sha="$(jq --raw-output '.provenance.sources[] | select(.path == "deploy/lightsail/scripts/_common.sh") | .sourceSha256' "${CONTROL_FILE}")"
  recovery_sha="$(jq --raw-output '.provenance.sources[] | select(.path == "deploy/lightsail/scripts/recover-quiesced-runtime.sh") | .sourceSha256' "${CONTROL_FILE}")"
  release_sha="$(jq --raw-output '.provenance.sources[] | select(.path == "deploy/lightsail/scripts/release.sh") | .sourceSha256' "${CONTROL_FILE}")"
  [[ "${compose_sha}${caddy_sha}${common_sha}${recovery_sha}${release_sha}" =~ ^([0-9a-f]{64}){5}$ ]] || {
    production_error TOPOLOGY_INVALID
    return
  }
  ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '$(transport_value postgresContainerId)' '$(transport_value verifierContainerId)' '$(transport_value webContainerId)' '$(transport_value workerContainerId)' '$(transport_value caddyContainerId)' '${compose_sha}' '${caddy_sha}' '${common_sha}' '${recovery_sha}' '${release_sha}'" <<'REMOTE' >/dev/null || {
set +x
set -o pipefail
exec 2>/dev/null
revision="$1"; shift
services=(postgres verifier web worker caddy)
expected=("${@:1:5}")
source_hashes=("${@:6:5}")
for executable in awk basename cat chmod chown cp curl cut date docker grep install jq ln mktemp mv python3 readlink rm sed seq sha256sum sleep ss stat sync systemctl timeout tr wc; do
  command -v "${executable}" >/dev/null
done
docker compose version >/dev/null
test "$(readlink --canonicalize-existing /opt/refunddesk/current)" = "/opt/refunddesk/releases/${revision}"
release_root="/opt/refunddesk/releases/${revision}/source"
source_paths=(
  deploy/lightsail/compose.yml
  deploy/lightsail/Caddyfile.public
  deploy/lightsail/scripts/_common.sh
  deploy/lightsail/scripts/recover-quiesced-runtime.sh
  deploy/lightsail/scripts/release.sh
)
for index in 0 1 2 3 4; do
  path="${release_root}/${source_paths[$index]}"
  expected_hash="${source_hashes[$index]}"
  test -f "${path}" && test ! -L "${path}" && [[ "${expected_hash}" =~ ^[0-9a-f]{64}$ ]]
  test "$(sha256sum -- "${path}" | cut -d " " -f 1)" = "${expected_hash}"
done

# Re-admit the complete contained surface while the edge holder owns the host
# interlock.  The earlier incident capture is evidence, never a substitute for
# this current observation immediately before an origin mutation.
test "$(stat --format='%u:%g:%a' -- /etc/refunddesk/release.env)" = "0:0:600"
release_environment="$(</etc/refunddesk/release.env)"
expected_release_environment="$(printf 'REFUNDDESK_IMAGE_TAG=sandbox-%s\nREFUNDDESK_REVISION=%s\nREFUNDDESK_WORKER_RUNTIME_MODE=incident_admission' "${revision}" "${revision}")"
test "${release_environment}" = "${expected_release_environment}"
for binding in \
  '/etc/refunddesk/platform.env|REFUNDDESK_GLOBAL_LIVE_ENABLED=false' \
  '/etc/refunddesk/platform.env|STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled' \
  '/etc/refunddesk/worker.env|REFUNDDESK_GLOBAL_LIVE_ENABLED=false'; do
  binding_path="${binding%%|*}"
  binding_line="${binding#*|}"
  test "$(stat --format='%u:%g:%a' -- "${binding_path}")" = "0:0:600"
  test "$(grep --fixed-strings --line-regexp --count -- "${binding_line}" "${binding_path}")" = 1
done

for journal in \
  /etc/refunddesk/application-key-transition-in-progress.json \
  /etc/refunddesk/stripe-app-id-transition-in-progress.json \
  /etc/refunddesk/managed-sandbox-three-binding-transition-in-progress.json \
  /var/lib/refunddesk/control/runtime-quiesce-in-progress.json \
  /var/lib/refunddesk/control/backup-upload-in-progress.json; do
  test ! -e "${journal}" && test ! -L "${journal}"
done
shopt -s nullglob
runtime_markers=(/run/refunddesk-release-fence-*.ready /run/refunddesk-release-candidate-*.admit)
shopt -u nullglob
(( ${#runtime_markers[@]} == 0 ))

for unit in \
  refunddesk-backup.timer refunddesk-retention.timer \
  refunddesk-backup.service refunddesk-retention.service \
  refunddesk-quiesce-recovery.service; do
  test "$(systemctl show "${unit}" --property=ActiveState --value)" = inactive
done
for timer in refunddesk-backup.timer refunddesk-retention.timer; do
  test "$(systemctl is-enabled "${timer}" 2>/dev/null)" = disabled
done
# A prior edge-window marker or merely enabled watchdog timer is an active
# interlock, even when its unit is momentarily inactive. Never overwrite or
# consume it while admitting a new nonce.
watchdog_marker=/var/lib/refunddesk/control/edge-window-watchdog.json
watchdog_preflight=/var/lib/refunddesk/control/edge-window-watchdog-preflight.json
test ! -e "${watchdog_marker}" && test ! -L "${watchdog_marker}"
test ! -e "${watchdog_preflight}" && test ! -L "${watchdog_preflight}"
test ! -e /var/lib/refunddesk/control/.edge-window-watchdog.json.pending &&
  test ! -L /var/lib/refunddesk/control/.edge-window-watchdog.json.pending
test ! -e /var/lib/refunddesk/control/edge-window-watchdog-triggered
test ! -e /run/refunddesk/edge-window-watchdog-triggered
shopt -s nullglob
watchdog_identity_transitions=(
  /var/lib/refunddesk/control/edge-window-caddy-identity-transition-*.json
  /var/lib/refunddesk/control/.edge-window-caddy-identity-transition-*.json.*
)
watchdog_marker_legacy_pendings=(/var/lib/refunddesk/control/.edge-window-install.*)
shopt -u nullglob
(( ${#watchdog_identity_transitions[@]} == 0 ))
(( ${#watchdog_marker_legacy_pendings[@]} == 0 ))
test "$(systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.timer)" = inactive
test "$(systemctl is-enabled refunddesk-edge-window-watchdog.timer 2>/dev/null)" = disabled
watchdog_service_state="$(systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.service)"
[[ "${watchdog_service_state}" == inactive || "${watchdog_service_state}" == failed ]]
release_units="$(timeout --signal=TERM --kill-after=1s 2s systemctl list-units --type=service --all --plain --no-legend 'refunddesk-release-*.service' | head --bytes=16385)"
test "${#release_units}" -lt 16385
release_unit_count=0
while read -r unit _ active _rest; do
  test -n "${unit}" || continue
  release_unit_count=$((release_unit_count + 1))
  [[ "${unit}" =~ ^refunddesk-release(-fence)?-[0-9a-f]{12}-[1-9][0-9]*\.service$ ]]
  test "${active}" = inactive
done <<<"${release_units}"
test "${release_unit_count}" -le 64
tcp_public_listeners="$(ss -H -ltn '( sport = :80 or sport = :443 )')"
udp_public_listeners="$(ss -H -lun '( sport = :80 or sport = :443 )')"
test -z "${tcp_public_listeners}"
test -z "${udp_public_listeners}"

declare -A expected_container_ids=()
for index in 0 1 2 3 4; do expected_container_ids["${expected[$index]}"]="${services[$index]}"; done
all_container_ids="$(docker container ls --all --no-trunc --quiet)"
all_container_count=0
while IFS= read -r container_id; do
  test -n "${container_id}" || continue
  [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]]
  test -n "${expected_container_ids[${container_id}]:-}"
  all_container_count=$((all_container_count + 1))
done <<<"${all_container_ids}"
(( all_container_count == 5 ))
for index in 0 1 2 3 4; do
  service="${services[$index]}"; expected_id="${expected[$index]}"
  [[ "${expected_id}" =~ ^[0-9a-f]{64}$ ]]
  ids="$(docker container ls --all --no-trunc --quiet --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service="${service}")"
  [[ "${ids}" == "${expected_id}" ]]
  inspection="$(docker inspect "${expected_id}")"
  configured_image="$(jq --raw-output '.[0].Config.Image' <<<"${inspection}")"
  resolved_image="$(docker image inspect --format '{{.Id}}' -- "${configured_image}")"
  [[ "${resolved_image}" =~ ^sha256:[0-9a-f]{64}$ ]]
  jq --exit-status --arg image "${resolved_image}" 'length == 1 and .[0].Image == $image' <<<"${inspection}" >/dev/null
  if [[ "${service}" == worker || "${service}" == caddy ]]; then
    jq --exit-status --arg id "${expected_id}" --arg service "${service}" --arg revision "${revision}" '
      length == 1 and .[0].Id == $id and .[0].State.Running == false
      and .[0].HostConfig.RestartPolicy.Name == "no"
      and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
      and .[0].Config.Labels["com.docker.compose.service"] == $service
      and .[0].Config.Labels["com.refunddesk.revision"] == $revision
    ' <<<"${inspection}" >/dev/null
  else
    jq --exit-status --arg id "${expected_id}" --arg service "${service}" --arg revision "${revision}" '
      length == 1 and .[0].Id == $id and .[0].State.Running == true and .[0].State.Health.Status == "healthy"
      and .[0].HostConfig.RestartPolicy.Name == "no"
      and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
      and .[0].Config.Labels["com.docker.compose.service"] == $service
      and .[0].Config.Labels["com.refunddesk.revision"] == $revision
    ' <<<"${inspection}" >/dev/null
  fi
  if [[ "${service}" == web || "${service}" == worker ]]; then
    jq --exit-status --arg mode "${service}" '
      .[0].Config.Env as $env
      | ([$env[] | select(. == "REFUNDDESK_GLOBAL_LIVE_ENABLED=false")] | length) == 1
      and ([$env[] | select(startswith("REFUNDDESK_GLOBAL_LIVE_ENABLED="))] | length) == 1
      and (if $mode == "worker" then
        ([$env[] | select(. == "REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission")] | length) == 1
        and ([$env[] | select(startswith("REFUNDDESK_WORKER_RUNTIME_MODE="))] | length) == 1
      else
        ([$env[] | select(. == "STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled")] | length) == 1
        and ([$env[] | select(startswith("STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET="))] | length) == 1
      end)
    ' <<<"${inspection}" >/dev/null
  fi
done
REMOTE
    production_error TOPOLOGY_INVALID
    return
  }
  rm --force -- "${identity}" "${instance_document}" "${distribution_document}"
  account_sha="$(hash_text "$(transport_value awsAccountId)")" || return 1
  region_sha="$(hash_text "$(transport_value awsRegion)")" || return 1
  ssh_cidr_sha="$(hash_text "$(transport_value expectedSshCidr)")" || return 1
  jq --null-input --compact-output --sort-keys \
    --arg accountSha256 "${account_sha}" --arg regionSha256 "${region_sha}" --arg sshCidrSha256 "${ssh_cidr_sha}" \
    '{topology:{accountMatched:true,aliasMatched:true,awsAccountIdSha256:$accountSha256,awsRegionSha256:$regionSha256,distributionDeployed:true,distributionEnabled:true,hostRevisionMatched:true,hostSourcesMatched:true,instanceMatched:true,instanceRunning:true,originDomainMatched:true,runtimeContainersMatched:true,sshCidrSha256:$sshCidrSha256,sshInstanceMatched:true}}'
}

remote_install() {
  local source="$1" destination="$2" mode="$3"
  [[ -f "${source}" && ! -L "${source}" ]] || return 1
  ssh_command "sudo sh -ceu 'umask 077; candidate=\$(mktemp /tmp/refunddesk-edge-install.XXXXXXXXXX); cat >\"\${candidate}\"; chmod ${mode} \"\${candidate}\"; chown root:root \"\${candidate}\"; sync \"\${candidate}\"; mv -f \"\${candidate}\" ${destination}; sync \$(dirname ${destination})'" \
    <"${source}" >/dev/null
}

remote_install_create_new() {
  local source="$1" destination="$2" mode="$3" create_missing="${4:-true}" expected_sha payload_base64
  [[ -f "${source}" && ! -L "${source}" ]] || return 1
  [[ "${mode}" == 0600 ]] || return 1
  [[ "${create_missing}" == true || "${create_missing}" == false ]] || return 1
  expected_sha="$(hash_file "${source}")" || return 1
  payload_base64="$(python3 - "${source}" <<'PY'
import base64
import pathlib
import sys

sys.stdout.write(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode("ascii"))
PY
  )" || return 1
  [[ "${expected_sha}" =~ ^[0-9a-f]{64}$ && "${payload_base64}" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
  ssh_command "sudo bash -seu -- '${destination}' '${expected_sha}' '${payload_base64}' '${create_missing}'" <<'REMOTE_MARKER_PUBLISH' >/dev/null
set +x
exec 2>/dev/null
python3 - "$@" <<'PY'
# REFUNDDESK_EDGE_REMOTE_MARKER_PUBLISH_PY_BEGIN
import base64
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import stat
import sys

destination = pathlib.Path(sys.argv[1])
expected_sha = sys.argv[2]
create_missing = sys.argv[4] == "true"
if sys.argv[4] not in {"true", "false"}:
    raise SystemExit(1)
try:
    expected = base64.b64decode(sys.argv[3], validate=True)
except Exception:
    raise SystemExit(1)
if hashlib.sha256(expected).hexdigest() != expected_sha or len(expected) > 4096:
    raise SystemExit(1)
directory = destination.parent
pending = directory / f".{destination.name}.pending"
legacy = sorted(directory.glob(".edge-window-install.*"))
if len(legacy) > 1:
    raise SystemExit(1)

def fsync_directory():
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def metadata(path, allowed_links=(1,)):
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.geteuid()
        or info.st_gid != os.getegid()
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_nlink not in allowed_links
        or info.st_size > 4096
    ):
        raise SystemExit(1)
    return info

def read_once(path, allowed_links=(1,)):
    before = metadata(path, allowed_links)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise SystemExit(1)
        chunks = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(4097 - total, 4096))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > 4096:
                raise SystemExit(1)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if (
        (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
        or total != opened.st_size
    ):
        raise SystemExit(1)
    return b"".join(chunks), before

def canonical_document(raw):
    def pairs(items):
        document = {}
        for key, value in items:
            if key in document:
                raise ValueError("duplicate")
            document[key] = value
        return document
    try:
        document = json.loads(raw.decode("ascii"), object_pairs_hook=pairs)
        canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
    except Exception:
        return False
    return raw == canonical

def rename_noreplace(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    function = libc.renameat2
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOSYS, errno.EINVAL}:
            raise SystemExit(1)
        raise OSError(error, os.strerror(error))

destination_exists = os.path.lexists(destination)
pending_exists = os.path.lexists(pending)
if destination_exists:
    destination_raw, destination_info = read_once(destination, (1, 2))
    if destination_info.st_nlink == 2 and destination_raw != expected:
        raise SystemExit(1)
    # Repair only the legacy link-before-unlink boundary: one exact candidate
    # and the destination must be the same two-link inode.
    if destination_info.st_nlink == 2:
        if pending_exists or len(legacy) != 1:
            raise SystemExit(1)
        legacy_raw, legacy_info = read_once(legacy[0], (2,))
        if (
            legacy_raw != expected
            or (legacy_info.st_dev, legacy_info.st_ino)
            != (destination_info.st_dev, destination_info.st_ino)
        ):
            raise SystemExit(1)
        os.unlink(legacy[0])
        fsync_directory()
        destination_raw, destination_info = read_once(destination)
        if destination_raw != expected:
            raise SystemExit(1)
    elif pending_exists or legacy:
        # A second inode beside an already published authority is never debris.
        raise SystemExit(1)
    elif create_missing and destination_raw != expected:
        raise SystemExit(1)
    raise SystemExit(0)

candidate = None
if pending_exists and legacy:
    raise SystemExit(1)
if pending_exists:
    candidate = pending
elif legacy:
    candidate = legacy[0]
if candidate is not None:
    candidate_raw, _ = read_once(candidate)
    if candidate_raw == expected:
        fsync_directory()
        rename_noreplace(candidate, destination)
        fsync_directory()
        final_raw, _ = read_once(destination)
        if final_raw != expected:
            raise SystemExit(1)
        raise SystemExit(0)
    # A complete canonical marker for another operation is an authority
    # conflict. Only an incomplete private write may be removed and retried.
    if canonical_document(candidate_raw):
        raise SystemExit(1)
    os.unlink(candidate)
    fsync_directory()

if not create_missing:
    raise SystemExit(0)

descriptor = os.open(
    pending,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    0o600,
)
try:
    offset = 0
    while offset < len(expected):
        written = os.write(descriptor, expected[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written
    os.fchmod(descriptor, 0o600)
    os.fchown(descriptor, os.geteuid(), os.getegid())
    os.fsync(descriptor)
finally:
    os.close(descriptor)
fsync_directory()
rename_noreplace(pending, destination)
fsync_directory()
final_raw, _ = read_once(destination)
if final_raw != expected:
    raise SystemExit(1)
# REFUNDDESK_EDGE_REMOTE_MARKER_PUBLISH_PY_END
PY
REMOTE_MARKER_PUBLISH
}

production_prefix_fetch() {
  local raw="${OPERATION_ROOT}/ip-ranges.raw.json"
  local allowlist="${OPERATION_ROOT}/cloudfront-origin-facing.json"
  local fetched_at document_sha allowlist_sha create_date sync_token ipv4_count ipv6_count
  fetched_at="$(timestamp_now)" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 5 --max-time 20 \
    --max-filesize 2097152 --output "${raw}" https://ip-ranges.amazonaws.com/ip-ranges.json || {
    production_error TOOL_UNAVAILABLE
    return
  }
  (( $(wc --bytes <"${raw}") <= 2097152 )) || {
    production_error PREFIX_MALFORMED
    return
  }
  python3 - "${raw}" "${allowlist}" "${fetched_at}" <<'PY' || {
import datetime
import ipaddress
import json
import os
import sys

source, target, fetched_at = sys.argv[1:]
with open(source, "rb") as stream:
    raw = stream.read()
document = json.loads(raw.decode("utf-8"))
if set(document) != {"createDate", "ipv6_prefixes", "prefixes", "syncToken"}:
    raise SystemExit(1)
if not isinstance(document["syncToken"], str) or not document["syncToken"].isdigit():
    raise SystemExit(1)
if not isinstance(document["createDate"], str):
    raise SystemExit(1)
try:
    created = datetime.datetime.strptime(document["createDate"], "%Y-%m-%d-%H-%M-%S").replace(tzinfo=datetime.timezone.utc)
    fetched = datetime.datetime.strptime(fetched_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
except ValueError:
    raise SystemExit(1)
age = fetched - created
if age < datetime.timedelta(minutes=-2) or age > datetime.timedelta(days=30):
    raise SystemExit(1)
ipv4 = []
for item in document["prefixes"]:
    if set(item) != {"ip_prefix", "network_border_group", "region", "service"}:
        raise SystemExit(1)
    if item["service"] == "CLOUDFRONT_ORIGIN_FACING":
        network = ipaddress.ip_network(item["ip_prefix"], strict=True)
        if network.version != 4 or network.prefixlen == 0:
            raise SystemExit(1)
        ipv4.append(str(network))
ipv6 = []
for item in document["ipv6_prefixes"]:
    if set(item) != {"ipv6_prefix", "network_border_group", "region", "service"}:
        raise SystemExit(1)
    if item["service"] == "CLOUDFRONT_ORIGIN_FACING":
        network = ipaddress.ip_network(item["ipv6_prefix"], strict=True)
        if network.version != 6 or network.prefixlen == 0:
            raise SystemExit(1)
        ipv6.append(str(network))
if len(ipv4) != len(set(ipv4)) or len(ipv6) != len(set(ipv6)):
    raise SystemExit(1)
ipv4 = sorted(ipv4)
ipv6 = sorted(ipv6)
if not ipv4 or not ipv6:
    raise SystemExit(1)
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
    json.dump({"createDate": created.strftime("%Y-%m-%dT%H:%M:%SZ"), "ipv4": ipv4, "ipv6": ipv6, "syncToken": document["syncToken"]}, stream, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    stream.write("\n")
    stream.flush()
    os.fsync(stream.fileno())
PY
    production_error PREFIX_MALFORMED
    return
  }
  document_sha="$(hash_file "${raw}")" || {
    production_error PREFIX_MALFORMED
    return
  }
  allowlist_sha="$(hash_file "${allowlist}")" || {
    production_error PREFIX_MALFORMED
    return
  }
  create_date="$(jq --raw-output '.createDate' "${allowlist}")"
  sync_token="$(jq --raw-output '.syncToken' "${allowlist}")"
  ipv4_count="$(jq '.ipv4 | length' "${allowlist}")"
  ipv6_count="$(jq '.ipv6 | length' "${allowlist}")"
  jq --null-input --compact-output --sort-keys \
    --arg allowlistSha256 "${allowlist_sha}" \
    --arg createDate "${create_date}" \
    --arg documentSha256 "${document_sha}" \
    --arg fetchedAt "${fetched_at}" \
    --arg syncToken "${sync_token}" \
    --argjson ipv4Count "${ipv4_count}" \
    --argjson ipv6Count "${ipv6_count}" \
    '{prefixes:{allowlistSha256:$allowlistSha256,canonical:true,createDate:$createDate,documentSha256:$documentSha256,exactService:true,fetchedAt:$fetchedAt,firewallMatched:false,fresh:true,ipv4Count:$ipv4Count,ipv6Count:$ipv6Count,service:"CLOUDFRONT_ORIGIN_FACING",source:"AWS_PUBLIC_IP_RANGES",syncToken:$syncToken}}'
}

validate_firewall_document() {
  local document="$1" expected_ssh="$2" policy="$3" allowlist="${4:-}"
  python3 - "${document}" "${expected_ssh}" "${policy}" "${allowlist}" <<'PY'
import ipaddress, json, re, sys

path, expected_ssh, policy, allowlist_path = sys.argv[1:]
with open(path, "rb") as stream:
    raw = stream.read()
if not raw or len(raw) > 262144:
    raise SystemExit(1)
document = json.loads(raw.decode("utf-8"))
if set(document) != {"portStates"} or not isinstance(document["portStates"], list):
    raise SystemExit(1)

canonical_rules = []
for rule in document["portStates"]:
    if not isinstance(rule, dict) or set(rule) != {"cidrListAliases", "cidrs", "fromPort", "ipv6Cidrs", "protocol", "state", "toPort"}:
        raise SystemExit(1)
    if isinstance(rule["fromPort"], bool) or isinstance(rule["toPort"], bool) or not isinstance(rule["fromPort"], int) or not isinstance(rule["toPort"], int):
        raise SystemExit(1)
    if rule["fromPort"] < -1 or rule["toPort"] > 65535 or rule["fromPort"] > rule["toPort"]:
        raise SystemExit(1)
    if rule["protocol"] not in {"tcp", "udp", "all", "icmp", "icmpv6"} or rule["state"] not in {"open", "closed"}:
        raise SystemExit(1)
    if not all(isinstance(rule[name], list) for name in ("cidrs", "ipv6Cidrs", "cidrListAliases")):
        raise SystemExit(1)
    if not all(isinstance(value, str) for name in ("cidrs", "ipv6Cidrs", "cidrListAliases") for value in rule[name]):
        raise SystemExit(1)
    if len(rule["cidrs"]) != len(set(rule["cidrs"])) or len(rule["ipv6Cidrs"]) != len(set(rule["ipv6Cidrs"])) or len(rule["cidrListAliases"]) != len(set(rule["cidrListAliases"])):
        raise SystemExit(1)
    try:
        ipv4 = sorted(str(ipaddress.ip_network(value, strict=True)) for value in rule["cidrs"])
        ipv6 = sorted(str(ipaddress.ip_network(value, strict=True)) for value in rule["ipv6Cidrs"])
    except ValueError:
        raise SystemExit(1)
    if any(ipaddress.ip_network(value).version != 4 for value in ipv4) or any(ipaddress.ip_network(value).version != 6 for value in ipv6):
        raise SystemExit(1)
    aliases = sorted(rule["cidrListAliases"])
    if any(re.fullmatch(r"[a-z0-9-]{1,64}", value) is None for value in aliases):
        raise SystemExit(1)
    canonical_rules.append({"cidrListAliases": aliases, "cidrs": ipv4, "fromPort": rule["fromPort"], "ipv6Cidrs": ipv6, "protocol": rule["protocol"], "state": rule["state"], "toPort": rule["toPort"]})
if len(canonical_rules) != len({json.dumps(rule, separators=(",", ":"), sort_keys=True) for rule in canonical_rules}):
    raise SystemExit(1)
open_rules = [rule for rule in canonical_rules if rule["state"] == "open"]
ssh = {"cidrListAliases": [], "cidrs": [expected_ssh], "fromPort": 22, "ipv6Cidrs": [], "protocol": "tcp", "state": "open", "toPort": 22}
if policy == "closed":
    if open_rules != [ssh]:
        raise SystemExit(1)
elif policy == "open":
    with open(allowlist_path, encoding="utf-8") as stream:
        allowlist = json.load(stream)
    https = {"cidrListAliases": [], "cidrs": allowlist["ipv4"], "fromPort": 443, "ipv6Cidrs": allowlist["ipv6"], "protocol": "tcp", "state": "open", "toPort": 443}
    if sorted(open_rules, key=lambda item: item["fromPort"]) != [ssh, https]:
        raise SystemExit(1)
else:
    raise SystemExit(1)
PY
}

validate_lightsail_operation() {
  local path="$1" expected_type="$2" instance="$3"
  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  (( $(wc --bytes <"${path}") <= 16384 )) || return 1
  jq --exit-status --arg operationType "${expected_type}" --arg instance "${instance}" '
    type == "object"
    and keys == ["errorCode","errorDetails","isTerminal","operationType","resourceName","resourceType","status"]
    and .errorCode == null and .errorDetails == null
    and .isTerminal == true and .status == "Succeeded"
    and .operationType == $operationType
    and .resourceName == $instance and .resourceType == "Instance"
  ' "${path}" >/dev/null
}

production_counts() {
  local phase="$1" counts expected_postgres
  expected_postgres="$(transport_value postgresContainerId)"
  counts="$(ssh_command "sudo bash -seu -- '${expected_postgres}'" <<'REMOTE'
set +x
exec 2>/dev/null
expected="$1"
ids="$(docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=postgres)"
test "${ids}" = "${expected}"
inspection="$(docker inspect "${expected}")"
jq --exit-status --arg id "${expected}" '
  length == 1 and .[0].Id == $id
  and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
  and .[0].Config.Labels["com.docker.compose.service"] == "postgres"
  and .[0].State.Running == true
' <<<"${inspection}" >/dev/null
  raw="$(timeout --signal=TERM --kill-after=2s 25s docker exec --env PSQL_HISTORY=/dev/null --interactive "${expected}" \
  psql --host=/var/run/postgresql --username=refunddesk_owner --dbname=refunddesk \
  --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align <<'SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SELECT json_build_object(
  'activeFinancialJobs', (SELECT count(*) FROM pgboss.job WHERE name='refunddesk_refund_execute' AND state::text IN ('active','created','retry')),
  'activeWorkflows', (SELECT count(*) FROM public.refund_requests WHERE workflow_status IN ('pending_approval','approved','executing','reconciliation_required')),
  'auditEvents', (SELECT count(*) FROM public.audit_events),
  'liveInstallations', (SELECT count(*) FROM public.stripe_installations WHERE environment='live'),
  'liveTenants', (SELECT count(*) FROM public.tenants WHERE live_enabled),
  'mutationReceipts', (SELECT count(*) FROM public.api_mutation_receipts),
  'preparedTransactions', (SELECT count(*) FROM pg_catalog.pg_prepared_xacts),
  'refundExecutionAttempts', (SELECT count(*) FROM public.refund_execution_attempts),
  'refundExecutions', (SELECT count(*) FROM public.refund_executions),
  'refundRequests', (SELECT count(*) FROM public.refund_requests),
  'systemIdentifier', (SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
  'unreleasedPaymentGuards', (SELECT count(*) FROM public.refund_requests WHERE payment_guard_released_at IS NULL),
  'webhookReceipts', (SELECT count(*) FROM public.webhook_receipts)
)::text;
ROLLBACK;
SQL
)"
system_identifier="$(jq --raw-output '.systemIdentifier' <<<"${raw}")"
[[ "${system_identifier}" =~ ^[1-9][0-9]{17,19}$ ]]
system_sha="$(printf '%s' "${system_identifier}" | sha256sum | cut -d ' ' -f 1)"
jq --compact-output --sort-keys --arg systemSha "${system_sha}" '
  {counts:{activeFinancialJobs:.activeFinancialJobs,auditEvents:.auditEvents,mutationReceipts:.mutationReceipts,
    refundExecutionAttempts:.refundExecutionAttempts,refundExecutions:.refundExecutions,
    refundRequests:.refundRequests,unreleasedPaymentGuards:.unreleasedPaymentGuards,webhookReceipts:.webhookReceipts},
   invariants:{activeWorkflows:.activeWorkflows,liveInstallations:.liveInstallations,liveTenants:.liveTenants,
    preparedTransactions:.preparedTransactions,systemIdentifierSha256:$systemSha}}
' <<<"${raw}"
REMOTE
)" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  jq --exit-status --compact-output --sort-keys '
    type == "object" and keys == ["counts","invariants"]
    and (.counts | keys == ["activeFinancialJobs","auditEvents","mutationReceipts","refundExecutionAttempts","refundExecutions","refundRequests","unreleasedPaymentGuards","webhookReceipts"]
      and all(.[]; type == "number" and floor == . and . >= 0))
    and (.invariants | keys == ["activeWorkflows","liveInstallations","liveTenants","preparedTransactions","systemIdentifierSha256"]
      and (.systemIdentifierSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (del(.systemIdentifierSha256) | all(.[]; type == "number" and floor == . and . >= 0)))
  ' <<<"${counts}" >/dev/null || {
    production_error TOOL_UNAVAILABLE
    return
  }
  jq --null-input --compact-output --sort-keys --arg phase "${phase}" --argjson value "${counts}" \
    '{counts:{($phase):$value.counts},database:{($phase):$value.invariants}}'
}

recover_local_origin_token() {
  local create_missing="$1"
  local target="${OPERATION_ROOT}/origin-token"
  local pending="${OPERATION_ROOT}/.origin-token.pending"
  [[ "${create_missing}" == true || "${create_missing}" == false ]] || return 1
  python3 - "${target}" "${pending}" "${create_missing}" <<'PY'
# REFUNDDESK_EDGE_LOCAL_ORIGIN_TOKEN_PY_BEGIN
import base64
import ctypes
import errno
import os
import re
import secrets
import stat
import sys

target, pending, create_missing = sys.argv[1:]
create_missing = create_missing == "true"
directory = os.path.dirname(target)
TOKEN = re.compile(rb"[A-Za-z0-9_-]{43}")

def fsync_directory():
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def controlled_raw(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        linked = os.lstat(path)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.geteuid()
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1
            or before.st_size > 43
            or (before.st_dev, before.st_ino) != (linked.st_dev, linked.st_ino)
        ):
            raise SystemExit(1)
        raw = bytearray()
        while len(raw) <= 43:
            chunk = os.read(descriptor, 44 - len(raw))
            if not chunk:
                break
            raw.extend(chunk)
        after = os.fstat(descriptor)
        linked_after = os.lstat(path)
        identity = lambda item: (
            item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
            item.st_ctime_ns, item.st_mode, item.st_uid, item.st_gid, item.st_nlink,
        )
        if identity(before) != identity(after) or (after.st_dev, after.st_ino) != (linked_after.st_dev, linked_after.st_ino):
            raise SystemExit(1)
        if len(raw) != before.st_size:
            raise SystemExit(1)
        return bytes(raw)
    finally:
        os.close(descriptor)

def rename_noreplace(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "renameat2", None)
    if function is None:
        raise SystemExit(1)
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOSYS, errno.EINVAL}:
            raise SystemExit(1)
        raise OSError(error, os.strerror(error))

def unlink_pending():
    os.unlink(pending)
    fsync_directory()

if os.path.lexists(target):
    current = controlled_raw(target)
    if TOKEN.fullmatch(current) is None:
        raise SystemExit(1)
    if os.path.lexists(pending):
        candidate = controlled_raw(pending)
        if TOKEN.fullmatch(candidate) is not None and candidate != current:
            # A complete different pending is another authority, not debris.
            raise SystemExit(1)
        unlink_pending()
elif os.path.lexists(pending):
    candidate = controlled_raw(pending)
    if TOKEN.fullmatch(candidate) is not None:
        fsync_directory()
        rename_noreplace(pending, target)
        fsync_directory()
    else:
        # A partial private pending was never externally authoritative.
        unlink_pending()

if create_missing and not os.path.lexists(target):
    value = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=")
    if TOKEN.fullmatch(value) is None:
        raise SystemExit(1)
    descriptor = os.open(
        pending,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        offset = 0
        while offset < len(value):
            written = os.write(descriptor, value[offset:])
            if written <= 0:
                raise OSError("short write")
            offset += written
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory()
    rename_noreplace(pending, target)
    fsync_directory()

if os.path.lexists(target):
    final = controlled_raw(target)
    if TOKEN.fullmatch(final) is None:
        raise SystemExit(1)
elif create_missing:
    raise SystemExit(1)
# REFUNDDESK_EDGE_LOCAL_ORIGIN_TOKEN_PY_END
PY
}

production_origin_host_files() {
  local mode="$1"
  local token="${OPERATION_ROOT}/origin-token"
  local token_value=""
  [[ "${mode}" == bind || "${mode}" == cleanup ]] || return 1
  if [[ -e "${token}" || -L "${token}" ]]; then
    controlled_file "${token}" || return 1
    token_value="$(<"${token}")"
    [[ "${token_value}" =~ ^[A-Za-z0-9_-]{43}$ ]] || return 1
  elif [[ "${mode}" == bind ]]; then
    return 1
  fi
  {
    printf '%s\n' "${token_value}"
    cat <<'PY_ORIGIN_HOST_FILES'
import ctypes
import errno
import os
import pathlib
import re
import stat
import sys

nonce, mode = sys.argv[1:]
if re.fullmatch(r"[0-9a-f]{64}", nonce) is None or mode not in {"bind", "cleanup"}:
    raise SystemExit(1)
token_input = bytearray()
while len(token_input) <= 44:
    chunk = os.read(3, 45 - len(token_input))
    if not chunk:
        break
    token_input.extend(chunk)
if not token_input.endswith(b"\n") or token_input.count(b"\n") != 1:
    raise SystemExit(1)
expected_token = bytes(token_input[:-1])
token_pattern = re.compile(rb"[A-Za-z0-9_-]{43}")
if expected_token and token_pattern.fullmatch(expected_token) is None:
    raise SystemExit(1)
if mode == "bind" and not expected_token:
    raise SystemExit(1)

control = pathlib.Path("/var/lib/refunddesk/control")
environment_root = pathlib.Path("/etc/refunddesk")
token_path = control / f"edge-window-origin-token-{nonce}"
token_pending = control / f".edge-window-origin-token-{nonce}.pending"
backup_path = control / f"edge-window-caddy-{nonce}.before"
backup_pending = control / f".edge-window-caddy-{nonce}.before.pending"
current_path = environment_root / "caddy.env"
candidate_path = environment_root / f".caddy.env.{nonce[:10]}"

def fsync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def controlled_raw(path, maximum=16_384):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        linked = os.lstat(path)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != 0
            or before.st_gid != 0
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1
            or before.st_size > maximum
            or (before.st_dev, before.st_ino) != (linked.st_dev, linked.st_ino)
        ):
            raise SystemExit(1)
        raw = bytearray()
        while len(raw) <= maximum:
            chunk = os.read(descriptor, min(65_536, maximum + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        after = os.fstat(descriptor)
        linked_after = os.lstat(path)
        identity = lambda item: (
            item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
            item.st_ctime_ns, item.st_mode, item.st_uid, item.st_gid, item.st_nlink,
        )
        if identity(before) != identity(after) or (after.st_dev, after.st_ino) != (linked_after.st_dev, linked_after.st_ino):
            raise SystemExit(1)
        if len(raw) != before.st_size:
            raise SystemExit(1)
        return bytes(raw)
    finally:
        os.close(descriptor)

def environment_lines(raw):
    if not raw.endswith(b"\n") or b"\r" in raw or b"\x00" in raw:
        raise ValueError("invalid environment")
    try:
        lines = raw[:-1].decode("utf-8").split("\n")
    except UnicodeDecodeError as error:
        raise ValueError("invalid environment") from error
    if len(lines) != 3:
        raise ValueError("invalid environment")
    values = {}
    for line in lines:
        if "=" not in line:
            raise ValueError("invalid environment")
        key, value = line.split("=", 1)
        if key in values or key not in {
            "REFUNDDESK_ACME_EMAIL", "REFUNDDESK_PUBLIC_HOST", "REFUNDDESK_EDGE_ORIGIN_TOKEN",
        }:
            raise ValueError("invalid environment")
        values[key] = value
    if token_pattern.fullmatch(values.get("REFUNDDESK_EDGE_ORIGIN_TOKEN", "").encode("ascii", "strict")) is None:
        raise ValueError("invalid environment")
    return lines, values

def valid_environment(raw):
    try:
        environment_lines(raw)
        return True
    except (UnicodeError, ValueError):
        return False

def rename_noreplace(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "renameat2", None)
    if function is None:
        raise SystemExit(1)
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOSYS, errno.EINVAL}:
            raise SystemExit(1)
        raise OSError(error, os.strerror(error))

def write_pending(path, raw):
    descriptor = os.open(
        path,
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
        os.fchown(descriptor, 0, 0)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(path.parent)

def unlink_pending(path):
    path.unlink()
    fsync_directory(path.parent)

def publish_pending(pending, destination):
    rename_noreplace(pending, destination)
    fsync_directory(destination.parent)

# The nonce-bound token is published before any caddy.env mutation. A complete
# foreign pending is retained as an authority conflict; only a structurally
# private partial pending may be discarded and rewritten.
if token_path.exists():
    token_raw = controlled_raw(token_path, 43)
    if token_pattern.fullmatch(token_raw) is None or not expected_token or token_raw != expected_token:
        raise SystemExit(1)
    if token_pending.exists():
        pending_raw = controlled_raw(token_pending, 43)
        if token_pattern.fullmatch(pending_raw) is not None and pending_raw != token_raw:
            raise SystemExit(1)
        unlink_pending(token_pending)
elif token_pending.exists():
    pending_raw = controlled_raw(token_pending, 43)
    if token_pattern.fullmatch(pending_raw) is not None:
        if not expected_token or pending_raw != expected_token:
            raise SystemExit(1)
        publish_pending(token_pending, token_path)
    else:
        unlink_pending(token_pending)
if mode == "bind" and not token_path.exists():
    write_pending(token_pending, expected_token)
    publish_pending(token_pending, token_path)
if token_path.exists():
    token_raw = controlled_raw(token_path, 43)
    if not expected_token or token_raw != expected_token or token_pattern.fullmatch(token_raw) is None:
        raise SystemExit(1)
elif token_pending.exists() or mode == "bind":
    raise SystemExit(1)

if not expected_token and any(path.exists() for path in (backup_path, backup_pending)):
    raise SystemExit(1)
if backup_path.exists():
    backup_raw = controlled_raw(backup_path)
    if not valid_environment(backup_raw):
        raise SystemExit(1)
    if backup_pending.exists():
        pending_raw = controlled_raw(backup_pending)
        if valid_environment(pending_raw) and pending_raw != backup_raw:
            raise SystemExit(1)
        unlink_pending(backup_pending)
elif backup_pending.exists():
    pending_raw = controlled_raw(backup_pending)
    if valid_environment(pending_raw):
        if not expected_token:
            raise SystemExit(1)
        publish_pending(backup_pending, backup_path)
        backup_raw = pending_raw
    else:
        unlink_pending(backup_pending)
if mode == "bind" and not backup_path.exists():
    current_raw = controlled_raw(current_path)
    _, current_values = environment_lines(current_raw)
    if current_values["REFUNDDESK_EDGE_ORIGIN_TOKEN"].encode("ascii") == expected_token:
        raise SystemExit(1)
    write_pending(backup_pending, current_raw)
    publish_pending(backup_pending, backup_path)
    backup_raw = current_raw

if mode == "cleanup" and expected_token:
    current_raw = controlled_raw(current_path)
    _, current_values = environment_lines(current_raw)
    if current_values["REFUNDDESK_EDGE_ORIGIN_TOKEN"].encode("ascii") == expected_token and not backup_path.exists():
        # Missing transient token is recoverable only when the currently
        # installed environment proves that no host bind took effect.
        raise SystemExit(1)

if mode == "bind":
    backup_raw = controlled_raw(backup_path)
    lines, values = environment_lines(backup_raw)
    if values["REFUNDDESK_EDGE_ORIGIN_TOKEN"].encode("ascii") == expected_token:
        raise SystemExit(1)
    candidate_lines = []
    for line in lines:
        if line.startswith("REFUNDDESK_EDGE_ORIGIN_TOKEN="):
            candidate_lines.append("REFUNDDESK_EDGE_ORIGIN_TOKEN=" + expected_token.decode("ascii"))
        else:
            candidate_lines.append(line)
    candidate_raw = ("\n".join(candidate_lines) + "\n").encode("utf-8")
    if candidate_path.exists():
        observed = controlled_raw(candidate_path)
        if valid_environment(observed) and observed != candidate_raw:
            raise SystemExit(1)
        unlink_pending(candidate_path)
    write_pending(candidate_path, candidate_raw)
    os.replace(candidate_path, current_path)
    fsync_directory(environment_root)
    if controlled_raw(current_path) != candidate_raw:
        raise SystemExit(1)
PY_ORIGIN_HOST_FILES
  } | ssh_command "sudo bash -ceu 'set +x; IFS= read -r token; exec 3<<<\"\${token}\"; unset token; exec python3 - \"${NONCE}\" \"${mode}\" 3<&3'" >/dev/null
}

production_origin_bind() {
  local token="${OPERATION_ROOT}/origin-token"
  local response="${OPERATION_ROOT}/cloudfront.before.json"
  local response_raw="${OPERATION_ROOT}/cloudfront.prebind-distribution.json"
  local route_projection="${OPERATION_ROOT}/cloudfront.prebind-route.json"
  local original="${OPERATION_ROOT}/cloudfront.original-config.json"
  local bound="${OPERATION_ROOT}/cloudfront.bound-config.json"
  local response_pending="${response}.pending"
  local original_pending="${original}.pending"
  local bound_pending="${bound}.pending"
  local current="${OPERATION_ROOT}/cloudfront.bound-observed.json"
  local update="${OPERATION_ROOT}/cloudfront.bind-update.json"
  local etag update_etag distribution origin distribution_sha origin_sha public_base public_hostname resolved_host
  local prepared_caddy expected_caddy
  distribution="$(transport_value distributionId)"
  origin="$(transport_value originId)"
  public_base="$(transport_value publicBaseUrl)"
  public_hostname="$(python3 - "${public_base}" <<'PY'
import sys, urllib.parse
value=urllib.parse.urlsplit(sys.argv[1])
if value.scheme != "https" or value.username is not None or value.password is not None or value.port is not None or value.path or value.query or value.fragment or not value.hostname:
    raise SystemExit(1)
print(value.hostname.lower())
PY
)" || {
    production_error TOPOLOGY_INVALID
    return
  }
  resolved_host="$(transport_value targetHost | tr '[:upper:]' '[:lower:]')"
  bounded_aws_command 30 cloudfront get-distribution --id "${distribution}" --output json >"${response_raw}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  (( $(wc --bytes <"${response_raw}") <= 2097152 )) || {
    production_error ETAG_RACE
    return
  }
  jq --compact-output --sort-keys '
    {
      Aliases:.Distribution.DistributionConfig.Aliases.Items,
      ContinuousDeploymentPolicyId:.Distribution.DistributionConfig.ContinuousDeploymentPolicyId,
      CustomErrorResponses:.Distribution.DistributionConfig.CustomErrorResponses,
      DefaultCacheBehavior:(.Distribution.DistributionConfig.DefaultCacheBehavior | {FunctionAssociations,LambdaFunctionAssociations,TargetOriginId}),
      Enabled:.Distribution.DistributionConfig.Enabled,
      Id:.Distribution.Id,
      OrderedCacheBehaviors:.Distribution.DistributionConfig.CacheBehaviors,
      OriginGroups:.Distribution.DistributionConfig.OriginGroups,
      Origins:(.Distribution.DistributionConfig.Origins.Items | map({DomainName,Id})),
      Staging:.Distribution.DistributionConfig.Staging,
      Status:.Distribution.Status,
      WebACLId:.Distribution.DistributionConfig.WebACLId
    }
  ' "${response_raw}" >"${route_projection}" || {
    production_error ETAG_RACE
    return
  }
  validate_cloudfront_route_projection "${route_projection}" "${distribution}" "${origin}" "${public_hostname}" "${resolved_host}" || {
    production_error TOPOLOGY_INVALID
    return
  }
  jq --compact-output --sort-keys '{ETag,DistributionConfig:.Distribution.DistributionConfig}' "${response_raw}" >"${response_pending}" || {
    production_error ETAG_RACE
    return
  }
  rm --force -- "${response_raw}" "${route_projection}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  etag="$(jq --raw-output '.ETag' "${response_pending}")"
  [[ "${etag}" =~ ^[A-Za-z0-9_=+-]{1,256}$ ]] || {
    production_error ETAG_RACE
    return
  }
  durable_replace "${response}" "${response_pending}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  jq --compact-output --sort-keys '.DistributionConfig' "${response}" >"${original_pending}" || {
    production_error ETAG_RACE
    return
  }
  jq --exit-status --arg origin "${origin}" '
    ([.Origins.Items[] | select(.Id == $origin)] | length) == 1
    and ([.Origins.Items[] | select(.Id == $origin) | (.OriginCustomHeaders.Items // [])[] | select((.HeaderName | ascii_downcase) == "x-refunddesk-origin-token")] | length) == 0
  ' "${original_pending}" >/dev/null || {
    production_error ETAG_RACE
    return
  }
  durable_replace "${original}" "${original_pending}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  recover_local_origin_token true || {
    production_error TOOL_UNAVAILABLE
    return
  }
  jq --compact-output --sort-keys --arg origin "${origin}" --rawfile token "${token}" '
    .Origins.Items |= map(
      if .Id == $origin then
        ((.OriginCustomHeaders.Items // []) + [{HeaderName:"X-RefundDesk-Origin-Token",HeaderValue:$token}]) as $items
        | .OriginCustomHeaders = {Items:$items,Quantity:($items|length)}
      else . end
    )
  ' "${original}" >"${bound_pending}" || {
    production_error ETAG_RACE
    return
  }
  jq --exit-status --arg origin "${origin}" --rawfile token "${token}" '
    ([.Origins.Items[] | select(.Id == $origin)] | length) == 1
    and ([.Origins.Items[] | select(.Id == $origin) | (.OriginCustomHeaders.Items // [])[]
      | select((.HeaderName | ascii_downcase) == "x-refunddesk-origin-token" and .HeaderValue == $token)] | length) == 1
  ' "${bound_pending}" >/dev/null || {
    production_error ETAG_RACE
    return
  }
  durable_replace "${bound}" "${bound_pending}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  # The exact original and candidate CloudFront documents are durable recovery
  # inputs.  They must exist before the host token is changed, otherwise a
  # crash between the host rewrite and the first CloudFront read is
  # unrecoverable without guessing provider state.
  chmod 600 "${response}" "${original}" "${bound}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  sync "${token}" "${response}" "${original}" "${bound}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  sync --file-system "${OPERATION_ROOT}" 2>/dev/null || sync "${OPERATION_ROOT}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  production_origin_host_files bind || {
    production_error TOOL_UNAVAILABLE
    return
  }
  bounded_aws_command 30 cloudfront update-distribution --id "${distribution}" --if-match "${etag}" \
    --distribution-config "file://${bound}" --output json >"${update}" || {
    production_error ETAG_RACE
    return
  }
  (( $(wc --bytes <"${update}") <= 2097152 )) || {
    production_error ETAG_RACE
    return
  }
  jq --exit-status --arg distribution "${distribution}" --slurpfile expected "${bound}" '
    type == "object"
    and (.ETag | type == "string" and test("^[A-Za-z0-9_=+-]{1,256}$"))
    and .Distribution.Id == $distribution
    and (.Distribution.Status | IN("InProgress","Deployed"))
    and .Distribution.DistributionConfig == $expected[0]
  ' "${update}" >/dev/null || {
    production_error ETAG_RACE
    return
  }
  update_etag="$(jq --raw-output '.ETag' "${update}")"
  [[ "${update_etag}" != "${etag}" ]] || {
    production_error ETAG_RACE
    return
  }
  if ! chmod 600 "${update}" || ! sync "${update}"; then
    production_error TOOL_UNAVAILABLE
    return
  fi
  sync --file-system "${OPERATION_ROOT}" 2>/dev/null || sync "${OPERATION_ROOT}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  bounded_aws_command 420 cloudfront wait distribution-deployed --id "${distribution}" || {
    production_error NEVER_DEPLOYED
    return
  }
  bounded_aws_command 30 cloudfront get-distribution-config --id "${distribution}" --output json >"${current}" || {
    production_error NEVER_DEPLOYED
    return
  }
  (( $(wc --bytes <"${current}") <= 2097152 )) || {
    production_error ETAG_RACE
    return
  }
  jq --exit-status --arg expectedEtag "${update_etag}" --slurpfile expected "${bound}" '
    .ETag == $expectedEtag and .DistributionConfig == $expected[0]
  ' \
    "${current}" >/dev/null || {
    production_error ETAG_RACE
    return
  }
  # Materialize the exact token-bound Caddy while the Lightsail firewall is
  # still closed, but keep it stopped.  The durable watchdog is then armed
  # against this exact 64-hex container/scope identity before any listener can
  # exist; caddy-start may only start this already-inspected container.
  expected_caddy="$(transport_value caddyContainerId)"
prepared_caddy="$(ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${expected_caddy}'" <<'REMOTE'
set +x
exec 2>/dev/null
set -o pipefail
revision="$1"
old_id="$2"
release_root="/opt/refunddesk/releases/${revision}/source"
compose_file="${release_root}/deploy/lightsail/compose.yml"
release_env=/etc/refunddesk/release.env
test -f "${compose_file}"
test -f "${release_env}"
test "$(<"${release_root}/.refunddesk-revision")" = "${revision}"
ids="$(docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy)"
test "${ids}" = "${old_id}"
docker inspect "${old_id}" | jq --exit-status --arg revision "${revision}" --arg id "${old_id}" '
  length == 1 and .[0].Id == $id
  and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
  and .[0].Config.Labels["com.docker.compose.service"] == "caddy"
  and .[0].Config.Labels["com.refunddesk.revision"] == $revision
  and .[0].HostConfig.RestartPolicy.Name == "no"
  and .[0].State.Running == false
' >/dev/null
docker compose --project-name refunddesk --env-file "${release_env}" --file "${compose_file}" \
  up --no-start --no-deps --no-build --pull never --force-recreate caddy >/dev/null
new_id="$(docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy)"
[[ "${new_id}" =~ ^[0-9a-f]{64}$ && "${new_id}" != "${old_id}" ]]
docker update --restart=no "${new_id}" >/dev/null
expected_image="$(docker compose --project-name refunddesk --env-file "${release_env}" --file "${compose_file}" config --format json | jq --raw-output '.services.caddy.image')"
expected_image_id="$(docker image inspect --format '{{.Id}}' "${expected_image}")"
[[ "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]
inspection="$(docker inspect "${new_id}")"
jq --exit-status --arg id "${new_id}" --arg image "${expected_image}" --arg imageId "${expected_image_id}" --arg revision "${revision}" --arg source "${release_root}/deploy/lightsail/Caddyfile.public" '
  length == 1 and .[0].Id == $id
  and .[0].Image == $imageId
  and .[0].Config.Image == $image
  and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
  and .[0].Config.Labels["com.docker.compose.service"] == "caddy"
  and .[0].Config.Labels["com.refunddesk.revision"] == $revision
  and (.[0].Config.Labels["com.docker.compose.config-hash"] | type == "string" and length == 64)
  and .[0].HostConfig.RestartPolicy.Name == "no"
  and .[0].State.Running == false
  and ([.[0].Mounts[] | select(.Destination == "/etc/caddy/Caddyfile" and .Source == $source and .RW == false)] | length) == 1
' <<<"${inspection}" >/dev/null
test -z "$(docker container ls --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy)"
test -z "$(docker container ls --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=worker)"
printf '%s' "${new_id}"
REMOTE
)" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  [[ "${prepared_caddy}" =~ ^[0-9a-f]{64}$ && "${prepared_caddy}" != "${expected_caddy}" ]] || {
    production_error TOPOLOGY_INVALID
    return
  }
  distribution_sha="$(printf '%s' "${distribution}" | sha256sum | cut -d ' ' -f 1)"
  origin_sha="$(printf '%s' "${origin}" | sha256sum | cut -d ' ' -f 1)"
  jq --null-input --compact-output --sort-keys \
    --arg distributionIdSha256 "${distribution_sha}" --arg originIdSha256 "${origin_sha}" \
    --arg preparedCaddyContainerId "${prepared_caddy}" \
    '{intents:{preparedCaddyContainerId:$preparedCaddyContainerId},mutations:{originUpdates:1},origin:{bound:true,boundDeployed:true,distributionIdSha256:$distributionIdSha256,etagBindMatched:true,originIdSha256:$originIdSha256,originMatched:true,secretMaterialEmitted:false,tokenGenerated:true,tokenLengthBytes:32,tokenWrittenRootOnly:true,updateAttempts:1}}'
}

production_origin_unbind() {
  local distribution origin current etag original_etag bound_etag update_etag original bound observed provider_state
  local before bind_update unbind_update
  local restored_caddy_sha prepared_caddy origin_updates=0 update_attempts=0
  local etag_bind_matched=false etag_unbind_matched=true
  recover_local_origin_token false || {
    production_error TOOL_UNAVAILABLE
    return
  }
  production_origin_host_files cleanup || {
    production_error TOOL_UNAVAILABLE
    return
  }
  distribution="$(transport_value distributionId)"
  origin="$(transport_value originId)"
  current="${OPERATION_ROOT}/cloudfront.cleanup-current.json"
  before="${OPERATION_ROOT}/cloudfront.before.json"
  original="${OPERATION_ROOT}/cloudfront.original-config.json"
  bound="${OPERATION_ROOT}/cloudfront.bound-config.json"
  bind_update="${OPERATION_ROOT}/cloudfront.bind-update.json"
  unbind_update="${OPERATION_ROOT}/cloudfront.unbind-update.json"
  observed="${OPERATION_ROOT}/cloudfront.cleanup-observed.json"
  etag_bind_matched="$(jq --raw-output '.origin.etagBindMatched // false' "${FACTS_FILE}")" || etag_bind_matched=false
  prepared_caddy="$(jq --raw-output '.intents.preparedCaddyContainerId // empty' "${FACTS_FILE}")" || prepared_caddy=""
  [[ -z "${prepared_caddy}" || "${prepared_caddy}" =~ ^[0-9a-f]{64}$ ]] || {
    production_error TOOL_UNAVAILABLE
    return
  }
  [[ "${etag_bind_matched}" == true || "${etag_bind_matched}" == false ]] || etag_bind_matched=false
  bounded_aws_command 30 cloudfront get-distribution-config --id "${distribution}" --output json >"${current}" || {
    production_error ETAG_RACE
    return
  }
  (( $(wc --bytes <"${current}") <= 2097152 )) || {
    production_error ETAG_RACE
    return
  }
  etag="$(jq --raw-output '.ETag' "${current}")"
  [[ "${etag}" =~ ^[A-Za-z0-9_=+-]{1,256}$ ]] || {
    production_error ETAG_RACE
    return
  }
  if [[ ! -f "${before}" || ! -f "${original}" || ! -f "${bound}" ]]; then
    # A crash before both durable recovery documents existed cannot have issued
    # the CloudFront update. Prove the authorized origin is still unique and
    # has no matcher header; never infer this from the journal intent alone.
    jq --exit-status --arg origin "${origin}" '
      ([.DistributionConfig.Origins.Items[] | select(.Id == $origin)] | length) == 1
      and ([.DistributionConfig.Origins.Items[] | select(.Id == $origin)
        | (.OriginCustomHeaders.Items // [])[]
        | select((.HeaderName | ascii_downcase) == "x-refunddesk-origin-token")] | length) == 0
    ' "${current}" >/dev/null || {
      production_error ETAG_RACE
      return
    }
    provider_state=prebind
    cp -- "${current}" "${observed}"
    # No external bind can have followed an unpublished recovery document.
    # Remove only private, nonce-bound pending inodes after the provider has
    # independently proved the exact pre-bind state.
    for provider_pending in "${before}.pending" "${original}.pending" "${bound}.pending"; do
      if [[ -e "${provider_pending}" || -L "${provider_pending}" ]]; then
        controlled_file "${provider_pending}" || {
          production_error ETAG_RACE
          return
        }
        rm -- "${provider_pending}" || {
          production_error TOOL_UNAVAILABLE
          return
        }
      fi
    done
    sync --file-system "${OPERATION_ROOT}" 2>/dev/null || sync "${OPERATION_ROOT}" || {
      production_error TOOL_UNAVAILABLE
      return
    }
  else
    [[ ! -e "${before}.pending" && ! -L "${before}.pending" &&
      ! -e "${original}.pending" && ! -L "${original}.pending" &&
      ! -e "${bound}.pending" && ! -L "${bound}.pending" ]] || {
      production_error ETAG_RACE
      return
    }
    original_etag="$(jq --raw-output '.ETag' "${before}")"
    [[ "${original_etag}" =~ ^[A-Za-z0-9_=+-]{1,256}$ ]] || {
      production_error ETAG_RACE
      return
    }
  fi
  if [[ -n "${original_etag:-}" ]] && jq --exit-status --slurpfile expected "${original}" '.DistributionConfig == $expected[0]' \
    "${current}" >/dev/null; then
    if [[ "${etag}" == "${original_etag}" ]]; then
      # The bind update was never accepted. Equal bytes with any other ETag
      # are not equivalent: they may be a third-party rollback.
      provider_state=original
      cp -- "${current}" "${observed}"
    elif [[ -s "${unbind_update}" ]] && (( $(wc --bytes <"${unbind_update}") <= 2097152 )) &&
      update_etag="$(jq --raw-output '.ETag // empty' "${unbind_update}" 2>/dev/null)" &&
      [[ "${update_etag}" == "${etag}" && "${update_etag}" != "${original_etag}" ]] &&
      jq --exit-status --arg distribution "${distribution}" --arg expectedEtag "${etag}" \
        --slurpfile expected "${original}" '
          .ETag == $expectedEtag
          and .Distribution.Id == $distribution
          and (.Distribution.Status | IN("InProgress","Deployed"))
          and .Distribution.DistributionConfig == $expected[0]
        ' "${unbind_update}" >/dev/null; then
      # Recovery after our exact unbind response was persisted but before its
      # facts patch. No provider write is repeated, but get-config does not
      # expose deployment status: the exact waiter and final ETag readback are
      # still mandatory before unboundDeployed may be asserted.
      provider_state=restored
      origin_updates=2
      update_attempts=2
      bounded_aws_command 420 cloudfront wait distribution-deployed --id "${distribution}" || {
        production_error NEVER_DEPLOYED
        return
      }
      bounded_aws_command 30 cloudfront get-distribution-config --id "${distribution}" --output json >"${observed}" || {
        production_error NEVER_DEPLOYED
        return
      }
      (( $(wc --bytes <"${observed}") <= 2097152 )) || {
        production_error ETAG_RACE
        return
      }
      jq --exit-status --arg expectedEtag "${update_etag}" --slurpfile expected "${original}" '
        .ETag == $expectedEtag and .DistributionConfig == $expected[0]
      ' "${observed}" >/dev/null || {
        production_error ETAG_RACE
        return
      }
    else
      # Exact original bytes are already safe even when the unbind response
      # was lost before it could be durably attributed.  The current ETag is
      # authoritative for subsequent CAS, but lack of an exact response can
      # never be promoted to PASS.  Wait for Deployed, prove the same ETag and
      # config again, then continue cleanup as terminal INCOMPLETE.
      provider_state=restored-unattributed
      origin_updates=2
      update_attempts=2
      etag_unbind_matched=false
      bounded_aws_command 420 cloudfront wait distribution-deployed --id "${distribution}" || {
        production_error NEVER_DEPLOYED
        return
      }
      bounded_aws_command 30 cloudfront get-distribution-config --id "${distribution}" --output json >"${observed}" || {
        production_error NEVER_DEPLOYED
        return
      }
      (( $(wc --bytes <"${observed}") <= 2097152 )) || {
        production_error ETAG_RACE
        return
      }
      jq --exit-status --arg expectedEtag "${etag}" --slurpfile expected "${original}" '
        .ETag == $expectedEtag and .DistributionConfig == $expected[0]
      ' "${observed}" >/dev/null || {
        production_error ETAG_RACE
        return
      }
    fi
  elif [[ -n "${original_etag:-}" ]] && jq --exit-status --slurpfile expected "${bound}" '.DistributionConfig == $expected[0]' \
    "${current}" >/dev/null; then
    provider_state=bound
    if [[ -f "${bind_update}" ]] && (( $(wc --bytes <"${bind_update}") <= 2097152 )); then
      bound_etag="$(jq --raw-output '.ETag // empty' "${bind_update}" 2>/dev/null || true)"
      if [[ "${bound_etag}" == "${etag}" && "${bound_etag}" != "${original_etag}" ]] &&
        jq --exit-status --arg distribution "${distribution}" --arg expectedEtag "${etag}" \
          --slurpfile expected "${bound}" '
            .ETag == $expectedEtag
            and .Distribution.Id == $distribution
            and (.Distribution.Status | IN("InProgress","Deployed"))
            and .Distribution.DistributionConfig == $expected[0]
          ' "${bind_update}" >/dev/null; then
        etag_bind_matched=true
      else
        etag_bind_matched=false
      fi
    else
      # The exact bound bytes contain the nonce-unique token from our durable
      # candidate, so cleanup may safely unbind using the current ETag even
      # though the bind ACK was lost. Attribution remains false and forces 21.
      etag_bind_matched=false
    fi
    update_attempts=2
    bounded_aws_command 30 cloudfront update-distribution --id "${distribution}" --if-match "${etag}" \
      --distribution-config "file://${original}" --output json >"${unbind_update}" || {
      production_error ETAG_RACE
      return
    }
    (( $(wc --bytes <"${unbind_update}") <= 2097152 )) || {
      production_error ETAG_RACE
      return
    }
    update_etag="$(jq --raw-output '.ETag' "${unbind_update}")"
    jq --exit-status --arg distribution "${distribution}" --slurpfile expected "${original}" '
      (.ETag | type == "string" and test("^[A-Za-z0-9_=+-]{1,256}$"))
      and .Distribution.Id == $distribution
      and (.Distribution.Status | IN("InProgress","Deployed"))
      and .Distribution.DistributionConfig == $expected[0]
    ' "${unbind_update}" >/dev/null || {
      production_error ETAG_RACE
      return
    }
    [[ "${update_etag}" != "${etag}" ]] || {
      production_error ETAG_RACE
      return
    }
    if ! chmod 600 "${unbind_update}" || ! sync "${unbind_update}"; then
      production_error TOOL_UNAVAILABLE
      return
    fi
    sync --file-system "${OPERATION_ROOT}" 2>/dev/null || sync "${OPERATION_ROOT}" || {
      production_error TOOL_UNAVAILABLE
      return
    }
    origin_updates=2
    bounded_aws_command 420 cloudfront wait distribution-deployed --id "${distribution}" || {
      production_error NEVER_DEPLOYED
      return
    }
    bounded_aws_command 30 cloudfront get-distribution-config --id "${distribution}" --output json >"${observed}" || {
      production_error NEVER_DEPLOYED
      return
    }
    (( $(wc --bytes <"${observed}") <= 2097152 )) || {
      production_error ETAG_RACE
      return
    }
    jq --exit-status --arg expectedEtag "${update_etag}" --slurpfile expected "${original}" '
      .ETag == $expectedEtag and .DistributionConfig == $expected[0]
    ' \
      "${observed}" >/dev/null || {
      production_error ETAG_RACE
      return
    }
  elif [[ -n "${original_etag:-}" ]]; then
    # Any third state may be an operator/provider race.  Retain every 0600
    # recovery input and the durable watchdog; never guess a restoration.
    production_error ETAG_RACE
    return
  fi
  if [[ "${provider_state}" == prebind ]]; then
    # With no durable provider documents, origin-bind could not yet have
    # rewritten the host token or issued an update. Preserve the exact inert
    # promotion Caddy instead of recreating it during deterministic pre-effect
    # cleanup.
    restored_caddy_sha="$(jq --raw-output '.admission.promotionCaddyContainerIdSha256' "${CONTROL_FILE}")"
  else
    restored_caddy_sha="$(ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${NONCE}' '${prepared_caddy}'" <<'REMOTE'
set +x
exec 2>/dev/null
revision="$1"
nonce="$2"
expected_prepared="$3"
backup="/var/lib/refunddesk/control/edge-window-caddy-${nonce}.before"
token_file="/var/lib/refunddesk/control/edge-window-origin-token-${nonce}"
current=/etc/refunddesk/caddy.env
watchdog_marker=/var/lib/refunddesk/control/edge-window-watchdog.json
watchdog_receipt=/var/lib/refunddesk/control/edge-window-watchdog-preflight.json
watchdog_identity_transition="/var/lib/refunddesk/control/edge-window-caddy-identity-transition-${nonce}.json"
exec 9>/run/refunddesk/edge-window-watchdog.lock
flock --exclusive --timeout 10 9
test -f "${current}" && test ! -L "${current}"
if test -e "${token_file}"; then
  test -f "${token_file}" && test ! -L "${token_file}"
  test "$(stat --format='%U:%G:%a' "${token_file}")" = root:root:600
  grep -Eq '^[A-Za-z0-9_-]{43}$' "${token_file}"
fi
if test -e "${backup}"; then
  test -f "${backup}" && test ! -L "${backup}"
  test "$(stat --format='%U:%G:%a' "${backup}")" = root:root:600
  # Keep the recovery copy until the inert replacement container has been
  # inspected. A crash after restoring caddy.env can therefore replay this
  # phase without inferring state from the backup's absence.
  python3 - "${backup}" "${current}" "${nonce}" <<'PY_RESTORE_CADDY_ENV'
import os
import pathlib
import re
import stat
import sys

backup, current = map(pathlib.Path, sys.argv[1:3])
nonce = sys.argv[3]
candidate = current.parent / f".caddy.env.{nonce[:10]}"
token_pattern = re.compile(rb"[A-Za-z0-9_-]{43}")

def fsync_directory():
    descriptor = os.open(current.parent, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def controlled_raw(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        linked = os.lstat(path)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != 0
            or before.st_gid != 0
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1
            or before.st_size > 16_384
            or (before.st_dev, before.st_ino) != (linked.st_dev, linked.st_ino)
        ):
            raise SystemExit(1)
        raw = bytearray()
        while len(raw) <= 16_384:
            chunk = os.read(descriptor, min(65_536, 16_385 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        after = os.fstat(descriptor)
        linked_after = os.lstat(path)
        identity = lambda item: (
            item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
            item.st_ctime_ns, item.st_mode, item.st_uid, item.st_gid, item.st_nlink,
        )
        if identity(before) != identity(after) or (after.st_dev, after.st_ino) != (linked_after.st_dev, linked_after.st_ino):
            raise SystemExit(1)
        if len(raw) != before.st_size:
            raise SystemExit(1)
        return bytes(raw)
    finally:
        os.close(descriptor)

def valid_environment(raw):
    if not raw.endswith(b"\n") or b"\r" in raw or b"\x00" in raw:
        return False
    try:
        lines = raw[:-1].decode("utf-8").split("\n")
    except UnicodeDecodeError:
        return False
    if len(lines) != 3:
        return False
    values = {}
    for line in lines:
        if "=" not in line:
            return False
        key, value = line.split("=", 1)
        if key in values or key not in {
            "REFUNDDESK_ACME_EMAIL", "REFUNDDESK_PUBLIC_HOST", "REFUNDDESK_EDGE_ORIGIN_TOKEN",
        }:
            return False
        values[key] = value
    try:
        return token_pattern.fullmatch(values.get("REFUNDDESK_EDGE_ORIGIN_TOKEN", "").encode("ascii")) is not None
    except UnicodeEncodeError:
        return False

raw = controlled_raw(backup)
if not valid_environment(raw):
    raise SystemExit(1)
if candidate.exists():
    candidate_raw = controlled_raw(candidate)
    if valid_environment(candidate_raw) and candidate_raw != raw:
        raise SystemExit(1)
    candidate.unlink()
    fsync_directory()
descriptor = os.open(
    candidate,
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
    os.fchown(descriptor, 0, 0)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
fsync_directory()
os.replace(candidate, current)
fsync_directory()
if controlled_raw(current) != raw:
    raise SystemExit(1)
PY_RESTORE_CADDY_ENV
fi
test "$(stat --format='%U:%G:%a' "${current}")" = root:root:600
token_count="$(grep -Ec '^REFUNDDESK_EDGE_ORIGIN_TOKEN=[A-Za-z0-9_-]{43}$' "${current}")"
test "${token_count}" = 1
release_root="/opt/refunddesk/releases/${revision}/source"
compose_file="${release_root}/deploy/lightsail/compose.yml"
release_env=/etc/refunddesk/release.env
test "$(<"${release_root}/.refunddesk-revision")" = "${revision}"
old_id="$(docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy)"
[[ -z "${old_id}" || "${old_id}" =~ ^[0-9a-f]{64}$ ]]
watchdog_pair="$(python3 - "${watchdog_marker}" "${watchdog_receipt}" "${watchdog_identity_transition}" "${nonce}" "${revision}" "${expected_prepared}" "${old_id}" <<'PY'
import ctypes, errno, hashlib, json, os, pathlib, stat, sys, tempfile

marker_path, receipt_path, transition_path = map(pathlib.Path, sys.argv[1:4])
nonce, revision, expected_prepared, observed_old = sys.argv[4:]

def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate")
        result[key] = value
    return result

def read_exact(path, keys):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 4096:
        raise SystemExit(1)
    raw = path.read_bytes()
    document = json.loads(raw.decode("ascii"), object_pairs_hook=pairs)
    canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
    if raw != canonical or set(document) != keys:
        raise SystemExit(1)
    return document, raw

def fsync_directory():
    descriptor = os.open(marker_path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def rename_noreplace(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOSYS, errno.EINVAL}:
            raise SystemExit(1)
        raise OSError(error, os.strerror(error))

def replace(path, document):
    raw = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise SystemExit(1)
            offset += written
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        fsync_directory()
        os.replace(temporary, path)
        fsync_directory()
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)
    return raw

transition_keys = {"expectedRevision","kind","markerAfterSha256","markerBeforeSha256","newCaddyContainerId","nonce","oldCaddyContainerId","receiptAfterSha256","receiptBeforeSha256","schemaVersion","workerContainerId"}
pending_paths = sorted(transition_path.parent.glob(f".{transition_path.name}.*"))
if len(pending_paths) > 1:
    raise SystemExit(1)
if transition_path.exists() or transition_path.is_symlink():
    if pending_paths:
        raise SystemExit(1)
elif pending_paths:
    # The pending directory entry was durable before RENAME_NOREPLACE. Recover
    # only its exact canonical transition bytes; never fall back to provider or
    # mutable marker inference after this intent exists.
    read_exact(pending_paths[0], transition_keys)
    fsync_directory()
    rename_noreplace(pending_paths[0], transition_path)
    fsync_directory()

marker_exists = marker_path.exists() or marker_path.is_symlink()
receipt_exists = receipt_path.exists() or receipt_path.is_symlink()
if not marker_exists and not receipt_exists:
    print("absent")
    raise SystemExit(0)
if not marker_exists or not receipt_exists:
    raise SystemExit(1)
marker_keys = {"armedBoottimeMilliseconds","bootId","caddyContainerId","deadlineBoottimeMilliseconds","deadlineEpoch","expectedRevision","kind","metrics","nonce","schemaVersion","serviceSha256","startDeadlineBoottimeMilliseconds","state","timerSha256","triggered","watchdogSha256","windowSeconds","workerContainerId"}
receipt_keys = {"bootIdSha256","caddyContainerId","expectedRevision","kind","markerSha256","nonce","observedAtEpoch","observedBoottimeMilliseconds","schemaVersion","workerContainerId"}
marker, marker_raw = read_exact(marker_path, marker_keys)
receipt, receipt_raw = read_exact(receipt_path, receipt_keys)
allowed_ids = {value for value in (expected_prepared, observed_old) if value}
if marker.get("kind") != "refunddesk.edge-window-watchdog" or marker.get("schemaVersion") != 1 or marker.get("nonce") != nonce or marker.get("expectedRevision") != revision or marker.get("state") not in {"armed", "armed_running", "starting", "contained"} or not isinstance(marker.get("triggered"), bool):
    raise SystemExit(1)
if receipt.get("kind") != "refunddesk.edge-window-watchdog-preflight" or receipt.get("schemaVersion") != 1 or receipt.get("nonce") != nonce or receipt.get("expectedRevision") != revision:
    raise SystemExit(1)
if receipt.get("bootIdSha256") != hashlib.sha256(marker["bootId"].encode("ascii")).hexdigest():
    raise SystemExit(1)
transition_exists = transition_path.exists() or transition_path.is_symlink()
if transition_exists:
    transition, _ = read_exact(transition_path, transition_keys)
    old_id = transition.get("oldCaddyContainerId")
    new_id = transition.get("newCaddyContainerId")
    before_marker_sha = transition.get("markerBeforeSha256")
    after_marker_sha = transition.get("markerAfterSha256")
    before_receipt_sha = transition.get("receiptBeforeSha256")
    after_receipt_sha = transition.get("receiptAfterSha256")
    if transition.get("kind") != "refunddesk.edge-window-caddy-identity-transition" or transition.get("schemaVersion") != 1 or transition.get("nonce") != nonce or transition.get("expectedRevision") != revision:
        raise SystemExit(1)
    if not all(isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value) for value in (old_id, new_id, transition.get("workerContainerId"), before_marker_sha, after_marker_sha, before_receipt_sha, after_receipt_sha)):
        raise SystemExit(1)
    if old_id == new_id or new_id != observed_old or old_id not in allowed_ids or transition.get("workerContainerId") != marker.get("workerContainerId") or receipt.get("workerContainerId") != marker.get("workerContainerId"):
        raise SystemExit(1)
    marker_id = marker.get("caddyContainerId")
    receipt_id = receipt.get("caddyContainerId")
    if marker_id not in {old_id, new_id} or receipt_id not in {old_id, new_id}:
        raise SystemExit(1)
    marker_sha = hashlib.sha256(marker_raw).hexdigest()
    receipt_sha = hashlib.sha256(receipt_raw).hexdigest()
    if marker_sha != (before_marker_sha if marker_id == old_id else after_marker_sha):
        raise SystemExit(1)
    if receipt_sha != (before_receipt_sha if receipt_id == old_id else after_receipt_sha):
        raise SystemExit(1)
    if receipt.get("markerSha256") != (before_marker_sha if receipt_id == old_id else after_marker_sha):
        raise SystemExit(1)
    if marker_id == old_id:
        marker["caddyContainerId"] = new_id
        marker_raw = replace(marker_path, marker)
        if hashlib.sha256(marker_raw).hexdigest() != after_marker_sha:
            raise SystemExit(1)
    if receipt_id == old_id:
        receipt["caddyContainerId"] = new_id
        receipt["markerSha256"] = after_marker_sha
        receipt_raw = replace(receipt_path, receipt)
        if hashlib.sha256(receipt_raw).hexdigest() != after_receipt_sha:
            raise SystemExit(1)
    marker, marker_raw = read_exact(marker_path, marker_keys)
    receipt, receipt_raw = read_exact(receipt_path, receipt_keys)
    if hashlib.sha256(marker_raw).hexdigest() != after_marker_sha or hashlib.sha256(receipt_raw).hexdigest() != after_receipt_sha:
        raise SystemExit(1)
    transition_path.unlink()
    fsync_directory()
if not allowed_ids or marker.get("caddyContainerId") not in allowed_ids:
    raise SystemExit(1)
if receipt.get("caddyContainerId") != marker.get("caddyContainerId") or receipt.get("workerContainerId") != marker.get("workerContainerId"):
    raise SystemExit(1)
if receipt.get("markerSha256") != hashlib.sha256(marker_raw).hexdigest():
    raise SystemExit(1)
print("present")
PY
)"
[[ "${watchdog_pair}" == absent || "${watchdog_pair}" == present ]]
docker compose --project-name refunddesk --env-file "${release_env}" --file "${compose_file}" \
  up --no-start --no-deps --no-build --pull never --force-recreate caddy >/dev/null
new_id="$(docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy)"
[[ "${new_id}" =~ ^[0-9a-f]{64}$ ]]
[[ -z "${old_id}" || "${new_id}" != "${old_id}" ]]
docker update --restart=no "${new_id}" >/dev/null
expected_image="$(docker compose --project-name refunddesk --env-file "${release_env}" --file "${compose_file}" config --format json | jq --raw-output '.services.caddy.image')"
expected_image_id="$(docker image inspect --format '{{.Id}}' "${expected_image}")"
[[ "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]
inspection_file="/var/lib/refunddesk/control/edge-caddy-inspect-${nonce}.json"
if test -e "${inspection_file}"; then
  test -f "${inspection_file}" && test ! -L "${inspection_file}"
  test "$(stat --format='%U:%G:%a' "${inspection_file}")" = root:root:600
  rm -- "${inspection_file}"
fi
(set -o noclobber; umask 077; : >"${inspection_file}")
chmod 0600 "${inspection_file}"
chown root:root "${inspection_file}"
trap 'rm -f -- "${inspection_file}"' EXIT
docker inspect "${new_id}" >"${inspection_file}"
sync "${inspection_file}"
python3 - "${new_id}" "${expected_image}" "${expected_image_id}" "${revision}" "${release_root}/deploy/lightsail/Caddyfile.public" "${current}" "${inspection_file}" "${token_file}" <<'PY'
import json
import pathlib
import re
import sys

container_id, image, image_id, revision, source, env_path, inspection_path, transient_token_path = sys.argv[1:]
transient_path = pathlib.Path(transient_token_path)
transient_token = transient_path.read_text(encoding="ascii").strip() if transient_path.exists() else ""
if transient_token and re.fullmatch(r"[A-Za-z0-9_-]{43}", transient_token) is None:
    raise SystemExit(1)
with open(inspection_path, encoding="utf-8") as stream:
    inspection = json.load(stream)
with open(env_path, encoding="utf-8") as stream:
    tokens = [line.rstrip("\n").split("=", 1)[1] for line in stream if line.startswith("REFUNDDESK_EDGE_ORIGIN_TOKEN=")]
if len(tokens) != 1 or re.fullmatch(r"[A-Za-z0-9_-]{43}", tokens[0]) is None:
    raise SystemExit(1)
if len(inspection) != 1:
    raise SystemExit(1)
item = inspection[0]
labels = item["Config"]["Labels"]
mounts = item["Mounts"]
valid = (
    item["Id"] == container_id
    and item["Image"] == image_id
    and item["Config"]["Image"] == image
    and labels.get("com.docker.compose.project") == "refunddesk"
    and labels.get("com.docker.compose.service") == "caddy"
    and labels.get("com.refunddesk.revision") == revision
    and re.fullmatch(r"[0-9a-f]{64}", labels.get("com.docker.compose.config-hash", "")) is not None
    and item["HostConfig"]["RestartPolicy"]["Name"] == "no"
    and item["State"]["Running"] is False
    and item["Config"]["Env"].count("REFUNDDESK_EDGE_ORIGIN_TOKEN=" + tokens[0]) == 1
    and (not transient_token or all(transient_token not in value for value in item["Config"]["Env"]))
    and sum(m.get("Destination") == "/etc/caddy/Caddyfile" and m.get("Source") == source and m.get("RW") is False for m in mounts) == 1
)
if not valid:
    raise SystemExit(1)
PY
python3 - /var/lib/refunddesk/control "${token_file}" "${inspection_file}" <<'PY'
import os, pathlib, stat, sys
root, token_path, inspection_path = map(pathlib.Path, sys.argv[1:])
token = token_path.read_bytes().rstrip(b"\n") if token_path.exists() else b""
if token:
    for path in root.iterdir():
        if path in {token_path, inspection_path}:
            continue
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise SystemExit(1)
        if stat.S_ISREG(info.st_mode):
            if info.st_size > 2_097_152:
                raise SystemExit(1)
            if token in path.read_bytes():
                raise SystemExit(1)
PY
python3 - /etc/refunddesk "${token_file}" <<'PY'
import os, pathlib, re, stat, sys
root = pathlib.Path(sys.argv[1])
token_path = pathlib.Path(sys.argv[2])
token = token_path.read_bytes().rstrip(b"\n") if token_path.exists() else b""
if token and re.fullmatch(rb"[A-Za-z0-9_-]{43}", token) is None:
    raise SystemExit(1)
entries = list(root.iterdir())
if len(entries) > 256:
    raise SystemExit(1)
for path in entries:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(1)
    if not stat.S_ISREG(info.st_mode):
        continue
    if info.st_size > 2_097_152:
        raise SystemExit(1)
    raw = path.read_bytes()
    if re.fullmatch(r"\.caddy\.env\.[A-Za-z0-9]{10}", path.name):
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise SystemExit(1)
        path.unlink()
        continue
    if token and token in raw:
        raise SystemExit(1)
directory = os.open(root, os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
if any(re.fullmatch(r"\.caddy\.env\.[A-Za-z0-9]{10}", path.name) for path in root.iterdir()):
    raise SystemExit(1)
PY
all_ids="$(docker container ls --all --quiet --no-trunc)"
if test -n "${all_ids}" && test -e "${token_file}"; then
  # The token path, not its value, is the only argument. Docker metadata is
  # streamed and rejected if any Config/label/mount field retains the token.
  docker inspect ${all_ids} | python3 -c 'import json,pathlib,sys; token=pathlib.Path(sys.argv[1]).read_text(encoding="ascii").strip(); data=json.load(sys.stdin); raise SystemExit(1 if token and token in json.dumps(data,separators=(",",":"),sort_keys=True) else 0)' "${token_file}"
fi
rm -f -- "${inspection_file}"
trap - EXIT
if test -e "${backup}"; then rm -- "${backup}"; fi
if test -e "${token_file}"; then rm -- "${token_file}"; fi
sync /var/lib/refunddesk/control
if test "${watchdog_pair}" = present; then
  python3 - "${watchdog_marker}" "${watchdog_receipt}" "${watchdog_identity_transition}" "${nonce}" "${revision}" "${new_id}" <<'PY'
import ctypes, errno, hashlib, json, os, pathlib, stat, sys, tempfile

marker_path, receipt_path, transition_path = map(pathlib.Path, sys.argv[1:4])
nonce, revision, new_id = sys.argv[4:]

def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate")
        result[key] = value
    return result

def read(path):
    raw = path.read_bytes()
    document = json.loads(raw.decode("ascii"), object_pairs_hook=pairs)
    canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
    if raw != canonical:
        raise SystemExit(1)
    return document, raw

def canonical_bytes(document):
    return (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")

def fsync_directory():
    directory = os.open(marker_path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def rename_noreplace(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOSYS, errno.EINVAL}:
            raise SystemExit(1)
        raise OSError(error, os.strerror(error))

def replace(path, document):
    raw = canonical_bytes(document)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise SystemExit(1)
            offset += written
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        fsync_directory()
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)
    return raw

def publish_new(path, document):
    raw = canonical_bytes(document)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise SystemExit(1)
            offset += written
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        fsync_directory()
        rename_noreplace(temporary, path)
        fsync_directory()
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)

marker, marker_before_raw = read(marker_path)
receipt, receipt_before_raw = read(receipt_path)
if marker.get("nonce") != nonce or marker.get("expectedRevision") != revision or marker.get("state") not in {"armed", "contained"}:
    raise SystemExit(1)
if receipt.get("nonce") != nonce or receipt.get("expectedRevision") != revision or receipt.get("caddyContainerId") != marker.get("caddyContainerId") or receipt.get("workerContainerId") != marker.get("workerContainerId"):
    raise SystemExit(1)
marker_before_sha = hashlib.sha256(marker_before_raw).hexdigest()
receipt_before_sha = hashlib.sha256(receipt_before_raw).hexdigest()
if receipt.get("markerSha256") != marker_before_sha:
    raise SystemExit(1)
old_id = marker.get("caddyContainerId")
if old_id == new_id:
    raise SystemExit(1)
marker_after = dict(marker)
marker_after["caddyContainerId"] = new_id
marker_after_raw = canonical_bytes(marker_after)
marker_after_sha = hashlib.sha256(marker_after_raw).hexdigest()
receipt_after = dict(receipt)
receipt_after["caddyContainerId"] = new_id
receipt_after["markerSha256"] = marker_after_sha
receipt_after_raw = canonical_bytes(receipt_after)
transition = {
    "expectedRevision": revision,
    "kind": "refunddesk.edge-window-caddy-identity-transition",
    "markerAfterSha256": marker_after_sha,
    "markerBeforeSha256": marker_before_sha,
    "newCaddyContainerId": new_id,
    "nonce": nonce,
    "oldCaddyContainerId": old_id,
    "receiptAfterSha256": hashlib.sha256(receipt_after_raw).hexdigest(),
    "receiptBeforeSha256": receipt_before_sha,
    "schemaVersion": 1,
    "workerContainerId": marker.get("workerContainerId"),
}
publish_new(transition_path, transition)
if replace(marker_path, marker_after) != marker_after_raw:
    raise SystemExit(1)
if replace(receipt_path, receipt_after) != receipt_after_raw:
    raise SystemExit(1)
transition_path.unlink()
fsync_directory()
PY
fi
running_caddy_ids="$(docker container ls --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy)"
test -z "${running_caddy_ids}"
if test -n "${old_id}"; then ! docker inspect "${old_id}" >/dev/null 2>&1; fi
flock --unlock 9
exec 9>&-
printf '%s' "${new_id}" | sha256sum | cut -d ' ' -f 1
REMOTE
    )" || {
      production_error TOOL_UNAVAILABLE
      return
    }
  fi
  [[ "${restored_caddy_sha}" =~ ^[0-9a-f]{64}$ ]] || {
    production_error TOOL_UNAVAILABLE
    return
  }
  jq --null-input --compact-output --sort-keys \
    --arg providerState "${provider_state}" \
    --arg finalCaddyContainerIdSha256 "${restored_caddy_sha}" \
    --argjson originUpdates "${origin_updates}" \
    --argjson updateAttempts "${update_attempts}" \
    --argjson etagBindMatched "${etag_bind_matched}" \
    --argjson etagUnbindMatched "${etag_unbind_matched}" \
    '{containment:{originHeaderRemoved:true},mutations:{originUpdates:$originUpdates},origin:{etagBindMatched:$etagBindMatched,etagUnbindMatched:$etagUnbindMatched,headerRemoved:true,unboundDeployed:true,updateAttempts:$updateAttempts},topology:{finalCaddyContainerIdSha256:$finalCaddyContainerIdSha256}}'
}

production_origin_status() {
  local distribution origin current deployed before original unbind_update receipt expected_etag expected_config_sha
  local current_config_sha token_sha=none final_caddy_sha observed_caddy_sha observed_host observed_boot_sha
  local receipt_temporary expected_boot current_fail_safe boot_stable=true receipt_required=false
  local etag_bind_matched etag_unbind_matched receipt_bytes="" receipt_present=false
  distribution="$(transport_value distributionId)"
  origin="$(transport_value originId)"
  current="${OPERATION_ROOT}/cloudfront.status-config.json"
  deployed="${OPERATION_ROOT}/cloudfront.status-distribution.json"
  before="${OPERATION_ROOT}/cloudfront.before.json"
  original="${OPERATION_ROOT}/cloudfront.original-config.json"
  unbind_update="${OPERATION_ROOT}/cloudfront.unbind-update.json"
  receipt="${OPERATION_ROOT}/origin-status-receipt.json"
  if require_facts '.intents.originGcAttempted == true or .origin.tokenFileRemoved == true or .containment.tokenRemoved == true'; then
    receipt_required=true
  elif [[ ! -f "${original}" ]] &&
    require_facts '.origin.updateAttempts > 0 or .mutations.originUpdates > 0'; then
    # Raw provider documents are intentionally destroyed by GC.  Once an
    # origin effect occurred, their absence leaves the private receipt as the
    # sole immutable authority for the restored config/ETag/token binding.
    receipt_required=true
  fi
  if [[ "${receipt_required}" == true ]] &&
    { [[ ! -f "${receipt}" ]] || [[ -L "${receipt}" ]]; }; then
    production_error ETAG_RACE
    return
  fi
  etag_bind_matched="$(jq --raw-output '.origin.etagBindMatched // false' "${FACTS_FILE}")" || etag_bind_matched=false
  etag_unbind_matched="$(jq --raw-output '.origin.etagUnbindMatched // false' "${FACTS_FILE}")" || etag_unbind_matched=false
  [[ "${etag_bind_matched}" == true || "${etag_bind_matched}" == false ]] || etag_bind_matched=false
  [[ "${etag_unbind_matched}" == true || "${etag_unbind_matched}" == false ]] || etag_unbind_matched=false
  bounded_aws_command 30 cloudfront get-distribution-config --id "${distribution}" --output json >"${current}" || {
    production_error ETAG_RACE
    return
  }
  bounded_aws_command 30 cloudfront get-distribution --id "${distribution}" --output json >"${deployed}" || {
    production_error NEVER_DEPLOYED
    return
  }
  (( $(wc --bytes <"${current}") <= 2097152 && $(wc --bytes <"${deployed}") <= 2097152 )) || {
    production_error ETAG_RACE
    return
  }
  if [[ -e "${receipt}" || -L "${receipt}" ]]; then
    receipt_bytes="$(controlled_file_bytes_once "${receipt}" 4096)" || {
      production_error ETAG_RACE
      return
    }
    receipt_present=true
    [[ "$(jq --compact-output --sort-keys . <<<"${receipt_bytes}")" == "${receipt_bytes}" ]] || {
      production_error ETAG_RACE
      return
    }
    jq --exit-status --arg nonce "${NONCE}" --arg revision "${EXPECTED_REVISION}" '
      type == "object"
      and keys == ["configurationSha256","etag","expectedRevision","finalCaddyContainerIdSha256","kind","nonce","schemaVersion","transientTokenSha256"]
      and .schemaVersion == 1 and .kind == "refunddesk.edge-window-origin-status-receipt"
      and .nonce == $nonce and .expectedRevision == $revision
      and (.etag | type == "string" and test("^[A-Za-z0-9_=+-]{1,256}$"))
      and (.configurationSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.finalCaddyContainerIdSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.transientTokenSha256 == "none" or (.transientTokenSha256 | type == "string" and test("^[0-9a-f]{64}$")))
    ' <<<"${receipt_bytes}" >/dev/null || {
      production_error ETAG_RACE
      return
    }
    expected_etag="$(jq --raw-output '.etag' <<<"${receipt_bytes}")"
    expected_config_sha="$(jq --raw-output '.configurationSha256' <<<"${receipt_bytes}")"
    token_sha="$(jq --raw-output '.transientTokenSha256' <<<"${receipt_bytes}")"
  elif [[ -f "${original}" ]]; then
    if [[ -f "${unbind_update}" ]]; then
      expected_etag="$(jq --raw-output '.ETag // empty' "${unbind_update}")"
    elif [[ -f "${before}" ]]; then
      # A bind that never reached the provider preserves the exact baseline
      # ETag. Any equal-byte document under a different ETag is a third-party
      # rollback and is not an admissible restoration.
      expected_etag="$(jq --raw-output '.ETag // empty' "${before}")"
    else
      production_error ETAG_RACE
      return
    fi
    [[ "${expected_etag}" =~ ^[A-Za-z0-9_=+-]{1,256}$ ]] || {
      production_error ETAG_RACE
      return
    }
    jq --exit-status --arg expectedEtag "${expected_etag}" --slurpfile expected "${original}" '
      .ETag == $expectedEtag and .DistributionConfig == $expected[0]
    ' "${current}" >/dev/null || {
      production_error ETAG_RACE
      return
    }
  fi
  if [[ "${receipt_present}" == true ]] && ! jq --exit-status --arg expectedEtag "${expected_etag}" '.ETag == $expectedEtag' "${current}" >/dev/null; then
    production_error ETAG_RACE
    return
  fi
  current_config_sha="$(jq --compact-output --sort-keys '.DistributionConfig' "${current}" | sha256sum | cut -d ' ' -f 1)" || {
    production_error ETAG_RACE
    return
  }
  [[ "${current_config_sha}" =~ ^[0-9a-f]{64}$ ]] || {
    production_error ETAG_RACE
    return
  }
  if [[ -n "${expected_config_sha:-}" && "${current_config_sha}" != "${expected_config_sha}" ]]; then
    production_error ETAG_RACE
    return
  fi
  # Always prove the transient header absent, even on cleanup before bind or
  # after facts already recorded a prior successful unbind.
  jq --exit-status --arg origin "${origin}" '
    ([.DistributionConfig.Origins.Items[] | select(.Id == $origin)] | length) == 1
    and ([.DistributionConfig.Origins.Items[] | select(.Id == $origin)
      | (.OriginCustomHeaders.Items // [])[]
      | select((.HeaderName | ascii_downcase) == "x-refunddesk-origin-token")] | length) == 0
  ' "${current}" >/dev/null || {
    production_error ETAG_RACE
    return
  }
  jq --exit-status --arg distribution "${distribution}" --slurpfile current "${current}" '
    .Distribution.Id == $distribution
    and .Distribution.Status == "Deployed"
    and .Distribution.DistributionConfig == $current[0].DistributionConfig
  ' "${deployed}" >/dev/null || {
    production_error NEVER_DEPLOYED
    return
  }
  if [[ -f "${OPERATION_ROOT}/origin-token" && ! -L "${OPERATION_ROOT}/origin-token" ]]; then
    grep -Eq '^[A-Za-z0-9_-]{43}$' "${OPERATION_ROOT}/origin-token" || {
      production_error TOOL_UNAVAILABLE
      return
    }
    token_sha="$(hash_file "${OPERATION_ROOT}/origin-token")" || {
      production_error TOOL_UNAVAILABLE
      return
    }
  fi
  final_caddy_sha="$(jq --raw-output '.topology.finalCaddyContainerIdSha256 // empty' "${FACTS_FILE}")" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  [[ "${token_sha}" == none || "${token_sha}" =~ ^[0-9a-f]{64}$ ]]
  [[ "${final_caddy_sha}" =~ ^[0-9a-f]{64}$ ]] || {
    production_error TOOL_UNAVAILABLE
    return
  }
  if [[ "${receipt_present}" == true && "${final_caddy_sha}" != "$(jq --raw-output '.finalCaddyContainerIdSha256' <<<"${receipt_bytes}")" ]]; then
    production_error ETAG_RACE
    return
  fi
  expected_boot="$(window_boot_argument)" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  current_fail_safe="$(jq --raw-output '.watchdog.failSafeContained // false' "${FACTS_FILE}")" || current_fail_safe=false
  [[ "${current_fail_safe}" == true || "${current_fail_safe}" == false ]] || current_fail_safe=false
  observed_host="$(ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${final_caddy_sha}' '${token_sha}'" <<'REMOTE'
set +x
set -o pipefail
exec 2>/dev/null
revision="$1"; expected_caddy_sha="$2"; transient_sha="$3"
current=/etc/refunddesk/caddy.env
test -f "${current}" && test ! -L "${current}"
test "$(stat --format='%U:%G:%a' "${current}")" = root:root:600
caddy_ids="$(docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy)"
[[ "${caddy_ids}" =~ ^[0-9a-f]{64}$ ]]
test "$(printf '%s' "${caddy_ids}" | sha256sum | cut -d ' ' -f 1)" = "${expected_caddy_sha}"
set +e
docker inspect "${caddy_ids}" | head --bytes=2097153 | python3 -c '
import hashlib,json,pathlib,re,sys
container_id,revision,env_path,transient_sha=sys.argv[1:]
raw=sys.stdin.buffer.read(2_097_154)
if len(raw)>2_097_152: raise SystemExit(1)
inspection=json.loads(raw)
env_raw=pathlib.Path(env_path).read_bytes()
if len(env_raw)>65536 or not env_raw.endswith(b"\n"): raise SystemExit(1)
tokens=[line.split(b"=",1)[1] for line in env_raw.splitlines() if line.startswith(b"REFUNDDESK_EDGE_ORIGIN_TOKEN=")]
if len(tokens)!=1 or re.fullmatch(rb"[A-Za-z0-9_-]{43}",tokens[0]) is None: raise SystemExit(1)
if transient_sha!="none" and hashlib.sha256(tokens[0]).hexdigest()==transient_sha: raise SystemExit(1)
if len(inspection)!=1: raise SystemExit(1)
item=inspection[0]; labels=item["Config"]["Labels"]; env=item["Config"]["Env"]
origin_env=[value for value in env if value.startswith("REFUNDDESK_EDGE_ORIGIN_TOKEN=")]
if len(origin_env)!=1 or origin_env[0].encode("ascii").split(b"=",1)[1]!=tokens[0]: raise SystemExit(1)
if transient_sha!="none" and any(hashlib.sha256(value.encode("ascii").split(b"=",1)[-1]).hexdigest()==transient_sha for value in origin_env): raise SystemExit(1)
valid=(item["Id"]==container_id and item["State"]["Running"] is False
 and item["HostConfig"]["RestartPolicy"]["Name"]=="no"
 and labels.get("com.docker.compose.project")=="refunddesk"
 and labels.get("com.docker.compose.service")=="caddy"
 and labels.get("com.refunddesk.revision")==revision)
raise SystemExit(0 if valid else 1)
' "${caddy_ids}" "${revision}" "${current}" "${transient_sha}"
pipeline_status=("${PIPESTATUS[@]}")
set -e
(( pipeline_status[0] == 0 && pipeline_status[1] == 0 && pipeline_status[2] == 0 ))
printf '%s' "${caddy_ids}" | sha256sum | cut -d ' ' -f 1
tr -d '\n' </proc/sys/kernel/random/boot_id | sha256sum | cut -d ' ' -f 1
REMOTE
  )" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  [[ "${observed_host}" == *$'\n'* ]] || {
    production_error TOOL_UNAVAILABLE
    return
  }
  observed_caddy_sha="${observed_host%%$'\n'*}"
  observed_boot_sha="${observed_host#*$'\n'}"
  [[ "${observed_caddy_sha}" == "${final_caddy_sha}" && "${observed_boot_sha}" =~ ^[0-9a-f]{64}$ && "${observed_boot_sha}" != *$'\n'* ]] || {
    production_error TOOL_UNAVAILABLE
    return
  }
  if [[ "${current_fail_safe}" != true || ( "${expected_boot}" != none && "${observed_boot_sha}" != "${expected_boot}" ) ]]; then
    boot_stable=false
  fi
  if [[ "${receipt_present}" != true ]]; then
    [[ "${receipt_required}" != true ]] || {
      production_error ETAG_RACE
      return
    }
    receipt_temporary="$(mktemp --tmpdir="${OPERATION_ROOT}" '.edge-origin-status-receipt.XXXXXXXXXX')" || {
      production_error TOOL_UNAVAILABLE
      return
    }
    jq --null-input --compact-output --sort-keys \
      --arg configurationSha256 "${current_config_sha}" \
      --arg etag "$(jq --raw-output '.ETag' "${current}")" \
      --arg expectedRevision "${EXPECTED_REVISION}" \
      --arg finalCaddyContainerIdSha256 "${observed_caddy_sha}" \
      --arg nonce "${NONCE}" \
      --arg transientTokenSha256 "${token_sha}" \
      '{configurationSha256:$configurationSha256,etag:$etag,expectedRevision:$expectedRevision,finalCaddyContainerIdSha256:$finalCaddyContainerIdSha256,kind:"refunddesk.edge-window-origin-status-receipt",nonce:$nonce,schemaVersion:1,transientTokenSha256:$transientTokenSha256}' \
      >"${receipt_temporary}" || {
      production_error TOOL_UNAVAILABLE
      return
    }
    durable_replace "${receipt}" "${receipt_temporary}" || {
      production_error TOOL_UNAVAILABLE
      return
    }
  fi
  rm --force -- "${current}" "${deployed}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  sync --file-system "${OPERATION_ROOT}" 2>/dev/null || sync "${OPERATION_ROOT}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  jq --null-input --compact-output --sort-keys \
    --arg finalCaddyContainerIdSha256 "${observed_caddy_sha}" \
    --argjson bootStable "${boot_stable}" \
    --argjson etagBindMatched "${etag_bind_matched}" \
    --argjson etagUnbindMatched "${etag_unbind_matched}" \
    '{containment:{originHeaderRemoved:true},origin:{etagBindMatched:$etagBindMatched,etagUnbindMatched:$etagUnbindMatched,headerRemoved:true,unboundDeployed:true},topology:{finalCaddyContainerIdSha256:$finalCaddyContainerIdSha256},watchdog:{failSafeContained:$bootStable}}'
}

production_origin_secret_scan() {
  local token="${OPERATION_ROOT}/origin-token" receipt="${OPERATION_ROOT}/origin-status-receipt.json"
  local receipt_bytes="" token_sha=none post_gc=false
  if require_facts '.origin.tokenFileRemoved == true and .containment.tokenRemoved == true'; then
    post_gc=true
  fi
  [[ ! -e "${OPERATION_ROOT}/.origin-token.pending" && ! -L "${OPERATION_ROOT}/.origin-token.pending" ]] || {
    production_error TOOL_UNAVAILABLE
    return
  }
  if [[ -e "${receipt}" || -L "${receipt}" ]]; then
    receipt_bytes="$(controlled_file_bytes_once "${receipt}" 4096)" || {
      production_error TOOL_UNAVAILABLE
      return
    }
    token_sha="$(jq --raw-output '.transientTokenSha256 // "none"' <<<"${receipt_bytes}")" || {
      production_error TOOL_UNAVAILABLE
      return
    }
    [[ "${token_sha}" == none || "${token_sha}" =~ ^[0-9a-f]{64}$ ]] || {
      production_error TOOL_UNAVAILABLE
      return
    }
  fi
  if [[ -e "${token}" || -L "${token}" ]]; then
    [[ -f "${token}" && ! -L "${token}" ]] || {
      production_error TOOL_UNAVAILABLE
      return
    }
  fi
  timeout --signal=TERM --kill-after=1s 15s \
    python3 - "${CONTROL_ROOT}" "${OPERATION_ROOT}" "${token}" "${token_sha}" "${post_gc}" <<'PY' || {
# REFUNDDESK_EDGE_LOCAL_SECRET_SCAN_PY_BEGIN
import hashlib
import os
import pathlib
import re
import stat
import sys

control_root, operation_root, token_path = map(pathlib.Path, sys.argv[1:4])
expected_token_sha = sys.argv[4]
post_gc = sys.argv[5] == "true"
MAX_ENTRIES = 256
MAX_OPERATION_DIRECTORIES = 32
MAX_FILE_BYTES = 2_097_152
MAX_TOTAL_BYTES = 16_777_216
MAX_TOKEN_CANDIDATE_WINDOWS = 65_536
token_candidate_windows = 0

def read_regular(path, allowed_modes, maximum):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        path_before = os.lstat(path)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(1)
        if before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) not in allowed_modes or before.st_nlink != 1:
            raise SystemExit(1)
        if (path_before.st_dev, path_before.st_ino) != (before.st_dev, before.st_ino):
            raise SystemExit(1)
        if before.st_size < 0 or before.st_size > maximum:
            raise SystemExit(1)
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(descriptor, min(65_536, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(descriptor)
        path_after = os.lstat(path)
        identity_before = (
            before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
            before.st_ctime_ns, before.st_mode, before.st_uid, before.st_gid, before.st_nlink,
        )
        identity_after = (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
            after.st_ctime_ns, after.st_mode, after.st_uid, after.st_gid, after.st_nlink,
        )
        if identity_before != identity_after or (path_after.st_dev, path_after.st_ino) != (after.st_dev, after.st_ino):
            raise SystemExit(1)
        if len(data) != before.st_size or len(data) > maximum:
            raise SystemExit(1)
        return bytes(data)
    finally:
        os.close(descriptor)

raw = None
if os.path.lexists(token_path):
    if post_gc:
        raise SystemExit(1)
    raw = read_regular(token_path, {0o600}, 43)
    if re.fullmatch(rb"[A-Za-z0-9_-]{43}", raw) is None:
        raise SystemExit(1)
    if re.fullmatch(r"[0-9a-f]{64}", expected_token_sha) is None:
        raise SystemExit(1)
    if hashlib.sha256(raw).hexdigest() != expected_token_sha:
        raise SystemExit(1)
elif expected_token_sha != "none" and re.fullmatch(r"[0-9a-f]{64}", expected_token_sha) is None:
    raise SystemExit(1)

def contains_transient_token(data):
    global token_candidate_windows
    if raw is not None and raw in data:
        return True
    if expected_token_sha == "none":
        return False
    for match in re.finditer(rb"[A-Za-z0-9_-]{43,}", data):
        candidate_run = match.group(0)
        windows = len(candidate_run) - 42
        token_candidate_windows += windows
        if token_candidate_windows > MAX_TOKEN_CANDIDATE_WINDOWS:
            raise SystemExit(1)
        for offset in range(windows):
            if hashlib.sha256(candidate_run[offset:offset + 43]).hexdigest() == expected_token_sha:
                return True
    return False

control_entries = sorted(control_root.iterdir(), key=lambda path: path.name)
if len(control_entries) > MAX_ENTRIES:
    raise SystemExit(1)
total = 0
operation_directories = []
for path in control_entries:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(1)
    if stat.S_ISDIR(info.st_mode):
        if re.fullmatch(r"edge-window-operation-[0-9a-f]{64}", path.name) is None:
            raise SystemExit(1)
        operation_directories.append(path)
        continue
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit(1)
    data = read_regular(path, {0o400, 0o600}, MAX_FILE_BYTES)
    total += len(data)
    if total > MAX_TOTAL_BYTES or contains_transient_token(data):
        raise SystemExit(1)

if operation_root not in operation_directories or len(operation_directories) > MAX_OPERATION_DIRECTORIES:
    raise SystemExit(1)
operation_entry_count = 0
for directory in operation_directories:
    entries = sorted(directory.iterdir(), key=lambda path: path.name)
    operation_entry_count += len(entries)
    if len(entries) > MAX_ENTRIES or operation_entry_count > MAX_ENTRIES:
        raise SystemExit(1)
    for path in entries:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise SystemExit(1)
        if directory == operation_root:
            is_recovery_material = path == token_path or (
                path.name.startswith("cloudfront.") and path.name.endswith(".json")
            )
            if is_recovery_material:
                if post_gc:
                    raise SystemExit(1)
                continue
        data = read_regular(path, {0o400, 0o600}, MAX_FILE_BYTES)
        total += len(data)
        if total > MAX_TOTAL_BYTES or contains_transient_token(data):
            raise SystemExit(1)
# REFUNDDESK_EDGE_LOCAL_SECRET_SCAN_PY_END
PY
    production_error TOOL_UNAVAILABLE
    return
  }
  ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${NONCE}'" <<'REMOTE' >/dev/null || {
set +x
exec 2>/dev/null
revision="$1"; nonce="$2"
control=/var/lib/refunddesk/control
for residue in \
  "${control}/edge-window-caddy-${nonce}.before" \
  "${control}/.edge-window-caddy-${nonce}.before.pending" \
  "${control}/edge-window-origin-token-${nonce}" \
  "${control}/.edge-window-origin-token-${nonce}.pending" \
  "${control}/edge-caddy-inspect-${nonce}.json"; do
  test ! -e "${residue}" && test ! -L "${residue}"
done
shopt -s nullglob
caddy_env_candidates=(/etc/refunddesk/.caddy.env.??????????)
shopt -u nullglob
(( ${#caddy_env_candidates[@]} == 0 ))
current=/etc/refunddesk/caddy.env
test "$(stat --format='%U:%G:%a' "${current}")" = root:root:600
test "$(grep -Ec '^REFUNDDESK_EDGE_ORIGIN_TOKEN=[A-Za-z0-9_-]{43}$' "${current}")" = 1
id="$(timeout --signal=TERM --kill-after=1s 3s docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy)"
[[ "${id}" =~ ^[0-9a-f]{64}$ ]]
set +e
timeout --signal=TERM --kill-after=1s 5s docker inspect "${id}" | head --bytes=2097153 | jq --exit-status --arg id "${id}" --arg revision "${revision}" --rawfile caddyEnv "${current}" '
  ($caddyEnv | split("\n") | map(select(startswith("REFUNDDESK_EDGE_ORIGIN_TOKEN=")))) as $tokenLines
  | ($tokenLines | length) == 1
  and ($tokenLines[0] | test("^REFUNDDESK_EDGE_ORIGIN_TOKEN=[A-Za-z0-9_-]{43}$"))
  and
  length == 1 and .[0].Id == $id
  and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
  and .[0].Config.Labels["com.docker.compose.service"] == "caddy"
  and .[0].Config.Labels["com.refunddesk.revision"] == $revision
  and .[0].HostConfig.RestartPolicy.Name == "no" and .[0].State.Running == false
  and ([.[0].Config.Env[] | select(. == $tokenLines[0])] | length) == 1
' >/dev/null
pipeline_status=("${PIPESTATUS[@]}")
set -e
(( pipeline_status[0] == 0 && pipeline_status[1] == 0 && pipeline_status[2] == 0 ))
REMOTE
    production_error TOOL_UNAVAILABLE
    return
  }
  jq --null-input --compact-output --sort-keys '{intents:{originGcScanPassed:true}}'
}

production_origin_gc() {
  local receipt="${OPERATION_ROOT}/origin-status-receipt.json"
  require_facts '.intents.originGcScanPassed == true' || {
    production_error TOOL_UNAVAILABLE
    return
  }
  controlled_file "${receipt}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  jq --exit-status --arg nonce "${NONCE}" --arg revision "${EXPECTED_REVISION}" '
    .kind == "refunddesk.edge-window-origin-status-receipt"
    and .schemaVersion == 1 and .nonce == $nonce and .expectedRevision == $revision
  ' "${receipt}" >/dev/null || {
    production_error TOOL_UNAVAILABLE
    return
  }
  rm --force -- "${OPERATION_ROOT}/origin-token" "${OPERATION_ROOT}/.origin-token.pending" "${OPERATION_ROOT}"/cloudfront.*.json || {
    production_error TOOL_UNAVAILABLE
    return
  }
  sync --file-system "${OPERATION_ROOT}" 2>/dev/null || sync "${OPERATION_ROOT}" || {
    production_error TOOL_UNAVAILABLE
    return
  }
  if [[ -e "${OPERATION_ROOT}/origin-token" || -e "${OPERATION_ROOT}/.origin-token.pending" ||
    -L "${OPERATION_ROOT}/.origin-token.pending" ]] || compgen -G "${OPERATION_ROOT}/cloudfront.*.json" >/dev/null; then
    production_error TOOL_UNAVAILABLE
    return
  fi
  jq --null-input --compact-output --sort-keys \
    '{containment:{tokenRemoved:true},origin:{tokenFileRemoved:true}}'
}

production_firewall_open() {
  local before="${OPERATION_ROOT}/lightsail-before.json"
  local preopen="${OPERATION_ROOT}/lightsail-preopen.json"
  local desired="${OPERATION_ROOT}/lightsail-open-port-infos.json"
  local response="${OPERATION_ROOT}/lightsail-open-response.json"
  local observed="${OPERATION_ROOT}/lightsail-open-observed.json"
  local instance expected_ssh before_sha preopen_sha opened_sha allowlist guard
  local query='{portStates:portStates[].{fromPort:fromPort,toPort:toPort,protocol:protocol,state:state,cidrs:cidrs,ipv6Cidrs:ipv6Cidrs,cidrListAliases:cidrListAliases}}'
  instance="$(transport_value instanceName)"
  expected_ssh="$(transport_value expectedSshCidr)"
  allowlist="${OPERATION_ROOT}/cloudfront-origin-facing.json"
  [[ -f "${allowlist}" ]] || {
    production_error FIREWALL_INVALID
    return
  }
  [[ -f "${before}" ]] || {
    production_error FIREWALL_INVALID
    return
  }
  jq --null-input --compact-output --sort-keys --slurpfile allowlist "${allowlist}" '
    {cidrs:$allowlist[0].ipv4,fromPort:443,ipv6Cidrs:$allowlist[0].ipv6,protocol:"tcp",toPort:443}
  ' >"${desired}" || {
    production_error FIREWALL_INVALID
    return
  }
  validate_firewall_document "${before}" "${expected_ssh}" closed || {
    production_error FIREWALL_INVALID
    return
  }
  before_sha="$(jq --compact-output --sort-keys . "${before}" | sha256sum | cut -d ' ' -f 1)"
  aws_command lightsail get-instance-port-states --instance-name "${instance}" \
    --query "${query}" --output json >"${preopen}" || {
    production_error FIREWALL_INVALID
    return
  }
  validate_firewall_document "${preopen}" "${expected_ssh}" closed || {
    production_error FIREWALL_INVALID
    return
  }
  preopen_sha="$(jq --compact-output --sort-keys . "${preopen}" | sha256sum | cut -d ' ' -f 1)"
  [[ "${preopen_sha}" == "${before_sha}" ]] || {
    production_error FIREWALL_INVALID
    return
  }
  # Re-observe the host monotonic clock after the final firewall CAS and
  # reserve bounded time for the mutation, readback and emergency close.
  # This prevents a slow Caddy/probe phase from issuing an open at/after the
  # independently armed deadline.
  guard="$(production_window_clock_open_guard)" || {
    production_error FIREWALL_INVALID
    return
  }
  jq --exit-status 'type == "object" and length == 0' <<<"${guard}" >/dev/null || {
    production_error FIREWALL_INVALID
    return
  }
  bounded_aws_command "${FIREWALL_OPEN_MUTATION_SECONDS}" lightsail open-instance-public-ports --instance-name "${instance}" \
    --port-info "file://${desired}" \
    --query 'operation.{errorCode:errorCode,errorDetails:errorDetails,isTerminal:isTerminal,operationType:operationType,resourceName:resourceName,resourceType:resourceType,status:status}' \
    --output json >"${response}" || {
    production_error FIREWALL_INVALID
    return
  }
  validate_lightsail_operation "${response}" OpenInstancePublicPorts "${instance}" || {
    production_error FIREWALL_INVALID
    return
  }
  bounded_aws_command "${FIREWALL_OPEN_READBACK_SECONDS}" lightsail get-instance-port-states --instance-name "${instance}" \
    --query "${query}" --output json >"${observed}" || {
    production_error FIREWALL_INVALID
    return
  }
  validate_firewall_document "${observed}" "${expected_ssh}" open "${allowlist}" || {
    production_error FIREWALL_INVALID
    return
  }
  # The durable firewall intent is written before this operation.  Recheck the
  # watchdog state after the bounded AWS mutation/readback so a scheduled tick
  # that won the lock concurrently can only lead to immediate cleanup and 21;
  # it can never be normalized into an admitted window or PASS.
  guard="$(production_window_clock_open_guard)" || {
    production_error FIREWALL_INVALID
    return
  }
  jq --exit-status 'type == "object" and length == 0' <<<"${guard}" >/dev/null || {
    production_error FIREWALL_INVALID
    return
  }
  opened_sha="$(jq --compact-output --sort-keys . "${observed}" | sha256sum | cut -d ' ' -f 1)"
  jq --null-input --compact-output --sort-keys --arg beforeSha256 "${before_sha}" --arg openedSha256 "${opened_sha}" \
    '{firewall:{beforeSha256:$beforeSha256,exactPrefixSet:true,openObserved:true,openedSha256:$openedSha256,port80Closed:true,sshUnchanged:true,tcp443Only:true,udpClosed:true,wildcardAbsent:true},prefixes:{firewallMatched:true}}'
}

production_firewall_baseline() {
  local before="${1:-${OPERATION_ROOT}/lightsail-before.json}"
  local pending="${before}.pending"
  local instance expected_ssh before_sha
  local query='{portStates:portStates[].{fromPort:fromPort,toPort:toPort,protocol:protocol,state:state,cidrs:cidrs,ipv6Cidrs:ipv6Cidrs,cidrListAliases:cidrListAliases}}'
  instance="$(transport_value instanceName)"
  expected_ssh="$(transport_value expectedSshCidr)"
  if [[ ! -e "${before}" && ! -L "${before}" && ( -e "${pending}" || -L "${pending}" ) ]]; then
    # The baseline is read-only and must precede every ingress effect.  A
    # power loss during its pending write can therefore be retried, but only
    # after proving the sole deterministic pending inode is private.  A fully
    # canonical pending capture is published; a partial one is removed and
    # freshly observed.
    controlled_file "${pending}" || {
      production_error FIREWALL_INVALID
      return
    }
    if validate_firewall_document "${pending}" "${expected_ssh}" closed; then
      durable_replace "${before}" "${pending}" || {
        production_error TOOL_UNAVAILABLE
        return
      }
    else
      rm -- "${pending}" || {
        production_error TOOL_UNAVAILABLE
        return
      }
      sync --file-system "${OPERATION_ROOT}" 2>/dev/null || sync "${OPERATION_ROOT}" || {
        production_error TOOL_UNAVAILABLE
        return
      }
    fi
  fi
  if [[ ! -e "${before}" && ! -L "${before}" ]]; then
    (set -o noclobber; umask 077; aws_command lightsail get-instance-port-states --instance-name "${instance}" \
      --query "${query}" --output json >"${pending}") || {
      rm -f -- "${pending}"
      production_error TOOL_UNAVAILABLE
      return
    }
    controlled_file "${pending}" && validate_firewall_document "${pending}" "${expected_ssh}" closed || {
      production_error FIREWALL_INVALID
      return
    }
    durable_replace "${before}" "${pending}" || {
      production_error TOOL_UNAVAILABLE
      return
    }
  fi
  controlled_file "${before}" || {
    production_error FIREWALL_INVALID
    return
  }
  validate_firewall_document "${before}" "${expected_ssh}" closed || {
    production_error FIREWALL_INVALID
    return
  }
  before_sha="$(jq --compact-output --sort-keys . "${before}" | sha256sum | cut -d ' ' -f 1)"
  jq --null-input --compact-output --sort-keys --arg beforeSha256 "${before_sha}" \
    '{firewall:{beforeSha256:$beforeSha256}}'
}

production_firewall_close() {
  local before="${OPERATION_ROOT}/lightsail-before.json"
  local current="${OPERATION_ROOT}/lightsail-preclose.json"
  local restore="${OPERATION_ROOT}/lightsail-restore-port-infos.json"
  local response="${OPERATION_ROOT}/lightsail-close-response.json"
  local exact_close="${OPERATION_ROOT}/lightsail-close-exact.json"
  local observed="${OPERATION_ROOT}/lightsail-close-observed.json"
  local allowlist="${OPERATION_ROOT}/cloudfront-origin-facing.json"
  local close_lines="${OPERATION_ROOT}/lightsail-close-lines.jsonl"
  local instance before_sha after_sha expected_ssh close_count=0 close_success_count=0 close_info close_file
  local prior_close_count=0 total_close_count=0 firewall_open_attempted=false close_attempted_first=false
  local allowlist_ambiguous=false baseline_reconstructed=false
  local close_error=0 current_fetch_error=0 candidate_ambiguous=true close_started_seconds close_phase_deadline remaining
  local -a pipeline_status
  local query='{portStates:portStates[].{fromPort:fromPort,toPort:toPort,protocol:protocol,state:state,cidrs:cidrs,ipv6Cidrs:ipv6Cidrs,cidrListAliases:cidrListAliases}}'
  instance="$(transport_value instanceName)"
  expected_ssh="$(transport_value expectedSshCidr)"
  prior_close_count="$(jq --raw-output '.mutations.firewallCloses // 0' "${FACTS_FILE}")" || {
    production_error CLOSE_AMBIGUOUS
    return
  }
  [[ "${prior_close_count}" =~ ^[0-9]+$ ]] || {
    production_error CLOSE_AMBIGUOUS
    return
  }
  close_started_seconds="${SECONDS}"
  close_phase_deadline=$((close_started_seconds + FIREWALL_CLOSE_TOTAL_SECONDS - FIREWALL_CLOSE_READBACK_SECONDS))
  firewall_open_attempted="$(jq --raw-output '.intents.firewallOpenAttempted' "${FACTS_FILE}")" || {
    production_error CLOSE_AMBIGUOUS
    return
  }
  [[ "${firewall_open_attempted}" == true || "${firewall_open_attempted}" == false ]] || {
    production_error CLOSE_AMBIGUOUS
    return
  }
  if [[ -f "${allowlist}" && ! -L "${allowlist}" ]] && jq --compact-output --sort-keys '
    select(type == "object" and (.ipv4 | type == "array") and (.ipv6 | type == "array"))
    | {cidrs:.ipv4,fromPort:443,ipv6Cidrs:.ipv6,protocol:"tcp",toPort:443}
  ' "${allowlist}" >"${exact_close}"; then
    # The exact authorized rule is always closed before any provider inventory
    # or early decision.  An accepted open can become visible after its lost
    # response/readback; a pre-close read is therefore not a safe substitute.
    close_count=1
    close_attempted_first=true
    remaining=$((close_phase_deadline - SECONDS))
    if (( remaining <= 0 )); then
      close_error=1
    else
      (( remaining > FIREWALL_CLOSE_MUTATION_SECONDS )) && remaining="${FIREWALL_CLOSE_MUTATION_SECONDS}"
      if ! bounded_aws_command "${remaining}" lightsail close-instance-public-ports --instance-name "${instance}" \
        --port-info "file://${exact_close}" \
        --query 'operation.{errorCode:errorCode,errorDetails:errorDetails,isTerminal:isTerminal,operationType:operationType,resourceName:resourceName,resourceType:resourceType,status:status}' \
        --output json >"${response}.1"; then
        close_error=1
      elif validate_lightsail_operation "${response}.1" CloseInstancePublicPorts "${instance}"; then
        close_success_count=1
      else
        close_error=1
      fi
    fi
  elif [[ "${firewall_open_attempted}" == true ]]; then
    # The exact allowlist authority is unavailable, so attribution is lost.
    # Continue with a bounded provider inventory and close every parseable
    # dangerous rule before returning INCOMPLETE; never return pre-close.
    allowlist_ambiguous=true
  fi
  set +e
  bounded_aws_command "${FIREWALL_CLOSE_READBACK_SECONDS}" lightsail get-instance-port-states --instance-name "${instance}" \
    --query "${query}" --output json | head --bytes=2097153 >"${current}"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  if (( pipeline_status[0] != 0 || pipeline_status[1] != 0 )) || (( $(wc --bytes <"${current}") > 2097152 )); then
    # Even an unreadable provider state cannot suppress the minimum removal
    # attempt for the exact TCP/443 rule this operation opened.
    current_fetch_error=1
    printf '%s\n' '{}' >"${current}" || {
      production_error CLOSE_AMBIGUOUS
      return
    }
  fi
  # Build a best-effort removal set.  It always contains the exact rule this
  # operation intended to open, then adds every parseable observed rule whose
  # range covers 80 or 443, regardless of protocol, wildcard or prefix drift.
  # Malformed observations therefore cannot suppress the minimum close call.
  candidate_ambiguous="$(python3 - "${current}" "${allowlist}" "${restore}" "${FIREWALL_CLOSE_EXTRA_LIMIT}" "${close_attempted_first}" false <<'PY' || true
# REFUNDDESK_EDGE_FIREWALL_CLOSE_CANDIDATES_PY_BEGIN
import json, pathlib, sys

current_path, allowlist_path, output_path = map(pathlib.Path, sys.argv[1:4])
extra_limit = int(sys.argv[4])
skip_exact = len(sys.argv) > 5 and sys.argv[5] == "true"
require_allowlist = len(sys.argv) <= 6 or sys.argv[6] == "true"
exact = None
try:
    with allowlist_path.open(encoding="utf-8") as stream:
        allowlist = json.load(stream)
    if not isinstance(allowlist, dict) or not isinstance(allowlist.get("ipv4"), list) or not isinstance(allowlist.get("ipv6"), list):
        raise ValueError("allowlist")
    exact = {"cidrs": allowlist["ipv4"], "fromPort": 443, "ipv6Cidrs": allowlist["ipv6"], "protocol": "tcp", "toPort": 443}
except Exception:
    if require_allowlist:
        raise
candidates = [exact] if exact is not None and not skip_exact else []
ambiguous = False
try:
    with current_path.open(encoding="utf-8") as stream:
        current = json.load(stream)
    states = current.get("portStates", []) if isinstance(current, dict) else []
    if not isinstance(states, list) or len(states) > 64:
        ambiguous = True
        states = states[:64] if isinstance(states, list) else []
except Exception:
    ambiguous = True
    states = []
for state in states:
    try:
        if not isinstance(state, dict) or state.get("state") != "open":
            continue
        start, end = state.get("fromPort"), state.get("toPort")
        protocol = state.get("protocol")
        if not isinstance(start, int) or isinstance(start, bool) or not isinstance(end, int) or isinstance(end, bool):
            ambiguous = True
            continue
        if start < 0 or end > 65535 or start > end or not isinstance(protocol, str) or not protocol:
            ambiguous = True
            continue
        if not (start <= 80 <= end or start <= 443 <= end):
            continue
        cidrs = state.get("cidrs", [])
        ipv6 = state.get("ipv6Cidrs", [])
        aliases = state.get("cidrListAliases", [])
        if not all(isinstance(values, list) and all(isinstance(value, str) for value in values) for values in (cidrs, ipv6, aliases)):
            ambiguous = True
            continue
        item = {"cidrs": cidrs, "fromPort": start, "ipv6Cidrs": ipv6, "protocol": protocol, "toPort": end}
        if aliases:
            item["cidrListAliases"] = aliases
        if exact is None or item != exact:
            # Cleanup still removes every bounded dangerous rule and requires
            # the exact final baseline, but any additional exposure observed
            # after this operation's exact open invalidates CloudFront-only
            # attribution and permanently disables PASS.
            ambiguous = True
        candidates.append(item)
    except Exception:
        ambiguous = True
        continue
seen = set()
if exact is not None and skip_exact:
    seen.add(json.dumps(exact, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
ordered = []
for item in candidates:
    key = json.dumps(item, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    if key in seen:
        continue
    seen.add(key)
    if len(ordered) > extra_limit:
        ambiguous = True
        continue
    ordered.append(item)
data = (json.dumps(ordered, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode()
with output_path.open("wb") as stream:
    stream.write(data)
print("true" if ambiguous else "false")
# REFUNDDESK_EDGE_FIREWALL_CLOSE_CANDIDATES_PY_END
PY
  )"
  [[ "${candidate_ambiguous}" == true || "${candidate_ambiguous}" == false ]] || candidate_ambiguous=true
  jq --compact-output '.[]' "${restore}" >"${close_lines}" || {
    production_error CLOSE_AMBIGUOUS
    return
  }
  while IFS= read -r close_info; do
    [[ -n "${close_info}" ]] || continue
    close_count=$((close_count + 1))
    [[ "${close_attempted_first}" == true ]] || close_attempted_first=true
    close_file="${OPERATION_ROOT}/lightsail-close-port-info-${close_count}.json"
    if ! printf '%s\n' "${close_info}" >"${close_file}"; then
      close_error=1
      continue
    fi
    remaining=$((close_phase_deadline - SECONDS))
    if (( remaining <= 0 )); then
      close_error=1
      break
    fi
    (( remaining > FIREWALL_CLOSE_MUTATION_SECONDS )) && remaining="${FIREWALL_CLOSE_MUTATION_SECONDS}"
    if ! bounded_aws_command "${remaining}" lightsail close-instance-public-ports --instance-name "${instance}" \
      --port-info "file://${close_file}" \
      --query 'operation.{errorCode:errorCode,errorDetails:errorDetails,isTerminal:isTerminal,operationType:operationType,resourceName:resourceName,resourceType:resourceType,status:status}' \
      --output json >"${response}.${close_count}"; then
      close_error=1
      continue
    fi
    if validate_lightsail_operation "${response}.${close_count}" CloseInstancePublicPorts "${instance}"; then
      close_success_count=$((close_success_count + 1))
    else
      close_error=1
    fi
  done <"${close_lines}"
  remaining=$((close_started_seconds + FIREWALL_CLOSE_TOTAL_SECONDS - SECONDS))
  (( remaining > 0 )) || {
    production_error CLOSE_AMBIGUOUS
    return
  }
  (( remaining > FIREWALL_CLOSE_READBACK_SECONDS )) && remaining="${FIREWALL_CLOSE_READBACK_SECONDS}"
  set +e
  bounded_aws_command "${remaining}" lightsail get-instance-port-states --instance-name "${instance}" \
    --query "${query}" --output json | head --bytes=2097153 >"${observed}"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  if (( pipeline_status[0] != 0 || pipeline_status[1] != 0 )) || (( $(wc --bytes <"${observed}") > 2097152 )); then
    production_error CLOSE_AMBIGUOUS
    return
  fi
  validate_firewall_document "${observed}" "${expected_ssh}" closed || {
    production_error CLOSE_AMBIGUOUS
    return
  }
  after_sha="$(jq --compact-output --sort-keys . "${observed}" | sha256sum | cut -d ' ' -f 1)"
  # Recover a missing/partial baseline only from the final exact closed
  # readback, never before the close attempts.  This proves physical closure
  # while permanently marking attribution ambiguous. An uncontrolled original
  # pathname is preserved and a nonce-private recovery authority is used.
  if ! controlled_file "${before}" || ! validate_firewall_document "${before}" "${expected_ssh}" closed; then
    local recovered_before="${OPERATION_ROOT}/lightsail-before-recovered.json" recovered_temporary
    baseline_reconstructed=true
    if controlled_file "${before}"; then
      rm -- "${before}" || {
        production_error CLOSE_AMBIGUOUS
        return
      }
    elif [[ -e "${before}" || -L "${before}" ]]; then
      before="${recovered_before}"
    fi
    if ! controlled_file "${before}" || ! validate_firewall_document "${before}" "${expected_ssh}" closed; then
      if controlled_file "${before}"; then rm -- "${before}"; fi
      [[ ! -e "${before}" && ! -L "${before}" ]] || {
        production_error CLOSE_AMBIGUOUS
        return
      }
      recovered_temporary="$(mktemp --tmpdir="${OPERATION_ROOT}" '.lightsail-before-recovered.XXXXXXXXXX')" || {
        production_error CLOSE_AMBIGUOUS
        return
      }
      jq --compact-output --sort-keys . "${observed}" >"${recovered_temporary}" || {
        production_error CLOSE_AMBIGUOUS
        return
      }
      durable_replace "${before}" "${recovered_temporary}" || {
        production_error CLOSE_AMBIGUOUS
        return
      }
    fi
  fi
  controlled_file "${before}" && validate_firewall_document "${before}" "${expected_ssh}" closed || {
    production_error CLOSE_AMBIGUOUS
    return
  }
  before_sha="$(jq --compact-output --sort-keys . "${before}" | sha256sum | cut -d ' ' -f 1)"
  if [[ "${allowlist_ambiguous}" == true || "${baseline_reconstructed}" == true ]]; then
    candidate_ambiguous=true
  fi
  [[ "${before_sha}" == "${after_sha}" ]] || {
    production_error CLOSE_AMBIGUOUS
    return
  }
  total_close_count=$((prior_close_count + close_success_count))
  if (( close_error != 0 || current_fetch_error != 0 )) || [[ "${candidate_ambiguous}" == true ]]; then
    # Exact final provider bytes prove the edge closed, so local/host cleanup
    # must continue and may release its interlocks.  Lost ACKs, an unreadable
    # initial state or a capped candidate inventory still make attribution
    # ambiguous and force the terminal identity to INCOMPLETE/21.
    jq --null-input --compact-output --sort-keys --arg beforeSha256 "${before_sha}" --arg afterSha256 "${after_sha}" --argjson closeCount "${total_close_count}" --argjson closeAttemptedFirst "${close_attempted_first}" \
      '{containment:{awsIngressClosed:true},firewall:{afterSha256:$afterSha256,beforeSha256:$beforeSha256,closeAmbiguous:true,closeAttemptedFirst:$closeAttemptedFirst,closeObserved:true,finalClosed:true},mutations:{firewallCloses:$closeCount}}'
    return
  fi
  jq --null-input --compact-output --sort-keys --arg beforeSha256 "${before_sha}" --arg afterSha256 "${after_sha}" --argjson closeCount "${total_close_count}" --argjson closeAttemptedFirst "${close_attempted_first}" \
    '{containment:{awsIngressClosed:true},firewall:{afterSha256:$afterSha256,beforeSha256:$beforeSha256,closeAmbiguous:false,closeAttemptedFirst:$closeAttemptedFirst,closeObserved:true,finalClosed:true},mutations:{firewallCloses:$closeCount}}'
}

production_watchdog_arm() {
  local watchdog_source="deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh"
  local service_source="deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service"
  local timer_source="deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer"
  local watchdog_sha service_sha timer_sha marker_sha deadline_epoch
  watchdog_sha="$(hash_file "${watchdog_source}")" || {
    production_error WATCHDOG_INVALID
    return
  }
  service_sha="$(hash_file "${service_source}")" || {
    production_error WATCHDOG_INVALID
    return
  }
  timer_sha="$(hash_file "${timer_source}")" || {
    production_error WATCHDOG_INVALID
    return
  }
  marker_sha="$(hash_file "${WATCHDOG_MARKER}")" || {
    production_error WATCHDOG_INVALID
    return
  }
  deadline_epoch="$(timestamp_epoch "${DEADLINE_AT}")" || {
    production_error WATCHDOG_INVALID
    return
  }
  ssh_command "sudo bash -seu" <<'REMOTE_PREFLIGHT' >/dev/null || {
set +x
exec 2>/dev/null
marker=/var/lib/refunddesk/control/edge-window-watchdog.json
receipt=/var/lib/refunddesk/control/edge-window-watchdog-preflight.json
test ! -e "${marker}" && test ! -L "${marker}"
test ! -e "${receipt}" && test ! -L "${receipt}"
test ! -e /var/lib/refunddesk/control/.edge-window-watchdog.json.pending &&
  test ! -L /var/lib/refunddesk/control/.edge-window-watchdog.json.pending
test ! -e /var/lib/refunddesk/control/edge-window-watchdog-triggered
test ! -e /run/refunddesk/edge-window-watchdog-triggered
shopt -s nullglob
identity_transitions=(
  /var/lib/refunddesk/control/edge-window-caddy-identity-transition-*.json
  /var/lib/refunddesk/control/.edge-window-caddy-identity-transition-*.json.*
)
marker_legacy_pendings=(/var/lib/refunddesk/control/.edge-window-install.*)
shopt -u nullglob
(( ${#identity_transitions[@]} == 0 ))
(( ${#marker_legacy_pendings[@]} == 0 ))
test ! -e /etc/systemd/system/refunddesk-edge-window-watchdog.service.d
test ! -e /etc/systemd/system/refunddesk-edge-window-watchdog.timer.d
test "$(systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.timer)" = inactive
test "$(systemctl is-enabled refunddesk-edge-window-watchdog.timer 2>/dev/null)" = disabled
service_state="$(systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.service)"
[[ "${service_state}" == inactive || "${service_state}" == failed ]]
REMOTE_PREFLIGHT
    production_error WATCHDOG_INVALID
    return
  }
  remote_install "${watchdog_source}" /usr/local/libexec/refunddesk-edge-window-watchdog.sh 0755 || {
    production_error WATCHDOG_INVALID
    return
  }
  remote_install "${service_source}" /etc/systemd/system/refunddesk-edge-window-watchdog.service 0644 || {
    production_error WATCHDOG_INVALID
    return
  }
  remote_install "${timer_source}" /etc/systemd/system/refunddesk-edge-window-watchdog.timer 0644 || {
    production_error WATCHDOG_INVALID
    return
  }
  remote_install_create_new "${WATCHDOG_MARKER}" /var/lib/refunddesk/control/edge-window-watchdog.json 0600 || {
    production_error WATCHDOG_INVALID
    return
  }
  ssh_command "sudo bash -seu -- '${watchdog_sha}' '${service_sha}' '${timer_sha}' '${marker_sha}' '${deadline_epoch}' '${EFFECTIVE_WINDOW_SECONDS}'" <<'REMOTE' >/dev/null || {
set +x
exec 2>/dev/null
set -o pipefail
watchdog_sha="$1"; service_sha="$2"; timer_sha="$3"; marker_sha="$4"; deadline="$5"; window="$6"
watchdog=/usr/local/libexec/refunddesk-edge-window-watchdog.sh
service=/etc/systemd/system/refunddesk-edge-window-watchdog.service
timer=/etc/systemd/system/refunddesk-edge-window-watchdog.timer
marker=/var/lib/refunddesk/control/edge-window-watchdog.json
receipt=/var/lib/refunddesk/control/edge-window-watchdog-preflight.json
docker_bin=/usr/bin/docker
docker_socket=/run/docker.sock
docker_host=unix:///run/docker.sock
docker_config=/run/refunddesk/edge-window-watchdog-docker-config
docker_cli_environment_valid() {
  local metadata entry
  test -x "${docker_bin}" && test -f "${docker_bin}" && test ! -L "${docker_bin}"
  test -S "${docker_socket}" && test ! -L "${docker_socket}"
  test -d "${docker_config}" && test ! -L "${docker_config}"
  metadata="$(stat --format='%u:%g:%a:%h' -- "${docker_config}")"
  test "${metadata}" = 0:0:555:2
  entry="$(find "${docker_config}" -mindepth 1 -maxdepth 1 -print -quit)"
  test -z "${entry}"
}
docker_cli_bounded() {
  local duration="$1"
  shift
  docker_cli_environment_valid
  timeout --signal=TERM --kill-after=1s "${duration}" \
    env -i PATH=/usr/bin:/bin HOME=/nonexistent LC_ALL=C \
    DOCKER_HOST="${docker_host}" DOCKER_CONFIG="${docker_config}" \
    "${docker_bin}" --host "${docker_host}" --config "${docker_config}" "$@"
}
install -d -m 0555 -o root -g root -- "${docker_config}"
docker_cli_environment_valid
assert_effective_units() {
  service_name=refunddesk-edge-window-watchdog.service
  timer_name=refunddesk-edge-window-watchdog.timer
  unit_property() {
    timeout --signal=TERM --kill-after=1s 3s systemctl show --property="$1" --value "$2"
  }
  value="$(unit_property FragmentPath "${service_name}")"
  test "${value}" = "${service}"
  value="$(unit_property FragmentPath "${timer_name}")"
  test "${value}" = "${timer}"
  value="$(unit_property DropInPaths "${service_name}")"
  test -z "${value}"
  value="$(unit_property DropInPaths "${timer_name}")"
  test -z "${value}"
  value="$(unit_property User "${service_name}")"
  test "${value}" = root
  value="$(unit_property Group "${service_name}")"
  test "${value}" = root
  value="$(unit_property Type "${service_name}")"
  test "${value}" = oneshot
  value="$(unit_property NoNewPrivileges "${service_name}")"
  test "${value}" = yes
  value="$(unit_property ProtectSystem "${service_name}")"
  test "${value}" = strict
  value="$(unit_property ProtectClock "${service_name}")"
  test "${value}" = yes
  value="$(unit_property Environment "${service_name}")"
  test "${value}" = "PATH=/usr/bin:/bin DOCKER_HOST=unix:///run/docker.sock DOCKER_CONFIG=/run/refunddesk/edge-window-watchdog-docker-config"
  value="$(unit_property UnsetEnvironment "${service_name}")"
  test "${value}" = "DOCKER_CONTEXT DOCKER_CERT_PATH DOCKER_TLS_VERIFY DOCKER_TLS"
  value="$(unit_property ExecSearchPath "${service_name}")"
  test "${value}" = /usr/bin:/bin
  exec_start="$(unit_property ExecStart "${service_name}")"
  [[ "${exec_start}" != *$'\n'* ]]
  [[ "${exec_start}" != *'} ; {'* ]]
  test "$(grep --only-matching --fixed-strings 'path=' <<<"${exec_start}" | wc --lines)" = 1
  test "$(grep --only-matching --fixed-strings 'argv[]=' <<<"${exec_start}" | wc --lines)" = 1
  [[ "${exec_start}" == "{ path=/usr/local/libexec/refunddesk-edge-window-watchdog.sh ; argv[]=/usr/local/libexec/refunddesk-edge-window-watchdog.sh ; ignore_errors=no ;"*" }" ]]
  value="$(unit_property Unit "${timer_name}")"
  test "${value}" = "${service_name}"
  value="$(unit_property OnBootUSec "${timer_name}")"
  test "${value}" = 1s
  value="$(unit_property OnUnitActiveUSec "${timer_name}")"
  test "${value}" = 1s
  value="$(unit_property AccuracyUSec "${timer_name}")"
  test "${value}" = 1ms
  value="$(unit_property RandomizedDelayUSec "${timer_name}")"
  test "${value}" = 0
  value="$(unit_property Persistent "${timer_name}")"
  test "${value}" = no
}
exec 9>/run/refunddesk/edge-window-watchdog.lock
flock --exclusive --timeout 10 9
test ! -e "${receipt}" && test ! -L "${receipt}"
test "$(systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.timer)" = inactive
test "$(systemctl is-enabled refunddesk-edge-window-watchdog.timer 2>/dev/null)" = disabled
watchdog_service_state="$(systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.service)"
[[ "${watchdog_service_state}" == inactive || "${watchdog_service_state}" == failed ]]
test "$(stat --format='%U:%G:%a' "${watchdog}")" = root:root:755
test "$(stat --format='%U:%G:%a' "${service}")" = root:root:644
test "$(stat --format='%U:%G:%a' "${timer}")" = root:root:644
test "$(stat --format='%U:%G:%a:%h' "${marker}")" = root:root:600:1
test "$(sha256sum "${watchdog}" | cut -d ' ' -f 1)" = "${watchdog_sha}"
test "$(sha256sum "${service}" | cut -d ' ' -f 1)" = "${service_sha}"
test "$(sha256sum "${timer}" | cut -d ' ' -f 1)" = "${timer_sha}"
test "$(sha256sum "${marker}" | cut -d ' ' -f 1)" = "${marker_sha}"
jq --exit-status --arg watchdogSha "${watchdog_sha}" --arg serviceSha "${service_sha}" --arg timerSha "${timer_sha}" --argjson deadline "${deadline}" '
  keys == ["armedBoottimeMilliseconds","bootId","caddyContainerId","deadlineBoottimeMilliseconds","deadlineEpoch","expectedRevision","kind","metrics","nonce","schemaVersion","serviceSha256","startDeadlineBoottimeMilliseconds","state","timerSha256","triggered","watchdogSha256","windowSeconds","workerContainerId"]
  and .state == "armed" and .startDeadlineBoottimeMilliseconds == null and .triggered == false and .deadlineEpoch == $deadline
  and .watchdogSha256 == $watchdogSha and .serviceSha256 == $serviceSha and .timerSha256 == $timerSha
  and (.caddyContainerId | type == "string" and test("^[0-9a-f]{64}$"))
  and (.workerContainerId | type == "string" and test("^[0-9a-f]{64}$"))
  and .caddyContainerId != .workerContainerId
' "${marker}" >/dev/null
test "$(docker_cli_bounded 3s info --format '{{.CgroupDriver}}')" = systemd
for service_name in caddy worker; do
  container_id="$(jq --raw-output ".${service_name}ContainerId" "${marker}")"
  observed_ids="$(docker_cli_bounded 3s container ls --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=refunddesk --filter "label=com.docker.compose.service=${service_name}")"
  test "${observed_ids}" = "${container_id}"
  docker_cli_bounded 3s inspect "${container_id}" | jq --exit-status \
    --arg id "${container_id}" --arg service "${service_name}" --arg revision "$(jq --raw-output '.expectedRevision' "${marker}")" '
      length == 1 and .[0].Id == $id
      and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
      and .[0].Config.Labels["com.docker.compose.service"] == $service
      and .[0].Config.Labels["com.refunddesk.revision"] == $revision
      and .[0].HostConfig.RestartPolicy.Name == "no"
      and .[0].State.Running == false
    ' >/dev/null
done
boot_id="$(tr -d '\n' </proc/sys/kernel/random/boot_id)"
[[ "${boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]
boot_ms="$(awk '{printf "%.0f\n", $1 * 1000}' /proc/uptime)"
[[ "${boot_ms}" =~ ^[0-9]+$ ]]
now="$(date --utc '+%s')"
# REFUNDDESK_EDGE_WATCHDOG_REMAINING_DEADLINE_BEGIN
remaining=$((deadline - now))
test "${remaining}" -ge 30
# Installation latency and wall-clock skew may only shorten the original
# effective window.  CLOCK_BOOTTIME is anchored to the same absolute wall
# deadline, never to a fresh full window starting after remote installation.
test "${remaining}" -le "${window}"
deadline_boot_ms=$((boot_ms + remaining * 1000))
# REFUNDDESK_EDGE_WATCHDOG_REMAINING_DEADLINE_END
candidate="$(mktemp /var/lib/refunddesk/control/.edge-window-watchdog.XXXXXXXXXX)"
jq --compact-output --sort-keys --arg bootId "${boot_id}" --argjson armed "${boot_ms}" --argjson bootDeadline "${deadline_boot_ms}" --argjson window "${remaining}" '
  .bootId = $bootId | .armedBoottimeMilliseconds = $armed
  | .deadlineBoottimeMilliseconds = $bootDeadline | .windowSeconds = $window
' "${marker}" >"${candidate}"
chmod 0600 "${candidate}"
chown root:root "${candidate}"
sync "${candidate}"
mv -f "${candidate}" "${marker}"
sync /var/lib/refunddesk/control
systemctl daemon-reload
assert_effective_units
systemctl enable --now refunddesk-edge-window-watchdog.timer
# Release the watchdog lock before starting the oneshot. A tick that collides
# with this lock exits without executing, so holding it here would make the
# apparent synchronous preflight a false success.
flock --unlock 9
exec 9>&-
# Execute one synchronous deadline tick. The exact unit must create a
# nonce/revision/marker/boot-bound receipt before ingress; Result=success alone
# is never accepted as proof that the script acquired its lock.
systemctl start refunddesk-edge-window-watchdog.service
test "$(systemctl show --property=Result --value refunddesk-edge-window-watchdog.service)" = success
test "$(systemctl show --property=ExecMainStatus --value refunddesk-edge-window-watchdog.service)" = 0
exec 9>/run/refunddesk/edge-window-watchdog.lock
flock --exclusive --timeout 10 9
assert_effective_units
test "$(systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.timer)" = active
test "$(systemctl is-enabled refunddesk-edge-window-watchdog.timer)" = enabled
test "$(sha256sum "${watchdog}" | cut -d ' ' -f 1)" = "${watchdog_sha}"
test "$(sha256sum "${service}" | cut -d ' ' -f 1)" = "${service_sha}"
test "$(sha256sum "${timer}" | cut -d ' ' -f 1)" = "${timer_sha}"
jq --exit-status '.state == "armed"' "${marker}" >/dev/null
test -f "${receipt}" && test ! -L "${receipt}"
test "$(stat --format='%U:%G:%a:%h' "${receipt}")" = root:root:600:1
marker_sha_observed="$(sha256sum "${marker}" | cut -d ' ' -f 1)"
boot_sha_observed="$(jq --raw-output '.bootId' "${marker}" | tr -d '\n' | sha256sum | cut -d ' ' -f 1)"
jq --exit-status --arg nonce "$(jq --raw-output '.nonce' "${marker}")" \
  --arg revision "$(jq --raw-output '.expectedRevision' "${marker}")" \
  --arg caddyContainerId "$(jq --raw-output '.caddyContainerId' "${marker}")" \
  --arg workerContainerId "$(jq --raw-output '.workerContainerId' "${marker}")" \
  --arg markerSha "${marker_sha_observed}" --arg bootSha "${boot_sha_observed}" \
  --argjson armed "$(jq --raw-output '.armedBoottimeMilliseconds' "${marker}")" \
  --argjson deadlineBoot "$(jq --raw-output '.deadlineBoottimeMilliseconds' "${marker}")" \
  --argjson deadlineEpoch "$(jq --raw-output '.deadlineEpoch' "${marker}")" '
    type == "object"
    and keys == ["bootIdSha256","caddyContainerId","expectedRevision","kind","markerSha256","nonce","observedAtEpoch","observedBoottimeMilliseconds","schemaVersion","workerContainerId"]
    and .schemaVersion == 1 and .kind == "refunddesk.edge-window-watchdog-preflight"
    and .nonce == $nonce and .expectedRevision == $revision
    and .markerSha256 == $markerSha and .bootIdSha256 == $bootSha
    and .caddyContainerId == $caddyContainerId and .workerContainerId == $workerContainerId
    and (.observedAtEpoch | type == "number" and floor == . and . < $deadlineEpoch)
    and (.observedBoottimeMilliseconds | type == "number" and floor == . and . >= $armed and . < $deadlineBoot)
  ' "${receipt}" >/dev/null
REMOTE
    production_error WATCHDOG_INVALID
    return
  }
  local clock
  clock="$(ssh_command "sudo bash -seu" <<'REMOTE_CLOCK'
set +x
exec 2>/dev/null
marker=/var/lib/refunddesk/control/edge-window-watchdog.json
boot="$(jq --raw-output '.bootId' "${marker}")"
boot_sha="$(printf '%s' "${boot}" | sha256sum | cut -d ' ' -f 1)"
jq --compact-output --sort-keys --arg bootSha "${boot_sha}" \
  '{armedBoottimeMilliseconds:.armedBoottimeMilliseconds,bootIdSha256:$bootSha,deadlineBoottimeMilliseconds:.deadlineBoottimeMilliseconds}' \
  "${marker}"
REMOTE_CLOCK
)" || {
    production_error WATCHDOG_INVALID
    return
  }
  jq --exit-status 'keys == ["armedBoottimeMilliseconds","bootIdSha256","deadlineBoottimeMilliseconds"]
    and (.armedBoottimeMilliseconds | type == "number" and floor == . and . >= 0)
    and (.deadlineBoottimeMilliseconds | type == "number" and floor == . and . > 0)
    and (.bootIdSha256 | type == "string" and test("^[0-9a-f]{64}$"))' <<<"${clock}" >/dev/null || {
    production_error WATCHDOG_INVALID
    return
  }
  jq --null-input --compact-output --sort-keys --argjson clock "${clock}" \
    '{mutations:{watchdogArms:1},watchdog:{activeBeforeIngress:true,armedBeforeIngress:true} + $clock}'
}

production_window_clock_stop() {
  local expected_boot armed_ms deadline_ms observation maximum_ms
  expected_boot="$(jq --raw-output '.watchdog.bootIdSha256' "${FACTS_FILE}")" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  armed_ms="$(jq --raw-output '.watchdog.armedBoottimeMilliseconds' "${FACTS_FILE}")" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  deadline_ms="$(jq --raw-output '.watchdog.deadlineBoottimeMilliseconds' "${FACTS_FILE}")" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  [[ "${expected_boot}" =~ ^[0-9a-f]{64}$ && "${armed_ms}" =~ ^[0-9]+$ && "${deadline_ms}" =~ ^[0-9]+$ ]] || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  maximum_ms=$((deadline_ms - armed_ms))
  (( maximum_ms >= 30000 && maximum_ms <= EFFECTIVE_WINDOW_SECONDS * 1000 )) || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  observation="$(ssh_command "sudo bash -seu" <<'REMOTE_CLOCK'
set +x
exec 2>/dev/null
IFS= read -r boot </proc/sys/kernel/random/boot_id
boot_sha="$(printf '%s' "${boot}" | sha256sum | cut -d ' ' -f 1)"
now_ms="$(awk '{printf "%.0f\n", $1 * 1000}' /proc/uptime)"
jq --null-input --compact-output --sort-keys --arg bootSha "${boot_sha}" --argjson now "${now_ms}" \
  '{bootIdSha256:$bootSha,closedBoottimeMilliseconds:$now}'
REMOTE_CLOCK
)" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  jq --exit-status --arg boot "${expected_boot}" --argjson armed "${armed_ms}" --argjson maximum "${maximum_ms}" '
    keys == ["bootIdSha256","closedBoottimeMilliseconds"]
    and .bootIdSha256 == $boot
    and (.closedBoottimeMilliseconds | type == "number" and floor == . and . >= $armed)
    and (.closedBoottimeMilliseconds - $armed <= $maximum)
  ' <<<"${observation}" >/dev/null || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  jq --null-input --compact-output --sort-keys --argjson observation "${observation}" --argjson armed "${armed_ms}" '
    {watchdog:{closedBoottimeMilliseconds:$observation.closedBoottimeMilliseconds,
      monotonicBounded:true,monotonicDurationMilliseconds:($observation.closedBoottimeMilliseconds - $armed)}}'
}

window_remaining_seconds() {
  local now now_epoch deadline_epoch wall_remaining monotonic_remaining
  [[ "${WINDOW_MONOTONIC_STARTED_SECONDS}" =~ ^[0-9]+$ ]] || return 1
  now="$(timestamp_now)" || return 1
  now_epoch="$(timestamp_epoch "${now}")" || return 1
  deadline_epoch="$(timestamp_epoch "${DEADLINE_AT}")" || return 1
  wall_remaining=$((deadline_epoch - now_epoch))
  monotonic_remaining=$((EFFECTIVE_WINDOW_SECONDS - (SECONDS - WINDOW_MONOTONIC_STARTED_SECONDS)))
  (( wall_remaining < monotonic_remaining )) && printf '%s\n' "${wall_remaining}" || printf '%s\n' "${monotonic_remaining}"
}

production_window_clock_open_guard() {
  local expected_boot deadline_ms observation now now_epoch deadline_epoch remaining
  expected_boot="$(jq --raw-output '.watchdog.bootIdSha256' "${FACTS_FILE}")" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  deadline_ms="$(jq --raw-output '.watchdog.deadlineBoottimeMilliseconds' "${FACTS_FILE}")" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  [[ "${expected_boot}" =~ ^[0-9a-f]{64}$ && "${deadline_ms}" =~ ^[0-9]+$ ]] || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  observation="$(ssh_command "sudo bash -seu -- '${NONCE}' '${EXPECTED_REVISION}'" <<'REMOTE_CLOCK'
set +x
exec 2>/dev/null
nonce="$1"
revision="$2"
marker=/var/lib/refunddesk/control/edge-window-watchdog.json
receipt=/var/lib/refunddesk/control/edge-window-watchdog-preflight.json
receipt_before="$(jq --raw-output '.observedBoottimeMilliseconds' "${receipt}")"
[[ "${receipt_before}" =~ ^[0-9]+$ ]]
timeout --signal=TERM --kill-after=1s 15s systemctl start refunddesk-edge-window-watchdog.service
test "$(systemctl show --property=Result --value refunddesk-edge-window-watchdog.service)" = success
test "$(systemctl show --property=ExecMainStatus --value refunddesk-edge-window-watchdog.service)" = 0
receipt_after="$(jq --raw-output '.observedBoottimeMilliseconds' "${receipt}")"
[[ "${receipt_after}" =~ ^[0-9]+$ && "${receipt_after}" -ge "${receipt_before}" ]]
exec 9>/run/refunddesk/edge-window-watchdog.lock
flock --exclusive --timeout 5 9
test ! -e /var/lib/refunddesk/control/edge-window-watchdog-triggered
test ! -e /run/refunddesk/edge-window-watchdog-triggered
test -f "${marker}" && test ! -L "${marker}"
test "$(stat --format='%U:%G:%a:%h' "${marker}")" = root:root:600:1
test -f "${receipt}" && test ! -L "${receipt}"
test "$(stat --format='%U:%G:%a:%h' "${receipt}")" = root:root:600:1
marker_sha="$(sha256sum "${marker}" | cut -d ' ' -f 1)"
boot_id="$(jq --raw-output '.bootId' "${marker}")"
boot_sha="$(printf '%s' "${boot_id}" | sha256sum | cut -d ' ' -f 1)"
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '
  type == "object" and .state == "armed_running" and .startDeadlineBoottimeMilliseconds == null
  and .triggered == false and .nonce == $nonce and .expectedRevision == $revision
  and (.caddyContainerId | type == "string" and test("^[0-9a-f]{64}$"))
  and (.workerContainerId | type == "string" and test("^[0-9a-f]{64}$"))
  and .caddyContainerId != .workerContainerId
' "${marker}" >/dev/null
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" \
  --arg markerSha "${marker_sha}" --arg bootSha "${boot_sha}" \
  --arg caddyContainerId "$(jq --raw-output '.caddyContainerId' "${marker}")" \
  --arg workerContainerId "$(jq --raw-output '.workerContainerId' "${marker}")" '
    type == "object" and .kind == "refunddesk.edge-window-watchdog-preflight"
    and .schemaVersion == 1 and .nonce == $nonce and .expectedRevision == $revision
    and .markerSha256 == $markerSha and .bootIdSha256 == $bootSha
    and .caddyContainerId == $caddyContainerId and .workerContainerId == $workerContainerId
  ' "${receipt}" >/dev/null
IFS= read -r boot </proc/sys/kernel/random/boot_id
boot_sha="$(printf '%s' "${boot}" | sha256sum | cut -d ' ' -f 1)"
now_ms="$(awk '{printf "%.0f\n", $1 * 1000}' /proc/uptime)"
jq --null-input --compact-output --sort-keys --arg bootSha "${boot_sha}" --argjson now "${now_ms}" \
  '{bootIdSha256:$bootSha,openGuardBoottimeMilliseconds:$now}'
REMOTE_CLOCK
)" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  jq --exit-status --arg boot "${expected_boot}" --argjson deadline "${deadline_ms}" '
    keys == ["bootIdSha256","openGuardBoottimeMilliseconds"]
    and .bootIdSha256 == $boot
    and (.openGuardBoottimeMilliseconds | type == "number" and floor == . and . >= 0 and . < $deadline)
  ' <<<"${observation}" >/dev/null || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  now="$(timestamp_now)" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  now_epoch="$(timestamp_epoch "${now}")" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  deadline_epoch="$(timestamp_epoch "${DEADLINE_AT}")" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  remaining="$(window_remaining_seconds)" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  (( now_epoch < deadline_epoch && remaining >= FIREWALL_OPEN_MUTATION_SECONDS + FIREWALL_OPEN_READBACK_SECONDS + FIREWALL_CLOSE_RESERVE_SECONDS )) || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  printf '%s\n' '{}'
}

production_host_lease_acquire() {
  local unit="refunddesk-edge-lease-${NONCE}.service"
  local authorization_sha
  authorization_sha="$(jq --raw-output '.admission.authorizationEvidenceSha256' "${CONTROL_FILE}")" || {
    production_error CONTROL_UNAVAILABLE
    return
  }
  [[ "${authorization_sha}" =~ ^[0-9a-f]{64}$ ]] || {
    production_error CONTROL_UNAVAILABLE
    return
  }
  ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${NONCE}' '${unit}' '${authorization_sha}'" <<'REMOTE' >/dev/null || {
set +x
exec 2>/dev/null
revision="$1"
nonce="$2"
unit="$3"
authorization_sha="$4"
marker=/var/lib/refunddesk/control/edge-window-lease.json
authorization_root=/var/lib/refunddesk/control/edge-window-authorizations
authorization_marker="${authorization_root}/${authorization_sha}.json"
signal="/run/refunddesk/edge-window-lease-release-${nonce}"
[[ "${revision}" =~ ^[0-9a-f]{40}$ && "${nonce}" =~ ^[0-9a-f]{64}$ && "${authorization_sha}" =~ ^[0-9a-f]{64}$ ]]
[[ "${unit}" == "refunddesk-edge-lease-${nonce}.service" ]]
install -d -m 0700 -o root -g root "${authorization_root}"
test "$(stat --format='%U:%G:%a' "${authorization_root}")" = root:root:700
test ! -e "${signal}" && test ! -L "${signal}"
cleanup_failed_holder() {
  timeout --signal=TERM --kill-after=1s 5s systemctl stop "${unit}" >/dev/null 2>&1 || timeout --signal=TERM --kill-after=1s 2s systemctl kill --kill-who=all --signal=KILL "${unit}" >/dev/null 2>&1 || true
  systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
  rm -f -- "${signal}"
}
trap cleanup_failed_holder ERR
holder='set -Eeuo pipefail
set +x
umask 077
marker="$1"; authorization_marker="$2"; signal="$3"; nonce="$4"; revision="$5"; authorization_sha="$6"
exec 8>/run/refunddesk/edge-window-holder.lock
flock --exclusive --nonblock 8 || exit 76
exec 9>/run/refunddesk/operator.lock
flock --shared --nonblock 9 || exit 75
python3 - "${marker}" "${authorization_marker}" "${nonce}" "${revision}" "${authorization_sha}" <<'"'"'PY'"'"'
# REFUNDDESK_EDGE_HOST_LEASE_MARKER_PUBLISH_PY_BEGIN
import ctypes, errno, json, os, stat, sys
path, authorization_path, nonce, revision, authorization_sha = sys.argv[1:]
expected_uid=os.geteuid()
def pairs(items):
    out={}
    for key,value in items:
        if key in out: raise ValueError("duplicate")
        out[key]=value
    return out
def canonical(document):
    return (json.dumps(document,separators=(",",":"),sort_keys=True)+"\n").encode()
held={"expectedRevision":revision,"kind":"refunddesk.edge-window-host-lease","nonce":nonce,"schemaVersion":1,"state":"held"}
authorization_held={"authorizationSha256":authorization_sha,"expectedRevision":revision,"kind":"refunddesk.edge-window-authorization-consumption","nonce":nonce,"schemaVersion":1,"state":"held"}

def fsync_directory(directory):
    descriptor=os.open(directory,os.O_RDONLY|getattr(os,"O_CLOEXEC",0))
    try: os.fsync(descriptor)
    finally: os.close(descriptor)

def read_controlled(marker_path):
    info=os.lstat(marker_path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size>4096: raise SystemExit(1)
    with open(marker_path,"rb") as stream: raw=stream.read(4097)
    if len(raw)>4096: raise SystemExit(1)
    try: document=json.loads(raw.decode("utf-8"),object_pairs_hook=pairs)
    except Exception: raise SystemExit(1)
    if raw != canonical(document): raise SystemExit(1)
    return document

def rename_noreplace(source,destination):
    libc=ctypes.CDLL(None,use_errno=True)
    function=getattr(libc,"renameat2",None)
    if function is None: raise SystemExit(1)
    function.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    function.restype=ctypes.c_int
    if function(-100,os.fsencode(source),-100,os.fsencode(destination),1)!=0:
        error=ctypes.get_errno()
        if error in {errno.EEXIST,errno.ENOSYS,errno.EINVAL}: raise SystemExit(1)
        raise OSError(error,os.strerror(error))

def publish_or_recover(marker_path, expected):
    directory=os.path.dirname(marker_path)
    pending=marker_path+".pending"
    if os.path.lexists(marker_path):
        existing=read_controlled(marker_path)
        if existing != expected: raise SystemExit(1)
        if os.path.lexists(pending):
            # The destination is already the exact authority. A crash-partial
            # deterministic pending is derived and may be removed only after
            # its inode contract is checked.
            pending_info=os.lstat(pending)
            if not stat.S_ISREG(pending_info.st_mode) or pending_info.st_uid!=expected_uid or stat.S_IMODE(pending_info.st_mode)!=0o600 or pending_info.st_nlink!=1 or pending_info.st_size>4096: raise SystemExit(1)
            try: pending_document=read_controlled(pending)
            except SystemExit: pending_document=None
            if pending_document is not None and pending_document != expected: raise SystemExit(1)
            os.unlink(pending); fsync_directory(directory)
        return
    if os.path.lexists(pending):
        pending_info=os.lstat(pending)
        if not stat.S_ISREG(pending_info.st_mode) or pending_info.st_uid!=expected_uid or stat.S_IMODE(pending_info.st_mode)!=0o600 or pending_info.st_nlink!=1 or pending_info.st_size>4096: raise SystemExit(1)
        try: pending_document=read_controlled(pending)
        except SystemExit:
            os.unlink(pending); fsync_directory(directory)
        else:
            if pending_document == expected:
                fsync_directory(directory); rename_noreplace(pending,marker_path); fsync_directory(directory)
                if read_controlled(marker_path) != expected: raise SystemExit(1)
                return
            # A complete canonical pending is an authority owned by the
            # operation that created it.  Never erase another nonce/revision
            # merely because it has not reached the public marker pathname.
            raise SystemExit(1)
    raw=canonical(expected)
    descriptor=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0),0o600)
    try:
        offset=0
        while offset<len(raw):
            written=os.write(descriptor,raw[offset:])
            if written <= 0: raise OSError("short write")
            offset+=written
        os.fchmod(descriptor,0o600); os.fsync(descriptor)
    finally: os.close(descriptor)
    fsync_directory(directory); rename_noreplace(pending,marker_path); fsync_directory(directory)
    if read_controlled(marker_path) != expected: raise SystemExit(1)

publish_or_recover(authorization_path,authorization_held)
publish_or_recover(path,held)
# REFUNDDESK_EDGE_HOST_LEASE_MARKER_PUBLISH_PY_END
PY
while test ! -e "${signal}"; do
  sleep 1
done
test -f "${signal}" && test ! -L "${signal}"
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '"'"'
  keys == ["completedAt","expectedRevision","kind","nonce","schemaVersion","state"]
  and .schemaVersion == 1 and .kind == "refunddesk.edge-window-host-lease"
  and .state == "complete" and .nonce == $nonce and .expectedRevision == $revision
'"'"' "${marker}" >/dev/null
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" --arg authorizationSha "${authorization_sha}" '"'"'
  keys == ["authorizationSha256","completedAt","expectedRevision","kind","nonce","schemaVersion","state"]
  and .schemaVersion == 1 and .kind == "refunddesk.edge-window-authorization-consumption"
  and .state == "complete" and .nonce == $nonce and .expectedRevision == $revision
  and .authorizationSha256 == $authorizationSha
'"'"' "${authorization_marker}" >/dev/null
rm -f -- "${signal}"
sync /run/refunddesk
'
timeout --signal=TERM --kill-after=1s 5s systemctl stop "${unit}" >/dev/null 2>&1 || timeout --signal=TERM --kill-after=1s 2s systemctl kill --kill-who=all --signal=KILL "${unit}" >/dev/null 2>&1 || true
systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
test "$(systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)" != active
systemd-run --quiet --unit="${unit}" --property=Type=exec --property=Restart=no \
  --property=KillMode=control-group --property=TimeoutStopSec=30s \
  /bin/bash -ceu "${holder}" edge-lease "${marker}" "${authorization_marker}" "${signal}" "${nonce}" "${revision}" "${authorization_sha}"
for _ in $(seq 1 100); do
  state="$(timeout --signal=TERM --kill-after=1s 5s systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)"
  [[ "${state}" == active ]] && break
  [[ "${state}" == failed || "${state}" == inactive ]] && exit 1
  sleep 0.1
done
test "$(systemctl show --property=ActiveState --value "${unit}")" = active
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '
  keys == ["expectedRevision","kind","nonce","schemaVersion","state"]
  and .schemaVersion == 1 and .kind == "refunddesk.edge-window-host-lease"
  and .state == "held" and .nonce == $nonce and .expectedRevision == $revision
' "${marker}" >/dev/null
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" --arg authorizationSha "${authorization_sha}" '
  keys == ["authorizationSha256","expectedRevision","kind","nonce","schemaVersion","state"]
  and .schemaVersion == 1 and .kind == "refunddesk.edge-window-authorization-consumption"
  and .state == "held" and .nonce == $nonce and .expectedRevision == $revision
  and .authorizationSha256 == $authorizationSha
' "${authorization_marker}" >/dev/null
if flock --exclusive --nonblock /run/refunddesk/operator.lock true; then exit 1; fi
trap - ERR
REMOTE
    production_error TOOL_UNAVAILABLE
    return
  }
  printf '%s\n' '{"hostLease":{"authorizationMarkerState":"held","held":true,"holderActive":true,"hostLeaseMarkerState":"held"}}'
}

production_host_lease_status() {
  local unit="refunddesk-edge-lease-${NONCE}.service"
  local authorization_sha
  authorization_sha="$(jq --raw-output '.admission.authorizationEvidenceSha256' "${CONTROL_FILE}")" || {
    production_error LOCK_UNAVAILABLE
    return
  }
  ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${NONCE}' '${unit}' '${authorization_sha}'" <<'REMOTE' || {
set +x
exec 2>/dev/null
revision="$1"; nonce="$2"; unit="$3"; authorization_sha="$4"
marker=/var/lib/refunddesk/control/edge-window-lease.json
authorization_marker="/var/lib/refunddesk/control/edge-window-authorizations/${authorization_sha}.json"
test "$(systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)" = active
main_pid="$(systemctl show --property=MainPID --value "${unit}")"
[[ "${main_pid}" =~ ^[1-9][0-9]*$ ]]
jq --compact-output --sort-keys --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '
  select(type == "object" and keys == ["expectedRevision","kind","nonce","schemaVersion","state"]
    and .schemaVersion == 1 and .kind == "refunddesk.edge-window-host-lease"
    and .state == "held" and .nonce == $nonce and .expectedRevision == $revision)
  | {hostLease:{authorizationMarkerState:"held",held:true,holderActive:true,hostLeaseMarkerState:"held"}}
' "${marker}"
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" --arg authorizationSha "${authorization_sha}" '
  type == "object" and keys == ["authorizationSha256","expectedRevision","kind","nonce","schemaVersion","state"]
  and .schemaVersion == 1 and .kind == "refunddesk.edge-window-authorization-consumption"
  and .state == "held" and .nonce == $nonce and .expectedRevision == $revision
  and .authorizationSha256 == $authorizationSha
' "${authorization_marker}" >/dev/null
if flock --exclusive --nonblock /run/refunddesk/edge-window-holder.lock true; then exit 1; fi
if flock --exclusive --nonblock /run/refunddesk/operator.lock true; then exit 1; fi
REMOTE
    production_error LOCK_UNAVAILABLE
    return
  }
}

window_boot_argument() {
  local armed expected_boot
  armed="$(jq --raw-output '(.intents.watchdogArmAttempted == true or .mutations.watchdogArms > 0)' "${FACTS_FILE}")" || return 1
  expected_boot="$(jq --raw-output '.watchdog.bootIdSha256 // empty' "${FACTS_FILE}")" || return 1
  if [[ "${armed}" == true ]]; then
    [[ "${expected_boot}" =~ ^[0-9a-f]{64}$ ]] || return 1
    printf '%s\n' "${expected_boot}"
  elif [[ "${armed}" == false && -z "${expected_boot}" ]]; then
    printf '%s\n' none
  else
    return 1
  fi
}

production_window_boot_guard() {
  local expected_boot current_boot
  expected_boot="$(window_boot_argument)" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  [[ "${expected_boot}" != none ]] || {
    printf '%s\n' '{}'
    return
  }
  current_boot="$(ssh_command "sudo bash -seu" <<'REMOTE_BOOT'
set +x
exec 2>/dev/null
tr -d '\n' </proc/sys/kernel/random/boot_id | sha256sum | cut -d ' ' -f 1
REMOTE_BOOT
)" || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  [[ "${current_boot}" == "${expected_boot}" ]] || {
    production_error WINDOW_MONOTONIC_INVALID
    return
  }
  printf '%s\n' '{}'
}

production_host_lease_complete() {
  local enforce_boot="${1:-true}" require_completion_started="${2:-false}"
  local authorization_sha expected_boot completion_not_before completion_not_after
  local -a completion_bounds
  [[ "${enforce_boot}" == true || "${enforce_boot}" == false ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  [[ "${require_completion_started}" == true || "${require_completion_started}" == false ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  authorization_sha="$(jq --raw-output '.admission.authorizationEvidenceSha256' "${CONTROL_FILE}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  if [[ "${enforce_boot}" == true ]]; then
    expected_boot="$(window_boot_argument)" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    mapfile -t completion_bounds < <(pass_completion_bounds)
    (( ${#completion_bounds[@]} == 2 )) || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    completion_not_before="${completion_bounds[0]}"
    completion_not_after="${completion_bounds[1]}"
  else
    expected_boot=none
    completion_not_before="2000-01-01T00:00:00Z"
    completion_not_after="9999-12-31T23:59:59Z"
  fi
  ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${NONCE}' '${authorization_sha}' '${expected_boot}' '${require_completion_started}' '${completion_not_before}' '${completion_not_after}'" <<'REMOTE' >/dev/null || {
set +x
exec 2>/dev/null
revision="$1"
nonce="$2"
authorization_sha="$3"
expected_boot="$4"
require_completion_started="$5"
completion_not_before="$6"
completion_not_after="$7"
marker=/var/lib/refunddesk/control/edge-window-lease.json
authorization_marker="/var/lib/refunddesk/control/edge-window-authorizations/${authorization_sha}.json"
[[ "${require_completion_started}" == true || "${require_completion_started}" == false ]]
if test "${expected_boot}" != none; then
  current_boot_sha="$(tr -d '\n' </proc/sys/kernel/random/boot_id | sha256sum | cut -d ' ' -f 1)"
  test "${current_boot_sha}" = "${expected_boot}"
fi
test -f "${marker}" && test ! -L "${marker}"
lease_complete=false
if jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '
  keys == ["completedAt","expectedRevision","kind","nonce","schemaVersion","state"]
  and .schemaVersion == 1 and .kind == "refunddesk.edge-window-host-lease" and .state == "complete"
  and .nonce == $nonce and .expectedRevision == $revision
' "${marker}" >/dev/null; then
  lease_complete=true
fi
if test "${require_completion_started}" = true; then
  test "${lease_complete}" = true
fi
if test "${lease_complete}" = true; then
  python3 - "${marker}" "${nonce}" "${revision}" "${completion_not_before}" "${completion_not_after}" <<'PY'
import datetime, json, pathlib, sys
path, nonce, revision, not_before, not_after = sys.argv[1:]
def instant(value): return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
document=json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
expected={"completedAt":document.get("completedAt"),"expectedRevision":revision,"kind":"refunddesk.edge-window-host-lease","nonce":nonce,"schemaVersion":1,"state":"complete"}
if document != expected or not (instant(not_before) <= instant(document["completedAt"]) <= instant(not_after)): raise SystemExit(1)
PY
else
python3 - "${marker}" "${nonce}" "${revision}" "${completion_not_before}" "${completion_not_after}" <<'PY'
import datetime, json, os, sys, tempfile
path, nonce, revision, not_before, not_after = sys.argv[1:]
def instant(value): return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
with open(path, encoding="utf-8") as stream: previous=json.load(stream)
if previous != {"expectedRevision":revision,"kind":"refunddesk.edge-window-host-lease","nonce":nonce,"schemaVersion":1,"state":"held"}: raise SystemExit(1)
completed=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
if not (instant(not_before) <= completed <= instant(not_after)): raise SystemExit(1)
document={"completedAt":completed.strftime("%Y-%m-%dT%H:%M:%SZ"),"expectedRevision":revision,"kind":"refunddesk.edge-window-host-lease","nonce":nonce,"schemaVersion":1,"state":"complete"}
directory=os.path.dirname(path); fd,tmp=tempfile.mkstemp(prefix=".edge-window-lease.",dir=directory)
try:
 os.fchmod(fd,0o600); data=(json.dumps(document,separators=(",",":"),sort_keys=True)+"\n").encode(); offset=0
 while offset < len(data):
  written=os.write(fd,data[offset:])
  if written <= 0: raise OSError("short write")
  offset+=written
 os.fsync(fd); os.close(fd); fd=-1; os.replace(tmp,path); d=os.open(directory,os.O_RDONLY); os.fsync(d); os.close(d)
finally:
 if fd >= 0: os.close(fd)
 if os.path.exists(tmp): os.unlink(tmp)
PY
fi
python3 - "${authorization_marker}" "${nonce}" "${revision}" "${authorization_sha}" "${completion_not_before}" "${completion_not_after}" <<'PY'
import datetime, json, os, stat, sys, tempfile
path, nonce, revision, authorization_sha, not_before, not_after = sys.argv[1:]
def instant(value): return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
raw=open(path,"rb").read()
document=json.loads(raw.decode("utf-8"))
held={"authorizationSha256":authorization_sha,"expectedRevision":revision,"kind":"refunddesk.edge-window-authorization-consumption","nonce":nonce,"schemaVersion":1,"state":"held"}
if set(document) == {"authorizationSha256","completedAt","expectedRevision","kind","nonce","schemaVersion","state"} and document.get("state") == "complete":
    if document.get("authorizationSha256") != authorization_sha or document.get("expectedRevision") != revision or document.get("nonce") != nonce: raise SystemExit(1)
    if not (instant(not_before) <= instant(document["completedAt"]) <= instant(not_after)): raise SystemExit(1)
    raise SystemExit(0)
if document != held: raise SystemExit(1)
completed=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
if not (instant(not_before) <= completed <= instant(not_after)): raise SystemExit(1)
complete={**held,"completedAt":completed.strftime("%Y-%m-%dT%H:%M:%SZ"),"state":"complete"}
directory=os.path.dirname(path); fd,tmp=tempfile.mkstemp(prefix=".edge-window-authorization.",dir=directory)
try:
 os.fchmod(fd,0o600); data=(json.dumps(complete,separators=(",",":"),sort_keys=True)+"\n").encode(); offset=0
 while offset < len(data):
  written=os.write(fd,data[offset:])
  if written <= 0: raise OSError("short write")
  offset+=written
 os.fsync(fd); os.close(fd); fd=-1; os.replace(tmp,path); d=os.open(directory,os.O_RDONLY); os.fsync(d); os.close(d)
finally:
 if fd >= 0: os.close(fd)
 if os.path.exists(tmp): os.unlink(tmp)
PY
REMOTE
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  printf '%s\n' '{"hostLease":{"authorizationMarkerState":"complete","held":true,"holderActive":true,"hostLeaseMarkerState":"complete"}}'
}

production_host_lease_release() {
  local enforce_boot="${1:-true}" authorization_sha expected_boot
  [[ "${enforce_boot}" == true || "${enforce_boot}" == false ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  authorization_sha="$(jq --raw-output '.admission.authorizationEvidenceSha256' "${CONTROL_FILE}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  if [[ "${enforce_boot}" == true ]]; then
    expected_boot="$(window_boot_argument)" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
  else
    expected_boot=none
  fi
  ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${NONCE}' '${authorization_sha}' '${expected_boot}'" <<'REMOTE' >/dev/null || {
set +x
exec 2>/dev/null
revision="$1"
nonce="$2"
authorization_sha="$3"
expected_boot="$4"
unit="refunddesk-edge-lease-${nonce}.service"
marker=/var/lib/refunddesk/control/edge-window-lease.json
authorization_marker="/var/lib/refunddesk/control/edge-window-authorizations/${authorization_sha}.json"
signal="/run/refunddesk/edge-window-lease-release-${nonce}"
if test "${expected_boot}" != none; then
  current_boot_sha="$(tr -d '\n' </proc/sys/kernel/random/boot_id | sha256sum | cut -d ' ' -f 1)"
  test "${current_boot_sha}" = "${expected_boot}"
fi
test -f "${marker}" && test ! -L "${marker}"
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '
  keys == ["completedAt","expectedRevision","kind","nonce","schemaVersion","state"]
  and .schemaVersion == 1 and .kind == "refunddesk.edge-window-host-lease"
  and .state == "complete" and .nonce == $nonce and .expectedRevision == $revision
' "${marker}" >/dev/null
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" --arg authorizationSha "${authorization_sha}" '
  keys == ["authorizationSha256","completedAt","expectedRevision","kind","nonce","schemaVersion","state"]
  and .schemaVersion == 1 and .kind == "refunddesk.edge-window-authorization-consumption"
  and .state == "complete" and .nonce == $nonce and .expectedRevision == $revision
  and .authorizationSha256 == $authorizationSha
' "${authorization_marker}" >/dev/null
state="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value "${unit}")"
[[ "${state}" == active || "${state}" == activating || "${state}" == deactivating || "${state}" == inactive || "${state}" == failed ]]
if [[ "${state}" == active || "${state}" == activating || "${state}" == deactivating ]]; then
  python3 - "${signal}" <<'PY'
import os, stat, sys
path=sys.argv[1]
if os.path.lexists(path):
    info=os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600: raise SystemExit(1)
else:
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
    os.fsync(fd); os.close(fd)
d=os.open(os.path.dirname(path),os.O_RDONLY); os.fsync(d); os.close(d)
PY
  for _ in $(seq 1 300); do
    state="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value "${unit}")"
    [[ "${state}" == inactive || "${state}" == failed ]] && break
    sleep 0.1
  done
fi
state="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value "${unit}")"
[[ "${state}" == inactive || "${state}" == failed ]]
exec 8>/run/refunddesk/edge-window-holder.lock
flock --exclusive --timeout 5 8
exec 9>/run/refunddesk/operator.lock
flock --exclusive --timeout 5 9
systemctl reset-failed "${unit}" 2>/dev/null || true
jq --exit-status '.state == "complete"' "${marker}" >/dev/null
REMOTE
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  printf '%s\n' '{"hostLease":{"authorizationMarkerState":"complete","held":true,"holderActive":false,"hostLeaseMarkerState":"complete"}}'
}

production_host_lease_finalization_status() {
  local enforce_evidence_time="${1:-true}"
  local enforce_boot="${2:-true}"
  local authorization_sha evidence_completed_at expected_boot completion_not_after
  local -a completion_bounds
  [[ "${enforce_evidence_time}" == true || "${enforce_evidence_time}" == false ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  [[ "${enforce_boot}" == true || "${enforce_boot}" == false ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  authorization_sha="$(jq --raw-output '.admission.authorizationEvidenceSha256' "${CONTROL_FILE}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  if [[ "${enforce_evidence_time}" == true ]]; then
    [[ "${EVIDENCE_AUTHORITY_SHA}" =~ ^[0-9a-f]{64}$ && -n "${EVIDENCE_AUTHORITY_BYTES}" ]] || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    evidence_completed_at="$(jq --raw-output '.completedAt' <<<"${EVIDENCE_AUTHORITY_BYTES}")" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    mapfile -t completion_bounds < <(pass_completion_bounds)
    (( ${#completion_bounds[@]} == 2 )) || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    completion_not_after="${completion_bounds[1]}"
  else
    evidence_completed_at="2000-01-01T00:00:00Z"
    completion_not_after="9999-12-31T23:59:59Z"
  fi
  if [[ "${enforce_boot}" == true ]]; then
    expected_boot="$(window_boot_argument)" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
  else
    expected_boot=none
  fi
  ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${NONCE}' '${authorization_sha}' '${evidence_completed_at}' '${enforce_evidence_time}' '${expected_boot}' '${completion_not_after}'" <<'REMOTE' >/dev/null || {
set +x
exec 2>/dev/null
revision="$1"; nonce="$2"; authorization_sha="$3"; evidence_completed_at="$4"; enforce_evidence_time="$5"; expected_boot="$6"; completion_not_after="$7"
unit="refunddesk-edge-lease-${nonce}.service"
marker=/var/lib/refunddesk/control/edge-window-lease.json
authorization_marker="/var/lib/refunddesk/control/edge-window-authorizations/${authorization_sha}.json"
watchdog_marker=/var/lib/refunddesk/control/edge-window-watchdog.json
watchdog_receipt=/var/lib/refunddesk/control/edge-window-watchdog-preflight.json
[[ "${evidence_completed_at}" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
[[ "${enforce_evidence_time}" == true || "${enforce_evidence_time}" == false ]]
if test "${expected_boot}" != none; then
  current_boot_sha="$(tr -d '\n' </proc/sys/kernel/random/boot_id | sha256sum | cut -d ' ' -f 1)"
  test "${current_boot_sha}" = "${expected_boot}"
fi
exec 8>/run/refunddesk/edge-window-holder.lock
flock --exclusive --nonblock 8
exec 9>/run/refunddesk/operator.lock
flock --exclusive --nonblock 9
exec 7>/run/refunddesk/edge-window-watchdog.lock
flock --exclusive --timeout 5 7
unit_state="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value "${unit}")"
[[ "${unit_state}" == inactive || "${unit_state}" == failed ]]
test "$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.timer)" = inactive
watchdog_service_state="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.service)"
[[ "${watchdog_service_state}" == inactive || "${watchdog_service_state}" == failed ]]
timer_enabled="$(timeout --signal=TERM --kill-after=1s 2s systemctl is-enabled refunddesk-edge-window-watchdog.timer 2>/dev/null)" ||
  test "${timer_enabled}" = disabled
test "${timer_enabled}" = disabled
test ! -e "${watchdog_marker}" && test ! -L "${watchdog_marker}"
test ! -e "${watchdog_receipt}" && test ! -L "${watchdog_receipt}"
test "$(stat --format='%U:%G:%a' "${marker}")" = root:root:600
test "$(stat --format='%U:%G:%a' "${authorization_marker}")" = root:root:600
python3 - "${marker}" "${authorization_marker}" "${nonce}" "${revision}" "${authorization_sha}" "${evidence_completed_at}" "${enforce_evidence_time}" "${completion_not_after}" <<'PY'
import datetime, json, pathlib, sys

lease_path, authorization_path, nonce, revision, authorization_sha, evidence_completed_at, enforce_evidence_time, completion_not_after = sys.argv[1:]
def instant(value): return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
def pairs(items):
    out = {}
    for key, value in items:
        if key in out: raise ValueError("duplicate")
        out[key] = value
    return out
def read(path):
    raw = pathlib.Path(path).read_bytes()
    document = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs)
    if raw != (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii"):
        raise SystemExit(1)
    return document
lease = read(lease_path)
authorization = read(authorization_path)
if set(lease) != {"completedAt","expectedRevision","kind","nonce","schemaVersion","state"}: raise SystemExit(1)
if lease != {"completedAt":lease["completedAt"],"expectedRevision":revision,"kind":"refunddesk.edge-window-host-lease","nonce":nonce,"schemaVersion":1,"state":"complete"}: raise SystemExit(1)
if set(authorization) != {"authorizationSha256","completedAt","expectedRevision","kind","nonce","schemaVersion","state"}: raise SystemExit(1)
if authorization != {"authorizationSha256":authorization_sha,"completedAt":authorization["completedAt"],"expectedRevision":revision,"kind":"refunddesk.edge-window-authorization-consumption","nonce":nonce,"schemaVersion":1,"state":"complete"}: raise SystemExit(1)
if enforce_evidence_time == "true":
    earliest=instant(evidence_completed_at); latest=instant(completion_not_after)
    if not (earliest <= instant(lease["completedAt"]) <= latest): raise SystemExit(1)
    if not (earliest <= instant(authorization["completedAt"]) <= latest): raise SystemExit(1)
PY
REMOTE
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  printf '%s\n' '{"hostLease":{"authorizationMarkerState":"complete","held":true,"holderActive":false,"hostLeaseMarkerState":"complete"}}'
}

production_host_lease_cleanup_status() {
  production_host_lease_finalization_status false false
}

production_caddy_start() {
  local prepared_caddy
  prepared_caddy="$(jq --raw-output '.intents.preparedCaddyContainerId // empty' "${FACTS_FILE}")" || {
    production_error LOCAL_PROBE_INVALID
    return
  }
  [[ "${prepared_caddy}" =~ ^[0-9a-f]{64}$ ]] || {
    production_error LOCAL_PROBE_INVALID
    return
  }
  ssh_command "sudo bash -seu -- '${EXPECTED_REVISION}' '${prepared_caddy}' '${NONCE}'" <<'REMOTE' >/dev/null || {
set +x
exec 2>/dev/null
set -o pipefail
revision="$1"
container_id="$2"
nonce="$3"
marker=/var/lib/refunddesk/control/edge-window-watchdog.json
receipt=/var/lib/refunddesk/control/edge-window-watchdog-preflight.json
release_root="/opt/refunddesk/releases/${revision}/source"
compose_file="${release_root}/deploy/lightsail/compose.yml"
release_env=/etc/refunddesk/release.env
test -f "${compose_file}"
test -f "${release_env}"
test "$(<"${release_root}/.refunddesk-revision")" = "${revision}"
ids="$(timeout --signal=TERM --kill-after=1s 3s docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy | head --bytes=129)"
test "${ids}" = "${container_id}"
inspection="$(timeout --signal=TERM --kill-after=1s 3s docker inspect "${container_id}" | head --bytes=2097153)"
test "${#inspection}" -lt 2097153
jq --exit-status --arg id "${container_id}" --arg revision "${revision}" '
  length == 1 and .[0].Id == $id
  and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
  and .[0].Config.Labels["com.docker.compose.service"] == "caddy"
  and .[0].Config.Labels["com.refunddesk.revision"] == $revision
  and .[0].HostConfig.RestartPolicy.Name == "no"
  and .[0].State.Running == false
' <<<"${inspection}" >/dev/null
timeout --signal=TERM --kill-after=1s 3s docker update --restart=no "${container_id}" >/dev/null
test "$(timeout --signal=TERM --kill-after=1s 3s docker info --format '{{.CgroupDriver}}')" = systemd
docker_service_properties="$(timeout --signal=TERM --kill-after=1s 3s systemctl show \
  --property=LoadState --property=ActiveState --property=ControlGroup --property=MainPID -- docker.service)"
test "$(grep -Fc 'LoadState=loaded' <<<"${docker_service_properties}")" = 1
test "$(grep -Fc 'ActiveState=active' <<<"${docker_service_properties}")" = 1
test "$(grep -Fc 'ControlGroup=/system.slice/docker.service' <<<"${docker_service_properties}")" = 1
docker_main_pid="$(sed -n 's/^MainPID=//p' <<<"${docker_service_properties}")"
[[ "${docker_main_pid}" =~ ^[1-9][0-9]*$ ]]
test "$(basename "$(readlink -f "/proc/${docker_main_pid}/exe")")" = dockerd
receipt_before="$(jq --raw-output '.observedBoottimeMilliseconds' "${receipt}")"
[[ "${receipt_before}" =~ ^[0-9]+$ ]]
timeout --signal=TERM --kill-after=1s 15s systemctl start refunddesk-edge-window-watchdog.service
test "$(systemctl show --property=Result --value refunddesk-edge-window-watchdog.service)" = success
test "$(systemctl show --property=ExecMainStatus --value refunddesk-edge-window-watchdog.service)" = 0
receipt_after="$(jq --raw-output '.observedBoottimeMilliseconds' "${receipt}")"
[[ "${receipt_after}" =~ ^[0-9]+$ && "${receipt_after}" -ge "${receipt_before}" ]]
exec 9>/run/refunddesk/edge-window-watchdog.lock
flock --exclusive --timeout 5 9
test ! -e /var/lib/refunddesk/control/edge-window-watchdog-triggered
test ! -e /run/refunddesk/edge-window-watchdog-triggered
test -f "${marker}" && test ! -L "${marker}"
test "$(stat --format='%U:%G:%a:%h' "${marker}")" = root:root:600:1
test -f "${receipt}" && test ! -L "${receipt}"
test "$(stat --format='%U:%G:%a:%h' "${receipt}")" = root:root:600:1
marker_sha="$(sha256sum "${marker}" | cut -d ' ' -f 1)"
boot_id="$(jq --raw-output '.bootId' "${marker}")"
boot_sha="$(printf '%s' "${boot_id}" | sha256sum | cut -d ' ' -f 1)"
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" --arg containerId "${container_id}" '
  type == "object" and .state == "armed" and .startDeadlineBoottimeMilliseconds == null
  and .triggered == false and .nonce == $nonce and .expectedRevision == $revision
  and .caddyContainerId == $containerId
  and (.workerContainerId | type == "string" and test("^[0-9a-f]{64}$"))
  and .caddyContainerId != .workerContainerId
' "${marker}" >/dev/null
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" \
  --arg markerSha "${marker_sha}" --arg bootSha "${boot_sha}" --arg caddyContainerId "${container_id}" \
  --arg workerContainerId "$(jq --raw-output '.workerContainerId' "${marker}")" '
    type == "object" and .kind == "refunddesk.edge-window-watchdog-preflight"
    and .schemaVersion == 1 and .nonce == $nonce and .expectedRevision == $revision
    and .markerSha256 == $markerSha and .bootIdSha256 == $bootSha
    and .caddyContainerId == $caddyContainerId and .workerContainerId == $workerContainerId
  ' "${receipt}" >/dev/null
# The only effectful Docker command executes outside the watchdog lock.  The
# marker first enters a short, durable `starting` state. A timer tick tolerates
# that state only until this CLOCK_BOOTTIME mini-deadline; after it, or near the
# window deadline, the tick advances triggered containment and fences scopes.
current_boot_ms="$(awk '{printf "%.0f\n", $1 * 1000}' /proc/uptime)"
deadline_boot_ms="$(jq --raw-output '.deadlineBoottimeMilliseconds' "${marker}")"
[[ "${current_boot_ms}" =~ ^[0-9]+$ && "${deadline_boot_ms}" =~ ^[0-9]+$ ]]
start_deadline_boot_ms=$((current_boot_ms + 5000))
(( start_deadline_boot_ms + 25000 <= deadline_boot_ms ))
temporary="$(mktemp /var/lib/refunddesk/control/.edge-window-watchdog.XXXXXXXXXX)"
jq --compact-output --sort-keys --argjson startDeadline "${start_deadline_boot_ms}" \
  '.state = "starting" | .startDeadlineBoottimeMilliseconds = $startDeadline' "${marker}" >"${temporary}"
chmod 0600 "${temporary}"
chown root:root "${temporary}"
sync "${temporary}"
mv -f "${temporary}" "${marker}"
sync /var/lib/refunddesk/control
flock --unlock 9
exec 9>&-
timeout --signal=TERM --kill-after=1s 2s docker start "${container_id}" >/dev/null
exec 9>/run/refunddesk/edge-window-watchdog.lock
flock --exclusive --timeout 2 9
test ! -e /var/lib/refunddesk/control/edge-window-watchdog-triggered
test ! -e /run/refunddesk/edge-window-watchdog-triggered
test -f "${marker}" && test ! -L "${marker}"
test -f "${receipt}" && test ! -L "${receipt}"
current_boot_ms="$(awk '{printf "%.0f\n", $1 * 1000}' /proc/uptime)"
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" --arg containerId "${container_id}" \
  --argjson nowBoot "${current_boot_ms}" '
  type == "object" and .state == "starting" and .triggered == false and .nonce == $nonce
  and .expectedRevision == $revision and .caddyContainerId == $containerId
  and (.startDeadlineBoottimeMilliseconds | type == "number" and floor == . and . > $nowBoot)
' "${marker}" >/dev/null
jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" --arg caddyContainerId "${container_id}" '
    type == "object" and .nonce == $nonce and .expectedRevision == $revision
    and .caddyContainerId == $caddyContainerId
  ' "${receipt}" >/dev/null
temporary="$(mktemp /var/lib/refunddesk/control/.edge-window-watchdog.XXXXXXXXXX)"
jq --compact-output --sort-keys '.state = "armed_running" | .startDeadlineBoottimeMilliseconds = null' \
  "${marker}" >"${temporary}"
chmod 0600 "${temporary}"
chown root:root "${temporary}"
sync "${temporary}"
mv -f "${temporary}" "${marker}"
sync /var/lib/refunddesk/control
flock --unlock 9
exec 9>&-
for _ in $(seq 1 20); do
  test "$(timeout --signal=TERM --kill-after=1s 2s docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${container_id}")" = healthy && break
  sleep 1
done
expected_image="$(docker compose --project-name refunddesk --env-file "${release_env}" --file "${compose_file}" config --format json | jq --raw-output '.services.caddy.image')"
expected_image_id="$(docker image inspect --format '{{.Id}}' "${expected_image}")"
[[ "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]
inspection="$(docker inspect "${container_id}")"
jq --exit-status --arg id "${container_id}" --arg image "${expected_image}" --arg imageId "${expected_image_id}" --arg revision "${revision}" --arg source "${release_root}/deploy/lightsail/Caddyfile.public" '
  length == 1 and .[0].Id == $id
  and .[0].Image == $imageId
  and .[0].Config.Image == $image
  and .[0].Config.Labels["com.docker.compose.project"] == "refunddesk"
  and .[0].Config.Labels["com.docker.compose.service"] == "caddy"
  and .[0].Config.Labels["com.refunddesk.revision"] == $revision
  and (.[0].Config.Labels["com.docker.compose.config-hash"] | type == "string" and length == 64)
  and .[0].HostConfig.RestartPolicy.Name == "no"
  and .[0].State.Running == true and .[0].State.Health.Status == "healthy"
  and ([.[0].Mounts[] | select(.Destination == "/etc/caddy/Caddyfile" and .Source == $source and .RW == false)] | length) == 1
' <<<"${inspection}" >/dev/null
scope="docker-${container_id}.scope"
scope_properties="$(timeout --signal=TERM --kill-after=1s 3s systemctl show \
  --property=LoadState --property=ActiveState --property=ControlGroup -- "${scope}")"
test "$(grep -Fc 'LoadState=loaded' <<<"${scope_properties}")" = 1
test "$(grep -Fc 'ActiveState=active' <<<"${scope_properties}")" = 1
test "$(grep -Fxc "ControlGroup=/system.slice/${scope}" <<<"${scope_properties}")" = 1
running_worker_ids="$(docker container ls --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=worker)"
test -z "${running_worker_ids}"
REMOTE
    production_error LOCAL_PROBE_INVALID
    return
  }
  jq --null-input --compact-output --sort-keys '{mutations:{caddyStarts:1}}'
}

production_local_probe() {
  local result
  result="$(ssh_command "sudo bash -seu" <<'REMOTE'
set +x
exec 2>/dev/null
mapfile -t lines </etc/refunddesk/caddy.env
token=""
host=""
for line in "${lines[@]}"; do
  case "${line}" in
    REFUNDDESK_EDGE_ORIGIN_TOKEN=*) token="${line#*=}" ;;
    REFUNDDESK_PUBLIC_HOST=*) host="${line#*=}" ;;
  esac
done
[[ "${token}" =~ ^[A-Za-z0-9_-]{43}$ && "${host}" =~ ^[A-Za-z0-9.-]+$ ]]
wrong="A${token:1}"
[[ "${wrong}" != "${token}" ]] || wrong="B${token:1}"
probe() {
  local url_path="$1" method="$2" header_one="${3:-}" header_two="${4:-}"
  {
    printf '%s\n' 'silent' 'show-error' 'output = "/dev/null"' 'write-out = "%{http_code}"' 'connect-timeout = 5' 'max-time = 15'
    printf 'resolve = "%s:443:127.0.0.1"\n' "${host}"
    printf 'request = "%s"\n' "${method}"
    [[ -z "${header_one}" ]] || printf 'header = "%s"\n' "${header_one}"
    [[ -z "${header_two}" ]] || printf 'header = "%s"\n' "${header_two}"
    printf 'url = "https://%s%s"\n' "${host}" "${url_path}"
  } | curl --config -
}
correct="$(probe /api/health GET "X-RefundDesk-Origin-Token: ${token}")"
missing="$(probe /api/health GET)"
wrong_status="$(probe /api/health GET "X-RefundDesk-Origin-Token: ${wrong}")"
# The production signed-API admission gate rejects a forwarded origin token
# with 503.  A 401 missing-signature response therefore observes end-to-end
# that the exact Caddy runtime removed the token before the real backend.
backend_strip="$(probe /api/v1/settings/get POST "X-RefundDesk-Origin-Token: ${token}" 'X-Forwarded-For: 192.0.2.1')"
caddy_id="$(docker container ls --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter label=com.docker.compose.service=caddy)"
[[ "${caddy_id}" =~ ^[0-9a-f]{64}$ ]]
runtime_config="$(docker exec "${caddy_id}" wget --quiet --output-document=- http://127.0.0.1:2019/config/)"
strip=false
jq --exit-status '[.. | objects | .headers?.request?.delete? // empty | arrays[]] | any(. == "X-RefundDesk-Origin-Token")' <<<"${runtime_config}" >/dev/null && strip=true
printf '{"backendStrip":%s,"correct":%s,"missing":%s,"strip":%s,"wrong":%s}\n' "${backend_strip}" "${correct}" "${missing}" "${strip}" "${wrong_status}"
REMOTE
)" || {
    production_error LOCAL_PROBE_INVALID
    return
  }
  [[ "$(jq --compact-output --sort-keys . <<<"${result}")" == '{"backendStrip":401,"correct":200,"missing":404,"strip":true,"wrong":404}' ]] || {
    production_error LOCAL_PROBE_INVALID
    return
  }
  jq --null-input --compact-output --sort-keys '{origin:{tokenMatched:true},probes:{localCaddy:{backendStripStatus:401,correctTokenStatus:200,missingTokenStatus:404,tokenStripped:true,wrongTokenStatus:404}}}'
}

production_public_health() {
  local headers="${OPERATION_ROOT}/public-health.headers" headers_temporary public_url
  local -a pipeline_status
  public_url="$(transport_value publicBaseUrl)/api/health?revision=${EXPECTED_REVISION}&probe=edge-${NONCE}"
  # The candidate-controlled response body is semantically irrelevant.  Never
  # materialize it in the finite private control volume.  Retained headers
  # pass through a 64 KiB + 1 sentinel reader so the bound applies while curl
  # writes, not only after an attacker-controlled response has completed.
  headers_temporary="$(mktemp --tmpdir="${OPERATION_ROOT}" '.public-health.headers.XXXXXXXXXX')" || {
    production_error PUBLIC_HEALTH_INVALID
    return
  }
  chmod 600 "${headers_temporary}" || {
    rm --force -- "${headers_temporary}"
    production_error PUBLIC_HEALTH_INVALID
    return
  }
  # REFUNDDESK_EDGE_PUBLIC_HEALTH_BOUNDED_HEADERS_BEGIN
  set +e
  curl --silent --show-error --header 'Cache-Control: no-cache' --header 'Pragma: no-cache' --dump-header - --output /dev/null --max-filesize 65536 --connect-timeout 5 --max-time 20 "${public_url}" |
    head --bytes=65537 >"${headers_temporary}"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  # REFUNDDESK_EDGE_PUBLIC_HEALTH_BOUNDED_HEADERS_END
  if (( ${pipeline_status[0]:-1} != 0 || ${pipeline_status[1]:-1} != 0 || $(wc --bytes <"${headers_temporary}") > 65536 )); then
    rm --force -- "${headers_temporary}"
    production_error PUBLIC_HEALTH_INVALID
    return
  fi
  sync "${headers_temporary}" || {
    rm --force -- "${headers_temporary}"
    production_error PUBLIC_HEALTH_INVALID
    return
  }
  mv --force -- "${headers_temporary}" "${headers}" || {
    rm --force -- "${headers_temporary}"
    production_error PUBLIC_HEALTH_INVALID
    return
  }
  python3 - "${headers}" "${EXPECTED_REVISION}" <<'PY' || {
import re, sys
path, revision = sys.argv[1:]
raw = open(path, "rb").read()
if not raw or len(raw) > 65536 or b"\x00" in raw:
    raise SystemExit(1)
try:
    lines = raw.decode("ascii").replace("\r\n", "\n").splitlines()
except UnicodeDecodeError:
    raise SystemExit(1)
status = [line for line in lines if line.startswith("HTTP/")]
if len(status) != 1 or re.fullmatch(r"HTTP/(?:1\.[01]|2) 200(?: .*)?", status[0]) is None:
    raise SystemExit(1)
headers = {}
for line in lines:
    if not line or line.startswith("HTTP/"):
        continue
    if line[:1] in {" ", "\t"} or ":" not in line:
        raise SystemExit(1)
    name, value = line.split(":", 1)
    if re.fullmatch(r"[A-Za-z0-9-]+", name) is None:
        raise SystemExit(1)
    headers.setdefault(name.lower(), []).append(value.strip())
required = ("cache-control", "via", "x-amz-cf-id", "x-amz-cf-pop", "x-cache", "x-refunddesk-revision")
if any(len(headers.get(name, [])) != 1 for name in required):
    raise SystemExit(1)
if "no-store" not in {part.strip().lower() for part in headers["cache-control"][0].split(",")}:
    raise SystemExit(1)
if re.fullmatch(r"1\.1 [A-Za-z0-9.-]+\.cloudfront\.net \(CloudFront\)", headers["via"][0], re.I) is None:
    raise SystemExit(1)
if re.fullmatch(r"[A-Za-z0-9_+/=-]{16,256}", headers["x-amz-cf-id"][0]) is None:
    raise SystemExit(1)
if re.fullmatch(r"[A-Z0-9]{3,10}[0-9]{1,3}-[A-Z][0-9]", headers["x-amz-cf-pop"][0]) is None:
    raise SystemExit(1)
if headers["x-cache"][0].lower() != "miss from cloudfront":
    raise SystemExit(1)
if any(name in headers for name in ("x-refunddesk-origin-token", "set-cookie")):
    raise SystemExit(1)
if "age" in headers and (len(headers["age"]) != 1 or headers["age"][0] != "0"):
    raise SystemExit(1)
if headers["x-refunddesk-revision"][0] != revision:
    raise SystemExit(1)
PY
    production_error PUBLIC_HEALTH_INVALID
    return
  }
  jq --null-input --compact-output --sort-keys '{probes:{publicHealth:{cloudFrontObserved:true,noStore:true,revisionMatches:true,status:200}}}'
}

production_host_contain() {
  local metrics marker_required=false previously_disarmed=false previously_contained=false prepared_caddy worker_container
  local marker_publication_recovered=true
  require_facts '.intents.watchdogArmAttempted == true or .mutations.watchdogArms > 0' && marker_required=true
  require_facts '.watchdog.disarmed == true and .containment.watchdogDisarmed == true and .watchdog.markerComplete == true' && previously_disarmed=true
  require_facts '.containment.caddyStopped == true and .containment.workerStopped == true and .containment.maintenanceStopped == true and .containment.publicListenersClosed == true' && previously_contained=true
  prepared_caddy="$(jq --raw-output '.intents.preparedCaddyContainerId // "none"' "${FACTS_FILE}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  worker_container="$(transport_value workerContainerId)" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  [[ "${prepared_caddy}" == none || "${prepared_caddy}" =~ ^[0-9a-f]{64}$ ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  [[ "${worker_container}" =~ ^[0-9a-f]{64}$ && "${worker_container}" != "${prepared_caddy}" ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  if [[ "${marker_required}" == true && "${previously_disarmed}" != true ]]; then
    # Repair only a crash in the create-new publication boundary before any
    # consumer reads or replaces the marker. Recovery mode never creates a
    # missing marker and never adopts canonical bytes from another operation.
    remote_install_create_new "${WATCHDOG_MARKER}" /var/lib/refunddesk/control/edge-window-watchdog.json 0600 false || {
      marker_publication_recovered=false
    }
  fi
  metrics="$(ssh_command "sudo bash -seu -- '${NONCE}' '${EXPECTED_REVISION}' '${marker_required}' '${previously_disarmed}' '${previously_contained}' '${prepared_caddy}' '${worker_container}' '${marker_publication_recovered}'" <<'REMOTE'
set +x
set -o pipefail
exec 2>/dev/null
nonce="$1"
revision="$2"
marker_required="$3"
previously_disarmed="$4"
previously_contained="$5"
expected_caddy="$6"
expected_worker="$7"
marker_publication_recovered="$8"
marker=/var/lib/refunddesk/control/edge-window-watchdog.json
receipt=/var/lib/refunddesk/control/edge-window-watchdog-preflight.json
control_trigger=/var/lib/refunddesk/control/edge-window-watchdog-triggered
runtime_trigger=/run/refunddesk/edge-window-watchdog-triggered
[[ "${marker_required}" == true || "${marker_required}" == false ]]
[[ "${previously_disarmed}" == true || "${previously_disarmed}" == false ]]
[[ "${previously_contained}" == true || "${previously_contained}" == false ]]
[[ "${expected_caddy}" == none || "${expected_caddy}" =~ ^[0-9a-f]{64}$ ]]
[[ "${expected_worker}" =~ ^[0-9a-f]{64}$ && "${expected_worker}" != "${expected_caddy}" ]]
[[ "${marker_publication_recovered}" == true || "${marker_publication_recovered}" == false ]]
status=0
continuity_valid=true
watchdog_triggered=false
if test "${marker_publication_recovered}" != true; then
  status=1
  continuity_valid=false
  watchdog_triggered=true
fi
containers_stopped=0
containers_fenced=0
units_stopped=0
docker_api_fenced=false
stop_unit() {
  unit="$1"
  state="$(timeout --signal=TERM --kill-after=1s 1s systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)"
  if test "${state}" != inactive; then units_stopped=$((units_stopped + 1)); fi
  timeout --signal=TERM --kill-after=1s 2s systemctl stop "${unit}" >/dev/null 2>&1 || {
    timeout --signal=TERM --kill-after=1s 1s systemctl kill --kill-who=all --signal=KILL "${unit}" >/dev/null 2>&1 || true
    timeout --signal=TERM --kill-after=1s 1s systemctl stop "${unit}" >/dev/null 2>&1 || status=1
  }
}
disable_unit() {
  unit="$1"
  state="$(timeout --signal=TERM --kill-after=1s 1s systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)"
  if test "${state}" != inactive; then units_stopped=$((units_stopped + 1)); fi
  timeout --signal=TERM --kill-after=1s 3s systemctl disable --now "${unit}" >/dev/null 2>&1 || {
    timeout --signal=TERM --kill-after=1s 1s systemctl kill --kill-who=all --signal=KILL "${unit}" >/dev/null 2>&1 || true
    timeout --signal=TERM --kill-after=1s 1s systemctl stop "${unit}" >/dev/null 2>&1 || status=1
    test "$(timeout --signal=TERM --kill-after=1s 1s systemctl is-enabled "${unit}" 2>/dev/null || true)" = disabled || status=1
  }
}
# REFUNDDESK_EDGE_HOST_CONTAIN_CONTAINERS_BEGIN
# Fence the exact listener-bearing Caddy and worker identities first.  Every
# command has one fixed timeout; an unavailable Docker API falls back to the
# exact systemd scope without delaying later unit and listener barriers.
contain_exact_container() {
  local id="$1" before after
  test "${id}" != none || return 0
  [[ "${id}" =~ ^[0-9a-f]{64}$ ]] || { status=1; return; }
  if test "${docker_api_fenced}" = true; then
    timeout --signal=TERM --kill-after=1s 2s systemctl kill --kill-who=all --signal=KILL "docker-${id}.scope" >/dev/null 2>&1 || status=1
    return
  fi
  before="$(timeout --signal=TERM --kill-after=1s 2s docker inspect --format '{{.HostConfig.RestartPolicy.Name}}:{{.State.Running}}' "${id}" 2>/dev/null)" || {
    before=unavailable
    status=1
  }
  if timeout --signal=TERM --kill-after=1s 2s docker update --restart=no "${id}" >/dev/null 2>&1; then
    if test "${before%%:*}" != no; then containers_fenced=$((containers_fenced + 1)); fi
  else
    status=1
  fi
  if test "${before##*:}" = true || test "${before}" = unavailable; then
    if timeout --signal=TERM --kill-after=1s 5s docker stop --time 3 "${id}" >/dev/null 2>&1 ||
      timeout --signal=TERM --kill-after=1s 2s docker kill "${id}" >/dev/null 2>&1 ||
      timeout --signal=TERM --kill-after=1s 2s systemctl kill --kill-who=all --signal=KILL "docker-${id}.scope" >/dev/null 2>&1; then
      containers_stopped=$((containers_stopped + 1))
    else
      status=1
    fi
  fi
  after="$(timeout --signal=TERM --kill-after=1s 2s docker inspect --format '{{.HostConfig.RestartPolicy.Name}}:{{.State.Running}}' "${id}" 2>/dev/null)" || {
    after=unavailable
    status=1
  }
  if test "${after}" != no:false; then
    timeout --signal=TERM --kill-after=1s 2s systemctl kill --kill-who=all --signal=KILL "docker-${id}.scope" >/dev/null 2>&1 || true
    status=1
  fi
}
contain_exact_container "${expected_caddy}"

# Drift inventory is bounded at the producer and validated before any ID can
# become argv.  At most 64 validated drift IDs are fenced/stopped by three
# aggregate fixed-time calls; overflow is never iterated and remains status 1.
docker_fail_safe_fenced=false
fence_ambiguous_docker() {
  if test "${docker_fail_safe_fenced}" = true; then return; fi
  # An unknown Caddy or worker scope is more dangerous than availability
  # loss. Mask and stop socket activation before any scope/service fence, then
  # never invoke the Docker API again in this containment attempt.
  docker_api_fenced=true
  timeout --signal=TERM --kill-after=1s 3s systemctl mask --runtime --now -- docker.socket >/dev/null 2>&1 || {
    timeout --signal=TERM --kill-after=1s 1s systemctl kill --kill-who=all --signal=KILL -- docker.socket >/dev/null 2>&1 || true
    timeout --signal=TERM --kill-after=1s 1s systemctl stop -- docker.socket >/dev/null 2>&1 || status=1
  }
  socket_load="$(timeout --signal=TERM --kill-after=1s 1s systemctl show --property=LoadState --value -- docker.socket 2>/dev/null)" || {
    socket_load=unavailable
    status=1
  }
  socket_state="$(timeout --signal=TERM --kill-after=1s 1s systemctl show --property=ActiveState --value -- docker.socket 2>/dev/null || true)"
  socket_enabled="$(timeout --signal=TERM --kill-after=1s 1s systemctl is-enabled -- docker.socket 2>/dev/null || true)"
  if test "${socket_load}" = not-found; then
    :
  else
    [[ "${socket_load}" == masked || "${socket_load}" == loaded ]] || status=1
    [[ "${socket_state}" == inactive || "${socket_state}" == failed ]] || status=1
    [[ "${socket_enabled}" == masked || "${socket_enabled}" == masked-runtime ]] || status=1
  fi
  timeout --signal=TERM --kill-after=1s 3s systemctl kill --kill-who=all --signal=KILL -- 'docker-*.scope' >/dev/null 2>&1 || status=1
  timeout --signal=TERM --kill-after=1s 2s systemctl kill --kill-who=all --signal=KILL -- docker.service >/dev/null 2>&1 || true
  timeout --signal=TERM --kill-after=1s 2s systemctl stop -- docker.service >/dev/null 2>&1 || true
  docker_state="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value -- docker.service 2>/dev/null)" || {
    docker_state=unavailable
    status=1
  }
  [[ "${docker_state}" == inactive || "${docker_state}" == failed ]] || status=1
  docker_fail_safe_fenced=true
}
if test "${marker_publication_recovered}" != true; then
  # An ambiguous create-new inode must never suppress physical containment.
  # Preserve every marker/pending authority for recovery, but broadly fence
  # Docker before the worker and all later unit/listener barriers.
  fence_ambiguous_docker
fi
read_public_listener_surface() {
  local protocol port listener_output listeners_closed=true
  for protocol in tcp udp; do
    for port in 80 443; do
      if test "${protocol}" = tcp; then
        listener_output="$(timeout --signal=TERM --kill-after=1s 2s ss -H -ltn "sport = :${port}" 2>/dev/null | head --bytes=1)" || {
          listener_output=unavailable
          listeners_closed=false
        }
      else
        listener_output="$(timeout --signal=TERM --kill-after=1s 2s ss -H -lun "sport = :${port}" 2>/dev/null | head --bytes=1)" || {
          listener_output=unavailable
          listeners_closed=false
        }
      fi
      test -z "${listener_output}" || listeners_closed=false
    done
  done
  [[ "${listeners_closed}" == true ]]
}
for service in caddy worker; do
  if test "${docker_api_fenced}" = true; then
    if test "${service}" = worker; then
      # Broad fencing may have happened in the Caddy group. Re-read the public
      # sockets before any worker/unit work, then kill the exact worker scope
      # without reconnecting to the now-masked Docker socket.
      read_public_listener_surface || status=1
      contain_exact_container "${expected_worker}"
    fi
    continue
  fi
  if test "${service}" = worker; then
    # A container readback cannot prove that docker-proxy, stale DNAT or an
    # unknown listener is gone. Close the four public TCP/UDP sockets
    # immediately after the complete Caddy group, before any worker or
    # maintenance timeout may consume the containment reserve.
    # REFUNDDESK_EDGE_HOST_CONTAIN_EARLY_LISTENERS_BEGIN
    if ! read_public_listener_surface; then
      status=1
      fence_ambiguous_docker
      read_public_listener_surface || status=1
    fi
    # REFUNDDESK_EDGE_HOST_CONTAIN_EARLY_LISTENERS_END
    contain_exact_container "${expected_worker}"
    test "${docker_api_fenced}" != true || continue
  fi
  inventory_ok=1
  ids="$(timeout --signal=TERM --kill-after=1s 2s docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=refunddesk --filter "label=com.docker.compose.service=${service}" | head --bytes=16385)" || {
    ids=""
    inventory_ok=0
    status=1
  }
  test "${#ids}" -lt 16385 || { inventory_ok=0; status=1; }
  drift_ids=()
  if test "${inventory_ok}" = 1; then
    while IFS= read -r id; do
      test -n "${id}" || continue
      if [[ ! "${id}" =~ ^[0-9a-f]{64}$ ]]; then
        inventory_ok=0
        status=1
        break
      fi
      if test "${id}" != "${expected_caddy}" && test "${id}" != "${expected_worker}"; then
        drift_ids+=("${id}")
      fi
      if (( ${#drift_ids[@]} > 64 )); then
        inventory_ok=0
        status=1
        break
      fi
    done <<<"${ids}"
  fi
  if test "${inventory_ok}" != 1; then
    drift_ids=()
    fence_ambiguous_docker
    continue
  fi
  if (( ${#drift_ids[@]} > 0 )); then
    if timeout --signal=TERM --kill-after=1s 3s docker update --restart=no "${drift_ids[@]}" >/dev/null 2>&1; then
      containers_fenced=$((containers_fenced + ${#drift_ids[@]}))
    else
      status=1
      fence_ambiguous_docker
      continue
    fi
    if timeout --signal=TERM --kill-after=1s 8s docker stop --time 3 "${drift_ids[@]}" >/dev/null 2>&1 ||
      timeout --signal=TERM --kill-after=1s 3s docker kill "${drift_ids[@]}" >/dev/null 2>&1; then
      containers_stopped=$((containers_stopped + ${#drift_ids[@]}))
    else
      status=1
      fence_ambiguous_docker
      continue
    fi
    states="$(timeout --signal=TERM --kill-after=1s 3s docker inspect --format '{{.HostConfig.RestartPolicy.Name}}:{{.State.Running}}' "${drift_ids[@]}" 2>/dev/null)" || {
      states=unavailable
      status=1
      fence_ambiguous_docker
      continue
    }
    state_count=0
    state_valid=1
    while IFS= read -r container_state; do
      test -n "${container_state}" || continue
      state_count=$((state_count + 1))
      if test "${container_state}" != no:false; then
        status=1
        state_valid=0
      fi
    done <<<"${states}"
    if test "${state_count}" -ne "${#drift_ids[@]}"; then
      status=1
      state_valid=0
    fi
    test "${state_valid}" = 1 || fence_ambiguous_docker
  fi
done
# REFUNDDESK_EDGE_HOST_CONTAIN_CONTAINERS_END
for unit in refunddesk-backup.timer refunddesk-retention.timer; do
  disable_unit "${unit}"
done
for unit in refunddesk-backup.service refunddesk-retention.service refunddesk-quiesce-recovery.service; do
  stop_unit "${unit}"
done
release_inventory_ok=1
release_output="$(timeout --signal=TERM --kill-after=1s 2s systemctl list-units --type=service --all --no-legend --no-pager 'refunddesk-release-*.service' 2>/dev/null | awk '{print $1}' | head --bytes=16385)" || { release_output=""; release_inventory_ok=0; status=1; }
release_count=0
while IFS= read -r unit; do
  test -n "${unit}" || continue
  release_count=$((release_count + 1))
  if [[ ! "${unit}" =~ ^refunddesk-release-(fence-)?[0-9a-f]{12}-[0-9]+\.service$ ]]; then status=1; continue; fi
done <<<"${release_output}"
test "${#release_output}" -lt 16385 || status=1
test "${release_count}" -le 64 || status=1
if test "${release_count}" -gt 0 || test "${release_inventory_ok}" != 1; then
  if timeout --signal=TERM --kill-after=1s 12s systemctl stop 'refunddesk-release-*.service' >/dev/null 2>&1; then
    units_stopped=$((units_stopped + release_count))
  else
    timeout --signal=TERM --kill-after=1s 2s systemctl kill --kill-who=all --signal=KILL 'refunddesk-release-*.service' >/dev/null 2>&1 || true
    timeout --signal=TERM --kill-after=1s 3s systemctl stop 'refunddesk-release-*.service' >/dev/null 2>&1 || status=1
  fi
fi
for unit in refunddesk-backup.timer refunddesk-backup.service refunddesk-retention.timer refunddesk-retention.service refunddesk-quiesce-recovery.service; do
  test "$(timeout --signal=TERM --kill-after=1s 1s systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)" = inactive || status=1
done
for timer in refunddesk-backup.timer refunddesk-retention.timer; do
  test "$(timeout --signal=TERM --kill-after=1s 1s systemctl is-enabled "${timer}" 2>/dev/null || true)" = disabled || status=1
done
active_release_output="$(timeout --signal=TERM --kill-after=1s 2s systemctl list-units --type=service --all --state=activating,active,reloading,deactivating,failed --no-legend --no-pager 'refunddesk-release-*.service' | awk '{print $1}' | head --bytes=1)" || {
  active_release_output=unavailable
  status=1
}
test -z "${active_release_output}" || status=1
# REFUNDDESK_EDGE_HOST_CONTAIN_LISTENERS_BEGIN
read_listener_surface() {
  local protocol port listener_output listeners_closed=true
  for protocol in tcp udp; do
    for port in 80 443; do
      if [[ "${protocol}" == tcp ]]; then
        listener_output="$(timeout --signal=TERM --kill-after=1s 2s ss -H -ltn "sport = :${port}" 2>/dev/null | head --bytes=1)" || {
          listener_output=unavailable
          listeners_closed=false
        }
      else
        listener_output="$(timeout --signal=TERM --kill-after=1s 2s ss -H -lun "sport = :${port}" 2>/dev/null | head --bytes=1)" || {
          listener_output=unavailable
          listeners_closed=false
        }
      fi
      test -z "${listener_output}" || listeners_closed=false
    done
  done
  [[ "${listeners_closed}" == true ]]
}
if ! read_listener_surface; then
  # A stopped Docker container is not proof that docker-proxy, a drift scope,
  # or stale DNAT no longer exposes 80/443. Escalate once to the same bounded
  # broad Docker fence, then require a fresh four-socket readback.
  status=1
  fence_ambiguous_docker
  read_listener_surface || status=1
fi
# REFUNDDESK_EDGE_HOST_CONTAIN_LISTENERS_END
# Every marker read/transition is serialized with the timer tick.  A marker
# already contained before the first positively journaled host containment is
# a fail-safe trigger (or an unacknowledged transition) and can never authorize
# PASS, even though cleanup remains physically convergent.
exec 7>/run/refunddesk/edge-window-watchdog.lock
watchdog_lock_acquired=false
identity_transition_present=false
if ! flock --exclusive --timeout 5 7; then
  status=1
  continuity_valid=false
else
  watchdog_lock_acquired=true
  shopt -s nullglob
  identity_transitions=(
    /var/lib/refunddesk/control/edge-window-caddy-identity-transition-*.json
    /var/lib/refunddesk/control/.edge-window-caddy-identity-transition-*.json.*
  )
  shopt -u nullglob
  if test "${#identity_transitions[@]}" -eq 1; then
    identity_transition_present=true
  elif test "${#identity_transitions[@]}" -gt 1; then
    status=1
    continuity_valid=false
  fi
  # Either sentinel is a monotone record that the timer entered a fail-safe
  # path before it could safely rewrite the full marker.  Baseline admission
  # proves both names absent before arming, so a controlled sentinel belongs
  # to this sole active marker generation.  A malformed/uncontrolled name is
  # still fail-closed but cannot be removed automatically.
  for trigger_path in "${control_trigger}" "${runtime_trigger}"; do
    if test -e "${trigger_path}" || test -L "${trigger_path}"; then
      watchdog_triggered=true
      trigger_metadata="$(stat --format='%U:%G:%a:%h:%s' -- "${trigger_path}" 2>/dev/null || true)"
      if [[ ! "${trigger_metadata}" =~ ^root:root:600:1:([0-9]|1[0-6])$ ]] || test ! -f "${trigger_path}" || test -L "${trigger_path}"; then
        status=1
        continuity_valid=false
      fi
    fi
  done
# A crash after the locked disarm removed the marker is recoverable from the
# durable facts only after independently re-proving that timer and service are
# quiescent and the marker is still absent under the same watchdog lock.
fi
if test "${watchdog_lock_acquired}" != true; then
  :
elif test "${previously_disarmed}" = true && test "${identity_transition_present}" = true; then
  status=1
  continuity_valid=false
elif test "${previously_disarmed}" = true; then
    timer_state="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.timer 2>/dev/null)" || {
      timer_state=unavailable
      status=1
      continuity_valid=false
    }
    service_state="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.service 2>/dev/null)" || {
      service_state=unavailable
      status=1
      continuity_valid=false
    }
    timer_enabled="$(timeout --signal=TERM --kill-after=1s 2s systemctl is-enabled refunddesk-edge-window-watchdog.timer 2>/dev/null)" || true
    test "${timer_state}" = inactive || { status=1; continuity_valid=false; }
    [[ "${service_state}" == inactive || "${service_state}" == failed ]] || { status=1; continuity_valid=false; }
    test "${timer_enabled}" = disabled || { status=1; continuity_valid=false; }
    test ! -e "${marker}" && test ! -L "${marker}" || { status=1; continuity_valid=false; }
# If the deadline marker exists, advance its counters atomically.  Invalid
# marker bytes never suppress the best-effort stops above, but keep cleanup
# incomplete so the host lease is retained.
elif test -e "${marker}"; then
  marker_valid=0
  if test "$(stat --format='%U:%G:%a:%h' "${marker}" 2>/dev/null || true)" = root:root:600:1 && python3 - "${marker}" "${nonce}" "${revision}" <<'PYMARKER'
import json, pathlib, sys
path, nonce, revision = sys.argv[1:]
raw = pathlib.Path(path).read_bytes()
def pairs(items):
    out = {}
    for key, value in items:
        if key in out: raise ValueError("duplicate")
        out[key] = value
    return out
try: document = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs)
except Exception: raise SystemExit(1)
canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
keys = {"armedBoottimeMilliseconds","bootId","caddyContainerId","deadlineBoottimeMilliseconds","deadlineEpoch","expectedRevision","kind","metrics","nonce","schemaVersion","serviceSha256","startDeadlineBoottimeMilliseconds","state","timerSha256","triggered","watchdogSha256","windowSeconds","workerContainerId"}
metric_keys = {"containersRestartFenced","containersStopped","unitsStopRequested"}
if raw != canonical or set(document) != keys or document.get("nonce") != nonce or document.get("expectedRevision") != revision or document.get("state") not in {"armed","armed_running","starting","contained"} or not isinstance(document.get("triggered"), bool): raise SystemExit(1)
if not all(isinstance(document.get(key), str) and len(document[key]) == 64 and all(char in "0123456789abcdef" for char in document[key]) for key in ("caddyContainerId","workerContainerId")): raise SystemExit(1)
if document["caddyContainerId"] == document["workerContainerId"]: raise SystemExit(1)
metrics = document.get("metrics")
if not isinstance(metrics, dict) or set(metrics) != metric_keys or any(not isinstance(v, int) or isinstance(v, bool) or v < 0 for v in metrics.values()): raise SystemExit(1)
PYMARKER
  then
    marker_valid=1
    marker_state="$(jq --raw-output '.state' "${marker}")" || marker_state=invalid
    marker_triggered="$(jq --raw-output '.triggered' "${marker}")" || marker_triggered=true
    if test "${marker_triggered}" = true || { test "${marker_state}" = contained && test "${previously_contained}" != true; }; then
      watchdog_triggered=true
    fi
  else status=1; continuity_valid=false; fi
  temporary=""
  if test "${docker_api_fenced}" != true && test "${marker_publication_recovered}" = true && test "${marker_valid}" = 1 && test "${identity_transition_present:-false}" != true; then temporary="$(mktemp /var/lib/refunddesk/control/.edge-window-watchdog.XXXXXXXXXX)" || status=1; fi
  if test "${docker_api_fenced}" = true; then
    # Broad containment masked docker.socket and made every later Docker API
    # call forbidden. Preserve the exact marker/receipt pair rather than
    # changing its hash and starting a fresh watchdog process whose local
    # DOCKER_API_FENCED flag would reset to false.
    status=1
    continuity_valid=false
    test -z "${temporary:-}" || rm -f -- "${temporary}"
  elif test "${marker_valid}" = 1 && test "${identity_transition_present:-false}" = true; then
    # Do not mutate a marker whose exact pre/post hash is bound by the durable
    # Caddy identity transition. Origin-unbind will repair the split pair under
    # this lock before removing that transition.
    :
  elif test "${marker_publication_recovered}" = true && test "${marker_valid}" = 1 && test -n "${temporary:-}" && jq --compact-output --sort-keys \
    --arg nonce "${nonce}" --arg revision "${revision}" \
    --argjson triggered "${watchdog_triggered}" \
    --argjson fenced "${containers_fenced}" --argjson stopped "${containers_stopped}" --argjson units "${units_stopped}" '
      select(type == "object"
        and keys == ["armedBoottimeMilliseconds","bootId","caddyContainerId","deadlineBoottimeMilliseconds","deadlineEpoch","expectedRevision","kind","metrics","nonce","schemaVersion","serviceSha256","startDeadlineBoottimeMilliseconds","state","timerSha256","triggered","watchdogSha256","windowSeconds","workerContainerId"]
        and .nonce == $nonce and .expectedRevision == $revision and (.state | IN("armed","armed_running","starting","contained")))
      | .state = "contained"
      | .startDeadlineBoottimeMilliseconds = null
      | .triggered = (.triggered or $triggered)
      | .metrics.containersRestartFenced += $fenced
      | .metrics.containersStopped += $stopped
      | .metrics.unitsStopRequested += $units
    ' "${marker}" >"${temporary}"; then
    chmod 0600 "${temporary}" || status=1
    chown root:root "${temporary}" || status=1
    sync "${temporary}" || status=1
    marker_pair_refresh_required=false
    if mv -f "${temporary}" "${marker}" && sync /var/lib/refunddesk/control; then
      marker_pair_refresh_required=true
    else
      status=1
      continuity_valid=false
    fi
  elif test "${marker_publication_recovered}" = true && test "${marker_valid}" = 1; then
    status=1
    continuity_valid=false
    test -z "${temporary:-}" || rm -f -- "${temporary}"
  fi
elif test "${marker_required}" = true; then
  # The embedded stop/fence proof still runs, but a marker that disappeared
  # after arm means the independent fail-safe was not continuously present.
  # Cleanup may continue safely; PASS may not.
  continuity_valid=false
fi
# Host containment changes the marker hash.  Release the lock and run the
# installed watchdog once so it atomically refreshes the receipt binding, then
# reacquire and require an exact marker/receipt pair before any later consumer
# (origin identity transfer or disarm) can proceed.  The tick may repeat the
# already-safe stops; no ingress operation occurs on this path.
if test "${watchdog_lock_acquired}" = true && test "${marker_pair_refresh_required:-false}" = true && test "${docker_api_fenced}" != true; then
  flock --unlock 7 || { status=1; continuity_valid=false; }
  watchdog_lock_acquired=false
  timeout --signal=TERM --kill-after=2s 30s systemctl start refunddesk-edge-window-watchdog.service >/dev/null 2>&1 || {
    status=1
    continuity_valid=false
  }
  if flock --exclusive --timeout 5 7; then
    watchdog_lock_acquired=true
    if ! test -f "${marker}" || test -L "${marker}" ||
      ! test -f "${receipt}" || test -L "${receipt}" ||
      test "$(stat --format='%U:%G:%a:%h' -- "${receipt}" 2>/dev/null || true)" != root:root:600:1; then
      status=1
      continuity_valid=false
    else
      marker_sha="$(sha256sum -- "${marker}" | cut -d ' ' -f 1)" || marker_sha=invalid
      jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" --arg markerSha "${marker_sha}" \
        --arg caddyContainerId "$(jq --raw-output '.caddyContainerId' "${marker}" 2>/dev/null || true)" \
        --arg workerContainerId "$(jq --raw-output '.workerContainerId' "${marker}" 2>/dev/null || true)" '
          type == "object"
          and .kind == "refunddesk.edge-window-watchdog-preflight" and .schemaVersion == 1
          and .nonce == $nonce and .expectedRevision == $revision
          and .markerSha256 == $markerSha
          and .caddyContainerId == $caddyContainerId
          and .workerContainerId == $workerContainerId
        ' "${receipt}" >/dev/null || { status=1; continuity_valid=false; }
    fi
  else
    status=1
    continuity_valid=false
  fi
fi
if test -f "${marker}" && jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '.state == "contained" and .nonce == $nonce and .expectedRevision == $revision' "${marker}" >/dev/null 2>&1; then
  jq --compact-output --sort-keys --argjson continuity "${continuity_valid}" --argjson triggered "${watchdog_triggered}" '{continuityValid:$continuity,metrics,state,triggered:$triggered}' "${marker}"
else
  jq --null-input --compact-output --sort-keys --argjson continuity "${continuity_valid}" --argjson triggered "${watchdog_triggered}" --argjson fenced "${containers_fenced}" --argjson stopped "${containers_stopped}" --argjson units "${units_stopped}" '{continuityValid:$continuity,metrics:{containersRestartFenced:$fenced,containersStopped:$stopped,unitsStopRequested:$units},state:"contained",triggered:$triggered}'
fi
exit "${status}"
REMOTE
)" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  jq --exit-status '
    type == "object"
    and keys == ["continuityValid","metrics","state","triggered"] and .state == "contained"
    and (.continuityValid | type == "boolean")
    and (.triggered | type == "boolean")
    and (.metrics | type == "object"
      and keys == ["containersRestartFenced","containersStopped","unitsStopRequested"]
      and all(.[]; type == "number" and floor == . and . >= 0))
  ' <<<"${metrics}" >/dev/null || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  jq --null-input --compact-output --sort-keys --argjson proof "${metrics}" \
    '{containment:{caddyStopped:true,maintenanceStopped:true,publicListenersClosed:true,workerStopped:true},mutations:$proof.metrics,watchdog:{caddyFenced:true,failSafeContained:$proof.continuityValid,maintenanceStopped:true,publicListenersClosed:true,triggered:$proof.triggered,workerFenced:true}}'
}

production_watchdog_disarm() {
  local enforce_boot="${1:-true}" marker_required=false previously_disarmed=false continuity expected_boot
  [[ "${enforce_boot}" == true || "${enforce_boot}" == false ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  require_facts '.intents.watchdogArmAttempted == true or .mutations.watchdogArms > 0' && marker_required=true
  require_facts '.watchdog.disarmed == true and .watchdog.markerComplete == true and .containment.watchdogDisarmed == true and .containment.markerComplete == true' && previously_disarmed=true
  if [[ "${enforce_boot}" == true ]]; then
    expected_boot="$(window_boot_argument)" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
  else
    expected_boot=none
  fi
  continuity="$(ssh_command "sudo bash -seu -- '${NONCE}' '${EXPECTED_REVISION}' '${marker_required}' '${previously_disarmed}' '${expected_boot}'" <<'REMOTE'
set +x
exec 2>/dev/null
nonce="$1"
revision="$2"
marker_required="$3"
previously_disarmed="$4"
expected_boot="$5"
marker=/var/lib/refunddesk/control/edge-window-watchdog.json
receipt=/var/lib/refunddesk/control/edge-window-watchdog-preflight.json
control_trigger=/var/lib/refunddesk/control/edge-window-watchdog-triggered
runtime_trigger=/run/refunddesk/edge-window-watchdog-triggered
watchdog=/usr/local/libexec/refunddesk-edge-window-watchdog.sh
service=/etc/systemd/system/refunddesk-edge-window-watchdog.service
timer=/etc/systemd/system/refunddesk-edge-window-watchdog.timer
continuity_valid=true
marker_was_triggered=false
exec 9>/run/refunddesk/edge-window-watchdog.lock
flock --exclusive --timeout 10 9
if test "${expected_boot}" != none; then
  current_boot_sha="$(tr -d '\n' </proc/sys/kernel/random/boot_id | sha256sum | cut -d ' ' -f 1)"
  test "${current_boot_sha}" = "${expected_boot}"
fi
active="$(systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.timer 2>/dev/null || true)"
enabled="$(systemctl is-enabled refunddesk-edge-window-watchdog.timer 2>/dev/null || true)"
watchdog_service_state="$(systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.service 2>/dev/null || true)"
if test "${previously_disarmed}" = true; then
  # The disarm patch is journaled atomically before this operation returns.
  # A local crash in the following instruction gap therefore resumes from a
  # positive, idempotent remote state instead of treating the deliberately
  # removed marker as a continuity failure.
  test "${active}" = inactive && test "${enabled}" = disabled
  [[ "${watchdog_service_state}" == inactive || "${watchdog_service_state}" == failed ]]
  test ! -e "${marker}"
  test ! -e "${receipt}"
  test ! -e "${control_trigger}" && test ! -L "${control_trigger}"
  test ! -e "${runtime_trigger}" && test ! -L "${runtime_trigger}"
elif test "${marker_required}" = true; then
  test -f "${marker}" && test ! -L "${marker}" && test "$(stat --format='%U:%G:%a:%h' "${marker}" 2>/dev/null || true)" = root:root:600:1 || continuity_valid=false
  if test "${continuity_valid}" = true; then
    jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '
      type == "object"
      and keys == ["armedBoottimeMilliseconds","bootId","caddyContainerId","deadlineBoottimeMilliseconds","deadlineEpoch","expectedRevision","kind","metrics","nonce","schemaVersion","serviceSha256","startDeadlineBoottimeMilliseconds","state","timerSha256","triggered","watchdogSha256","windowSeconds","workerContainerId"]
      and .schemaVersion == 1 and .kind == "refunddesk.edge-window-watchdog"
      and .state == "contained" and .nonce == $nonce and .expectedRevision == $revision
    ' "${marker}" >/dev/null || continuity_valid=false
    marker_was_triggered="$(jq --raw-output '.triggered // false' "${marker}" 2>/dev/null || true)"
    [[ "${marker_was_triggered}" == true || "${marker_was_triggered}" == false ]] || continuity_valid=false
  fi
  if test "${continuity_valid}" = true; then
    test "${active}" = active && test "${enabled}" = enabled || continuity_valid=false
    test "$(sha256sum "${watchdog}" | cut -d ' ' -f 1)" = "$(jq --raw-output '.watchdogSha256' "${marker}")" || continuity_valid=false
    test "$(sha256sum "${service}" | cut -d ' ' -f 1)" = "$(jq --raw-output '.serviceSha256' "${marker}")" || continuity_valid=false
    test "$(sha256sum "${timer}" | cut -d ' ' -f 1)" = "$(jq --raw-output '.timerSha256' "${marker}")" || continuity_valid=false
    test -f "${receipt}" && test ! -L "${receipt}" && test "$(stat --format='%U:%G:%a:%h' "${receipt}" 2>/dev/null || true)" = root:root:600:1 || continuity_valid=false
    if test "${continuity_valid}" = true; then
      boot_sha="$(jq --raw-output '.bootId' "${marker}" | tr -d '\n' | sha256sum | cut -d ' ' -f 1)"
      jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" --arg bootSha "${boot_sha}" \
        --arg caddyContainerId "$(jq --raw-output '.caddyContainerId' "${marker}")" \
        --arg workerContainerId "$(jq --raw-output '.workerContainerId' "${marker}")" \
        --arg markerSha "$(sha256sum -- "${marker}" | cut -d ' ' -f 1)" \
        --argjson armed "$(jq --raw-output '.armedBoottimeMilliseconds' "${marker}")" \
        --argjson deadlineBoot "$(jq --raw-output '.deadlineBoottimeMilliseconds' "${marker}")" \
        --argjson deadlineEpoch "$(jq --raw-output '.deadlineEpoch' "${marker}")" '
          type == "object"
          and keys == ["bootIdSha256","caddyContainerId","expectedRevision","kind","markerSha256","nonce","observedAtEpoch","observedBoottimeMilliseconds","schemaVersion","workerContainerId"]
          and .schemaVersion == 1 and .kind == "refunddesk.edge-window-watchdog-preflight"
          and .nonce == $nonce and .expectedRevision == $revision and .bootIdSha256 == $bootSha
          and .caddyContainerId == $caddyContainerId and .workerContainerId == $workerContainerId
          and .markerSha256 == $markerSha
          and (.observedAtEpoch | type == "number" and floor == . and . < $deadlineEpoch)
          and (.observedBoottimeMilliseconds | type == "number" and floor == . and . >= $armed and . < $deadlineBoot)
        ' "${receipt}" >/dev/null || continuity_valid=false
    fi
  fi
else
  # Before any arm intent, an active timer or residual marker is an unrelated
  # state and may not be silently consumed by this operation.
  test "${active}" = inactive && test "${enabled}" = disabled && test ! -e "${marker}" && test ! -e "${receipt}"
fi
timeout --signal=TERM --kill-after=1s 10s systemctl disable --now refunddesk-edge-window-watchdog.timer
timeout --signal=TERM --kill-after=1s 10s systemctl stop refunddesk-edge-window-watchdog.service
test "$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.timer)" = inactive
watchdog_service_state="$(timeout --signal=TERM --kill-after=1s 2s systemctl show --property=ActiveState --value refunddesk-edge-window-watchdog.service)"
[[ "${watchdog_service_state}" == inactive || "${watchdog_service_state}" == failed ]]
test "$(systemctl is-enabled refunddesk-edge-window-watchdog.timer || true)" = disabled
if test -e "${marker}"; then
  # Only exact nonce/revision bytes may be removed.  A malformed or unrelated
  # marker remains fail-closed for operator reconciliation.
  test -f "${marker}" && test ! -L "${marker}" && test "$(stat --format='%U:%G:%a:%h' "${marker}")" = root:root:600:1
  jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '
    type == "object" and .nonce == $nonce and .expectedRevision == $revision
  ' "${marker}" >/dev/null
  rm -- "${marker}"
  sync /var/lib/refunddesk/control
fi
if test -e "${receipt}"; then
  test -f "${receipt}" && test ! -L "${receipt}" && test "$(stat --format='%U:%G:%a:%h' "${receipt}")" = root:root:600:1
  jq --exit-status --arg nonce "${nonce}" --arg revision "${revision}" '
    type == "object" and .kind == "refunddesk.edge-window-watchdog-preflight"
    and .schemaVersion == 1 and .nonce == $nonce and .expectedRevision == $revision
  ' "${receipt}" >/dev/null
  rm -- "${receipt}"
  sync /var/lib/refunddesk/control
fi
for trigger_path in "${control_trigger}" "${runtime_trigger}"; do
  if test -e "${trigger_path}" || test -L "${trigger_path}"; then
    # The sentinel is derived fail-safe state.  A direct-write power loss may
    # leave any prefix up to 16 bytes, but only the exact private regular inode
    # can be consumed after the marker has durably carried triggered=true.
    test -f "${trigger_path}" && test ! -L "${trigger_path}"
    trigger_metadata="$(stat --format='%U:%G:%a:%h:%s' -- "${trigger_path}")"
    [[ "${trigger_metadata}" =~ ^root:root:600:1:([0-9]|1[0-6])$ ]]
    test "${marker_was_triggered}" = true || test "${continuity_valid}" = false || test "${previously_disarmed}" = true
    rm -- "${trigger_path}"
    sync "$(dirname -- "${trigger_path}")"
  fi
done
test ! -e "${marker}"
test ! -e "${receipt}"
test ! -e "${control_trigger}" && test ! -L "${control_trigger}"
test ! -e "${runtime_trigger}" && test ! -L "${runtime_trigger}"
printf '%s\n' "${continuity_valid}"
REMOTE
)" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  [[ "${continuity}" == true || "${continuity}" == false ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  jq --null-input --compact-output --sort-keys --argjson continuity "${continuity}" \
    '{containment:{markerComplete:true,watchdogDisarmed:true},watchdog:{disarmed:true,failSafeContained:$continuity,markerComplete:true}}'
}

# REFUNDDESK_EDGE_CANONICAL_SNAPSHOT_HELPER_BEGIN
snapshot_canonical_json_file() {
  local source="$1" destination="$2" maximum_bytes="$3"
  python3 - "${source}" "${destination}" "${maximum_bytes}" <<'PY'
import json
import ctypes
import errno
import os
import re
import secrets
import stat
import sys
import time

source, destination, maximum_text = sys.argv[1:]
maximum = int(maximum_text)
if maximum < 2 or maximum > 2_097_152:
    raise SystemExit(1)

def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result

def validate_canonical(data):
    try:
        text = data.decode("utf-8")
        document = json.loads(text, object_pairs_hook=reject_duplicates)
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        raise SystemExit(1)
    canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    if canonical != data:
        raise SystemExit(1)

def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def rename_noreplace(source_path, destination_path):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise SystemExit(1)
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        -100,
        os.fsencode(source_path),
        -100,
        os.fsencode(destination_path),
        1,
    )
    if result != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise FileExistsError(error, os.strerror(error), destination_path)
        raise OSError(error, os.strerror(error), destination_path)

def read_path_once(path, expected_mode, require_path_identity):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        path_before = os.lstat(path)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(1)
        if before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) != expected_mode or before.st_nlink != 1:
            raise SystemExit(1)
        if require_path_identity and (path_before.st_dev, path_before.st_ino) != (before.st_dev, before.st_ino):
            raise SystemExit(1)
        if before.st_size < 2 or before.st_size > maximum:
            raise SystemExit(1)
        if (
            os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_FINAL_POSTFLIGHT_SNAPSHOT_DELAY") == "1"
            or os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_CHECKPOINT_SNAPSHOT_DELAY") == "1"
        ):
            sync_path = os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_CANONICAL_SNAPSHOT_READ_SYNC")
            if sync_path:
                sync_descriptor = os.open(sync_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.fsync(sync_descriptor)
                os.close(sync_descriptor)
            time.sleep(0.2)
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(descriptor, min(8192, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(descriptor)
        path_after = os.lstat(path)
        identity_before = (
            before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
            before.st_ctime_ns, before.st_mode, before.st_uid, before.st_gid, before.st_nlink,
        )
        identity_after = (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
            after.st_ctime_ns, after.st_mode, after.st_uid, after.st_gid, after.st_nlink,
        )
        if identity_before != identity_after:
            raise SystemExit(1)
        if require_path_identity and (path_after.st_dev, path_after.st_ino) != (after.st_dev, after.st_ino):
            raise SystemExit(1)
        if len(data) != before.st_size or len(data) > maximum:
            raise SystemExit(1)
        return bytes(data)
    finally:
        os.close(descriptor)

directory = os.path.dirname(destination)
destination_name = os.path.basename(destination)
if not directory or not destination_name or destination_name in (".", ".."):
    raise SystemExit(1)
pending_pattern = re.compile(
    rf"^\.{re.escape(destination_name)}\.[1-9][0-9]*\.[0-9a-f]{{16}}\.pending$"
)

def snapshot_pending_paths():
    matches = []
    entry_count = 0
    with os.scandir(directory) as entries:
        for entry in entries:
            entry_count += 1
            if entry_count > 256:
                raise SystemExit(1)
            if pending_pattern.fullmatch(entry.name):
                matches.append(os.path.join(directory, entry.name))
                if len(matches) > 2:
                    raise SystemExit(1)
    return matches

def recover_snapshot_publication():
    pending_paths = snapshot_pending_paths()
    if os.path.lexists(destination):
        destination_stat = os.lstat(destination)
        if (
            not stat.S_ISREG(destination_stat.st_mode)
            or destination_stat.st_uid != os.geteuid()
            or stat.S_IMODE(destination_stat.st_mode) != 0o400
        ):
            raise SystemExit(1)
        if destination_stat.st_nlink == 1:
            if pending_paths:
                raise SystemExit(1)
            return
        if destination_stat.st_nlink != 2 or len(pending_paths) != 1:
            raise SystemExit(1)
        pending_stat = os.lstat(pending_paths[0])
        if (
            not stat.S_ISREG(pending_stat.st_mode)
            or pending_stat.st_uid != os.geteuid()
            or stat.S_IMODE(pending_stat.st_mode) != 0o400
            or pending_stat.st_nlink != 2
            or (pending_stat.st_dev, pending_stat.st_ino)
            != (destination_stat.st_dev, destination_stat.st_ino)
        ):
            raise SystemExit(1)
        os.unlink(pending_paths[0])
        fsync_directory(directory)
        repaired_stat = os.lstat(destination)
        if (
            repaired_stat.st_nlink != 1
            or (repaired_stat.st_dev, repaired_stat.st_ino)
            != (destination_stat.st_dev, destination_stat.st_ino)
        ):
            raise SystemExit(1)
        return
    if len(pending_paths) > 1:
        raise SystemExit(1)
    if len(pending_paths) == 1:
        recovered = read_path_once(pending_paths[0], 0o400, True)
        validate_canonical(recovered)
        try:
            rename_noreplace(pending_paths[0], destination)
        except FileExistsError:
            raise SystemExit(1)
        fsync_directory(directory)
        published = read_path_once(destination, 0o400, True)
        if published != recovered:
            raise SystemExit(1)

recover_snapshot_publication()

if os.path.lexists(destination):
    snapshot = read_path_once(destination, 0o400, True)
    validate_canonical(snapshot)
    if os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_CANONICAL_SNAPSHOT_OUTPUT_DELAY") == "1":
        sync_path = os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_CANONICAL_SNAPSHOT_OUTPUT_SYNC")
        if sync_path:
            sync_descriptor = os.open(sync_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.fsync(sync_descriptor)
            os.close(sync_descriptor)
        time.sleep(0.2)
    offset = 0
    while offset < len(snapshot):
        written = os.write(1, snapshot[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written
    raise SystemExit(0)

data = read_path_once(source, 0o600, True)
validate_canonical(data)
pending = os.path.join(
    directory,
    f".{destination_name}.{os.getpid()}.{secrets.token_hex(8)}.pending",
)
output = -1
published = False
try:
    output = os.open(
        pending,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        0o400,
    )
    offset = 0
    while offset < len(data):
        written = os.write(output, data[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written
    os.fchmod(output, 0o400)
    os.fsync(output)
    os.close(output)
    output = -1
    # Make the fully written pending directory entry durable before the
    # no-replace rename. A power loss may then leave either the recoverable
    # pending name or the published destination, never force a mutable-source
    # fallback merely because the pending entry was not persisted.
    fsync_directory(directory)
    try:
        rename_noreplace(pending, destination)
    except FileExistsError:
        raise SystemExit(1)
    published = True
    fsync_directory(directory)
finally:
    if output >= 0:
        os.close(output)
    try:
        os.unlink(pending)
        fsync_directory(directory)
    except FileNotFoundError:
        pass
if not published:
    raise SystemExit(1)
if os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_CANONICAL_SNAPSHOT_OUTPUT_DELAY") == "1":
    sync_path = os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_CANONICAL_SNAPSHOT_OUTPUT_SYNC")
    if sync_path:
        sync_descriptor = os.open(sync_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.fsync(sync_descriptor)
        os.close(sync_descriptor)
    time.sleep(0.2)
offset = 0
while offset < len(data):
    written = os.write(1, data[offset:])
    if written <= 0:
        raise OSError("short write")
    offset += written
PY
}
# REFUNDDESK_EDGE_CANONICAL_SNAPSHOT_HELPER_END

final_postflight_request_clock_matches_window() {
  local expected_boot_sha="$1"
  local expected_closed_boottime_ms="$2"
  local watchdog_was_armed="$3"
  local request_boot_sha="$4"
  local requested_boottime_ms="$5"
  [[ "${watchdog_was_armed}" == true || "${watchdog_was_armed}" == false ]] || return 1
  [[ "${request_boot_sha}" =~ ^[0-9a-f]{64}$ && "${requested_boottime_ms}" =~ ^[0-9]+$ ]] || return 1
  if [[ "${watchdog_was_armed}" == true ]]; then
    [[ "${expected_boot_sha}" =~ ^[0-9a-f]{64}$ && "${expected_closed_boottime_ms}" =~ ^[0-9]+$ ]] || return 1
    [[ "${request_boot_sha}" == "${expected_boot_sha}" ]] || return 1
    # The request is issued after AWS closure and the durable monotonic stop
    # observation.  Requiring that stronger boundary also proves it is after
    # the ingress-open instant on the same boot.
    (( requested_boottime_ms >= expected_closed_boottime_ms )) || return 1
  else
    [[ -z "${expected_boot_sha}" && -z "${expected_closed_boottime_ms}" ]] || return 1
  fi
}

production_final_postflight() {
  local request="${OPERATION_ROOT}/final-postflight-request.json"
  local request_pending="${OPERATION_ROOT}/.final-postflight-request.pending"
  local result="${OPERATION_ROOT}/final-postflight-capture.json"
  local result_snapshot="${OPERATION_ROOT}/final-postflight-capture.snapshot.json"
  local requested_at now deadline_epoch now_epoch node_executable git_executable git_sha evidence_sha validation_sha final_caddy_sha
  local result_bytes validation_output postflight_validation_output remote_bytes remote_nonce remote_sha
  local request_clock request_boot_sha requested_boottime_ms completion_clock completion_boot_sha completion_boottime_ms captured_at captured_epoch
  local expected_boot_sha expected_closed_boottime_ms watchdog_was_armed
  local postflight_wait_started_seconds
  expected_boot_sha="$(jq --raw-output '.watchdog.bootIdSha256 // empty' "${FACTS_FILE}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  expected_closed_boottime_ms="$(jq --raw-output '.watchdog.closedBoottimeMilliseconds // empty' "${FACTS_FILE}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  watchdog_was_armed="$(jq --raw-output '(.intents.watchdogArmAttempted == true or .mutations.watchdogArms > 0)' "${FACTS_FILE}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  # Recover only the deterministic pending request authority. A partial
  # pending file was never visible to the external observer and is safe to
  # discard after exact inode checks; a complete canonical pending is promoted
  # with RENAME_NOREPLACE. The public pathname is therefore never partial.
  python3 - "${request}" "${request_pending}" "${EXPECTED_REVISION}" "${NONCE}" <<'PY_REQUEST_RECOVER' || {
import ctypes
import errno
import json
import os
import stat
import sys

request, pending, revision, nonce = sys.argv[1:]
expected_uid = os.geteuid()

def fsync_directory():
    descriptor = os.open(os.path.dirname(request), os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def controlled(path):
    info = os.lstat(path)
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == expected_uid
        and stat.S_IMODE(info.st_mode) == 0o600
        and info.st_nlink == 1
        and info.st_size <= 4096
    )

def canonical_pending():
    if not controlled(pending):
        return False
    raw = open(pending, "rb").read()
    try:
        document = json.loads(raw.decode("ascii"))
    except Exception:
        return False
    canonical = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
    return (
        raw == canonical
        and set(document) == {
            "expectedRevision", "kind", "nonce", "requestBootIdSha256",
            "requestedAt", "requestedBoottimeMilliseconds", "schemaVersion",
        }
        and document.get("schemaVersion") == 1
        and document.get("kind") == "refunddesk.edge-window-final-postflight-request"
        and document.get("expectedRevision") == revision
        and document.get("nonce") == nonce
    )

def rename_noreplace():
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "renameat2", None)
    if function is None:
        raise SystemExit(1)
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(-100, os.fsencode(pending), -100, os.fsencode(request), 1) != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise SystemExit(1)
        raise OSError(error, os.strerror(error))

if os.path.lexists(request):
    if os.path.lexists(pending):
        if not controlled(pending):
            raise SystemExit(1)
        os.unlink(pending)
        fsync_directory()
elif os.path.lexists(pending):
    if canonical_pending():
        fsync_directory()
        rename_noreplace()
        fsync_directory()
    elif controlled(pending):
        os.unlink(pending)
        fsync_directory()
    else:
        raise SystemExit(1)
PY_REQUEST_RECOVER
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  if [[ -e "${request}" ]]; then
    controlled_file "${request}" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    jq --exit-status --arg revision "${EXPECTED_REVISION}" --arg nonce "${NONCE}" '
      type == "object"
      and keys == ["expectedRevision","kind","nonce","requestBootIdSha256","requestedAt","requestedBoottimeMilliseconds","schemaVersion"]
      and .schemaVersion == 1 and .kind == "refunddesk.edge-window-final-postflight-request"
      and .expectedRevision == $revision and .nonce == $nonce
      and (.requestBootIdSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.requestedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and (.requestedBoottimeMilliseconds | type == "number" and floor == . and . >= 0)
    ' "${request}" >/dev/null || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    [[ "$(jq --compact-output --sort-keys . "${request}")" == "$(tr -d '\n' <"${request}")" ]] || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    requested_at="$(jq --raw-output '.requestedAt' "${request}")"
    request_boot_sha="$(jq --raw-output '.requestBootIdSha256' "${request}")"
    requested_boottime_ms="$(jq --raw-output '.requestedBoottimeMilliseconds' "${request}")"
    if ! final_postflight_request_clock_matches_window \
      "${expected_boot_sha}" "${expected_closed_boottime_ms}" "${watchdog_was_armed}" \
      "${request_boot_sha}" "${requested_boottime_ms}"; then
      production_error FINAL_CONTAINMENT_INVALID
      return
    fi
  else
    [[ ! -L "${request}" && ! -e "${result}" && ! -L "${result}" ]] || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    requested_at="$(timestamp_now)" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    request_clock="$(ssh_command "sudo bash -seu" <<'REMOTE_CLOCK'
set +x
exec 2>/dev/null
IFS= read -r boot </proc/sys/kernel/random/boot_id
boot_sha="$(printf '%s' "${boot}" | sha256sum | cut -d ' ' -f 1)"
now_ms="$(awk '{printf "%.0f\n", $1 * 1000}' /proc/uptime)"
jq --null-input --compact-output --sort-keys --arg bootSha "${boot_sha}" --argjson now "${now_ms}" \
  '{requestBootIdSha256:$bootSha,requestedBoottimeMilliseconds:$now}'
REMOTE_CLOCK
)" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    jq --exit-status '
      type == "object"
      and keys == ["requestBootIdSha256","requestedBoottimeMilliseconds"]
      and (.requestBootIdSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.requestedBoottimeMilliseconds | type == "number" and floor == . and . >= 0)
    ' <<<"${request_clock}" >/dev/null || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    request_boot_sha="$(jq --raw-output '.requestBootIdSha256' <<<"${request_clock}")"
    requested_boottime_ms="$(jq --raw-output '.requestedBoottimeMilliseconds' <<<"${request_clock}")"
    if ! final_postflight_request_clock_matches_window \
      "${expected_boot_sha}" "${expected_closed_boottime_ms}" "${watchdog_was_armed}" \
      "${request_boot_sha}" "${requested_boottime_ms}"; then
      production_error FINAL_CONTAINMENT_INVALID
      return
    fi
    python3 - "${request}" "${request_pending}" "${EXPECTED_REVISION}" "${NONCE}" "${requested_at}" "${request_boot_sha}" "${requested_boottime_ms}" <<'PY' || {
import ctypes
import errno
import json
import os
import signal
import sys

path, pending, revision, nonce, requested_at, request_boot_sha, requested_boottime_ms = sys.argv[1:]
document = {
    "expectedRevision": revision,
    "kind": "refunddesk.edge-window-final-postflight-request",
    "nonce": nonce,
    "requestBootIdSha256": request_boot_sha,
    "requestedAt": requested_at,
    "requestedBoottimeMilliseconds": int(requested_boottime_ms),
    "schemaVersion": 1,
}
data = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0), 0o600)
try:
    offset = 0
    while offset < len(data):
        chunk = data[offset:]
        if os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_FINAL_REQUEST_CRASH") == "mid-write":
            chunk = chunk[: max(1, len(chunk) // 2)]
        written = os.write(descriptor, chunk)
        if written <= 0:
            raise OSError("short write")
        offset += written
        if os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_FINAL_REQUEST_CRASH") == "mid-write":
            os.fsync(descriptor)
            os.kill(os.getppid(), signal.SIGKILL)
            raise SystemExit(99)
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
directory = os.open(os.path.dirname(path), os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)
if os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_FINAL_REQUEST_CRASH") == "pre-rename":
    os.kill(os.getppid(), signal.SIGKILL)
    raise SystemExit(99)
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    raise SystemExit(1)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
if renameat2(-100, os.fsencode(pending), -100, os.fsencode(path), 1) != 0:
    error = ctypes.get_errno()
    if error in {errno.EEXIST, errno.ENOSYS, errno.EINVAL}:
        raise SystemExit(1)
    raise OSError(error, os.strerror(error))
directory = os.open(os.path.dirname(path), os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)
if os.environ.get("REFUNDDESK_EDGE_WINDOW_TEST_FINAL_REQUEST_CRASH") == "post-rename":
    os.kill(os.getppid(), signal.SIGKILL)
    raise SystemExit(99)
PY
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
  fi
  deadline_epoch=$(( $(timestamp_epoch "${requested_at}") + FINAL_POSTFLIGHT_WAIT_SECONDS ))
  postflight_wait_started_seconds="${SECONDS}"
  while [[ ! -e "${result}" && ! -e "${result_snapshot}" ]]; do
    (( SECONDS - postflight_wait_started_seconds <= FINAL_POSTFLIGHT_WAIT_SECONDS )) || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    now="$(timestamp_now)" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    now_epoch="$(timestamp_epoch "${now}")" || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    (( now_epoch <= deadline_epoch )) || {
      production_error FINAL_CONTAINMENT_INVALID
      return
    }
    sleep 1
  done
  result_bytes="$(snapshot_canonical_json_file "${result}" "${result_snapshot}" 131072)" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  # The 0400 snapshot is the durable capture identity for this request. Keep it
  # until terminal volume GC: after a process death every retry must consume
  # these exact bytes and must never fall back to a mutable replacement at the
  # result pathname. snapshot_canonical_json_file prefers and revalidates an
  # existing snapshot before it considers the source.
  [[ -n "${result_bytes}" ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
    "${REFUNDDESK_EDGE_WINDOW_TEST_FINAL_POSTFLIGHT_CONSUMER_DELAY:-}" == "1" ]]; then
    sleep 0.2
  fi
  now="$(timestamp_now)" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  now_epoch="$(timestamp_epoch "${now}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  (( SECONDS - postflight_wait_started_seconds <= FINAL_POSTFLIGHT_WAIT_SECONDS && now_epoch <= deadline_epoch )) || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  captured_at="$(jq --raw-output '.capturedAt // empty' <<<"${result_bytes}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  captured_epoch="$(timestamp_epoch "${captured_at}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  (( captured_epoch <= deadline_epoch )) || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  completion_clock="$(ssh_command "sudo bash -seu" <<'REMOTE_CLOCK'
set +x
exec 2>/dev/null
IFS= read -r boot </proc/sys/kernel/random/boot_id
boot_sha="$(printf '%s' "${boot}" | sha256sum | cut -d ' ' -f 1)"
now_ms="$(awk '{printf "%.0f\n", $1 * 1000}' /proc/uptime)"
jq --null-input --compact-output --sort-keys --arg bootSha "${boot_sha}" --argjson now "${now_ms}" \
  '{completionBootIdSha256:$bootSha,completionBoottimeMilliseconds:$now}'
REMOTE_CLOCK
)" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  completion_boot_sha="$(jq --raw-output '.completionBootIdSha256 // empty' <<<"${completion_clock}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  completion_boottime_ms="$(jq --raw-output '.completionBoottimeMilliseconds // empty' <<<"${completion_clock}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  if [[ "${completion_boot_sha}" != "${request_boot_sha}" || ! "${requested_boottime_ms}" =~ ^[0-9]+$ || ! "${completion_boottime_ms}" =~ ^[0-9]+$ ]] ||
    { [[ "${watchdog_was_armed}" == true ]] && [[ "${completion_boot_sha}" != "${expected_boot_sha}" ]]; } ||
    (( completion_boottime_ms < requested_boottime_ms || completion_boottime_ms - requested_boottime_ms > FINAL_POSTFLIGHT_WAIT_SECONDS * 1000 )); then
    production_error FINAL_CONTAINMENT_INVALID
    return
  fi
  node_executable="$(transport_value nodeExecutable)"
  validation_output="$(printf '%s\n' "${result_bytes}" | bounded_node_validation 4096 "${node_executable}" scripts/validate-lightsail-incident-admission.mjs \
    --kind postflight \
    --expected-revision "${EXPECTED_REVISION}" \
    --now "${now}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  (( ${#validation_output} <= 4096 )) || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  [[ "$(jq --compact-output --sort-keys . <<<"${validation_output}")" == "${validation_output}" ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  jq --exit-status 'keys == ["code","result"] and .code == "PASS_POSTFLIGHT_VALID" and .result == "PASS"' \
    <<<"${validation_output}" >/dev/null || {
    production_error FINAL_CONTAINMENT_INVALID
      return
    }
  remote_bytes="$(jq --compact-output --sort-keys '.remote' <<<"${result_bytes}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  remote_nonce="$(jq --raw-output '.nonce // empty' <<<"${remote_bytes}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  [[ "${remote_nonce}" =~ ^[0-9a-f]{64}$ ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  git_executable="$(transport_value gitExecutable)"
  git_sha="$(transport_value gitSha256)"
  postflight_validation_output="$(printf '%s\n' "${remote_bytes}" | bounded_node_validation 524288 "${node_executable}" scripts/validate-lightsail-postflight.mjs \
    --expected-nonce "${remote_nonce}" \
    --process-exit-code 0 \
    --not-before "${requested_at}" \
    --not-after "${now}" \
    --repository /workspace \
    --git-executable "${git_executable}" \
    --expected-git-sha256 "${git_sha}" \
    --attested-workspace \
    --expected-revision "${EXPECTED_REVISION}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  (( ${#postflight_validation_output} <= 524288 )) || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  remote_sha="$(printf '%s\n' "${remote_bytes}" | sha256sum | cut -d ' ' -f 1)"
  jq --exit-status \
    --arg revision "${EXPECTED_REVISION}" \
    --arg remoteSha "${remote_sha}" \
    --argjson official "${postflight_validation_output}" '
      $official.kind == "refunddesk.lightsail.host-postflight.validation"
      and $official.result == "PASS" and $official.posture == "COHERENT_CONTAINED"
      and $official.remote == .remote
      and $official.provenance.repositoryHead == $revision
      and $official.provenance.revisionComposeVerified == true
      and .provenance.remoteDocumentSha256 == $remoteSha
      and $official.provenance.observer.sha256 == .provenance.observer.sha256
      and $official.provenance.schema.sha256 == .provenance.schema.sha256
      and $official.provenance.validator.sha256 == .provenance.validator.sha256
      and $official.provenance.wrapper.sha256 == .provenance.wrapper.sha256
    ' <<<"${result_bytes}" >/dev/null || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  jq --exit-status --arg closedAt "${CLOSED_AT}" --arg requestedAt "${requested_at}" --arg revision "${EXPECTED_REVISION}" '
    .schemaVersion == 1
    and .kind == "refunddesk.lightsail.host-postflight.capture"
    and .result == "PASS" and .posture == "COHERENT_CONTAINED"
    and .admission == "ADMISSIBLE_READ_ONLY"
    and .capturedAt >= $requestedAt
    and .capturedAt >= $closedAt
    and .remote.result == "PASS" and .remote.code == "PASS_CONTAINED"
    and .remote.posture == "COHERENT_CONTAINED"
    and ([.remote.containment[],.remote.financial[]] | all)
    and .awsControlPlane.firewallClosedBefore == true
    and .awsControlPlane.firewallClosedAfter == true
    and .awsControlPlane.firewallUnchanged == true
    and .provenance.repositoryHead == $revision
    and .provenance.revisionComposeVerified == true
    and .provenance.transportInputsPinned == true
    and .provenance.fixtureOnly == false
    and ([.redaction[]] | all(. == false))
  ' <<<"${result_bytes}" >/dev/null || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  final_caddy_sha="$(jq --raw-output '.topology.finalCaddyContainerIdSha256' "${FACTS_FILE}")" || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  [[ "${final_caddy_sha}" =~ ^[0-9a-f]{64}$ && "${final_caddy_sha}" != "$(printf '0%.0s' {1..64})" ]] || {
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  python3 - "${CONTROL_FILE}" "${final_caddy_sha}" 3<<<"${result_bytes}" <<'PY' || {
# REFUNDDESK_EDGE_FINAL_POSTFLIGHT_BINDING_PY_BEGIN
import hashlib
import json
import sys

control_path, expected_final_caddy = sys.argv[1:]
with open(3, "rb", closefd=False) as stream:
    observed = json.load(stream)
with open(control_path, "rb") as stream:
    control = json.load(stream)

baseline = control["postIncidentBaseline"]
count_keys = (
    "activeFinancialJobs",
    "auditEvents",
    "mutationReceipts",
    "refundExecutionAttempts",
    "refundExecutions",
    "refundRequests",
    "unreleasedPaymentGuards",
    "webhookReceipts",
)
database_names = {
    "activeFinancialJobs": "activeFinancialJobs",
    "auditEvents": "auditEvents",
    "mutationReceipts": "apiMutationReceipts",
    "refundExecutionAttempts": "refundExecutionAttempts",
    "refundExecutions": "refundExecutions",
    "refundRequests": "refundRequests",
    "unreleasedPaymentGuards": "unreleasedPaymentGuards",
    "webhookReceipts": "webhookReceipts",
}
expected_hashes = {
    "postgres": control["admission"]["promotionPostgresContainerIdSha256"],
    "verifier": control["admission"]["promotionVerifierContainerIdSha256"],
    "web": control["admission"]["promotionWebContainerIdSha256"],
    "worker": control["admission"]["promotionWorkerContainerIdSha256"],
}
expected_system = control["admission"]["promotionDatabaseSystemIdentifierSha256"]
expected_services = set(expected_hashes) | {"caddy"}
final_caddy_identifier = None

for capture_name in ("a", "b"):
    capture = observed["remote"]["captures"][capture_name]
    database = capture["database"]
    projection = {key: database[database_names[key]] for key in count_keys}
    if any(type(value) is not int or value < 0 for value in projection.values()):
        raise SystemExit(1)
    if projection != {key: baseline[key] for key in count_keys}:
        raise SystemExit(1)
    encoded = json.dumps(projection, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if hashlib.sha256(encoded).hexdigest() != baseline["snapshotSha256"]:
        raise SystemExit(1)
    if any(database[name] != 0 for name in (
        "activeWorkflows", "liveInstallations", "liveTenants", "preparedTransactions"
    )):
        raise SystemExit(1)
    system_identifier = database["systemIdentifier"]
    if not isinstance(system_identifier, str) or hashlib.sha256(system_identifier.encode("utf-8")).hexdigest() != expected_system:
        raise SystemExit(1)
    containers = capture["containers"]
    if not isinstance(containers, list) or len(containers) != 5:
        raise SystemExit(1)
    ids = {}
    raw_ids = {}
    for container in containers:
        service = container.get("service")
        identifier = container.get("containerId")
        if service in ids or service not in expected_services or not isinstance(identifier, str):
            raise SystemExit(1)
        if len(identifier) != 64 or any(character not in "0123456789abcdef" for character in identifier):
            raise SystemExit(1)
        ids[service] = hashlib.sha256(identifier.encode("utf-8")).hexdigest()
        raw_ids[service] = identifier
    if set(ids) != expected_services or len(set(raw_ids.values())) != 5:
        raise SystemExit(1)
    if any(ids[service] != expected_hash for service, expected_hash in expected_hashes.items()):
        raise SystemExit(1)
    if final_caddy_identifier is None:
        final_caddy_identifier = raw_ids["caddy"]
    elif raw_ids["caddy"] != final_caddy_identifier:
        raise SystemExit(1)
    if capture["identity"].get("releaseEnvironmentWorkerRuntimeMode") != "INCIDENT_ADMISSION":
        raise SystemExit(1)
    worker = next(container for container in containers if container["service"] == "worker")
    if worker.get("effectiveWorkerRuntimeMode") != "INCIDENT_ADMISSION":
        raise SystemExit(1)
if final_caddy_identifier is None:
    raise SystemExit(1)
if hashlib.sha256(final_caddy_identifier.encode("utf-8")).hexdigest() != expected_final_caddy:
    raise SystemExit(1)
# REFUNDDESK_EDGE_FINAL_POSTFLIGHT_BINDING_PY_END
PY
    production_error FINAL_CONTAINMENT_INVALID
    return
  }
  evidence_sha="$(printf '%s\n' "${result_bytes}" | sha256sum | cut -d ' ' -f 1)"
  validation_sha="$(printf '%s\n' "${postflight_validation_output}" | sha256sum | cut -d ' ' -f 1)"
  jq --null-input --compact-output --sort-keys \
    --arg capturedAt "$(jq --raw-output '.capturedAt' <<<"${result_bytes}")" \
    --arg evidenceSha256 "${evidence_sha}" --arg validationSha256 "${validation_sha}" \
    --arg validUntil "$(jq --raw-output '.validUntil' <<<"${result_bytes}")" \
    '{containment:{coreHealthy:true,finalPostflightContained:true,finalPostflightPass:true,financialQuiescent:true,financialStable:true,liveDisabled:true},probes:{finalPostflight:{capturedAt:$capturedAt,contained:true,evidenceSha256:$evidenceSha256,officialValidator:true,revisionMatches:true,validationSha256:$validationSha256,validUntil:$validUntil}}}'
}

# REFUNDDESK_EDGE_BOUNDED_NODE_VALIDATION_BEGIN
bounded_node_validation() {
  local maximum_bytes="$1" timeout_seconds=30
  shift
  [[ "${maximum_bytes}" =~ ^[1-9][0-9]*$ ]] || return "${EXIT_USAGE}"
  (( maximum_bytes <= 524288 )) || return "${EXIT_USAGE}"
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
    "${REFUNDDESK_EDGE_WINDOW_TEST_NODE_VALIDATION_TIMEOUT_SECONDS:-}" =~ ^[12]$ ]]; then
    timeout_seconds="${REFUNDDESK_EDGE_WINDOW_TEST_NODE_VALIDATION_TIMEOUT_SECONDS}"
  fi
  timeout --signal=TERM --kill-after=1s "${timeout_seconds}s" "$@" |
    head --bytes "$((maximum_bytes + 1))"
}
# REFUNDDESK_EDGE_BOUNDED_NODE_VALIDATION_END

production_operation() {
  local operation="$1"
  shift
  case "${operation}" in
    aws-baseline) production_aws_baseline ;;
    counts-before) production_counts before ;;
    counts-during) production_counts during ;;
    counts-after) production_counts after ;;
    prefix-fetch) production_prefix_fetch ;;
    origin-bind) production_origin_bind ;;
    origin-unbind) production_origin_unbind ;;
    origin-status) production_origin_status ;;
    origin-secret-scan) production_origin_secret_scan ;;
    origin-gc) production_origin_gc ;;
    firewall-baseline) production_firewall_baseline ;;
    firewall-open) production_firewall_open ;;
    firewall-close) production_firewall_close ;;
    host-lease-acquire) production_host_lease_acquire ;;
    host-lease-status) production_host_lease_status ;;
    host-lease-complete) production_host_lease_complete "$@" ;;
    host-lease-cleanup-status) production_host_lease_cleanup_status ;;
    host-lease-finalization-status) production_host_lease_finalization_status "$@" ;;
    host-lease-release) production_host_lease_release "$@" ;;
    watchdog-arm) production_watchdog_arm ;;
    window-clock-stop) production_window_clock_stop ;;
    window-clock-open-guard) production_window_clock_open_guard ;;
    window-boot-guard) production_window_boot_guard ;;
    caddy-start) production_caddy_start ;;
    local-probe) production_local_probe ;;
    public-health) production_public_health ;;
    checkpoint-publish) printf '%s\n' '{}' ;;
    host-contain) production_host_contain ;;
    watchdog-disarm) production_watchdog_disarm "$@" ;;
    final-postflight) production_final_postflight ;;
    *) production_error TOOL_UNAVAILABLE ;;
  esac
}

bounded_operation() {
  local operation="$1" output timeout_seconds="${ADAPTER_OPERATION_TIMEOUT_SECONDS}"
  shift
  if [[ -n "${COMMAND_ADAPTER}" ]]; then
    timeout_seconds="$(effect_timeout_seconds "${ADAPTER_OPERATION_TIMEOUT_SECONDS}" 1)" || return 124
    output="$({ timeout --signal=TERM --kill-after=1s "${timeout_seconds}s" "${COMMAND_ADAPTER}" "${operation}" "$@" | head --bytes "$((MAX_FRAGMENT_BYTES + 1))"; })" ||
      return $?
  else
    output="$({ production_operation "${operation}" "$@" | head --bytes "$((MAX_FRAGMENT_BYTES + 1))"; })" ||
      return $?
  fi
  (( ${#output} <= MAX_FRAGMENT_BYTES )) || return "${EXIT_FAIL}"
  [[ -n "${output}" ]] || output='{}'
  jq --exit-status --compact-output --sort-keys 'type == "object"' <<<"${output}" >/dev/null ||
    return "${EXIT_FAIL}"
  [[ "$(jq --compact-output --sort-keys . <<<"${output}")" == "${output}" ]] || return "${EXIT_FAIL}"
  printf '%s' "${output}"
}

directory_controlled() {
  local path="$1" expected_uid metadata mode
  [[ -d "${path}" && ! -L "${path}" ]] || return 1
  expected_uid=0
  [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ||
    "${REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-}" == "1" ]] && expected_uid="$(id -u)"
  metadata="$(stat --format='%u:%a' -- "${path}")" || return 1
  [[ "${metadata}" =~ ^${expected_uid}:([0-7]{3,4})$ ]] || return 1
  mode="${BASH_REMATCH[1]}"
  (( (8#${mode} & 022) == 0 ))
}

controlled_file() {
  local path="$1" expected_uid metadata
  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  expected_uid=0
  [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ||
    "${REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-}" == "1" ]] && expected_uid="$(id -u)"
  metadata="$(stat --format='%u:%a:%h' -- "${path}")" || return 1
  [[ "${metadata}" == "${expected_uid}:600:1" ]]
}

controlled_file_bytes_once() {
  local path="$1" maximum_bytes="$2" expected_uid=0 expected_gid=0
  [[ "${maximum_bytes}" =~ ^[1-9][0-9]*$ ]] || return 1
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ||
    "${REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-}" == "1" ]]; then
    expected_uid="$(id -u)" || return 1
    expected_gid="$(id -g)" || return 1
  fi
  python3 - "${path}" "${expected_uid}" "${expected_gid}" "${maximum_bytes}" <<'PY'
# REFUNDDESK_EDGE_CONTROLLED_FILE_BYTES_ONCE_PY_BEGIN
import os
import stat
import sys

path, expected_uid, expected_gid, maximum_bytes = sys.argv[1:]
expected_uid = int(expected_uid)
expected_gid = int(expected_gid)
maximum_bytes = int(maximum_bytes)
before = os.lstat(path)
if (
    not stat.S_ISREG(before.st_mode)
    or before.st_uid != expected_uid
    or before.st_gid != expected_gid
    or stat.S_IMODE(before.st_mode) != 0o600
    or before.st_nlink != 1
    or before.st_size <= 0
    or before.st_size > maximum_bytes
):
    raise SystemExit(1)
descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
try:
    opened = os.fstat(descriptor)
    if (
        opened.st_dev,
        opened.st_ino,
        opened.st_uid,
        opened.st_gid,
        stat.S_IMODE(opened.st_mode),
        opened.st_nlink,
    ) != (
        before.st_dev,
        before.st_ino,
        before.st_uid,
        before.st_gid,
        stat.S_IMODE(before.st_mode),
        before.st_nlink,
    ):
        raise SystemExit(1)
    chunks = []
    total = 0
    while True:
        chunk = os.read(descriptor, min(65_536, maximum_bytes + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > maximum_bytes:
            raise SystemExit(1)
    after = os.fstat(descriptor)
finally:
    os.close(descriptor)
after_path = os.lstat(path)
if (
    total != opened.st_size
    or (
        after.st_dev,
        after.st_ino,
        after.st_uid,
        after.st_gid,
        stat.S_IMODE(after.st_mode),
        after.st_nlink,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    )
    != (
        opened.st_dev,
        opened.st_ino,
        opened.st_uid,
        opened.st_gid,
        stat.S_IMODE(opened.st_mode),
        opened.st_nlink,
        opened.st_size,
        opened.st_mtime_ns,
        opened.st_ctime_ns,
    )
    or (
        after_path.st_dev,
        after_path.st_ino,
        after_path.st_uid,
        after_path.st_gid,
        stat.S_IMODE(after_path.st_mode),
        after_path.st_nlink,
        after_path.st_size,
        after_path.st_mtime_ns,
        after_path.st_ctime_ns,
    )
    != (
        after.st_dev,
        after.st_ino,
        after.st_uid,
        after.st_gid,
        stat.S_IMODE(after.st_mode),
        after.st_nlink,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    )
):
    raise SystemExit(1)
raw = b"".join(chunks)
offset = 0
while offset < len(raw):
    written = os.write(1, raw[offset:])
    if written <= 0:
        raise OSError("short write")
    offset += written
# REFUNDDESK_EDGE_CONTROLLED_FILE_BYTES_ONCE_PY_END
PY
}

immutable_input_directory() {
  local path="$1"
  if [[ "${REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-}" != "1" ]]; then
    directory_controlled "${path}"
    return
  fi
  [[ -d "${path}" && ! -L "${path}" ]] || return 1
  [[ "$(stat --format='%u:%g:%a:%h' -- "${path}")" == "0:0:555:2" ]]
}

immutable_input_file() {
  local path="$1"
  if [[ "${REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-}" != "1" ]]; then
    controlled_file "${path}"
    return
  fi
  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  [[ "$(stat --format='%u:%g:%a:%h' -- "${path}")" == "0:0:444:1" ]]
}

durable_replace() {
  local target="$1" temporary="$2"
  chmod 600 "${temporary}" || return 1
  sync --file-system "${temporary}" 2>/dev/null || sync "${temporary}" || return 1
  mv --no-target-directory -- "${temporary}" "${target}" || return 1
  sync --file-system "$(dirname -- "${target}")" 2>/dev/null ||
    sync "$(dirname -- "${target}")" || return 1
}

write_run_marker() {
  local requested_state="$1" evidence_sha="${2:-}" facts_path="${3:-${FACTS_FILE}}" evidence_path="${4:-}" evidence_published="${5:-false}" temporary facts_sha evidence_json=null
  [[ -f "${facts_path}" && ! -L "${facts_path}" ]] || return 1
  facts_sha="$(jq --compact-output --sort-keys . "${facts_path}" | sha256sum | cut -d ' ' -f 1)" || return 1
  [[ "${facts_sha}" =~ ^[0-9a-f]{64}$ ]] || return 1
  if [[ -n "${evidence_sha}" ]]; then
    [[ "${evidence_published}" == true || "${evidence_published}" == false ]] || return 1
    [[ "${evidence_sha}" =~ ^[0-9a-f]{64}$ ]] || return 1
    if [[ "${evidence_sha}" == "${EVIDENCE_AUTHORITY_SHA}" && -n "${EVIDENCE_AUTHORITY_BYTES}" ]]; then
      # Once a candidate has been embedded, every later state transition uses
      # those in-memory journal-authority bytes. The evidence pathname is only
      # a derived copy and can neither replace nor suppress the authority.
      evidence_json="${EVIDENCE_AUTHORITY_BYTES}"
    else
      [[ -f "${evidence_path}" && ! -L "${evidence_path}" ]] || return 1
      evidence_json="$(jq --compact-output --sort-keys . "${evidence_path}")" || return 1
    fi
    [[ "$(printf '%s\n' "${evidence_json}" | sha256sum | cut -d ' ' -f 1)" == "${evidence_sha}" ]] || return 1
  else
    [[ "${evidence_published}" == false ]] || return 1
  fi
  temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-run.XXXXXXXXXX')" || return 1
  jq --null-input --compact-output --sort-keys \
    --slurpfile facts "${facts_path}" \
    --arg armedAt "${ARMED_AT}" \
    --arg closedAt "${CLOSED_AT}" \
    --arg deadlineAt "${DEADLINE_AT}" \
    --argjson evidence "${evidence_json}" \
    --argjson evidencePublished "${evidence_published}" \
    --arg evidenceSha256 "${evidence_sha}" \
    --arg expectedRevision "${EXPECTED_REVISION}" \
    --arg factsSha256 "${facts_sha}" \
    --arg nonce "${NONCE}" \
    --arg openedAt "${OPENED_AT}" \
    --argjson operationRemainingSecondsAtRunnerStart "${CONTROL_OPERATION_REMAINING_SECONDS}" \
    --arg operationStartedAt "${OPERATION_STARTED_AT}" \
    --arg operatorBootIdentifierSha256 "${CONTROL_OPERATOR_BOOT_IDENTIFIER_SHA256}" \
    --argjson operatorControlCalculatedMonotonicMilliseconds "${CONTROL_OPERATOR_CONTROL_CALCULATED_MONOTONIC_MILLISECONDS}" \
    --argjson operatorDeadlineMonotonicMilliseconds "${CONTROL_OPERATOR_DEADLINE_MONOTONIC_MILLISECONDS}" \
    --argjson operatorStartedMonotonicMilliseconds "${CONTROL_OPERATOR_STARTED_MONOTONIC_MILLISECONDS}" \
    --arg runnerBootIdentifierSha256 "${RUNNER_BOOT_IDENTIFIER_SHA256}" \
    --argjson runnerDeadlineBoottimeMilliseconds "${RUNNER_DEADLINE_BOOTTIME_MILLISECONDS}" \
    --argjson runnerStartedBoottimeMilliseconds "${RUNNER_STARTED_BOOTTIME_MILLISECONDS}" \
    --arg startedAt "${STARTED_AT}" \
    --arg state "${requested_state}" \
    '{armedAt:(if $armedAt == "" then null else $armedAt end),closedAt:(if $closedAt == "" then null else $closedAt end),deadlineAt:$deadlineAt,evidence:$evidence,evidencePublished:$evidencePublished,evidenceSha256:(if $evidenceSha256 == "" then null else $evidenceSha256 end),expectedRevision:$expectedRevision,facts:$facts[0],factsSha256:$factsSha256,kind:"refunddesk.edge-window-run",nonce:$nonce,openedAt:(if $openedAt == "" then null else $openedAt end),operationRemainingSecondsAtRunnerStart:$operationRemainingSecondsAtRunnerStart,operationStartedAt:$operationStartedAt,operatorBootIdentifierSha256:$operatorBootIdentifierSha256,operatorControlCalculatedMonotonicMilliseconds:$operatorControlCalculatedMonotonicMilliseconds,operatorDeadlineMonotonicMilliseconds:$operatorDeadlineMonotonicMilliseconds,operatorStartedMonotonicMilliseconds:$operatorStartedMonotonicMilliseconds,runnerBootIdentifierSha256:$runnerBootIdentifierSha256,runnerDeadlineBoottimeMilliseconds:$runnerDeadlineBoottimeMilliseconds,runnerStartedBoottimeMilliseconds:$runnerStartedBoottimeMilliseconds,schemaVersion:1,startedAt:$startedAt,state:$state}' \
    >"${temporary}" || return 1
  durable_replace "${RUN_MARKER}" "${temporary}" || return 1
  if [[ -n "${evidence_sha}" ]]; then
    EVIDENCE_AUTHORITY_SHA="${evidence_sha}"
    EVIDENCE_AUTHORITY_BYTES="${evidence_json}"
  else
    EVIDENCE_AUTHORITY_SHA=""
    EVIDENCE_AUTHORITY_BYTES=""
  fi
  STATE="${requested_state}"
}

commit_facts() {
  local candidate="$1" existing_evidence_sha="" existing_evidence_published=false evidence_temporary=""
  [[ -f "${candidate}" && ! -L "${candidate}" ]] || return 1
  # The journal is authoritative and is replaced first.  If power is lost
  # before the derived facts file is replaced, recovery reconstructs the
  # latter from the journal's embedded canonical facts object.
  existing_evidence_sha="$(jq --raw-output '.evidenceSha256 // empty' "${RUN_MARKER}" 2>/dev/null || true)"
  existing_evidence_published="$(jq --raw-output '.evidencePublished // false' "${RUN_MARKER}" 2>/dev/null || true)"
  if [[ "${existing_evidence_sha}" =~ ^[0-9a-f]{64}$ &&
    "${existing_evidence_sha}" == "${EVIDENCE_AUTHORITY_SHA}" &&
    -n "${EVIDENCE_AUTHORITY_BYTES}" && "${existing_evidence_published}" == true ]]; then
    # Facts refreshes after contained_verified must preserve the journal's
    # embedded evidence, not consult a same-UID-replaceable convenience path.
    # Repair that path from authority A before replacing the journal.
    evidence_temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-evidence-repair.XXXXXXXXXX')" ||
      return 1
    printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" >"${evidence_temporary}" || return 1
    chmod 600 "${evidence_temporary}" || return 1
    sync --file-system "${evidence_temporary}" 2>/dev/null || sync "${evidence_temporary}" ||
      return 1
    durable_replace "${EVIDENCE_FILE}" "${evidence_temporary}" || return 1
    write_run_marker "${STATE}" "${existing_evidence_sha}" "${candidate}" "${EVIDENCE_FILE}" true || return 1
  else
    write_run_marker "${STATE}" "" "${candidate}" || return 1
  fi
  durable_replace "${FACTS_FILE}" "${candidate}"
}

restore_run_journal() {
  local actual_facts_sha temporary
  controlled_file "${RUN_MARKER}" || return 1
  (( $(wc --bytes <"${RUN_MARKER}") <= 393216 )) || return 1
  [[ "$(jq --compact-output --sort-keys . "${RUN_MARKER}")" == "$(tr -d '\n' <"${RUN_MARKER}")" ]] || return 1
  jq --exit-status --arg nonce "${NONCE}" --arg revision "${EXPECTED_REVISION}" \
    --arg operatorBootIdentifierSha256 "${CONTROL_OPERATOR_BOOT_IDENTIFIER_SHA256}" \
    --argjson operatorControlCalculatedMonotonicMilliseconds "${CONTROL_OPERATOR_CONTROL_CALCULATED_MONOTONIC_MILLISECONDS}" \
    --argjson operatorDeadlineMonotonicMilliseconds "${CONTROL_OPERATOR_DEADLINE_MONOTONIC_MILLISECONDS}" \
    --argjson operatorStartedMonotonicMilliseconds "${CONTROL_OPERATOR_STARTED_MONOTONIC_MILLISECONDS}" \
    --argjson operationRemainingSecondsAtRunnerStart "${CONTROL_OPERATION_REMAINING_SECONDS}" '
    type == "object"
    and keys == ["armedAt","closedAt","deadlineAt","evidence","evidencePublished","evidenceSha256","expectedRevision","facts","factsSha256","kind","nonce","openedAt","operationRemainingSecondsAtRunnerStart","operationStartedAt","operatorBootIdentifierSha256","operatorControlCalculatedMonotonicMilliseconds","operatorDeadlineMonotonicMilliseconds","operatorStartedMonotonicMilliseconds","runnerBootIdentifierSha256","runnerDeadlineBoottimeMilliseconds","runnerStartedBoottimeMilliseconds","schemaVersion","startedAt","state"]
    and .schemaVersion == 1
    and .kind == "refunddesk.edge-window-run"
    and .nonce == $nonce
    and .expectedRevision == $revision
    and .operatorBootIdentifierSha256 == $operatorBootIdentifierSha256
    and .operatorControlCalculatedMonotonicMilliseconds == $operatorControlCalculatedMonotonicMilliseconds
    and .operatorDeadlineMonotonicMilliseconds == $operatorDeadlineMonotonicMilliseconds
    and .operatorStartedMonotonicMilliseconds == $operatorStartedMonotonicMilliseconds
    and .operationRemainingSecondsAtRunnerStart == $operationRemainingSecondsAtRunnerStart
    and (.operationStartedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and (.startedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and .startedAt >= .operationStartedAt
    and (.deadlineAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and ([.armedAt,.closedAt,.openedAt][] | . == null or (type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
    and ((.evidence == null and .evidenceSha256 == null and .evidencePublished == false) or
      ((.evidence | type == "object") and (.evidenceSha256 | type == "string" and test("^[0-9a-f]{64}$")) and (.evidencePublished | type == "boolean")))
    and (.facts | type == "object")
    and (.factsSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.runnerBootIdentifierSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.runnerStartedBoottimeMilliseconds | type == "number" and floor == . and . >= 0 and . <= 9007199254740991)
    and (.runnerDeadlineBoottimeMilliseconds | type == "number" and floor == . and . >= .runnerStartedBoottimeMilliseconds and . <= 9007199254740991)
    and (.runnerDeadlineBoottimeMilliseconds - .runnerStartedBoottimeMilliseconds <= $operationRemainingSecondsAtRunnerStart * 1000)
    and (.state | IN("prepared","origin_bound","watchdog_armed","ingress_open","functional_gate_passed","ingress_closed","contained_disarmed_pending_validation","contained_verified","complete","failed_closed"))
  ' "${RUN_MARKER}" >/dev/null || return 1
  actual_facts_sha="$(jq --compact-output --sort-keys '.facts' "${RUN_MARKER}" | sha256sum | cut -d ' ' -f 1)" || return 1
  [[ "${actual_facts_sha}" == "$(jq --raw-output '.factsSha256' "${RUN_MARKER}")" ]] || return 1
  if [[ "$(jq --raw-output '.evidenceSha256 // empty' "${RUN_MARKER}")" != "" ]]; then
    [[ "$(jq --compact-output --sort-keys '.evidence' "${RUN_MARKER}" | sha256sum | cut -d ' ' -f 1)" == "$(jq --raw-output '.evidenceSha256' "${RUN_MARKER}")" ]] || return 1
    EVIDENCE_AUTHORITY_SHA="$(jq --raw-output '.evidenceSha256' "${RUN_MARKER}")" || return 1
    EVIDENCE_AUTHORITY_BYTES="$(jq --compact-output --sort-keys '.evidence' "${RUN_MARKER}")" || return 1
    [[ "$(printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" | sha256sum | cut -d ' ' -f 1)" == "${EVIDENCE_AUTHORITY_SHA}" ]] || return 1
  else
    EVIDENCE_AUTHORITY_SHA=""
    EVIDENCE_AUTHORITY_BYTES=""
  fi
  temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-facts.XXXXXXXXXX')" || return 1
  jq --compact-output --sort-keys '.facts' "${RUN_MARKER}" >"${temporary}" || return 1
  durable_replace "${FACTS_FILE}" "${temporary}" || return 1
  OPERATION_STARTED_AT="$(jq --raw-output '.operationStartedAt' "${RUN_MARKER}")" || return 1
  [[ -n "${CONTROL_OPERATION_STARTED_AT}" && "${OPERATION_STARTED_AT}" == "${CONTROL_OPERATION_STARTED_AT}" ]] || return 1
  STARTED_AT="$(jq --raw-output '.startedAt' "${RUN_MARKER}")" || return 1
  RUNNER_BOOT_IDENTIFIER_SHA256="$(jq --raw-output '.runnerBootIdentifierSha256' "${RUN_MARKER}")" || return 1
  RUNNER_STARTED_BOOTTIME_MILLISECONDS="$(jq --raw-output '.runnerStartedBoottimeMilliseconds' "${RUN_MARKER}")" || return 1
  RUNNER_DEADLINE_BOOTTIME_MILLISECONDS="$(jq --raw-output '.runnerDeadlineBoottimeMilliseconds' "${RUN_MARKER}")" || return 1
  ARMED_AT="$(jq --raw-output '.armedAt // empty' "${RUN_MARKER}")" || return 1
  DEADLINE_AT="$(jq --raw-output '.deadlineAt' "${RUN_MARKER}")" || return 1
  OPENED_AT="$(jq --raw-output '.openedAt // empty' "${RUN_MARKER}")" || return 1
  CLOSED_AT="$(jq --raw-output '.closedAt // empty' "${RUN_MARKER}")" || return 1
  STATE="$(jq --raw-output '.state' "${RUN_MARKER}")" || return 1
  if runner_operation_clock_still_valid; then
    OPERATION_CLOCK_VALID=true
  else
    OPERATION_CLOCK_VALID=false
  fi
  if [[ -n "${ARMED_AT}" ]]; then
    EFFECTIVE_WINDOW_SECONDS=$(( $(timestamp_epoch "${DEADLINE_AT}") - $(timestamp_epoch "${ARMED_AT}") ))
    (( EFFECTIVE_WINDOW_SECONDS >= 30 && EFFECTIVE_WINDOW_SECONDS <= MAX_WINDOW_SECONDS )) || return 1
  else
    EFFECTIVE_WINDOW_SECONDS="${WINDOW_SECONDS}"
  fi
}

write_watchdog_marker() {
  local deadline_epoch watchdog_sha service_sha timer_sha temporary boot_id armed_boottime_ms deadline_boottime_ms
  local caddy_container_id worker_container_id
  deadline_epoch="$(timestamp_epoch "${DEADLINE_AT}")" || return 1
  watchdog_sha="$(jq --raw-output '.provenance.sources[] | select(.path == "deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh") | .sourceSha256' "${CONTROL_FILE}")" || return 1
  service_sha="$(jq --raw-output '.provenance.sources[] | select(.path == "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service") | .sourceSha256' "${CONTROL_FILE}")" || return 1
  timer_sha="$(jq --raw-output '.provenance.sources[] | select(.path == "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer") | .sourceSha256' "${CONTROL_FILE}")" || return 1
  [[ "${watchdog_sha}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${service_sha}" =~ ^[0-9a-f]{64}$ && "${timer_sha}" =~ ^[0-9a-f]{64}$ ]] || return 1
  caddy_container_id="$(jq --raw-output '.intents.preparedCaddyContainerId // empty' "${FACTS_FILE}")" || return 1
  worker_container_id="$(transport_value workerContainerId)" || return 1
  [[ "${caddy_container_id}" =~ ^[0-9a-f]{64}$ && "${worker_container_id}" =~ ^[0-9a-f]{64}$ && "${caddy_container_id}" != "${worker_container_id}" ]] || return 1
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ]]; then
    boot_id="$("${COMMAND_ADAPTER}" boot-id)" || return 1
    armed_boottime_ms="$("${COMMAND_ADAPTER}" boottime-ms)" || return 1
  else
    boot_id="00000000-0000-4000-8000-000000000000"
    armed_boottime_ms=0
  fi
  [[ "${boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ && "${armed_boottime_ms}" =~ ^[0-9]+$ ]] || return 1
  deadline_boottime_ms=$((armed_boottime_ms + EFFECTIVE_WINDOW_SECONDS * 1000))
  temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-watchdog.XXXXXXXXXX')" || return 1
  jq --null-input --compact-output --sort-keys \
    --argjson deadlineEpoch "${deadline_epoch}" \
    --argjson armedBoottimeMilliseconds "${armed_boottime_ms}" \
    --argjson deadlineBoottimeMilliseconds "${deadline_boottime_ms}" \
    --argjson windowSeconds "${EFFECTIVE_WINDOW_SECONDS}" \
    --arg bootId "${boot_id}" \
    --arg caddyContainerId "${caddy_container_id}" \
    --arg expectedRevision "${EXPECTED_REVISION}" \
    --arg nonce "${NONCE}" \
    --arg serviceSha256 "${service_sha}" \
    --arg timerSha256 "${timer_sha}" \
    --arg watchdogSha256 "${watchdog_sha}" \
    --arg workerContainerId "${worker_container_id}" \
    '{armedBoottimeMilliseconds:$armedBoottimeMilliseconds,bootId:$bootId,caddyContainerId:$caddyContainerId,deadlineBoottimeMilliseconds:$deadlineBoottimeMilliseconds,deadlineEpoch:$deadlineEpoch,expectedRevision:$expectedRevision,kind:"refunddesk.edge-window-watchdog",metrics:{containersRestartFenced:0,containersStopped:0,unitsStopRequested:0},nonce:$nonce,schemaVersion:1,serviceSha256:$serviceSha256,startDeadlineBoottimeMilliseconds:null,state:"armed",timerSha256:$timerSha256,triggered:false,watchdogSha256:$watchdogSha256,windowSeconds:$windowSeconds,workerContainerId:$workerContainerId}' \
    >"${temporary}" || return 1
  durable_replace "${WATCHDOG_MARKER}" "${temporary}"
}

merge_patch() {
  local patch="$1" temporary
  temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-facts.XXXXXXXXXX')" || return 1
  jq --compact-output --sort-keys --argjson patch "${patch}" '. * $patch' \
    "${FACTS_FILE}" >"${temporary}" || return 1
  if [[ -e "${RUN_MARKER}" ]]; then
    commit_facts "${temporary}"
  else
    durable_replace "${FACTS_FILE}" "${temporary}"
  fi
}

run_patch_operation() {
  local operation="$1" patch
  shift
  LAST_OPERATION_ERROR=""
  patch="$(bounded_operation "${operation}" "$@")" || return $?
  if jq --exit-status 'keys == ["error"] and (.error | type == "string" and test("^[A-Z][A-Z0-9_]{2,63}$"))' \
    <<<"${patch}" >/dev/null; then
    LAST_OPERATION_ERROR="$(jq --raw-output '.error' <<<"${patch}")"
    return "${EXIT_FAIL}"
  fi
  merge_patch "${patch}"
}

require_facts() {
  local expression="$1"
  jq --exit-status "${expression}" "${FACTS_FILE}" >/dev/null
}

increment_mutation() {
  local name="$1" temporary
  temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-facts.XXXXXXXXXX')" || return 1
  jq --compact-output --sort-keys --arg name "${name}" '.mutations[$name] += 1' \
    "${FACTS_FILE}" >"${temporary}" || return 1
  if [[ -e "${RUN_MARKER}" ]]; then
    commit_facts "${temporary}"
  else
    durable_replace "${FACTS_FILE}" "${temporary}"
  fi
}

initialize_facts() {
  local temporary
  temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-facts.XXXXXXXXXX')" || return 1
  jq --null-input --compact-output --sort-keys \
    --arg deadlineAt "${DEADLINE_AT}" \
    --arg eventFingerprint "$(jq --raw-output '.eventFingerprintSha256' "${CONTROL_FILE}")" '
      {
        containment:{awsIngressClosed:false,caddyStopped:false,coreHealthy:false,finalPostflightContained:false,finalPostflightPass:false,financialQuiescent:false,financialStable:false,liveDisabled:false,maintenanceStopped:false,markerComplete:false,originHeaderRemoved:false,publicListenersClosed:false,tokenRemoved:false,watchdogDisarmed:false,workerStopped:false},
        counts:{after:{activeFinancialJobs:0,auditEvents:0,mutationReceipts:0,refundExecutionAttempts:0,refundExecutions:0,refundRequests:0,unreleasedPaymentGuards:0,webhookReceipts:0},before:{activeFinancialJobs:0,auditEvents:0,mutationReceipts:0,refundExecutionAttempts:0,refundExecutions:0,refundRequests:0,unreleasedPaymentGuards:0,webhookReceipts:0},during:{activeFinancialJobs:0,auditEvents:0,mutationReceipts:0,refundExecutionAttempts:0,refundExecutions:0,refundRequests:0,unreleasedPaymentGuards:0,webhookReceipts:0},quiescent:false,unchanged:false},
        database:{after:{activeWorkflows:null,liveInstallations:null,liveTenants:null,preparedTransactions:null,systemIdentifierSha256:null},before:{activeWorkflows:null,liveInstallations:null,liveTenants:null,preparedTransactions:null,systemIdentifierSha256:null},during:{activeWorkflows:null,liveInstallations:null,liveTenants:null,preparedTransactions:null,systemIdentifierSha256:null},quiescent:false,stable:false},
        firewall:{afterSha256:("0"*64),beforeSha256:("0"*64),closeAmbiguous:false,closeAttemptedFirst:false,closeObserved:false,exactPrefixSet:false,finalClosed:false,openObserved:false,openedSha256:null,port80Closed:false,sshUnchanged:false,tcp443Only:false,udpClosed:false,wildcardAbsent:false},
        hostLease:{authorizationMarkerState:"absent",held:false,holderActive:false,hostLeaseMarkerState:"absent"},
        intents:{abortRequested:false,caddyStartAttempted:false,countsBeforeAttempted:false,firewallOpenAttempted:false,hostLeaseAcquireAttempted:false,originBindAttempted:false,originGcAttempted:false,originGcScanPassed:false,terminalReason:null,watchdogArmAttempted:false},
        mutations:{caddyStarts:0,containersRestartFenced:0,containersStopped:0,firewallCloses:0,firewallOpens:0,markerTransitions:0,originUpdates:0,unitsStopRequested:0,watchdogArms:0},
        origin:{bound:false,boundDeployed:false,distributionIdSha256:("0"*64),etagBindMatched:false,etagUnbindMatched:false,headerName:"X-RefundDesk-Origin-Token",headerRemoved:false,originIdSha256:("0"*64),originMatched:false,secretMaterialEmitted:false,tokenFileRemoved:false,tokenGenerated:false,tokenLengthBytes:0,tokenMatched:false,tokenWrittenRootOnly:false,unboundDeployed:false,updateAttempts:0},
        prefixes:{allowlistSha256:("0"*64),canonical:false,createDate:"1970-01-01T00:00:00Z",documentSha256:("0"*64),exactService:false,fetchedAt:"1970-01-01T00:00:00Z",firewallMatched:false,fresh:false,ipv4Count:0,ipv6Count:0,service:"CLOUDFRONT_ORIGIN_FACING",source:"AWS_PUBLIC_IP_RANGES",syncToken:"0"},
        probes:{finalPostflight:{capturedAt:null,contained:false,evidenceSha256:("0"*64),officialValidator:false,revisionMatches:false,validationSha256:("0"*64),validUntil:null},localCaddy:{backendStripStatus:0,correctTokenStatus:0,missingTokenStatus:0,tokenStripped:false,wrongTokenStatus:0},publicHealth:{cloudFrontObserved:false,noStore:false,revisionMatches:false,status:0},workbench:{attestationSha256:null,capturedAt:null,cliUsed:false,createNewObserved:false,createdAfterOpen:false,createdBeforeDeadline:false,duplicate:false,eventFingerprintSha256:$eventFingerprint,httpStatus:0,nonceMatches:false,revisionMatches:false,source:"OPERATOR_WORKBENCH"}},
        redaction:{arbitraryPathPresent:false,customerDataPresent:false,ipAddressPresent:false,keyDigestPresent:false,rawApiKeyPresent:false,rawPayloadPresent:false,rawSecretPresent:false,rawSignaturePresent:false,stderrPresent:false,stripeIdentifierPresent:false},
        topology:{accountMatched:false,aliasMatched:false,awsAccountIdSha256:("0"*64),awsRegionSha256:("0"*64),distributionDeployed:false,distributionEnabled:false,finalCaddyContainerIdSha256:("0" * 64),hostRevisionMatched:false,hostSourcesMatched:false,instanceMatched:false,instanceRunning:false,originDomainMatched:false,runtimeContainersMatched:false,sshCidrSha256:("0"*64),sshInstanceMatched:false},
        watchdog:{activeBeforeIngress:false,armedAt:null,armedBeforeIngress:false,armedBoottimeMilliseconds:null,bootIdSha256:null,caddyFenced:false,closedBoottimeMilliseconds:null,deadlineAt:$deadlineAt,deadlineBoottimeMilliseconds:null,disarmed:false,failSafeContained:false,maintenanceStopped:false,markerComplete:false,monotonicBounded:false,monotonicDurationMilliseconds:null,publicListenersClosed:false,timer:"refunddesk-edge-window-watchdog.timer",triggered:false,unit:"refunddesk-edge-window-watchdog.service",workerFenced:false}
      }
    ' >"${temporary}" || return 1
  durable_replace "${FACTS_FILE}" "${temporary}"
}

validate_control() {
  local baseline_canonical baseline_expected baseline_observed
  immutable_input_file "${CONTROL_FILE}" || return 1
  (( $(wc --bytes <"${CONTROL_FILE}") <= 131072 )) || return 1
  [[ "$(tail --bytes 1 "${CONTROL_FILE}")" == "" ]] || return 1
  jq --exit-status \
    --arg nonce "${NONCE}" \
    --arg revision "${EXPECTED_REVISION}" \
    --argjson minimumWindow "${MIN_WINDOW_SECONDS}" \
    --argjson maximumWindow "${MAX_WINDOW_SECONDS}" '
      type == "object"
    and keys == ["admission","eventFingerprintSha256","expectedRevision","kind","nonce","operationRemainingSecondsAtRunnerStart","operationStartedAt","operatorBootIdentifierSha256","operatorControlCalculatedMonotonicMilliseconds","operatorDeadlineMonotonicMilliseconds","operatorStartedMonotonicMilliseconds","postIncidentBaseline","provenance","schemaVersion","windowSeconds"]
      and .schemaVersion == 1
      and .kind == "refunddesk.edge-window-control"
      and .nonce == $nonce
      and .expectedRevision == $revision
      and (.eventFingerprintSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.windowSeconds | type == "number" and floor == . and . >= $minimumWindow and . <= $maximumWindow)
      and (.admission | type == "object"
        and keys == ["authorizationAccepted","authorizationEvidenceSha256","authorizationMaxWindowSeconds","authorizationValidFrom","authorizationValidUntil","authorizedAwsAccountIdSha256","authorizedAwsRegionSha256","authorizedDistributionIdSha256","authorizedInstanceNameSha256","authorizedOriginIdSha256","authorizedPublicBaseUrlSha256","authorizedSshCidrSha256","authorizedSshHostSha256","incidentAccepted","incidentCapturedAt","incidentEvidenceSha256","incidentRemainingSecondsAtStart","incidentValidUntil","postflightAccepted","postflightCapturedAt","postflightEvidenceSha256","postflightRemainingSecondsAtStart","postflightValidUntil","promotionAccepted","promotionCaddyContainerIdSha256","promotionDatabaseSystemIdentifierSha256","promotionEvidenceSha256","promotionPostgresContainerIdSha256","promotionRevision","promotionVerifierContainerIdSha256","promotionWebContainerIdSha256","promotionWorkerContainerIdSha256","promotionWorkerRuntimeMode"]
        and ([.authorizationAccepted,.incidentAccepted,.postflightAccepted,.promotionAccepted] | all(type == "boolean"))
        and ([.authorizationEvidenceSha256,.authorizedAwsAccountIdSha256,.authorizedAwsRegionSha256,.authorizedDistributionIdSha256,.authorizedInstanceNameSha256,.authorizedOriginIdSha256,.authorizedPublicBaseUrlSha256,.authorizedSshCidrSha256,.authorizedSshHostSha256,.incidentEvidenceSha256,.postflightEvidenceSha256,.promotionCaddyContainerIdSha256,.promotionDatabaseSystemIdentifierSha256,.promotionEvidenceSha256,.promotionPostgresContainerIdSha256,.promotionVerifierContainerIdSha256,.promotionWebContainerIdSha256,.promotionWorkerContainerIdSha256] | all(type == "string" and test("^[0-9a-f]{64}$")))
        and ([.authorizationValidFrom,.authorizationValidUntil,.incidentCapturedAt,.incidentValidUntil,.postflightCapturedAt,.postflightValidUntil] | all(type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
        and ([.incidentRemainingSecondsAtStart,.postflightRemainingSecondsAtStart] | all(type == "number" and floor == . and . >= 720 and . <= 900))
        and (.authorizationMaxWindowSeconds | type == "number" and floor == . and . >= 60 and . <= 300)
        and (.promotionWorkerRuntimeMode | type == "string")
        and (.promotionRevision | type == "string" and test("^[0-9a-f]{40}$")))
      and (.operationStartedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and (.operationRemainingSecondsAtRunnerStart | type == "number" and floor == . and . >= 0 and . <= 9007199254740991)
      and (.operatorBootIdentifierSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.operatorStartedMonotonicMilliseconds | type == "number" and floor == . and . >= 0 and . <= 9007199254740991)
      and (.operatorControlCalculatedMonotonicMilliseconds | type == "number" and floor == . and . >= 0 and . <= 9007199254740991)
      and (.operatorDeadlineMonotonicMilliseconds | type == "number" and floor == . and . >= 0 and . <= 9007199254740991)
      and (.postIncidentBaseline | type == "object"
        and keys == ["activeFinancialJobs","auditEvents","mutationReceipts","refundExecutionAttempts","refundExecutions","refundRequests","snapshotSha256","unreleasedPaymentGuards","webhookReceipts"]
        and (.snapshotSha256 | type == "string" and test("^[0-9a-f]{64}$"))
        and (del(.snapshotSha256) | all(.[]; type == "number" and floor == . and . >= 0)))
      and (.provenance | type == "object"
        and keys == ["fixtureOnly","operatorLockHeld","repositoryHead","repositoryIndexSha256","sourceBundleSha256","sources","sourcesExact","toolImageIdSha256","transportInputsPinned","transportInputsSha256","workflowRunId","workflowRunObservationSha256"]
        and ([.fixtureOnly,.operatorLockHeld,.sourcesExact,.transportInputsPinned] | all(type == "boolean"))
        and (.repositoryHead | type == "string" and test("^[0-9a-f]{40}$"))
        and ([.repositoryIndexSha256,.sourceBundleSha256,.toolImageIdSha256,.transportInputsSha256,.workflowRunObservationSha256] | all(type == "string" and test("^[0-9a-f]{64}$")))
        and (.workflowRunId | type == "number" and floor == . and . >= 1)
        and (.sources | type == "array" and length == 30
          and all(.[]; type == "object"
            and keys == ["headSha256","indexSha256","path","sourceSha256"]
            and (.path | type == "string")
            and ([.headSha256,.indexSha256,.sourceSha256] | all(type == "string" and test("^[0-9a-f]{64}$"))))))
    ' "${CONTROL_FILE}" >/dev/null || return 1
  [[ "$(jq --compact-output --sort-keys . "${CONTROL_FILE}")" == "$(tr -d '\n' <"${CONTROL_FILE}")" ]] ||
    return 1
  baseline_canonical="$(jq --compact-output --sort-keys '.postIncidentBaseline | del(.snapshotSha256)' "${CONTROL_FILE}")" || return 1
  baseline_expected="$(printf '%s' "${baseline_canonical}" | sha256sum)" || return 1
  baseline_expected="${baseline_expected%% *}"
  baseline_observed="$(jq --raw-output '.postIncidentBaseline.snapshotSha256' "${CONTROL_FILE}")" || return 1
  [[ "${baseline_expected}" == "${baseline_observed}" ]] || return 1
  CONTROL_OPERATION_STARTED_AT="$(jq --raw-output '.operationStartedAt' "${CONTROL_FILE}")" || return 1
  [[ "${CONTROL_OPERATION_STARTED_AT}" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  CONTROL_OPERATION_REMAINING_SECONDS="$(jq --raw-output '.operationRemainingSecondsAtRunnerStart' "${CONTROL_FILE}")" || return 1
  CONTROL_OPERATOR_BOOT_IDENTIFIER_SHA256="$(jq --raw-output '.operatorBootIdentifierSha256' "${CONTROL_FILE}")" || return 1
  CONTROL_OPERATOR_CONTROL_CALCULATED_MONOTONIC_MILLISECONDS="$(jq --raw-output '.operatorControlCalculatedMonotonicMilliseconds' "${CONTROL_FILE}")" || return 1
  CONTROL_OPERATOR_STARTED_MONOTONIC_MILLISECONDS="$(jq --raw-output '.operatorStartedMonotonicMilliseconds' "${CONTROL_FILE}")" || return 1
  CONTROL_OPERATOR_DEADLINE_MONOTONIC_MILLISECONDS="$(jq --raw-output '.operatorDeadlineMonotonicMilliseconds' "${CONTROL_FILE}")" || return 1
  (( CONTROL_OPERATOR_DEADLINE_MONOTONIC_MILLISECONDS - CONTROL_OPERATOR_STARTED_MONOTONIC_MILLISECONDS == EXECUTION_MAX_SECONDS * 1000 )) || return 2
  (( CONTROL_OPERATOR_CONTROL_CALCULATED_MONOTONIC_MILLISECONDS >= CONTROL_OPERATOR_STARTED_MONOTONIC_MILLISECONDS )) || return 2
  (( CONTROL_OPERATOR_CONTROL_CALCULATED_MONOTONIC_MILLISECONDS < CONTROL_OPERATOR_DEADLINE_MONOTONIC_MILLISECONDS )) || return 2
  (( CONTROL_OPERATION_REMAINING_SECONDS >= 1 && CONTROL_OPERATION_REMAINING_SECONDS <= EXECUTION_MAX_SECONDS - OPERATOR_HANDOFF_RESERVE_SECONDS )) || return 2
  (( CONTROL_OPERATION_REMAINING_SECONDS <=
    (CONTROL_OPERATOR_DEADLINE_MONOTONIC_MILLISECONDS - CONTROL_OPERATOR_CONTROL_CALCULATED_MONOTONIC_MILLISECONDS) / 1000 - OPERATOR_HANDOFF_RESERVE_SECONDS )) || return 2
  WINDOW_SECONDS="$(jq --raw-output '.windowSeconds' "${CONTROL_FILE}")"
  EFFECTIVE_WINDOW_SECONDS="${WINDOW_SECONDS}"
  # This provisional value exists only so pre-open failure evidence remains
  # well shaped.  The normative deadline is recomputed immediately before the
  # durable watchdog is armed, after the potentially slow CloudFront deploy.
  DEADLINE_AT="$(timestamp_add_seconds "${STARTED_AT}" "${WINDOW_SECONDS}")" || return 1
}

validate_fresh_admission() {
  local operation_epoch invocation_epoch incident_captured_at incident_valid_until incident_asserted incident_actual
  local postflight_captured_at postflight_valid_until postflight_asserted postflight_actual
  local authorization_valid_from authorization_valid_until
  jq --exit-status --arg revision "${EXPECTED_REVISION}" --argjson windowSeconds "${WINDOW_SECONDS}" '
    .admission.authorizationAccepted == true
    and .admission.incidentAccepted == true
    and .admission.postflightAccepted == true
    and .admission.promotionAccepted == true
    and .admission.promotionRevision == $revision
    and .admission.promotionWorkerRuntimeMode == "incident_admission"
    and .admission.authorizationMaxWindowSeconds >= $windowSeconds
    and ([.admission.promotionCaddyContainerIdSha256,.admission.promotionPostgresContainerIdSha256,.admission.promotionVerifierContainerIdSha256,.admission.promotionWebContainerIdSha256,.admission.promotionWorkerContainerIdSha256] | unique | length) == 5
  ' "${CONTROL_FILE}" >/dev/null || return 1
  operation_epoch="$(timestamp_epoch "${OPERATION_STARTED_AT}")" || return 1
  invocation_epoch="$(timestamp_epoch "${INVOCATION_STARTED_AT}")" || return 1
  incident_captured_at="$(timestamp_epoch "$(jq --raw-output '.admission.incidentCapturedAt' "${CONTROL_FILE}")")" || return 1
  incident_valid_until="$(timestamp_epoch "$(jq --raw-output '.admission.incidentValidUntil' "${CONTROL_FILE}")")" || return 1
  incident_asserted="$(jq --raw-output '.admission.incidentRemainingSecondsAtStart' "${CONTROL_FILE}")" || return 1
  postflight_captured_at="$(timestamp_epoch "$(jq --raw-output '.admission.postflightCapturedAt' "${CONTROL_FILE}")")" || return 1
  postflight_valid_until="$(timestamp_epoch "$(jq --raw-output '.admission.postflightValidUntil' "${CONTROL_FILE}")")" || return 1
  postflight_asserted="$(jq --raw-output '.admission.postflightRemainingSecondsAtStart' "${CONTROL_FILE}")" || return 1
  authorization_valid_from="$(timestamp_epoch "$(jq --raw-output '.admission.authorizationValidFrom' "${CONTROL_FILE}")")" || return 1
  authorization_valid_until="$(timestamp_epoch "$(jq --raw-output '.admission.authorizationValidUntil' "${CONTROL_FILE}")")" || return 1
  [[ "${incident_asserted}" =~ ^[0-9]+$ && "${postflight_asserted}" =~ ^[0-9]+$ ]] || return 1
  postflight_actual=$((postflight_valid_until - operation_epoch))
  incident_actual=$((incident_valid_until - operation_epoch))
  (( postflight_actual >= MIN_POSTFLIGHT_REMAINING_SECONDS &&
    postflight_actual <= MAX_ADMISSION_REMAINING_SECONDS )) || return 1
  (( incident_actual >= MIN_POSTFLIGHT_REMAINING_SECONDS &&
    incident_actual <= MAX_ADMISSION_REMAINING_SECONDS )) || return 1
  (( incident_asserted == incident_actual && postflight_asserted == postflight_actual )) || return 1
  # ADR 0036 completes the referenced ADR 0034 capture before it seals the
  # outer incident document.  Edge admission is later than both.
  (( postflight_captured_at <= incident_captured_at && incident_captured_at <= operation_epoch )) || return 1
  (( authorization_valid_from <= operation_epoch )) || return 1
  (( authorization_valid_until - authorization_valid_from <= 7200 )) || return 1
  (( authorization_valid_until >= operation_epoch + EXECUTION_MAX_SECONDS )) || return 1
  # A durable workstation attempt may resume with the same sealed evidence,
  # but it never extends the 35-minute operation budget or authorizes a late
  # first effect. Current topology and financial state are re-read below.
  (( operation_epoch <= invocation_epoch && invocation_epoch <= operation_epoch + EXECUTION_MAX_SECONDS )) || return 1
}

arm_window_deadline() {
  local authorization_valid_until armed_epoch candidate_deadline_epoch deadline_epoch operation_deadline_epoch operation_remaining
  ARMED_AT="$(timestamp_now)" || return 1
  WINDOW_MONOTONIC_STARTED_SECONDS="${SECONDS}"
  armed_epoch="$(timestamp_epoch "${ARMED_AT}")" || return 1
  operation_deadline_epoch="$(timestamp_epoch "${OPERATION_DEADLINE_AT}")" || return 1
  operation_remaining="$(operation_budget_remaining_seconds)" || return 1
  (( operation_remaining >= 0 )) || return 1
  (( armed_epoch + operation_remaining < operation_deadline_epoch )) &&
    operation_deadline_epoch=$((armed_epoch + operation_remaining))
  authorization_valid_until="$(timestamp_epoch "$(jq --raw-output '.admission.authorizationValidUntil' "${CONTROL_FILE}")")" || return 1
  candidate_deadline_epoch=$((armed_epoch + WINDOW_SECONDS - WATCHDOG_CONTAINMENT_RESERVE_SECONDS))
  deadline_epoch="${candidate_deadline_epoch}"
  (( operation_deadline_epoch < deadline_epoch )) && deadline_epoch="${operation_deadline_epoch}"
  (( authorization_valid_until < deadline_epoch )) && deadline_epoch="${authorization_valid_until}"
  EFFECTIVE_WINDOW_SECONDS=$((deadline_epoch - armed_epoch))
  (( EFFECTIVE_WINDOW_SECONDS >= 30 )) || return 1
  DEADLINE_AT="$(timestamp_add_seconds "${ARMED_AT}" "${EFFECTIVE_WINDOW_SECONDS}")" || return 1
  [[ "$(timestamp_epoch "${DEADLINE_AT}")" == "${deadline_epoch}" ]] || return 1
  merge_patch "$(jq --null-input --compact-output --sort-keys \
    --arg armedAt "${ARMED_AT}" --arg deadlineAt "${DEADLINE_AT}" \
    '{watchdog:{armedAt:$armedAt,deadlineAt:$deadlineAt}}')" || return 1
}

validate_transport() {
  local expected actual ssh_config ssh_config_sha aws_config_sha expected_ssh_sha expected_aws_sha value digest name executable expected_digest
  [[ -n "${TRANSPORT_FILE}" ]] || return 1
  immutable_input_file "${TRANSPORT_FILE}" || return 1
  (( $(wc --bytes <"${TRANSPORT_FILE}") <= 32768 )) || return 1
  jq --exit-status '
    type == "object"
    and keys == ["awsAccountId","awsConfigSha256","awsRegion","caddyContainerId","distributionId","expectedSshCidr","gitExecutable","gitSha256","instanceName","nodeExecutable","nodeSha256","originId","postgresContainerId","publicBaseUrl","sshConfigPath","sshConfigSha256","sshHost","targetHost","verifierContainerId","webContainerId","workerContainerId"]
    and (.awsAccountId | type == "string" and test("^[0-9]{12}$"))
    and (.awsConfigSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.awsRegion | type == "string" and test("^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$"))
    and (.caddyContainerId | type == "string" and test("^[0-9a-f]{64}$"))
    and (.distributionId | type == "string" and test("^[A-Z0-9]{8,32}$"))
    and (.expectedSshCidr | type == "string" and test("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}/32$"))
    and (.instanceName | type == "string" and test("^[A-Za-z0-9_-]{1,64}$"))
    and (.originId | type == "string" and test("^[A-Za-z0-9._-]{1,128}$"))
    and (.postgresContainerId | type == "string" and test("^[0-9a-f]{64}$"))
    and (.verifierContainerId | type == "string" and test("^[0-9a-f]{64}$"))
    and (.webContainerId | type == "string" and test("^[0-9a-f]{64}$"))
    and (.workerContainerId | type == "string" and test("^[0-9a-f]{64}$"))
    and (.publicBaseUrl | type == "string" and test("^https://[A-Za-z0-9.-]+$"))
    and (.gitExecutable | type == "string" and test("^/[^\\r\\n]{1,1023}$"))
    and (.gitSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.nodeExecutable | type == "string" and test("^/[^\\r\\n]{1,1023}$"))
    and (.nodeSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.sshConfigPath | type == "string" and test("^/[^\\r\\n]{1,1023}$"))
    and (.sshConfigSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.sshHost | type == "string" and test("^[A-Za-z0-9_-]{1,64}$"))
    and (.targetHost | type == "string" and test("^[A-Za-z0-9.-]{1,253}$"))
  ' "${TRANSPORT_FILE}" >/dev/null || return 1
  [[ "$(jq --compact-output --sort-keys . "${TRANSPORT_FILE}")" == "$(tr -d '\n' <"${TRANSPORT_FILE}")" ]] ||
    return 1
  expected="$(jq --raw-output '.provenance.transportInputsSha256' "${CONTROL_FILE}")" || return 1
  actual="$(hash_file "${TRANSPORT_FILE}")" || return 1
  [[ "${actual}" == "${expected}" ]] || return 1
  ssh_config="$(transport_value sshConfigPath)" || return 1
  if [[ "${REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-}" == "1" ]]; then
    [[ "${ssh_config}" == "/var/lib/refunddesk/input/ssh-config" &&
      "${AWS_CONFIG_FILE:-}" == "/var/lib/refunddesk/input/aws-config" ]] || return 1
  fi
  immutable_input_file "${ssh_config}" || return 1
  [[ -n "${AWS_CONFIG_FILE:-}" ]] || return 1
  immutable_input_file "${AWS_CONFIG_FILE}" || return 1
  ssh_config_sha="$(hash_file "${ssh_config}")" || return 1
  aws_config_sha="$(hash_file "${AWS_CONFIG_FILE}")" || return 1
  [[ "${ssh_config_sha}" == "$(transport_value sshConfigSha256)" &&
    "${aws_config_sha}" == "$(transport_value awsConfigSha256)" ]] || return 1
  expected_ssh_sha="$(printf '%s\n' \
    'Host refunddesk-edge' \
    "  HostName $(transport_value targetHost)" \
    '  User ubuntu' \
    '  BatchMode yes' \
    '  PasswordAuthentication no' \
    '  KbdInteractiveAuthentication no' \
    '  GSSAPIAuthentication no' \
    '  IdentitiesOnly yes' \
    '  IdentityFile /operator/ssh/id' \
    '  UserKnownHostsFile /operator/ssh/known_hosts' \
    '  StrictHostKeyChecking yes' \
    '  ForwardAgent no' \
    '  ClearAllForwardings yes' \
    '  PermitLocalCommand no' \
    '  RequestTTY no' \
    '  SendEnv -*' \
    '  IdentityAgent none' \
    '  LogLevel ERROR' | sha256sum | cut -d ' ' -f 1)" || return 1
  expected_aws_sha="$(printf '[default]\nregion = %s\noutput = json\n' "$(transport_value awsRegion)" | sha256sum | cut -d ' ' -f 1)" || return 1
  [[ "${ssh_config_sha}" == "${expected_ssh_sha}" && "${aws_config_sha}" == "${expected_aws_sha}" ]] || return 1
  ! grep -Eiq '(^|[^A-Za-z])(AWS_ACCESS|AWS_SECRET|AWS_SESSION|credential|stripe)' "${TRANSPORT_FILE}" || return 1
  for name in awsAccountId awsRegion expectedSshCidr distributionId originId instanceName publicBaseUrl targetHost caddyContainerId postgresContainerId verifierContainerId webContainerId workerContainerId; do
    value="$(transport_value "${name}")" || return 1
    digest="$(hash_text "${value}")" || return 1
    case "${name}" in
      awsAccountId) expected="$(jq --raw-output '.admission.authorizedAwsAccountIdSha256' "${CONTROL_FILE}")" ;;
      awsRegion) expected="$(jq --raw-output '.admission.authorizedAwsRegionSha256' "${CONTROL_FILE}")" ;;
      expectedSshCidr) expected="$(jq --raw-output '.admission.authorizedSshCidrSha256' "${CONTROL_FILE}")" ;;
      distributionId) expected="$(jq --raw-output '.admission.authorizedDistributionIdSha256' "${CONTROL_FILE}")" ;;
      originId) expected="$(jq --raw-output '.admission.authorizedOriginIdSha256' "${CONTROL_FILE}")" ;;
      instanceName) expected="$(jq --raw-output '.admission.authorizedInstanceNameSha256' "${CONTROL_FILE}")" ;;
      publicBaseUrl) expected="$(jq --raw-output '.admission.authorizedPublicBaseUrlSha256' "${CONTROL_FILE}")" ;;
      targetHost) expected="$(jq --raw-output '.admission.authorizedSshHostSha256' "${CONTROL_FILE}")" ;;
      caddyContainerId) expected="$(jq --raw-output '.admission.promotionCaddyContainerIdSha256' "${CONTROL_FILE}")" ;;
      postgresContainerId) expected="$(jq --raw-output '.admission.promotionPostgresContainerIdSha256' "${CONTROL_FILE}")" ;;
      verifierContainerId) expected="$(jq --raw-output '.admission.promotionVerifierContainerIdSha256' "${CONTROL_FILE}")" ;;
      webContainerId) expected="$(jq --raw-output '.admission.promotionWebContainerIdSha256' "${CONTROL_FILE}")" ;;
      workerContainerId) expected="$(jq --raw-output '.admission.promotionWorkerContainerIdSha256' "${CONTROL_FILE}")" ;;
    esac
    [[ "${digest}" == "${expected}" ]] || return 1
  done
  for name in git node; do
    executable="$(transport_value "${name}Executable")" || return 1
    expected_digest="$(transport_value "${name}Sha256")" || return 1
    [[ -f "${executable}" && ! -L "${executable}" && -x "${executable}" ]] || return 1
    [[ "$(hash_file "${executable}")" == "${expected_digest}" ]] || return 1
  done
}

validate_local_sources() {
  local path expected actual records expected_paths expected_fixture sources_json index_json
  local source_bundle_expected source_bundle_observed index_expected index_observed count=0
  expected_paths='[".dockerignore",".github/workflows/sandbox-images.yml","deploy/lightsail/Caddyfile.public","deploy/lightsail/compose.yml","deploy/lightsail/edge-operator.Dockerfile","deploy/lightsail/edge-operator.Dockerfile.dockerignore","deploy/lightsail/scripts/_common.sh","deploy/lightsail/scripts/observe-host-postflight.sh","deploy/lightsail/scripts/prove-bounded-edge-window.sh","deploy/lightsail/scripts/recover-quiesced-runtime.sh","deploy/lightsail/scripts/release.sh","deploy/lightsail/scripts/refunddesk-edge-operator.sh","deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh","deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service","deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer","docs/adr/0037-bounded-cloudfront-origin-window.md","docs/schemas/refunddesk-edge-operator-image-v1.schema.json","docs/schemas/refunddesk-lightsail-contained-promotion-v1.schema.json","docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json","docs/schemas/refunddesk-lightsail-incident-admission-v1.schema.json","docs/schemas/refunddesk-lightsail-postflight-v1.schema.json","scripts/check-sandbox-images-workflow.mjs","scripts/invoke-lightsail-edge-window.ps1","scripts/invoke-lightsail-postflight.ps1","scripts/submit-lightsail-edge-window-checkpoint.ps1","scripts/validate-edge-operator-image.mjs","scripts/validate-lightsail-contained-promotion.mjs","scripts/validate-lightsail-edge-window.mjs","scripts/validate-lightsail-incident-admission.mjs","scripts/validate-lightsail-postflight.mjs"]'
  expected_fixture=false
  [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ]] && expected_fixture=true
  jq --exit-status --arg revision "${EXPECTED_REVISION}" --argjson fixture "${expected_fixture}" --argjson paths "${expected_paths}" '
    .provenance.repositoryHead == $revision
    and .provenance.fixtureOnly == $fixture
    and .provenance.operatorLockHeld == true
    and .provenance.sourcesExact == true
    and .provenance.transportInputsPinned == true
    and [.provenance.sources[].path] == $paths
    and all(.provenance.sources[]; .sourceSha256 == .indexSha256 and .sourceSha256 == .headSha256)
  ' "${CONTROL_FILE}" >/dev/null || return 1
  sources_json="$(jq --compact-output --sort-keys '.provenance.sources' "${CONTROL_FILE}")" || return 1
  source_bundle_expected="$(hash_text "${sources_json}")" || return 1
  source_bundle_observed="$(jq --raw-output '.provenance.sourceBundleSha256' "${CONTROL_FILE}")" || return 1
  [[ "${source_bundle_expected}" == "${source_bundle_observed}" ]] || return 1
  index_json="$(jq --compact-output --sort-keys '[.provenance.sources[] | {indexSha256,path}]' "${CONTROL_FILE}")" || return 1
  index_expected="$(hash_text "${index_json}")" || return 1
  index_observed="$(jq --raw-output '.provenance.repositoryIndexSha256' "${CONTROL_FILE}")" || return 1
  [[ "${index_expected}" == "${index_observed}" ]] || return 1
  records="$(jq --raw-output '.provenance.sources[] | [.path,.sourceSha256] | @tsv' "${CONTROL_FILE}")" || return 1
  while IFS=$'\t' read -r path expected; do
    ((count += 1))
    [[ -f "${path}" && ! -L "${path}" ]] || return 1
    actual="$(hash_file "${path}")" || return 1
    [[ "${actual}" == "${expected}" ]] || return 1
  done <<<"${records}"
  (( count == 30 )) || return 1
}

write_checkpoint_request() {
  [[ ! -e "${CHECKPOINT_REQUEST_FILE}" && ! -L "${CHECKPOINT_REQUEST_FILE}" ]] || return 1
  python3 - "${CHECKPOINT_REQUEST_FILE}" "${DEADLINE_AT}" \
    "$(jq --raw-output '.eventFingerprintSha256' "${CONTROL_FILE}")" \
    "${EXPECTED_REVISION}" "${NONCE}" "${OPENED_AT}" <<'PY' || return 1
import json
import os
import sys

path, deadline, fingerprint, revision, nonce, opened = sys.argv[1:]
document = {
    "deadlineAt": deadline,
    "eventFingerprintSha256": fingerprint,
    "expectedRevision": revision,
    "kind": "refunddesk.operator-workbench-request",
    "nonce": nonce,
    "openedAt": opened,
    "schemaVersion": 1,
}
data = (json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written
    os.fsync(descriptor)
finally:
    os.close(descriptor)
directory = os.open(os.path.dirname(path), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

wait_for_workbench_checkpoint() {
  local now epoch deadline_epoch captured_epoch opened_epoch digest monotonic_elapsed
  local expected_fingerprint request_sha snapshot snapshot_bytes patch
  expected_fingerprint="$(jq --raw-output '.eventFingerprintSha256' "${CONTROL_FILE}")" || return "${EXIT_INCOMPLETE}"
  request_sha="$(hash_file "${CHECKPOINT_REQUEST_FILE}")" || return "${EXIT_INCOMPLETE}"
  deadline_epoch="$(timestamp_epoch "${DEADLINE_AT}")" || return "${EXIT_INCOMPLETE}"
  opened_epoch="$(timestamp_epoch "${OPENED_AT}")" || return "${EXIT_INCOMPLETE}"

  snapshot="${OPERATION_ROOT}/workbench-checkpoint.snapshot.json"
  # In tests only, this operation models an operator using Workbench and must
  # create the file with O_EXCL. Production returns immediately and a human
  # creates the local checkpoint after observing the request file. A durable
  # snapshot is already the sole authority on replay, so never republish or
  # reopen the mutable checkpoint pathname once that snapshot exists.
  if [[ ! -e "${CHECKPOINT_FILE}" && ! -L "${CHECKPOINT_FILE}" &&
    ! -e "${snapshot}" && ! -L "${snapshot}" ]]; then
    bounded_operation checkpoint-publish \
      "${CHECKPOINT_FILE}" "${CHECKPOINT_REQUEST_FILE}" "${NONCE}" "${EXPECTED_REVISION}" "${expected_fingerprint}" \
      "${OPENED_AT}" "${DEADLINE_AT}" >/dev/null || return "${EXIT_INCOMPLETE}"
  fi
  while [[ ! -e "${CHECKPOINT_FILE}" && ! -e "${snapshot}" ]]; do
    [[ "${WINDOW_MONOTONIC_STARTED_SECONDS}" =~ ^[0-9]+$ ]] || return "${EXIT_INCOMPLETE}"
    monotonic_elapsed=$((SECONDS - WINDOW_MONOTONIC_STARTED_SECONDS))
    (( monotonic_elapsed < EFFECTIVE_WINDOW_SECONDS )) || return "${CHECKPOINT_TIMEOUT_STATUS}"
    now="$(timestamp_now)" || return "${EXIT_INCOMPLETE}"
    epoch="$(timestamp_epoch "${now}")" || return "${EXIT_INCOMPLETE}"
    (( epoch <= deadline_epoch )) || return "${CHECKPOINT_TIMEOUT_STATUS}"
    sleep 1
  done
  if [[ ! -e "${snapshot}" ]]; then
    controlled_file "${CHECKPOINT_FILE}" || return 20
  fi
  now="$(timestamp_now)" || return "${EXIT_INCOMPLETE}"
  monotonic_elapsed=$((SECONDS - WINDOW_MONOTONIC_STARTED_SECONDS))
  (( monotonic_elapsed <= EFFECTIVE_WINDOW_SECONDS )) || return "${CHECKPOINT_TIMEOUT_STATUS}"
  epoch="$(timestamp_epoch "${now}")" || return "${EXIT_INCOMPLETE}"
  (( epoch <= deadline_epoch )) || return "${CHECKPOINT_TIMEOUT_STATUS}"
  # The canonical snapshot helper reads the source once through O_NOFOLLOW,
  # fstat-validates it before and after the read, durably creates a 0400
  # replay snapshot, and returns those exact bytes on stdout.  Command
  # substitution removes only the canonical final LF; every consumer below
  # restores that LF from the in-memory value and never reopens a pathname.
  snapshot_bytes="$(snapshot_canonical_json_file "${CHECKPOINT_FILE}" "${snapshot}" 16384)" || return 20
  # Keep the immutable 0400 snapshot until terminal volume GC. A crash before
  # the facts merge must resume from these bytes, never from a replacement at
  # the operator-controlled checkpoint pathname.
  [[ -n "${snapshot_bytes}" ]] || return 20
  maybe_crash after_workbench_snapshot
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
    "${REFUNDDESK_EDGE_WINDOW_TEST_CHECKPOINT_CONSUMER_DELAY:-}" == "1" ]]; then
    sleep 0.2
  fi
  jq --exit-status \
    --arg nonce "${NONCE}" \
    --arg revision "${EXPECTED_REVISION}" \
    --arg fingerprint "${expected_fingerprint}" '
      type == "object"
      and keys == ["capturedAt","cliUsed","duplicate","eventFingerprintSha256","expectedRevision","httpStatus","kind","nonce","receiver","requestSha256","schemaVersion","source"]
      and .schemaVersion == 1
      and .kind == "refunddesk.operator-workbench-replay"
      and .nonce == $nonce
      and .expectedRevision == $revision
      and .eventFingerprintSha256 == $fingerprint
      and .source == "OPERATOR_WORKBENCH"
      and .receiver == "REFUNDDESK_CREATE_NEW_V1"
      and .httpStatus == 200
      and .duplicate == true
      and .cliUsed == false
      and (.requestSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.capturedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    ' <<<"${snapshot_bytes}" >/dev/null || return 20
  [[ "$(jq --raw-output '.requestSha256' <<<"${snapshot_bytes}")" == "${request_sha}" ]] || return 20
  captured_epoch="$(timestamp_epoch "$(jq --raw-output '.capturedAt' <<<"${snapshot_bytes}")")" ||
    return 20
  (( captured_epoch >= opened_epoch && captured_epoch <= deadline_epoch )) || return 20
  digest="$(printf '%s\n' "${snapshot_bytes}" | sha256sum | cut -d ' ' -f 1)" || return 20
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || return 20
  patch="$(jq --null-input --compact-output --sort-keys \
    --arg capturedAt "$(jq --raw-output '.capturedAt' <<<"${snapshot_bytes}")" \
    --arg digest "${digest}" '
      {probes:{workbench:{attestationSha256:$digest,capturedAt:$capturedAt,cliUsed:false,createNewObserved:true,createdAfterOpen:true,createdBeforeDeadline:true,duplicate:true,httpStatus:200,nonceMatches:true,revisionMatches:true,source:"OPERATOR_WORKBENCH"}}}
    ')" || return 20
  merge_patch "${patch}"
}

maybe_crash() {
  local point="$1"
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
    "${REFUNDDESK_EDGE_WINDOW_TEST_SIGNAL_POINT:-}" == "${point}" ]]; then
    kill -TERM "$$"
    return
  fi
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
    "${REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT:-}" == "${point}" ]]; then
    kill -KILL "$$"
  fi
}

cleanup_surfaces() {
  local status=0 firewall_status=0 operation_status=0 watchdog_disarmed=false edge_was_open=false
  local pass_eligible=true terminal_cleanup_status=0
  local closed_epoch deadline_epoch candidate_sha terminal_rejection_reason=""
  [[ "${CLEANUP_STARTED}" == false ]] || return 0
  CLEANUP_STARTED=true
  if [[ -f "${FACTS_FILE}" ]] &&
    require_facts '.intents.hostLeaseAcquireAttempted == true or .hostLease.held == true'; then
    # The acquisition effect may have completed before its SSH/patch
    # acknowledgement.  Derive recovery authority from the durable intent and
    # facts, never only from this process's volatile success flag.
    HOST_LEASE_RECOVERY_REQUIRED=true
  fi
  if [[ "${FUNCTIONAL_GATE_PASSED}" != true ]]; then
    # Every pre-functional state is cleanup-only.  In particular, an arm
    # intent without an acknowledged arm has no boot proof that could support
    # PASS, but it must still be disarmed and released safely.
    pass_eligible=false
  fi
  if require_facts '.intents.abortRequested == true'; then
    pass_eligible=false
    terminal_rejection_reason="$(jq --raw-output '.intents.terminalReason // empty' "${FACTS_FILE}")" ||
      return "${EXIT_INCOMPLETE}"
    case "${terminal_rejection_reason}" in
      OFFICIAL_VALIDATOR_REJECTED | MUTATION_CARDINALITY_INVALID)
        terminal_cleanup_status="${EXIT_FAIL}"
        ;;
      FIREWALL_ATTRIBUTION_AMBIGUOUS | WINDOW_CLOCK_INVALID | WINDOW_DEADLINE_EXCEEDED | \
        WATCHDOG_CONTINUITY_INVALID | BOOT_GUARD_INVALID | PROVIDER_ATTRIBUTION_INVALID | \
        TERMINAL_TIMESTAMP_INVALID | \
        TERMINAL_TEMPORAL_BOUNDS_INVALID | PASS_COMPLETION_INVALID | PASS_REPLAY_INVALID | \
        TERMINAL_PROOF_INCOMPLETE)
        terminal_cleanup_status="${EXIT_INCOMPLETE}"
        ;;
      "")
        # Abort intents created before the terminal proof boundary retain their
        # operation-specific classification; no terminal reason is invented.
        ;;
      *)
        return "${EXIT_INCOMPLETE}"
        ;;
    esac
  fi

  if [[ -f "${FACTS_FILE}" ]]; then
    require_facts '.intents.firewallOpenAttempted == true or .firewall.openObserved == true or .mutations.firewallOpens > 0' && edge_was_open=true
  fi

  # This ordering is a safety contract: remove every AWS ingress rule before
  # touching CloudFront identity or the host. It also applies after TERM/error.
  if [[ "${edge_was_open}" == true || "${HOST_LEASE_ACQUIRED}" == true || "${HOST_LEASE_RECOVERY_REQUIRED}" == true ]]; then
    run_patch_operation firewall-close || firewall_status=$?
    (( firewall_status == 0 )) || status="${firewall_status}"
    if (( status != 0 )) && [[ -f "${FACTS_FILE}" ]]; then
      merge_patch '{"firewall":{"closeAmbiguous":true,"closeObserved":false,"finalClosed":false}}' || true
    fi
    if (( firewall_status == 0 )) && require_facts '.firewall.finalClosed == true and .firewall.closeAmbiguous == true'; then
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
      terminal_rejection_reason="FIREWALL_ATTRIBUTION_AMBIGUOUS"
    fi
    if (( firewall_status == 0 )) && require_facts '.watchdog.armedBoottimeMilliseconds != null and .watchdog.bootIdSha256 != null'; then
      operation_status=0
      run_patch_operation window-clock-stop || operation_status=$?
      if (( operation_status == 0 )); then
        CLOSED_AT="$(timestamp_now)" || return "${EXIT_INCOMPLETE}"
        closed_epoch="$(timestamp_epoch "${CLOSED_AT}")" || return "${EXIT_INCOMPLETE}"
        deadline_epoch="$(timestamp_epoch "${DEADLINE_AT}")" || return "${EXIT_INCOMPLETE}"
        if (( closed_epoch > deadline_epoch )); then
          pass_eligible=false
          terminal_cleanup_status="${EXIT_INCOMPLETE}"
          terminal_rejection_reason="WINDOW_DEADLINE_EXCEEDED"
        fi
        write_run_marker ingress_closed 2>/dev/null || status="${EXIT_FAIL}"
      else
        # A reboot, wall/boottime ambiguity or a cleanup that starts after the
        # durable deadline can never be promoted to PASS.  Exact AWS closure
        # still permits best-effort containment, origin restoration, watchdog
        # disarm and lease release so a safe recovery does not deadlock
        # forever.  The terminal evidence remains INCOMPLETE with the original
        # timestamps and monotonicBounded=false.
        pass_eligible=false
        terminal_cleanup_status="${EXIT_INCOMPLETE}"
        terminal_rejection_reason="WINDOW_CLOCK_INVALID"
      fi
    elif (( firewall_status == 0 )) && [[ "${edge_was_open}" == true ]]; then
      # An observed/open-attempted edge without its durable monotonic arm
      # cannot be relabelled as safely bounded.
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
      terminal_rejection_reason="WATCHDOG_CONTINUITY_INVALID"
    fi
  fi
  # Before the durable host lease exists, cleanup is restricted to the AWS
  # control plane.  It must not touch Caddy, workers, timers or host config
  # without owning the real host operator lock.
  if [[ "${HOST_LEASE_ACQUIRED}" != true ]]; then
    if [[ "${HOST_LEASE_RECOVERY_REQUIRED}" == true ]]; then
      # A lost acknowledgement after either durable completion or holder
      # release must never regress the authorization marker to held.  Finish
      # or verify release using the exact complete pair, then terminate this
      # cleanup-only invocation as 21 without touching host surfaces again.
      if run_patch_operation host-lease-cleanup-status ||
        {
          # If the host marker reached complete before process death but the
          # authorization marker did not, finish only that already-started
          # monotonic transition.  The repair-only flag rejects an ordinary
          # held/held pair, which must still be recovered through the holder.
          run_patch_operation host-lease-complete false true &&
            run_patch_operation host-lease-release false &&
            run_patch_operation host-lease-cleanup-status
        }; then
        CLEANUP_CONVERGED=true
        return "${EXIT_INCOMPLETE}"
      fi
      operation_status=0
      run_patch_operation host-lease-status || operation_status=$?
      if (( operation_status != 0 )); then
        run_patch_operation host-lease-acquire || operation_status=$?
      fi
      if (( operation_status == 0 )) && require_facts '.hostLease.held == true'; then
        HOST_LEASE_ACQUIRED=true
      else
        return "${EXIT_INCOMPLETE}"
      fi
    fi
  fi
  if [[ "${HOST_LEASE_ACQUIRED}" != true ]]; then
    (( status != 0 )) || CLEANUP_CONVERGED=true
    return "${status}"
  fi
  # Once the AWS edge is observed closed, contain the host immediately.  A
  # CloudFront unbind can legitimately wait several minutes for Deployed and
  # must never extend the lifetime of Caddy, the worker, timers or listeners.
  operation_status=0
  run_patch_operation host-contain || operation_status=$?
  (( operation_status == 0 || status != 0 )) || status="${operation_status}"
  if (( operation_status == 0 )) && require_facts '.watchdog.triggered == true'; then
    # A scheduled/forced fail-safe transition is monotone.  Physical cleanup
    # can converge and release its interlocks as INCOMPLETE, but it can never
    # be relabelled as the runner's planned terminal containment or PASS.
    pass_eligible=false
    terminal_cleanup_status="${EXIT_INCOMPLETE}"
    terminal_rejection_reason="WATCHDOG_CONTINUITY_INVALID"
  fi
  if (( operation_status == 0 )) &&
    require_facts '.intents.watchdogArmAttempted == true or .mutations.watchdogArms > 0' &&
    ! require_facts '.watchdog.failSafeContained == true'; then
    pass_eligible=false
    terminal_cleanup_status="${EXIT_INCOMPLETE}"
    terminal_rejection_reason="WATCHDOG_CONTINUITY_INVALID"
  fi
  # Always obtain positive origin/token restoration evidence under the host
  # lease.  Zero intent/mutation counters cannot prove that an external effect
  # did not complete before its journal acknowledgement.
  if ! require_facts '.origin.headerRemoved == true and .origin.unboundDeployed == true'; then
    operation_status=0
    run_patch_operation origin-unbind || operation_status=$?
    (( operation_status == 0 || status != 0 )) || status="${operation_status}"
    (( operation_status != 0 )) || maybe_crash after_origin_unbound
  fi
  # Facts are not a provider lock. Re-read the exact CloudFront ETag/config
  # and the inert host Caddy metadata on every cleanup/replay before any
  # canary/recovery GC or PASS transition. This status-only operation never
  # updates CloudFront and never recreates Caddy.
  if (( status == 0 )); then
    operation_status=0
    run_patch_operation origin-status || operation_status=$?
    (( operation_status == 0 || status != 0 )) || status="${operation_status}"
  fi
  if (( status == 0 )) && require_facts '.origin.updateAttempts > 0' &&
    ! require_facts '.origin.etagBindMatched == true and .origin.etagUnbindMatched == true'; then
    # Exact provider bytes permit safe cleanup after a lost bind/unbind ACK,
    # but incomplete mutation attribution can never authorize PASS or a
    # terminal FAIL. Keep the proof explicitly resumable as INCOMPLETE/21.
    pass_eligible=false
    terminal_cleanup_status="${EXIT_INCOMPLETE}"
    terminal_rejection_reason="PROVIDER_ATTRIBUTION_INVALID"
  fi
  # A boot transition never admits PASS, but it must not prevent a fully
  # contained recovery from releasing its exact durable lease as INCOMPLETE.
  # Check once after the final provider read and again after watchdog disarm so
  # every PASS-capable path is bound to the boot that armed/opened the window.
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    operation_status=0
    run_patch_operation window-boot-guard || operation_status=$?
    if (( operation_status != 0 )); then
      # A boot transition (or an unreadable boot identity) breaks the durable
      # fail-safe continuity proof even when the already-contained host remains
      # physically stopped.  Preserve that factual cause in terminal evidence.
      merge_patch '{"watchdog":{"failSafeContained":false}}' || status="${EXIT_INCOMPLETE}"
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
      terminal_rejection_reason="BOOT_GUARD_INVALID"
    fi
  fi
  if (( status == 0 )); then
    # A canary scan is a point-in-time observation, not a monotone authority.
    # Repeat it on every attempt immediately before GC or PASS; a crash after
    # an older successful scan must not authorize deletion or terminalization
    # after new residue appears.
    operation_status=0
    run_patch_operation origin-secret-scan || operation_status=$?
    (( operation_status == 0 || status != 0 )) || status="${operation_status}"
    (( operation_status != 0 )) || maybe_crash after_origin_secret_scan
  fi
  if (( status == 0 )) && ! require_facts '.origin.tokenFileRemoved == true and .containment.tokenRemoved == true'; then
    if (( status == 0 )); then
      merge_patch '{"intents":{"originGcAttempted":true}}' || status="${EXIT_INCOMPLETE}"
    fi
    if (( status == 0 )); then
      operation_status=0
      run_patch_operation origin-gc || operation_status=$?
      (( operation_status == 0 || status != 0 )) || status="${operation_status}"
      (( operation_status != 0 )) || maybe_crash after_origin_gc
    fi
  fi
  operation_status=0
  run_patch_operation counts-after || operation_status=$?
  (( operation_status == 0 || status != 0 )) || status="${operation_status}"
  if (( status == 0 )) && [[ "${pass_eligible}" == true ]]; then
    operation_status=0
    run_patch_operation final-postflight || operation_status=$?
    (( operation_status == 0 || status != 0 )) || status="${operation_status}"
  elif (( status == 0 )); then
    # A reboot, monotonic-clock failure or earlier terminal ambiguity has
    # already made PASS impossible.  A final ADR 0034 request is bound to the
    # boot that armed the window and cannot succeed after that boundary is
    # lost.  Do not let the impossible PASS proof block physical cleanup,
    # watchdog disarm and monotonic lease release as INCOMPLETE/21.
    merge_patch '{"containment":{"coreHealthy":false,"finalPostflightContained":false,"finalPostflightPass":false,"financialQuiescent":false,"financialStable":false,"liveDisabled":false},"probes":{"finalPostflight":{"capturedAt":null,"contained":false,"evidenceSha256":"0000000000000000000000000000000000000000000000000000000000000000","officialValidator":false,"revisionMatches":false,"validationSha256":"0000000000000000000000000000000000000000000000000000000000000000","validUntil":null}}}' || status="${EXIT_INCOMPLETE}"
  fi
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    operation_status=0
    run_patch_operation window-boot-guard || operation_status=$?
    if (( operation_status != 0 )); then
      merge_patch '{"watchdog":{"failSafeContained":false}}' || status="${EXIT_INCOMPLETE}"
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
      terminal_rejection_reason="BOOT_GUARD_INVALID"
    fi
  fi
  # Establish the provider+inert-host receipt after the final postflight and
  # immediately before contained_verified while the watchdog is still armed.
  # A second observation after disarm closes the later finalization race.
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    operation_status=0
    run_patch_operation origin-status || operation_status=$?
    if (( operation_status != 0 )); then
      merge_patch '{"containment":{"originHeaderRemoved":false},"origin":{"headerRemoved":false,"unboundDeployed":false}}' || true
      status="${operation_status}"
    fi
  fi
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" != true ]]; then
    if jq --exit-status --slurpfile control "${CONTROL_FILE}" '
      (if .intents.countsBeforeAttempted == true then
        .counts.before == ($control[0].postIncidentBaseline | del(.snapshotSha256))
        and .counts.after == .counts.before
        and .database.after == .database.before
      else
        .counts.after == ($control[0].postIncidentBaseline | del(.snapshotSha256))
      end)
      and .database.after.activeWorkflows == 0
      and .database.after.liveInstallations == 0
      and .database.after.liveTenants == 0
      and .database.after.preparedTransactions == 0
    ' "${FACTS_FILE}" >/dev/null; then
      if require_facts '.intents.countsBeforeAttempted == true'; then
        merge_patch "$(jq --compact-output --sort-keys '{counts:{during:.counts.before,quiescent:true,unchanged:true},database:{during:.database.before,quiescent:true,stable:true}}' "${FACTS_FILE}")" || status="${EXIT_FAIL}"
      else
        merge_patch "$(jq --compact-output --sort-keys '{counts:{before:.counts.after,during:.counts.after,quiescent:true,unchanged:true},database:{before:.database.after,during:.database.after,quiescent:true,stable:true}}' "${FACTS_FILE}")" || status="${EXIT_FAIL}"
      fi
    else
      status="${EXIT_FAIL}"
    fi
  fi
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    # A third party closing an already-open edge is safe, but it is not proof
    # that this exact state machine performed its required close.  Likewise,
    # every public mutation has an exact cardinality.  Preserve containment,
    # disarm/release normally, and return a deterministic FAIL rather than
    # allowing the outer validator to discover a false runner PASS later.
    if ! jq --exit-status '
      .mutations.originUpdates == 2
      and .mutations.watchdogArms == 1
      and .mutations.firewallOpens == 1
      and .mutations.firewallCloses >= 1
      and .mutations.caddyStarts == 1
    ' "${FACTS_FILE}" >/dev/null; then
      pass_eligible=false
      terminal_cleanup_status="${EXIT_FAIL}"
      terminal_rejection_reason="MUTATION_CARDINALITY_INVALID"
    fi
  fi
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    if ! jq --exit-status '
      .counts.before == .counts.during
      and .counts.before == .counts.after
      and .counts.after.unreleasedPaymentGuards == 0
      and .counts.after.activeFinancialJobs == 0
      and .database.before == .database.during
      and .database.before == .database.after
      and .database.after.activeWorkflows == 0
      and .database.after.liveInstallations == 0
      and .database.after.liveTenants == 0
      and .database.after.preparedTransactions == 0
      and .firewall.finalClosed == true
      and .firewall.closeAmbiguous == false
      and .origin.headerRemoved == true
      and .origin.tokenFileRemoved == true
      and (.containment | del(.markerComplete,.watchdogDisarmed) | [.[]] | all)
    ' "${FACTS_FILE}" >/dev/null; then
      status="${EXIT_FAIL}"
    fi
  fi
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    merge_patch '{"counts":{"quiescent":true,"unchanged":true},"database":{"quiescent":true,"stable":true}}' || status="${EXIT_FAIL}"
  fi
  # Persist the latest contained facts while the host lease and watchdog still
  # block every concurrent launcher. This is not `contained_verified`: no PASS
  # candidate has yet crossed watchdog disarm or the official validator.
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    write_run_marker ingress_closed || status="${EXIT_FAIL}"
    if (( status == 0 )); then
      increment_mutation markerTransitions || status="${EXIT_FAIL}"
    fi
    if (( status == 0 )); then
      maybe_crash after_contained_verified
    fi
  fi
  # Counts and the official ADR0034 capture run while both the durable host
  # lease and watchdog are still active.  Disarm and verify the watchdog while
  # the lease is still held; only then publish lease complete and release it.
  # Any ambiguity retains all three interlocks for a later cleanup attempt.
  if (( firewall_status == 0 && status == 0 )); then
    operation_status=0
    run_patch_operation watchdog-disarm "${pass_eligible}" || operation_status=$?
    if (( operation_status == 0 )); then
      watchdog_disarmed=true
      if require_facts '.intents.watchdogArmAttempted == true or .mutations.watchdogArms > 0' &&
        ! require_facts '.watchdog.failSafeContained == true'; then
        pass_eligible=false
        terminal_cleanup_status="${EXIT_INCOMPLETE}"
        terminal_rejection_reason="WATCHDOG_CONTINUITY_INVALID"
      fi
    else
      status="${operation_status}"
    fi
    (( operation_status != 0 )) || maybe_crash after_watchdog_disarm_returned
  fi
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    operation_status=0
    run_patch_operation window-boot-guard || operation_status=$?
    if (( operation_status != 0 )); then
      merge_patch '{"watchdog":{"failSafeContained":false}}' || status="${EXIT_INCOMPLETE}"
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
      terminal_rejection_reason="BOOT_GUARD_INVALID"
    fi
  fi
  # The official host capture does not inspect CloudFront configuration. Run
  # the terminal provider+inert-host read only after the final postflight,
  # watchdog disarm and boot guard.  This is the last remote observation before
  # the provisional evidence is built and the durable lease can be consumed.
  if (( status == 0 )); then
    operation_status=0
    run_patch_operation origin-status || operation_status=$?
    if (( operation_status != 0 )); then
      merge_patch '{"containment":{"originHeaderRemoved":false},"origin":{"headerRemoved":false,"unboundDeployed":false}}' || true
      status="${operation_status}"
    elif ! require_facts '.watchdog.failSafeContained == true'; then
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
      terminal_rejection_reason="WATCHDOG_CONTINUITY_INVALID"
    fi
  fi
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    # The pre-GC scan cannot authorize PASS after the final postflight wait,
    # provider observations and watchdog disarm. Re-scan the current bounded
    # local+host allowlist at the terminal boundary; no later operation is
    # permitted to create origin recovery material or secret-bearing files.
    operation_status=0
    run_patch_operation origin-secret-scan || operation_status=$?
    (( operation_status == 0 || status != 0 )) || status="${operation_status}"
  fi
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    # Capture completion only after watchdog disarm has returned and
    # immediately before the PASS bytes are built.  This prevents a slow
    # disarm from crossing an authorization/freshness boundary while evidence
    # retains an earlier timestamp.
    terminal_timestamp_status=0
    if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
      "${REFUNDDESK_EDGE_WINDOW_TEST_TERMINAL_TIMESTAMP_FAIL_ONCE:-}" == "1" ]]; then
      "${COMMAND_ADAPTER}" terminal-timestamp-gate || terminal_timestamp_status=$?
    fi
    if (( terminal_timestamp_status == 0 )); then
      COMPLETED_AT="$(timestamp_now)" || terminal_timestamp_status=$?
    fi
    if (( terminal_timestamp_status != 0 )); then
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
      terminal_rejection_reason="TERMINAL_TIMESTAMP_INVALID"
    fi
    terminal_temporal_status=0
    if [[ "${pass_eligible}" == true && "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
      "${REFUNDDESK_EDGE_WINDOW_TEST_TERMINAL_TEMPORAL_FAIL_ONCE:-}" == "1" ]]; then
      "${COMMAND_ADAPTER}" terminal-temporal-gate || terminal_temporal_status=$?
    fi
    if [[ "${pass_eligible}" == true ]] && (( terminal_temporal_status == 0 )) &&
      ! python3 - "${OPERATION_STARTED_AT}" "${STARTED_AT}" "${ARMED_AT}" "${OPENED_AT}" "${CLOSED_AT}" "${DEADLINE_AT}" "${COMPLETED_AT}" "${CONTROL_FILE}" "${FACTS_FILE}" <<'PYTIME'
import datetime as dt
import json
import pathlib
import sys

operation_started, started, armed, opened, closed, deadline, completed, control_path, facts_path = sys.argv[1:]

def instant(value: str) -> dt.datetime:
    parsed = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    return parsed.replace(tzinfo=dt.timezone.utc)

control = json.loads(pathlib.Path(control_path).read_text(encoding="utf-8"))
facts = json.loads(pathlib.Path(facts_path).read_text(encoding="utf-8"))
times = list(map(instant, (operation_started, started, armed, opened, closed, deadline, completed)))
operation_value, started_value, armed_value, opened_value, closed_value, deadline_value, completed_value = times
final_capture = instant(facts["probes"]["finalPostflight"]["capturedAt"])
final_valid_until = instant(facts["probes"]["finalPostflight"]["validUntil"])
authorization_from = instant(control["admission"]["authorizationValidFrom"])
authorization_until = instant(control["admission"]["authorizationValidUntil"])
if not (
    authorization_from <= operation_value <= started_value <= armed_value <= opened_value <= closed_value <= deadline_value
    and closed_value <= final_capture <= completed_value
    and completed_value <= authorization_until
    and completed_value <= final_valid_until
    and (completed_value - operation_value).total_seconds() <= 35 * 60
):
    raise SystemExit(1)
PYTIME
    then
      terminal_temporal_status=1
    fi
    if [[ "${pass_eligible}" == true ]] && (( terminal_temporal_status != 0 )); then
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
      terminal_rejection_reason="TERMINAL_TEMPORAL_BOUNDS_INVALID"
      if [[ -n "${CLOSED_AT}" && -n "${OPENED_AT}" ]] &&
        (( $(timestamp_epoch "${CLOSED_AT}") < $(timestamp_epoch "${OPENED_AT}") )); then
        # Preserve the monotonic close proof in watchdog facts, but do not
        # publish an invalid wall-clock close instant after a detected rollback.
        CLOSED_AT=""
      fi
    fi
  fi
  # Persist the complete PASS bytes while the host lease is still held.  The
  # run journal deliberately remains contained_verified until the holder has
  # been completed and released, so a crash can only resume finalization and
  # can never consume the evidence while authority is still held.
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    if ! jq --exit-status '
      ([.containment[]] | all)
      and .counts.unchanged == true and .counts.quiescent == true
      and .database.stable == true and .database.quiescent == true
      and .watchdog.disarmed == true and .watchdog.markerComplete == true
    ' "${FACTS_FILE}" >/dev/null; then
      status="${EXIT_FAIL}"
    fi
  fi
  if (( firewall_status == 0 && status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]]; then
    RESULT="PASS"
    CODE="${PASS_CODE}"
    RESULT_EXIT=0
    FAILURE_DIAGNOSTICS=()
    STATE="complete"
    persist_evidence
    # Embed the immutable candidate under a non-terminal state before running
    # the official validator. A crash during validation can reconstruct only
    # these exact bytes and must revalidate them; it cannot rebuild a more
    # favorable candidate from mutable current state.
    candidate_sha="$(hash_file "${EVIDENCE_PENDING_FILE}")" || status="${EXIT_INCOMPLETE}"
    if (( status == 0 )); then
      write_run_marker contained_disarmed_pending_validation "${candidate_sha}" "${FACTS_FILE}" "${EVIDENCE_PENDING_FILE}" false || status="${EXIT_INCOMPLETE}"
    fi
    if (( status == 0 )); then
      STATE="contained_disarmed_pending_validation"
      maybe_crash after_pass_candidate_embedded_before_validation
    fi
    # Only exact bytes already accepted by the public validator may become a
    # contained_verified journal authority or the published evidence path.
    if (( status == 0 )) && final_evidence_ready "${EVIDENCE_PENDING_FILE}" "${candidate_sha}"; then
      publish_prepared_evidence contained_verified "${candidate_sha}"
      STATE="contained_verified"
      maybe_crash after_success_evidence
    elif (( status == 0 )); then
      # The exact public validator is the final authority before the durable
      # authorization/lease markers can be consumed.  A mismatch after safe
      # disarm remains a fully contained FAIL20; release the lease with PASS
      # disabled. The rejection latch is durable before every later crash
      # point, including `after_watchdog_disarmed`.
      terminal_cleanup_status="${EXIT_FAIL}"
      terminal_rejection_reason="OFFICIAL_VALIDATOR_REJECTED"
      latch_terminal_proof_rejection "${terminal_cleanup_status}" "${terminal_rejection_reason}" || status="${EXIT_INCOMPLETE}"
    fi
  fi
  if (( firewall_status == 0 && status == 0 )); then
    if [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" != true ]] &&
      ! require_facts '.intents.abortRequested == true'; then
      # Every post-containment proof/timestamp rejection is monotone. Persist
      # it before the crash hook so a transient failure cannot disappear on a
      # later cleanup replay and rebuild PASS.
      if [[ "${terminal_cleanup_status}" != "${EXIT_FAIL}" && "${terminal_cleanup_status}" != "${EXIT_INCOMPLETE}" ]]; then
        terminal_cleanup_status="${EXIT_INCOMPLETE}"
      fi
      [[ -n "${terminal_rejection_reason}" ]] || terminal_rejection_reason="TERMINAL_PROOF_INCOMPLETE"
      latch_terminal_proof_rejection "${terminal_cleanup_status}" "${terminal_rejection_reason}" || status="${EXIT_INCOMPLETE}"
    fi
    maybe_crash after_watchdog_disarmed
    if [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]] &&
      ! pass_completion_guard; then
      invalidate_provisional_pass || status="${EXIT_INCOMPLETE}"
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
    fi
    operation_status=0
    run_patch_operation host-lease-complete "${pass_eligible}" || operation_status=$?
    if (( operation_status != 0 )) && [[ "${pass_eligible}" == true ]]; then
      invalidate_provisional_pass || true
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
    fi
    (( operation_status == 0 || status != 0 )) || status="${operation_status}"
    (( status != 0 )) || maybe_crash after_host_lease_complete
  fi
  if (( firewall_status == 0 && status == 0 )); then
    operation_status=0
    run_patch_operation host-lease-release "${pass_eligible}" || operation_status=$?
    if (( operation_status != 0 )) && [[ "${pass_eligible}" == true ]]; then
      invalidate_provisional_pass || true
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
    fi
    (( operation_status == 0 || status != 0 )) || status="${operation_status}"
    (( status != 0 )) || maybe_crash after_host_lease_release
  fi
  if (( firewall_status == 0 && status == 0 )); then
    operation_status=0
    if [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true &&
      "${EVIDENCE_AUTHORITY_SHA}" =~ ^[0-9a-f]{64}$ && -n "${EVIDENCE_AUTHORITY_BYTES}" ]]; then
      run_patch_operation host-lease-finalization-status || operation_status=$?
    else
      run_patch_operation host-lease-finalization-status false false || operation_status=$?
    fi
    if (( operation_status != 0 )) && [[ "${pass_eligible}" == true ]]; then
      invalidate_provisional_pass || true
      pass_eligible=false
      terminal_cleanup_status="${EXIT_INCOMPLETE}"
    fi
    (( operation_status == 0 || status != 0 )) || status="${operation_status}"
  fi
  if (( firewall_status == 0 && status == 0 )) &&
    [[ "${FUNCTIONAL_GATE_PASSED}" == true && "${pass_eligible}" == true ]] &&
    ! pass_completion_guard; then
    invalidate_provisional_pass || status="${EXIT_INCOMPLETE}"
    pass_eligible=false
    terminal_cleanup_status="${EXIT_INCOMPLETE}"
  fi
  if [[ "${watchdog_disarmed}" == true && -f "${WATCHDOG_MARKER}" ]]; then
    rm --force -- "${WATCHDOG_MARKER}" || status="${EXIT_FAIL}"
    sync --file-system "${CONTROL_ROOT}" 2>/dev/null || sync "${CONTROL_ROOT}" ||
      status="${EXIT_FAIL}"
  fi
  if (( status != 0 )); then
    return "${status}"
  fi
  CLEANUP_CONVERGED=true
  return "${terminal_cleanup_status}"
}

normalize_failure() {
  local requested="$1" requested_exit="${2:-${EXIT_FAIL}}"
  case "${requested}" in
    ETAG_RACE) CODE="ORIGIN_CONFIGURATION_AMBIGUOUS" ;;
    NEVER_DEPLOYED) CODE="ORIGIN_DEPLOYMENT_TIMEOUT" ;;
    PREFIX_STALE) CODE="PREFIX_DOCUMENT_STALE" ;;
    PREFIX_MALFORMED) CODE="PREFIX_DOCUMENT_INVALID" ;;
    WATCHDOG_INVALID) CODE="WATCHDOG_ARM_FAILED" ;;
    FIREWALL_INVALID) CODE="FIREWALL_OPEN_INVALID" ;;
    LOCAL_PROBE_INVALID) CODE="LOCAL_PROBE_FAILED" ;;
    PUBLIC_HEALTH_INVALID) CODE="PUBLIC_HEALTH_FAILED" ;;
    CHECKPOINT_TIMEOUT) CODE="WORKBENCH_CHECKPOINT_TIMEOUT" ;;
    CHECKPOINT_INVALID) CODE="WORKBENCH_CHECKPOINT_INVALID" ;;
    COUNTS_CHANGED) CODE="DURABLE_COUNTS_CHANGED" ;;
    CLOSE_AMBIGUOUS) CODE="FIREWALL_CLOSE_AMBIGUOUS" ;;
    FINAL_CONTAINMENT_INVALID) CODE="FINAL_CONTAINMENT_FAILED" ;;
    ADMISSION_INVALID) CODE="ADMISSION_EVIDENCE_INVALID" ;;
    SOURCE_INVALID) CODE="SOURCE_PROVENANCE_INVALID" ;;
    TOPOLOGY_INVALID) CODE="TOPOLOGY_BINDING_INVALID" ;;
    TOOL_UNAVAILABLE) CODE="TOOL_UNAVAILABLE" ; requested_exit="${EXIT_INCOMPLETE}" ;;
    *)
      if (( requested_exit == EXIT_INCOMPLETE )); then
        CODE="CONTROL_PLANE_UNAVAILABLE"
      else
        CODE="FINAL_CONTAINMENT_FAILED"
      fi
      ;;
  esac
  RESULT_EXIT="${requested_exit}"
  if (( RESULT_EXIT == EXIT_INCOMPLETE )); then
    RESULT="INCOMPLETE"
  else
    RESULT="FAIL"
  fi
  FAILURE_DIAGNOSTICS=("${CODE}")
}

persist_evidence() {
  local temporary output_size diagnostics_json completed_epoch closed_epoch final_postflight_epoch
  temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-output.XXXXXXXXXX')" || exit "${EXIT_INCOMPLETE}"
  if [[ -z "${COMPLETED_AT}" ]]; then
    COMPLETED_AT="$(timestamp_now)" || exit "${EXIT_INCOMPLETE}"
  fi
  if [[ "${RESULT}" == "PASS" ]]; then
    completed_epoch="$(timestamp_epoch "${COMPLETED_AT}")" || exit "${EXIT_INCOMPLETE}"
    closed_epoch="$(timestamp_epoch "${CLOSED_AT}")" || exit "${EXIT_INCOMPLETE}"
    final_postflight_epoch="$(timestamp_epoch "$(jq --raw-output '.probes.finalPostflight.capturedAt' "${FACTS_FILE}")")" || exit "${EXIT_INCOMPLETE}"
    (( completed_epoch >= closed_epoch && completed_epoch >= final_postflight_epoch )) || exit "${EXIT_INCOMPLETE}"
  fi
  diagnostics_json="$(printf '%s\n' "${FAILURE_DIAGNOSTICS[@]:-}" | sed '/^$/d' | sort -u | jq --raw-input --slurp 'split("\n") | map(select(length > 0))')"
  jq --null-input --compact-output --sort-keys \
    --slurpfile control "${CONTROL_FILE}" \
    --slurpfile facts "${FACTS_FILE}" \
    --arg code "${CODE}" \
    --arg completedAt "${COMPLETED_AT}" \
    --argjson diagnostics "${diagnostics_json}" \
    --argjson exitCode "${RESULT_EXIT}" \
    --arg expectedRevision "${EXPECTED_REVISION}" \
    --arg nonce "${NONCE}" \
    --arg operationStartedAt "${OPERATION_STARTED_AT}" \
    --arg result "${RESULT}" \
    --arg startedAt "${STARTED_AT}" \
    --arg closedAt "${CLOSED_AT}" \
    --arg deadlineAt "${DEADLINE_AT}" \
    --arg openedAt "${OPENED_AT}" \
    --arg runnerBootIdentifierSha256 "${RUNNER_BOOT_IDENTIFIER_SHA256}" \
    --argjson runnerDeadlineBoottimeMilliseconds "${RUNNER_DEADLINE_BOOTTIME_MILLISECONDS}" \
    --argjson runnerStartedBoottimeMilliseconds "${RUNNER_STARTED_BOOTTIME_MILLISECONDS}" \
    --arg state "${STATE}" '
      ($control[0]) as $c | ($facts[0]) as $f |
      {
        admission:$c.admission,
        code:$code,
        completedAt:$completedAt,
        containment:$f.containment,
        counts:$f.counts,
        database:$f.database,
        diagnostics:$diagnostics,
        exitCode:$exitCode,
        expectedRevision:$expectedRevision,
        firewall:$f.firewall,
        interlocksAtCapture:{
          authorizationMarkerState:$f.hostLease.authorizationMarkerState,
          holderActive:$f.hostLease.holderActive,
          hostLeaseMarkerState:$f.hostLease.hostLeaseMarkerState,
          watchdogMarkerState:(if $f.watchdog.markerComplete == true then "complete" elif $f.watchdog.activeBeforeIngress == true then "armed" else "absent" end)
        },
        kind:"refunddesk.lightsail.edge-window",
        mutations:$f.mutations,
        nonce:$nonce,
        operationStartedAt:$operationStartedAt,
        origin:$f.origin,
        prefixes:$f.prefixes,
        probes:$f.probes,
        provenance:($c.provenance + {
          operationRemainingSecondsAtRunnerStart:$c.operationRemainingSecondsAtRunnerStart,
          operatorBootIdentifierSha256:$c.operatorBootIdentifierSha256,
          operatorControlCalculatedMonotonicMilliseconds:$c.operatorControlCalculatedMonotonicMilliseconds,
          operatorDeadlineMonotonicMilliseconds:$c.operatorDeadlineMonotonicMilliseconds,
          operatorStartedMonotonicMilliseconds:$c.operatorStartedMonotonicMilliseconds,
          runnerBootIdentifierSha256:$runnerBootIdentifierSha256,
          runnerDeadlineBoottimeMilliseconds:$runnerDeadlineBoottimeMilliseconds,
          runnerStartedBoottimeMilliseconds:$runnerStartedBoottimeMilliseconds
        }),
        redaction:$f.redaction,
        result:$result,
        schemaVersion:1,
        startedAt:$startedAt,
        topology:$f.topology,
        watchdog:$f.watchdog,
        window:{closedAt:(if $closedAt == "" then null else $closedAt end),deadlineAt:$deadlineAt,durationSeconds:$c.windowSeconds,openedAt:(if $openedAt == "" then null else $openedAt end),retryAuthorized:false,state:$state}
      }
    ' >"${temporary}" || exit "${EXIT_INCOMPLETE}"
  output_size="$(wc --bytes <"${temporary}")"
  (( output_size <= MAX_OUTPUT_BYTES )) || exit "${EXIT_INCOMPLETE}"
  chmod 600 "${temporary}" || exit "${EXIT_INCOMPLETE}"
  sync --file-system "${temporary}" 2>/dev/null || sync "${temporary}" || exit "${EXIT_INCOMPLETE}"
  EVIDENCE_PENDING_FILE="${temporary}"
}

publish_prepared_evidence() {
  local journal_state="$1" evidence_sha="${2:-}" journal_temporary="" publication_temporary
  [[ -n "${EVIDENCE_PENDING_FILE}" && -f "${EVIDENCE_PENDING_FILE}" && ! -L "${EVIDENCE_PENDING_FILE}" ]] ||
    exit "${EXIT_INCOMPLETE}"
  if [[ -z "${evidence_sha}" ]]; then
    evidence_sha="$(hash_file "${EVIDENCE_PENDING_FILE}")" || exit "${EXIT_INCOMPLETE}"
    write_run_marker "${journal_state}" "${evidence_sha}" "${FACTS_FILE}" "${EVIDENCE_PENDING_FILE}" false ||
      exit "${EXIT_INCOMPLETE}"
  else
    [[ "${EVIDENCE_AUTHORITY_SHA}" == "${evidence_sha}" && -n "${EVIDENCE_AUTHORITY_BYTES}" ]] ||
      exit "${EXIT_INCOMPLETE}"
    journal_temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-evidence-journal.XXXXXXXXXX')" ||
      exit "${EXIT_INCOMPLETE}"
    printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" >"${journal_temporary}" ||
      exit "${EXIT_INCOMPLETE}"
    chmod 600 "${journal_temporary}" || exit "${EXIT_INCOMPLETE}"
    sync --file-system "${journal_temporary}" 2>/dev/null || sync "${journal_temporary}" ||
      exit "${EXIT_INCOMPLETE}"
    write_run_marker "${journal_state}" "${evidence_sha}" "${FACTS_FILE}" "${journal_temporary}" false ||
      exit "${EXIT_INCOMPLETE}"
    rm --force -- "${journal_temporary}" || exit "${EXIT_INCOMPLETE}"
  fi
  [[ "${evidence_sha}" =~ ^[0-9a-f]{64}$ ]] || exit "${EXIT_INCOMPLETE}"
  # The journal is the authority. Embed canonical bytes and their digest before
  # publishing the convenience pathname, then record that publication in a
  # second marker replace. A crash at either boundary restores only from the
  # embedded bytes; an unbound pathname is never adopted.
  maybe_crash after_evidence_embedded_before_publish
  # Never move or re-adopt the mutable candidate pathname after validation.
  # Reconstruct the convenience file exclusively from the bytes embedded in
  # the journal above, whose digest is the caller-supplied authority.
  publication_temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-evidence-publish.XXXXXXXXXX')" ||
    exit "${EXIT_INCOMPLETE}"
  printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" >"${publication_temporary}" ||
    exit "${EXIT_INCOMPLETE}"
  chmod 600 "${publication_temporary}" || exit "${EXIT_INCOMPLETE}"
  sync --file-system "${publication_temporary}" 2>/dev/null || sync "${publication_temporary}" ||
    exit "${EXIT_INCOMPLETE}"
  rm --force -- "${EVIDENCE_PENDING_FILE}" || exit "${EXIT_INCOMPLETE}"
  durable_replace "${EVIDENCE_FILE}" "${publication_temporary}" || exit "${EXIT_INCOMPLETE}"
  EVIDENCE_PENDING_FILE=""
  maybe_crash after_evidence_publish_before_published_marker
  write_run_marker "${journal_state}" "${evidence_sha}" "${FACTS_FILE}" "${EVIDENCE_FILE}" true ||
    exit "${EXIT_INCOMPLETE}"
  maybe_crash after_evidence_published_marker
}

emit_authoritative_evidence() {
  [[ "${EVIDENCE_AUTHORITY_SHA}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ -n "${EVIDENCE_AUTHORITY_BYTES}" ]] || return 1
  [[ "$(printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" | sha256sum | cut -d ' ' -f 1)" == "${EVIDENCE_AUTHORITY_SHA}" ]] ||
    return 1
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
    "${REFUNDDESK_EDGE_WINDOW_TEST_SUBSTITUTE_EVIDENCE_BEFORE_OUTPUT:-}" == "1" ]]; then
    "${COMMAND_ADAPTER}" evidence-substitute-before-output "${EVIDENCE_FILE}" || return 1
  fi
  printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" >&3
}

emit_evidence() {
  local evidence_sha
  [[ "${OUTPUT_EMITTED}" == false ]] || exit "${RESULT_EXIT}"
  OUTPUT_EMITTED=true
  persist_evidence
  # A terminal failure is just as immutable as a PASS.  Embed the exact
  # canonical bytes in the durable run journal before exposing stdout so a
  # wrapper crash after the runner exits cannot lose or relabel exit 20/21.
  # If power is lost before this replacement, the private unbound pending file
  # is never adopted as authority; recovery rebuilds the result from the
  # journaled facts without replaying any effect.
  if [[ "${STATE}" == "failed_closed" ]]; then
    publish_prepared_evidence failed_closed
  else
    publish_prepared_evidence "${STATE}"
  fi
  emit_authoritative_evidence || exit "${EXIT_INCOMPLETE}"
  exit "${RESULT_EXIT}"
}

final_evidence_ready() {
  local evidence_path="${1:-${EVIDENCE_FILE}}" expected_sha="${2:-${EVIDENCE_AUTHORITY_SHA}}"
  [[ "${expected_sha}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${EVIDENCE_AUTHORITY_SHA}" == "${expected_sha}" && -n "${EVIDENCE_AUTHORITY_BYTES}" ]] ||
    return 1
  [[ "$(printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" | sha256sum | cut -d ' ' -f 1)" == "${expected_sha}" ]] ||
    return 1
  (( ${#EVIDENCE_AUTHORITY_BYTES} + 1 <= MAX_OUTPUT_BYTES )) || return 1
  [[ "$(jq --compact-output --sort-keys . <<<"${EVIDENCE_AUTHORITY_BYTES}")" == "${EVIDENCE_AUTHORITY_BYTES}" ]] ||
    return 1
  jq --exit-status \
    --slurpfile control "${CONTROL_FILE}" \
    --slurpfile facts "${FACTS_FILE}" \
    --arg nonce "${NONCE}" \
    --arg operationStartedAt "${OPERATION_STARTED_AT}" \
    --arg revision "${EXPECTED_REVISION}" \
    --arg armedAt "${ARMED_AT}" \
    --arg deadlineAt "${DEADLINE_AT}" \
    --arg openedAt "${OPENED_AT}" \
    --arg closedAt "${CLOSED_AT}" '
      ($control[0]) as $c | ($facts[0]) as $f |
      .schemaVersion == 1 and .kind == "refunddesk.lightsail.edge-window"
      and .nonce == $nonce and .expectedRevision == $revision
      and .operationStartedAt == $operationStartedAt
      and .result == "PASS" and .code == "PASS_EDGE_WINDOW_RECONTAINED" and .exitCode == 0
      and .diagnostics == []
      and .admission == $c.admission and .provenance == $c.provenance
      and .containment == $f.containment and .counts == $f.counts and .database == $f.database
      and .firewall == $f.firewall and .mutations == $f.mutations
      and .origin == $f.origin and .prefixes == $f.prefixes and .probes == $f.probes
      and .redaction == $f.redaction and .topology == $f.topology and .watchdog == $f.watchdog
      and .window.state == "complete" and .window.retryAuthorized == false
      and .window.deadlineAt == $deadlineAt and .window.openedAt == $openedAt and .window.closedAt == $closedAt
      and .operationStartedAt <= .startedAt
      and .startedAt <= .watchdog.armedAt
      and .watchdog.armedAt <= .window.openedAt
      and .window.openedAt <= .window.closedAt
      and .window.closedAt <= .window.deadlineAt
      and .completedAt >= .window.closedAt
      and .completedAt >= .probes.finalPostflight.capturedAt
      and .completedAt <= .admission.authorizationValidUntil
      and .completedAt <= .probes.finalPostflight.validUntil
      and (.startedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and (.completedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and ([.containment[]] | all) and .counts.before == .counts.during and .counts.before == .counts.after
    ' <<<"${EVIDENCE_AUTHORITY_BYTES}" >/dev/null || return 1
  validate_pass_evidence_official || return 1
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" &&
    "${REFUNDDESK_EDGE_WINDOW_TEST_SUBSTITUTE_EVIDENCE_AFTER_VALIDATOR:-}" == "1" ]]; then
    "${COMMAND_ADAPTER}" evidence-substitute-after-validator "${evidence_path}" || return 1
  fi
  # Both the local joins and public validator consumed the in-memory bytes
  # already embedded in the journal. The pathname is only a derived copy; a
  # same-UID rename before, during or after validation cannot alter authority.
  [[ "$(printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" | sha256sum | cut -d ' ' -f 1)" == "${expected_sha}" ]]
}

pass_replay_still_fresh() {
  local observed_epoch operation_epoch completed_epoch authorization_valid_from
  local authorization_valid_until final_valid_until
  [[ -n "${INVOCATION_STARTED_AT}" ]] || return 1
  observed_epoch="$(timestamp_epoch "${INVOCATION_STARTED_AT}")" || return 1
  operation_epoch="$(timestamp_epoch "${OPERATION_STARTED_AT}")" || return 1
  completed_epoch="$(timestamp_epoch "$(jq --raw-output '.completedAt' <<<"${EVIDENCE_AUTHORITY_BYTES}")")" || return 1
  authorization_valid_from="$(timestamp_epoch "$(jq --raw-output '.admission.authorizationValidFrom' "${CONTROL_FILE}")")" || return 1
  authorization_valid_until="$(timestamp_epoch "$(jq --raw-output '.admission.authorizationValidUntil' "${CONTROL_FILE}")")" || return 1
  final_valid_until="$(timestamp_epoch "$(jq --raw-output '.probes.finalPostflight.validUntil' <<<"${EVIDENCE_AUTHORITY_BYTES}")")" || return 1
  (( authorization_valid_from <= observed_epoch )) || return 1
  (( operation_epoch <= completed_epoch && completed_epoch <= observed_epoch )) || return 1
  (( observed_epoch - operation_epoch <= EXECUTION_MAX_SECONDS )) || return 1
  (( observed_epoch <= authorization_valid_until )) || return 1
  (( observed_epoch <= final_valid_until ))
}

pass_completion_bounds() {
  [[ "${EVIDENCE_AUTHORITY_SHA}" =~ ^[0-9a-f]{64}$ && -n "${EVIDENCE_AUTHORITY_BYTES}" ]] || return 1
  python3 - "${OPERATION_STARTED_AT}" "${CONTROL_FILE}" \
    <(printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}") <<'PY'
import datetime as dt
import json
import pathlib
import sys

operation_started, control_path, evidence_path = sys.argv[1:]

def instant(value):
    parsed = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    return parsed.replace(tzinfo=dt.timezone.utc)

control = json.loads(pathlib.Path(control_path).read_text(encoding="utf-8"))
evidence = json.loads(pathlib.Path(evidence_path).read_text(encoding="utf-8"))
operation = instant(operation_started)
not_before = instant(evidence["completedAt"])
not_after = min(
    operation + dt.timedelta(minutes=35),
    instant(control["admission"]["authorizationValidUntil"]),
    instant(evidence["probes"]["finalPostflight"]["validUntil"]),
)
if not_before > not_after:
    raise SystemExit(1)
print(not_before.strftime("%Y-%m-%dT%H:%M:%SZ"))
print(not_after.strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
}

pass_completion_guard() {
  local observed observed_epoch not_before_epoch not_after_epoch operation_remaining
  local -a bounds
  mapfile -t bounds < <(pass_completion_bounds) || return 1
  (( ${#bounds[@]} == 2 )) || return 1
  observed="$(timestamp_now)" || return 1
  observed_epoch="$(timestamp_epoch "${observed}")" || return 1
  not_before_epoch="$(timestamp_epoch "${bounds[0]}")" || return 1
  not_after_epoch="$(timestamp_epoch "${bounds[1]}")" || return 1
  operation_remaining="$(operation_budget_remaining_seconds)" || return 1
  (( operation_remaining >= 0 )) || return 1
  (( not_before_epoch <= observed_epoch && observed_epoch <= not_after_epoch ))
}

terminal_reason_valid() {
  case "$1" in
    OFFICIAL_VALIDATOR_REJECTED | MUTATION_CARDINALITY_INVALID | \
      FIREWALL_ATTRIBUTION_AMBIGUOUS | WINDOW_CLOCK_INVALID | WINDOW_DEADLINE_EXCEEDED | \
      WATCHDOG_CONTINUITY_INVALID | BOOT_GUARD_INVALID | PROVIDER_ATTRIBUTION_INVALID | \
      TERMINAL_TIMESTAMP_INVALID | \
      TERMINAL_TEMPORAL_BOUNDS_INVALID | PASS_COMPLETION_INVALID | PASS_REPLAY_INVALID | \
      TERMINAL_PROOF_INCOMPLETE)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

invalidate_provisional_pass() {
  local reason="${1:-PASS_COMPLETION_INVALID}" patch
  terminal_reason_valid "${reason}" || return 1
  # Revoke the embedded PASS authority before deleting its derived pathname or
  # merging invalidation facts. A crash can then never resurrect provisional
  # bytes merely because evidence.json still exists.
  write_run_marker "${STATE}" "" "${FACTS_FILE}" || return 1
  rm --force -- "${EVIDENCE_FILE}" || return 1
  sync --file-system "${OPERATION_ROOT}" 2>/dev/null || sync "${OPERATION_ROOT}" || return 1
  patch="$(jq --null-input --compact-output --sort-keys --arg reason "${reason}" \
    '{containment:{finalPostflightPass:false},intents:{abortRequested:true,terminalReason:$reason},probes:{finalPostflight:{officialValidator:false}}}')" || return 1
  merge_patch "${patch}" || return 1
  RESULT="INCOMPLETE"
  CODE="FINAL_CONTAINMENT_FAILED"
  RESULT_EXIT="${EXIT_INCOMPLETE}"
  FAILURE_DIAGNOSTICS=("FINAL_CONTAINMENT_FAILED")
}

latch_terminal_proof_rejection() {
  local requested_exit="${1:-${EXIT_FAIL}}"
  local reason="${2:-OFFICIAL_VALIDATOR_REJECTED}" patch
  [[ "${requested_exit}" == "${EXIT_FAIL}" || "${requested_exit}" == "${EXIT_INCOMPLETE}" ]] || return 1
  terminal_reason_valid "${reason}" || return 1
  case "${reason}" in
    OFFICIAL_VALIDATOR_REJECTED | MUTATION_CARDINALITY_INVALID)
      [[ "${requested_exit}" == "${EXIT_FAIL}" ]] || return 1
      ;;
    *)
      [[ "${requested_exit}" == "${EXIT_INCOMPLETE}" ]] || return 1
      ;;
  esac
  # Revoke the unpublished candidate authority in the journal before deleting
  # any derived pathname. The durable abort fact makes every later replay
  # cleanup-only even if a transient validator/timestamp failure disappears.
  patch="$(jq --null-input --compact-output --sort-keys --arg reason "${reason}" \
    '{containment:{finalPostflightPass:false},intents:{abortRequested:true,terminalReason:$reason},probes:{finalPostflight:{officialValidator:false}}}')" || return 1
  merge_patch "${patch}" || return 1
  if [[ -n "${EVIDENCE_PENDING_FILE}" ]]; then
    rm --force -- "${EVIDENCE_PENDING_FILE}" || return 1
    EVIDENCE_PENDING_FILE=""
  fi
  rm --force -- "${EVIDENCE_FILE}" || return 1
  sync --file-system "${OPERATION_ROOT}" 2>/dev/null || sync "${OPERATION_ROOT}" || return 1
  if [[ "${requested_exit}" == "${EXIT_INCOMPLETE}" ]]; then
    RESULT="INCOMPLETE"
  else
    RESULT="FAIL"
  fi
  CODE="FINAL_CONTAINMENT_FAILED"
  RESULT_EXIT="${requested_exit}"
  FAILURE_DIAGNOSTICS=("FINAL_CONTAINMENT_FAILED")
  if [[ -n "${pass_eligible+x}" ]]; then
    pass_eligible=false
  fi
  if [[ -n "${terminal_cleanup_status+x}" ]]; then
    terminal_cleanup_status="${requested_exit}"
  fi
}

validate_pass_evidence_official() {
  local node_executable not_before not_after output
  local -a arguments
  [[ "${EVIDENCE_AUTHORITY_SHA}" =~ ^[0-9a-f]{64}$ && -n "${EVIDENCE_AUTHORITY_BYTES}" ]] || return 1
  node_executable="$(transport_value nodeExecutable)" || return 1
  not_before="$(jq --raw-output '.operationStartedAt' <<<"${EVIDENCE_AUTHORITY_BYTES}")" || return 1
  not_after="$(jq --raw-output '.completedAt' <<<"${EVIDENCE_AUTHORITY_BYTES}")" || return 1
  arguments=(
    scripts/validate-lightsail-edge-window.mjs
    -
    docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json
    "${NONCE}"
    "${EXPECTED_REVISION}"
    0
    "${not_before}"
    "${not_after}"
  )
  if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" == "1" ]]; then
    arguments+=(fixture)
    if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_OFFICIAL_VALIDATOR_FAIL_ONCE:-}" == "1" ]]; then
      "${COMMAND_ADAPTER}" official-validator-gate || return 1
    fi
  fi
  output="$(printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" |
    timeout --signal=TERM --kill-after=2s 30s "${node_executable}" "${arguments[@]}" 2>&1 |
    head --bytes=65)" || return 1
  (( ${#output} <= 64 )) || return 1
  [[ "${output}" == "${PASS_CODE}" ]]
}

terminal_failure_evidence_ready() {
  [[ "${EVIDENCE_AUTHORITY_SHA}" =~ ^[0-9a-f]{64}$ && -n "${EVIDENCE_AUTHORITY_BYTES}" ]] || return 1
  [[ "$(printf '%s\n' "${EVIDENCE_AUTHORITY_BYTES}" | sha256sum | cut -d ' ' -f 1)" == "${EVIDENCE_AUTHORITY_SHA}" ]] ||
    return 1
  (( ${#EVIDENCE_AUTHORITY_BYTES} + 1 <= MAX_OUTPUT_BYTES )) || return 1
  [[ "$(jq --compact-output --sort-keys . <<<"${EVIDENCE_AUTHORITY_BYTES}")" == "${EVIDENCE_AUTHORITY_BYTES}" ]] ||
    return 1
  jq --exit-status \
    --slurpfile control "${CONTROL_FILE}" \
    --slurpfile facts "${FACTS_FILE}" \
    --arg nonce "${NONCE}" \
    --arg operationStartedAt "${OPERATION_STARTED_AT}" \
    --arg revision "${EXPECTED_REVISION}" \
    --arg deadlineAt "${DEADLINE_AT}" \
    --arg openedAt "${OPENED_AT}" \
    --arg closedAt "${CLOSED_AT}" '
      ($control[0]) as $c | ($facts[0]) as $f |
      .schemaVersion == 1 and .kind == "refunddesk.lightsail.edge-window"
      and .nonce == $nonce and .expectedRevision == $revision
      and .operationStartedAt == $operationStartedAt
      and (((.result == "FAIL") and (.exitCode == 20)) or
        ((.result == "INCOMPLETE") and (.exitCode == 21)))
      and .code != "PASS_EDGE_WINDOW_RECONTAINED"
      and (.code | type == "string" and test("^[A-Z][A-Z0-9_]{2,63}$"))
      and (.diagnostics == [.code])
      and .admission == $c.admission and .provenance == $c.provenance
      and .containment == $f.containment and .counts == $f.counts and .database == $f.database
      and .firewall == $f.firewall and .mutations == $f.mutations
      and .origin == $f.origin and .prefixes == $f.prefixes and .probes == $f.probes
      and .redaction == $f.redaction and .topology == $f.topology and .watchdog == $f.watchdog
      and .window.state == "failed_closed" and .window.retryAuthorized == false
      and .window.deadlineAt == $deadlineAt
      and .window.openedAt == (if $openedAt == "" then null else $openedAt end)
      and .window.closedAt == (if $closedAt == "" then null else $closedAt end)
      and (.startedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and (.completedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    ' <<<"${EVIDENCE_AUTHORITY_BYTES}" >/dev/null
}

restore_embedded_evidence() {
  local expected_sha current_sha="" current_size="" evidence_temporary evidence_ready=false evidence_published
  expected_sha="$(jq --raw-output '.evidenceSha256 // empty' "${RUN_MARKER}")" || return 1
  [[ "${expected_sha}" =~ ^[0-9a-f]{64}$ ]] || return 1
  if controlled_file "${EVIDENCE_FILE}"; then
    current_size="$(stat --format='%s' -- "${EVIDENCE_FILE}")" || current_size=""
    if [[ "${current_size}" =~ ^[0-9]+$ ]] && (( current_size <= MAX_OUTPUT_BYTES )) &&
      [[ "$(jq --compact-output --sort-keys . "${EVIDENCE_FILE}" 2>/dev/null)" == "$(tr -d '\n' <"${EVIDENCE_FILE}")" ]]; then
      current_sha="$(hash_file "${EVIDENCE_FILE}")" || current_sha=""
      [[ "${current_sha}" == "${expected_sha}" ]] && evidence_ready=true
    fi
  fi

  # The canonical journal was validated, including the SHA of its embedded
  # evidence, before this helper is reached.  Repair an absent or substituted
  # convenience pathname atomically from that durable authority; never
  # relabel the recorded terminal exit because the derived copy drifted.
  if [[ "${evidence_ready}" != true ]]; then
    evidence_temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-evidence.XXXXXXXXXX')" || return 1
    jq --compact-output --sort-keys '.evidence' "${RUN_MARKER}" >"${evidence_temporary}" || return 1
    [[ "$(hash_file "${evidence_temporary}")" == "${expected_sha}" ]] || return 1
    durable_replace "${EVIDENCE_FILE}" "${evidence_temporary}" || return 1
  fi
  controlled_file "${EVIDENCE_FILE}" || return 1
  [[ "$(hash_file "${EVIDENCE_FILE}")" == "${expected_sha}" ]] || return 1
  evidence_published="$(jq --raw-output '.evidencePublished' "${RUN_MARKER}")" || return 1
  [[ "${evidence_published}" == true || "${evidence_published}" == false ]] || return 1
  if [[ "${evidence_published}" == false ]]; then
    write_run_marker "${STATE}" "${expected_sha}" "${FACTS_FILE}" "${EVIDENCE_FILE}" true || return 1
  fi
}

restore_embedded_validation_candidate() {
  local expected_sha candidate_temporary evidence_published
  [[ "${STATE}" == "contained_disarmed_pending_validation" ]] || return 1
  expected_sha="$(jq --raw-output '.evidenceSha256 // empty' "${RUN_MARKER}")" || return 1
  evidence_published="$(jq --raw-output '.evidencePublished' "${RUN_MARKER}")" || return 1
  [[ "${expected_sha}" =~ ^[0-9a-f]{64}$ && "${evidence_published}" == false ]] || return 1
  candidate_temporary="$(mktemp --tmpdir="${CONTROL_ROOT}" '.edge-window-evidence-candidate.XXXXXXXXXX')" || return 1
  jq --compact-output --sort-keys '.evidence' "${RUN_MARKER}" >"${candidate_temporary}" || return 1
  chmod 600 "${candidate_temporary}" || return 1
  [[ "$(hash_file "${candidate_temporary}")" == "${expected_sha}" ]] || return 1
  sync --file-system "${candidate_temporary}" 2>/dev/null || sync "${candidate_temporary}" || return 1
  EVIDENCE_PENDING_FILE="${candidate_temporary}"
}

replay_terminal_failure() {
  local result_exit
  [[ "${STATE}" == "failed_closed" ]] || return 1
  restore_embedded_evidence || return 1
  terminal_failure_evidence_ready || return 1
  result_exit="$(jq --raw-output '.exitCode' <<<"${EVIDENCE_AUTHORITY_BYTES}")" || return 1
  [[ "${result_exit}" == "${EXIT_FAIL}" || "${result_exit}" == "${EXIT_INCOMPLETE}" ]] || return 1
  emit_authoritative_evidence || return 1
  exit "${result_exit}"
}

abort_run() {
  local reason="$1" requested_exit="${2:-${EXIT_FAIL}}" cleanup_status=0
  trap - ERR HUP INT TERM
  if [[ -f "${FACTS_FILE}" ]]; then
    merge_patch '{"intents":{"abortRequested":true}}' || true
  fi
  normalize_failure "${reason}" "${requested_exit}"
  cleanup_surfaces || cleanup_status=$?
  if (( cleanup_status != 0 )); then
    RESULT="INCOMPLETE"
    RESULT_EXIT="${EXIT_INCOMPLETE}"
    if require_facts '.firewall.finalClosed == true and .firewall.closeAmbiguous == false'; then
      CODE="FINAL_CONTAINMENT_FAILED"
      FAILURE_DIAGNOSTICS=("FINAL_CONTAINMENT_FAILED")
    else
      CODE="FIREWALL_CLOSE_AMBIGUOUS"
      FAILURE_DIAGNOSTICS=("FIREWALL_CLOSE_AMBIGUOUS")
    fi
  fi
  STATE="failed_closed"
  emit_evidence
}

# shellcheck disable=SC2329 # invoked by the ERR trap below
unexpected_error() {
  abort_run CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
}

# shellcheck disable=SC2329 # invoked by the signal traps below
signal_error() {
  abort_run CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
}

trap unexpected_error ERR
trap signal_error HUP INT TERM

for required in awk cut date flock grep head jq mktemp python3 sed sha256sum sleep stat sync timeout tr wc; do
  command -v "${required}" >/dev/null 2>&1 || exit "${EXIT_INCOMPLETE}"
done
if [[ "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" != "1" ]]; then
  for required in aws curl ssh; do
    command -v "${required}" >/dev/null 2>&1 || exit "${EXIT_INCOMPLETE}"
  done
fi
directory_controlled "${CONTROL_ROOT}" || exit "${EXIT_INCOMPLETE}"
directory_controlled "${RUNTIME_ROOT}" || exit "${EXIT_INCOMPLETE}"
immutable_input_directory "$(dirname -- "${CONTROL_FILE}")" || input_boundary_failure
[[ "$(dirname -- "${CONTROL_FILE}")" == "$(dirname -- "${TRANSPORT_FILE}")" ]] || input_boundary_failure
if [[ "${REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-}" == "1" ]]; then
  immutable_input_file "${AWS_CONFIG_FILE}" || input_boundary_failure
fi
directory_controlled "$(dirname -- "${CHECKPOINT_FILE}")" || input_boundary_failure
directory_controlled "$(dirname -- "${CHECKPOINT_REQUEST_FILE}")" || input_boundary_failure

exec 9>"${OPERATOR_LOCK}" || exit "${EXIT_INCOMPLETE}"
flock --exclusive --nonblock 9 || exit "${EXIT_INCOMPLETE}"
STARTED_AT="$(timestamp_now)" || exit "${EXIT_INCOMPLETE}"
INVOCATION_STARTED_AT="${STARTED_AT}"
control_validation_status=0
if validate_control; then
  :
else
  control_validation_status=$?
  if (( control_validation_status == 2 )); then
    control_clock_contract_failure
  fi
  input_boundary_failure
fi
validate_transport || input_boundary_failure
OPERATION_STARTED_AT="${CONTROL_OPERATION_STARTED_AT}"
OPERATION_DEADLINE_AT="$(timestamp_add_seconds "${OPERATION_STARTED_AT}" "${EXECUTION_MAX_SECONDS}")" ||
  input_boundary_failure
timestamp_epoch "${OPERATION_DEADLINE_AT}" >/dev/null || input_boundary_failure
if [[ -e "${OPERATION_ROOT}" ]]; then
  [[ -d "${OPERATION_ROOT}" && ! -L "${OPERATION_ROOT}" && -e "${RUN_MARKER}" ]] ||
    exit "${EXIT_INCOMPLETE}"
  directory_controlled "${OPERATION_ROOT}" || exit "${EXIT_INCOMPLETE}"
  # Restore the minimal durable journal before deciding how to handle source
  # drift.  A mismatch after an effect may never be relabelled as a fresh
  # admission failure; the already-running, image-baked runner is restricted
  # to cleanup-only convergence below.
  validate_local_sources || LOCAL_SOURCES_VALID=false
else
  # A fresh invocation has no durable effect journal yet, so an invalid source
  # set is a complete pre-effect admission failure.
  validate_local_sources || exit "${EXIT_FAIL}"
  mkdir --mode=700 -- "${OPERATION_ROOT}" || exit "${EXIT_INCOMPLETE}"
  sync --file-system "${CONTROL_ROOT}" 2>/dev/null || sync "${CONTROL_ROOT}" ||
    exit "${EXIT_INCOMPLETE}"
  initialize_runner_operation_clock || exit "${EXIT_INCOMPLETE}"
fi

if [[ -e "${RUN_MARKER}" ]]; then
  restore_run_journal || exit "${EXIT_INCOMPLETE}"
  existing_state="${STATE}"
  if [[ "$(jq --raw-output '.evidenceSha256 // empty' "${RUN_MARKER}")" != "" ]]; then
    if [[ "${existing_state}" == "contained_disarmed_pending_validation" ]]; then
      restore_embedded_validation_candidate || exit "${EXIT_INCOMPLETE}"
    else
      restore_embedded_evidence || exit "${EXIT_INCOMPLETE}"
    fi
  fi
  if [[ "${OPERATION_CLOCK_VALID}" != true &&
    "${existing_state}" != "complete" && "${existing_state}" != "failed_closed" ]]; then
    # A reboot, boottime rollback or expiry can never mint a fresh runner
    # deadline from the still-valid control bytes. Existing nonterminal work is
    # cleanup-only. Already-terminal embedded 0/20/21 bytes remain immutable
    # replay authority and create no new effect or deadline.
    FUNCTIONAL_GATE_PASSED=false
    normalize_failure CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
    cleanup_surfaces || true
    exit "${EXIT_INCOMPLETE}"
  fi
  if [[ "${LOCAL_SOURCES_VALID}" != true ]]; then
    if require_facts '.intents.hostLeaseAcquireAttempted == true or .hostLease.held == true' ||
      [[ "${existing_state}" =~ ^(origin_bound|watchdog_armed|ingress_open|functional_gate_passed|ingress_closed|contained_disarmed_pending_validation|contained_verified)$ ]]; then
      HOST_LEASE_RECOVERY_REQUIRED=true
    fi
    # Source/provenance drift permanently disables PASS for this invocation.
    # Use only the monotone facts already restored from the journal to close
    # AWS first, contain the host and release exact interlocks.  Do not emit a
    # normal evidence document whose provenance assertions are known false.
    FUNCTIONAL_GATE_PASSED=false
    normalize_failure CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
    cleanup_surfaces || true
    exit "${EXIT_INCOMPLETE}"
  fi
  if [[ "${MODE}" != "cleanup" && "${existing_state}" == "failed_closed" ]]; then
    replay_terminal_failure || exit "${EXIT_INCOMPLETE}"
  fi
  if [[ "${existing_state}" == "complete" ]]; then
    restore_embedded_evidence || exit "${EXIT_INCOMPLETE}"
    final_evidence_ready "${EVIDENCE_FILE}" "${EVIDENCE_AUTHORITY_SHA}" || exit "${EXIT_INCOMPLETE}"
    jq --exit-status --arg nonce "${NONCE}" --arg revision "${EXPECTED_REVISION}" '
      .schemaVersion == 1 and .kind == "refunddesk.lightsail.edge-window"
      and .nonce == $nonce and .expectedRevision == $revision
      and .result == "PASS" and .code == "PASS_EDGE_WINDOW_RECONTAINED"
      and .exitCode == 0 and .window.state == "complete"
    ' <<<"${EVIDENCE_AUTHORITY_BYTES}" >/dev/null || exit "${EXIT_INCOMPLETE}"
    emit_authoritative_evidence || exit "${EXIT_INCOMPLETE}"
    exit 0
  fi

  if [[ "${existing_state}" == "contained_disarmed_pending_validation" ]]; then
    if final_evidence_ready "${EVIDENCE_PENDING_FILE}" "${EVIDENCE_AUTHORITY_SHA}"; then
      publish_prepared_evidence contained_verified "${EVIDENCE_AUTHORITY_SHA}"
      STATE="contained_verified"
      existing_state="contained_verified"
      maybe_crash after_success_evidence
    else
      latch_terminal_proof_rejection "${EXIT_FAIL}" OFFICIAL_VALIDATOR_REJECTED ||
        exit "${EXIT_INCOMPLETE}"
    fi
  fi

  contained_verified_ready=false
  if [[ "${existing_state}" == "contained_verified" ]]; then
    if [[ "${EVIDENCE_AUTHORITY_SHA}" =~ ^[0-9a-f]{64}$ ]] &&
      final_evidence_ready "${EVIDENCE_FILE}" "${EVIDENCE_AUTHORITY_SHA}"; then
      contained_verified_ready=true
    else
      invalidate_provisional_pass PASS_REPLAY_INVALID || exit "${EXIT_INCOMPLETE}"
    fi
  fi

  if [[ "${contained_verified_ready}" == true ]]; then
    pass_replay_ready=true
    # Historical PASS bytes do not lock CloudFront or the inert host. Before
    # consuming either completion marker, re-read provider/host state and bind
    # the boot again. The initial incident/postflight documents remain the
    # point-in-time admission captured at operationStartedAt; only the fixed
    # authorization budget and terminal postflight validity cover this replay.
    if ! run_patch_operation origin-status; then
      merge_patch '{"containment":{"originHeaderRemoved":false},"origin":{"headerRemoved":false,"unboundDeployed":false}}' || true
      pass_replay_ready=false
    fi
    if [[ "${pass_replay_ready}" == true ]] && ! run_patch_operation origin-secret-scan; then
      # A contained_verified marker binds historical PASS bytes, not the
      # current secret-bearing filesystem. Re-scan after every process death
      # before either lease/authorization completion marker can be consumed.
      pass_replay_ready=false
    fi
    if [[ "${pass_replay_ready}" == true ]] && ! run_patch_operation window-boot-guard; then
      merge_patch '{"watchdog":{"failSafeContained":false}}' || true
      pass_replay_ready=false
    fi
    if [[ "${pass_replay_ready}" == true ]] && ! pass_replay_still_fresh; then
      pass_replay_ready=false
    fi
    if [[ "${pass_replay_ready}" == true ]] &&
      ! final_evidence_ready "${EVIDENCE_FILE}" "${EVIDENCE_AUTHORITY_SHA}"; then
      pass_replay_ready=false
    fi
    if [[ "${pass_replay_ready}" == true ]] && ! pass_completion_guard; then
      invalidate_provisional_pass || exit "${EXIT_INCOMPLETE}"
      pass_replay_ready=false
    fi
    if [[ "${pass_replay_ready}" != true ]]; then
      # Force the generic branch to remain cleanup-only. It may recontain and
      # release exact interlocks, but it cannot promote the stale/drifted
      # historical evidence back to PASS.
      merge_patch '{"intents":{"abortRequested":true,"terminalReason":"PASS_REPLAY_INVALID"}}' ||
        exit "${EXIT_INCOMPLETE}"
    else
      finalization_ready=false
      if run_patch_operation host-lease-finalization-status; then
        finalization_ready=true
      else
      # The PASS bytes and watchdog-disarm facts are durable before either host
      # lease marker becomes complete.  Recover the exact holder after a local
      # crash/reboot, publish both completion markers idempotently, and only
      # then signal/release it.  Releasing a merely-held marker is forbidden.
      # A crash can land between the two durable marker replacements, leaving
      # the host lease complete while the authorization marker remains held.
      # Complete both idempotently first, then release the original holder (or
      # prove both locks free after reboot).  Never reacquire a complete
      # authorization consumption marker or regress it to held.
        if run_patch_operation host-lease-complete &&
          run_patch_operation host-lease-release &&
          run_patch_operation host-lease-finalization-status; then
          finalization_ready=true
        else
          if ! run_patch_operation host-lease-status; then
            run_patch_operation host-lease-acquire || true
          fi
          if require_facts '.hostLease.held == true' &&
          run_patch_operation host-lease-complete &&
          run_patch_operation host-lease-release &&
          run_patch_operation host-lease-finalization-status; then
            finalization_ready=true
          fi
        fi
      fi
      if [[ "${finalization_ready}" == true ]] && ! pass_completion_guard; then
        invalidate_provisional_pass || exit "${EXIT_INCOMPLETE}"
        finalization_ready=false
      fi
      if [[ "${finalization_ready}" == true ]]; then
        # The complete host and authorization markers were written only after
        # the exact PASS bytes and watchdog disarm. With both host locks acquired
        # for the status read, historical bytes can now be consumed locally.
        evidence_sha="${EVIDENCE_AUTHORITY_SHA}"
        [[ "${evidence_sha}" =~ ^[0-9a-f]{64}$ ]] || exit "${EXIT_INCOMPLETE}"
        STATE="complete"
        write_run_marker complete "${evidence_sha}" "${FACTS_FILE}" "${EVIDENCE_FILE}" true || exit "${EXIT_INCOMPLETE}"
        maybe_crash after_run_marker_complete
        emit_authoritative_evidence || exit "${EXIT_INCOMPLETE}"
        exit 0
      fi
    fi
  fi

  # A non-complete journal is cleanup-only forever.  Reacquire the exact host
  # lease for this nonce when a reboot killed its transient holder, then close
  # from the preserved monotone facts.  It may never return to origin bind/open.
    if require_facts '.intents.hostLeaseAcquireAttempted == true or .hostLease.held == true' || [[ "${existing_state}" =~ ^(origin_bound|watchdog_armed|ingress_open|functional_gate_passed|ingress_closed|contained_disarmed_pending_validation|contained_verified)$ ]]; then
    HOST_LEASE_RECOVERY_REQUIRED=true
  fi
  if [[ "${existing_state}" =~ ^(functional_gate_passed|ingress_closed|contained_disarmed_pending_validation|contained_verified)$ ]]; then
    FUNCTIONAL_GATE_PASSED=true
  fi
  normalize_failure CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
  cleanup_status=0
  cleanup_surfaces || cleanup_status=$?
  if (( cleanup_status == 0 )) && [[ "${FUNCTIONAL_GATE_PASSED}" == true ]] &&
    final_evidence_ready "${EVIDENCE_FILE}" "${EVIDENCE_AUTHORITY_SHA}"; then
    if pass_completion_guard; then
      evidence_sha="${EVIDENCE_AUTHORITY_SHA}"
      [[ "${evidence_sha}" =~ ^[0-9a-f]{64}$ ]] || exit "${EXIT_INCOMPLETE}"
      STATE="complete"
      write_run_marker complete "${evidence_sha}" "${FACTS_FILE}" "${EVIDENCE_FILE}" true || exit "${EXIT_INCOMPLETE}"
      maybe_crash after_run_marker_complete
      emit_authoritative_evidence || exit "${EXIT_INCOMPLETE}"
      exit 0
    fi
    invalidate_provisional_pass || exit "${EXIT_INCOMPLETE}"
    cleanup_status="${EXIT_INCOMPLETE}"
  fi
  if (( cleanup_status != 0 )); then
    terminal_reason="$(jq --raw-output '.intents.terminalReason // empty' "${FACTS_FILE}")" ||
      exit "${EXIT_INCOMPLETE}"
    if (( cleanup_status == EXIT_FAIL )) &&
      [[ "${terminal_reason}" == OFFICIAL_VALIDATOR_REJECTED || "${terminal_reason}" == MUTATION_CARDINALITY_INVALID ]]; then
      RESULT="FAIL"
      RESULT_EXIT="${EXIT_FAIL}"
    else
      RESULT="INCOMPLETE"
      RESULT_EXIT="${EXIT_INCOMPLETE}"
    fi
    if require_facts '.firewall.finalClosed == true and .firewall.closeAmbiguous == false'; then
      CODE="FINAL_CONTAINMENT_FAILED"
      FAILURE_DIAGNOSTICS=("FINAL_CONTAINMENT_FAILED")
    else
      CODE="FIREWALL_CLOSE_AMBIGUOUS"
      FAILURE_DIAGNOSTICS=("FIREWALL_CLOSE_AMBIGUOUS")
    fi
  fi
  STATE="failed_closed"
  emit_evidence
fi

initialize_facts || exit "${EXIT_INCOMPLETE}"
write_run_marker prepared || abort_run SOURCE_INVALID
maybe_crash after_run_marker_prepared
increment_mutation markerTransitions || abort_run SOURCE_INVALID
validate_fresh_admission || abort_run ADMISSION_INVALID

if [[ "${MODE}" == "cleanup" ]]; then
  normalize_failure CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
  cleanup_surfaces || true
  STATE="failed_closed"
  emit_evidence
fi

[[ ! -e "${CHECKPOINT_FILE}" && ! -L "${CHECKPOINT_FILE}" ]] || abort_run CHECKPOINT_INVALID
[[ ! -e "${CHECKPOINT_REQUEST_FILE}" && ! -L "${CHECKPOINT_REQUEST_FILE}" ]] ||
  abort_run CHECKPOINT_INVALID

# Acquire the real host operator interlock before observing any host-sensitive
# admission facts.  Release/recovery therefore cannot win a gap between the
# topology/count snapshot and the first origin mutation.
merge_patch '{"intents":{"hostLeaseAcquireAttempted":true}}' || abort_run SOURCE_INVALID
run_patch_operation host-lease-acquire || abort_run "${LAST_OPERATION_ERROR:-TOOL_UNAVAILABLE}" "${EXIT_INCOMPLETE}"
HOST_LEASE_ACQUIRED=true
if ! run_patch_operation aws-baseline; then
  if [[ "${LAST_OPERATION_ERROR}" == TOPOLOGY_INVALID ]]; then
    abort_run TOPOLOGY_INVALID "${EXIT_FAIL}"
  fi
  abort_run CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
fi
require_facts '(.topology | [.[]] | all)' || abort_run TOPOLOGY_INVALID
merge_patch '{"intents":{"countsBeforeAttempted":true}}' || abort_run CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
run_patch_operation counts-before || abort_run CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
if ! jq --exit-status --slurpfile control "${CONTROL_FILE}" '.counts.before == ($control[0].postIncidentBaseline | del(.snapshotSha256))' "${FACTS_FILE}" >/dev/null; then
  abort_run COUNTS_CHANGED
fi
if ! jq --exit-status --slurpfile control "${CONTROL_FILE}" '
  .database.before.systemIdentifierSha256 == $control[0].admission.promotionDatabaseSystemIdentifierSha256
  and .database.before.activeWorkflows == 0 and .database.before.liveInstallations == 0
  and .database.before.liveTenants == 0 and .database.before.preparedTransactions == 0
' "${FACTS_FILE}" >/dev/null; then
  abort_run COUNTS_CHANGED
fi
run_patch_operation prefix-fetch || abort_run "${LAST_OPERATION_ERROR:-PREFIX_MALFORMED}"
require_facts '.prefixes.fresh == true' || abort_run PREFIX_STALE
require_facts '.prefixes.canonical == true and .prefixes.exactService == true and .prefixes.ipv4Count > 0 and .prefixes.ipv6Count > 0' || abort_run PREFIX_MALFORMED
run_patch_operation firewall-baseline || abort_run "${LAST_OPERATION_ERROR:-FIREWALL_INVALID}"
require_facts '.firewall.beforeSha256 != ("0" * 64)' || abort_run FIREWALL_INVALID
begin_pre_effect_budget "${ORIGIN_BIND_MINIMUM_REMAINING_SECONDS}" ||
  abort_run WINDOW_DEADLINE_EXCEEDED "${EXIT_INCOMPLETE}"
merge_patch '{"intents":{"originBindAttempted":true}}' || abort_pre_effect_run SOURCE_INVALID
run_patch_operation origin-bind || {
  abort_pre_effect_run "${LAST_OPERATION_ERROR:-ETAG_RACE}"
}
end_pre_effect_budget
require_facts '.origin.bound == true and .origin.boundDeployed == true and .origin.etagBindMatched == true and .origin.originMatched == true and .origin.tokenGenerated == true and .origin.tokenLengthBytes == 32 and .origin.tokenWrittenRootOnly == true and .origin.secretMaterialEmitted == false' || abort_run ETAG_RACE
write_run_marker origin_bound || abort_run SOURCE_INVALID
increment_mutation markerTransitions || abort_run SOURCE_INVALID
maybe_crash after_origin_bound

# Origin binding has already recreated and inspected the exact token-bound
# Caddy in a stopped state while the public firewall is closed. Arm the durable
# fail-safe against that immutable container/scope identity before starting it
# or permitting any listener. A local orchestrator or Docker-daemon failure in
# startup/probing is therefore recontained by PID 1 at this deadline.
  begin_pre_effect_budget "${WATCHDOG_ARM_MINIMUM_REMAINING_SECONDS}" ||
    abort_run WINDOW_DEADLINE_EXCEEDED "${EXIT_INCOMPLETE}"
  arm_window_deadline || abort_pre_effect_run WATCHDOG_INVALID
  write_run_marker origin_bound || abort_pre_effect_run WATCHDOG_INVALID
  merge_patch '{"intents":{"watchdogArmAttempted":true}}' || abort_pre_effect_run SOURCE_INVALID
  write_watchdog_marker || abort_pre_effect_run WATCHDOG_INVALID
  maybe_crash after_watchdog_marker_written
  run_patch_operation watchdog-arm || {
    abort_pre_effect_run WATCHDOG_INVALID
  }
  end_pre_effect_budget
require_facts '.watchdog.armedAt != null and .watchdog.deadlineAt != null and .watchdog.armedBeforeIngress == true and .watchdog.activeBeforeIngress == true' || abort_run WATCHDOG_INVALID
write_run_marker watchdog_armed || abort_run WATCHDOG_INVALID
increment_mutation markerTransitions || abort_run WATCHDOG_INVALID
maybe_crash after_watchdog_armed

begin_pre_effect_budget "${CADDY_START_MINIMUM_REMAINING_SECONDS}" ||
  abort_run WINDOW_DEADLINE_EXCEEDED "${EXIT_INCOMPLETE}"
merge_patch '{"intents":{"caddyStartAttempted":true}}' || abort_pre_effect_run SOURCE_INVALID
run_patch_operation caddy-start || {
  abort_pre_effect_run LOCAL_PROBE_INVALID
}
end_pre_effect_budget
run_patch_operation local-probe || abort_run LOCAL_PROBE_INVALID
require_facts '.probes.localCaddy.missingTokenStatus == 404 and .probes.localCaddy.wrongTokenStatus == 404 and .probes.localCaddy.correctTokenStatus == 200 and .probes.localCaddy.backendStripStatus == 401 and .probes.localCaddy.tokenStripped == true' || abort_run LOCAL_PROBE_INVALID

begin_pre_effect_budget "${FIREWALL_OPEN_MINIMUM_REMAINING_SECONDS}" ||
  abort_run WINDOW_DEADLINE_EXCEEDED "${EXIT_INCOMPLETE}"
run_patch_operation window-clock-open-guard || {
  abort_pre_effect_run WATCHDOG_INVALID
}
# Persist the conservative beginning of any possible public interval before
# the AWS mutation intent/effect. A lost ACK or process death can therefore
# never be relabelled as a pre-open failure merely because readback was lost.
OPENED_AT="$(timestamp_now)" || {
  abort_pre_effect_run CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
}
(( $(timestamp_epoch "${OPENED_AT}") <= $(timestamp_epoch "${DEADLINE_AT}") )) || {
  abort_pre_effect_run FIREWALL_INVALID
}
merge_patch '{"intents":{"firewallOpenAttempted":true}}' || abort_pre_effect_run SOURCE_INVALID
run_patch_operation firewall-open || {
  abort_pre_effect_run FIREWALL_INVALID
}
end_pre_effect_budget
require_facts '.firewall.openObserved == true and .firewall.exactPrefixSet == true and .firewall.tcp443Only == true and .firewall.port80Closed == true and .firewall.udpClosed == true and .firewall.wildcardAbsent == true and .firewall.sshUnchanged == true' || abort_run FIREWALL_INVALID
increment_mutation firewallOpens || abort_run FIREWALL_INVALID
write_run_marker ingress_open || abort_run FIREWALL_INVALID
increment_mutation markerTransitions || abort_run FIREWALL_INVALID
write_checkpoint_request || abort_run CHECKPOINT_INVALID
maybe_crash after_ingress_open

run_patch_operation public-health || abort_run PUBLIC_HEALTH_INVALID
require_facts '.probes.publicHealth.status == 200 and .probes.publicHealth.cloudFrontObserved == true and .probes.publicHealth.revisionMatches == true and .probes.publicHealth.noStore == true' || abort_run PUBLIC_HEALTH_INVALID
if wait_for_workbench_checkpoint; then
  :
else
  checkpoint_status=$?
  if (( checkpoint_status == CHECKPOINT_TIMEOUT_STATUS )); then
    abort_run CHECKPOINT_TIMEOUT
  fi
  if (( checkpoint_status == EXIT_INCOMPLETE )); then
    abort_run TOOL_UNAVAILABLE "${EXIT_INCOMPLETE}"
  fi
  abort_run CHECKPOINT_INVALID
fi
run_patch_operation counts-during || abort_run CONTROL_UNAVAILABLE "${EXIT_INCOMPLETE}"
if ! jq --exit-status '.counts.before == .counts.during' "${FACTS_FILE}" >/dev/null; then
  abort_run COUNTS_CHANGED
fi
if ! jq --exit-status '.database.before == .database.during' "${FACTS_FILE}" >/dev/null; then
  abort_run COUNTS_CHANGED
fi
write_run_marker functional_gate_passed || abort_run SOURCE_INVALID
increment_mutation markerTransitions || abort_run SOURCE_INVALID
FUNCTIONAL_GATE_PASSED=true
maybe_crash after_functional_gate

cleanup_status=0
cleanup_surfaces || cleanup_status=$?
if (( cleanup_status != 0 )); then
  cleanup_exit="${EXIT_INCOMPLETE}"
  if (( cleanup_status == EXIT_FAIL )) && [[ "${CLEANUP_CONVERGED}" == true ]] &&
    require_facts '.firewall.finalClosed == true and .firewall.closeAmbiguous == false'; then
    # A fully converged cleanup may still establish a terminal local proof
    # failure (for example a required mutation cardinality was not observed).
    # It is a complete FAIL20. Any retained/ambiguous remote surface is 21.
    cleanup_exit="${EXIT_FAIL}"
  fi
  if require_facts '.firewall.finalClosed == true and .firewall.closeAmbiguous == false'; then
    abort_run FINAL_CONTAINMENT_INVALID "${cleanup_exit}"
  fi
  abort_run CLOSE_AMBIGUOUS "${EXIT_INCOMPLETE}"
fi

final_evidence_ready "${EVIDENCE_FILE}" "${EVIDENCE_AUTHORITY_SHA}" ||
  abort_run FINAL_CONTAINMENT_INVALID
if ! pass_completion_guard; then
  invalidate_provisional_pass || abort_run FINAL_CONTAINMENT_INVALID "${EXIT_INCOMPLETE}"
  abort_run FINAL_CONTAINMENT_INVALID "${EXIT_INCOMPLETE}"
fi
RESULT="PASS"
CODE="${PASS_CODE}"
RESULT_EXIT=0
STATE="complete"
FAILURE_DIAGNOSTICS=()
trap - ERR HUP INT TERM
evidence_sha="${EVIDENCE_AUTHORITY_SHA}"
[[ "${evidence_sha}" =~ ^[0-9a-f]{64}$ ]] || exit "${EXIT_INCOMPLETE}"
write_run_marker complete "${evidence_sha}" "${FACTS_FILE}" "${EVIDENCE_FILE}" true || exit "${EXIT_INCOMPLETE}"
maybe_crash after_run_marker_complete
emit_authoritative_evidence || exit "${EXIT_INCOMPLETE}"
exit 0
