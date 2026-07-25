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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_maintenance') THEN
    CREATE ROLE refunddesk_maintenance
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
ALTER ROLE refunddesk_maintenance WITH
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
    'refunddesk_maintenance'
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

GRANT USAGE ON SCHEMA public TO refunddesk_runtime, refunddesk_worker;
GRANT SELECT ON tenants, stripe_installations TO refunddesk_runtime, refunddesk_worker;

-- Repair broad execution grants from earlier deployments before adding back
-- only the read models required by the request-detail UI.
REVOKE ALL PRIVILEGES ON
  refund_executions,
  refund_execution_attempts,
  refund_correlation_candidates
FROM refunddesk_runtime;
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
GRANT SELECT, INSERT, UPDATE ON
  tenant_users,
  approval_policies,
  refund_requests,
  webhook_receipts
TO refunddesk_runtime;
GRANT SELECT, INSERT ON approval_decisions, api_mutation_receipts TO refunddesk_runtime;

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
  api_mutation_receipts
  FROM refunddesk_runtime, refunddesk_worker;
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

-- Maintenance is a capability role, not a read/delete role. Revoke legacy
-- grants on every apply so an older deployment is repaired in place.
REVOKE CREATE ON SCHEMA public FROM refunddesk_maintenance;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM refunddesk_maintenance;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM refunddesk_maintenance;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM refunddesk_maintenance;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO refunddesk_maintenance;
GRANT EXECUTE ON FUNCTION refunddesk_purge_tenant(UUID, VARCHAR)
  TO refunddesk_maintenance;
