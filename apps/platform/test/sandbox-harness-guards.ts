export const DISPOSABLE_POSTGRES_CLUSTER_CONSENT =
  "I_ACKNOWLEDGE_DEDICATED_DISPOSABLE_POSTGRES_CLUSTER";

export const SANDBOX_E2E_SCENARIOS = ["normal", "pending_refund", "failed_refund_scanner"] as const;

export type SandboxE2EScenario = (typeof SANDBOX_E2E_SCENARIOS)[number];

export const SANDBOX_E2E_SCENARIO_PAYMENT_METHODS = {
  normal: "pm_card_visa",
  pending_refund: "pm_card_pendingRefund",
  failed_refund_scanner: "pm_card_refundFail",
} as const satisfies Readonly<Record<SandboxE2EScenario, string>>;

export function readSandboxE2EScenario(
  environment: Readonly<Record<string, string | undefined>>,
): SandboxE2EScenario {
  const selected = environment["REFUNDDESK_SANDBOX_E2E_SCENARIO"]?.trim();
  if (selected === "failed_refund_webhook") {
    throw new Error("SANDBOX_E2E_FAILED_REFUND_WEBHOOK_REQUIRES_HOSTED_SIGNED_DELIVERY");
  }
  if (
    selected !== "normal" &&
    selected !== "pending_refund" &&
    selected !== "failed_refund_scanner"
  ) {
    throw new Error("SANDBOX_E2E_SCENARIO_INVALID_OR_MISSING");
  }
  return selected;
}

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
