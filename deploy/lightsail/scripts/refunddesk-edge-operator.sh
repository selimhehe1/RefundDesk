#!/usr/bin/env bash

set -Eeuo pipefail
set +x
set +a
umask 077
export LC_ALL=C

readonly EXPECTED_UID=10001
readonly RUNNER=/workspace/deploy/lightsail/scripts/prove-bounded-edge-window.sh

[[ "$(id -u)" == "${EXPECTED_UID}" ]] || exit 64
[[ "$(pwd -P)" == /workspace ]] || exit 64
[[ -f "${RUNNER}" && ! -L "${RUNNER}" && -x "${RUNNER}" ]] || exit 64
[[ ! -e /var/run/docker.sock && ! -e /run/docker.sock ]] || exit 64
[[ "${REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-}" == 1 ]] || exit 64
[[ -z "${REFUNDDESK_EDGE_WINDOW_COMMAND:-}" && -z "${REFUNDDESK_EDGE_WINDOW_TEST_MODE:-}" ]] || exit 64

exec /usr/bin/bash "${RUNNER}" "$@"

