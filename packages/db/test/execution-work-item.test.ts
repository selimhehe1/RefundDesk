import { describe, expect, it, vi } from "vitest";

import { TenantRepositories, type Prisma } from "../src/index.js";

const tenantId = "5c66ba36-d4c2-444e-9186-582c8e6b0671";
const requestId = "ca3872bc-01b8-4df3-b649-e81a22c31c5e";
const installationId = "0f12622c-eb99-49b5-9940-d194098446af";
const requesterUserId = "8e52d5ac-b743-4b6b-9f7e-79f42c402f2e";
const approverUserId = "0064fd29-e479-4a23-a78b-5d43a78d9263";
const approvalAttestationId = "1d89462d-3444-42c3-a6a1-f89deea67e78";

describe("execution work item loading", () => {
  it("loads every relation sequentially on the transaction client", async () => {
    const request = { id: requestId, tenantId, installationId, requesterUserId };
    const tenant = { id: tenantId };
    const installation = { id: installationId, tenantId };
    const executionRecord = { id: "execution-test", requestId, tenantId };
    const attempts = [
      { id: "attempt-1", executionId: executionRecord.id, tenantId, attemptNumber: 1 },
      { id: "attempt-2", executionId: executionRecord.id, tenantId, attemptNumber: 2 },
    ];
    const requester = { id: requesterUserId, tenantId };
    const decision = {
      id: "3a92ed44-2314-499f-b4d2-9ee85dc04a6b",
      tenantId,
      requestId,
      approverUserId,
      approvalAttestationId,
      decision: "approve",
    };
    const approver = { id: approverUserId, tenantId };
    const approvalAttestation = {
      id: approvalAttestationId,
      tenantId,
      requestId,
      approverUserId,
    };
    const completedReads: string[] = [];
    let activeRead: string | null = null;

    function sequentialRead<T>(name: string, value: T) {
      return vi.fn(async () => {
        if (activeRead !== null) {
          throw new Error(`OVERLAPPING_TRANSACTION_READ:${activeRead}:${name}`);
        }
        activeRead = name;
        await Promise.resolve();
        activeRead = null;
        completedReads.push(name);
        return value;
      });
    }

    const requestFindFirst = sequentialRead("request", request);
    const tenantFindFirst = sequentialRead("tenant", tenant);
    const installationFindFirst = sequentialRead("installation", installation);
    const executionFindFirst = sequentialRead("execution", executionRecord);
    const attemptsFindMany = sequentialRead("attempts", attempts);
    const userFindFirst = sequentialRead("requester", requester);
    const decisionFindFirst = sequentialRead("decision", decision);
    const approverFindFirst = sequentialRead("approver", approver);
    const attestationFindFirst = sequentialRead("attestation", approvalAttestation);
    const tenantUserFindFirst = vi
      .fn()
      .mockImplementationOnce(userFindFirst)
      .mockImplementationOnce(approverFindFirst);
    const tx = {
      refundRequest: { findFirst: requestFindFirst },
      tenant: { findFirst: tenantFindFirst },
      stripeInstallation: { findFirst: installationFindFirst },
      refundExecution: { findFirst: executionFindFirst },
      refundExecutionAttempt: { findMany: attemptsFindMany },
      tenantUser: { findFirst: tenantUserFindFirst },
      approvalDecision: { findFirst: decisionFindFirst },
      approvalAttestation: { findFirst: attestationFindFirst },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(repositories.getExecutionWorkItem(requestId)).resolves.toEqual({
      ...request,
      tenant,
      installation,
      execution: { ...executionRecord, attempts },
      requester,
      approvalDecision: {
        ...decision,
        approver,
        approvalAttestation,
      },
    });
    expect(completedReads).toEqual([
      "request",
      "tenant",
      "installation",
      "execution",
      "attempts",
      "requester",
      "decision",
      "approver",
      "attestation",
    ]);
    expect(requestFindFirst).toHaveBeenCalledWith({
      where: { id: requestId, tenantId },
    });
    expect(tenantFindFirst).toHaveBeenCalledWith({
      where: { id: tenantId },
    });
    expect(installationFindFirst).toHaveBeenCalledWith({
      where: { id: installationId, tenantId },
    });
    expect(executionFindFirst).toHaveBeenCalledWith({
      where: { requestId, tenantId },
    });
    expect(attemptsFindMany).toHaveBeenCalledWith({
      where: { executionId: executionRecord.id, tenantId },
      orderBy: { attemptNumber: "asc" },
    });
    expect(tenantUserFindFirst).toHaveBeenNthCalledWith(1, {
      where: { id: requesterUserId, tenantId },
    });
    expect(decisionFindFirst).toHaveBeenCalledWith({
      where: { decision: "approve", requestId, tenantId },
      orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
    });
    expect(tenantUserFindFirst).toHaveBeenNthCalledWith(2, {
      where: { id: approverUserId, tenantId },
    });
    expect(attestationFindFirst).toHaveBeenCalledWith({
      where: {
        approverUserId,
        id: approvalAttestationId,
        requestId,
        tenantId,
      },
    });
  });

  it("does not load relations when the request does not exist", async () => {
    const tenantFindFirst = vi.fn();
    const installationFindFirst = vi.fn();
    const executionFindFirst = vi.fn();
    const tx = {
      refundRequest: { findFirst: vi.fn().mockResolvedValue(null) },
      tenant: { findFirst: tenantFindFirst },
      stripeInstallation: { findFirst: installationFindFirst },
      refundExecution: { findFirst: executionFindFirst },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(repositories.getExecutionWorkItem(requestId)).resolves.toBeNull();
    expect(tenantFindFirst).not.toHaveBeenCalled();
    expect(installationFindFirst).not.toHaveBeenCalled();
    expect(executionFindFirst).not.toHaveBeenCalled();
  });

  it("fails closed before installation or execution reads when the tenant is missing", async () => {
    const installationFindFirst = vi.fn();
    const executionFindFirst = vi.fn();
    const tx = {
      refundRequest: {
        findFirst: vi.fn().mockResolvedValue({ id: requestId, tenantId, installationId }),
      },
      tenant: { findFirst: vi.fn().mockResolvedValue(null) },
      stripeInstallation: { findFirst: installationFindFirst },
      refundExecution: { findFirst: executionFindFirst },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(repositories.getExecutionWorkItem(requestId)).rejects.toThrow(
      "EXECUTION_WORK_ITEM_TENANT_NOT_FOUND",
    );
    expect(installationFindFirst).not.toHaveBeenCalled();
    expect(executionFindFirst).not.toHaveBeenCalled();
  });

  it("fails closed before the execution read when the installation is missing", async () => {
    const executionFindFirst = vi.fn();
    const tx = {
      refundRequest: {
        findFirst: vi.fn().mockResolvedValue({ id: requestId, tenantId, installationId }),
      },
      tenant: { findFirst: vi.fn().mockResolvedValue({ id: tenantId }) },
      stripeInstallation: { findFirst: vi.fn().mockResolvedValue(null) },
      refundExecution: { findFirst: executionFindFirst },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await expect(repositories.getExecutionWorkItem(requestId)).rejects.toThrow(
      "EXECUTION_WORK_ITEM_INSTALLATION_NOT_FOUND",
    );
    expect(executionFindFirst).not.toHaveBeenCalled();
  });
});
