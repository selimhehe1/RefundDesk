-- LOCAL DEVELOPMENT ONLY.
--
-- The PostgreSQL image runs this file only when it initializes an empty volume.
-- The fixed passwords match .env.example and must never be reused outside the
-- loopback-only Docker service.

DO $refunddesk_local_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_runtime') THEN
    CREATE ROLE refunddesk_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_worker') THEN
    CREATE ROLE refunddesk_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_queue') THEN
    CREATE ROLE refunddesk_queue
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_maintenance') THEN
    CREATE ROLE refunddesk_maintenance
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_attestation_writer') THEN
    CREATE ROLE refunddesk_attestation_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_web_login') THEN
    CREATE ROLE refunddesk_web_login LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_worker_login') THEN
    CREATE ROLE refunddesk_worker_login LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_queue_login') THEN
    CREATE ROLE refunddesk_queue_login LOGIN;
  END IF;
END
$refunddesk_local_roles$;

ALTER ROLE refunddesk_web_login WITH
  LOGIN PASSWORD 'refunddesk_web_local'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE refunddesk_worker_login WITH
  LOGIN PASSWORD 'refunddesk_worker_local'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE refunddesk_queue_login WITH
  LOGIN PASSWORD 'refunddesk_queue_local'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;

GRANT refunddesk_runtime TO refunddesk_web_login;
GRANT refunddesk_worker TO refunddesk_worker_login;
GRANT refunddesk_queue TO refunddesk_queue_login;
GRANT refunddesk_attestation_writer TO refunddesk_worker_login;
REVOKE refunddesk_worker, refunddesk_queue, refunddesk_maintenance,
  refunddesk_attestation_writer
  FROM refunddesk_web_login;
REVOKE refunddesk_runtime, refunddesk_queue, refunddesk_maintenance
  FROM refunddesk_worker_login;
REVOKE refunddesk_runtime, refunddesk_worker, refunddesk_maintenance,
  refunddesk_attestation_writer
  FROM refunddesk_queue_login;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
