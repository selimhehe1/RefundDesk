import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  TenantRepositories,
  accountWebhookEndpointSchema,
  assertNormalizedAccountWebhookRowConsistency,
  assertTenantId,
  isRetryableTransactionError,
  normalizedAccountWebhookPayloadSchema,
  type Prisma,
} from "../src/index.js";

const tenantId = "5c66ba36-d4c2-444e-9186-582c8e6b0671";

describe("tenant repositories", () => {
  it("always adds the bound tenant to request lookups", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const tx = {
      refundRequest: { findFirst },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await repositories.getRefundRequest("ca3872bc-01b8-4df3-b649-e81a22c31c5e");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
        tenantId,
      },
    });
  });

  it("settles certified pre-effect work and preserves ambiguous guards on deauthorization", async () => {
    const eventAt = new Date("2030-01-01T12:00:00.000Z");
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: "installation-lock" }])
      .mockResolvedValueOnce([{ id: tenantId }])
      .mockResolvedValueOnce([
        {
          id: "pending",
          workflow_status: "pending_approval",
          effect_state: "not_started",
          payment_guard_released_at: null,
        },
        {
          id: "approved",
          workflow_status: "approved",
          effect_state: "not_started",
          payment_guard_released_at: null,
        },
        {
          id: "executing-before-boundary",
          workflow_status: "executing",
          effect_state: "not_started",
          payment_guard_released_at: null,
        },
        {
          id: "executing-certain-absence",
          workflow_status: "executing",
          effect_state: "absence_proven",
          payment_guard_released_at: null,
        },
        {
          id: "executing-possible",
          workflow_status: "executing",
          effect_state: "possible",
          payment_guard_released_at: null,
        },
        {
          id: "executing-identified",
          workflow_status: "executing",
          effect_state: "identified",
          payment_guard_released_at: null,
        },
        {
          id: "already-reconciling",
          workflow_status: "reconciliation_required",
          effect_state: "identified",
          payment_guard_released_at: null,
        },
      ]);
    const requestUpdate = vi
      .fn()
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 2 });
    const installationUpdate = vi.fn().mockResolvedValue({ id: "installation-lock" });
    const tenantUpdate = vi.fn().mockResolvedValue({ id: tenantId });
    const tx = {
      $queryRaw: queryRaw,
      stripeInstallation: {
        findFirst: vi.fn().mockResolvedValue({
          id: "installation-lock",
          environment: "test",
          lastLifecycleEventCreatedAt: null,
          lastLifecycleEventId: null,
          lastLifecycleEventType: null,
        }),
        update: installationUpdate,
      },
      tenant: { update: tenantUpdate },
      refundRequest: { updateMany: requestUpdate },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(
      repositories.applyWebhookDeauthorization({
        installationId: "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
        stripeEventId: "evt_DeauthorizationBoundary",
        stripeEventCreatedAt: eventAt,
        purgeAt: new Date("2030-01-31T12:00:00.000Z"),
      }),
    ).resolves.toBe(true);

    expect(requestUpdate).toHaveBeenNthCalledWith(1, {
      where: {
        tenantId,
        workflowStatus: { in: ["pending_approval", "approved"] },
        effectState: "not_started",
        paymentGuardReleasedAt: null,
      },
      data: {
        workflowStatus: "stale",
        effectState: "absence_proven",
        terminalAt: eventAt,
        paymentGuardReleasedAt: eventAt,
        version: { increment: 1 },
      },
    });
    expect(requestUpdate).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId,
        workflowStatus: "executing",
        effectState: { in: ["not_started", "absence_proven"] },
        paymentGuardReleasedAt: null,
      },
      data: {
        workflowStatus: "failed_terminal",
        effectState: "absence_proven",
        terminalAt: eventAt,
        paymentGuardReleasedAt: eventAt,
        version: { increment: 1 },
      },
    });
    expect(requestUpdate).toHaveBeenNthCalledWith(3, {
      where: {
        tenantId,
        workflowStatus: "executing",
        effectState: { in: ["possible", "identified"] },
        paymentGuardReleasedAt: null,
      },
      data: {
        workflowStatus: "reconciliation_required",
        version: { increment: 1 },
      },
    });
    expect(queryRaw.mock.invocationCallOrder[2]).toBeLessThan(
      requestUpdate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(installationUpdate).toHaveBeenCalledOnce();
    expect(tenantUpdate).toHaveBeenCalledOnce();
  });

  it("marks a direct deauthorization before applying protective request transitions", async () => {
    const deauthorizedAt = new Date("2030-01-01T12:00:00.000Z");
    const installationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const requestUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const tenantUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: "installation-lock" }])
        .mockResolvedValueOnce([{ id: tenantId }])
        .mockResolvedValueOnce([]),
      stripeInstallation: { updateMany: installationUpdate },
      refundRequest: { updateMany: requestUpdate },
      tenant: { updateMany: tenantUpdate },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(
      repositories.deauthorizeInstallation(
        "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
        deauthorizedAt,
        new Date("2030-01-31T12:00:00.000Z"),
      ),
    ).resolves.toBe(true);

    expect(installationUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      requestUpdate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(requestUpdate).toHaveBeenCalledTimes(3);
    expect(tenantUpdate).toHaveBeenCalledOnce();
  });

  it("aborts deauthorization when the locked request compare-and-set boundary drifts", async () => {
    const eventAt = new Date("2030-01-01T12:00:00.000Z");
    const installationUpdate = vi.fn();
    const tenantUpdate = vi.fn();
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: "installation-lock" }])
        .mockResolvedValueOnce([{ id: tenantId }])
        .mockResolvedValueOnce([
          {
            id: "executing-before-boundary",
            workflow_status: "executing",
            effect_state: "not_started",
            payment_guard_released_at: null,
          },
        ]),
      stripeInstallation: {
        findFirst: vi.fn().mockResolvedValue({
          id: "installation-lock",
          environment: "test",
          lastLifecycleEventCreatedAt: null,
          lastLifecycleEventId: null,
          lastLifecycleEventType: null,
        }),
        update: installationUpdate,
      },
      tenant: { update: tenantUpdate },
      refundRequest: {
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(
      repositories.applyWebhookDeauthorization({
        installationId: "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
        stripeEventId: "evt_DeauthorizationCasFailure",
        stripeEventCreatedAt: eventAt,
        purgeAt: new Date("2030-01-31T12:00:00.000Z"),
      }),
    ).rejects.toThrow("DEAUTHORIZATION_REQUEST_COMPARE_AND_SET_FAILED");
    expect(installationUpdate).toHaveBeenCalledWith({
      where: { id: "installation-lock" },
      data: {
        status: "deauthorized",
        deauthorizedAt: eventAt,
        lastLifecycleEventId: "evt_DeauthorizationCasFailure",
        lastLifecycleEventType: "account.application.deauthorized",
        lastLifecycleEventCreatedAt: eventAt,
      },
    });
    // A real transaction rolls this earlier installation write back when the
    // request compare-and-set below fails.
    expect(tenantUpdate).not.toHaveBeenCalled();
  });
});

describe("tenant transaction safety", () => {
  it("accepts only UUID tenant contexts and identifies PostgreSQL retry codes", () => {
    expect(() => assertTenantId(tenantId)).not.toThrow();
    expect(() => assertTenantId("tenant-a")).toThrow(TypeError);
    expect(isRetryableTransactionError({ code: "40001" })).toBe(true);
    expect(isRetryableTransactionError({ cause: { code: "40P01" } })).toBe(true);
    expect(isRetryableTransactionError({ code: "23505" })).toBe(false);
  });
});

describe("migration hardening", () => {
  it("requires independently persisted approval evidence at the database boundary", async () => {
    const [sql, runtimeRoles] = await Promise.all([
      readFile(
        new URL(
          "../prisma/migrations/20260727230000_approval_attestation_boundary/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(new URL("../prisma/runtime-roles.sql", import.meta.url), "utf8"),
    ]);

    expect(sql).toContain('CREATE TABLE "approval_attestations"');
    expect(sql).toContain('ALTER TABLE "approval_attestations" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('"approval_attestations_append_only"');
    expect(sql).toContain('"approval_decisions_attestation_binding_fkey"');
    expect(sql).toContain('NEW."decided_at" >= attestation."consume_before"');
    expect(sql).toContain('attestation."request_version" <> current_request_version');
    expect(sql).toContain('"refunddesk_enforce_tenant_user_identity_immutable"');
    expect(sql).toContain('"refunddesk_count_purged_approval_attestation"');
    expect(sql).toContain("'approval_attestations'");
    expect(sql).toContain("NEW.\"process_version\" := 'db-purge-v2'");
    expect(runtimeRoles).toContain(
      "GRANT SELECT, INSERT ON approval_attestations\n  TO refunddesk_attestation_writer",
    );
    expect(runtimeRoles).not.toMatch(
      /GRANT [^;]+ ON approval_attestations\s+TO refunddesk_runtime/u,
    );
  });

  it("separates web decisions from worker-owned execution state", async () => {
    const [sql, runtimeRoles] = await Promise.all([
      readFile(
        new URL(
          "../prisma/migrations/20260725201500_runtime_role_separation/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(new URL("../prisma/runtime-roles.sql", import.meta.url), "utf8"),
    ]);

    expect(sql).toContain('"refunddesk_enforce_request_role_boundary"');
    expect(sql).toContain('"refunddesk_validate_durable_decision_transition"');
    expect(sql).toContain('"refunddesk_enforce_worker_owned_relation"');
    expect(sql).toContain('session_role."oid" = relation."relowner"');
    expect(sql).toContain("FOR SHARE");
    expect(sql).toContain('NEW."decided_at" > clock_timestamp()');
    expect(runtimeRoles).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public");
    expect(runtimeRoles).toContain("GRANT SELECT ON refund_executions, refund_execution_attempts");
    expect(runtimeRoles).not.toMatch(/GRANT [^;]+ TO refunddesk_queue;/u);
    const webBroadGrant = /GRANT SELECT, INSERT, UPDATE ON([\s\S]*?)TO refunddesk_runtime;/u.exec(
      runtimeRoles,
    )?.[1];
    expect(webBroadGrant).toBeDefined();
    expect(webBroadGrant).not.toContain("refund_executions");
  });

  it("contains financial guards, durable webhook recovery, and candidate protections", async () => {
    const [sql, runtimeRoles] = await Promise.all([
      readFile(
        new URL("../prisma/migrations/20260725154000_initial_pilot/migration.sql", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../prisma/runtime-roles.sql", import.meta.url), "utf8"),
    ]);
    expect(sql).toContain('"refund_requests_active_payment_guard_key"');
    expect(sql).toContain('ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('"audit_events_append_only"');
    expect(sql).toContain('"refunddesk_provision_installation"');
    expect(sql).toContain('"refunddesk_provision_webhook_installation"');
    expect(sql.match(/INSERT INTO public\."stripe_installations" AS inserted/gu)).toHaveLength(2);
    expect(
      sql.match(/RETURNING inserted\."tenant_id", inserted\."id", inserted\."status"/gu),
    ).toHaveLength(2);
    expect(sql).toContain('"refunddesk_list_recoverable_webhook_receipts"');
    expect(sql).toContain('"webhook_receipts_payload_shape_check"');
    expect(sql).toContain('"refund_correlation_candidates"');
    expect(sql).toContain('"refund_candidates_request_refund_key"');
    expect(sql).toContain('ALTER TABLE "refund_correlation_candidates" FORCE ROW LEVEL SECURITY');
    expect(sql).not.toContain('"raw_body"');
    expect(sql).toContain(
      "WHEN 'reconciliation_required' THEN NEW.\"workflow_status\" IN ('succeeded', 'failed_terminal', 'executing')",
    );
    expect(sql).toContain('"refunddesk_lock_payment_scope"');
    expect(sql).toContain('"refund_requests_external_payment_protection"');
    expect(sql).toContain('"external_refund_alerts_pilot_reconciliation_check"');
    expect(sql).toContain("current_refund_status IS DISTINCT FROM 'failed'");
    expect(sql).toContain("NEW.\"stripe_refund_status\" = 'failed'");
    expect(sql).not.toContain("NEW.\"stripe_refund_status\" IN ('failed', 'canceled')");
    expect(runtimeRoles).toMatch(
      /GRANT UPDATE \([^;]*"last_lifecycle_event_id"[^;]*\) ON stripe_installations TO refunddesk_runtime;/u,
    );
    expect(runtimeRoles).toContain(
      "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON external_refund_alerts",
    );
    expect(runtimeRoles).not.toMatch(
      /GRANT (?:INSERT|UPDATE) \([^;]*"reconciled_at"[^;]*\) ON external_refund_alerts/u,
    );
  });

  it("adds account-scoped webhook endpoints with account-global Event deduplication", async () => {
    const [enumSql, sql] = await Promise.all([
      readFile(
        new URL(
          "../prisma/migrations/20260728145900_account_scoped_webhook_endpoint_enum/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../prisma/migrations/20260728150000_account_scoped_webhook_endpoints/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

    expect(enumSql).toContain("ADD VALUE IF NOT EXISTS 'account_test'");
    expect(enumSql).toContain("ADD VALUE IF NOT EXISTS 'account_sandbox'");
    expect(enumSql).toMatch(/^--[\s\S]+BEGIN;[\s\S]+COMMIT;\s*$/u);
    expect(sql).not.toContain("ADD VALUE");
    expect(sql).toMatch(/^BEGIN;[\s\S]+COMMIT;\s*$/u);
    expect(sql).toContain('"webhook_receipts_account_event_key"');
    expect(sql).toContain('("stripe_account_id", "stripe_event_id")');
    expect(sql).toContain('DROP INDEX "webhook_receipts_endpoint_event_key"');
    expect(sql).toContain("receipt.\"endpoint\" IN ('connected_test', 'account_test')");
    expect(sql).toContain("receipt.\"endpoint\" IN ('connected_sandbox', 'account_sandbox')");
    expect(sql).toContain('"refunddesk_find_webhook_receipt_v2"');
    expect(sql).toContain('"refunddesk_list_recoverable_webhook_receipts_v2"');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION "refunddesk_find_webhook_receipt"');
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION "refunddesk_list_recoverable_webhook_receipts"',
    );
    expect(sql).toContain(
      '"stripe_event_id" = requested_event_id\n    AND receipt."stripe_account_id" = requested_account_id',
    );
  });

  it("converges a succeeded linked Refund when Stripe later cancels it", async () => {
    const sql = await readFile(
      new URL(
        "../prisma/migrations/20260726190000_canceled_refund_terminal_convergence/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain("current_refund_status NOT IN ('failed', 'canceled')");
    expect(sql).toContain("NEW.\"stripe_refund_status\" IN ('failed', 'canceled')");
    expect(sql).toContain(
      "OLD.\"stripe_refund_status\" = 'canceled'\n         AND NEW.\"stripe_refund_status\" = 'failed'",
    );
    expect(sql).not.toContain('NEW."terminal_at"');
    expect(sql).not.toContain('NEW."payment_guard_released_at"');
  });

  it("exposes only a guarded tenant-purge capability to maintenance", async () => {
    const [sql, runtimeRoles] = await Promise.all([
      readFile(
        new URL("../prisma/migrations/20260725154000_initial_pilot/migration.sql", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../prisma/runtime-roles.sql", import.meta.url), "utf8"),
    ]);
    const certificateTable = /CREATE TABLE "purge_certificates" \(([\s\S]*?)\);/u.exec(sql)?.[1];

    expect(sql).toContain('"legal_hold_at" TIMESTAMPTZ(6)');
    expect(sql).toContain('CREATE FUNCTION "refunddesk_purge_tenant"');
    expect(sql).toMatch(
      /CREATE FUNCTION "refunddesk_purge_tenant"\([\s\S]*?SECURITY DEFINER\s+SET search_path = pg_catalog/u,
    );
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("selected_pending_delete_at > completed_at");
    expect(sql).toContain("tenant purge requires complete deauthorization");
    expect(sql).toContain("tenant purge is blocked by legal hold");
    expect(sql).toContain("tenant purge is blocked by unresolved financial state");
    expect(sql).toContain('request."payment_guard_released_at" IS NULL');
    expect(sql).toContain("attempt.\"state\" = 'started'");
    expect(sql).toContain("candidate.\"state\" IN ('pending', 'conflict')");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION "refunddesk_purge_tenant"(UUID, VARCHAR) FROM PUBLIC',
    );
    expect(sql).not.toContain("current_user = 'refunddesk_maintenance'");
    expect(certificateTable).toBeDefined();
    expect(certificateTable).not.toContain("tenant_id");
    expect(certificateTable).not.toContain("stripe_");
    expect(runtimeRoles).toMatch(
      /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public\s+FROM PUBLIC,[^;]*refunddesk_maintenance/u,
    );
    expect(runtimeRoles).toContain(
      "GRANT EXECUTE ON FUNCTION refunddesk_purge_tenant(UUID, VARCHAR)",
    );
    expect(runtimeRoles).not.toContain("GRANT SELECT, DELETE ON");
  });
});

describe("normalized account webhook payloads", () => {
  const payload = {
    schema_version: 1,
    environment: "test",
    event_type: "refund.created",
    event_created: 1_893_499_200,
    event_idempotency_key: null,
    refund: {
      refund_id: "re_contract",
      payment_intent_id: "pi_contract",
      charge_id: "ch_contract",
      amount_minor: "500",
      currency: "eur",
      status: "succeeded",
      created: 1_893_499_200,
      metadata_request_id: "copied-not-a-uuid",
      metadata_proof: "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  } as const;

  it("allows only account-scoped labels for new webhook writes", () => {
    expect(accountWebhookEndpointSchema.parse("account_test")).toBe("account_test");
    expect(accountWebhookEndpointSchema.parse("account_sandbox")).toBe("account_sandbox");
    expect(() => accountWebhookEndpointSchema.parse("connected_test")).toThrow();
    expect(() => accountWebhookEndpointSchema.parse("connected_sandbox")).toThrow();
  });

  it("keeps tampered metadata classifiable while rejecting raw or unknown fields", () => {
    expect(normalizedAccountWebhookPayloadSchema.parse(payload)).toEqual(payload);
    expect(() =>
      normalizedAccountWebhookPayloadSchema.parse({
        ...payload,
        raw_body: '{"customer":"cus_forbidden"}',
      }),
    ).toThrow();
    expect(() =>
      normalizedAccountWebhookPayloadSchema.parse({
        ...payload,
        environment: "live",
      }),
    ).toThrow();
  });

  it("binds endpoint, type, object and creation time to the durable payload", () => {
    expect(
      assertNormalizedAccountWebhookRowConsistency({
        endpoint: "account_test",
        eventType: "refund.created",
        objectId: "re_contract",
        stripeCreatedAt: new Date(1_893_499_200_000),
        normalizedPayload: payload,
      }),
    ).toEqual(payload);
    expect(() =>
      assertNormalizedAccountWebhookRowConsistency({
        endpoint: "account_sandbox",
        eventType: "refund.created",
        objectId: "re_contract",
        stripeCreatedAt: new Date(1_893_499_200_000),
        normalizedPayload: payload,
      }),
    ).toThrow("endpoint");
    expect(
      assertNormalizedAccountWebhookRowConsistency({
        endpoint: "connected_test",
        eventType: "refund.created",
        objectId: "re_contract",
        stripeCreatedAt: new Date(1_893_499_200_000),
        normalizedPayload: payload,
      }),
    ).toEqual(payload);
  });
});
