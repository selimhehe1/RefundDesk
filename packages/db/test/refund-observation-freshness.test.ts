import { describe, expect, it, vi } from "vitest";

import { TenantRepositories, type Prisma, type StripeRefundStatus } from "../src/index.js";

const tenantId = "5c66ba36-d4c2-444e-9186-582c8e6b0671";
const requestId = "ca3872bc-01b8-4df3-b649-e81a22c31c5e";
const executionId = "a5cc7f0b-e61d-4fd9-81a4-d14c469e46a3";
const observedAt = new Date("2030-01-01T12:01:00.000Z");
const eventAt = new Date("2030-01-01T12:00:10.000Z");

function lockedObservation(input: {
  readonly workflowStatus?: string;
  readonly effectState?: string;
  readonly refundStatus?: StripeRefundStatus | null;
  readonly eventCreatedAt?: Date | null;
}) {
  return {
    id: requestId,
    workflow_status: input.workflowStatus ?? "executing",
    effect_state: input.effectState ?? "identified",
    execution_id: executionId,
    stripe_refund_id: "re_same",
    stripe_refund_status: input.refundStatus ?? "pending",
    last_stripe_event_created_at: input.eventCreatedAt ?? eventAt,
  };
}

function transaction(
  locked: ReturnType<typeof lockedObservation>,
  executionCount = 1,
  requestCount = 1,
) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([locked]),
    refundExecution: {
      updateMany: vi.fn().mockResolvedValue({ count: executionCount }),
    },
    refundRequest: {
      updateMany: vi.fn().mockResolvedValue({ count: requestCount }),
    },
  };
}

function observation(status: StripeRefundStatus | null, stripeEventCreatedAt?: Date) {
  return {
    requestId,
    stripeRefundId: "re_same",
    stripeRefundStatus: status,
    reconciliationResolution: "resolve" as const,
    ...(stripeEventCreatedAt === undefined ? {} : { stripeEventCreatedAt }),
    observedAt,
  };
}

describe("Stripe refund observation freshness", () => {
  it("corrects the same Refund from succeeded to failed without releasing timestamps again", async () => {
    const tx = transaction(
      lockedObservation({
        workflowStatus: "succeeded",
        effectState: "identified",
        refundStatus: "succeeded",
      }),
    );
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(
      repositories.markRefundIdentified(
        observation("failed", new Date("2030-01-01T12:00:11.000Z")),
      ),
    ).resolves.toBe(true);
    expect(tx.refundExecution.updateMany).toHaveBeenCalledWith({
      where: {
        id: executionId,
        tenantId,
        requestId,
        stripeRefundId: "re_same",
        stripeRefundStatus: "succeeded",
        lastStripeEventCreatedAt: eventAt,
      },
      data: {
        stripeRefundId: "re_same",
        stripeRefundStatus: "failed",
        lastStripeEventCreatedAt: new Date("2030-01-01T12:00:11.000Z"),
        reconciledAt: observedAt,
      },
    });
    expect(tx.refundRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: requestId,
        tenantId,
        workflowStatus: "succeeded",
        effectState: "identified",
      },
      data: {
        effectState: "absence_proven",
        workflowStatus: "failed_terminal",
        version: { increment: 1 },
      },
    });
  });

  it("returns a successful no-op for a stale event", async () => {
    const tx = transaction(lockedObservation({ refundStatus: "pending" }));
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(
      repositories.markRefundIdentified(
        observation("succeeded", new Date("2030-01-01T12:00:09.000Z")),
      ),
    ).resolves.toBe(true);
    expect(tx.refundExecution.updateMany).not.toHaveBeenCalled();
    expect(tx.refundRequest.updateMany).not.toHaveBeenCalled();
  });

  it("gives failed priority when Stripe Event.created is equal", async () => {
    const tx = transaction(
      lockedObservation({
        workflowStatus: "succeeded",
        effectState: "identified",
        refundStatus: "succeeded",
      }),
    );
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(repositories.markRefundIdentified(observation("failed", eventAt))).resolves.toBe(
      true,
    );
    expect(tx.refundExecution.updateMany).toHaveBeenCalledOnce();
    expect(tx.refundRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: requestId,
        tenantId,
        workflowStatus: "succeeded",
        effectState: "identified",
      },
      data: {
        effectState: "absence_proven",
        workflowStatus: "failed_terminal",
        version: { increment: 1 },
      },
    });
  });

  it("lets an authoritative scanner snapshot converge a nonterminal status to failed", async () => {
    const tx = transaction(lockedObservation({ refundStatus: "pending" }));
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(repositories.markRefundIdentified(observation("failed"))).resolves.toBe(true);
    expect(tx.refundRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: requestId,
        tenantId,
        workflowStatus: { in: ["executing", "reconciliation_required"] },
        effectState: { in: ["possible", "identified"] },
      },
      data: {
        effectState: "absence_proven",
        workflowStatus: "failed_terminal",
        terminalAt: observedAt,
        paymentGuardReleasedAt: observedAt,
        version: { increment: 1 },
      },
    });
  });

  it.each(["failed", "canceled"] as const)(
    "never lets a scanner regress terminal %s",
    async (terminalStatus) => {
      const tx = transaction(
        lockedObservation({
          workflowStatus: "failed_terminal",
          effectState: "absence_proven",
          refundStatus: terminalStatus,
        }),
      );
      const repositories = new TenantRepositories(
        tx as unknown as Prisma.TransactionClient,
        tenantId,
      );

      await expect(repositories.markRefundIdentified(observation("succeeded"))).resolves.toBe(true);
      expect(tx.refundExecution.updateMany).not.toHaveBeenCalled();
      expect(tx.refundRequest.updateMany).not.toHaveBeenCalled();
    },
  );

  it("does not erase a known nonterminal status with an unknown observation", async () => {
    const tx = transaction(lockedObservation({ refundStatus: "requires_action" }));
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(repositories.markRefundIdentified(observation(null))).resolves.toBe(true);
    expect(tx.refundExecution.updateMany).not.toHaveBeenCalled();
    expect(tx.refundRequest.updateMany).not.toHaveBeenCalled();
  });

  it("fails the compare-and-set when a concurrent newer execution state already won", async () => {
    const tx = transaction(lockedObservation({ refundStatus: "pending" }), 0);
    const repositories = new TenantRepositories(
      tx as unknown as Prisma.TransactionClient,
      tenantId,
    );

    await expect(
      repositories.markRefundIdentified(
        observation("succeeded", new Date("2030-01-01T12:00:11.000Z")),
      ),
    ).resolves.toBe(false);
    expect(tx.refundRequest.updateMany).not.toHaveBeenCalled();
  });
});
