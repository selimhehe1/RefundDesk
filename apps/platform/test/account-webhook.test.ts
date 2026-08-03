import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import type {
  AccountWebhookEndpoint,
  NormalizedAccountWebhookPayload,
  WebhookReceiptInsertResult,
} from "@refunddesk/db";

import {
  receiveAccountWebhook,
  type AccountWebhookDependencies,
  type AccountWebhookPersistence,
  type AccountWebhookRouteEnvironment,
  type ResolvedWebhookInstallation,
} from "../src/server/account-webhook.js";
import { EdgeAdmissionDeniedReason } from "../src/server/edge-admission.js";

const TEST_SECRET = "whsec_account_test";
const SANDBOX_SECRET = "whsec_account_sandbox";
const APP_ID = "ca_account";
const TEST_ACCOUNT_ID = "acct_DirectTest123";
const SANDBOX_ACCOUNT_ID = "acct_DirectSandbox456";
const TENANT_ID = "4f7718e3-783b-4698-8f86-af631bd4c91e";
const INSTALLATION_ID = "8f9dd61e-5ce4-4c74-a88f-297730aab274";
const RECEIPT_ID = "67f37649-b880-4bb9-847f-21da2cf53580";

interface InsertCall {
  readonly resolved: ResolvedWebhookInstallation;
  readonly endpoint: AccountWebhookEndpoint;
  readonly stripeEventId: string;
  readonly stripeAccountId: string;
  readonly payload: NormalizedAccountWebhookPayload;
  readonly objectId: string;
  readonly receivedAt: Date;
}

class FakePersistence implements AccountWebhookPersistence {
  existingReceiptId: string | null = null;
  resolved: ResolvedWebhookInstallation | null = {
    tenantId: TENANT_ID,
    installationId: INSTALLATION_ID,
    applied: false,
  };
  readonly resolutions: Array<Parameters<AccountWebhookPersistence["resolve"]>[0]> = [];
  readonly inserts: InsertCall[] = [];
  findExistingCalls = 0;
  insertError: Error | null = null;

  findExisting(): Promise<{ readonly receiptId: string } | null> {
    this.findExistingCalls += 1;
    return Promise.resolve(
      this.existingReceiptId === null ? null : { receiptId: this.existingReceiptId },
    );
  }

  resolve(
    input: Parameters<AccountWebhookPersistence["resolve"]>[0],
  ): Promise<ResolvedWebhookInstallation | null> {
    this.resolutions.push(input);
    return Promise.resolve(this.resolved);
  }

  insert(input: InsertCall): Promise<WebhookReceiptInsertResult> {
    this.inserts.push(input);
    if (this.insertError !== null) {
      return Promise.reject(this.insertError);
    }
    return Promise.resolve({
      inserted: this.existingReceiptId === null,
      receipt: {
        id: this.existingReceiptId ?? RECEIPT_ID,
      } as WebhookReceiptInsertResult["receipt"],
    });
  }
}

function refundEvent(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const created = Math.floor(Date.now() / 1_000);
  return {
    id: "evt_account_refund",
    object: "event",
    api_version: "2026-06-24.dahlia",
    created,
    data: {
      object: {
        id: "re_account",
        object: "refund",
        amount: 500,
        charge: "ch_account",
        payment_intent: "pi_account",
        currency: "eur",
        status: "succeeded",
        created,
        metadata: {
          refunddesk_request_id: "cc3cb5d1-268c-49b4-831f-a6f392097189",
          refunddesk_proof: "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: "req_account", idempotency_key: null },
    type: "refund.created",
    ...overrides,
  };
}

function lifecycleEvent(
  type: "account.application.authorized" | "account.application.deauthorized",
  applicationId = APP_ID,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id:
      type === "account.application.authorized"
        ? "evt_application_authorized"
        : "evt_application_removed",
    object: "event",
    api_version: "2026-02-25.clover",
    created: Math.floor(Date.now() / 1_000),
    data: {
      object: {
        id: applicationId,
        object: "application",
        name: "RefundDesk",
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    ...overrides,
  };
}

function signedRequest(
  event: Readonly<Record<string, unknown>>,
  secret = TEST_SECRET,
  timestamp = Math.floor(Date.now() / 1_000),
): Request {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp,
  });
  return new Request("http://localhost/api/webhooks/stripe-account/test", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
}

function dependencies(
  persistence: AccountWebhookPersistence,
  signingSecret: string | readonly string[] = TEST_SECRET,
  expectedAccountId = TEST_ACCOUNT_ID,
): AccountWebhookDependencies {
  return {
    expectedApplicationId: APP_ID,
    expectedAccountId,
    expectedApiVersion: "2026-06-24.dahlia",
    signingSecrets: Array.isArray(signingSecret) ? signingSecret : [signingSecret],
    constructEvent: (rawBody, signature, secret) =>
      Stripe.webhooks.constructEvent(rawBody, signature, secret, 300),
    persistence,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  };
}

async function receive(
  event: Readonly<Record<string, unknown>>,
  persistence: FakePersistence,
  endpoint: AccountWebhookRouteEnvironment = "test",
  secret = TEST_SECRET,
): Promise<Response> {
  return receiveAccountWebhook(
    signedRequest(event, secret),
    endpoint,
    dependencies(
      persistence,
      endpoint === "sandbox" ? SANDBOX_SECRET : TEST_SECRET,
      endpoint === "sandbox" ? SANDBOX_ACCOUNT_ID : TEST_ACCOUNT_ID,
    ),
  );
}

describe("durable direct-account Stripe webhook ingress", () => {
  it("rejects edge capacity before dependency setup, body allocation, HMAC or persistence", async () => {
    const persistence = new FakePersistence();
    const getReader = vi.fn(() => {
      throw new Error("body must not be read");
    });
    const constructEvent = vi.fn();
    const request = {
      body: { getReader },
      headers: new Headers(),
    } as unknown as Request;

    const response = await receiveAccountWebhook(
      request,
      "test",
      { ...dependencies(persistence), constructEvent },
      {
        acquire: () => ({
          allowed: false,
          reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
          retryAfterSeconds: 3,
          status: 429,
        }),
      },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toMatchObject({ code: "EDGE_RATE_LIMITED" });
    expect(getReader).not.toHaveBeenCalled();
    expect(constructEvent).not.toHaveBeenCalled();
    expect(persistence.findExistingCalls).toBe(0);
  });

  it("maps a rejected webhook source to a generic 403 without reading the body", async () => {
    const persistence = new FakePersistence();
    const getReader = vi.fn();
    const response = await receiveAccountWebhook(
      { body: { getReader }, headers: new Headers() } as unknown as Request,
      "sandbox",
      dependencies(persistence, SANDBOX_SECRET, SANDBOX_ACCOUNT_ID),
      {
        acquire: () => ({
          allowed: false,
          reason: EdgeAdmissionDeniedReason.WebhookSourceForbidden,
          status: 403,
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "WEBHOOK_SOURCE_FORBIDDEN" });
    expect(getReader).not.toHaveBeenCalled();
    expect(persistence.findExistingCalls).toBe(0);
  });

  it("releases webhook verification concurrency after an invalid signature", async () => {
    const release = vi.fn();
    const persistence = new FakePersistence();
    const response = await receiveAccountWebhook(
      signedRequest(refundEvent(), "whsec_wrong"),
      "test",
      dependencies(persistence),
      { acquire: () => ({ allowed: true, lease: { release } }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "WEBHOOK_INVALID" });
    expect(release).toHaveBeenCalledOnce();
    expect(persistence.findExistingCalls).toBe(0);
  });

  it("cancels a webhook body that misses the absolute deadline and releases its lease", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-01T12:00:00.000Z") });
    try {
      const cancel = vi.fn();
      const release = vi.fn();
      const constructEvent = vi.fn();
      const persistence = new FakePersistence();
      const request = new Request("http://localhost/api/webhooks/stripe-account/test", {
        body: new ReadableStream<Uint8Array>({ cancel }),
        headers: { "Stripe-Signature": "t=1,v1=unused" },
        method: "POST",
        duplex: "half",
      } as RequestInit & { readonly duplex: "half" });

      const responsePromise = receiveAccountWebhook(
        request,
        "test",
        { ...dependencies(persistence), constructEvent },
        { acquire: () => ({ allowed: true, lease: { release } }) },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await responsePromise;

      expect(response.status).toBe(408);
      expect(await response.json()).toMatchObject({ code: "WEBHOOK_TIMEOUT" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(constructEvent).not.toHaveBeenCalled();
      expect(persistence.findExistingCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists only a strict normalized refund receipt for outbox recovery", async () => {
    const persistence = new FakePersistence();

    const response = await receive(refundEvent(), persistence);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      received: true,
      receipt_id: RECEIPT_ID,
      duplicate: false,
      queued_by: "durable_receipt_recovery",
    });
    expect(persistence.inserts).toHaveLength(1);
    expect(persistence.inserts[0]).toMatchObject({
      endpoint: "account_test",
      stripeAccountId: TEST_ACCOUNT_ID,
      objectId: "re_account",
      payload: {
        schema_version: 1,
        environment: "test",
        event_type: "refund.created",
        refund: {
          refund_id: "re_account",
          amount_minor: "500",
          currency: "eur",
        },
      },
    });
    expect(JSON.stringify(persistence.inserts[0])).not.toContain('"object":"event"');
  });

  it("returns only the durable receipt acknowledgement for a verified Refund", async () => {
    const persistence = new FakePersistence();
    const response = await receiveAccountWebhook(
      signedRequest(refundEvent()),
      "test",
      dependencies(persistence),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      event_id: "evt_account_refund",
      receipt_id: RECEIPT_ID,
      duplicate: false,
      queued_by: "durable_receipt_recovery",
    });
    expect(persistence.inserts).toHaveLength(1);
  });

  it("reapplies duplicate deauthorization through atomic persistence before returning 200", async () => {
    const persistence = new FakePersistence();
    persistence.existingReceiptId = RECEIPT_ID;

    const response = await receive(lifecycleEvent("account.application.deauthorized"), persistence);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true, receipt_id: RECEIPT_ID });
    expect(persistence.resolutions).toHaveLength(1);
    expect(persistence.inserts).toHaveLength(1);
    expect(persistence.inserts[0]?.payload.event_type).toBe("account.application.deauthorized");
  });

  it("does not acknowledge deauthorization until atomic persistence succeeds", async () => {
    const persistence = new FakePersistence();
    persistence.insertError = new Error("DATABASE_UNAVAILABLE");

    const response = await receive(lifecycleEvent("account.application.deauthorized"), persistence);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "WEBHOOK_PERSISTENCE_UNAVAILABLE",
    });
    expect(persistence.resolutions).toHaveLength(1);
    expect(persistence.inserts).toHaveLength(1);
  });

  it.each(["account.application.authorized", "account.application.deauthorized"] as const)(
    "rejects a %s Event for another Stripe App before persistence",
    async (eventType) => {
      const persistence = new FakePersistence();
      persistence.existingReceiptId = RECEIPT_ID;

      const response = await receive(lifecycleEvent(eventType, "ca_other"), persistence);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "APPLICATION_MISMATCH",
      });
      expect(persistence.findExistingCalls).toBe(0);
      expect(persistence.resolutions).toEqual([]);
      expect(persistence.inserts).toEqual([]);
    },
  );

  it("accepts a signed non-UUID request metadata value for tampering classification", async () => {
    const persistence = new FakePersistence();
    const event = refundEvent();
    const data = event["data"] as {
      readonly object: Readonly<Record<string, unknown>>;
    };
    const modified = {
      ...event,
      data: {
        object: {
          ...data.object,
          metadata: {
            refunddesk_request_id: "copied-not-a-uuid",
            refunddesk_proof: "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      },
    };

    const response = await receive(modified, persistence);

    expect(response.status).toBe(200);
    expect(persistence.inserts[0]?.payload).toMatchObject({
      refund: { metadata_request_id: "copied-not-a-uuid" },
    });
  });

  it("rejects altered bytes, expired signatures, wrong endpoint secrets and live Events", async () => {
    const persistence = new FakePersistence();
    const event = refundEvent();
    const alteredRequest = signedRequest(event);
    const alteredPayload = JSON.stringify({ ...event, pending_webhooks: 2 });
    const alteredResponse = await receiveAccountWebhook(
      new Request(alteredRequest.url, {
        method: "POST",
        headers: alteredRequest.headers,
        body: alteredPayload,
      }),
      "test",
      dependencies(persistence),
    );
    const expiredResponse = await receiveAccountWebhook(
      signedRequest(event, TEST_SECRET, Math.floor(Date.now() / 1_000) - 301),
      "test",
      dependencies(persistence),
    );
    const wrongSecretResponse = await receive(event, persistence, "sandbox", TEST_SECRET);
    const liveResponse = await receive(refundEvent({ livemode: true }), persistence);

    expect(alteredResponse.status).toBe(400);
    expect(expiredResponse.status).toBe(400);
    expect(wrongSecretResponse.status).toBe(400);
    expect(liveResponse.status).toBe(400);
    expect(persistence.inserts).toEqual([]);
  });

  it("rejects connected-scope and wrong-version Events before persistence", async () => {
    const persistence = new FakePersistence();

    const connectedScope = await receive(refundEvent({ account: TEST_ACCOUNT_ID }), persistence);
    const wrongVersion = await receive(
      refundEvent({ api_version: "2026-02-25.clover" }),
      persistence,
    );

    expect(connectedScope.status).toBe(400);
    expect(await connectedScope.json()).toMatchObject({
      code: "DELIVERY_SCOPE_MISMATCH",
    });
    expect(wrongVersion.status).toBe(400);
    expect(await wrongVersion.json()).toMatchObject({
      code: "API_VERSION_MISMATCH",
    });
    expect(persistence.findExistingCalls).toBe(0);
    expect(persistence.resolutions).toEqual([]);
    expect(persistence.inserts).toEqual([]);
  });

  it.each(["account.application.authorized", "account.application.deauthorized"] as const)(
    "rejects a %s Event outside the explicit lifecycle API-version allowlist",
    async (eventType) => {
      const persistence = new FakePersistence();

      const response = await receive(
        lifecycleEvent(eventType, APP_ID, { api_version: "2025-12-15.clover" }),
        persistence,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "API_VERSION_MISMATCH",
      });
      expect(persistence.findExistingCalls).toBe(0);
      expect(persistence.resolutions).toEqual([]);
      expect(persistence.inserts).toEqual([]);
    },
  );

  it.each(["account.application.authorized", "account.application.deauthorized"] as const)(
    "continues to accept a %s Event rendered with the configured endpoint API version",
    async (eventType) => {
      const persistence = new FakePersistence();

      const response = await receive(
        lifecycleEvent(eventType, APP_ID, { api_version: "2026-06-24.dahlia" }),
        persistence,
      );

      expect(response.status).toBe(200);
      expect(persistence.resolutions).toHaveLength(1);
      expect(persistence.inserts).toHaveLength(1);
    },
  );

  it.each([
    ["account.application.authorized", null],
    ["account.application.deauthorized", "2026-01-01.clover"],
  ] as const)(
    "rejects a %s Event rendered with unsupported API version %s",
    async (eventType, apiVersion) => {
      const persistence = new FakePersistence();

      const response = await receive(
        lifecycleEvent(eventType, APP_ID, { api_version: apiVersion }),
        persistence,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "API_VERSION_MISMATCH",
      });
      expect(persistence.findExistingCalls).toBe(0);
      expect(persistence.resolutions).toEqual([]);
      expect(persistence.inserts).toEqual([]);
    },
  );

  it.each(["refund.created", "refund.updated", "refund.failed"] as const)(
    "does not extend the lifecycle Clover exception to %s",
    async (eventType) => {
      const persistence = new FakePersistence();

      const response = await receive(
        refundEvent({
          type: eventType,
          api_version: "2026-02-25.clover",
        }),
        persistence,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "API_VERSION_MISMATCH",
      });
      expect(persistence.findExistingCalls).toBe(0);
      expect(persistence.resolutions).toEqual([]);
      expect(persistence.inserts).toEqual([]);
    },
  );

  it("does not extend the lifecycle Clover exception by event-name prefix", async () => {
    const persistence = new FakePersistence();

    const response = await receive(
      lifecycleEvent("account.application.authorized", APP_ID, {
        type: "account.application.updated",
      }),
      persistence,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "API_VERSION_MISMATCH",
    });
    expect(persistence.findExistingCalls).toBe(0);
    expect(persistence.resolutions).toEqual([]);
    expect(persistence.inserts).toEqual([]);
  });

  it.each(["source_transfer_reversal", "transfer_reversal"] as const)(
    "rejects a direct Event whose Refund carries the Connect field %s before persistence",
    async (field) => {
      const persistence = new FakePersistence();
      const event = refundEvent();
      const data = event["data"] as {
        readonly object: Readonly<Record<string, unknown>>;
      };
      const connectRefund = {
        ...event,
        data: {
          object: {
            ...data.object,
            [field]: "trr_connect",
          },
        },
      };

      const response = await receive(connectRefund, persistence);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "PAYLOAD_INVALID" });
      expect(persistence.findExistingCalls).toBe(0);
      expect(persistence.resolutions).toEqual([]);
      expect(persistence.inserts).toEqual([]);
    },
  );

  it("fails closed before persistence when the configured direct account is invalid", async () => {
    const persistence = new FakePersistence();
    const response = await receiveAccountWebhook(
      signedRequest(refundEvent()),
      "test",
      dependencies(persistence, TEST_SECRET, "acct_invalid_with_underscores"),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ENDPOINT_MISCONFIGURED" });
    expect(persistence.findExistingCalls).toBe(0);
  });

  it("never logs a raw invalid payload and keeps the live endpoint hard-disabled", async () => {
    const persistence = new FakePersistence();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await receiveAccountWebhook(
      signedRequest(refundEvent(), "whsec_wrong"),
      "test",
      dependencies(persistence),
    );
    const live = await receiveAccountWebhook(
      new Request("http://localhost/api/webhooks/stripe-account/live", {
        method: "POST",
        body: "raw-secret-payload",
      }),
      "live",
    );

    expect(response.status).toBe(400);
    expect(live.status).toBe(503);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  it("normalizes authorized lifecycle Events for test-only provisioning", async () => {
    const persistence = new FakePersistence();
    persistence.resolved = {
      tenantId: TENANT_ID,
      installationId: INSTALLATION_ID,
      applied: true,
    };

    const response = await receive(lifecycleEvent("account.application.authorized"), persistence);

    expect(response.status).toBe(200);
    expect(persistence.resolutions[0]).toMatchObject({
      environment: "test",
      eventType: "account.application.authorized",
    });
    expect(persistence.inserts[0]?.payload).toMatchObject({
      event_type: "account.application.authorized",
      application_id: APP_ID,
    });
  });
});

describe("webhook secret rotation overlap", () => {
  // Stripe signs a delivery with the secret current at send time and then retries that exact
  // signature for days. A bare cutover therefore drops everything already in flight, and a
  // dropped `refund.failed` leaves a refund recorded as succeeded with its payment guard
  // released. The previous secret has to stay acceptable until those retries drain.
  const ROLLED_SECRET = "whsec_account_test_rolled";
  const FOREIGN_SECRET = "whsec_account_someone_else";

  it("accepts a delivery still signed with the previous secret during a roll", async () => {
    const persistence = new FakePersistence();

    const response = await receiveAccountWebhook(
      signedRequest(lifecycleEvent("account.application.authorized"), TEST_SECRET),
      "test",
      dependencies(persistence, [ROLLED_SECRET, TEST_SECRET]),
    );

    expect(response.status).toBe(200);
    expect(persistence.inserts).toHaveLength(1);
  });

  it("accepts a delivery signed with the new secret during the same roll", async () => {
    const persistence = new FakePersistence();

    const response = await receiveAccountWebhook(
      signedRequest(lifecycleEvent("account.application.authorized"), ROLLED_SECRET),
      "test",
      dependencies(persistence, [ROLLED_SECRET, TEST_SECRET]),
    );

    expect(response.status).toBe(200);
    expect(persistence.inserts).toHaveLength(1);
  });

  it("still refuses a secret that is neither the new nor the previous one", async () => {
    const persistence = new FakePersistence();

    const response = await receiveAccountWebhook(
      signedRequest(lifecycleEvent("account.application.authorized"), FOREIGN_SECRET),
      "test",
      dependencies(persistence, [ROLLED_SECRET, TEST_SECRET]),
    );

    expect(response.status).toBe(400);
    expect(persistence.inserts).toHaveLength(0);
  });

  it("refuses the previous secret once the roll is finished", async () => {
    const persistence = new FakePersistence();

    const response = await receiveAccountWebhook(
      signedRequest(lifecycleEvent("account.application.authorized"), TEST_SECRET),
      "test",
      dependencies(persistence, [ROLLED_SECRET]),
    );

    expect(response.status).toBe(400);
    expect(persistence.inserts).toHaveLength(0);
  });

  it("refuses every delivery when no secret is configured, without reading the body", async () => {
    const persistence = new FakePersistence();

    const response = await receiveAccountWebhook(
      signedRequest(lifecycleEvent("account.application.authorized"), TEST_SECRET),
      "test",
      dependencies(persistence, []),
    );

    expect(response.status).toBe(503);
    expect(persistence.inserts).toHaveLength(0);
  });
});
