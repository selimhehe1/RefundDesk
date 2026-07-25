import {
  executeRefundJobSchema,
  recoverApprovedJobSchema,
  type RecoverApprovedJob,
} from "./jobs.js";
import type { WorkerLogger, WorkerStore } from "./ports.js";

const RECOVERY_BATCH_SIZE = 500;

export interface RefundExecutionEnqueuer {
  enqueueRefundExecution(untrustedJob: unknown): Promise<string | null>;
}

export interface ExecutionRecoveryDependencies {
  readonly store: WorkerStore;
  readonly queue: RefundExecutionEnqueuer;
  readonly logger: WorkerLogger;
}

export async function handleApprovedExecutionRecoveryJob(
  untrustedJob: unknown,
  dependencies: ExecutionRecoveryDependencies,
): Promise<void> {
  const job: RecoverApprovedJob = recoverApprovedJobSchema.parse(untrustedJob);
  void job;

  // The store prepares both never-started approved requests and orphaned
  // executing requests. Ambiguous `possible` effects are diverted to
  // reconciliation inside that database unit of work and are never returned.
  const candidates = await dependencies.store.listApprovedRefundExecutions(RECOVERY_BATCH_SIZE);
  let enqueuedCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;

  for (const candidate of candidates) {
    if (
      candidate.installation.tenantId !== candidate.tenantId ||
      !candidate.installation.active ||
      candidate.installation.environment === "live" ||
      candidate.installation.tenantLiveEnabled
    ) {
      skippedCount += 1;
      dependencies.logger.warn(
        {
          code: "EXECUTION_RECOVERY_CANDIDATE_REJECTED",
          requestId: candidate.requestId,
          tenantId: candidate.tenantId,
        },
        "Refund execution recovery skipped a fail-closed candidate",
      );
      continue;
    }

    const executionJob = executeRefundJobSchema.parse({
      tenant_id: candidate.tenantId,
      request_id: candidate.requestId,
    });
    const queuedId = await dependencies.queue.enqueueRefundExecution(executionJob);
    if (queuedId === null) {
      duplicateCount += 1;
    } else {
      enqueuedCount += 1;
    }
  }

  dependencies.logger.info(
    {
      candidateCount: candidates.length,
      duplicateCount,
      enqueuedCount,
      skippedCount,
    },
    "Refund execution recovery completed",
  );
}
