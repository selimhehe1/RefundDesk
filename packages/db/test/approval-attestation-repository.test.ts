import { describe, expect, it, vi } from "vitest";

import { TenantRepositories, type Prisma } from "../src/index.js";

const tenantId = "5c66ba36-d4c2-444e-9186-582c8e6b0671";
const attestationId = "1d89462d-3444-42c3-a6a1-f89deea67e78";
const requestNonce = "46c4863d-07a9-4f1c-ad21-bcaf87d6c08a";

describe("approval attestation repository", () => {
  it("forces the transaction tenant on persistence", async () => {
    const create = vi.fn().mockResolvedValue({ id: attestationId, tenantId });
    const tx = {
      approvalAttestation: { create },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);
    const data = {
      approverUserId: "0064fd29-e479-4a23-a78b-5d43a78d9263",
      authorizationSnapshotHash: Buffer.alloc(32, 2),
      consumeBefore: new Date("2030-01-01T00:05:00.000Z"),
      environment: "test" as const,
      hmac: Buffer.alloc(32, 3),
      hmacKeyVersion: "v1",
      installationId: "0f12622c-eb99-49b5-9940-d194098446af",
      requestId: "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
      requestNonce,
      requestVersion: 0,
      resourceId: "pi_Test",
      resourceType: "payment_intent",
      signedEnvelopeHash: Buffer.alloc(32, 1),
      stripeAccountId: "acct_Test",
      verifiedAt: new Date("2030-01-01T00:00:00.000Z"),
    };

    await expect(repositories.persistApprovalAttestation(data)).resolves.toEqual({
      id: attestationId,
      tenantId,
    });
    expect(create).toHaveBeenCalledWith({
      data: { ...data, tenantId },
    });
  });

  it("scopes identifier and nonce lookups to the transaction tenant", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: attestationId, tenantId });
    const findUnique = vi.fn().mockResolvedValue({ id: attestationId, tenantId });
    const tx = {
      approvalAttestation: { findFirst, findUnique },
    } as unknown as Prisma.TransactionClient;
    const repositories = new TenantRepositories(tx, tenantId);

    await repositories.getApprovalAttestation(attestationId);
    await repositories.getApprovalAttestationByNonce(requestNonce);

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: attestationId, tenantId },
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_requestNonce: {
          requestNonce,
          tenantId,
        },
      },
    });
  });
});
