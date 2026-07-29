import { describe, expect, it } from "vitest";

import { ApprovalAttestationKeyring, RefundProofKeyring } from "@refunddesk/domain";

import {
  createApprovalAttestationKeyring,
  createRefundProofKeyring,
} from "../src/application-keyrings.js";

const proofPayload = {
  tenantId: "5c66ba36-d4c2-444e-9186-582c8e6b0671",
  stripeAccountId: "acct_123",
  requestId: "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
  paymentKey: "pi_123",
  amountMinor: 500n,
  currency: "eur",
  environment: "sandbox",
} as const;

const approvalPayload = {
  canonicalRequestHash: Buffer.alloc(32, 9),
  requestNonce: "2db72dc2-4816-4f95-aa23-57357727e113",
  tenantId: proofPayload.tenantId,
  installationId: "0f12622c-eb99-49b5-9940-d194098446af",
  stripeAccountId: proofPayload.stripeAccountId,
  environment: "sandbox",
  resourceType: "payment_intent",
  resourceId: proofPayload.paymentKey,
  requestId: proofPayload.requestId,
  requestVersion: 3,
  approverUserId: "48257283-e1c7-46f4-88aa-f9d621ae93df",
  requesterUserId: "8c80aa09-dfc7-42e1-824c-b4c2585054cf",
  approverStripeUserId: "usr_Approver",
  requesterStripeUserId: "usr_Requester",
  paymentKey: proofPayload.paymentKey,
  paymentIntentId: proofPayload.paymentKey,
  chargeId: "ch_123",
  amountMinor: proofPayload.amountMinor,
  currency: proofPayload.currency,
  reason: "requested_by_customer",
  policyVersion: 2,
  requiredApprovals: 1,
  expiresAt: "2030-01-08T00:00:00.000Z",
  verifiedAt: "2030-01-01T00:00:00.000Z",
  consumeBefore: "2030-01-01T00:05:00.000Z",
} as const;

function workerKeys() {
  return {
    activeProofVersion: "v1" as const,
    proofRotationState: "legacy" as const,
    proofV1: Buffer.alloc(32, 1),
    activeApprovalAttestationVersion: "v1" as const,
    approvalAttestationRotationState: "legacy" as const,
    approvalAttestationV1: Buffer.alloc(32, 2),
  };
}

describe("worker application keyrings", () => {
  it("keeps staged or rollback V2 keys verify-only while V1 selectors remain active", () => {
    const keys = {
      ...workerKeys(),
      proofRotationState: "staged" as const,
      proofV2: Buffer.alloc(32, 3),
      approvalAttestationRotationState: "staged" as const,
      approvalAttestationV2: Buffer.alloc(32, 4),
    };
    const proofs = createRefundProofKeyring(keys);
    const approvals = createApprovalAttestationKeyring(keys);
    const futureProof = new RefundProofKeyring({
      active: { version: "v2", key: keys.proofV2 },
    }).sign(proofPayload);
    const futureApproval = new ApprovalAttestationKeyring({
      active: { version: "v2", key: keys.approvalAttestationV2 },
    }).sign(approvalPayload);

    expect(proofs.sign(proofPayload)).toMatch(/^v1\./u);
    expect(approvals.sign(approvalPayload)).toMatch(/^v1\./u);
    expect(proofs.verify(proofPayload, futureProof)).toBe(true);
    expect(approvals.verify(approvalPayload, futureApproval)).toBe(true);
  });

  it("signs with V2 and verifies retained V1 proofs and attestations after activation", () => {
    const v1Keys = workerKeys();
    const historicalProof = new RefundProofKeyring({
      active: { version: "v1", key: v1Keys.proofV1 },
    }).sign(proofPayload);
    const historicalApproval = new ApprovalAttestationKeyring({
      active: { version: "v1", key: v1Keys.approvalAttestationV1 },
    }).sign(approvalPayload);
    const keys = {
      ...v1Keys,
      activeProofVersion: "v2" as const,
      proofRotationState: "active" as const,
      proofV2: Buffer.alloc(32, 3),
      activeApprovalAttestationVersion: "v2" as const,
      approvalAttestationRotationState: "active" as const,
      approvalAttestationV2: Buffer.alloc(32, 4),
    };
    const proofs = createRefundProofKeyring(keys);
    const approvals = createApprovalAttestationKeyring(keys);

    expect(proofs.sign(proofPayload)).toMatch(/^v2\./u);
    expect(approvals.sign(approvalPayload)).toMatch(/^v2\./u);
    expect(proofs.verify(proofPayload, historicalProof)).toBe(true);
    expect(approvals.verify(approvalPayload, historicalApproval)).toBe(true);
  });

  it("fails closed when either selected V2 key is unavailable", () => {
    expect(() =>
      createRefundProofKeyring({
        ...workerKeys(),
        activeProofVersion: "v2",
        proofRotationState: "active",
      }),
    ).toThrow("PROOF_HMAC_KEY_ROTATION_STATE_INVALID");
    expect(() =>
      createApprovalAttestationKeyring({
        ...workerKeys(),
        activeApprovalAttestationVersion: "v2",
        approvalAttestationRotationState: "active",
      }),
    ).toThrow("APPROVAL_ATTESTATION_KEY_ROTATION_STATE_INVALID");
  });

  it("rejects every V1 proof and attestation after V1 retirement", () => {
    const v1Keys = workerKeys();
    const historicalProof = new RefundProofKeyring({
      active: { version: "v1", key: v1Keys.proofV1 },
    }).sign(proofPayload);
    const historicalApproval = new ApprovalAttestationKeyring({
      active: { version: "v1", key: v1Keys.approvalAttestationV1 },
    }).sign(approvalPayload);
    const retiredKeys = {
      activeProofVersion: "v2" as const,
      proofRotationState: "retired" as const,
      proofV2: Buffer.alloc(32, 3),
      activeApprovalAttestationVersion: "v2" as const,
      approvalAttestationRotationState: "retired" as const,
      approvalAttestationV2: Buffer.alloc(32, 4),
    };
    const proofs = createRefundProofKeyring(retiredKeys);
    const approvals = createApprovalAttestationKeyring(retiredKeys);

    expect(proofs.sign(proofPayload)).toMatch(/^v2\./u);
    expect(approvals.sign(approvalPayload)).toMatch(/^v2\./u);
    expect(proofs.verify(proofPayload, historicalProof)).toBe(false);
    expect(approvals.verify(approvalPayload, historicalApproval)).toBe(false);
  });
});
