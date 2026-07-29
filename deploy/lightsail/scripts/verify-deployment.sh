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
require_command curl
require_command docker
require_command jq
require_command readlink
require_command ss
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
assert_root_secret_file "${ORIGIN_FILE}"
assert_root_secret_file "${CADDY_ENV}"
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
mapfile -t caddy_environment_lines <"${CADDY_ENV}"
(( ${#caddy_environment_lines[@]} == 2 )) ||
  die "Caddy environment must contain exactly two bindings"
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
    *)
      die "Caddy environment contains an unexpected binding"
      ;;
  esac
done
[[ "${CADDY_PUBLIC_HOST}" =~ ^[A-Za-z0-9.-]+$ &&
  "${CADDY_PUBLIC_HOST}" != "${VIEWER_HOST}" &&
  "${CADDY_PUBLIC_HOST}" != *.cloudfront.net &&
  "${CADDY_ACME_EMAIL_SEEN}" == "true" ]] ||
  die "Caddy origin host is invalid or not separated from the public viewer"
CADDY_ORIGIN="https://${CADDY_PUBLIC_HOST}"

curl_local_origin() {
  curl \
    --resolve "${CADDY_PUBLIC_HOST}:443:127.0.0.1" \
    --noproxy '*' \
    --proto '=https' \
    --tlsv1.2 \
    "$@"
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

refunddesk_compose config --quiet

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
done

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

if ss --listening --tcp --numeric --no-header |
  awk '{print $4}' |
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

public_ready_status="$(
  curl_local_origin --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    "${CADDY_ORIGIN}/api/ready"
)"
[[ "${public_ready_status}" == "404" ]] ||
  die "private platform readiness route is reachable through public ingress"

public_internal_status="$(
  curl_local_origin --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    --request POST --header 'content-type: application/json' --data '{}' \
    "${CADDY_ORIGIN}/internal/v1/signed-requests/verify"
)"
[[ "${public_internal_status}" == "404" ]] ||
  die "private verifier route is reachable through public ingress"

public_post_status() {
  curl_local_origin --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    --request POST --header 'content-type: application/json' --data '{}' \
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
done

refunddesk_compose exec \
  --env "REFUNDDESK_EXPECTED_REVISION=${EXPECTED_REVISION}" \
  --no-TTY web node -e '
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
    const response = await fetch(
      `${process.env.APP_BASE_URL}/api/webhooks/stripe-account/test`,
      {
        body: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": `t=${timestamp},v1=${signature}`,
        },
        method: "POST",
        signal: AbortSignal.timeout(20000),
      },
    );
    const body = await response.json().catch(() => null);
    if (
      response.status !== 200
      || body?.received !== true
      || body?.ignored !== true
      || body?.event_id !== eventId
      || response.headers.get("x-refunddesk-revision")
        !== process.env.REFUNDDESK_EXPECTED_REVISION
      || response.headers.get("cache-control") !== "no-store"
      || response.headers.get("x-cache") !== "Miss from cloudfront"
      || response.headers.get("x-amz-cf-id") === null
    ) {
      process.exit(1);
    }
  ' || die "CloudFront changed or bypassed the signed raw-body webhook relay"

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

refunddesk_compose exec --no-TTY web node -e '
  const response = await fetch("http://127.0.0.1:3000/api/ready", {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) process.exit(1);
'

refunddesk_compose exec --no-TTY worker node -e '
  const check = async (path) => {
    const response = await fetch(`http://127.0.0.1:3101${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) process.exit(1);
  };
  await check("/health");
  await check("/ready");
'

refunddesk_compose exec --no-TTY web node -e '
  const response = await fetch(process.env.REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 401) process.exit(1);
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
  refunddesk_compose exec --no-TTY web node -e '
    const response = await fetch("http://127.0.0.1:3000/api/ready", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) process.exit(1);
  '
  curl_local_origin \
    --fail --silent --show-error --max-time 20 \
    "${CADDY_ORIGIN}/api/health" >/dev/null
fi

log "deployment verification passed with live mode disabled"
