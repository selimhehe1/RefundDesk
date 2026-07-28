import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ApprovalAttestationKeyring,
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

  it("corrects the same succeeded Refund when Stripe later cancels it", () => {
    const corrected = correctLinkedRefundTerminalStatus({
      workflow: pendingWorkflow({
        status: "succeeded",
        effectState: "identified",
        stripeRefundId: "re_linked",
        stripeRefundStatus: "succeeded",
      }),
      observedStripeRefundId: "re_linked",
      authoritativeStripeRefundStatus: "canceled",
    });

    expect(corrected).toMatchObject({
      status: "failed_terminal",
      effectState: "absence_proven",
      stripeRefundId: "re_linked",
      stripeRefundStatus: "canceled",
    });
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

describe("approval attestations", () => {
  const approvalPayload = {
    canonicalRequestHash: randomBytes(32),
    requestNonce: "2db72dc2-4816-4f95-aa23-57357727e113",
    tenantId: "5c66ba36-d4c2-444e-9186-582c8e6b0671",
    installationId: "0f12622c-eb99-49b5-9940-d194098446af",
    stripeAccountId: "acct_123",
    environment: "sandbox",
    resourceType: "payment_intent",
    resourceId: "pi_123",
    requestId: "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
    requestVersion: 3,
    approverUserId: "48257283-e1c7-46f4-88aa-f9d621ae93df",
    requesterUserId: "8c80aa09-dfc7-42e1-824c-b4c2585054cf",
    approverStripeUserId: "usr_Approver",
    requesterStripeUserId: "usr_Requester",
    paymentKey: "pi_123",
    paymentIntentId: "pi_123",
    chargeId: "ch_123",
    amountMinor: 500n,
    currency: "eur",
    reason: "requested_by_customer",
    policyVersion: 2,
    requiredApprovals: 1,
    expiresAt: "2030-01-08T00:00:00.000Z",
    verifiedAt: "2030-01-01T00:00:00.000Z",
    consumeBefore: "2030-01-01T00:05:00.000Z",
  } as const;

  it("signs a domain-separated versioned token and verifies rotation keys", () => {
    const oldKey = randomBytes(32);
    const currentKey = randomBytes(32);
    const oldRing = new ApprovalAttestationKeyring({
      active: { version: "v1", key: oldKey },
    });
    const rotated = new ApprovalAttestationKeyring({
      active: { version: "v2", key: currentKey },
      verificationOnly: { v1: oldKey },
    });
    const oldToken = oldRing.sign(approvalPayload);
    const currentToken = rotated.sign(approvalPayload);

    expect(oldToken).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(currentToken).toMatch(/^v2\.[A-Za-z0-9_-]{43}$/u);
    expect(rotated.verify(approvalPayload, oldToken)).toBe(true);
    expect(rotated.verify(approvalPayload, currentToken)).toBe(true);
    expect(oldRing.verify(approvalPayload, currentToken)).toBe(false);
  });

  it("rejects token falsification without accepting a non-canonical encoding", () => {
    const ring = new ApprovalAttestationKeyring({
      active: { version: "v1", key: randomBytes(32) },
    });
    const token = ring.sign(approvalPayload);
    const [version, encoded] = token.split(".");
    if (version === undefined || encoded === undefined) {
      throw new TypeError("Expected a versioned approval attestation");
    }
    const falsifiedDigest = Buffer.from(encoded, "base64url");
    falsifiedDigest[0] = (falsifiedDigest[0] ?? 0) ^ 1;
    const falsifiedToken = `${version}.${falsifiedDigest.toString("base64url")}`;
    const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalCharacter = encoded.at(-1);
    const finalIndex =
      finalCharacter === undefined ? -1 : base64UrlAlphabet.indexOf(finalCharacter);
    if (finalIndex < 0 || finalIndex >= base64UrlAlphabet.length - 1) {
      throw new TypeError("Expected a canonical base64url digest");
    }
    const nonCanonicalToken = `${version}.${encoded.slice(0, -1)}${base64UrlAlphabet.charAt(finalIndex + 1)}`;

    expect(ring.verify(approvalPayload, falsifiedToken)).toBe(false);
    expect(ring.verify(approvalPayload, nonCanonicalToken)).toBe(false);
    expect(ring.verify(approvalPayload, `${token}=`)).toBe(false);
    expect(ring.verify(approvalPayload, `v999.${encoded}`)).toBe(false);
  });

  it("binds replay attempts to the original nonce, request, identity, and financial snapshot", () => {
    const ring = new ApprovalAttestationKeyring({
      active: { version: "v1", key: randomBytes(32) },
    });
    const token = ring.sign(approvalPayload);
    const changedHash = Uint8Array.from(approvalPayload.canonicalRequestHash);
    changedHash[0] = (changedHash[0] ?? 0) ^ 1;

    expect(
      ring.verify(
        { ...approvalPayload, requestNonce: "6c397ed9-600c-405b-802a-79f633825677" },
        token,
      ),
    ).toBe(false);
    expect(
      ring.verify({ ...approvalPayload, requestId: "b2e0e761-2eb0-4d91-9a45-d4f687051de2" }, token),
    ).toBe(false);
    expect(ring.verify({ ...approvalPayload, requestVersion: 4 }, token)).toBe(false);
    expect(
      ring.verify({ ...approvalPayload, approverStripeUserId: "usr_OtherApprover" }, token),
    ).toBe(false);
    expect(
      ring.verify({ ...approvalPayload, requesterStripeUserId: "usr_OtherRequester" }, token),
    ).toBe(false);
    expect(
      ring.verify(
        {
          ...approvalPayload,
          requesterUserId: "44a0a31d-b277-41de-ad66-155af882d44e",
        },
        token,
      ),
    ).toBe(false);
    expect(ring.verify({ ...approvalPayload, amountMinor: 501n }, token)).toBe(false);
    expect(ring.verify({ ...approvalPayload, reason: "duplicate" }, token)).toBe(false);
    expect(ring.verify({ ...approvalPayload, policyVersion: 3 }, token)).toBe(false);
    expect(
      ring.verify({ ...approvalPayload, consumeBefore: "2030-01-01T00:04:59.000Z" }, token),
    ).toBe(false);
    expect(ring.verify({ ...approvalPayload, canonicalRequestHash: changedHash }, token)).toBe(
      false,
    );
  });

  it("binds account, environment, and payment resource against cross-context replay", () => {
    const ring = new ApprovalAttestationKeyring({
      active: { version: "v1", key: randomBytes(32) },
    });
    const token = ring.sign(approvalPayload);

    expect(ring.verify({ ...approvalPayload, stripeAccountId: "acct_456" }, token)).toBe(false);
    expect(
      ring.verify(
        {
          ...approvalPayload,
          installationId: "0c1d9824-865a-4320-a0fb-d43cff076fff",
        },
        token,
      ),
    ).toBe(false);
    expect(ring.verify({ ...approvalPayload, environment: "test" }, token)).toBe(false);
    expect(
      ring.verify(
        {
          ...approvalPayload,
          resourceType: "charge",
          resourceId: "ch_123",
        },
        token,
      ),
    ).toBe(false);
  });

  it("fails closed on invalid keys and non-canonical or live payloads", () => {
    expect(
      () =>
        new ApprovalAttestationKeyring({
          active: { version: "1", key: randomBytes(32) },
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_APPROVAL_ATTESTATION" }));
    expect(
      () =>
        new ApprovalAttestationKeyring({
          active: { version: "v1", key: randomBytes(31) },
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_APPROVAL_ATTESTATION" }));

    const ring = new ApprovalAttestationKeyring({
      active: { version: "v1", key: randomBytes(32) },
    });
    expect(() =>
      ring.sign({ ...approvalPayload, canonicalRequestHash: randomBytes(31) }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_APPROVAL_ATTESTATION" }));
    expect(() => ring.sign({ ...approvalPayload, currency: "EUR" })).toThrow(
      "currency must be canonical lowercase",
    );
    expect(() =>
      ring.sign({
        ...approvalPayload,
        environment: "live" as "sandbox",
      }),
    ).toThrow("limited to test and sandbox");
    expect(() =>
      ring.sign({
        ...approvalPayload,
        requesterStripeUserId: approvalPayload.approverStripeUserId,
      }),
    ).toThrow("distinct from the requester");
    expect(() => ring.sign({ ...approvalPayload, requestVersion: -1 })).toThrow(
      "request version must be a non-negative integer",
    );
    expect(() =>
      ring.sign({
        ...approvalPayload,
        consumeBefore: "2030-01-09T00:00:00.000Z",
      }),
    ).toThrow("time window is inconsistent");
    expect(() =>
      ring.sign({
        ...approvalPayload,
        consumeBefore: approvalPayload.verifiedAt,
      }),
    ).toThrow("time window is inconsistent");
    expect(() => ring.sign({ ...approvalPayload, paymentKey: "ch_123" })).toThrow(
      "payment key is inconsistent",
    );
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
        signedStripeRoles: [{ id: "super_admin", type: "builtIn", name: "Super Administrator" }],
      }),
    ).toEqual({ allowed: true });
    expect(
      policy.authorize({
        ...base,
        action: "settings",
        signedStripeRoles: [{ name: "Administrator", type: "custom" }],
      }),
    ).toEqual({ allowed: false, code: "ADMIN_REQUIRED" });
    expect(
      policy.authorize({
        ...base,
        action: "settings",
        signedStripeRoles: [{ id: "view_only", type: "builtIn", name: "Super Administrator" }],
      }),
    ).toEqual({ allowed: false, code: "ADMIN_REQUIRED" });
    expect(policy.authorize({ ...base, action: "decide_refund_request" })).toEqual({
      allowed: false,
      code: "EXPLICIT_APPROVER_REQUIRED",
    });
  });
});
