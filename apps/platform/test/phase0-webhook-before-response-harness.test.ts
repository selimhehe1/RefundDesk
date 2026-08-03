import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import type {
  AccountWebhookEndpoint,
  NormalizedAccountWebhookPayload,
  WebhookReceiptInsertResult,
} from "@refunddesk/db";
import type {
  CreateRefundInput,
  NormalizedPayment,
  NormalizedRefund,
} from "@refunddesk/stripe-adapter";

import {
  receiveAccountWebhook,
  type AccountWebhookDependencies,
  type AccountWebhookPersistence,
  type ResolvedWebhookInstallation,
} from "../src/server/account-webhook.js";
import {
  executePhase0Probe,
  type ExecutePhase0ProbeInput,
  type Phase0ProbeGateway,
} from "../src/server/phase0-probe.js";
import { Phase0Store } from "../src/server/phase0-store.js";

const SIGNING_SECRET = "phase0-webhook-before-response-signing-secret";
const ACCOUNT_ID = "acct_Phase0RaceHarness";
const TENANT_ID = "83725d16-fde7-4473-a38a-642116180c03";
const INSTALLATION_ID = "297c924c-3b1b-411a-b4b0-6037f225ff6c";
const RECEIPT_ID = "880960d2-9559-4368-8e71-1eed463b17c2";
const PAYMENT_INTENT_ID = "pi_Phase0RaceHarness";
const CHARGE_ID = "ch_Phase0RaceHarness";
const FIRST_REFUND_ID = "re_Phase0RaceFirst";
const SECOND_REFUND_ID = "re_Phase0RaceSecond";
const REQUEST_NONCE = "4d8c3c32-9a66-4471-af8e-7a8d1064cff1";
const EVENT_CREATED = 1_783_448_000;
const RECEIVED_AT = new Date("2026-07-26T12:00:00.000Z");
const PROOF_KEY = Buffer.alloc(32, 17);

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Deferred promise was not initialized");
  }
  return { promise, resolve: resolvePromise };
}

class DeferredRefundGateway implements Phase0ProbeGateway {
  private readonly createStarted = deferred<CreateRefundInput>();
  private readonly apiResponse = deferred<NormalizedRefund>();

  constructor(private readonly trace: string[]) {}

  retrievePayment(): Promise<NormalizedPayment> {
    this.trace.push("payment_retrieved");
    return Promise.resolve({
      paymentKey: PAYMENT_INTENT_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      chargeId: CHARGE_ID,
      amountCaptured: 1_000n,
      amountRefunded: 0n,
      currency: "eur",
      captured: true,
      paid: true,
      disputed: false,
      paymentMethodType: "card",
      hasConnectSemantics: false,
    });
  }

  createRefund(input: CreateRefundInput): Promise<NormalizedRefund> {
    this.trace.push("refund_create_started");
    this.createStarted.resolve(input);
    return this.apiResponse.promise;
  }

  waitForCreateCall(): Promise<CreateRefundInput> {
    return this.createStarted.promise;
  }

  releaseApiResponse(input: CreateRefundInput, refundId = FIRST_REFUND_ID): void {
    this.trace.push("api_response_released");
    this.apiResponse.resolve({
      id: refundId,
      paymentIntentId: input.paymentIntentId ?? null,
      chargeId: CHARGE_ID,
      amountMinor: input.amountMinor,
      currency: "eur",
      status: "succeeded",
      created: EVENT_CREATED,
      metadata: input.metadata,
      requestId: "req_Phase0RaceHarness",
    });
  }
}

interface InsertCall {
  readonly endpoint: AccountWebhookEndpoint;
  readonly stripeEventId: string;
  readonly stripeAccountId: string;
  readonly payload: NormalizedAccountWebhookPayload;
}

class HarnessWebhookPersistence implements AccountWebhookPersistence {
  readonly correlations: Array<ReturnType<Phase0Store["observe"]>> = [];
  readonly inserts: InsertCall[] = [];
  private readonly receipts = new Map<string, string>();

  constructor(
    private readonly trace: string[],
    private readonly store: Phase0Store,
  ) {}

  findExisting(
    endpoint: AccountWebhookEndpoint,
    stripeEventId: string,
    stripeAccountId: string,
  ): Promise<{ readonly receiptId: string } | null> {
    const receiptId = this.receipts.get(`${endpoint}\0${stripeAccountId}\0${stripeEventId}`);
    return Promise.resolve(receiptId === undefined ? null : { receiptId });
  }

  resolve(): Promise<ResolvedWebhookInstallation> {
    return Promise.resolve({
      tenantId: TENANT_ID,
      installationId: INSTALLATION_ID,
      applied: false,
    });
  }

  insert(
    input: Parameters<AccountWebhookPersistence["insert"]>[0],
  ): Promise<WebhookReceiptInsertResult> {
    const key = `${input.endpoint}\0${input.stripeAccountId}\0${input.stripeEventId}`;
    const existingReceiptId = this.receipts.get(key);
    const receiptId = existingReceiptId ?? RECEIPT_ID;
    if (existingReceiptId === undefined) {
      this.receipts.set(key, receiptId);
    }
    this.inserts.push({
      endpoint: input.endpoint,
      stripeEventId: input.stripeEventId,
      stripeAccountId: input.stripeAccountId,
      payload: input.payload,
    });
    this.trace.push(`webhook_persisted:${input.stripeEventId}`);
    if ("refund" in input.payload) {
      const refund = input.payload.refund;
      const paymentKey = refund.payment_intent_id ?? refund.charge_id;
      if (paymentKey !== null) {
        this.correlations.push(
          this.store.observe({
            eventId: input.stripeEventId,
            refundId: refund.refund_id,
            accountId: input.stripeAccountId,
            environment: input.payload.environment,
            paymentKey,
            amountMinor: refund.amount_minor,
            currency: refund.currency,
            requestNonce: refund.metadata_request_id,
            proof: refund.metadata_proof,
            eventIdempotencyKey: input.payload.event_idempotency_key,
          }),
        );
        this.trace.push(`webhook_observed:${input.stripeEventId}`);
      }
    }
    return Promise.resolve({
      inserted: existingReceiptId === undefined,
      receipt: { id: receiptId } as WebhookReceiptInsertResult["receipt"],
    });
  }
}

function probeInput(): ExecutePhase0ProbeInput {
  return {
    installation: {
      stripeAccountId: ACCOUNT_ID,
      environment: "test",
      active: true,
    },
    actorUserId: "usr_Phase0RaceHarness",
    requestNonce: REQUEST_NONCE,
    paymentIntentId: PAYMENT_INTENT_ID,
    amountMinor: 500n,
    currency: "eur",
    reason: "requested_by_customer",
  };
}

function refundEvent(
  createInput: CreateRefundInput,
  eventId: string,
  refundId: string,
  eventIdempotencyKey: string | null,
): Readonly<Record<string, unknown>> {
  return {
    id: eventId,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: EVENT_CREATED,
    data: {
      object: {
        id: refundId,
        object: "refund",
        amount: Number(createInput.amountMinor),
        charge: CHARGE_ID,
        payment_intent: createInput.paymentIntentId,
        currency: "eur",
        status: "succeeded",
        created: EVENT_CREATED,
        metadata: createInput.metadata,
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: {
      id: "req_Phase0RaceHarness",
      idempotency_key: eventIdempotencyKey,
    },
    type: "refund.created",
  };
}

function signedWebhookRequest(event: Readonly<Record<string, unknown>>): Request {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: SIGNING_SECRET,
    timestamp: EVENT_CREATED,
  });
  return new Request("http://localhost/api/webhooks/stripe-account/test", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
}

async function deliverWebhook(input: {
  readonly event: Readonly<Record<string, unknown>>;
  readonly persistence: HarnessWebhookPersistence;
}): Promise<Readonly<Record<string, unknown>>> {
  const dependencies: AccountWebhookDependencies = {
    expectedApplicationId: "ca_refunddesk",
    expectedAccountId: ACCOUNT_ID,
    expectedApiVersion: "2026-06-24.dahlia",
    signingSecrets: [SIGNING_SECRET],
    constructEvent: (rawBody, signature, secret) =>
      Stripe.webhooks.constructEvent(rawBody, signature, secret, 300, undefined, EVENT_CREATED),
    persistence: input.persistence,
    now: () => RECEIVED_AT,
  };
  const response = await receiveAccountWebhook(
    signedWebhookRequest(input.event),
    "test",
    dependencies,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Readonly<Record<string, unknown>>;
}

describe("P0-WEBHOOK-005 deterministic webhook-before-response harness", () => {
  it("keeps a nullable-idempotency webhook pending until the same API Refund is bound", async () => {
    const trace: string[] = [];
    const store = new Phase0Store();
    const stripe = new DeferredRefundGateway(trace);
    const persistence = new HarnessWebhookPersistence(trace, store);
    const execution = executePhase0Probe(probeInput(), { stripe, store, proofKey: PROOF_KEY });
    const createInput = await stripe.waitForCreateCall();

    expect(trace).toEqual(["payment_retrieved", "refund_create_started"]);
    expect(store.report(ACCOUNT_ID, "test").probes).toBe(1);

    const webhookResult = await deliverWebhook({
      event: refundEvent(createInput, "evt_Phase0RaceBeforeResponse", FIRST_REFUND_ID, null),
      persistence,
    });

    expect(webhookResult).toMatchObject({
      received: true,
    });
    expect(webhookResult).not.toHaveProperty("phase0_correlation");
    expect(persistence.correlations).toEqual(["pending_correlation"]);
    expect(store.report(ACCOUNT_ID, "test").evidence.map((item) => item.correlation)).toEqual([
      "pending_correlation",
    ]);
    expect(trace).toEqual([
      "payment_retrieved",
      "refund_create_started",
      "webhook_persisted:evt_Phase0RaceBeforeResponse",
      "webhook_observed:evt_Phase0RaceBeforeResponse",
    ]);

    stripe.releaseApiResponse(createInput);
    const result = await execution;
    trace.push("probe_completed");

    expect(result.refund.id).toBe(FIRST_REFUND_ID);
    expect(result.correlation).toBe("internal");
    expect(store.report(ACCOUNT_ID, "test").evidence.map((item) => item.correlation)).toEqual([
      "pending_correlation",
      "internal",
    ]);
    expect(store.bindApiResponse(ACCOUNT_ID, "test", REQUEST_NONCE, FIRST_REFUND_ID)).toBe(
      "internal",
    );
    expect(store.bindApiResponse(ACCOUNT_ID, "test", REQUEST_NONCE, SECOND_REFUND_ID)).toBe(
      "proof_replay",
    );
    expect(trace).toEqual([
      "payment_retrieved",
      "refund_create_started",
      "webhook_persisted:evt_Phase0RaceBeforeResponse",
      "webhook_observed:evt_Phase0RaceBeforeResponse",
      "api_response_released",
      "probe_completed",
    ]);
  });

  it("preserves a Refund linked by the Event idempotency key before the API response", async () => {
    const trace: string[] = [];
    const store = new Phase0Store();
    const stripe = new DeferredRefundGateway(trace);
    const persistence = new HarnessWebhookPersistence(trace, store);
    const execution = executePhase0Probe(probeInput(), { stripe, store, proofKey: PROOF_KEY });
    const createInput = await stripe.waitForCreateCall();

    const webhookResult = await deliverWebhook({
      event: refundEvent(
        createInput,
        "evt_Phase0RaceIdempotency",
        FIRST_REFUND_ID,
        createInput.idempotencyKey,
      ),
      persistence,
    });

    expect(webhookResult).toMatchObject({
      received: true,
    });
    expect(webhookResult).not.toHaveProperty("phase0_correlation");
    expect(persistence.correlations).toEqual(["internal"]);
    expect(store.report(ACCOUNT_ID, "test").evidence.map((item) => item.correlation)).toEqual([
      "internal",
    ]);

    stripe.releaseApiResponse(createInput);
    const result = await execution;

    expect(result.refund.id).toBe(FIRST_REFUND_ID);
    expect(result.correlation).toBe("internal");

    const copiedProofResult = await deliverWebhook({
      event: refundEvent(createInput, "evt_Phase0RaceCopiedProof", SECOND_REFUND_ID, null),
      persistence,
    });

    expect(copiedProofResult).toMatchObject({
      received: true,
    });
    expect(copiedProofResult).not.toHaveProperty("phase0_correlation");
    expect(persistence.correlations).toEqual(["internal", "proof_replay"]);
    expect(store.bindApiResponse(ACCOUNT_ID, "test", REQUEST_NONCE, FIRST_REFUND_ID)).toBe(
      "internal",
    );
    expect(store.bindApiResponse(ACCOUNT_ID, "test", REQUEST_NONCE, SECOND_REFUND_ID)).toBe(
      "proof_replay",
    );
    expect(store.report(ACCOUNT_ID, "test").evidence.map((item) => item.correlation)).toEqual([
      "internal",
      "proof_replay",
    ]);
  });
});
