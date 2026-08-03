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

  it("corrects a succeeded Refund cancellation without rewriting terminal timestamps", async () => {
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

    await expect(repositories.markRefundIdentified(observation("canceled"))).resolves.toBe(true);
    expect(tx.refundRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          effectState: "absence_proven",
          workflowStatus: "failed_terminal",
          version: { increment: 1 },
        },
      }),
    );
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
        workflowStatus: "failed_terminal",
        effectState: "absence_proven",
        refundStatus: "canceled",
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
    expect(tx.refundRequest.updateMany).not.toHaveBeenCalled();
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

describe("Non-terminal Stripe refund statuses", () => {
  // Stripe reports an asynchronous card refund as `pending` before it settles, and can park
  // it in `requires_action`. Neither means the money moved, so neither may end the workflow
  // or release the payment guard — the protection has to outlive the uncertainty.
  //
  // The branch that handles them sits immediately above the one that treats `failed` as
  // proof of absence. Reordering the two would release the guard on a refund that may still
  // succeed, which is why these cases assert what the update must *not* carry rather than
  // only what it does.
  const nonTerminal: readonly StripeRefundStatus[] = ["pending", "requires_action"];

  for (const status of nonTerminal) {
    it(`keeps the workflow open and the payment guard held on ${status}`, async () => {
      const tx = transaction(
        lockedObservation({ workflowStatus: "executing", effectState: "possible" }),
      );
      const repositories = new TenantRepositories(
        tx as unknown as Prisma.TransactionClient,
        tenantId,
      );

      await expect(
        repositories.markRefundIdentified({
          ...observation(status),
          reconciliationResolution: "preserve",
        }),
      ).resolves.toBe(true);

      expect(tx.refundRequest.updateMany).toHaveBeenCalledTimes(1);
      const [call] = tx.refundRequest.updateMany.mock.calls;
      const data = (call?.[0] as { readonly data: Record<string, unknown> }).data;

      // A Refund object exists, so the effect is identified rather than absent.
      expect(data.effectState).toBe("identified");
      expect(data.version).toEqual({ increment: 1 });

      // The three fields that would end the workflow or free the payment.
      expect(data).not.toHaveProperty("workflowStatus");
      expect(data).not.toHaveProperty("terminalAt");
      expect(data).not.toHaveProperty("paymentGuardReleasedAt");
    });

    it(`refuses to treat ${status} as proof that no refund happened`, async () => {
      const tx = transaction(
        lockedObservation({ workflowStatus: "executing", effectState: "possible" }),
      );
      const repositories = new TenantRepositories(
        tx as unknown as Prisma.TransactionClient,
        tenantId,
      );

      await repositories.markRefundIdentified({
        ...observation(status),
        reconciliationResolution: "preserve",
      });

      const [call] = tx.refundRequest.updateMany.mock.calls;
      const data = (call?.[0] as { readonly data: Record<string, unknown> }).data;
      expect(data.effectState).not.toBe("absence_proven");
    });
  }
});
