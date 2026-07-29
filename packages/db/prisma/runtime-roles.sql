-- Run once as a database administrator. Login users are provisioned separately
-- and receive one of these NOLOGIN roles; passwords never belong in migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_runtime') THEN
    CREATE ROLE refunddesk_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_worker') THEN
    CREATE ROLE refunddesk_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_queue') THEN
    CREATE ROLE refunddesk_queue
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_maintenance') THEN
    CREATE ROLE refunddesk_maintenance
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'refunddesk_attestation_writer'
  ) THEN
    CREATE ROLE refunddesk_attestation_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- Repair all security attributes on every apply, including roles that predate
-- this script. Collective roles never authenticate and never retain passwords.
ALTER ROLE refunddesk_runtime WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
ALTER ROLE refunddesk_worker WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
ALTER ROLE refunddesk_queue WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
ALTER ROLE refunddesk_maintenance WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
ALTER ROLE refunddesk_attestation_writer WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;

DO $$
DECLARE
  collective_role NAME;
  parent_role NAME;
BEGIN
  FOREACH collective_role IN ARRAY ARRAY[
    'refunddesk_runtime',
    'refunddesk_worker',
    'refunddesk_queue',
    'refunddesk_maintenance',
    'refunddesk_attestation_writer'
  ]::NAME[]
  LOOP
    FOR parent_role IN
      SELECT parent.rolname
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS member ON member.oid = membership.member
      INNER JOIN pg_roles AS parent ON parent.oid = membership.roleid
      WHERE member.rolname = collective_role
    LOOP
      EXECUTE format('REVOKE %I FROM %I', parent_role, collective_role);
    END LOOP;
  END LOOP;
END
$$;

-- Reset every explicit grantee found on the application schema before adding
-- back the exact allowlist below. Listing ACL grantees dynamically also repairs
-- obsolete login and group roles that are no longer present in configuration.
DO $$
DECLARE
  application_type NAME;
  stale_grantee NAME;
BEGIN
  FOR stale_grantee IN
    WITH explicit_grantee(grantee) AS (
      SELECT privilege.grantee
      FROM pg_namespace AS namespace
      CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
      WHERE namespace.nspname = 'public'
      UNION
      SELECT privilege.grantee
      FROM pg_class AS relation
      INNER JOIN pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(relation.relacl) AS privilege
      WHERE namespace.nspname = 'public'
      UNION
      SELECT privilege.grantee
      FROM pg_attribute AS attribute
      INNER JOIN pg_class AS relation
        ON relation.oid = attribute.attrelid
      INNER JOIN pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
      WHERE namespace.nspname = 'public'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      UNION
      SELECT privilege.grantee
      FROM pg_proc AS routine
      INNER JOIN pg_namespace AS namespace
        ON namespace.oid = routine.pronamespace
      CROSS JOIN LATERAL aclexplode(routine.proacl) AS privilege
      WHERE namespace.nspname = 'public'
      UNION
      SELECT privilege.grantee
      FROM pg_type AS type
      INNER JOIN pg_namespace AS namespace
        ON namespace.oid = type.typnamespace
      CROSS JOIN LATERAL aclexplode(type.typacl) AS privilege
      WHERE namespace.nspname = 'public'
      UNION
      SELECT privilege.grantee
      FROM pg_default_acl AS default_acl
      LEFT JOIN pg_namespace AS namespace
        ON namespace.oid = default_acl.defaclnamespace
      CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS privilege
      WHERE default_acl.defaclrole = current_user::regrole
        AND (
          default_acl.defaclnamespace = 0
          OR namespace.nspname = 'public'
        )
    )
    SELECT role.rolname
    FROM explicit_grantee
    INNER JOIN pg_roles AS role ON role.oid = explicit_grantee.grantee
    WHERE explicit_grantee.grantee <> current_user::regrole
    GROUP BY role.rolname
    ORDER BY role.rolname
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM %I',
      stale_grantee
    );
    FOR application_type IN
      SELECT type.typname
      FROM pg_type AS type
      INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = 'public'
        AND type.typtype IN ('d', 'e', 'm', 'r')
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TYPE public.%I FROM %I',
        application_type,
        stale_grantee
      );
    END LOOP;
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON ROUTINES FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TYPES FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON ROUTINES FROM %I',
      stale_grantee
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TYPES FROM %I',
      stale_grantee
    );
  END LOOP;
END
$$;

REVOKE ALL PRIVILEGES ON SCHEMA public
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON ROUTINES
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TYPES
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON ROUTINES
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TYPES
  FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue,
    refunddesk_maintenance, refunddesk_attestation_writer;

GRANT USAGE ON SCHEMA public
  TO refunddesk_runtime, refunddesk_worker, refunddesk_attestation_writer;
DO $$
DECLARE
  application_type NAME;
BEGIN
  FOR application_type IN
    SELECT type.typname
    FROM pg_type AS type
    INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND type.typtype IN ('d', 'e', 'm', 'r')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TYPE public.%I FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue, refunddesk_maintenance, refunddesk_attestation_writer',
      application_type
    );
    EXECUTE format(
      'GRANT USAGE ON TYPE public.%I TO refunddesk_runtime, refunddesk_worker, refunddesk_attestation_writer',
      application_type
    );
  END LOOP;
END
$$;
GRANT SELECT ON
  refunddesk_database_identity,
  tenants,
  stripe_installations
TO refunddesk_runtime, refunddesk_worker;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON refunddesk_database_identity
  FROM refunddesk_runtime, refunddesk_worker;

-- Add back only the read models required by the request-detail UI.
GRANT SELECT ON refund_executions, refund_execution_attempts
TO refunddesk_runtime;

GRANT UPDATE ("status", "pending_delete_at", "updated_at")
  ON tenants TO refunddesk_runtime;
GRANT UPDATE ("status", "pending_delete_at", "updated_at")
  ON tenants TO refunddesk_worker;
GRANT UPDATE (
  "status",
  "onboarding_completed_at",
  "deauthorized_at",
  "last_lifecycle_event_id",
  "last_lifecycle_event_type",
  "last_lifecycle_event_created_at",
  "updated_at"
) ON stripe_installations TO refunddesk_runtime;
GRANT UPDATE (
  "status",
  "deauthorized_at",
  "last_lifecycle_event_id",
  "last_lifecycle_event_type",
  "last_lifecycle_event_created_at",
  "updated_at"
) ON stripe_installations TO refunddesk_worker;
GRANT SELECT, INSERT ON tenant_users TO refunddesk_runtime;
GRANT UPDATE (
  "display_name",
  "stripe_roles",
  "approver_enabled",
  "last_verified_at",
  "updated_at"
) ON tenant_users TO refunddesk_runtime;
GRANT SELECT, INSERT, UPDATE ON
  approval_policies,
  refund_requests,
  webhook_receipts
TO refunddesk_runtime;
GRANT SELECT, INSERT ON approval_decisions, api_mutation_receipts TO refunddesk_runtime;
GRANT SELECT, INSERT ON approval_attestations
  TO refunddesk_attestation_writer;

GRANT SELECT, UPDATE ON refund_requests TO refunddesk_worker;
GRANT SELECT, INSERT, UPDATE ON
  refund_executions,
  refund_execution_attempts,
  refund_correlation_candidates,
  webhook_receipts,
  reconciliation_checkpoints
TO refunddesk_worker;
GRANT SELECT ON tenant_users, approval_policies, approval_decisions
  TO refunddesk_worker;

-- External alerts are permanent payment protection in the pilot. Observation
-- can create them and runtime can acknowledge them, but neither role can set
-- reconciled_at or mutate the protected financial scope.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON external_refund_alerts
  FROM refunddesk_runtime, refunddesk_worker;
GRANT SELECT ON external_refund_alerts
  TO refunddesk_runtime, refunddesk_worker;
GRANT INSERT (
  "tenant_id",
  "installation_id",
  "environment",
  "stripe_refund_id",
  "stripe_refund_created_at",
  "payment_key",
  "amount_minor",
  "currency",
  "classification",
  "detected_at",
  "overlapped_request_id"
) ON external_refund_alerts TO refunddesk_runtime, refunddesk_worker;
GRANT UPDATE (
  "status",
  "acknowledged_at",
  "acknowledged_by_user_id"
) ON external_refund_alerts TO refunddesk_runtime;

GRANT SELECT, INSERT ON audit_events TO refunddesk_runtime, refunddesk_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON
  audit_events,
  approval_decisions,
  approval_attestations,
  api_mutation_receipts
  FROM refunddesk_runtime, refunddesk_worker, refunddesk_attestation_writer;
GRANT EXECUTE ON FUNCTION refunddesk_current_tenant_id()
  TO refunddesk_runtime, refunddesk_worker;
GRANT EXECUTE ON FUNCTION refunddesk_lock_payment_scope(
  UUID,
  UUID,
  stripe_environment,
  VARCHAR
) TO refunddesk_runtime, refunddesk_worker;
GRANT EXECUTE ON FUNCTION refunddesk_resolve_installation(VARCHAR, stripe_environment)
  TO refunddesk_runtime, refunddesk_worker;
GRANT EXECUTE ON FUNCTION refunddesk_provision_installation(VARCHAR, stripe_environment)
  TO refunddesk_runtime;
GRANT EXECUTE ON FUNCTION refunddesk_provision_webhook_installation(
  VARCHAR,
  stripe_environment,
  VARCHAR,
  TIMESTAMPTZ
) TO refunddesk_runtime;
GRANT EXECUTE ON FUNCTION refunddesk_find_webhook_receipt(
  webhook_endpoint,
  VARCHAR,
  VARCHAR
) TO refunddesk_runtime;
GRANT EXECUTE ON FUNCTION refunddesk_find_webhook_receipt_v2(
  webhook_endpoint,
  VARCHAR,
  VARCHAR
) TO refunddesk_runtime;
GRANT EXECUTE ON FUNCTION refunddesk_resolve_webhook_installation(
  VARCHAR,
  stripe_environment
) TO refunddesk_runtime;
GRANT EXECUTE ON FUNCTION refunddesk_list_scannable_installations()
  TO refunddesk_worker;
GRANT EXECUTE ON FUNCTION refunddesk_list_active_tenant_ids()
  TO refunddesk_worker;
GRANT EXECUTE ON FUNCTION refunddesk_list_recoverable_webhook_receipts(INTEGER)
  TO refunddesk_worker;
GRANT EXECUTE ON FUNCTION refunddesk_list_recoverable_webhook_receipts_v2(INTEGER)
  TO refunddesk_worker;

-- Maintenance is a capability role, not a read/delete role.
GRANT USAGE ON SCHEMA public TO refunddesk_maintenance;
GRANT EXECUTE ON FUNCTION refunddesk_list_due_tenant_purges(INTEGER)
  TO refunddesk_maintenance;
GRANT EXECUTE ON FUNCTION refunddesk_purge_test_sandbox_tenant(UUID, VARCHAR)
  TO refunddesk_maintenance;
