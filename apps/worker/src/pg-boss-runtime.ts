import { createHash } from "node:crypto";

import { PgBoss, type Job } from "pg-boss";

import type { WorkerConfig } from "@refunddesk/config";

import type { WorkerDependencies } from "./dependencies.js";
import { handleApprovedExecutionRecoveryJob } from "./execution-recovery.js";
import { handleExpirationJob } from "./expiration.js";
import {
  executeRefundJobSchema,
  expireRequestsJobSchema,
  processWebhookJobSchema,
  QUEUES,
  recoverApprovedJobSchema,
  recoverWebhooksJobSchema,
  scanRefundsJobSchema,
  type ExecuteRefundJob,
  type ProcessWebhookJob,
} from "./jobs.js";
import { handleReconciliationScanJob } from "./reconciliation-scanner.js";
import {
  createPgBossRuntimeReadinessSource,
  createWorkerReadinessProbe,
  WORKER_CONSUMER_CONCURRENCY,
  type WorkerReadinessProbe,
} from "./readiness.js";
import { handleRefundExecutionJob } from "./refund-execution.js";
import { assertPilotConfiguration } from "./safety.js";
import { handleWebhookJob } from "./webhook-processing.js";
import { handleWebhookRecoveryJob } from "./webhook-recovery.js";

const queueOptions = {
  [QUEUES.executeRefund]: {
    policy: "exclusive",
    retryLimit: 8,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 600,
    retentionSeconds: 365 * 24 * 60 * 60,
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  },
  [QUEUES.processWebhook]: {
    retryLimit: 10,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 300,
    retentionSeconds: 90 * 24 * 60 * 60,
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  },
  [QUEUES.recoverWebhooks]: {
    policy: "exclusive",
    retryLimit: 5,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 120,
    expireInSeconds: 55,
    retentionSeconds: 24 * 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
  },
  [QUEUES.recoverApproved]: {
    policy: "exclusive",
    retryLimit: 5,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 120,
    expireInSeconds: 55,
    retentionSeconds: 24 * 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
  },
  [QUEUES.scanRefunds]: {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 14 * 60,
    retentionSeconds: 90 * 24 * 60 * 60,
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  },
  [QUEUES.expireRequests]: {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 240,
    retentionSeconds: 90 * 24 * 60 * 60,
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  },
} as const;

function singletonKey(tenantId: string, requestId: string): string {
  return createHash("sha256").update(`${tenantId}\0${requestId}`, "utf8").digest("hex");
}

async function handleOne<T>(
  jobs: readonly Job<T>[],
  handler: (data: T) => Promise<void>,
): Promise<void> {
  if (jobs.length !== 1) {
    throw new Error("PGBOSS_SINGLE_JOB_INVARIANT");
  }
  const job = jobs[0];
  if (job === undefined) {
    throw new Error("PGBOSS_SINGLE_JOB_INVARIANT");
  }
  await handler(job.data);
}

export class WorkerQueuePublisher {
  constructor(private readonly boss: PgBoss) {}

  async enqueueRefundExecution(untrustedJob: unknown): Promise<string | null> {
    const job: ExecuteRefundJob = executeRefundJobSchema.parse(untrustedJob);
    return this.boss.send(QUEUES.executeRefund, job, {
      singletonKey: singletonKey(job.tenant_id, job.request_id),
      retryLimit: queueOptions[QUEUES.executeRefund].retryLimit,
      retryDelay: queueOptions[QUEUES.executeRefund].retryDelay,
      retryBackoff: true,
      retryDelayMax: queueOptions[QUEUES.executeRefund].retryDelayMax,
    });
  }

  async enqueueWebhook(untrustedJob: unknown): Promise<string | null> {
    const job: ProcessWebhookJob = processWebhookJobSchema.parse(untrustedJob);
    return this.boss.send(QUEUES.processWebhook, job, {
      singletonKey: singletonKey(job.tenant_id, job.receipt_id),
      retryLimit: queueOptions[QUEUES.processWebhook].retryLimit,
      retryDelay: queueOptions[QUEUES.processWebhook].retryDelay,
      retryBackoff: true,
      retryDelayMax: queueOptions[QUEUES.processWebhook].retryDelayMax,
    });
  }
}

export interface RunningWorker {
  readonly publisher: WorkerQueuePublisher;
  readonly readiness: WorkerReadinessProbe;
  stop(): Promise<void>;
}

export interface PgBossLifecycle {
  start(): Promise<unknown>;
  stop(options: { readonly graceful: boolean; readonly timeout: number }): Promise<unknown>;
}

export async function startPgBossWithCleanup(
  boss: PgBossLifecycle,
  initialize: () => Promise<void>,
): Promise<void> {
  try {
    await boss.start();
    await initialize();
  } catch (error) {
    await boss.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
    throw error;
  }
}

export async function startPgBossWorker(
  config: WorkerConfig,
  dependencies: WorkerDependencies,
): Promise<RunningWorker> {
  assertPilotConfiguration(config);
  const boss = new PgBoss({
    connectionString: config.pgBossDatabaseUrl,
    application_name: "refunddesk-worker",
    createSchema: false,
    migrate: false,
    schedule: true,
    supervise: true,
    useListenNotify: false,
  });

  boss.on("error", () => {
    dependencies.logger.error({ code: "PGBOSS_ERROR" }, "pg-boss emitted an error");
  });
  boss.on("warning", () => {
    dependencies.logger.warn({ code: "PGBOSS_WARNING" }, "pg-boss emitted an operational warning");
  });

  const publisher = new WorkerQueuePublisher(boss);

  await startPgBossWithCleanup(boss, async () => {
    for (const queue of Object.values(QUEUES)) {
      await boss.createQueue(queue, queueOptions[queue]);
    }

    await boss.schedule(
      QUEUES.recoverWebhooks,
      "* * * * *",
      recoverWebhooksJobSchema.parse({ scope: "recoverable" }),
      { key: "pilot_webhook_recovery_v1" },
    );
    await boss.schedule(
      QUEUES.recoverApproved,
      "* * * * *",
      recoverApprovedJobSchema.parse({ scope: "approved" }),
      { key: "pilot_approved_recovery_v1" },
    );
    await boss.schedule(
      QUEUES.scanRefunds,
      "*/15 * * * *",
      scanRefundsJobSchema.parse({ scope: "all" }),
      { key: "pilot_refund_scan_v1" },
    );
    await boss.schedule(
      QUEUES.expireRequests,
      "*/5 * * * *",
      expireRequestsJobSchema.parse({ scope: "due" }),
      { key: "pilot_request_expire_v1" },
    );
    await handleReconciliationScanJob(scanRefundsJobSchema.parse({ scope: "all" }), dependencies);
    dependencies.logger.info(
      { queue: QUEUES.scanRefunds },
      "Startup reconciliation catch-up completed",
    );

    await boss.send(
      QUEUES.recoverWebhooks,
      recoverWebhooksJobSchema.parse({ scope: "recoverable" }),
    );
    await boss.send(QUEUES.recoverApproved, recoverApprovedJobSchema.parse({ scope: "approved" }));

    await boss.work<unknown>(
      QUEUES.executeRefund,
      {
        batchSize: 1,
        localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.executeRefund],
      },
      (jobs) => handleOne(jobs, (data) => handleRefundExecutionJob(data, dependencies)),
    );
    await boss.work<unknown>(
      QUEUES.processWebhook,
      {
        batchSize: 1,
        localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.processWebhook],
      },
      (jobs) => handleOne(jobs, (data) => handleWebhookJob(data, dependencies)),
    );
    await boss.work<unknown>(
      QUEUES.recoverWebhooks,
      {
        batchSize: 1,
        localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.recoverWebhooks],
      },
      (jobs) =>
        handleOne(jobs, (data) =>
          handleWebhookRecoveryJob(data, {
            store: dependencies.store,
            queue: publisher,
            logger: dependencies.logger,
          }),
        ),
    );
    await boss.work<unknown>(
      QUEUES.recoverApproved,
      {
        batchSize: 1,
        localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.recoverApproved],
      },
      (jobs) =>
        handleOne(jobs, (data) =>
          handleApprovedExecutionRecoveryJob(data, {
            store: dependencies.store,
            queue: publisher,
            logger: dependencies.logger,
          }),
        ),
    );
    await boss.work<unknown>(
      QUEUES.scanRefunds,
      {
        batchSize: 1,
        localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.scanRefunds],
      },
      (jobs) => handleOne(jobs, (data) => handleReconciliationScanJob(data, dependencies)),
    );
    await boss.work<unknown>(
      QUEUES.expireRequests,
      {
        batchSize: 1,
        localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.expireRequests],
      },
      (jobs) => handleOne(jobs, (data) => handleExpirationJob(data, dependencies)),
    );
  });

  dependencies.logger.info(
    { queueCount: Object.keys(QUEUES).length },
    "RefundDesk pilot worker started",
  );

  let stopping = false;
  const readiness = createWorkerReadinessProbe({
    runtime: createPgBossRuntimeReadinessSource({
      boss,
      isStopping: () => stopping,
      isGlobalLiveEnabled: () => config.liveEnabled,
    }),
    store: dependencies.store,
    clock: dependencies.clock,
  });

  return {
    publisher,
    readiness,
    async stop(): Promise<void> {
      stopping = true;
      await boss.stop({ graceful: true, timeout: 30_000 });
    },
  };
}
