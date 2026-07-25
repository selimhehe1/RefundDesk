import { describe, expect, it, vi } from "vitest";

import { TenantRepositories, type Prisma } from "../src/index.js";

const tenantId = "5c66ba36-d4c2-444e-9186-582c8e6b0671";
const installationId = "0f12622c-eb99-49b5-9940-d194098446af";
const requestId = "ca3872bc-01b8-4df3-b649-e81a22c31c5e";
const stripeRefundCreatedAt = new Date("2030-01-01T12:00:05.000Z");
const observedAt = new Date("2030-01-01T12:01:00.000Z");

function externalAlert(overlappedRequestId: string | null, status = "open") {
  return {
    id: "1139f074-f713-4c3a-8741-18227abb2315",
    tenantId,
    installationId,
    environment: "test",
    stripeRefundId: "re_external",
    stripeRefundCreatedAt,
    paymentKey: "pi_external",
    amountMinor: 500n,
    currency: "eur",
    classification: "external",
    status,
    detectedAt: observedAt,
    acknowledgedAt: status === "acknowledged" ? observedAt : null,
    acknowledgedByUserId: status === "acknowledged" ? "8a10685c-662b-4323-8f71-5720f7972173" : null,
    overlappedRequestId,
    reconciledAt: null,
  };
}

function observationInput() {
  return {
    installationId,
    stripeRefundId: "re_external",
    stripeRefundCreatedAt,
    paymentKey: "pi_external",
    amountMinor: 500n,
    currency: "eur",
    classification: "external" as const,
    observedAt,
  };
}

function observationTransaction(
  lockedRequests: readonly Record<string, unknown>[],
  alert: ReturnType<typeof externalAlert>,
  updateCounts: readonly number[] = [0, 0, 0],
) {
  return {
    stripeInstallation: {
      findFirst: vi.fn().mockResolvedValue({ environment: "test" }),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ refunddesk_lock_payment_scope: null }])
      .mockResolvedValueOnce(lockedRequests)
      .mockResolvedValueOnce(
        alert.overlappedRequestId === null ? [] : [{ id: alert.overlappedRequestId }],
      ),
    $executeRaw: vi.fn().mockResolvedValue(1),
    externalRefundAlert: {
      findUnique: vi.fn().mockResolvedValue(alert),
    },
    refundRequest: {
      updateMany: vi
        .fn()
        .mockResolvedValueOnce({ count: updateCounts[0] ?? 0 })
        .mockResolvedValueOnce({ count: updateCounts[1] ?? 0 })
        .mockResolvedValueOnce({ count: updateCounts[2] ?? 0 }),
    },
  };
}

describe("external refund reconciliation", () => {
  it("records a reverse-order overlap without reopening the terminal request", async () => {
    const alert = externalAlert(requestId);
    const tx = observationTransaction(
      [
        {
          id: requestId,
          workflow_status: "succeeded",
          effect_state: "identified",
          payment_guard_released_at: new Date("2030-01-01T12:00:10.000Z"),
          execution_started_at: new Date("2030-01-01T12:00:00.000Z"),
          terminal_at: new Date("2030-01-01T12:00:10.000Z"),
        },
      ],
      alert,
    );
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(repositories.observeExternalRefund(observationInput())).resolves.toEqual({
      alert,
      requestTransition: "none",
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('INSERT INTO "external_refund_alerts"'),
        expect.stringContaining('ON CONFLICT ("installation_id", "stripe_refund_id") DO NOTHING'),
      ]),
    );
    expect(tx.$executeRaw.mock.calls[0]?.slice(1)).toEqual(
      expect.arrayContaining([
        tenantId,
        installationId,
        "test",
        "re_external",
        stripeRefundCreatedAt.toISOString(),
        "pi_external",
        500n,
        "eur",
        "external",
        observedAt.toISOString(),
        requestId,
      ]),
    );
    expect(tx.refundRequest.updateMany).toHaveBeenCalledTimes(3);
  });

  it("does not reclassify a terminal request when the external Refund was created later", async () => {
    const postTerminalCreatedAt = new Date("2030-01-01T12:00:11.000Z");
    const alert = {
      ...externalAlert(null),
      stripeRefundCreatedAt: postTerminalCreatedAt,
    };
    const tx = observationTransaction(
      [
        {
          id: requestId,
          workflow_status: "succeeded",
          effect_state: "identified",
          payment_guard_released_at: new Date("2030-01-01T12:00:10.000Z"),
          execution_started_at: new Date("2030-01-01T12:00:00.000Z"),
          terminal_at: new Date("2030-01-01T12:00:10.000Z"),
        },
      ],
      alert,
    );
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(
      repositories.observeExternalRefund({
        ...observationInput(),
        stripeRefundCreatedAt: postTerminalCreatedAt,
      }),
    ).resolves.toEqual({ alert, requestTransition: "none" });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0]?.slice(1)).toContain(null);
  });

  it("neutralizes pre-effect work and protects possible effects under one payment lock", async () => {
    const alert = externalAlert(null);
    const tx = observationTransaction(
      [
        {
          id: "pending",
          workflow_status: "pending_approval",
          effect_state: "not_started",
          payment_guard_released_at: null,
          execution_started_at: null,
          terminal_at: null,
        },
        {
          id: "executing-not-started",
          workflow_status: "executing",
          effect_state: "not_started",
          payment_guard_released_at: null,
          execution_started_at: new Date("2030-01-01T12:00:00.000Z"),
          terminal_at: null,
        },
        {
          id: "executing-possible",
          workflow_status: "executing",
          effect_state: "possible",
          payment_guard_released_at: null,
          execution_started_at: new Date("2030-01-01T12:00:00.000Z"),
          terminal_at: null,
        },
      ],
      alert,
      [1, 1, 1],
    );
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(repositories.observeExternalRefund(observationInput())).resolves.toEqual({
      alert,
      requestTransition: "reconciliation_required",
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.refundRequest.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        tenantId,
        installationId,
        environment: "test",
        paymentKey: "pi_external",
        workflowStatus: { in: ["pending_approval", "approved"] },
        effectState: "not_started",
        paymentGuardReleasedAt: null,
      },
      data: {
        effectState: "absence_proven",
        workflowStatus: "stale",
        terminalAt: observedAt,
        paymentGuardReleasedAt: observedAt,
        version: { increment: 1 },
      },
    });
    expect(tx.refundRequest.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId,
        installationId,
        environment: "test",
        paymentKey: "pi_external",
        workflowStatus: "executing",
        effectState: { in: ["not_started", "absence_proven"] },
        paymentGuardReleasedAt: null,
      },
      data: {
        effectState: "absence_proven",
        workflowStatus: "failed_terminal",
        terminalAt: observedAt,
        paymentGuardReleasedAt: observedAt,
        version: { increment: 1 },
      },
    });
    expect(tx.refundRequest.updateMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: {
          workflowStatus: "reconciliation_required",
          version: { increment: 1 },
        },
      }),
    );
  });

  it("treats acknowledgement as operational metadata, not reconciliation", async () => {
    const alert = externalAlert(null, "acknowledged");
    const tx = observationTransaction([], alert);
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(repositories.observeExternalRefund(observationInput())).resolves.toEqual({
      alert,
      requestTransition: "none",
    });
    expect(alert.reconciledAt).toBeNull();
  });

  it("keeps reconciliation and its guard when the linked Refund later succeeds", async () => {
    const requestUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: requestId,
          workflow_status: "reconciliation_required",
          effect_state: "identified",
          execution_id: "a5cc7f0b-e61d-4fd9-81a4-d14c469e46a3",
          stripe_refund_id: null,
          stripe_refund_status: null,
          last_stripe_event_created_at: null,
        },
      ]),
      refundExecution: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      refundRequest: { updateMany: requestUpdate },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(
      repositories.markRefundIdentified({
        requestId,
        stripeRefundId: "re_linked",
        stripeRefundStatus: "succeeded",
        reconciliationResolution: "preserve",
        observedAt,
      }),
    ).resolves.toBe(true);
    expect(requestUpdate).toHaveBeenCalledWith({
      where: {
        id: requestId,
        tenantId,
        workflowStatus: "reconciliation_required",
        effectState: { in: ["possible", "identified"] },
        paymentGuardReleasedAt: null,
      },
      data: {
        effectState: "identified",
        version: { increment: 1 },
      },
    });
  });

  it("does not let a unique scan resolve an acknowledged external conflict", async () => {
    const candidate = {
      stripeRefundId: "re_unique_but_conflicted",
      stripeRefundStatus: "succeeded",
      stripeEventId: null,
      stripeEventCreatedAt: null,
      stripeCreatedAt: new Date("2030-01-01T12:00:01.000Z"),
      eventIdempotencyCorrelation: "absent",
      lastSeenScanWindowEnd: new Date("2030-01-01T13:00:00.000Z"),
      state: "pending",
    };
    const alertFindFirst = vi.fn().mockResolvedValue({
      id: "alert-acknowledged-conflict",
      status: "acknowledged",
    });
    const tx = {
      refundCorrelationCandidate: {
        findMany: vi.fn().mockResolvedValueOnce([{ requestId }]).mockResolvedValueOnce([candidate]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      refundRequest: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({
          id: requestId,
          environment: "test",
          paymentKey: "pi_reconciling",
          executionStartedAt: new Date("2030-01-01T12:00:00.000Z"),
          reconciliationSafeAfterAt: new Date("2030-01-01T12:00:10.000Z"),
          execution: { stripeRefundId: null },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      externalRefundAlert: { findFirst: alertFindFirst },
      refundExecution: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: requestId,
          workflow_status: "reconciliation_required",
          effect_state: "possible",
          execution_id: "a5cc7f0b-e61d-4fd9-81a4-d14c469e46a3",
          stripe_refund_id: null,
          stripe_refund_status: null,
          last_stripe_event_created_at: null,
        },
      ]),
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(
      repositories.resolveUniqueRefundCandidates(
        installationId,
        new Date("2030-01-01T11:00:00.000Z"),
        new Date("2030-01-01T13:00:00.000Z"),
        observedAt,
      ),
    ).resolves.toEqual({ resolved: 0, conflicts: 1 });
    expect(alertFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId,
        installationId,
        environment: "test",
        paymentKey: "pi_reconciling",
        classification: { in: ["external", "tampered", "proof_replay"] },
        reconciledAt: null,
      },
      select: { id: true },
    });
  });

  it("proves absence and resumes with the same durable execution after a complete empty scan", async () => {
    const executionStartedAt = new Date("2030-01-01T12:00:00.000Z");
    const reconciliationSafeAfterAt = new Date("2030-01-01T12:00:10.000Z");
    const request = {
      id: requestId,
      environment: "test",
      paymentKey: "pi_empty_scan",
      executionStartedAt,
      reconciliationSafeAfterAt,
      workflowStatus: "reconciliation_required",
      effectState: "possible",
      execution: {
        stripeRefundId: null,
        idempotencyKey: "refunddesk_same_key",
      },
    };
    const requestUpdate = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const tx = {
      refundCorrelationCandidate: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      refundRequest: {
        findMany: vi.fn().mockResolvedValue([{ id: requestId }]),
        findFirst: vi.fn().mockResolvedValue(request),
        updateMany: requestUpdate,
      },
      externalRefundAlert: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: requestId }]),
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(
      repositories.resolveUniqueRefundCandidates(
        installationId,
        new Date("2030-01-01T11:00:00.000Z"),
        new Date("2030-01-01T13:00:00.000Z"),
        observedAt,
      ),
    ).resolves.toEqual({ resolved: 1, conflicts: 0 });
    expect(requestUpdate).toHaveBeenNthCalledWith(1, {
      where: {
        id: requestId,
        tenantId,
        workflowStatus: "reconciliation_required",
        effectState: "possible",
      },
      data: {
        effectState: "absence_proven",
        version: { increment: 1 },
      },
    });
    expect(requestUpdate).toHaveBeenNthCalledWith(2, {
      where: {
        id: requestId,
        tenantId,
        workflowStatus: "reconciliation_required",
        effectState: "absence_proven",
      },
      data: {
        workflowStatus: "executing",
        executionStartedAt: observedAt,
        version: { increment: 1 },
      },
    });
    expect(request.execution.idempotencyKey).toBe("refunddesk_same_key");
  });

  it("does not prove absence when the completed scan predates the durable reconciliation boundary", async () => {
    const executionStartedAt = new Date("2030-01-01T12:00:00.000Z");
    const reconciliationSafeAfterAt = new Date("2030-01-01T12:00:20.000Z");
    const refundRequestUpdate = vi.fn();
    const externalAlertFindFirst = vi.fn();
    const tx = {
      refundCorrelationCandidate: {
        findMany: vi.fn().mockResolvedValueOnce([{ requestId }]).mockResolvedValueOnce([]),
      },
      refundRequest: {
        findFirst: vi.fn().mockResolvedValue({
          id: requestId,
          environment: "test",
          paymentKey: "pi_late_boundary",
          executionStartedAt,
          reconciliationSafeAfterAt,
          workflowStatus: "reconciliation_required",
          effectState: "possible",
          execution: {
            stripeRefundId: null,
            idempotencyKey: "refunddesk_same_key",
          },
        }),
        updateMany: refundRequestUpdate,
      },
      externalRefundAlert: {
        findFirst: externalAlertFindFirst,
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: requestId }]),
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(
      repositories.resolveUniqueRefundCandidates(
        installationId,
        new Date("2030-01-01T11:00:00.000Z"),
        new Date("2030-01-01T12:00:19.999Z"),
        observedAt,
      ),
    ).resolves.toEqual({ resolved: 0, conflicts: 0 });
    expect(refundRequestUpdate).not.toHaveBeenCalled();
    expect(externalAlertFindFirst).not.toHaveBeenCalled();
  });
});
