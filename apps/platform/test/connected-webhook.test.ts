import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import type {
  ConnectedWebhookEndpoint,
  NormalizedConnectedWebhookPayload,
  WebhookReceiptInsertResult,
} from "@refunddesk/db";

import {
  receiveConnectedWebhook,
  type ConnectedWebhookDependencies,
  type ConnectedWebhookPersistence,
  type ResolvedWebhookInstallation,
  type WebhookEndpoint,
} from "../src/server/connected-webhook.js";

const TEST_SECRET = "whsec_connected_test";
const SANDBOX_SECRET = "whsec_connected_sandbox";
const TENANT_ID = "4f7718e3-783b-4698-8f86-af631bd4c91e";
const INSTALLATION_ID = "8f9dd61e-5ce4-4c74-a88f-297730aab274";
const RECEIPT_ID = "67f37649-b880-4bb9-847f-21da2cf53580";

interface InsertCall {
  readonly resolved: ResolvedWebhookInstallation;
  readonly endpoint: ConnectedWebhookEndpoint;
  readonly stripeEventId: string;
  readonly stripeAccountId: string;
  readonly payload: NormalizedConnectedWebhookPayload;
  readonly objectId: string;
  readonly receivedAt: Date;
}

class FakePersistence implements ConnectedWebhookPersistence {
  existingReceiptId: string | null = null;
  resolved: ResolvedWebhookInstallation | null = {
    tenantId: TENANT_ID,
    installationId: INSTALLATION_ID,
    applied: false,
  };
  readonly resolutions: Array<Parameters<ConnectedWebhookPersistence["resolve"]>[0]> = [];
  readonly inserts: InsertCall[] = [];
  insertError: Error | null = null;

  findExisting(): Promise<{ readonly receiptId: string } | null> {
    return Promise.resolve(
      this.existingReceiptId === null ? null : { receiptId: this.existingReceiptId },
    );
  }

  resolve(
    input: Parameters<ConnectedWebhookPersistence["resolve"]>[0],
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
    id: "evt_connected_refund",
    object: "event",
    account: "acct_connected",
    api_version: "2026-06-24.dahlia",
    created,
    data: {
      object: {
        id: "re_connected",
        object: "refund",
        amount: 500,
        charge: "ch_connected",
        payment_intent: "pi_connected",
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
    request: { id: "req_connected", idempotency_key: null },
    type: "refund.created",
    ...overrides,
  };
}

function lifecycleEvent(
  type: "account.application.authorized" | "account.application.deauthorized",
): Readonly<Record<string, unknown>> {
  return {
    id:
      type === "account.application.authorized"
        ? "evt_application_authorized"
        : "evt_application_removed",
    object: "event",
    account: "acct_connected",
    api_version: "2026-06-24.dahlia",
    created: Math.floor(Date.now() / 1_000),
    data: {
      object: {
        id: "ca_connected",
        object: "application",
        name: "RefundDesk",
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
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
  return new Request("http://localhost/api/webhooks/stripe-connected/test", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
}

function dependencies(
  persistence: ConnectedWebhookPersistence,
  signingSecret = TEST_SECRET,
): ConnectedWebhookDependencies {
  return {
    signingSecret,
    constructEvent: (rawBody, signature, secret) =>
      Stripe.webhooks.constructEvent(rawBody, signature, secret, 300),
    persistence,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  };
}

async function receive(
  event: Readonly<Record<string, unknown>>,
  persistence: FakePersistence,
  endpoint: WebhookEndpoint = "test",
  secret = TEST_SECRET,
): Promise<Response> {
  return receiveConnectedWebhook(
    signedRequest(event, secret),
    endpoint,
    dependencies(persistence, endpoint === "sandbox" ? SANDBOX_SECRET : TEST_SECRET),
  );
}

describe("durable connected Stripe webhook ingress", () => {
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
      endpoint: "connected_test",
      stripeAccountId: "acct_connected",
      objectId: "re_connected",
      payload: {
        schema_version: 1,
        environment: "test",
        event_type: "refund.created",
        refund: {
          refund_id: "re_connected",
          amount_minor: "500",
          currency: "eur",
        },
      },
    });
    expect(JSON.stringify(persistence.inserts[0])).not.toContain('"object":"event"');
  });

  it("feeds a verified and durably persisted Refund into the development Phase-0 observer", async () => {
    const persistence = new FakePersistence();
    const observe = vi.fn(() => "internal" as const);
    const response = await receiveConnectedWebhook(signedRequest(refundEvent()), "test", {
      ...dependencies(persistence),
      phase0Observer: { observe },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase0_correlation: "internal" });
    expect(observe).toHaveBeenCalledWith({
      eventId: "evt_connected_refund",
      refundId: "re_connected",
      accountId: "acct_connected",
      environment: "test",
      paymentKey: "pi_connected",
      amountMinor: "500",
      currency: "eur",
      requestNonce: "cc3cb5d1-268c-49b4-831f-a6f392097189",
      proof: "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      eventIdempotencyKey: null,
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
    const alteredResponse = await receiveConnectedWebhook(
      new Request(alteredRequest.url, {
        method: "POST",
        headers: alteredRequest.headers,
        body: alteredPayload,
      }),
      "test",
      dependencies(persistence),
    );
    const expiredResponse = await receiveConnectedWebhook(
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

  it("never logs a raw invalid payload and keeps the live endpoint hard-disabled", async () => {
    const persistence = new FakePersistence();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await receiveConnectedWebhook(
      signedRequest(refundEvent(), "whsec_wrong"),
      "test",
      dependencies(persistence),
    );
    const live = await receiveConnectedWebhook(
      new Request("http://localhost/api/webhooks/stripe-connected/live", {
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
      application_id: "ca_connected",
    });
  });
});
