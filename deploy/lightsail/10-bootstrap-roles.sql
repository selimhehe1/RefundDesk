\set ON_ERROR_STOP on
\getenv refunddesk_owner_password REFUNDDESK_POSTGRES_OWNER_PASSWORD
\getenv refunddesk_web_password REFUNDDESK_POSTGRES_WEB_PASSWORD
\getenv refunddesk_worker_password REFUNDDESK_POSTGRES_WORKER_PASSWORD
\getenv refunddesk_queue_password REFUNDDESK_POSTGRES_QUEUE_PASSWORD

SELECT
  current_setting('is_superuser') = 'on'
  AND lower(current_setting('log_min_error_statement')) = 'panic'
  AS refunddesk_bootstrap_session_safe
\gset

\if :refunddesk_bootstrap_session_safe
\else
\echo 'Database bootstrap requires a superuser session with statement error logging disabled.'
\quit 4
\endif

SELECT
  length(:'refunddesk_owner_password') >= 32
  AND length(:'refunddesk_web_password') >= 32
  AND length(:'refunddesk_worker_password') >= 32
  AND length(:'refunddesk_queue_password') >= 32
  AND :'refunddesk_owner_password' <> :'refunddesk_web_password'
  AND :'refunddesk_owner_password' <> :'refunddesk_worker_password'
  AND :'refunddesk_owner_password' <> :'refunddesk_queue_password'
  AND :'refunddesk_web_password' <> :'refunddesk_worker_password'
  AND :'refunddesk_web_password' <> :'refunddesk_queue_password'
  AND :'refunddesk_worker_password' <> :'refunddesk_queue_password'
  AS refunddesk_passwords_valid
\gset

\if :refunddesk_passwords_valid
\else
\echo 'Database password files must be non-empty, distinct values of at least 32 characters.'
\quit 3
\endif

SELECT
  'CREATE ROLE refunddesk_web_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'refunddesk_web_login'
)
\gexec
SELECT
  'CREATE ROLE refunddesk_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'refunddesk_worker_login'
)
\gexec
SELECT
  'CREATE ROLE refunddesk_queue_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'refunddesk_queue_login'
)
\gexec

ALTER ROLE refunddesk_web_login WITH LOGIN PASSWORD :'refunddesk_web_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE refunddesk_worker_login WITH LOGIN PASSWORD :'refunddesk_worker_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE refunddesk_queue_login WITH LOGIN PASSWORD :'refunddesk_queue_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
