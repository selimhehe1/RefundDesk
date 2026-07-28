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
require_command ss

ORIGIN_FILE="${REFUNDDESK_CONFIG_ROOT}/public-origin"
assert_regular_file "${ORIGIN_FILE}"
IFS= read -r CONFIGURED_PUBLIC_ORIGIN <"${ORIGIN_FILE}"
if [[ -n "${PUBLIC_ORIGIN}" && "${PUBLIC_ORIGIN}" != "${CONFIGURED_PUBLIC_ORIGIN}" ]]; then
  die "supplied public origin differs from the root-owned origin file"
fi
PUBLIC_ORIGIN="${CONFIGURED_PUBLIC_ORIGIN}"
[[ "${PUBLIC_ORIGIN}" =~ ^https://[A-Za-z0-9.-]+$ ]] ||
  die "public origin must be an HTTPS origin without a path"
PUBLIC_HOST="${PUBLIC_ORIGIN#https://}"

curl_local_public() {
  curl \
    --resolve "${PUBLIC_HOST}:443:127.0.0.1" \
    --noproxy '*' \
    --proto '=https' \
    --tlsv1.2 \
    "$@"
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
until curl_local_public \
  --fail --silent \
  --connect-timeout 5 --max-time 15 \
  "${PUBLIC_ORIGIN}/api/health" >/dev/null; do
  (( SECONDS < https_deadline )) ||
    die "local public HTTPS did not become ready within 180 seconds"
  sleep 3
done

public_ready_status="$(
  curl_local_public --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    "${PUBLIC_ORIGIN}/api/ready"
)"
[[ "${public_ready_status}" == "404" ]] ||
  die "private platform readiness route is reachable through public ingress"

public_internal_status="$(
  curl_local_public --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    --request POST --header 'content-type: application/json' --data '{}' \
    "${PUBLIC_ORIGIN}/internal/v1/signed-requests/verify"
)"
[[ "${public_internal_status}" == "404" ]] ||
  die "private verifier route is reachable through public ingress"

public_post_status() {
  curl_local_public --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    --request POST --header 'content-type: application/json' --data '{}' \
    "${PUBLIC_ORIGIN}${1}"
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
  acquire_operator_lock
  for service in worker web; do
    started_at="${SECONDS}"
    refunddesk_compose stop --timeout 45 "${service}"
    elapsed=$((SECONDS - started_at))
    (( elapsed <= 50 )) || die "${service} did not stop inside the grace window"
    container_id="$(service_container_id "${service}")"
    exit_code="$(docker inspect --format='{{.State.ExitCode}}' "${container_id}")"
    [[ "${exit_code}" == "0" || "${exit_code}" == "143" ]] ||
      die "${service} exited abnormally during graceful-stop verification"
    refunddesk_compose up --detach --no-deps --no-build "${service}"
    wait_for_container_health "${service}" 180 ||
      die "${service} did not recover after graceful-stop verification"
  done
  refunddesk_compose exec --no-TTY web node -e '
    const response = await fetch("http://127.0.0.1:3000/api/ready", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) process.exit(1);
  '
  curl_local_public \
    --fail --silent --show-error --max-time 20 \
    "${PUBLIC_ORIGIN}/api/health" >/dev/null
fi

log "deployment verification passed with live mode disabled"
