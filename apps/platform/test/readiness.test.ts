import { describe, expect, it } from "vitest";

import {
  isPlatformReady,
  PLATFORM_READINESS_SQL,
  type PlatformReadinessRow,
} from "../src/server/readiness.js";

const readyRow: PlatformReadinessRow = {
  audit_append_only: true,
  database_writable: true,
  postgres_supported: true,
  restricted_runtime_role: true,
  rls_forced: true,
  runtime_authority_ready: true,
  schema_contract_ready: true,
  schema_ready: true,
};

describe("platform readiness", () => {
  it("requires a writable current schema, forced RLS, append-only audit, PostgreSQL 18, and a restricted role", () => {
    expect(isPlatformReady(readyRow)).toBe(true);
    for (const key of Object.keys(readyRow) as (keyof PlatformReadinessRow)[]) {
      expect(isPlatformReady({ ...readyRow, [key]: false })).toBe(false);
    }
  });

  it("checks every tenant table without querying tenant data", () => {
    expect(PLATFORM_READINESS_SQL).toContain("refund_correlation_candidates");
    expect(PLATFORM_READINESS_SQL).toContain("relforcerowsecurity");
    expect(PLATFORM_READINESS_SQL).toContain("rolbypassrls");
    expect(PLATFORM_READINESS_SQL).toContain("rolcreatedb");
    expect(PLATFORM_READINESS_SQL).toContain("rolcreaterole");
    expect(PLATFORM_READINESS_SQL).toContain("rolreplication");
    expect(PLATFORM_READINESS_SQL).toContain("transaction_read_only");
    expect(PLATFORM_READINESS_SQL).toContain("< 190000");
    expect(PLATFORM_READINESS_SQL).toContain("refunddesk_database_identity");
    expect(PLATFORM_READINESS_SQL).toContain("schema_contract_version = 1");
    expect(PLATFORM_READINESS_SQL).toContain("pg_has_role(current_user, 'refunddesk_runtime'");
    expect(PLATFORM_READINESS_SQL).toContain("pg_has_role(current_user, 'refunddesk_worker'");
    expect(PLATFORM_READINESS_SQL).toContain("current_setting('session_replication_role')");
    expect(PLATFORM_READINESS_SQL).toContain("has_parameter_privilege(");
    expect(PLATFORM_READINESS_SQL).toContain("'ALTER SYSTEM'");
    expect(PLATFORM_READINESS_SQL).toContain("has_any_column_privilege(");
    expect(PLATFORM_READINESS_SQL).toContain("'TRUNCATE'");
    expect(PLATFORM_READINESS_SQL).toContain("api_mutation_receipts");
    expect(PLATFORM_READINESS_SQL).toContain("approval_attestations");
    expect(PLATFORM_READINESS_SQL).toContain(
      "has_any_column_privilege(current_user, 'approval_attestations', 'SELECT')",
    );
    expect(PLATFORM_READINESS_SQL).toContain("refunddesk_list_scannable_installations");
    expect(PLATFORM_READINESS_SQL).toContain("stripe_refund_status");
    expect(PLATFORM_READINESS_SQL).not.toMatch(/\bFROM\s+refund_requests\b/u);
  });
});
