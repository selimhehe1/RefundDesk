import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DomainError,
  FieldEncryptionKeyring,
  PilotAccessPolicy,
  RefundProofKeyring,
  canReleasePaymentGuard,
  classifyRefundEvidence,
  classifyRefundFailure,
  correctLinkedRefundTerminalStatus,
  evaluatePaymentEligibility,
  recordDecision,
  refundIdempotencyKey,
  transitionEffectState,
  transitionWorkflowStatus,
  type RefundWorkflow,
} from "../src/index.js";

function pendingWorkflow(overrides: Partial<RefundWorkflow> = {}): RefundWorkflow {
  return {
    id: "request-1",
    requesterId: "requester",
    requiredApprovals: 1,
    expiresAt: new Date("2030-01-08T00:00:00.000Z"),
    status: "pending_approval",
    effectState: "not_started",
    stripeRefundId: null,
    stripeRefundStatus: null,
    decisions: [],
    ...overrides,
  };
}

describe("workflow", () => {
  it("requires an approver distinct from the requester", () => {
    expect(() =>
      recordDecision({
        workflow: pendingWorkflow(),
        approverId: "requester",
        decision: "approve",
        decidedAt: new Date("2030-01-02T00:00:00.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "SELF_APPROVAL" }));
  });

  it("approves once quorum is reached and rejects duplicate decisions", () => {
    const approved = recordDecision({
      workflow: pendingWorkflow(),
      approverId: "approver",
      decision: "approve",
      decidedAt: new Date("2030-01-02T00:00:00.000Z"),
    });
    expect(approved.status).toBe("approved");

    expect(() =>
      recordDecision({
        workflow: pendingWorkflow({
          requiredApprovals: 2,
          decisions: approved.decisions,
        }),
        approverId: "approver",
        decision: "approve",
        decidedAt: new Date("2030-01-03T00:00:00.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_DECISION" }));
  });

  it("requires a meaningful rejection justification", () => {
    expect(() =>
      recordDecision({
        workflow: pendingWorkflow(),
        approverId: "approver",
        decision: "reject",
        rejectionJustification: "no",
        decidedAt: new Date("2030-01-02T00:00:00.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "REJECTION_JUSTIFICATION_REQUIRED" }));
  });

  it("allows reconciliation retry only after absence is proven", () => {
    expect(() =>
      transitionWorkflowStatus("reconciliation_required", "executing", {
        effectState: "possible",
      }),
    ).toThrow(DomainError);
    expect(
      transitionWorkflowStatus("reconciliation_required", "executing", {
        effectState: "absence_proven",
      }),
    ).toBe("executing");
    expect(
      transitionWorkflowStatus("reconciliation_required", "failed_terminal", {
        effectState: "absence_proven",
      }),
    ).toBe("failed_terminal");
    expect(() =>
      transitionWorkflowStatus("executing", "succeeded", {
        effectState: "identified",
        stripeRefundStatus: "pending",
      }),
    ).toThrow(DomainError);
    expect(
      transitionWorkflowStatus("executing", "succeeded", {
        effectState: "identified",
        stripeRefundStatus: "succeeded",
      }),
    ).toBe("succeeded");
  });

  it("corrects a succeeded workflow only when the same linked Refund later fails", () => {
    const succeeded = pendingWorkflow({
      status: "succeeded",
      effectState: "identified",
      stripeRefundId: "re_linked",
      stripeRefundStatus: "succeeded",
    });

    const corrected = correctLinkedRefundTerminalStatus({
      workflow: succeeded,
      observedStripeRefundId: "re_linked",
      authoritativeStripeRefundStatus: "failed",
    });
    expect(corrected).toMatchObject({
      status: "failed_terminal",
      effectState: "absence_proven",
      stripeRefundId: "re_linked",
      stripeRefundStatus: "failed",
    });
    expect(
      canReleasePaymentGuard({
        workflowStatus: corrected.status,
        effectState: corrected.effectState,
        stripeRefundStatus: corrected.stripeRefundStatus,
      }),
    ).toBe(true);

    expect(() =>
      transitionWorkflowStatus("succeeded", "failed_terminal", {
        effectState: "absence_proven",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WORKFLOW_TRANSITION" }));
    expect(() =>
      correctLinkedRefundTerminalStatus({
        workflow: succeeded,
        observedStripeRefundId: "re_different",
        authoritativeStripeRefundStatus: "failed",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EFFECT_TRANSITION" }));
    expect(() =>
      correctLinkedRefundTerminalStatus({
        workflow: { ...succeeded, effectState: "possible" },
        observedStripeRefundId: "re_linked",
        authoritativeStripeRefundStatus: "failed",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WORKFLOW_TRANSITION" }));
    expect(() =>
      correctLinkedRefundTerminalStatus({
        workflow: { ...succeeded, stripeRefundStatus: "pending" },
        observedStripeRefundId: "re_linked",
        authoritativeStripeRefundStatus: "failed",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WORKFLOW_TRANSITION" }));
  });
});

describe("payment eligibility and guard", () => {
  const cardPayment = {
    paymentKey: "pi_123",
    amountCaptured: 1_000n,
    amountRefunded: 200n,
    currency: "eur",
    paid: true,
    captured: true,
    disputed: false,
    paymentMethodType: "card",
    hasConnectSemantics: false,
  } as const;

  it("accepts only captured card payments within the remaining amount", () => {
    expect(
      evaluatePaymentEligibility({
        ...cardPayment,
        requestedAmountMinor: 800n,
        requestedCurrency: "EUR",
      }),
    ).toEqual({
      eligible: true,
      paymentKey: "pi_123",
      currency: "eur",
      remainingMinor: 800n,
    });
    expect(
      evaluatePaymentEligibility({
        ...cardPayment,
        paymentMethodType: "card_present",
      }),
    ).toEqual({ eligible: false, code: "CARD_PRESENT_UNSUPPORTED" });
    expect(
      evaluatePaymentEligibility({
        ...cardPayment,
        requestedAmountMinor: 801n,
      }),
    ).toEqual({ eligible: false, code: "AMOUNT_EXCEEDS_REMAINING" });
  });

  it("keeps the guard for ambiguous and non-terminal Stripe effects", () => {
    expect(
      canReleasePaymentGuard({
        workflowStatus: "reconciliation_required",
        effectState: "possible",
        stripeRefundStatus: null,
      }),
    ).toBe(false);
    expect(
      canReleasePaymentGuard({
        workflowStatus: "succeeded",
        effectState: "identified",
        stripeRefundStatus: "pending",
      }),
    ).toBe(false);
    expect(
      canReleasePaymentGuard({
        workflowStatus: "succeeded",
        effectState: "identified",
        stripeRefundStatus: "failed",
      }),
    ).toBe(false);
    expect(
      canReleasePaymentGuard({
        workflowStatus: "succeeded",
        effectState: "identified",
        stripeRefundStatus: "succeeded",
      }),
    ).toBe(true);
    expect(
      canReleasePaymentGuard({
        workflowStatus: "stale",
        effectState: "not_started",
        stripeRefundStatus: null,
      }),
    ).toBe(false);
    expect(transitionEffectState("possible", "absence_proven")).toBe("absence_proven");
    expect(() => transitionEffectState("identified", "absence_proven")).toThrow(DomainError);
    expect(() =>
      transitionEffectState("identified", "absence_proven", {
        authoritativeStripeRefundStatus: "failed",
        linkedStripeRefundId: "re_linked",
        observedStripeRefundId: "re_different",
      }),
    ).toThrow(DomainError);
    expect(
      transitionEffectState("identified", "absence_proven", {
        authoritativeStripeRefundStatus: "failed",
        linkedStripeRefundId: "re_linked",
        observedStripeRefundId: "re_linked",
      }),
    ).toBe("absence_proven");
  });
});

describe("proofs and encryption", () => {
  const payload = {
    tenantId: "5c66ba36-d4c2-444e-9186-582c8e6b0671",
    stripeAccountId: "acct_123",
    requestId: "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
    paymentKey: "pi_123",
    amountMinor: 500n,
    currency: "eur",
    environment: "sandbox",
  } as const;

  it("signs deterministic, versioned metadata and verifies old keys only", () => {
    const oldKey = randomBytes(32);
    const currentKey = randomBytes(32);
    const oldRing = new RefundProofKeyring({
      active: { version: "v1", key: oldKey },
    });
    const rotated = new RefundProofKeyring({
      active: { version: "v2", key: currentKey },
      verificationOnly: { v1: oldKey },
    });
    const oldProof = oldRing.sign(payload);

    expect(rotated.verify(payload, oldProof)).toBe(true);
    expect(rotated.sign(payload).startsWith("v2.")).toBe(true);
    expect(rotated.verify({ ...payload, amountMinor: 501n }, oldProof)).toBe(false);
  });

  it("classifies copied proof metadata as replay after the first ID is linked", () => {
    expect(
      classifyRefundEvidence({
        candidateRefundId: "re_second",
        metadataRequestId: payload.requestId,
        metadataProof: "v1.example",
        expectedRequestId: payload.requestId,
        proofValid: true,
        linkedRefundId: "re_first",
      }),
    ).toBe("proof_replay");
  });

  it("authenticates encrypted fields against tenant and field type", () => {
    const keyring = new FieldEncryptionKeyring({
      active: { version: "v1", key: randomBytes(32) },
    });
    const context = {
      tenantId: payload.tenantId,
      table: "refund_requests",
      entityId: payload.requestId,
      field: "justification",
    };
    const encrypted = keyring.encrypt("Customer asked for a duplicate refund.", context);

    expect(keyring.decrypt(encrypted, context)).toBe("Customer asked for a duplicate refund.");
    expect(() =>
      keyring.decrypt(encrypted, { ...context, entityId: "different-entity" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENCRYPTION_KEY" }));
  });

  it("builds the exact deterministic Stripe idempotency key", () => {
    expect(refundIdempotencyKey(payload.requestId)).toBe(
      "refunddesk:refund-request:ca3872bc-01b8-4df3-b649-e81a22c31c5e:v1",
    );
    expect(() => refundIdempotencyKey("not-a-uuid")).toThrow(DomainError);
  });
});

describe("failure classification", () => {
  it("treats post-boundary timeouts as ambiguous and validation failures as terminal", () => {
    expect(classifyRefundFailure({ kind: "timeout", effectBoundaryCrossed: true })).toEqual({
      classification: "ambiguous",
      retryWithSameIdempotencyKey: true,
    });
    expect(classifyRefundFailure({ kind: "invalid_request", effectBoundaryCrossed: true })).toEqual(
      { classification: "terminal", retryWithSameIdempotencyKey: false },
    );
    expect(classifyRefundFailure({ kind: "idempotency", effectBoundaryCrossed: true })).toEqual({
      classification: "ambiguous",
      retryWithSameIdempotencyKey: true,
    });
  });
});

describe("pilot access policy", () => {
  const policy = new PilotAccessPolicy();
  const base = {
    action: "create_refund_request",
    environment: "sandbox",
    tenantStatus: "active",
    installationStatus: "active",
    globalLiveEnabled: false,
    tenantLiveEnabled: false,
    signedStripeRoles: [],
    explicitApprover: false,
  } as const;

  it("fails closed for live and inactive installations", () => {
    expect(
      policy.authorize({
        ...base,
        environment: "live",
        globalLiveEnabled: true,
        tenantLiveEnabled: true,
      }),
    ).toEqual({ allowed: false, code: "PILOT_LIVE_DISABLED" });
    expect(policy.authorize({ ...base, installationStatus: "suspended" })).toEqual({
      allowed: false,
      code: "INSTALLATION_INACTIVE",
    });
  });

  it("requires a signed Administrator and an explicitly enabled approver", () => {
    expect(policy.authorize({ ...base, action: "settings" })).toEqual({
      allowed: false,
      code: "ADMIN_REQUIRED",
    });
    expect(
      policy.authorize({
        ...base,
        action: "settings",
        signedStripeRoles: [{ name: "Administrator", type: "builtIn" }],
      }),
    ).toEqual({ allowed: true });
    expect(
      policy.authorize({
        ...base,
        action: "settings",
        signedStripeRoles: [{ name: "Administrator", type: "custom" }],
      }),
    ).toEqual({ allowed: false, code: "ADMIN_REQUIRED" });
    expect(policy.authorize({ ...base, action: "decide_refund_request" })).toEqual({
      allowed: false,
      code: "EXPLICIT_APPROVER_REQUIRED",
    });
  });
});
