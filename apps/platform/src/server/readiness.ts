export interface PlatformReadinessRow {
  readonly audit_append_only: boolean;
  readonly database_writable: boolean;
  readonly postgres_supported: boolean;
  readonly restricted_runtime_role: boolean;
  readonly rls_forced: boolean;
  readonly runtime_authority_ready: boolean;
  readonly schema_contract_ready: boolean;
  readonly schema_ready: boolean;
}

const TENANT_TABLES = [
  "tenants",
  "stripe_installations",
  "tenant_users",
  "approval_policies",
  "refund_requests",
  "approval_decisions",
  "approval_attestations",
  "refund_executions",
  "refund_execution_attempts",
  "refund_correlation_candidates",
  "webhook_receipts",
  "external_refund_alerts",
  "audit_events",
  "api_mutation_receipts",
  "reconciliation_checkpoints",
] as const;

const expectedTablesSql = TENANT_TABLES.map((name) => `('${name}')`).join(", ");

export const PLATFORM_READINESS_SQL = `
WITH expected_table(name) AS (
  VALUES ${expectedTablesSql}
),
resolved_table AS (
  SELECT name, to_regclass(format('public.%I', name)) AS oid
  FROM expected_table
),
runtime_role AS (
  SELECT
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolbypassrls,
    rolreplication,
    pg_has_role(current_user, 'refunddesk_runtime', 'USAGE')
      AND NOT pg_has_role(current_user, 'refunddesk_worker', 'USAGE')
      AND current_setting('session_replication_role') = 'origin'
      AND NOT has_parameter_privilege(
        current_user,
        'session_replication_role',
        'SET'
      )
      AND NOT has_parameter_privilege(
        current_user,
        'session_replication_role',
        'ALTER SYSTEM'
      )
      AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
      AND has_table_privilege(current_user, 'tenants', 'SELECT')
      AND has_table_privilege(current_user, 'refund_requests', 'SELECT')
      AND has_table_privilege(current_user, 'refund_requests', 'INSERT')
      AND has_table_privilege(current_user, 'refund_requests', 'UPDATE')
      AND has_table_privilege(current_user, 'approval_decisions', 'INSERT')
      AND has_table_privilege(current_user, 'api_mutation_receipts', 'INSERT')
      AND has_table_privilege(current_user, 'audit_events', 'INSERT')
      AND has_table_privilege(current_user, 'webhook_receipts', 'SELECT')
      AND has_table_privilege(current_user, 'webhook_receipts', 'INSERT')
      AND has_table_privilege(current_user, 'webhook_receipts', 'UPDATE')
      AND NOT has_table_privilege(current_user, 'refund_requests', 'DELETE')
      AND NOT has_table_privilege(current_user, 'refund_requests', 'TRUNCATE')
      AND NOT (
        has_table_privilege(current_user, 'approval_decisions', 'UPDATE')
        OR has_any_column_privilege(current_user, 'approval_decisions', 'UPDATE')
        OR has_table_privilege(current_user, 'approval_decisions', 'DELETE')
        OR has_table_privilege(current_user, 'approval_decisions', 'TRUNCATE')
        OR has_table_privilege(current_user, 'approval_attestations', 'SELECT')
        OR has_any_column_privilege(current_user, 'approval_attestations', 'SELECT')
        OR has_table_privilege(current_user, 'approval_attestations', 'INSERT')
        OR has_any_column_privilege(current_user, 'approval_attestations', 'INSERT')
        OR has_table_privilege(current_user, 'approval_attestations', 'UPDATE')
        OR has_any_column_privilege(current_user, 'approval_attestations', 'UPDATE')
        OR has_table_privilege(current_user, 'approval_attestations', 'DELETE')
        OR has_table_privilege(current_user, 'approval_attestations', 'TRUNCATE')
        OR has_table_privilege(current_user, 'api_mutation_receipts', 'UPDATE')
        OR has_any_column_privilege(current_user, 'api_mutation_receipts', 'UPDATE')
        OR has_table_privilege(current_user, 'api_mutation_receipts', 'DELETE')
        OR has_table_privilege(current_user, 'api_mutation_receipts', 'TRUNCATE')
      )
      AND NOT (
        has_table_privilege(current_user, 'refund_executions', 'INSERT')
        OR has_any_column_privilege(current_user, 'refund_executions', 'INSERT')
        OR has_table_privilege(current_user, 'refund_executions', 'UPDATE')
        OR has_any_column_privilege(current_user, 'refund_executions', 'UPDATE')
        OR has_table_privilege(current_user, 'refund_executions', 'DELETE')
        OR has_table_privilege(current_user, 'refund_executions', 'TRUNCATE')
        OR has_table_privilege(current_user, 'refund_execution_attempts', 'INSERT')
        OR has_any_column_privilege(current_user, 'refund_execution_attempts', 'INSERT')
        OR has_table_privilege(current_user, 'refund_execution_attempts', 'UPDATE')
        OR has_any_column_privilege(current_user, 'refund_execution_attempts', 'UPDATE')
        OR has_table_privilege(current_user, 'refund_execution_attempts', 'DELETE')
        OR has_table_privilege(current_user, 'refund_execution_attempts', 'TRUNCATE')
        OR has_table_privilege(current_user, 'refund_correlation_candidates', 'INSERT')
        OR has_any_column_privilege(current_user, 'refund_correlation_candidates', 'INSERT')
        OR has_table_privilege(current_user, 'refund_correlation_candidates', 'UPDATE')
        OR has_any_column_privilege(current_user, 'refund_correlation_candidates', 'UPDATE')
        OR has_table_privilege(current_user, 'refund_correlation_candidates', 'DELETE')
        OR has_table_privilege(current_user, 'refund_correlation_candidates', 'TRUNCATE')
      ) AS authority_ready
  FROM pg_roles
  WHERE rolname = current_user
),
schema_contract AS (
  SELECT
    to_regclass('public.refunddesk_database_identity') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.refunddesk_database_identity
        WHERE singleton
          AND schema_contract_version = 1
      )
      AND to_regprocedure('public.refunddesk_list_scannable_installations()') IS NOT NULL
      AND to_regprocedure('public.refunddesk_list_active_tenant_ids()') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM pg_enum
        INNER JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE pg_type.typname = 'stripe_refund_status'
          AND pg_enum.enumlabel = 'canceled'
      ) AS ready
)
SELECT
  current_setting('server_version_num')::integer >= 180000
    AND current_setting('server_version_num')::integer < 190000 AS postgres_supported,
  current_setting('transaction_read_only') = 'off'
    AND NOT pg_is_in_recovery() AS database_writable,
  count(resolved_table.oid) = ${TENANT_TABLES.length} AS schema_ready,
  schema_contract.ready AS schema_contract_ready,
  count(resolved_table.oid) = ${TENANT_TABLES.length}
    AND coalesce(bool_and(pg_class.relrowsecurity AND pg_class.relforcerowsecurity), false)
    AS rls_forced,
  coalesce(bool_and(
    NOT runtime_role.rolsuper
    AND NOT runtime_role.rolcreatedb
    AND NOT runtime_role.rolcreaterole
    AND NOT runtime_role.rolbypassrls
    AND NOT runtime_role.rolreplication
  ), false)
    AS restricted_runtime_role,
  coalesce(bool_and(runtime_role.authority_ready), false) AS runtime_authority_ready,
  NOT coalesce(has_table_privilege(
    current_user,
    to_regclass('public.audit_events'),
    'UPDATE'
  ), true)
    AND NOT coalesce(has_any_column_privilege(
      current_user,
      to_regclass('public.audit_events'),
      'UPDATE'
    ), true)
    AND NOT coalesce(has_table_privilege(
      current_user,
      to_regclass('public.audit_events'),
      'DELETE'
    ), true)
    AND NOT coalesce(has_table_privilege(
      current_user,
      to_regclass('public.audit_events'),
      'TRUNCATE'
    ), true) AS audit_append_only
FROM resolved_table
LEFT JOIN pg_class ON pg_class.oid = resolved_table.oid
CROSS JOIN runtime_role
CROSS JOIN schema_contract
GROUP BY schema_contract.ready
`.trim();

export function isPlatformReady(row: PlatformReadinessRow | undefined): boolean {
  return (
    row?.audit_append_only === true &&
    row.database_writable === true &&
    row.postgres_supported === true &&
    row.restricted_runtime_role === true &&
    row.rls_forced === true &&
    row.runtime_authority_ready === true &&
    row.schema_contract_ready === true &&
    row.schema_ready === true
  );
}
