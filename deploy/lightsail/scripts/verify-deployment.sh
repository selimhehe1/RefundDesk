#!/usr/bin/env bash

# Runtime verification assumes only Caddy publishes host ports 80 and 443.
# PostgreSQL, web, worker and the static verifier proxy remain Compose-internal.
# Public origin is read from /etc/refunddesk/public-origin unless supplied.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

PUBLIC_ORIGIN=""
GRACEFUL_STOP_TEST=false

while (( $# > 0 )); do
  case "$1" in
    --origin)
      (( $# >= 2 )) || die "--origin requires a value"
      PUBLIC_ORIGIN="$2"
      shift 2
      ;;
    --graceful-stop-test)
      GRACEFUL_STOP_TEST=true
      shift
      ;;
    --help|-h)
      printf 'Usage: sudo bash verify-deployment.sh [--origin HTTPS_ORIGIN] [--graceful-stop-test]\n'
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

require_root
require_command base64
require_command curl
require_command docker
require_command jq
require_command readlink
require_command ss
require_command timeout
require_command tr

TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
VERIFY_CONTRACT="${REFUNDDESK_VERIFY_CONTRACT:-standalone}"
if [[ "${VERIFY_CONTRACT}" == "release-v2" ]]; then
  [[ "${GRACEFUL_STOP_TEST}" == "false" ]] ||
    die "graceful-stop mutation is prohibited inside a release transition"
  [[ "${REFUNDDESK_RELEASE_LAUNCHER_CONTRACT:-}" == "2" &&
    "${REFUNDDESK_REVISION:-}" =~ ^[0-9a-f]{40}$ ]] ||
    die "release verification lacks its stable launcher contract"
  EXPECTED_REVISION="${REFUNDDESK_REVISION}"
  EXPECTED_SOURCE="${REFUNDDESK_ROOT}/releases/${REFUNDDESK_REVISION}/source"
  [[ "${SCRIPT_DIR}" == "${EXPECTED_SOURCE}/deploy/lightsail/scripts" ]] ||
    die "release verification is not running from the exact target source"
  RESOLVED_COMPOSE_FILE="$(
    readlink --canonicalize-existing -- "${REFUNDDESK_COMPOSE_FILE}"
  )"
  [[ "${RESOLVED_COMPOSE_FILE}" == "${EXPECTED_SOURCE}/deploy/lightsail/compose.yml" ]] ||
    die "release verification Compose file differs from its target source"
  assert_root_secret_file "${TRANSITION_JOURNAL}"
  jq --exit-status --arg revision "${REFUNDDESK_REVISION}" '
    type == "object"
    and keys == ["from","schemaVersion","status","to"]
    and .schemaVersion == 1
    and .status == "in_progress"
    and .to.revision == $revision
  ' "${TRANSITION_JOURNAL}" >/dev/null ||
    die "release verification journal differs from the exact target"
  mapfile -t release_lines <"${REFUNDDESK_RELEASE_ENV}"
  (( ${#release_lines[@]} == 3 )) &&
    [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${REFUNDDESK_REVISION}" ]] &&
    [[ "${release_lines[1]}" == "REFUNDDESK_REVISION=${REFUNDDESK_REVISION}" ]] &&
    [[ "${release_lines[2]}" == "REFUNDDESK_RUNTIME_RESTART_POLICY=no" ]] ||
    die "release verification environment is not transition-fenced"
elif [[ "${VERIFY_CONTRACT}" == "standalone" ]]; then
  if [[ "${REFUNDDESK_OPERATOR_LOCK_INHERITED:-false}" == "true" ]]; then
    inherited_lock_path="$(readlink "/proc/self/fd/9")" ||
      die "inherited operator lock descriptor is unavailable"
    [[ "${inherited_lock_path}" == "${REFUNDDESK_OPERATOR_LOCK}" ]] ||
      die "inherited operator lock descriptor targets an unexpected file"
    flock --exclusive --nonblock 9 ||
      die "inherited operator lock is not held"
  else
    acquire_operator_lock
  fi
  [[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]] ||
    die "standalone deployment verification is blocked by an unfinished release"
  ACTIVE_REVISION_FILE="${REFUNDDESK_ROOT}/ACTIVE_REVISION"
  CURRENT_LINK="${REFUNDDESK_ROOT}/current"
  assert_root_control_file "${ACTIVE_REVISION_FILE}"
  assert_root_secret_file "${REFUNDDESK_RELEASE_ENV}"
  mapfile -t active_lines <"${ACTIVE_REVISION_FILE}"
  (( ${#active_lines[@]} == 1 )) &&
    [[ "${active_lines[0]}" =~ ^[0-9a-f]{40}$ ]] ||
    die "standalone verification active revision is invalid"
  ACTIVE_REVISION="${active_lines[0]}"
  EXPECTED_REVISION="${ACTIVE_REVISION}"
  [[ -L "${CURRENT_LINK}" && "$(stat --format='%u' -- "${CURRENT_LINK}")" == "0" ]] ||
    die "standalone verification current source is not root-owned"
  CURRENT_SOURCE="$(readlink --canonicalize-existing -- "${CURRENT_LINK}")"
  EXPECTED_SOURCE="${REFUNDDESK_ROOT}/releases/${ACTIVE_REVISION}/source"
  [[ "${CURRENT_SOURCE}" == "${EXPECTED_SOURCE}" &&
    "${SCRIPT_DIR}" == "${EXPECTED_SOURCE}/deploy/lightsail/scripts" ]] ||
    die "standalone deployment verification source selection is inconsistent"
  RESOLVED_COMPOSE_FILE="$(
    readlink --canonicalize-existing -- "${REFUNDDESK_COMPOSE_FILE}"
  )"
  [[ "${RESOLVED_COMPOSE_FILE}" == "${EXPECTED_SOURCE}/deploy/lightsail/compose.yml" ]] ||
    die "standalone deployment verification Compose selection is inconsistent"
  mapfile -t release_lines <"${REFUNDDESK_RELEASE_ENV}"
  (( ${#release_lines[@]} == 2 )) &&
    [[ "${release_lines[0]}" == "REFUNDDESK_IMAGE_TAG=sandbox-${ACTIVE_REVISION}" ]] &&
    [[ "${release_lines[1]}" == "REFUNDDESK_REVISION=${ACTIVE_REVISION}" ]] ||
    die "standalone deployment verification release environment is inconsistent"
else
  die "deployment verification invocation contract is invalid"
fi

ORIGIN_FILE="${REFUNDDESK_CONFIG_ROOT}/public-origin"
CADDY_ENV="${REFUNDDESK_CONFIG_ROOT}/caddy.env"
CADDY_CONFIG_DIRECTORY="/var/lib/refunddesk/caddy-public/config"
CADDY_AUTOSAVE_DIRECTORY="${CADDY_CONFIG_DIRECTORY}/caddy"
CADDY_AUTOSAVE_PATH="${CADDY_AUTOSAVE_DIRECTORY}/autosave.json"
assert_root_secret_file "${ORIGIN_FILE}"
assert_root_secret_file "${CADDY_ENV}"
[[ -d "${CADDY_CONFIG_DIRECTORY}" && ! -L "${CADDY_CONFIG_DIRECTORY}" ]] ||
  die "Caddy config directory is not a real directory"
RESOLVED_CADDY_CONFIG_DIRECTORY="$(
  readlink --canonicalize-existing -- "${CADDY_CONFIG_DIRECTORY}"
)"
[[ "${RESOLVED_CADDY_CONFIG_DIRECTORY}" == "${CADDY_CONFIG_DIRECTORY}" ]] ||
  die "Caddy config directory escaped its fixed path"
if [[ -e "${CADDY_AUTOSAVE_DIRECTORY}" || -L "${CADDY_AUTOSAVE_DIRECTORY}" ]]; then
  [[ -d "${CADDY_AUTOSAVE_DIRECTORY}" && ! -L "${CADDY_AUTOSAVE_DIRECTORY}" ]] ||
    die "Caddy autosave directory is not a real directory"
  RESOLVED_CADDY_AUTOSAVE_DIRECTORY="$(
    readlink --canonicalize-existing -- "${CADDY_AUTOSAVE_DIRECTORY}"
  )"
  [[ "${RESOLVED_CADDY_AUTOSAVE_DIRECTORY}" == "${CADDY_AUTOSAVE_DIRECTORY}" ]] ||
    die "Caddy autosave directory escaped its fixed path"
fi
[[ ! -e "${CADDY_AUTOSAVE_PATH}" && ! -L "${CADDY_AUTOSAVE_PATH}" ]] ||
  die "Caddy autosave residue is present"
IFS= read -r CONFIGURED_PUBLIC_ORIGIN <"${ORIGIN_FILE}"
if [[ -n "${PUBLIC_ORIGIN}" && "${PUBLIC_ORIGIN}" != "${CONFIGURED_PUBLIC_ORIGIN}" ]]; then
  die "supplied public origin differs from the root-owned origin file"
fi
PUBLIC_ORIGIN="${CONFIGURED_PUBLIC_ORIGIN}"
[[ "${PUBLIC_ORIGIN}" =~ ^https://[A-Za-z0-9.-]+$ ]] ||
  die "public origin must be an HTTPS origin without a path"
VIEWER_HOST="${PUBLIC_ORIGIN#https://}"
[[ "${VIEWER_HOST}" == "d2xv7szimbgban.cloudfront.net" ]] ||
  die "public viewer differs from the hosted CloudFront distribution"

CADDY_PUBLIC_HOST=""
CADDY_ACME_EMAIL_SEEN=false
CADDY_EDGE_ORIGIN_TOKEN=""
CADDY_EDGE_ORIGIN_TOKEN_SEEN=false
mapfile -t caddy_environment_lines <"${CADDY_ENV}"
(( ${#caddy_environment_lines[@]} == 3 )) ||
  die "Caddy environment must contain exactly three bindings"
for caddy_environment_line in "${caddy_environment_lines[@]}"; do
  case "${caddy_environment_line}" in
    REFUNDDESK_PUBLIC_HOST=*)
      [[ -z "${CADDY_PUBLIC_HOST}" ]] ||
        die "Caddy public host is duplicated"
      CADDY_PUBLIC_HOST="${caddy_environment_line#REFUNDDESK_PUBLIC_HOST=}"
      ;;
    REFUNDDESK_ACME_EMAIL=*)
      [[ "${CADDY_ACME_EMAIL_SEEN}" == "false" &&
        -n "${caddy_environment_line#REFUNDDESK_ACME_EMAIL=}" ]] ||
        die "Caddy ACME email binding is invalid"
      CADDY_ACME_EMAIL_SEEN=true
      ;;
    REFUNDDESK_EDGE_ORIGIN_TOKEN=*)
      [[ "${CADDY_EDGE_ORIGIN_TOKEN_SEEN}" == "false" ]] ||
        die "Caddy edge-origin token is duplicated"
      CADDY_EDGE_ORIGIN_TOKEN="${caddy_environment_line#REFUNDDESK_EDGE_ORIGIN_TOKEN=}"
      [[ "${CADDY_EDGE_ORIGIN_TOKEN}" =~ ^[A-Za-z0-9_-]{43}$ ]] ||
        die "Caddy edge-origin token is invalid"
      [[ "${CADDY_EDGE_ORIGIN_TOKEN}" != "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws" ]] ||
        die "Caddy edge-origin token is a known non-secret value"
      CADDY_EDGE_ORIGIN_TOKEN_SEEN=true
      ;;
    *)
      die "Caddy environment contains an unexpected binding"
      ;;
  esac
done
canonical_edge_origin_token="$(
  printf '%s=' "${CADDY_EDGE_ORIGIN_TOKEN}" |
    tr -- '_-' '/+' |
    base64 --decode 2>/dev/null |
    base64 --wrap=0 |
    tr -- '+/' '-_' |
    tr --delete '='
)" || die "Caddy edge-origin token is invalid"
[[ "${canonical_edge_origin_token}" == "${CADDY_EDGE_ORIGIN_TOKEN}" ]] ||
  die "Caddy edge-origin token is invalid"
unset canonical_edge_origin_token
[[ "${CADDY_PUBLIC_HOST}" =~ ^[A-Za-z0-9.-]+$ &&
  "${CADDY_PUBLIC_HOST}" != "${VIEWER_HOST}" &&
  "${CADDY_PUBLIC_HOST}" != *.cloudfront.net &&
  "${CADDY_ACME_EMAIL_SEEN}" == "true" &&
  "${CADDY_EDGE_ORIGIN_TOKEN_SEEN}" == "true" ]] ||
  die "Caddy origin host is invalid or not separated from the public viewer"
CADDY_ORIGIN="https://${CADDY_PUBLIC_HOST}"

curl_local_origin_transport() {
  curl \
    --resolve "${CADDY_PUBLIC_HOST}:443:127.0.0.1" \
    --noproxy '*' \
    --proto '=https' \
    --tlsv1.2 \
    "$@"
}

curl_local_origin_with_edge_token() {
  local supplied_edge_origin_token="$1"
  shift
  curl_local_origin_transport \
    --header @<(printf 'X-RefundDesk-Origin-Token: %s\n' "${supplied_edge_origin_token}") \
    "$@"
}

curl_local_origin() {
  curl_local_origin_with_edge_token "${CADDY_EDGE_ORIGIN_TOKEN}" "$@"
}

curl_local_origin_without_edge_token() {
  curl_local_origin_transport "$@"
}

curl_public_viewer() {
  curl \
    --noproxy '*' \
    --proto '=https' \
    --tlsv1.2 \
    "$@"
}

normalize_http_headers() {
  tr --delete '\r'
}

retry_bounded_service_probe() {
  local probe_name="$1"
  local container_id="$2"
  local deadline_seconds="$3"
  shift 3

  local attempt attempts_completed attempt_timeout deadline exit_status max_attempts
  local remaining_seconds sleep_seconds
  local max_attempt_timeout_seconds=50
  local retry_delay_seconds=5

  [[ "${probe_name}" =~ ^[a-z0-9-]+$ &&
    "${container_id}" =~ ^[0-9a-f]{64}$ &&
    "${deadline_seconds}" =~ ^[1-9][0-9]*$ ]] ||
    die "bounded deployment probe configuration is invalid"

  max_attempts=$((deadline_seconds / retry_delay_seconds + 2))
  deadline=$((SECONDS + deadline_seconds))
  attempt=1
  attempts_completed=0
  while (( attempt <= max_attempts && SECONDS < deadline )); do
    remaining_seconds=$((deadline - SECONDS))
    (( remaining_seconds > 0 )) || break
    attempt_timeout="${max_attempt_timeout_seconds}"
    if (( remaining_seconds < attempt_timeout )); then
      attempt_timeout="${remaining_seconds}"
    fi

    exit_status=0
    timeout \
      --foreground \
      --signal=TERM \
      --kill-after=5s \
      "${attempt_timeout}s" \
      docker exec -- "${container_id}" "$@" ||
      exit_status=$?
    attempts_completed="${attempt}"
    if (( exit_status == 0 )); then
      log "deployment probe passed; probe=${probe_name}; attempt=${attempt}"
      return 0
    fi

    case "${exit_status}" in
      75|124|137)
        log \
          "deployment probe transient failure; probe=${probe_name}; attempt=${attempt}; exit_status=${exit_status}"
        ;;
      *)
        die \
          "deployment probe failed permanently; probe=${probe_name}; attempt=${attempt}; exit_status=${exit_status}"
        ;;
    esac

    if (( attempt >= max_attempts || SECONDS >= deadline )); then
      break
    fi
    remaining_seconds=$((deadline - SECONDS))
    (( remaining_seconds > 0 )) || break
    sleep_seconds="${retry_delay_seconds}"
    if (( remaining_seconds < sleep_seconds )); then
      sleep_seconds="${remaining_seconds}"
    fi
    attempt=$((attempt + 1))
    sleep "${sleep_seconds}" ||
      die "deployment probe retry sleep failed; probe=${probe_name}"
  done

  die \
    "deployment probe exhausted; probe=${probe_name}; attempts=${attempts_completed}; deadline_seconds=${deadline_seconds}"
}

refunddesk_compose config --quiet

VERIFIED_WEB_CONTAINER_ID=""
VERIFIED_WORKER_CONTAINER_ID=""
for service in postgres verifier worker web caddy; do
  service_is_running "${service}" || die "${service} is not running"
  container_id="$(service_container_id "${service}")"
  [[ "$(docker inspect --format='{{.State.OOMKilled}}' "${container_id}")" == "false" ]] ||
    die "${service} was OOM-killed"
  memory_limit="$(docker inspect --format='{{.HostConfig.Memory}}' "${container_id}")"
  (( memory_limit > 0 )) || die "${service} has no container memory limit"
  wait_for_container_health "${service}" 30 || die "${service} is not healthy"
  if [[ "${VERIFY_CONTRACT}" == "release-v2" && "${service}" != "postgres" ]]; then
    docker inspect "${container_id}" |
      jq --exit-status \
        --arg revision "${REFUNDDESK_REVISION}" \
        --arg service "${service}" '
          length == 1
          and .[0].Config.Labels["com.docker.compose.service"] == $service
          and .[0].Config.Labels["com.refunddesk.revision"] == $revision
          and .[0].HostConfig.RestartPolicy.Name == "no"
        ' >/dev/null ||
      die "${service} is outside the release transition fence"
  fi
  case "${service}" in
    web)
      VERIFIED_WEB_CONTAINER_ID="${container_id}"
      ;;
    worker)
      VERIFIED_WORKER_CONTAINER_ID="${container_id}"
      ;;
  esac
done
[[ "${VERIFIED_WEB_CONTAINER_ID}" =~ ^[0-9a-f]{64}$ &&
  "${VERIFIED_WORKER_CONTAINER_ID}" =~ ^[0-9a-f]{64}$ ]] ||
  die "deployment verification did not capture the exact runtime container IDs"

for service in postgres verifier worker web; do
  container_id="$(service_container_id "${service}")"
  docker inspect "${container_id}" |
    jq --exit-status '.[0].HostConfig.PortBindings | (. == null or length == 0)' >/dev/null ||
    die "${service} unexpectedly publishes a host port"
done

caddy_id="$(service_container_id caddy)"
docker inspect "${caddy_id}" |
  jq --exit-status '
    [.[0].HostConfig.PortBindings[]?[]?.HostPort] as $ports
    | ($ports | length >= 2)
      and ($ports | all(. == "80" or . == "443"))
      and ($ports | index("80") != null)
      and ($ports | index("443") != null)
  ' >/dev/null || die "Caddy must publish only host ports 80 and 443"

host_tcp_listeners="$(
  ss --listening --tcp --numeric --no-header
)" || die "host listening TCP inventory is unavailable"
if awk '{print $4}' <<<"${host_tcp_listeners}" |
  grep -Eq '(^|:)(3000|3101|5432|8443)$'; then
  die "an internal RefundDesk port is listening on the host"
fi

https_deadline=$((SECONDS + 180))
until curl_local_origin \
  --fail --silent \
  --connect-timeout 5 --max-time 15 \
  "${CADDY_ORIGIN}/api/health" >/dev/null; do
  (( SECONDS < https_deadline )) ||
    die "local public HTTPS did not become ready within 180 seconds"
  sleep 3
done

correct_edge_token_status="$(
  curl_local_origin \
    --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    "${CADDY_ORIGIN}/api/health"
)" || die "local origin token-authenticated probe failed"
[[ "${correct_edge_token_status}" == "200" ]] ||
  die "local origin rejected the configured CloudFront token"

missing_edge_token_status="$(
  curl_local_origin_without_edge_token \
    --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    "${CADDY_ORIGIN}/api/health"
)" || die "local origin no-token probe failed"
[[ "${missing_edge_token_status}" == "404" ]] ||
  die "local origin accepted a request without the CloudFront token"

if [[ "${CADDY_EDGE_ORIGIN_TOKEN:0:1}" == "A" ]]; then
  WRONG_EDGE_ORIGIN_TOKEN="B${CADDY_EDGE_ORIGIN_TOKEN:1}"
else
  WRONG_EDGE_ORIGIN_TOKEN="A${CADDY_EDGE_ORIGIN_TOKEN:1}"
fi
wrong_edge_token_status="$(
  curl_local_origin_with_edge_token "${WRONG_EDGE_ORIGIN_TOKEN}" \
    --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    "${CADDY_ORIGIN}/api/health"
)" || die "local origin wrong-token probe failed"
unset WRONG_EDGE_ORIGIN_TOKEN
[[ "${wrong_edge_token_status}" == "404" ]] ||
  die "local origin accepted an invalid CloudFront token"

local_health_headers="$(
  curl_local_origin \
    --fail --silent --show-error \
    --dump-header - --output /dev/null \
    --connect-timeout 5 --max-time 15 \
    "${CADDY_ORIGIN}/api/health" |
    normalize_http_headers
)" || die "local origin health headers are unavailable"
grep -Eiq \
  "^x-refunddesk-revision:[[:space:]]*${EXPECTED_REVISION}$" \
  <<<"${local_health_headers}" ||
  die "local Caddy origin does not identify the exact verified revision"
grep -Eiq '^cache-control:[[:space:]]*no-store$' <<<"${local_health_headers}" ||
  die "local Caddy origin does not disable response storage"
if grep -Eiq '^x-refunddesk-origin-token:' <<<"${local_health_headers}"; then
  die "local Caddy origin returned its CloudFront token in response headers"
fi

public_ready_status="$(
  curl_local_origin --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    "${CADDY_ORIGIN}/api/ready"
)"
[[ "${public_ready_status}" == "404" ]] ||
  die "private platform readiness route is reachable through public ingress"

for authority_action in verify attest; do
  public_internal_status="$(
    curl_local_origin --silent --show-error \
      --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 5 --max-time 15 \
      --request POST --header 'content-type: application/json' --data '{}' \
      "${CADDY_ORIGIN}/internal/v1/signed-requests/${authority_action}"
  )"
  [[ "${public_internal_status}" == "404" ]] ||
    die "private signed-request authority route is reachable through public ingress"
done

public_post_status() {
  curl_local_origin --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    --request POST \
    --header 'content-type: application/json' \
    --header 'X-Forwarded-For: 3.18.12.63' \
    --data '{}' \
    "${CADDY_ORIGIN}${1}"
}

for direct_route in \
  "/api/webhooks/stripe-account/test" \
  "/api/webhooks/stripe-account/sandbox"; do
  [[ "$(public_post_status "${direct_route}")" == "400" ]] ||
    die "direct-account webhook route is not reachable at ${direct_route}"
done

for blocked_webhook_route in \
  "/api/webhooks/stripe-account/live" \
  "/api/webhooks/stripe-connected/test" \
  "/api/webhooks/stripe-connected/sandbox" \
  "/api/webhooks/stripe-connected/live"; do
  [[ "$(public_post_status "${blocked_webhook_route}")" == "404" ]] ||
    die "disabled webhook route is reachable at ${blocked_webhook_route}"
done

for viewer_probe in 1 2; do
  viewer_health_headers="$(
    curl_public_viewer \
      --fail --silent --show-error \
      --dump-header - --output /dev/null \
      --connect-timeout 5 --max-time 20 \
      "${PUBLIC_ORIGIN}/api/health?revision=${EXPECTED_REVISION}&probe=release-${viewer_probe}" |
      normalize_http_headers
  )" || die "CloudFront viewer health request failed"
  grep -Eiq '^x-amz-cf-id:' <<<"${viewer_health_headers}" ||
    die "public health response did not traverse CloudFront"
  grep -Eiq \
    "^x-refunddesk-revision:[[:space:]]*${EXPECTED_REVISION}$" \
    <<<"${viewer_health_headers}" ||
    die "CloudFront viewer is not bound to the exact verified revision"
  grep -Eiq '^cache-control:[[:space:]]*no-store$' <<<"${viewer_health_headers}" ||
    die "CloudFront viewer omitted the no-store response contract"
  grep -Eiq '^x-cache:[[:space:]]*Miss from cloudfront$' <<<"${viewer_health_headers}" ||
    die "CloudFront viewer returned a cache state outside the disabled-cache contract"
  if grep -Eiq '^x-refunddesk-origin-token:' <<<"${viewer_health_headers}"; then
    die "CloudFront viewer returned the origin token in response headers"
  fi
done

signed_webhook_probe="$({
  refunddesk_compose exec --no-TTY web node --input-type=module -e '
    const { createHmac } = await import("node:crypto");
    const timestamp = Math.floor(Date.now() / 1000);
    const eventId = `evt_RefundDeskReleaseProbe${timestamp}`;
    const payload = JSON.stringify({
      api_version: "2026-06-24.dahlia",
      created: timestamp,
      data: { object: { id: "synthetic_release_probe" } },
      id: eventId,
      livemode: false,
      object: "event",
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "refunddesk.release_probe",
    });
    const signature = createHmac(
      "sha256",
      process.env.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET,
    )
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    console.log(JSON.stringify({
      event_id: eventId,
      payload_base64: Buffer.from(payload, "utf8").toString("base64"),
      stripe_signature: `t=${timestamp},v1=${signature}`,
    }));
  '
} 2>/dev/null)" || die "synthetic webhook probe could not be prepared"
synthetic_event_id="$(jq --exit-status --raw-output '.event_id' <<<"${signed_webhook_probe}")" ||
  die "synthetic webhook probe identifier is invalid"
synthetic_payload="$({
  jq --exit-status --raw-output '.payload_base64' <<<"${signed_webhook_probe}" |
    base64 --decode
} 2>/dev/null)" || die "synthetic webhook probe payload is invalid"
synthetic_signature="$(
  jq --exit-status --raw-output '.stripe_signature' <<<"${signed_webhook_probe}"
)" || die "synthetic webhook probe signature is invalid"
[[ "${synthetic_event_id}" =~ ^evt_RefundDeskReleaseProbe[0-9]+$ &&
  "${synthetic_signature}" =~ ^t=[0-9]+,v1=[0-9a-f]{64}$ ]] ||
  die "synthetic webhook probe contract is invalid"

local_webhook_result="$({
  curl_local_origin \
    --silent --show-error \
    --connect-timeout 5 --max-time 20 \
    --request POST \
    --header 'content-type: application/json' \
    --header 'X-Forwarded-For: 3.18.12.63' \
    --header @<(printf 'Stripe-Signature: %s\n' "${synthetic_signature}") \
    --data-binary @<(printf '%s' "${synthetic_payload}") \
    --write-out $'\n%{http_code}' \
    "${CADDY_ORIGIN}/api/webhooks/stripe-account/test"
} 2>/dev/null)" || die "local signed raw-body webhook relay failed"
local_webhook_status="${local_webhook_result##*$'\n'}"
local_webhook_body="${local_webhook_result%$'\n'*}"
if [[ "${local_webhook_status}" != "200" ]] ||
  ! jq --exit-status --arg event_id "${synthetic_event_id}" '
    .received == true
    and .ignored == true
    and .event_id == $event_id
  ' <<<"${local_webhook_body}" >/dev/null; then
  die "local Caddy changed the signed raw body, forwarded the origin token or bypassed the trusted edge relay"
fi
unset signed_webhook_probe synthetic_event_id synthetic_payload synthetic_signature
unset local_webhook_result local_webhook_status local_webhook_body

refunddesk_compose exec \
  --env "REFUNDDESK_EXPECTED_REVISION=${EXPECTED_REVISION}" \
  --no-TTY web node --input-type=module -e '
    const response = await fetch(
      `${process.env.APP_BASE_URL}/api/webhooks/stripe-account/test`,
      {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(20000),
      },
    );
    const body = await response.json().catch(() => null);
    if (
      response.status !== 403
      || body?.code !== "WEBHOOK_SOURCE_FORBIDDEN"
      || response.headers.get("x-refunddesk-revision")
        !== process.env.REFUNDDESK_EXPECTED_REVISION
      || response.headers.get("cache-control") !== "no-store"
      // CloudFront reports "Error from cloudfront" for every 4xx an origin
      // returns, and "Miss from cloudfront" only for a 2xx it did not serve
      // from cache. Requiring "Miss" on a response this check expects to be
      // 403 can never hold. Origin traversal is already proved by the
      // revision header above, which only Caddy sets.
      || response.headers.get("x-cache") !== "Error from cloudfront"
      || response.headers.get("x-amz-cf-id") === null
    ) {
      process.exit(1);
    }
  ' || die "CloudFront webhook source allowlist is not enforced"

local_options_status="$(
  curl_local_origin --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    --request OPTIONS \
    "${CADDY_ORIGIN}/api/health"
)" || die "local origin OPTIONS probe failed"
viewer_options_status="$(
  curl_public_viewer --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 20 \
    --request OPTIONS \
    "${PUBLIC_ORIGIN}/api/health"
)" || die "CloudFront OPTIONS relay failed"
[[ "${viewer_options_status}" == "${local_options_status}" ]] ||
  die "CloudFront did not relay OPTIONS to the Caddy origin"

retry_bounded_service_probe \
  web-ready \
  "${VERIFIED_WEB_CONTAINER_ID}" \
  150 \
  node --input-type=module -e '
  try {
    const response = await fetch("http://127.0.0.1:3000/api/ready", {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      console.error(`deployment_probe=web-ready result=http_${response.status}`);
      process.exit(response.status === 503 ? 75 : 1);
    }
  } catch (error) {
    const result = error?.name === "TimeoutError" ? "timeout" : "transport_error";
    console.error(`deployment_probe=web-ready result=${result}`);
    process.exit(75);
  }
'

retry_bounded_service_probe \
  worker-ready \
  "${VERIFIED_WORKER_CONTAINER_ID}" \
  150 \
  node --input-type=module -e '
  const check = async (path, endpoint) => {
    try {
      const response = await fetch(`http://127.0.0.1:3101${path}`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        console.error(
          `deployment_probe=worker-ready endpoint=${endpoint} result=http_${response.status}`,
        );
        process.exit(response.status === 503 ? 75 : 1);
      }
    } catch (error) {
      const result = error?.name === "TimeoutError" ? "timeout" : "transport_error";
      console.error(
        `deployment_probe=worker-ready endpoint=${endpoint} result=${result}`,
      );
      process.exit(75);
    }
  };
  await check("/health", "health");
  await check("/ready", "ready");
'

retry_bounded_service_probe \
  verifier-auth \
  "${VERIFIED_WEB_CONTAINER_ID}" \
  150 \
  node --input-type=module -e '
  try {
    const response = await fetch(process.env.REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: "{}",
      signal: AbortSignal.timeout(20000),
    });
    if (response.status !== 403) {
      console.error(`deployment_probe=verifier-auth result=http_${response.status}`);
      process.exit(response.status === 503 ? 75 : 1);
    }
  } catch (error) {
    const result = error?.name === "TimeoutError" ? "timeout" : "transport_error";
    console.error(`deployment_probe=verifier-auth result=${result}`);
    process.exit(75);
  }
'

for service in web worker; do
  container_id="$(service_container_id "${service}")"
  environment_json="$(docker inspect --format='{{json .Config.Env}}' "${container_id}")"
  jq --exit-status '
    index("REFUNDDESK_GLOBAL_LIVE_ENABLED=false") != null
    and (
      map(select(startswith("STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=")))
      | all(. == "STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled")
    )
    and (
      map(select(startswith("STRIPE_PLATFORM_TEST_ACCOUNT_ID=acct_")))
      | length == 1
    )
    and (
      map(select(startswith("STRIPE_MANAGED_SANDBOX_ACCOUNT_ID=acct_")))
      | length == 1
    )
    and (
      map(split("=")[0])
      | all(
          . == "STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET"
          or (test("(^STRIPE_.*LIVE|^LIVE_.*(KEY|SECRET|TOKEN))") | not)
        )
    )
  ' <<<"${environment_json}" >/dev/null ||
    die "${service} does not enforce the live-disabled environment contract"
done

swap_bytes="$(awk '/SwapTotal:/ {print $2 * 1024}' /proc/meminfo)"
awk -v bytes="${swap_bytes}" 'BEGIN { exit !(bytes >= 2147483648) }' ||
  die "host swap is below 2 GiB"

docker stats --no-stream \
  --format '{{.Name}} {{.MemUsage}}' \
  "$(service_container_id postgres)" \
  "$(service_container_id verifier)" \
  "$(service_container_id worker)" \
  "$(service_container_id web)" \
  "$(service_container_id caddy)" >&2

if "${GRACEFUL_STOP_TEST}"; then
  for service in worker web; do
    started_at="${SECONDS}"
    refunddesk_compose stop --timeout 45 "${service}"
    elapsed=$((SECONDS - started_at))
    (( elapsed <= 50 )) || die "${service} did not stop inside the grace window"
    container_id="$(service_container_id "${service}")"
    exit_code="$(docker inspect --format='{{.State.ExitCode}}' "${container_id}")"
    [[ "${exit_code}" == "0" || "${exit_code}" == "143" ]] ||
      die "${service} exited abnormally during graceful-stop verification"
    refunddesk_compose up --detach --no-deps --no-build --pull never "${service}"
    wait_for_container_health "${service}" 180 ||
      die "${service} did not recover after graceful-stop verification"
  done
  retry_bounded_service_probe \
    graceful-web-ready \
    "${VERIFIED_WEB_CONTAINER_ID}" \
    150 \
    node --input-type=module -e '
    try {
      const response = await fetch("http://127.0.0.1:3000/api/ready", {
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        console.error(
          `deployment_probe=graceful-web-ready result=http_${response.status}`,
        );
        process.exit(response.status === 503 ? 75 : 1);
      }
    } catch (error) {
      const result = error?.name === "TimeoutError" ? "timeout" : "transport_error";
      console.error(`deployment_probe=graceful-web-ready result=${result}`);
      process.exit(75);
    }
  '
  curl_local_origin \
    --fail --silent --show-error --max-time 20 \
    "${CADDY_ORIGIN}/api/health" >/dev/null
fi

log "deployment verification passed with live mode disabled"
