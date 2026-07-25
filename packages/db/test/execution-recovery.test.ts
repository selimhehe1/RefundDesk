import { describe, expect, it, vi } from "vitest";

import { TenantRepositories, type Prisma } from "../src/index.js";

const tenantId = "5c66ba36-d4c2-444e-9186-582c8e6b0671";
const installationId = "0f12622c-eb99-49b5-9940-d194098446af";

function candidate(id: string, workflowStatus: string, effectState: string) {
  return {
    id,
    tenantId,
    installationId,
    workflowStatus,
    effectState,
  };
}

describe("execution recovery preparation", () => {
  it("returns safe approved/executing work and diverts possible effects to reconciliation", async () => {
    const approved = candidate("approved", "approved", "not_started");
    const executingNotStarted = candidate("executing-new", "executing", "not_started");
    const executingPossible = candidate("executing-ambiguous", "executing", "possible");
    const executingAbsent = candidate("executing-absent", "executing", "absence_proven");
    const findMany = vi
      .fn()
      .mockResolvedValue([approved, executingNotStarted, executingPossible, executingAbsent]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tenant = { id: tenantId, status: "active", liveEnabled: false };
    const installation = { id: installationId, tenantId, status: "active", environment: "test" };
    const tenantFindFirst = vi.fn().mockResolvedValue(tenant);
    const installationFindMany = vi.fn().mockResolvedValue([installation]);
    const executionFindMany = vi.fn().mockResolvedValue([]);
    const tx = {
      refundRequest: { findMany, updateMany },
      tenant: { findFirst: tenantFindFirst },
      stripeInstallation: { findMany: installationFindMany },
      refundExecution: { findMany: executionFindMany },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(repositories.prepareExecutionRecoveryWork(25)).resolves.toEqual([
      { ...approved, tenant, installation, execution: null },
      { ...executingNotStarted, tenant, installation, execution: null },
      { ...executingAbsent, tenant, installation, execution: null },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId,
        environment: { in: ["test", "sandbox"] },
        paymentGuardReleasedAt: null,
        tenant: {
          status: "active",
          liveEnabled: false,
        },
        installation: {
          status: "active",
          environment: { in: ["test", "sandbox"] },
        },
        OR: [
          {
            workflowStatus: "approved",
            effectState: "not_started",
          },
          {
            workflowStatus: "executing",
            effectState: { in: ["not_started", "possible", "absence_proven"] },
          },
        ],
      },
      take: 25,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "executing-ambiguous",
        tenantId,
        workflowStatus: "executing",
        paymentGuardReleasedAt: null,
      },
      data: {
        workflowStatus: "reconciliation_required",
        version: { increment: 1 },
      },
    });
    expect(tenantFindFirst).toHaveBeenCalledWith({ where: { id: tenantId } });
    expect(installationFindMany).toHaveBeenCalledWith({
      where: {
        tenantId,
        id: { in: [installationId] },
      },
    });
    expect(executionFindMany).toHaveBeenCalledWith({
      where: {
        tenantId,
        requestId: { in: ["approved", "executing-new", "executing-absent"] },
      },
    });
    expect(tenantFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
      installationFindMany.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(installationFindMany.mock.invocationCallOrder[0]).toBeLessThan(
      executionFindMany.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("never emits a possible candidate when its reconciliation CAS has already drifted", async () => {
    const possible = candidate("executing-raced", "executing", "possible");
    const tx = {
      refundRequest: {
        findMany: vi.fn().mockResolvedValue([possible]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(repositories.prepareExecutionRecoveryWork()).resolves.toEqual([]);
  });

  it("bounds recovery batches", async () => {
    const repositories = new TenantRepositories({} as Prisma.TransactionClient, tenantId);

    await expect(repositories.prepareExecutionRecoveryWork(0)).rejects.toThrow(RangeError);
    await expect(repositories.prepareExecutionRecoveryWork(1_001)).rejects.toThrow(RangeError);
  });
});
