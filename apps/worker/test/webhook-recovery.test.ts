import { describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";

import type { ProcessWebhookJob } from "../src/jobs.js";
import { WorkerQueuePublisher } from "../src/pg-boss-runtime.js";
import { handleWebhookJob } from "../src/webhook-processing.js";
import { handleWebhookRecoveryJob, type WebhookRecoveryQueue } from "../src/webhook-recovery.js";
import { FakeLogger, FakeStore, INSTALLATION_ID, TENANT_ID, fixedClock } from "./helpers.js";

const receiptId = "67f37649-b880-4bb9-847f-21da2cf53580";
const refundJob: ProcessWebhookJob = {
  tenant_id: TENANT_ID,
  installation_id: INSTALLATION_ID,
  receipt_id: receiptId,
  stripe_event_id: "evt_recovery",
  stripe_account_id: "acct_testworker",
  schema_version: 1,
  environment: "test",
  event_type: "refund.created",
  event_created: 1_893_499_200,
  event_idempotency_key: null,
  refund: {
    refund_id: "re_recovery",
    payment_intent_id: "pi_worker",
    charge_id: "ch_worker",
    amount_minor: "500",
    currency: "eur",
    status: "succeeded",
    created: 1_893_499_200,
    metadata_request_id: null,
    metadata_proof: null,
  },
};

class FakeRecoveryQueue implements WebhookRecoveryQueue {
  readonly jobs: ProcessWebhookJob[] = [];
  returnNull = false;

  enqueueWebhook(job: ProcessWebhookJob): Promise<string | null> {
    this.jobs.push(job);
    return Promise.resolve(this.returnNull ? null : "job-recovery");
  }
}

class FakeBoss {
  readonly singletonKeys: Array<string | undefined> = [];

  send(
    _name: string,
    _data: unknown,
    options?: { readonly singletonKey?: string },
  ): Promise<string> {
    this.singletonKeys.push(options?.singletonKey);
    return Promise.resolve("job");
  }
}

describe("durable webhook receipt recovery", () => {
  it("enqueues each recoverable receipt after the store read has completed", async () => {
    const store = new FakeStore();
    const queue = new FakeRecoveryQueue();
    store.recoverableWebhookJobs.push(refundJob);

    await handleWebhookRecoveryJob(
      { scope: "recoverable" },
      { store, queue, logger: new FakeLogger() },
    );

    expect(store.trace).toEqual(["store.webhook.recoverable"]);
    expect(queue.jobs).toEqual([refundJob]);
  });

  it("treats an active singleton as already covered without mutating the receipt", async () => {
    const store = new FakeStore();
    const queue = new FakeRecoveryQueue();
    queue.returnNull = true;
    store.recoverableWebhookJobs.push(refundJob);

    await expect(
      handleWebhookRecoveryJob(
        { scope: "recoverable" },
        { store, queue, logger: new FakeLogger() },
      ),
    ).resolves.toBeUndefined();
    expect(store.failedWebhookReceipts).toEqual([]);
  });

  it("publishes a deterministic singleton per durable receipt", async () => {
    const boss = new FakeBoss();
    const publisher = new WorkerQueuePublisher(boss as unknown as PgBoss);

    await publisher.enqueueWebhook(refundJob);
    await publisher.enqueueWebhook(refundJob);

    expect(boss.singletonKeys[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(boss.singletonKeys[1]).toBe(boss.singletonKeys[0]);
  });

  it("routes lifecycle receipts and marks processing failures with constant codes", async () => {
    const lifecycleStore = new FakeStore();
    await handleWebhookJob(
      {
        tenant_id: TENANT_ID,
        installation_id: INSTALLATION_ID,
        receipt_id: receiptId,
        stripe_event_id: "evt_deauthorized",
        stripe_account_id: "acct_testworker",
        schema_version: 1,
        environment: "test",
        event_type: "account.application.deauthorized",
        event_created: 1_893_499_200,
        event_idempotency_key: null,
        application_id: "ca_refunddesk",
      },
      { store: lifecycleStore, clock: fixedClock, logger: new FakeLogger() },
    );
    expect(lifecycleStore.lifecycleEvents[0]).toMatchObject({
      eventType: "account.application.deauthorized",
      receiptId,
    });

    class FailingStore extends FakeStore {
      override observeRefund(): Promise<void> {
        return Promise.reject(new Error("sensitive proof must not escape"));
      }
    }
    const failingStore = new FailingStore();
    await expect(
      handleWebhookJob(refundJob, {
        store: failingStore,
        clock: fixedClock,
        logger: new FakeLogger(),
      }),
    ).rejects.toThrow("WEBHOOK_PROCESSING_FAILED");
    expect(failingStore.failedWebhookReceipts).toEqual([
      {
        tenantId: TENANT_ID,
        receiptId,
        errorCode: "WEBHOOK_PROCESSING_FAILED",
      },
    ]);
  });
});
