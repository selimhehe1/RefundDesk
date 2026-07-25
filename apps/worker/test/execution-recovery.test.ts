import { describe, expect, it } from "vitest";

import type { PgBoss } from "pg-boss";

import {
  handleApprovedExecutionRecoveryJob,
  type RefundExecutionEnqueuer,
} from "../src/execution-recovery.js";
import { QUEUES, type ExecuteRefundJob } from "../src/jobs.js";
import { WorkerQueuePublisher } from "../src/pg-boss-runtime.js";
import { FakeLogger, FakeStore, REQUEST_ID, TENANT_ID, executionRecord } from "./helpers.js";

class FakeExecutionQueue implements RefundExecutionEnqueuer {
  readonly jobs: ExecuteRefundJob[] = [];
  duplicate = false;

  enqueueRefundExecution(untrustedJob: unknown): Promise<string | null> {
    const job = untrustedJob as ExecuteRefundJob;
    this.jobs.push(job);
    return Promise.resolve(this.duplicate ? null : `job-${this.jobs.length}`);
  }
}

class FakeBoss {
  readonly calls: Array<{
    name: string;
    data: unknown;
    options: { singletonKey?: string } | undefined;
  }> = [];

  send(name: string, data: unknown, options?: { singletonKey?: string }): Promise<string> {
    this.calls.push({ name, data, options });
    return Promise.resolve(`job-${this.calls.length}`);
  }
}

describe("durable execution recovery", () => {
  it("republishes prepared approved or orphaned work without carrying an alternate key", async () => {
    const store = new FakeStore();
    const queue = new FakeExecutionQueue();
    const record = executionRecord();
    store.approvedExecutions.push({
      tenantId: record.tenantId,
      requestId: record.requestId,
      installation: record.installation,
    });

    await handleApprovedExecutionRecoveryJob(
      { scope: "approved" },
      {
        store,
        queue,
        logger: new FakeLogger(),
      },
    );

    expect(queue.jobs).toEqual([
      {
        tenant_id: TENANT_ID,
        request_id: REQUEST_ID,
      },
    ]);
    expect(queue.jobs[0]).not.toHaveProperty("idempotency_key");
  });

  it("treats an existing singleton job as a successful recovery outcome", async () => {
    const store = new FakeStore();
    const queue = new FakeExecutionQueue();
    queue.duplicate = true;
    const record = executionRecord();
    store.approvedExecutions.push({
      tenantId: record.tenantId,
      requestId: record.requestId,
      installation: record.installation,
    });

    await expect(
      handleApprovedExecutionRecoveryJob(
        { scope: "approved" },
        {
          store,
          queue,
          logger: new FakeLogger(),
        },
      ),
    ).resolves.toBeUndefined();
    expect(queue.jobs).toHaveLength(1);
  });

  it("publishes every retry candidate with the same per-request singleton key", async () => {
    const boss = new FakeBoss();
    const publisher = new WorkerQueuePublisher(boss as unknown as PgBoss);
    const job = {
      tenant_id: TENANT_ID,
      request_id: REQUEST_ID,
    };

    await publisher.enqueueRefundExecution(job);
    await publisher.enqueueRefundExecution(job);

    expect(boss.calls).toHaveLength(2);
    expect(boss.calls[0]?.name).toBe(QUEUES.executeRefund);
    expect(boss.calls[0]?.options?.singletonKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(boss.calls[1]?.options?.singletonKey).toBe(boss.calls[0]?.options?.singletonKey);
  });

  it("never republishes live-mode candidates", async () => {
    const store = new FakeStore();
    const queue = new FakeExecutionQueue();
    const record = executionRecord();
    store.approvedExecutions.push({
      tenantId: record.tenantId,
      requestId: record.requestId,
      installation: {
        ...record.installation,
        environment: "live",
        tenantLiveEnabled: true,
      },
    });

    await handleApprovedExecutionRecoveryJob(
      { scope: "approved" },
      {
        store,
        queue,
        logger: new FakeLogger(),
      },
    );

    expect(queue.jobs).toEqual([]);
  });

  it("rejects unknown recovery job fields", async () => {
    await expect(
      handleApprovedExecutionRecoveryJob(
        { scope: "approved", workflow_status: "reconciliation_required" },
        {
          store: new FakeStore(),
          queue: new FakeExecutionQueue(),
          logger: new FakeLogger(),
        },
      ),
    ).rejects.toThrow();
  });
});
