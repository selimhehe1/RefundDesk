export interface PlatformReadinessRow {
  readonly audit_append_only: boolean;
  readonly postgres_supported: boolean;
  readonly restricted_runtime_role: boolean;
  readonly rls_forced: boolean;
  readonly schema_ready: boolean;
}

const TENANT_TABLES = [
  "tenants",
  "stripe_installations",
  "tenant_users",
  "approval_policies",
  "refund_requests",
  "approval_decisions",
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
  SELECT rolsuper, rolbypassrls
  FROM pg_roles
  WHERE rolname = current_user
)
SELECT
  current_setting('server_version_num')::integer >= 180000 AS postgres_supported,
  count(resolved_table.oid) = ${TENANT_TABLES.length} AS schema_ready,
  count(resolved_table.oid) = ${TENANT_TABLES.length}
    AND coalesce(bool_and(pg_class.relrowsecurity AND pg_class.relforcerowsecurity), false)
    AS rls_forced,
  coalesce(bool_and(NOT runtime_role.rolsuper AND NOT runtime_role.rolbypassrls), false)
    AS restricted_runtime_role,
  NOT coalesce(has_table_privilege(
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
`.trim();

export function isPlatformReady(row: PlatformReadinessRow | undefined): boolean {
  return (
    row?.audit_append_only === true &&
    row.postgres_supported === true &&
    row.restricted_runtime_role === true &&
    row.rls_forced === true &&
    row.schema_ready === true
  );
}
