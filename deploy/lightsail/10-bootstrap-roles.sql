\set ON_ERROR_STOP on
\getenv refunddesk_owner_password REFUNDDESK_POSTGRES_OWNER_PASSWORD
\getenv refunddesk_web_password REFUNDDESK_POSTGRES_WEB_PASSWORD
\getenv refunddesk_worker_password REFUNDDESK_POSTGRES_WORKER_PASSWORD
\getenv refunddesk_queue_password REFUNDDESK_POSTGRES_QUEUE_PASSWORD
\getenv refunddesk_maintenance_password REFUNDDESK_POSTGRES_MAINTENANCE_PASSWORD

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

SELECT count(*) = 5
  AND count(DISTINCT password_value) = 5
  AND min(length(password_value)) >= 32
  AS refunddesk_passwords_valid
FROM (
  VALUES
    (:'refunddesk_owner_password'),
    (:'refunddesk_web_password'),
    (:'refunddesk_worker_password'),
    (:'refunddesk_queue_password'),
    (:'refunddesk_maintenance_password')
) AS passwords(password_value)
\gset

\if :refunddesk_passwords_valid
\else
\echo 'Database password files must be non-empty, distinct values of at least 32 characters.'
\quit 3
\endif

SELECT
  'CREATE ROLE refunddesk_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'refunddesk_maintenance'
)
\gexec
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
SELECT
  'CREATE ROLE refunddesk_maintenance_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'refunddesk_maintenance_login'
)
\gexec

ALTER ROLE refunddesk_maintenance WITH NOLOGIN PASSWORD NULL
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE refunddesk_web_login WITH LOGIN PASSWORD :'refunddesk_web_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE refunddesk_worker_login WITH LOGIN PASSWORD :'refunddesk_worker_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE refunddesk_queue_login WITH LOGIN PASSWORD :'refunddesk_queue_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE refunddesk_maintenance_login WITH LOGIN PASSWORD :'refunddesk_maintenance_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;

SELECT format(
  'REVOKE %I FROM refunddesk_maintenance_login',
  parent.rolname
)
FROM pg_catalog.pg_auth_members AS membership
INNER JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
INNER JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
WHERE member.rolname = 'refunddesk_maintenance_login'
\gexec

SELECT format(
  'REVOKE refunddesk_maintenance_login FROM %I',
  member.rolname
)
FROM pg_catalog.pg_auth_members AS membership
INNER JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
INNER JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
WHERE parent.rolname = 'refunddesk_maintenance_login'
\gexec

SELECT format(
  'REVOKE %I FROM refunddesk_maintenance',
  parent.rolname
)
FROM pg_catalog.pg_auth_members AS membership
INNER JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
INNER JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
WHERE member.rolname = 'refunddesk_maintenance'
\gexec

SELECT format(
  'REVOKE refunddesk_maintenance FROM %I',
  member.rolname
)
FROM pg_catalog.pg_auth_members AS membership
INNER JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
INNER JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
WHERE parent.rolname = 'refunddesk_maintenance'
\gexec

GRANT refunddesk_maintenance TO refunddesk_maintenance_login;
REVOKE refunddesk_maintenance
  FROM refunddesk_web_login, refunddesk_worker_login, refunddesk_queue_login;
