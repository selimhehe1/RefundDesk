import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@refunddesk/db";
import {
  ApprovalAttestationKeyring,
  type ApprovalAttestationPayload,
  type RefundProofKeyring,
} from "@refunddesk/domain";

import { approvalAuthorizationSnapshotHash, PrismaWorkerStore } from "../src/db-store.js";

const tenantId = "5c66ba36-d4c2-444e-9186-582c8e6b0671";
const installationId = "0f12622c-eb99-49b5-9940-d194098446af";
const requestId = "ca3872bc-01b8-4df3-b649-e81a22c31c5e";
const executionId = "a5cc7f0b-e61d-4fd9-81a4-d14c469e46a3";
const requesterUserId = "8c80aa09-dfc7-42e1-824c-b4c2585054cf";
const approverUserId = "48257283-e1c7-46f4-88aa-f9d621ae93df";
const attestationId = "0dddf88a-4d04-4ae0-a0ce-4a3056d8bf4b";
const attestationKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const scanWindowEnd = new Date("2030-01-01T12:00:00.000Z");
const observedAt = new Date("2030-01-01T12:00:01.000Z");

function approvalAttestationKeyring(): ApprovalAttestationKeyring {
  return new ApprovalAttestationKeyring({
    active: { version: "v1", key: attestationKey },
  });
}

function storeForTransaction(transaction: Readonly<Record<string, unknown>>): PrismaWorkerStore {
  const client = {
    $transaction: vi.fn((operation: (tx: Readonly<Record<string, unknown>>) => Promise<unknown>) =>
      operation(transaction),
    ),
  } as unknown as PrismaClient;
  return new PrismaWorkerStore(client, {} as RefundProofKeyring, approvalAttestationKeyring());
}

function linkedWorkItem() {
  const requester = {
    id: requesterUserId,
    tenantId,
    stripeUserId: "usr_Requester",
    approverEnabled: false,
  };
  const approver = {
    id: approverUserId,
    tenantId,
    stripeUserId: "usr_Approver",
    approverEnabled: true,
  };
  const signedEnvelopeHash = createHash("sha256")
    .update("linked-refund-approval-envelope")
    .digest();
  const verifiedAt = new Date("2030-01-01T10:45:00.000Z");
  const consumeBefore = new Date("2030-01-01T10:50:00.000Z");
  const expiresAt = new Date("2030-01-08T00:00:00.000Z");
  const payload: ApprovalAttestationPayload = {
    canonicalRequestHash: signedEnvelopeHash,
    requestNonce: "2db72dc2-4816-4f95-aa23-57357727e113",
    tenantId,
    installationId,
    stripeAccountId: "acct_linked",
    environment: "test",
    resourceType: "payment_intent",
    resourceId: "pi_linked",
    requestId,
    requestVersion: 0,
    approverUserId,
    requesterUserId,
    approverStripeUserId: approver.stripeUserId,
    requesterStripeUserId: requester.stripeUserId,
    paymentKey: "pi_linked",
    paymentIntentId: "pi_linked",
    chargeId: "ch_linked",
    amountMinor: 500n,
    currency: "eur",
    reason: "requested_by_customer",
    policyVersion: 1,
    requiredApprovals: 1,
    expiresAt: expiresAt.toISOString(),
    verifiedAt: verifiedAt.toISOString(),
    consumeBefore: consumeBefore.toISOString(),
  };
  const [hmacKeyVersion, encodedHmac] = approvalAttestationKeyring().sign(payload).split(".");
  if (hmacKeyVersion === undefined || encodedHmac === undefined) {
    throw new TypeError("Expected a versioned approval attestation");
  }
  const approvalAttestation = {
    id: attestationId,
    tenantId,
    installationId,
    requestId,
    approverUserId,
    requestNonce: payload.requestNonce,
    stripeAccountId: payload.stripeAccountId,
    environment: payload.environment,
    resourceType: payload.resourceType,
    resourceId: payload.resourceId,
    requestVersion: payload.requestVersion,
    signedEnvelopeHash,
    authorizationSnapshotHash: approvalAuthorizationSnapshotHash(payload),
    verifiedAt,
    consumeBefore,
    hmacKeyVersion,
    hmac: Buffer.from(encodedHmac, "base64url"),
  };
  return {
    id: requestId,
    tenantId,
    installationId,
    requesterUserId,
    policyVersion: 1,
    requiredApprovals: 1,
    version: 4,
    createdAt: new Date("2029-12-31T00:00:00.000Z"),
    expiresAt,
    workflowStatus: "succeeded",
    effectState: "identified",
    paymentGuardReleasedAt: new Date("2030-01-01T11:00:00.000Z"),
    environment: "test",
    paymentKey: "pi_linked",
    paymentIntentId: "pi_linked",
    chargeId: "ch_linked",
    amountMinor: 500n,
    currency: "eur",
    reason: "requested_by_customer",
    requester,
    approvalDecision: {
      id: "e3258f8a-4d33-4f37-b377-8cfbf87ff240",
      tenantId,
      requestId,
      approverUserId,
      approvalAttestationId: attestationId,
      decision: "approve",
      decidedAt: new Date("2030-01-01T10:46:00.000Z"),
      approver,
      approvalAttestation,
    },
    execution: {
      id: executionId,
      requestId,
      tenantId,
      idempotencyKey: `refunddesk:refund-request:${requestId}:v1`,
      canonicalParametersHash: Uint8Array.from({ length: 32 }, () => 1),
      stripeRefundId: "re_linked",
      stripeRefundStatus: "succeeded",
      amountMinor: 500n,
      currency: "eur",
      lastStripeEventCreatedAt: new Date("2030-01-01T11:00:00.000Z"),
    },
    tenant: {
      status: "active",
      liveEnabled: false,
    },
    installation: {
      status: "active",
      environment: "test",
      stripeAccountId: "acct_linked",
    },
  };
}

function executionWorkItemRelations(
  item: Pick<
    ReturnType<typeof linkedWorkItem>,
    | "id"
    | "tenantId"
    | "installationId"
    | "tenant"
    | "installation"
    | "execution"
    | "requester"
    | "approvalDecision"
  >,
) {
  return {
    tenant: {
      findFirst: vi.fn().mockResolvedValue({
        ...item.tenant,
        id: item.tenantId,
      }),
    },
    stripeInstallation: {
      findFirst: vi.fn().mockResolvedValue({
        ...item.installation,
        id: item.installationId,
        tenantId: item.tenantId,
      }),
    },
    refundExecution: {
      findFirst: vi.fn().mockResolvedValue({
        ...item.execution,
        requestId: item.id,
        tenantId: item.tenantId,
      }),
    },
    refundExecutionAttempt: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    tenantUser: {
      findFirst: vi.fn((input: { readonly where: { readonly id?: string } }) => {
        if (input.where.id === item.requester.id) {
          return Promise.resolve(item.requester);
        }
        if (input.where.id === item.approvalDecision.approver.id) {
          return Promise.resolve(item.approvalDecision.approver);
        }
        return Promise.resolve(null);
      }),
    },
    approvalDecision: {
      findFirst: vi.fn().mockResolvedValue(item.approvalDecision),
    },
    approvalAttestation: {
      findFirst: vi.fn().mockResolvedValue(item.approvalDecision.approvalAttestation),
    },
  };
}

describe("linked Refund reconciliation store", () => {
  it("lists only the durable linked targets through the tenant repository", async () => {
    const refundRequestFindMany = vi.fn().mockResolvedValue([
      {
        id: requestId,
        execution: { stripeRefundId: "re_linked" },
      },
    ]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ set_config: tenantId }]),
      stripeInstallation: {
        findFirst: vi.fn().mockResolvedValue({
          id: installationId,
          status: "active",
          environment: "test",
          tenant: { status: "active", liveEnabled: false },
        }),
      },
      refundRequest: { findMany: refundRequestFindMany },
    };
    const store = storeForTransaction(tx);

    await expect(
      store.listLinkedRefundReconciliationTargets(tenantId, installationId, null, 100),
    ).resolves.toEqual([{ requestId, refundId: "re_linked" }]);
    expect(refundRequestFindMany).toHaveBeenCalledWith({
      where: {
        tenantId,
        installationId,
        environment: { in: ["test", "sandbox"] },
        workflowStatus: { in: ["executing", "reconciliation_required", "succeeded"] },
        execution: {
          is: {
            stripeRefundId: { not: null },
            OR: [
              { stripeRefundStatus: null },
              { stripeRefundStatus: { in: ["pending", "requires_action", "succeeded"] } },
            ],
          },
        },
      },
      select: {
        id: true,
        execution: { select: { stripeRefundId: true } },
      },
      take: 100,
      orderBy: { id: "asc" },
    });
  });

  it("applies a direct failed snapshot to the same immutable Refund without replacing Event time", async () => {
    const item = linkedWorkItem();
    const refundExecutionUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const refundRequestUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreate = vi.fn((input: unknown) => {
      void input;
      return Promise.resolve({ id: "audit-linked-refresh" });
    });
    const relations = executionWorkItemRelations(item);
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ set_config: tenantId }])
        .mockResolvedValueOnce([{ id: installationId }])
        .mockResolvedValueOnce([{ id: tenantId }])
        .mockResolvedValueOnce([{ id: requestId }])
        .mockResolvedValueOnce([
          {
            id: requestId,
            workflow_status: "succeeded",
            effect_state: "identified",
            execution_id: executionId,
            stripe_refund_id: "re_linked",
            stripe_refund_status: "succeeded",
            last_stripe_event_created_at: item.execution.lastStripeEventCreatedAt,
          },
        ]),
      refundRequest: {
        findFirst: vi.fn().mockResolvedValue(item),
        updateMany: refundRequestUpdate,
      },
      tenant: relations.tenant,
      stripeInstallation: relations.stripeInstallation,
      tenantUser: relations.tenantUser,
      approvalDecision: relations.approvalDecision,
      approvalAttestation: relations.approvalAttestation,
      refundExecutionAttempt: relations.refundExecutionAttempt,
      refundExecution: {
        ...relations.refundExecution,
        updateMany: refundExecutionUpdate,
      },
      auditEvent: { create: auditCreate },
    };
    const store = storeForTransaction(tx);

    await expect(
      store.observeLinkedRefund({
        tenantId,
        installationId,
        environment: "test",
        requestId,
        expectedRefundId: "re_linked",
        refund: {
          refundId: "re_linked",
          paymentIntentId: "pi_linked",
          chargeId: "ch_linked",
          amountMinor: 500n,
          currency: "eur",
          status: "failed",
          created: 1_893_499_200,
          metadataRequestId: null,
          metadataProof: null,
        },
        scanWindowEnd,
        observedAt,
      }),
    ).resolves.toBeUndefined();

    expect(refundExecutionUpdate).toHaveBeenCalledWith({
      where: {
        id: executionId,
        tenantId,
        requestId,
        stripeRefundId: "re_linked",
        stripeRefundStatus: "succeeded",
        lastStripeEventCreatedAt: item.execution.lastStripeEventCreatedAt,
      },
      data: {
        stripeRefundId: "re_linked",
        stripeRefundStatus: "failed",
        reconciledAt: observedAt,
      },
    });
    expect(refundRequestUpdate).toHaveBeenCalledWith({
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
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({
      data: {
        tenantId,
        actorType: "worker",
        action: "refund.linked_status_refreshed",
        entityId: "re_linked",
        payload: {
          source: "linked_scan",
          scan_window_end: scanWindowEnd.toISOString(),
          stripe_refund_status: "failed",
        },
        occurredAt: observedAt,
      },
    });
  });

  it.each(["executing", "reconciliation_required"] as const)(
    "resolves %s when the directly retrieved linked Refund succeeded",
    async (workflowStatus) => {
      const baseline = linkedWorkItem();
      const item = {
        ...baseline,
        workflowStatus,
        effectState: "identified",
        paymentGuardReleasedAt: null,
        execution: {
          ...baseline.execution,
          stripeRefundStatus: "pending",
        },
      };
      const refundExecutionUpdate = vi.fn().mockResolvedValue({ count: 1 });
      const refundRequestUpdate = vi.fn().mockResolvedValue({ count: 1 });
      const relations = executionWorkItemRelations(item);
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ set_config: tenantId }])
          .mockResolvedValueOnce([{ id: installationId }])
          .mockResolvedValueOnce([{ id: tenantId }])
          .mockResolvedValueOnce([{ id: requestId }])
          .mockResolvedValueOnce([
            {
              id: requestId,
              workflow_status: workflowStatus,
              effect_state: "identified",
              execution_id: executionId,
              stripe_refund_id: "re_linked",
              stripe_refund_status: "pending",
              last_stripe_event_created_at: item.execution.lastStripeEventCreatedAt,
            },
          ]),
        refundRequest: {
          findFirst: vi.fn().mockResolvedValue(item),
          updateMany: refundRequestUpdate,
        },
        tenant: relations.tenant,
        stripeInstallation: relations.stripeInstallation,
        tenantUser: relations.tenantUser,
        approvalDecision: relations.approvalDecision,
        approvalAttestation: relations.approvalAttestation,
        refundExecutionAttempt: relations.refundExecutionAttempt,
        refundExecution: {
          ...relations.refundExecution,
          updateMany: refundExecutionUpdate,
        },
        auditEvent: { create: vi.fn().mockResolvedValue({ id: "audit-linked-success" }) },
      };
      const store = storeForTransaction(tx);

      await expect(
        store.observeLinkedRefund({
          tenantId,
          installationId,
          environment: "test",
          requestId,
          expectedRefundId: "re_linked",
          refund: {
            refundId: "re_linked",
            paymentIntentId: "pi_linked",
            chargeId: "ch_linked",
            amountMinor: 500n,
            currency: "eur",
            status: "succeeded",
            created: 1_893_499_200,
            metadataRequestId: null,
            metadataProof: null,
          },
          scanWindowEnd,
          observedAt,
        }),
      ).resolves.toBeUndefined();

      expect(refundExecutionUpdate).toHaveBeenCalledWith({
        where: {
          id: executionId,
          tenantId,
          requestId,
          stripeRefundId: "re_linked",
          stripeRefundStatus: "pending",
          lastStripeEventCreatedAt: item.execution.lastStripeEventCreatedAt,
        },
        data: {
          stripeRefundId: "re_linked",
          stripeRefundStatus: "succeeded",
          reconciledAt: observedAt,
        },
      });
      expect(refundRequestUpdate).toHaveBeenCalledWith({
        where: {
          id: requestId,
          tenantId,
          workflowStatus: { in: ["executing", "reconciliation_required"] },
          effectState: { in: ["possible", "identified"] },
        },
        data: {
          effectState: "identified",
          workflowStatus: "succeeded",
          terminalAt: observedAt,
          paymentGuardReleasedAt: observedAt,
          version: { increment: 1 },
        },
      });
    },
  );

  it.each([
    ["executing", "failed"],
    ["executing", "canceled"],
    ["reconciliation_required", "failed"],
    ["reconciliation_required", "canceled"],
  ] as const)(
    "resolves %s to terminal failure when the same directly retrieved Refund is %s",
    async (workflowStatus, terminalStatus) => {
      const baseline = linkedWorkItem();
      const item = {
        ...baseline,
        workflowStatus,
        effectState: "identified",
        paymentGuardReleasedAt: null,
        execution: {
          ...baseline.execution,
          stripeRefundStatus: "pending",
        },
      };
      const refundExecutionUpdate = vi.fn().mockResolvedValue({ count: 1 });
      const refundRequestUpdate = vi.fn().mockResolvedValue({ count: 1 });
      const relations = executionWorkItemRelations(item);
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ set_config: tenantId }])
          .mockResolvedValueOnce([{ id: installationId }])
          .mockResolvedValueOnce([{ id: tenantId }])
          .mockResolvedValueOnce([{ id: requestId }])
          .mockResolvedValueOnce([
            {
              id: requestId,
              workflow_status: workflowStatus,
              effect_state: "identified",
              execution_id: executionId,
              stripe_refund_id: "re_linked",
              stripe_refund_status: "pending",
              last_stripe_event_created_at: item.execution.lastStripeEventCreatedAt,
            },
          ]),
        refundRequest: {
          findFirst: vi.fn().mockResolvedValue(item),
          updateMany: refundRequestUpdate,
        },
        tenant: relations.tenant,
        stripeInstallation: relations.stripeInstallation,
        tenantUser: relations.tenantUser,
        approvalDecision: relations.approvalDecision,
        approvalAttestation: relations.approvalAttestation,
        refundExecutionAttempt: relations.refundExecutionAttempt,
        refundExecution: {
          ...relations.refundExecution,
          updateMany: refundExecutionUpdate,
        },
        auditEvent: { create: vi.fn().mockResolvedValue({ id: "audit-linked-failure" }) },
      };
      const store = storeForTransaction(tx);

      await expect(
        store.observeLinkedRefund({
          tenantId,
          installationId,
          environment: "test",
          requestId,
          expectedRefundId: "re_linked",
          refund: {
            refundId: "re_linked",
            paymentIntentId: "pi_linked",
            chargeId: "ch_linked",
            amountMinor: 500n,
            currency: "eur",
            status: terminalStatus,
            created: 1_893_499_200,
            metadataRequestId: null,
            metadataProof: null,
          },
          scanWindowEnd,
          observedAt,
        }),
      ).resolves.toBeUndefined();

      expect(refundExecutionUpdate).toHaveBeenCalledWith({
        where: {
          id: executionId,
          tenantId,
          requestId,
          stripeRefundId: "re_linked",
          stripeRefundStatus: "pending",
          lastStripeEventCreatedAt: item.execution.lastStripeEventCreatedAt,
        },
        data: {
          stripeRefundId: "re_linked",
          stripeRefundStatus: terminalStatus,
          reconciledAt: observedAt,
        },
      });
      expect(refundRequestUpdate).toHaveBeenCalledWith({
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
    },
  );

  it("keeps reconciliation and its guard for a nonterminal linked Refund snapshot", async () => {
    const baseline = linkedWorkItem();
    const item = {
      ...baseline,
      workflowStatus: "reconciliation_required",
      effectState: "identified",
      paymentGuardReleasedAt: null,
      execution: {
        ...baseline.execution,
        stripeRefundStatus: "pending",
      },
    };
    const refundRequestUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const relations = executionWorkItemRelations(item);
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ set_config: tenantId }])
        .mockResolvedValueOnce([{ id: installationId }])
        .mockResolvedValueOnce([{ id: tenantId }])
        .mockResolvedValueOnce([{ id: requestId }])
        .mockResolvedValueOnce([
          {
            id: requestId,
            workflow_status: "reconciliation_required",
            effect_state: "identified",
            execution_id: executionId,
            stripe_refund_id: "re_linked",
            stripe_refund_status: "pending",
            last_stripe_event_created_at: item.execution.lastStripeEventCreatedAt,
          },
        ]),
      refundRequest: {
        findFirst: vi.fn().mockResolvedValue(item),
        updateMany: refundRequestUpdate,
      },
      tenant: relations.tenant,
      stripeInstallation: relations.stripeInstallation,
      tenantUser: relations.tenantUser,
      approvalDecision: relations.approvalDecision,
      approvalAttestation: relations.approvalAttestation,
      refundExecutionAttempt: relations.refundExecutionAttempt,
      refundExecution: {
        ...relations.refundExecution,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({ id: "audit-linked-pending" }) },
    };
    const store = storeForTransaction(tx);

    await expect(
      store.observeLinkedRefund({
        tenantId,
        installationId,
        environment: "test",
        requestId,
        expectedRefundId: "re_linked",
        refund: {
          refundId: "re_linked",
          paymentIntentId: "pi_linked",
          chargeId: "ch_linked",
          amountMinor: 500n,
          currency: "eur",
          status: "requires_action",
          created: 1_893_499_200,
          metadataRequestId: null,
          metadataProof: null,
        },
        scanWindowEnd,
        observedAt,
      }),
    ).resolves.toBeUndefined();

    expect(refundRequestUpdate).toHaveBeenCalledWith({
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

  it("rejects a tuple mismatch before mutating the linked Refund state", async () => {
    const item = linkedWorkItem();
    const refundExecutionUpdate = vi.fn();
    const relations = executionWorkItemRelations(item);
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ set_config: tenantId }])
        .mockResolvedValueOnce([{ id: installationId }])
        .mockResolvedValueOnce([{ id: tenantId }])
        .mockResolvedValueOnce([{ id: requestId }]),
      refundRequest: {
        findFirst: vi.fn().mockResolvedValue(item),
      },
      tenant: relations.tenant,
      stripeInstallation: relations.stripeInstallation,
      tenantUser: relations.tenantUser,
      approvalDecision: relations.approvalDecision,
      approvalAttestation: relations.approvalAttestation,
      refundExecutionAttempt: relations.refundExecutionAttempt,
      refundExecution: {
        ...relations.refundExecution,
        updateMany: refundExecutionUpdate,
      },
    };
    const store = storeForTransaction(tx);

    await expect(
      store.observeLinkedRefund({
        tenantId,
        installationId,
        environment: "test",
        requestId,
        expectedRefundId: "re_linked",
        refund: {
          refundId: "re_linked",
          paymentIntentId: "pi_linked",
          chargeId: "ch_linked",
          amountMinor: 501n,
          currency: "eur",
          status: "failed",
          created: 1_893_499_200,
          metadataRequestId: null,
          metadataProof: null,
        },
        scanWindowEnd,
        observedAt,
      }),
    ).rejects.toThrow("LINKED_REFUND_RECONCILIATION_TUPLE_MISMATCH");
    expect(refundExecutionUpdate).not.toHaveBeenCalled();
  });
});
