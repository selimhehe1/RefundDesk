import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@refunddesk/db";
import {
  ApprovalAttestationKeyring,
  refundIdempotencyKey,
  type ApprovalAttestationPayload,
  type RefundProofKeyring,
} from "@refunddesk/domain";

import {
  approvalAttestationRequestVersionIsCompatible,
  approvalAuthorizationSnapshotHash,
  PrismaWorkerStore,
} from "../src/db-store.js";

const tenantId = "5c66ba36-d4c2-444e-9186-582c8e6b0671";
const installationId = "0f12622c-eb99-49b5-9940-d194098446af";
const requestId = "ca3872bc-01b8-4df3-b649-e81a22c31c5e";
const requesterUserId = "8c80aa09-dfc7-42e1-824c-b4c2585054cf";
const approverUserId = "48257283-e1c7-46f4-88aa-f9d621ae93df";
const attestationId = "0dddf88a-4d04-4ae0-a0ce-4a3056d8bf4b";
const attestationKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function approvalAttestationKeyring(): ApprovalAttestationKeyring {
  return new ApprovalAttestationKeyring({
    active: { version: "v1", key: attestationKey },
  });
}

function executionWorkItem(
  options: { readonly attestation?: "missing" | "tampered" | "valid" } = {},
) {
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
  const signedEnvelopeHash = createHash("sha256").update("signed-approval-envelope").digest();
  const verifiedAt = new Date("2030-01-01T11:50:00.000Z");
  const consumeBefore = new Date("2030-01-01T11:55:00.000Z");
  const expiresAt = new Date("2030-01-08T00:00:00.000Z");
  const payload: ApprovalAttestationPayload = {
    canonicalRequestHash: signedEnvelopeHash,
    requestNonce: "2db72dc2-4816-4f95-aa23-57357727e113",
    tenantId,
    installationId,
    stripeAccountId: "acct_boundary",
    environment: "test",
    resourceType: "payment_intent",
    resourceId: "pi_boundary",
    requestId,
    requestVersion: 0,
    approverUserId,
    requesterUserId,
    approverStripeUserId: approver.stripeUserId,
    requesterStripeUserId: requester.stripeUserId,
    paymentKey: "pi_boundary",
    paymentIntentId: "pi_boundary",
    chargeId: "ch_boundary",
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
  const validHmac = Buffer.from(encodedHmac, "base64url");
  const hmac =
    options.attestation === "tampered"
      ? Buffer.from(validHmac.map((byte, index) => (index === 0 ? byte ^ 1 : byte)))
      : validHmac;
  const approvalAttestation =
    options.attestation === "missing"
      ? null
      : {
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
          hmac,
        };
  return {
    id: requestId,
    tenantId,
    installationId,
    requesterUserId,
    policyVersion: 1,
    requiredApprovals: 1,
    version: 1,
    createdAt: new Date("2029-12-31T00:00:00.000Z"),
    expiresAt,
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
    requester,
    approvalDecision: {
      id: "e3258f8a-4d33-4f37-b377-8cfbf87ff240",
      tenantId,
      requestId,
      approverUserId,
      approvalAttestationId: approvalAttestation?.id ?? null,
      decision: "approve",
      decidedAt: new Date("2030-01-01T11:51:00.000Z"),
      approver,
      approvalAttestation,
    },
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

type VersionCompatibilityInput = Parameters<
  typeof approvalAttestationRequestVersionIsCompatible
>[0];

function versionCompatibilityItem(input: {
  readonly workflowStatus: VersionCompatibilityInput["workflowStatus"];
  readonly effectState: VersionCompatibilityInput["effectState"];
  readonly version: number;
  readonly attemptStates?: readonly (
    "started" | "completed" | "retryable_failure" | "terminal_failure" | "ambiguous_failure"
  )[];
  readonly linkedRefundId?: string | null;
}): VersionCompatibilityInput {
  const base = executionWorkItem();
  const executionId = "095b455e-360f-42a3-ac71-5c190d1057d5";
  const at = new Date("2030-01-01T12:00:00.000Z");
  return {
    ...base,
    workflowStatus: input.workflowStatus,
    effectState: input.effectState,
    version: input.version,
    execution:
      input.attemptStates === undefined
        ? null
        : {
            id: executionId,
            tenantId,
            requestId,
            idempotencyKey: refundIdempotencyKey(requestId),
            canonicalParametersHash: Buffer.alloc(32, 1),
            stripeRefundId: input.linkedRefundId ?? null,
            stripeRefundStatus: null,
            amountMinor: 500n,
            currency: "eur",
            lastStripeEventId: null,
            lastStripeEventCreatedAt: null,
            lastStripeRequestId: null,
            createdAt: at,
            reconciledAt: null,
            updatedAt: at,
            attempts: input.attemptStates.map((state, index) => ({
              id: `095b455e-360f-42a3-ac71-${String(index + 1).padStart(12, "0")}`,
              tenantId,
              executionId,
              attemptNumber: index + 1,
              state,
              normalizedErrorCode: state === "started" ? null : `ATTEMPT_${index + 1}`,
              stripeRequestId: null,
              startedAt: at,
              finishedAt: state === "started" ? null : at,
            })),
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
  readonly attempts?: VersionCompatibilityInput["execution"] extends infer Execution
    ? Execution extends { readonly attempts: infer Attempts }
      ? Attempts
      : never
    : never;
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
          version: state.item.version + 1,
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
          version: state.item.version + 1,
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
          version: state.item.version + 1,
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
  const installationFindFirst = vi.fn(() =>
    Promise.resolve({
      ...state.item.installation,
      id: state.item.installationId,
      tenantId: state.item.tenantId,
    }),
  );
  const installationFindMany = vi.fn(() =>
    Promise.resolve([
      {
        ...state.item.installation,
        id: state.item.installationId,
        tenantId: state.item.tenantId,
      },
    ]),
  );
  const executionFindFirst = vi.fn(() =>
    Promise.resolve(
      state.item.execution === null
        ? null
        : {
            ...state.item.execution,
            requestId: state.item.id,
            tenantId: state.item.tenantId,
          },
    ),
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
  const attemptFindMany = vi.fn(() => Promise.resolve(state.item.execution?.attempts ?? []));
  const tenantUserFindFirst = vi.fn((input: { readonly where: { readonly id?: string } }) => {
    if (input.where.id === state.item.requester.id) {
      return Promise.resolve(state.item.requester);
    }
    if (input.where.id === state.item.approvalDecision.approver.id) {
      return Promise.resolve(state.item.approvalDecision.approver);
    }
    return Promise.resolve(null);
  });
  const approvalDecisionFindFirst = vi.fn(() => Promise.resolve(state.item.approvalDecision));
  const approvalAttestationFindFirst = vi.fn(() =>
    Promise.resolve(state.item.approvalDecision.approvalAttestation),
  );
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    tenant: {
      findFirst: tenantFindFirst,
    },
    stripeInstallation: {
      findFirst: installationFindFirst,
      findMany: installationFindMany,
    },
    refundRequest: {
      findFirst: vi.fn(() => Promise.resolve(state.item)),
      findMany: requestFindMany,
      updateMany: requestUpdate,
    },
    refundExecution: {
      findFirst: executionFindFirst,
      findMany: executionFindMany,
      upsert: executionUpsert,
    },
    refundExecutionAttempt: {
      aggregate: attemptAggregate,
      create: attemptCreate,
      findMany: attemptFindMany,
    },
    tenantUser: {
      findFirst: tenantUserFindFirst,
    },
    approvalDecision: {
      findFirst: approvalDecisionFindFirst,
    },
    approvalAttestation: {
      findFirst: approvalAttestationFindFirst,
    },
  };
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([{ tenant_id: tenantId }]),
    $transaction: vi.fn((operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx)),
  } as unknown as PrismaClient;
  const proofs = {} as RefundProofKeyring;
  const approvalAttestations = approvalAttestationKeyring();

  return {
    state,
    requestUpdate,
    requestFindMany,
    executionUpsert,
    attemptAggregate,
    attemptCreate,
    store: new PrismaWorkerStore(client, proofs, approvalAttestations),
  };
}

describe("approval attestation request revision compatibility", () => {
  it.each([
    {
      name: "approved request",
      item: versionCompatibilityItem({
        workflowStatus: "approved",
        effectState: "not_started",
        version: 1,
      }),
    },
    {
      name: "claimed request before its first effect boundary",
      item: versionCompatibilityItem({
        workflowStatus: "executing",
        effectState: "not_started",
        version: 2,
      }),
    },
    {
      name: "first possible effect",
      item: versionCompatibilityItem({
        workflowStatus: "executing",
        effectState: "possible",
        version: 3,
        attemptStates: ["started"],
      }),
    },
    {
      name: "ambiguous effect in reconciliation",
      item: versionCompatibilityItem({
        workflowStatus: "reconciliation_required",
        effectState: "possible",
        version: 4,
        attemptStates: ["ambiguous_failure"],
      }),
    },
    {
      name: "absence proven in reconciliation",
      item: versionCompatibilityItem({
        workflowStatus: "reconciliation_required",
        effectState: "absence_proven",
        version: 5,
        attemptStates: ["ambiguous_failure"],
      }),
    },
    {
      name: "resumed execution after proven absence",
      item: versionCompatibilityItem({
        workflowStatus: "executing",
        effectState: "absence_proven",
        version: 6,
        attemptStates: ["ambiguous_failure"],
      }),
    },
    {
      name: "retryable attempt with certain absence",
      item: versionCompatibilityItem({
        workflowStatus: "executing",
        effectState: "absence_proven",
        version: 4,
        attemptStates: ["retryable_failure"],
      }),
    },
    {
      name: "mixed reconciliation and retryable cycles",
      item: versionCompatibilityItem({
        workflowStatus: "executing",
        effectState: "absence_proven",
        version: 8,
        attemptStates: ["ambiguous_failure", "retryable_failure"],
      }),
    },
  ])("accepts the exact $name revision", ({ item }) => {
    expect(approvalAttestationRequestVersionIsCompatible(item, 0)).toBe(true);
  });

  it.each([
    versionCompatibilityItem({
      workflowStatus: "approved",
      effectState: "not_started",
      version: 2,
    }),
    versionCompatibilityItem({
      workflowStatus: "executing",
      effectState: "not_started",
      version: 3,
    }),
    versionCompatibilityItem({
      workflowStatus: "reconciliation_required",
      effectState: "absence_proven",
      version: 6,
      attemptStates: ["ambiguous_failure"],
    }),
    versionCompatibilityItem({
      workflowStatus: "executing",
      effectState: "absence_proven",
      version: 7,
      attemptStates: ["ambiguous_failure"],
    }),
  ])("rejects an otherwise invisible incompatible request mutation", (item) => {
    expect(approvalAttestationRequestVersionIsCompatible(item, 0)).toBe(false);
  });

  it("rejects execution evidence with a non-contiguous attempt sequence", () => {
    const item = versionCompatibilityItem({
      workflowStatus: "executing",
      effectState: "absence_proven",
      version: 4,
      attemptStates: ["retryable_failure"],
    });
    if (item.execution === null) {
      throw new TypeError("Expected execution evidence");
    }
    const [attempt] = item.execution.attempts;
    if (attempt === undefined) {
      throw new TypeError("Expected attempt evidence");
    }

    expect(
      approvalAttestationRequestVersionIsCompatible(
        {
          ...item,
          execution: {
            ...item.execution,
            attempts: [{ ...attempt, attemptNumber: 2 }],
          },
        },
        0,
      ),
    ).toBe(false);
  });

  it.each(["completed", "terminal_failure"] as const)(
    "rejects the terminal %s attempt state",
    (state) => {
      const item = versionCompatibilityItem({
        workflowStatus: "executing",
        effectState: "absence_proven",
        version: 4,
        attemptStates: [state],
      });
      expect(approvalAttestationRequestVersionIsCompatible(item, 0)).toBe(false);
    },
  );

  it("rejects a linked Refund even when the lifecycle revision matches", () => {
    const item = versionCompatibilityItem({
      workflowStatus: "executing",
      effectState: "absence_proven",
      version: 4,
      attemptStates: ["retryable_failure"],
      linkedRefundId: "re_already_linked",
    });
    expect(approvalAttestationRequestVersionIsCompatible(item, 0)).toBe(false);
  });
});

describe("PrismaWorkerStore financial authorization races", () => {
  it.each(["missing", "tampered"] as const)(
    "does not claim when the durable approval attestation is %s",
    async (attestation) => {
      const harness = storeHarness(executionWorkItem({ attestation }));

      await expect(harness.store.loadRefundExecution(tenantId, requestId)).resolves.toBeNull();

      expect(harness.requestUpdate).not.toHaveBeenCalled();
      expect(harness.executionUpsert).not.toHaveBeenCalled();
      expect(harness.attemptCreate).not.toHaveBeenCalled();
      expect(harness.state.item).toMatchObject({
        workflowStatus: "approved",
        effectState: "not_started",
        paymentGuardReleasedAt: null,
      });
    },
  );

  it("does not claim when the request revision contains an unaccounted mutation", async () => {
    const item = executionWorkItem();
    const harness = storeHarness({
      ...item,
      version: item.version + 1,
    });

    await expect(harness.store.loadRefundExecution(tenantId, requestId)).resolves.toBeNull();

    expect(harness.requestUpdate).not.toHaveBeenCalled();
    expect(harness.executionUpsert).not.toHaveBeenCalled();
    expect(harness.attemptCreate).not.toHaveBeenCalled();
    expect(harness.state.item).toMatchObject({
      workflowStatus: "approved",
      effectState: "not_started",
      version: 2,
    });
  });

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

  it("rejects an attestation tampered after claim before persisting the effect boundary", async () => {
    const harness = storeHarness();

    await expect(harness.store.loadRefundExecution(tenantId, requestId)).resolves.not.toBeNull();
    expect(harness.state.item.workflowStatus).toBe("executing");
    const decision = harness.state.item.approvalDecision;
    const attestation = decision.approvalAttestation;
    if (attestation === null) {
      throw new TypeError("Expected a valid approval attestation fixture");
    }
    const tamperedHmac = Buffer.from(attestation.hmac);
    tamperedHmac[0] = (tamperedHmac[0] ?? 0) ^ 1;
    harness.state.item = {
      ...harness.state.item,
      approvalDecision: {
        ...decision,
        approvalAttestation: {
          ...attestation,
          hmac: tamperedHmac,
        },
      },
    };

    await expect(
      harness.store.persistEffectBoundary({
        tenantId,
        requestId,
        idempotencyKey: refundIdempotencyKey(requestId),
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
      attempts:
        versionCompatibilityItem({
          workflowStatus: "executing",
          effectState: "absence_proven",
          version: 8,
          attemptStates: ["retryable_failure", "retryable_failure", "retryable_failure"],
        }).execution?.attempts.map((attempt) => ({
          ...attempt,
          executionId: "execution-absence",
        })) ?? [],
    };
    const harness = storeHarness({
      ...item,
      workflowStatus: "executing",
      effectState: "absence_proven",
      version: 8,
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
          installationId,
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
