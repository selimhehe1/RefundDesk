import { expireRequestsJobSchema, type ExpireRequestsJob } from "./jobs.js";
import type { Clock, WorkerLogger, WorkerStore } from "./ports.js";

const EXPIRATION_BATCH_SIZE = 500;
const MAX_BATCHES_PER_JOB = 100;

export interface ExpirationDependencies {
  readonly store: WorkerStore;
  readonly clock: Clock;
  readonly logger: WorkerLogger;
}

export async function handleExpirationJob(
  untrustedJob: unknown,
  dependencies: ExpirationDependencies,
): Promise<void> {
  const job: ExpireRequestsJob = expireRequestsJobSchema.parse(untrustedJob);
  void job;
  const now = dependencies.clock.now();
  let expiredCount = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_JOB; batch += 1) {
    const count = await dependencies.store.expireDueRequests(now, EXPIRATION_BATCH_SIZE);
    expiredCount += count;
    if (count < EXPIRATION_BATCH_SIZE) {
      dependencies.logger.info({ expiredCount }, "Expired pending refund requests");
      return;
    }
  }

  dependencies.logger.warn(
    {
      code: "EXPIRATION_BATCH_LIMIT_REACHED",
      expiredCount,
    },
    "Expiration stopped at its bounded batch limit",
  );
}
