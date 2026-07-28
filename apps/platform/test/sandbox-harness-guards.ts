export const DISPOSABLE_POSTGRES_CLUSTER_CONSENT =
  "I_ACKNOWLEDGE_DEDICATED_DISPOSABLE_POSTGRES_CLUSTER";

export function assertDisposablePostgresCluster(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const consent = environment["REFUNDDESK_SANDBOX_E2E_DISPOSABLE_POSTGRES_CLUSTER"]?.trim();
  if (consent !== DISPOSABLE_POSTGRES_CLUSTER_CONSENT) {
    throw new Error("SANDBOX_E2E_DEDICATED_DISPOSABLE_POSTGRES_CLUSTER_REQUIRED");
  }
}

export function assertDedicatedPostgresClusterPreflight(input: {
  readonly connectedDatabase: string;
  readonly expectedControlDatabase: string;
  readonly harnessLockAcquired: boolean;
  readonly otherConnectableDatabaseCount: number;
}): void {
  if (input.connectedDatabase !== input.expectedControlDatabase) {
    throw new Error("SANDBOX_E2E_POSTGRES_CONTROL_DATABASE_MISMATCH");
  }
  if (!input.harnessLockAcquired) {
    throw new Error("SANDBOX_E2E_POSTGRES_HARNESS_ALREADY_RUNNING");
  }
  if (input.otherConnectableDatabaseCount !== 0) {
    throw new Error("SANDBOX_E2E_POSTGRES_CLUSTER_NOT_DEDICATED");
  }
}

export function assertExclusiveSingletonEnqueue(
  firstJobId: string | null,
  secondJobId: string | null,
): string {
  if (firstJobId === null || firstJobId.length === 0) {
    throw new Error("SANDBOX_E2E_QUEUE_SINGLETON_FIRST_JOB_REJECTED");
  }
  if (secondJobId !== null) {
    throw new Error("SANDBOX_E2E_QUEUE_SINGLETON_DUPLICATE_ACCEPTED");
  }
  return firstJobId;
}
