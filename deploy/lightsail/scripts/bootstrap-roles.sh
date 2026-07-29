#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

read_secret() {
  local path="$1"
  local value

  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  value="$(<"${path}")"
  [[ -n "${value}" && "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || return 1
  printf '%s' "${value}"
}

REFUNDDESK_POSTGRES_OWNER_PASSWORD="$(
  read_secret /run/secrets/postgres-owner-password
)"
REFUNDDESK_POSTGRES_WEB_PASSWORD="$(
  read_secret /run/secrets/postgres-web-password
)"
REFUNDDESK_POSTGRES_WORKER_PASSWORD="$(
  read_secret /run/secrets/postgres-worker-password
)"
REFUNDDESK_POSTGRES_QUEUE_PASSWORD="$(
  read_secret /run/secrets/postgres-queue-password
)"
REFUNDDESK_POSTGRES_MAINTENANCE_PASSWORD="$(
  read_secret /run/secrets/postgres-maintenance-password
)"
PGPASSWORD="${REFUNDDESK_POSTGRES_OWNER_PASSWORD}"
export \
  PGPASSWORD \
  REFUNDDESK_POSTGRES_OWNER_PASSWORD \
  REFUNDDESK_POSTGRES_WEB_PASSWORD \
  REFUNDDESK_POSTGRES_WORKER_PASSWORD \
  REFUNDDESK_POSTGRES_QUEUE_PASSWORD \
  REFUNDDESK_POSTGRES_MAINTENANCE_PASSWORD
export PGSSLMODE=verify-full
export PGSSLROOTCERT=/run/refunddesk/postgres-ca.crt
export PGOPTIONS="-c log_min_error_statement=PANIC"

exec psql \
  --host=postgres.refunddesk.internal \
  --port=5432 \
  --username="${POSTGRES_USER:?POSTGRES_USER is required}" \
  --dbname="${POSTGRES_DB:?POSTGRES_DB is required}" \
  --no-password \
  --file=/run/refunddesk/bootstrap-roles.sql
