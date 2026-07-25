import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@refunddesk/db";
import { refundIdempotencyKey, type RefundProofKeyring } from "@refunddesk/domain";

import { PrismaWorkerStore } from "../src/db-store.js";

const tenantId = "5c66ba36-d4c2-444e-9186-582c8e6b0671";
const requestId = "ca3872bc-01b8-4df3-b649-e81a22c31c5e";

function executionWorkItem() {
  return {
    id: requestId,
    tenantId,
    installationId: "installation-test",
    workflowStatus: "approved",
    effectState: "not_started",
    paymentGuardReleasedAt: null,
    environment: "test",
    paymentKey: "pi_boundary",
    paymentIntentId: "pi_boundary",
    chargeId: "ch_boundary",
    amountMinor: 500n,
    currency: "eur",
    reason: "requested_by_customer",
    execution: null,
    tenant: {
      status: "active",
      liveEnabled: false,
    },
    installation: {
      status: "active",
      environment: "test",
      stripeAccountId: "acct_boundary",
    },
  };
}

interface HarnessExecution {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly stripeRefundId: string | null;
  readonly tenantId?: string;
  readonly requestId?: string;
  readonly canonicalParametersHash?: Uint8Array;
  readonly amountMinor?: bigint;
  readonly currency?: string;
}

type HarnessWorkItem = Omit<ReturnType<typeof executionWorkItem>, "execution"> & {
  execution: HarnessExecution | null;
};

function storeHarness(initialItem: HarnessWorkItem = executionWorkItem()) {
  const state: { item: HarnessWorkItem } = {
    item: initialItem,
  };
  const requestUpdate = vi.fn(
    (input: {
      readonly where: {
        readonly id?: string;
        readonly tenantId?: string;
        readonly workflowStatus?: string;
        readonly effectState?: string | { readonly in: readonly string[] };
        readonly paymentGuardReleasedAt?: Date | null;
        readonly environment?: { readonly in: readonly string[] };
        readonly tenant?: {
          readonly status: string;
          readonly liveEnabled: boolean;
        };
        readonly installation?: {
          readonly status: string;
          readonly environment: { readonly in: readonly string[] };
        };
      };
      readonly data: {
        readonly workflowStatus?: string;
        readonly effectState?: string;
      };
    }) => {
      if (
        input.where.workflowStatus === "approved" &&
        input.data.workflowStatus === "executing" &&
        state.item.workflowStatus === "approved" &&
        state.item.tenant.status === "active" &&
        state.item.installation.status === "active"
      ) {
        state.item = {
          ...state.item,
          workflowStatus: "executing",
        };
        return Promise.resolve({ count: 1 });
      }
      if (
        input.where.workflowStatus === "executing" &&
        input.data.workflowStatus === "reconciliation_required" &&
        state.item.workflowStatus === "executing"
      ) {
        state.item = {
          ...state.item,
          workflowStatus: "reconciliation_required",
        };
        return Promise.resolve({ count: 1 });
      }
      if (
        input.where.workflowStatus === "executing" &&
        input.data.effectState === "possible" &&
        state.item.workflowStatus === "executing" &&
        (state.item.effectState === "not_started" || state.item.effectState === "absence_proven")
      ) {
        state.item = {
          ...state.item,
          effectState: "possible",
        };
        return Promise.resolve({ count: 1 });
      }
      return Promise.resolve({ count: 0 });
    },
  );
  const requestFindMany = vi.fn().mockResolvedValue([]);
  const executionUpsert = vi.fn();
  const attemptAggregate = vi.fn();
  const attemptCreate = vi.fn();
  const tenantFindFirst = vi.fn(() => Promise.resolve(state.item.tenant));
  const installationFindMany = vi.fn(() =>
    Promise.resolve([
      {
        ...state.item.installation,
        id: state.item.installationId,
        tenantId: state.item.tenantId,
      },
    ]),
  );
  const executionFindMany = vi.fn(() =>
    Promise.resolve(
      state.item.execution === null
        ? []
        : [
            {
              ...state.item.execution,
              requestId: state.item.id,
              tenantId: state.item.tenantId,
            },
          ],
    ),
  );
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    tenant: {
      findFirst: tenantFindFirst,
    },
    stripeInstallation: {
      findMany: installationFindMany,
    },
    refundRequest: {
      findFirst: vi.fn(() => Promise.resolve(state.item)),
      findMany: requestFindMany,
      updateMany: requestUpdate,
    },
    refundExecution: {
      findMany: executionFindMany,
      upsert: executionUpsert,
    },
    refundExecutionAttempt: {
      aggregate: attemptAggregate,
      create: attemptCreate,
    },
  };
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([{ tenant_id: tenantId }]),
    $transaction: vi.fn((operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx)),
  } as unknown as PrismaClient;
  const proofs = {} as RefundProofKeyring;

  return {
    state,
    requestUpdate,
    requestFindMany,
    executionUpsert,
    attemptAggregate,
    attemptCreate,
    store: new PrismaWorkerStore(client, proofs),
  };
}

describe("PrismaWorkerStore financial authorization races", () => {
  it("does not claim an approved request after deauthorization", async () => {
    const item = executionWorkItem();
    const harness = storeHarness({
      ...item,
      tenant: {
        ...item.tenant,
        status: "pending_deletion",
      },
      installation: {
        ...item.installation,
        status: "deauthorized",
      },
    });

    await expect(harness.store.loadRefundExecution(tenantId, requestId)).resolves.toBeNull();
    expect(harness.requestUpdate).not.toHaveBeenCalled();
    expect(harness.state.item).toMatchObject({
      workflowStatus: "approved",
      effectState: "not_started",
      paymentGuardReleasedAt: null,
    });
  });

  it("stops without boundary mutations when deauthorization races after load", async () => {
    const harness = storeHarness();

    await expect(harness.store.loadRefundExecution(tenantId, requestId)).resolves.not.toBeNull();
    expect(harness.state.item.workflowStatus).toBe("executing");
    expect(harness.requestUpdate.mock.calls[0]?.[0].where).toEqual({
      id: requestId,
      tenantId,
      workflowStatus: "approved",
      effectState: "not_started",
      paymentGuardReleasedAt: null,
      environment: { in: ["test", "sandbox"] },
      tenant: {
        status: "active",
        liveEnabled: false,
      },
      installation: {
        status: "active",
        environment: { in: ["test", "sandbox"] },
      },
    });

    harness.state.item = {
      ...harness.state.item,
      tenant: {
        ...harness.state.item.tenant,
        status: "pending_deletion",
      },
      installation: {
        ...harness.state.item.installation,
        status: "deauthorized",
      },
    };

    await expect(
      harness.store.persistEffectBoundary({
        tenantId,
        requestId,
        idempotencyKey: `refunddesk:refund-request:${requestId}:v1`,
        at: new Date("2030-01-01T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ kind: "not_executable" });

    expect(harness.requestUpdate).toHaveBeenCalledOnce();
    expect(harness.executionUpsert).not.toHaveBeenCalled();
    expect(harness.attemptAggregate).not.toHaveBeenCalled();
    expect(harness.attemptCreate).not.toHaveBeenCalled();
    expect(harness.state.item).toMatchObject({
      workflowStatus: "executing",
      effectState: "not_started",
      paymentGuardReleasedAt: null,
    });
  });

  it("moves a replayed possible effect to reconciliation before returning work", async () => {
    const item = executionWorkItem();
    const harness = storeHarness({
      ...item,
      workflowStatus: "executing",
      effectState: "possible",
      execution: {
        id: "execution-possible",
        idempotencyKey: refundIdempotencyKey(requestId),
        stripeRefundId: null,
      },
    });

    await expect(harness.store.loadRefundExecution(tenantId, requestId)).resolves.toBeNull();
    expect(harness.state.item.workflowStatus).toBe("reconciliation_required");
    expect(harness.executionUpsert).not.toHaveBeenCalled();
    expect(harness.attemptCreate).not.toHaveBeenCalled();
  });

  it("closes a boundary race by reconciling possible instead of starting another attempt", async () => {
    const item = executionWorkItem();
    const harness = storeHarness({
      ...item,
      workflowStatus: "executing",
      effectState: "possible",
      execution: {
        id: "execution-raced",
        idempotencyKey: refundIdempotencyKey(requestId),
        stripeRefundId: null,
      },
    });

    await expect(
      harness.store.persistEffectBoundary({
        tenantId,
        requestId,
        idempotencyKey: refundIdempotencyKey(requestId),
        at: new Date("2030-01-01T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ kind: "reconciliation_required" });
    expect(harness.state.item.workflowStatus).toBe("reconciliation_required");
    expect(harness.executionUpsert).not.toHaveBeenCalled();
    expect(harness.attemptCreate).not.toHaveBeenCalled();
  });

  it("reuses the persisted canonical key after proven absence", async () => {
    const item = executionWorkItem();
    const idempotencyKey = refundIdempotencyKey(requestId);
    const canonicalParametersHash = createHash("sha256")
      .update(
        JSON.stringify([
          tenantId,
          requestId,
          "acct_boundary",
          "test",
          "pi_boundary",
          "pi_boundary",
          "ch_boundary",
          "500",
          "eur",
          "requested_by_customer",
        ]),
        "utf8",
      )
      .digest();
    const execution = {
      id: "execution-absence",
      tenantId,
      requestId,
      idempotencyKey,
      canonicalParametersHash,
      amountMinor: 500n,
      currency: "eur",
      stripeRefundId: null,
    };
    const harness = storeHarness({
      ...item,
      workflowStatus: "executing",
      effectState: "absence_proven",
      execution,
    });
    harness.executionUpsert.mockResolvedValue(execution);
    harness.attemptAggregate.mockResolvedValue({ _max: { attemptNumber: 3 } });
    harness.attemptCreate.mockResolvedValue({ id: "attempt-4" });

    await expect(
      harness.store.persistEffectBoundary({
        tenantId,
        requestId,
        idempotencyKey,
        at: new Date("2030-01-01T12:00:00.000Z"),
      }),
    ).resolves.toEqual({
      kind: "execute",
      attemptId: "attempt-4",
      idempotencyKey,
    });
    expect(harness.executionUpsert).toHaveBeenCalledWith({
      where: {
        requestId_tenantId: {
          requestId,
          tenantId,
        },
      },
      create: {
        tenantId,
        requestId,
        idempotencyKey,
        canonicalParametersHash: Uint8Array.from(canonicalParametersHash),
        amountMinor: 500n,
        currency: "eur",
      },
      update: {},
    });
    expect(harness.attemptCreate).toHaveBeenCalledWith({
      data: {
        tenantId,
        executionId: "execution-absence",
        attemptNumber: 4,
        state: "started",
        startedAt: new Date("2030-01-01T12:00:00.000Z"),
      },
    });
  });

  it("rediscovers an orphaned executing request only with its persisted canonical key", async () => {
    const item = executionWorkItem();
    const idempotencyKey = refundIdempotencyKey(requestId);
    const execution = {
      id: "execution-recoverable",
      idempotencyKey,
      stripeRefundId: null,
    };
    const executing = {
      ...item,
      workflowStatus: "executing",
      effectState: "absence_proven",
      execution,
    };
    const harness = storeHarness(executing);
    harness.requestFindMany.mockResolvedValue([executing]);

    await expect(harness.store.listApprovedRefundExecutions(10)).resolves.toEqual([
      {
        tenantId,
        requestId,
        installation: {
          tenantId,
          installationId: "installation-test",
          stripeAccountId: "acct_boundary",
          environment: "test",
          active: true,
          tenantLiveEnabled: false,
        },
      },
    ]);
  });

  it("does not emit an orphaned possible effect before reconciliation", async () => {
    const item = executionWorkItem();
    const executing = {
      ...item,
      workflowStatus: "executing",
      effectState: "possible",
      execution: {
        id: "execution-possible-recovery",
        idempotencyKey: refundIdempotencyKey(requestId),
        stripeRefundId: null,
      },
    };
    const harness = storeHarness(executing);
    harness.requestFindMany.mockResolvedValue([executing]);

    await expect(harness.store.listApprovedRefundExecutions(10)).resolves.toEqual([]);
    expect(harness.state.item.workflowStatus).toBe("reconciliation_required");
  });

  it("fails closed instead of recovering with a different persisted key", async () => {
    const item = executionWorkItem();
    const executing = {
      ...item,
      workflowStatus: "executing",
      effectState: "absence_proven",
      execution: {
        id: "execution-wrong-key",
        idempotencyKey: "refunddesk:refund-request:different:v1",
        stripeRefundId: null,
      },
    };
    const harness = storeHarness(executing);
    harness.requestFindMany.mockResolvedValue([executing]);

    await expect(harness.store.listApprovedRefundExecutions(10)).resolves.toEqual([]);
    expect(harness.state.item.workflowStatus).toBe("reconciliation_required");
  });
});
