import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("reconciliation safe-boundary migration", () => {
  it("database-stamps every reconciliation entry and prevents caller rewrites", async () => {
    const sql = await readFile(
      new URL(
        "../prisma/migrations/20260725193630_reconciliation_safe_boundary/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain('ADD COLUMN "reconciliation_safe_after_at" TIMESTAMPTZ(6)');
    expect(sql).toContain(
      'NEW."reconciliation_safe_after_at" := GREATEST(\n      clock_timestamp(),\n      NEW."execution_started_at"',
    );
    expect(sql).toContain(
      'SET "reconciliation_safe_after_at" = GREATEST(\n  clock_timestamp(),\n  "execution_started_at"',
    );
    expect(sql).toContain("reconciliation safe boundary is database-managed");
    expect(sql).toContain('"refund_requests_reconciliation_safe_boundary_check"');
    expect(sql).toContain('"reconciliation_safe_after_at" >= "execution_started_at"');
  });
});
