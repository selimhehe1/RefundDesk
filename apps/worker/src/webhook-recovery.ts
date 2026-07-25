import {
  recoverWebhooksJobSchema,
  type ProcessWebhookJob,
  type RecoverWebhooksJob,
} from "./jobs.js";
import type { WorkerLogger, WorkerStore } from "./ports.js";

const RECOVERY_BATCH_SIZE = 500;

export interface WebhookRecoveryQueue {
  enqueueWebhook(job: ProcessWebhookJob): Promise<string | null>;
}

export interface WebhookRecoveryDependencies {
  readonly store: WorkerStore;
  readonly queue: WebhookRecoveryQueue;
  readonly logger: WorkerLogger;
}

export async function handleWebhookRecoveryJob(
  untrustedJob: unknown,
  dependencies: WebhookRecoveryDependencies,
): Promise<void> {
  let job: RecoverWebhooksJob;
  try {
    job = recoverWebhooksJobSchema.parse(untrustedJob);
  } catch {
    throw new Error("WEBHOOK_RECOVERY_JOB_INVALID");
  }
  void job;

  let candidates: readonly ProcessWebhookJob[];
  try {
    candidates = await dependencies.store.listRecoverableWebhookJobs(RECOVERY_BATCH_SIZE);
  } catch {
    throw new Error("WEBHOOK_RECOVERY_READ_FAILED");
  }

  let enqueued = 0;
  for (const candidate of candidates) {
    try {
      const jobId = await dependencies.queue.enqueueWebhook(candidate);
      if (jobId !== null) {
        enqueued += 1;
      }
    } catch {
      dependencies.logger.warn(
        {
          code: "WEBHOOK_RECOVERY_ENQUEUE_FAILED",
          receiptId: candidate.receipt_id,
          tenantId: candidate.tenant_id,
        },
        "Recoverable webhook receipt could not be enqueued",
      );
      throw new Error("WEBHOOK_RECOVERY_ENQUEUE_FAILED");
    }
  }

  dependencies.logger.info(
    { candidateCount: candidates.length, enqueuedCount: enqueued },
    "Durable webhook receipt recovery completed",
  );
}
