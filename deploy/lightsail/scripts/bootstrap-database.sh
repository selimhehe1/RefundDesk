#!/usr/bin/env bash

# Database bootstrap contract:
# - Compose project/file come from _common.sh.
# - /etc/refunddesk/postgres.env contains only non-runtime settings and
#   POSTGRES_PASSWORD_FILE; it is root:root 0600.
# - Four root-only files below /etc/refunddesk/secrets are mounted only into
#   one-shot bootstrap (and the owner file into PostgreSQL for initdb).
# - The Compose bootstrap service uses postgres:18.4, TLS verify-full and psql
#   to create/repair exactly three LOGIN roles. It receives no password through
#   argv or a long-lived container environment.
# - Capability roles, memberships, schemas, RLS and grants remain exclusively
#   owned by the serialized release migration.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_root
require_command docker
acquire_operator_lock

POSTGRES_ENV="${REFUNDDESK_CONFIG_ROOT}/postgres.env"
assert_root_secret_file "${POSTGRES_ENV}"
SECRETS_ROOT="${REFUNDDESK_CONFIG_ROOT}/secrets"
for secret_name in \
  postgres-owner-password \
  postgres-web-password \
  postgres-worker-password \
  postgres-queue-password; do
  assert_root_secret_file "${SECRETS_ROOT}/${secret_name}"
done

# Compose must parse all services even though only PostgreSQL is started.
export REFUNDDESK_IMAGE_TAG="${REFUNDDESK_IMAGE_TAG:-bootstrap-only}"
refunddesk_compose config --quiet
refunddesk_compose up --detach --no-build postgres

deadline=$((SECONDS + 120))
until refunddesk_compose exec --no-TTY postgres pg_isready --quiet; do
  (( SECONDS < deadline )) || die "PostgreSQL did not become ready within 120 seconds"
  sleep 2
done

refunddesk_compose --profile release run --rm --no-deps --no-build bootstrap

log "PostgreSQL is ready and exactly three restricted runtime logins were repaired"
