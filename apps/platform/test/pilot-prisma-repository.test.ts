import { describe, expect, it } from "vitest";

import type { PrismaClient } from "@refunddesk/db";
import { FieldEncryptionKeyring } from "@refunddesk/domain";

import {
  pilotAssertedStripeRolesSnapshot,
  PilotPrismaRepository,
  pilotStripeRolesJson,
} from "../src/server/pilot-prisma-repository.js";
import type {
  PilotMutationMetadata,
  PilotStoredResponse,
  PilotTenantContext,
} from "../src/server/pilot-ports.js";

const TENANT_ID = "b4d99977-29d0-4493-a3bf-25b9719fb570";
const INSTALLATION_ID = "bc401781-0027-4aa7-8bb4-d4a29fd5cce8";
const NONCE = "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9";

interface StoredReceipt {
  readonly actorId: string;
  readonly canonicalRequestHash: Uint8Array;
  readonly operation: string;
  readonly responseBody: Readonly<Record<string, unknown>>;
  readonly responseStatus: number;
}

interface CapturedTenantUserUpsert {
  readonly create: Readonly<Record<string, unknown>>;
  readonly update: Readonly<Record<string, unknown>>;
}

function context(): PilotTenantContext {
  return {
    actor: {
      approverEnabled: true,
      id: "5950a897-6150-4372-8193-b3a9f2593c68",
      stripeUserId: "usr_approver",
    },
    environment: "test",
    installationId: INSTALLATION_ID,
    installationStatus: "active",
    stripeAccountId: "acct_pilot",
    tenantId: TENANT_ID,
    tenantStatus: "active",
  };
}

function metadata(hashByte: number, responseRequestId: string): PilotMutationMetadata {
  return {
    actorId: "usr_approver",
    assertedStripeRoles: null,
    canonicalRequestHash: Uint8Array.from([hashByte]),
    operation: "refund_request.create",
    requestNonce: NONCE,
    responseRequestId,
  };
}

function concurrentReceiptRepository(): {
  readonly createAttempts: () => number;
  readonly repository: PilotPrismaRepository;
  readonly stored: () => StoredReceipt | null;
} {
  let receipt: StoredReceipt | null = null;
  let createAttempts = 0;
  let initialReads = 0;
  let releaseInitialReads: (() => void) | undefined;
  const bothInitialReads = new Promise<void>((resolve) => {
    releaseInitialReads = resolve;
  });
  const transaction = {
    $queryRaw: () => Promise.resolve([]),
    apiMutationReceipt: {
      findUnique: async (): Promise<StoredReceipt | null> => {
        if (receipt !== null) {
          return receipt;
        }
        initialReads += 1;
        if (initialReads === 2) {
          releaseInitialReads?.();
        }
        await bothInitialReads;
        return null;
      },
      create: (input: { readonly data: StoredReceipt }): Promise<StoredReceipt> => {
        createAttempts += 1;
        if (receipt !== null) {
          return Promise.reject(Object.assign(new Error("unique violation"), { code: "P2002" }));
        }
        receipt = input.data;
        return Promise.resolve(receipt);
      },
    },
    stripeInstallation: {
      findFirst: () =>
        Promise.resolve({
          id: INSTALLATION_ID,
          tenantId: TENANT_ID,
          stripeAccountId: "acct_pilot",
          environment: "test",
          status: "active",
          tenant: {
            id: TENANT_ID,
            liveEnabled: false,
            status: "active",
          },
        }),
    },
  };
  const client = {
    $transaction: <T>(operation: (tx: typeof transaction) => Promise<T>): Promise<T> =>
      operation(transaction),
  } as unknown as PrismaClient;
  return {
    createAttempts: () => createAttempts,
    repository: new PilotPrismaRepository({
      appBaseUrl: "https://refunddesk.example",
      auditSigningKey: Buffer.alloc(32, 1),
      client,
      fieldKeyring: new FieldEncryptionKeyring({
        active: { key: Buffer.alloc(32, 2), version: "v1" },
      }),
      now: () => new Date("2030-01-01T12:00:00.000Z"),
    }),
    stored: () => receipt,
  };
}

describe("atomic pilot mutation receipt storage", () => {
  it("returns the single winning response to concurrent identical requests", async () => {
    const harness = concurrentReceiptRepository();
    const firstResponse: PilotStoredResponse = {
      body: {
        code: "PAYMENT_NOT_ELIGIBLE",
        message: "Payment is not eligible.",
        request_id: "8b661cd3-4aa3-4772-9e90-ef9d88636318",
      },
      status: 422,
    };
    const secondResponse: PilotStoredResponse = {
      body: {
        code: "PAYMENT_NOT_ELIGIBLE",
        message: "Payment is not eligible.",
        request_id: "03f1fe5d-65bc-4a24-b591-b096588d7a42",
      },
      status: 422,
    };

    const results = await Promise.all([
      harness.repository.storeMutationReceipt(
        context(),
        metadata(1, "8b661cd3-4aa3-4772-9e90-ef9d88636318"),
        firstResponse,
      ),
      harness.repository.storeMutationReceipt(
        context(),
        metadata(1, "03f1fe5d-65bc-4a24-b591-b096588d7a42"),
        secondResponse,
      ),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.body).toEqual(harness.stored()?.responseBody);
    expect(harness.createAttempts()).toBe(2);
  });

  it("rejects the loser when the same nonce races with a changed payload", async () => {
    const harness = concurrentReceiptRepository();
    const results = await Promise.allSettled([
      harness.repository.storeMutationReceipt(context(), metadata(1, "request-a"), {
        body: { code: "WORKFLOW_CONFLICT", message: "Conflict A.", request_id: "request-a" },
        status: 409,
      }),
      harness.repository.storeMutationReceipt(context(), metadata(2, "request-b"), {
        body: { code: "WORKFLOW_CONFLICT", message: "Conflict B.", request_id: "request-b" },
        status: 409,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: {
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
      },
      status: "rejected",
    });
    expect(harness.createAttempts()).toBe(2);
  });
});

describe("Stripe role persistence", () => {
  it("uses only the roles asserted by the current signed command", () => {
    const assertedRoles = [{ id: "view_only", type: "builtIn", name: "View only" }] as const;

    expect(pilotAssertedStripeRolesSnapshot(null)).toEqual([]);
    expect(pilotAssertedStripeRolesSnapshot(assertedRoles)).toEqual(assertedRoles);
  });

  it.each([
    {
      name: "writes an empty snapshot for an unasserted command",
      assertedStripeRoles: null,
      expectedSnapshot: [],
    },
    {
      name: "keeps the current assertion when a concurrent observation changed durable roles",
      assertedStripeRoles: [{ id: "view_only", type: "builtIn", name: "View only" }] as const,
      expectedSnapshot: [{ id: "view_only", type: "builtIn", name: "View only" }],
    },
  ])("$name", async ({ assertedStripeRoles, expectedSnapshot }) => {
    const requestId = "d4522945-a0f4-4b0c-88ff-78ee2fed55d6";
    const capturedDecisions: Readonly<Record<string, unknown>>[] = [];
    const capturedAuditEvents: Readonly<Record<string, unknown>>[] = [];
    const durableRoles = [{ id: "super_admin", type: "builtIn", name: "Super Administrator" }];
    const transaction = {
      $queryRaw: () => Promise.resolve([]),
      apiMutationReceipt: {
        findUnique: () => Promise.resolve(null),
        create: (input: { readonly data: Readonly<Record<string, unknown>> }) =>
          Promise.resolve(input.data),
      },
      approvalDecision: {
        create: (input: { readonly data: Readonly<Record<string, unknown>> }) => {
          capturedDecisions.push(input.data);
          return Promise.resolve(input.data);
        },
      },
      auditEvent: {
        create: (input: { readonly data: Readonly<Record<string, unknown>> }) => {
          capturedAuditEvents.push(input.data);
          return Promise.resolve(input.data);
        },
      },
      refundRequest: {
        findFirst: () =>
          Promise.resolve({
            chargeId: "ch_pilot",
            decisions: [],
            effectState: "not_started",
            execution: null,
            id: requestId,
            paymentIntentId: "pi_pilot",
            requesterUserId: "aa1d1b56-567a-4e76-a9d6-962aed9224ad",
            workflowStatus: "pending_approval",
          }),
        updateMany: () => Promise.resolve({ count: 1 }),
      },
      stripeInstallation: {
        findFirst: () =>
          Promise.resolve({
            environment: "test",
            id: INSTALLATION_ID,
            status: "active",
            stripeAccountId: "acct_pilot",
            tenant: {
              id: TENANT_ID,
              liveEnabled: false,
              status: "active",
            },
            tenantId: TENANT_ID,
          }),
      },
      tenantUser: {
        findFirst: () =>
          Promise.resolve({
            approverEnabled: true,
            id: context().actor.id,
            stripeRoles: durableRoles,
            stripeUserId: context().actor.stripeUserId,
            tenantId: TENANT_ID,
          }),
      },
    };
    const client = {
      $transaction: <T>(operation: (tx: typeof transaction) => Promise<T>): Promise<T> =>
        operation(transaction),
    } as unknown as PrismaClient;
    const repository = new PilotPrismaRepository({
      appBaseUrl: "https://refunddesk.example",
      auditSigningKey: Buffer.alloc(32, 1),
      client,
      fieldKeyring: new FieldEncryptionKeyring({
        active: { key: Buffer.alloc(32, 2), version: "v1" },
      }),
      now: () => new Date("2030-01-01T12:00:00.000Z"),
    });

    const result = await repository.executeMutation(
      context(),
      {
        ...metadata(3, "6d201081-2da7-4f8f-8a4d-583515011d47"),
        assertedStripeRoles,
        operation: "refund_request.decide",
      },
      {
        decision: "approve",
        kind: "refund_request_decide",
        requestId,
        resource: { id: "pi_pilot", type: "payment_intent" },
      },
    );

    expect(result).toEqual({
      body: { request_id: requestId, status: "approved" },
      status: 200,
    });
    expect(capturedDecisions).toHaveLength(1);
    expect(capturedDecisions[0]?.["stripeRolesSnapshot"]).toEqual(expectedSnapshot);
    expect(capturedAuditEvents).toHaveLength(1);
    expect(capturedAuditEvents[0]?.["actorSnapshot"]).toEqual(expectedSnapshot);
    expect(capturedAuditEvents[0]?.["payload"]).toEqual({
      decision: "approve",
      roles_asserted: assertedStripeRoles !== null,
    });
  });

  it("retains the stable runtime role ID and omits only an actually absent ID", () => {
    expect(
      pilotStripeRolesJson([
        { id: "super_admin", type: "builtIn", name: "Super Administrator" },
        { id: "refund_reviewer", type: "custom", name: "Refund reviewer" },
        { type: "builtIn", name: "View only" },
      ]),
    ).toEqual([
      { id: "super_admin", type: "builtIn", name: "Super Administrator" },
      { id: "refund_reviewer", type: "custom", name: "Refund reviewer" },
      { type: "builtIn", name: "View only" },
    ]);
  });

  it("preserves stored roles without an assertion and persists an asserted role snapshot", async () => {
    const observedAt = new Date("2030-01-01T12:00:00.000Z");
    const upserts: CapturedTenantUserUpsert[] = [];
    const transaction = {
      $queryRaw: () => Promise.resolve([]),
      stripeInstallation: {
        findFirst: () =>
          Promise.resolve({
            environment: "test",
            id: INSTALLATION_ID,
            status: "active",
            stripeAccountId: "acct_pilot",
            tenant: {
              id: TENANT_ID,
              liveEnabled: false,
              status: "active",
            },
            tenantId: TENANT_ID,
          }),
      },
      tenantUser: {
        upsert: (input: CapturedTenantUserUpsert) => {
          upserts.push(input);
          return Promise.resolve({
            approverEnabled: false,
            id: "5950a897-6150-4372-8193-b3a9f2593c68",
            stripeUserId: "usr_view_only",
          });
        },
      },
    };
    const client = {
      $queryRaw: () =>
        Promise.resolve([
          {
            installation_id: INSTALLATION_ID,
            status: "active",
            tenant_id: TENANT_ID,
          },
        ]),
      $transaction: <T>(operation: (tx: typeof transaction) => Promise<T>): Promise<T> =>
        operation(transaction),
    } as unknown as PrismaClient;
    const repository = new PilotPrismaRepository({
      appBaseUrl: "https://refunddesk.example",
      auditSigningKey: Buffer.alloc(32, 1),
      client,
      fieldKeyring: new FieldEncryptionKeyring({
        active: { key: Buffer.alloc(32, 2), version: "v1" },
      }),
      now: () => observedAt,
    });
    const roles = [{ id: "view_only", name: "View only", type: "builtIn" }] as const;

    await repository.resolveContext(
      {
        accountId: "acct_pilot",
        environment: "test",
        roles,
        rolesAsserted: false,
        userId: "usr_view_only",
      },
      { allowProvision: false },
    );
    await repository.resolveContext(
      {
        accountId: "acct_pilot",
        environment: "test",
        roles,
        rolesAsserted: true,
        userId: "usr_view_only",
      },
      { allowProvision: false },
    );

    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.create).not.toHaveProperty("stripeRoles");
    expect(upserts[0]?.update).not.toHaveProperty("stripeRoles");
    expect(upserts[0]?.update).not.toHaveProperty("lastVerifiedAt");
    expect(upserts[1]?.create).toMatchObject({
      lastVerifiedAt: observedAt,
      stripeRoles: roles,
    });
    expect(upserts[1]?.update).toEqual({
      lastVerifiedAt: observedAt,
      stripeRoles: roles,
    });
  });
});
