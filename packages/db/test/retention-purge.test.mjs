import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  assertMaintenanceCapabilities,
  assertMaintenanceIdentity,
  loadRetentionPurgeConfig,
  runRetentionPurge,
  safeRetentionErrorCode,
  tenantPurgePseudonym,
} from "../scripts/retention-purge.mjs";

const maintenancePrincipal = "refunddesk_maintenance_login";
const validKey = Buffer.alloc(32, 19).toString("base64");
const tenantA = "3b7cdca2-f697-4ec2-bb73-3dc16eb78925";
const tenantB = "6bfbb2d9-7d95-4374-ad7f-ac96b24a2970";
const tenantC = "817e7b0c-cf20-48df-9eed-0c9851cc32f1";
const tenantD = "b502cd58-812d-43e8-a3ac-21fc07edeeac";

function productionEnvironment(overrides = {}) {
  return {
    NODE_ENV: "production",
    REFUNDDESK_MAINTENANCE_DATABASE_URL:
      "postgresql://refunddesk_maintenance_login:synthetic_maintenance_password_32@postgres.refunddesk.internal:5432/refunddesk?sslmode=verify-full",
    REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1: validKey,
    REFUNDDESK_RETENTION_SCOPE: "test_sandbox",
    ...overrides,
  };
}

function validIdentity(overrides = {}) {
  return {
    current_user: maintenancePrincipal,
    session_user: maintenancePrincipal,
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: true,
    rolreplication: false,
    rolbypassrls: false,
    replication_role_is_origin: true,
    can_set_replication_role: false,
    can_alter_system_replication_role: false,
    admin_option_absent: true,
    parent_roles: ["refunddesk_maintenance"],
    ...overrides,
  };
}

function validCapabilities(overrides = {}) {
  return {
    has_schema_usage: true,
    has_schema_create: false,
    has_pgboss_schema_usage: false,
    has_pgboss_schema_create: false,
    has_direct_table_access: false,
    has_relation_maintain: false,
    has_sequence_access: false,
    has_other_function_execute: false,
    has_procedure_execute: false,
    can_list_due_purges: true,
    can_guarded_purge: true,
    can_raw_purge: false,
    ...overrides,
  };
}

class RetentionClientFixture {
  constructor({
    candidates = [{ tenant_id: tenantA, blocker_reason: null, overdue_seconds: "60" }],
    candidateBatches,
    lockAcquired = true,
  } = {}) {
    this.candidates = candidates;
    this.candidateBatches = candidateBatches;
    this.candidateBatchIndex = 0;
    this.lockAcquired = lockAcquired;
    this.queries = [];
  }

  async query(sql, parameters = []) {
    this.queries.push({ sql, parameters });
    if (sql.includes("WITH RECURSIVE parent_membership")) {
      return { rows: [validIdentity()] };
    }
    if (sql.includes("AS has_schema_usage")) {
      return { rows: [validCapabilities()] };
    }
    if (sql.includes("pg_try_advisory_lock")) {
      return { rows: [{ acquired: this.lockAcquired }] };
    }
    if (sql.includes("refunddesk_list_due_tenant_purges")) {
      if (this.candidateBatches !== undefined) {
        const rows = this.candidateBatches[this.candidateBatchIndex] ?? [];
        this.candidateBatchIndex += 1;
        return { rows };
      }
      return { rows: this.candidates };
    }
    if (sql.includes("refunddesk_purge_test_sandbox_tenant")) {
      if (parameters[0] === tenantB) {
        throw Object.assign(new Error("sensitive database detail"), { code: "55000" });
      }
      return { rows: [{ result: "completed" }] };
    }
    if (sql.includes("pg_advisory_unlock")) {
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    throw new Error("UNEXPECTED_FIXTURE_QUERY");
  }
}

describe("isolated retention purge configuration", () => {
  it("accepts only an explicit test/sandbox scope and canonical dedicated inputs", () => {
    const config = loadRetentionPurgeConfig(productionEnvironment());

    expect(config).toMatchObject({
      batchSize: 25,
      databasePrincipal: maintenancePrincipal,
    });
    expect(config.pseudonymKey).toEqual(Buffer.alloc(32, 19));
    config.pseudonymKey.fill(0);
  });

  it("requires both the separate maintenance credential and purge-only HMAC key", () => {
    const withoutDatabase = productionEnvironment();
    delete withoutDatabase.REFUNDDESK_MAINTENANCE_DATABASE_URL;
    expect(() => loadRetentionPurgeConfig(withoutDatabase)).toThrow(
      "REFUNDDESK_MAINTENANCE_DATABASE_URL_REQUIRED",
    );

    const withoutKey = productionEnvironment();
    delete withoutKey.REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1;
    expect(() => loadRetentionPurgeConfig(withoutKey)).toThrow(
      "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1_REQUIRED",
    );
  });

  it.each([
    ["DATABASE_URL", "postgresql://web:synthetic@localhost/refunddesk"],
    ["DATABASE_MIGRATION_URL", "postgresql://owner:synthetic@localhost/refunddesk"],
    ["PGBOSS_DATABASE_URL", "postgresql://queue:synthetic@localhost/refunddesk"],
    ["WORKER_DATABASE_URL", "postgresql://worker:synthetic@localhost/refunddesk"],
    ["PGOPTIONS", "-c role=refunddesk_owner"],
    ["STRIPE_PLATFORM_TEST_EFFECT_KEY", "rk_test_foreign"],
    ["REFUNDDESK_GLOBAL_LIVE_ENABLED", "false"],
  ])("refuses foreign authority in %s", (name, value) => {
    expect(() =>
      loadRetentionPurgeConfig(
        productionEnvironment({
          [name]: value,
        }),
      ),
    ).toThrow("RETENTION_FOREIGN_AUTHORITY_FORBIDDEN");
  });

  it("rejects live-capable scope, unsafe TLS, authority overrides and malformed keys", () => {
    expect(() =>
      loadRetentionPurgeConfig(
        productionEnvironment({
          REFUNDDESK_RETENTION_SCOPE: "live",
        }),
      ),
    ).toThrow("REFUNDDESK_RETENTION_SCOPE_INVALID");
    expect(() =>
      loadRetentionPurgeConfig(
        productionEnvironment({
          REFUNDDESK_MAINTENANCE_DATABASE_URL:
            "postgresql://refunddesk_maintenance_login:synthetic_maintenance_password_32@postgres.refunddesk.internal:5432/refunddesk?sslmode=require",
        }),
      ),
    ).toThrow("REFUNDDESK_MAINTENANCE_DATABASE_TLS_INVALID");
    expect(() =>
      loadRetentionPurgeConfig(
        productionEnvironment({
          REFUNDDESK_MAINTENANCE_DATABASE_URL:
            "postgresql://refunddesk_maintenance_login:synthetic_maintenance_password_32@localhost:5432/refunddesk?options=-c%20role%3Drefunddesk_owner",
        }),
      ),
    ).toThrow("REFUNDDESK_MAINTENANCE_DATABASE_URL_INVALID");
    expect(() =>
      loadRetentionPurgeConfig(
        productionEnvironment({
          REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1: Buffer.alloc(31).toString("base64"),
        }),
      ),
    ).toThrow("REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1_INVALID");
    expect(() =>
      loadRetentionPurgeConfig(
        productionEnvironment({
          REFUNDDESK_MAINTENANCE_DATABASE_URL:
            "postgresql://another_maintenance_login:synthetic_maintenance_password_32@postgres.refunddesk.internal:5432/refunddesk?sslmode=verify-full",
        }),
      ),
    ).toThrow("REFUNDDESK_MAINTENANCE_DATABASE_URL_INVALID");
  });

  it("bounds every automatic batch", () => {
    expect(
      loadRetentionPurgeConfig(
        productionEnvironment({
          REFUNDDESK_RETENTION_BATCH_SIZE: "100",
        }),
      ).batchSize,
    ).toBe(100);
    for (const batchSize of ["0", "101", "1e2", " 25"]) {
      expect(() =>
        loadRetentionPurgeConfig(
          productionEnvironment({
            REFUNDDESK_RETENTION_BATCH_SIZE: batchSize,
          }),
        ),
      ).toThrow("REFUNDDESK_RETENTION_BATCH_SIZE_INVALID");
    }
  });
});

describe("retention purge authority and execution", () => {
  it("creates stable, domain-separated, non-identifying pseudonyms", () => {
    const key = Buffer.from(validKey, "base64");
    const first = tenantPurgePseudonym(tenantA, key);

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(tenantPurgePseudonym(tenantA, key)).toBe(first);
    expect(tenantPurgePseudonym(tenantB, key)).not.toBe(first);
    expect(first).not.toContain(tenantA);
    expect(() => tenantPurgePseudonym(tenantA, Buffer.alloc(31))).toThrow(
      "RETENTION_PURGE_CANDIDATE_INVALID",
    );
    key.fill(0);
  });

  it("requires one non-privileged login with only the maintenance membership", () => {
    expect(() => assertMaintenanceIdentity(validIdentity(), maintenancePrincipal)).not.toThrow();
    expect(() =>
      assertMaintenanceIdentity(
        validIdentity({ parent_roles: ["refunddesk_maintenance", "refunddesk_worker"] }),
        maintenancePrincipal,
      ),
    ).toThrow("RETENTION_DATABASE_IDENTITY_INVALID");
    expect(() =>
      assertMaintenanceIdentity(validIdentity({ rolsuper: true }), maintenancePrincipal),
    ).toThrow("RETENTION_DATABASE_IDENTITY_INVALID");
    expect(() => assertMaintenanceIdentity(validIdentity(), "refunddesk_owner")).toThrow(
      "RETENTION_DATABASE_IDENTITY_INVALID",
    );
  });

  it("requires exactly the two maintenance functions and no direct data access", () => {
    expect(() => assertMaintenanceCapabilities(validCapabilities())).not.toThrow();
    expect(() =>
      assertMaintenanceCapabilities(validCapabilities({ has_direct_table_access: true })),
    ).toThrow("RETENTION_DATABASE_CAPABILITY_INVALID");
    expect(() =>
      assertMaintenanceCapabilities(validCapabilities({ has_other_function_execute: true })),
    ).toThrow("RETENTION_DATABASE_CAPABILITY_INVALID");
    expect(() =>
      assertMaintenanceCapabilities(validCapabilities({ has_pgboss_schema_usage: true })),
    ).toThrow("RETENTION_DATABASE_CAPABILITY_INVALID");
    expect(() =>
      assertMaintenanceCapabilities(validCapabilities({ can_guarded_purge: false })),
    ).toThrow("RETENTION_DATABASE_CAPABILITY_INVALID");
    expect(() => assertMaintenanceCapabilities(validCapabilities({ can_raw_purge: true }))).toThrow(
      "RETENTION_DATABASE_CAPABILITY_INVALID",
    );
  });

  it("serializes a batch, revalidates every candidate and reports only counts", async () => {
    const client = new RetentionClientFixture({
      candidates: [
        { tenant_id: tenantA, blocker_reason: null, overdue_seconds: "120" },
        { tenant_id: tenantB, blocker_reason: null, overdue_seconds: "60" },
      ],
    });
    const key = Buffer.from(validKey, "base64");

    await expect(
      runRetentionPurge(client, {
        batchSize: 10,
        databasePrincipal: maintenancePrincipal,
        pseudonymKey: key,
      }),
    ).resolves.toEqual({
      batches: 1,
      blockedByReason: { revalidation: 1 },
      blockedAfterSelection: 1,
      oldestOverdueSeconds: 120,
      purged: 1,
      selected: 2,
    });
    const purgeQueries = client.queries.filter(({ sql }) =>
      sql.includes("FROM public.refunddesk_purge_test_sandbox_tenant"),
    );
    expect(purgeQueries).toHaveLength(2);
    expect(purgeQueries[0]?.parameters[1]).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(client.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
    key.fill(0);
  });

  it("fails closed on concurrent runs and malformed or duplicate candidates", async () => {
    const key = Buffer.from(validKey, "base64");
    await expect(
      runRetentionPurge(new RetentionClientFixture({ lockAcquired: false }), {
        batchSize: 10,
        databasePrincipal: maintenancePrincipal,
        pseudonymKey: key,
      }),
    ).rejects.toThrow("RETENTION_PURGE_ALREADY_RUNNING");

    const duplicateClient = new RetentionClientFixture({
      candidates: [
        { tenant_id: tenantA, blocker_reason: null, overdue_seconds: "60" },
        { tenant_id: tenantA, blocker_reason: null, overdue_seconds: "60" },
      ],
    });
    await expect(
      runRetentionPurge(duplicateClient, {
        batchSize: 10,
        databasePrincipal: maintenancePrincipal,
        pseudonymKey: key,
      }),
    ).rejects.toThrow("RETENTION_PURGE_CANDIDATE_INVALID");
    expect(duplicateClient.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
    key.fill(0);
  });

  it("drains multiple eligible batches and exposes blocked age without identifiers", async () => {
    const key = Buffer.from(validKey, "base64");
    const drainingClient = new RetentionClientFixture({
      candidateBatches: [
        [
          { tenant_id: tenantA, blocker_reason: null, overdue_seconds: "300" },
          { tenant_id: tenantC, blocker_reason: null, overdue_seconds: "200" },
        ],
        [{ tenant_id: tenantD, blocker_reason: null, overdue_seconds: "100" }],
      ],
    });
    await expect(
      runRetentionPurge(drainingClient, {
        batchSize: 2,
        databasePrincipal: maintenancePrincipal,
        pseudonymKey: key,
      }),
    ).resolves.toMatchObject({
      batches: 2,
      blockedAfterSelection: 0,
      oldestOverdueSeconds: 300,
      purged: 3,
      selected: 3,
    });

    const blockedClient = new RetentionClientFixture({
      candidates: [{ tenant_id: tenantA, blocker_reason: "legal_hold", overdue_seconds: "900" }],
    });
    await expect(
      runRetentionPurge(blockedClient, {
        batchSize: 25,
        databasePrincipal: maintenancePrincipal,
        pseudonymKey: key,
      }),
    ).resolves.toEqual({
      batches: 1,
      blockedByReason: { legal_hold: 1 },
      blockedAfterSelection: 1,
      oldestOverdueSeconds: 900,
      purged: 0,
      selected: 1,
    });
    expect(
      blockedClient.queries.some(({ sql }) =>
        sql.includes("FROM public.refunddesk_purge_test_sandbox_tenant"),
      ),
    ).toBe(false);
    key.fill(0);
  });

  it("never emits arbitrary database messages as an error code", () => {
    expect(
      safeRetentionErrorCode(Object.assign(new Error("tenant acct_secret"), { code: "55000" })),
    ).toBe("55000");
    expect(
      safeRetentionErrorCode(Object.assign(new Error("schema detail"), { code: "RDQ01" })),
    ).toBe("RDQ01");
    expect(safeRetentionErrorCode(new Error("tenant acct_secret"))).toBe("RETENTION_PURGE_FAILED");
  });
});
