import { describe, expect, it } from "vitest";

import {
  isPlatformReady,
  PLATFORM_READINESS_SQL,
  type PlatformReadinessRow,
} from "../src/server/readiness.js";

const readyRow: PlatformReadinessRow = {
  audit_append_only: true,
  postgres_supported: true,
  restricted_runtime_role: true,
  rls_forced: true,
  schema_ready: true,
};

describe("platform readiness", () => {
  it("requires the schema, forced RLS, append-only audit, PostgreSQL 18, and a restricted role", () => {
    expect(isPlatformReady(readyRow)).toBe(true);
    for (const key of Object.keys(readyRow) as (keyof PlatformReadinessRow)[]) {
      expect(isPlatformReady({ ...readyRow, [key]: false })).toBe(false);
    }
  });

  it("checks every tenant table without querying tenant data", () => {
    expect(PLATFORM_READINESS_SQL).toContain("refund_correlation_candidates");
    expect(PLATFORM_READINESS_SQL).toContain("relforcerowsecurity");
    expect(PLATFORM_READINESS_SQL).toContain("rolbypassrls");
    expect(PLATFORM_READINESS_SQL).not.toMatch(/\bFROM\s+refund_requests\b/u);
  });
});
