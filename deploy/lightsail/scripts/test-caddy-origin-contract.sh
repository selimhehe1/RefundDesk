#!/usr/bin/env bash

# Exercise the public-origin authentication route without publishing a port or
# attaching the disposable Caddy process to any Docker network.  The production
# secret is validated for shape only; the functional probe uses a synthetic
# 32-byte token that is safe to retain in test output.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
CADDYFILE="${SOURCE_ROOT}/deploy/lightsail/Caddyfile.public"
CADDY_ENV="${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}/caddy.env"
REVISION=""
readonly CADDY_IMAGE="caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648"
readonly SYNTHETIC_TOKEN="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
readonly FROZEN_VIEWER_CHAIN="198.51.100.7, 2001:db8::7"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bash test-caddy-origin-contract.sh --revision FULL_SHA [--caddyfile FILE] [--caddy-env FILE]

The test starts one disposable, network-none Caddy container and publishes no
host port. It never sends a request to CloudFront, the public origin or the web.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --revision)
      (( $# >= 2 )) || die "--revision requires a value"
      REVISION="$2"
      shift 2
      ;;
    --caddyfile)
      (( $# >= 2 )) || die "--caddyfile requires a value"
      CADDYFILE="$2"
      shift 2
      ;;
    --caddy-env)
      (( $# >= 2 )) || die "--caddy-env requires a value"
      CADDY_ENV="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || die "revision must be a full lowercase Git SHA"
for command_name in awk cat chmod docker grep mktemp python3 readlink rm sleep stat tr wc; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
expected_caddy_image_id="$(docker image inspect --format '{{.Id}}' -- "${CADDY_IMAGE}")" ||
  die "the pinned Caddy image is not already present"
[[ "${expected_caddy_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the pinned Caddy image ID is invalid"
[[ -f "${CADDYFILE}" && ! -L "${CADDYFILE}" ]] || die "Caddyfile must be a regular non-symlink file"
[[ -f "${CADDY_ENV}" && ! -L "${CADDY_ENV}" ]] || die "caddy.env must be a regular non-symlink file"
[[ "${CADDYFILE}" == /* && "$(readlink --canonicalize-existing -- "${CADDYFILE}")" == "${CADDYFILE}" ]] ||
  die "Caddyfile must use its canonical absolute path"
[[ "${CADDY_ENV}" == /* && "$(readlink --canonicalize-existing -- "${CADDY_ENV}")" == "${CADDY_ENV}" ]] ||
  die "caddy.env must use its canonical absolute path"
if (( EUID == 0 )); then
  [[ "$(stat --format='%u' -- "${CADDY_ENV}")" == "0" ]] || die "caddy.env must be owned by root"
  mode="$(stat --format='%a' -- "${CADDY_ENV}")"
  (( (8#${mode} & 077) == 0 )) || die "caddy.env must be root-only"
fi

# Never print the configured token. Python validates the complete environment
# grammar and canonical base64url length in-process, returning no value.
python3 - "${CADDY_ENV}" <<'PY'
import base64
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    lines = path.read_text(encoding="utf-8").splitlines()
except (OSError, UnicodeError) as error:
    raise SystemExit("caddy.env is unreadable") from error
values = {}
for line in lines:
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*=[^\r\n]*", line):
        raise SystemExit("caddy.env has a malformed line")
    name, value = line.split("=", 1)
    if name in values:
        raise SystemExit("caddy.env has a duplicate key")
    values[name] = value
if set(values) != {"REFUNDDESK_ACME_EMAIL", "REFUNDDESK_EDGE_ORIGIN_TOKEN", "REFUNDDESK_PUBLIC_HOST"}:
    raise SystemExit("caddy.env has unexpected keys")
token = values["REFUNDDESK_EDGE_ORIGIN_TOKEN"]
if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
    raise SystemExit("origin token is not canonical base64url")
try:
    decoded = base64.urlsafe_b64decode(token + "=")
except ValueError as error:
    raise SystemExit("origin token is not decodable") from error
if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != token:
    raise SystemExit("origin token is not a canonical 32-byte value")
PY

work_directory="$(mktemp --directory "${TMPDIR:-/tmp}/refunddesk-caddy-origin.XXXXXX")"
backend_handler="${work_directory}/backend-handler.sh"
backend_loop="${work_directory}/backend-loop.sh"
container_name="refunddesk-caddy-origin-contract-$$-${RANDOM}"
container_id=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "${container_id}" ]]; then
    docker rm --force --volumes "${container_id}" >/dev/null 2>&1 || status=1
  fi
  if [[ -d "${work_directory}" && ! -L "${work_directory}" ]]; then
    rm --recursive --force --one-file-system -- "${work_directory}" || status=1
  fi
  exit "${status}"
}
trap cleanup EXIT

cat >"${backend_handler}" <<'EOF'
#!/bin/sh
edge=missing
viewer=missing
token=absent
while IFS= read -r line; do
	line="${line%$(printf '\r')}"
	[ -n "${line}" ] || break
	name="$(printf '%s' "${line%%:*}" | tr '[:upper:]' '[:lower:]')"
	value="${line#*:}"
	value="${value# }"
	case "${name}" in
		x-refunddesk-edge-verified) edge="${value}" ;;
		x-refunddesk-viewer-chain) viewer="${value}" ;;
		x-refunddesk-origin-token) token=present ;;
	esac
done
body="edge=${edge}
viewer=${viewer}
token=${token}
"
length="$(printf '%s' "${body}" | wc -c | tr -d '[:space:]')"
printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "${length}" "${body}"
EOF
cat >"${backend_loop}" <<'EOF'
#!/bin/sh
while true; do
	nc -l -p 3000 -e /srv/backend-handler.sh
done
EOF
chmod 0500 "${backend_handler}" "${backend_loop}"

docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 32 --memory 48m \
  --tmpfs /config:rw,nosuid,nodev,noexec,size=4m \
  --tmpfs /data:rw,nosuid,nodev,noexec,size=4m \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=4m \
  --env "REFUNDDESK_EDGE_ORIGIN_TOKEN=${SYNTHETIC_TOKEN}" \
  --env "REFUNDDESK_PUBLIC_HOST=localhost" \
  --env "REFUNDDESK_ACME_EMAIL=contained-origin@example.invalid" \
  --env "REFUNDDESK_REVISION=${REVISION}" \
  --mount "type=bind,source=${CADDYFILE},target=/etc/caddy/Caddyfile,readonly" \
  --entrypoint /bin/sh \
  "${CADDY_IMAGE}" -eu -c \
  '/usr/bin/caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null && exec /usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile' >/dev/null

container_id="$(docker run --detach --pull never --network none --read-only --cap-drop ALL \
  --name "${container_name}" --security-opt no-new-privileges:true \
  --add-host web.refunddesk.internal:127.0.0.1 \
  --pids-limit 32 --memory 48m \
  --tmpfs /config:rw,nosuid,nodev,noexec,size=4m \
  --tmpfs /data:rw,nosuid,nodev,noexec,size=4m \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=4m \
  --env "REFUNDDESK_EDGE_ORIGIN_TOKEN=${SYNTHETIC_TOKEN}" \
  --env "REFUNDDESK_PUBLIC_HOST=localhost" \
  --env "REFUNDDESK_ACME_EMAIL=contained-origin@example.invalid" \
  --env "REFUNDDESK_REVISION=${REVISION}" \
  --mount "type=bind,source=${CADDYFILE},target=/etc/caddy/Caddyfile,readonly" \
  --mount "type=bind,source=${backend_handler},target=/srv/backend-handler.sh,readonly" \
  --mount "type=bind,source=${backend_loop},target=/srv/backend-loop.sh,readonly" \
  --entrypoint /bin/sh \
  "${CADDY_IMAGE}" -c '/srv/backend-loop.sh & exec /usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile')"
[[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] || die "Docker returned an invalid disposable container ID"
[[ "$(docker inspect --format '{{.Image}}' "${container_id}")" == "${expected_caddy_image_id}" ]] ||
  die "the disposable Caddy image ID differs from the pinned local image"
docker inspect "${container_id}" | python3 -c '
import json,sys
value=json.load(sys.stdin)
if len(value)!=1 or value[0]["HostConfig"]["NetworkMode"]!="none": raise SystemExit(1)
if value[0]["HostConfig"].get("PortBindings") not in (None, {}): raise SystemExit(1)
ports=value[0]["NetworkSettings"].get("Ports") or {}
if any(bindings not in (None, []) for bindings in ports.values()): raise SystemExit(1)
' || die "the disposable Caddy container exposed a network or published port"

deadline=$((SECONDS + 20))
until docker exec "${container_id}" wget --quiet --spider http://127.0.0.1:2019/config/; do
  (( SECONDS < deadline )) || die "disposable Caddy did not become ready"
  sleep 1
done

missing_status="$(docker exec "${container_id}" sh -eu -c \
  'wget --no-check-certificate -S -O /dev/null https://localhost:8443/ 2>&1 || true' |
  awk '/HTTP\// {code=$2} END {print code}')"
[[ "${missing_status}" == "404" ]] || die "a missing origin token was not rejected with 404"

wrong_status="$(docker exec "${container_id}" sh -eu -c \
  'wget --no-check-certificate -S -O /dev/null --header="X-RefundDesk-Origin-Token: wrong" https://localhost:8443/ 2>&1 || true' |
  awk '/HTTP\// {code=$2} END {print code}')"
[[ "${wrong_status}" == "404" ]] || die "an incorrect origin token was not rejected with 404"

correct_body="$(docker exec "${container_id}" sh -eu -c \
  'wget --no-check-certificate -qO- --header="X-RefundDesk-Origin-Token: ${REFUNDDESK_EDGE_ORIGIN_TOKEN}" --header="X-Forwarded-For: 198.51.100.7, 2001:db8::7" https://localhost:8443/')"
expected_body="$(printf 'edge=cloudfront-v1\nviewer=%s\ntoken=absent' "${FROZEN_VIEWER_CHAIN}")"
[[ "${correct_body}" == "${expected_body}" ]] ||
  die "the exact-token upstream header contract failed"
docker exec "${container_id}" test ! -e /config/caddy/autosave.json ||
  die "Caddy autosave residue was created"

printf '{"autosaveAbsent":true,"exactTokenStatus":200,"frozenViewerChain":true,"kind":"refunddesk-caddy-origin-contract","missingTokenStatus":404,"networkMode":"none","publishedPorts":false,"revision":"%s","schemaVersion":1,"tokenStripped":true,"wrongTokenStatus":404}\n' \
  "${REVISION}"
