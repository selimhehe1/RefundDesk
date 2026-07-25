import { describe, expect, it } from "vitest";

import { handleExpirationJob } from "../src/expiration.js";
import { executeRefundJobSchema, processWebhookJobSchema } from "../src/jobs.js";
import { handleWebhookJob } from "../src/webhook-processing.js";
import {
  FakeLogger,
  FakeStore,
  INSTALLATION_ID,
  REQUEST_ID,
  TENANT_ID,
  fixedClock,
} from "./helpers.js";

const webhookJob = {
  tenant_id: TENANT_ID,
  installation_id: INSTALLATION_ID,
  receipt_id: "67f37649-b880-4bb9-847f-21da2cf53580",
  schema_version: 1,
  environment: "test",
  stripe_event_id: "evt_worker",
  stripe_account_id: "acct_testworker",
  event_idempotency_key: null,
  event_type: "refund.created",
  event_created: 1_893_499_200,
  refund: {
    refund_id: "re_worker",
    payment_intent_id: "pi_worker",
    charge_id: "ch_worker",
    amount_minor: "500",
    currency: "eur",
    status: "succeeded",
    created: 1_893_499_200,
    metadata_request_id: REQUEST_ID,
    metadata_proof: "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
} as const;

describe("strict worker jobs", () => {
  it("rejects unknown execution fields", () => {
    expect(() =>
      executeRefundJobSchema.parse({
        tenant_id: TENANT_ID,
        request_id: REQUEST_ID,
        unsafe_extra: true,
      }),
    ).toThrow();
  });

  it("bounds the nullable Event idempotency key", () => {
    expect(
      processWebhookJobSchema.parse({
        ...webhookJob,
        event_idempotency_key: "refunddesk:refund-request:example:v1",
      }).event_idempotency_key,
    ).toContain("refunddesk");
    expect(() =>
      processWebhookJobSchema.parse({
        ...webhookJob,
        event_idempotency_key: "x".repeat(256),
      }),
    ).toThrow();
  });
});

describe("asynchronous webhook processing", () => {
  it("passes only the normalized observation and secondary idempotency evidence", async () => {
    const store = new FakeStore();

    await handleWebhookJob(
      {
        ...webhookJob,
        event_idempotency_key: "refunddesk:refund-request:secondary:v1",
      },
      {
        store,
        clock: fixedClock,
        logger: new FakeLogger(),
      },
    );

    expect(store.observations).toHaveLength(1);
    const observation = store.observations[0];
    expect(observation?.source).toMatchObject({
      kind: "webhook",
      receiptId: webhookJob.receipt_id,
      stripeAccountId: webhookJob.stripe_account_id,
      eventIdempotencyKey: "refunddesk:refund-request:secondary:v1",
    });
    expect(observation?.refund).toMatchObject({
      refundId: "re_worker",
      amountMinor: 500n,
    });
  });

  it("fails closed for a live webhook job", async () => {
    const store = new FakeStore();

    await expect(
      handleWebhookJob(
        { ...webhookJob, environment: "live" },
        {
          store,
          clock: fixedClock,
          logger: new FakeLogger(),
        },
      ),
    ).rejects.toThrow("WEBHOOK_JOB_INVALID");
    expect(store.observations).toEqual([]);
  });
});

describe("request expiration", () => {
  it("processes bounded batches until the repository reports completion", async () => {
    const store = new FakeStore();
    store.expirationResults.splice(0, store.expirationResults.length, 500, 500, 17);

    await handleExpirationJob(
      { scope: "due" },
      {
        store,
        clock: fixedClock,
        logger: new FakeLogger(),
      },
    );

    expect(store.trace.filter((entry) => entry === "store.expire")).toHaveLength(3);
  });
});
