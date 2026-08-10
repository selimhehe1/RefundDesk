import { QUEUES } from "./jobs.js";
import type {
  Clock,
  ReconciliationCheckpoint,
  ScannableWorkerInstallation,
  WorkerStore,
} from "./ports.js";

const SECOND_MILLISECONDS = 1_000;
const MINUTE_MILLISECONDS = 60 * SECOND_MILLISECONDS;

export const DEFAULT_WORKER_READINESS_THRESHOLDS = Object.freeze({
  consumerPollMaxAgeMs: 15 * SECOND_MILLISECONDS,
  scannerMaxLagMs: 30 * MINUTE_MILLISECONDS,
  scannerWarmupMs: 30 * MINUTE_MILLISECONDS,
  futureTimestampToleranceMs: 5 * SECOND_MILLISECONDS,
});

export const WORKER_CONSUMER_CONCURRENCY = Object.freeze({
  [QUEUES.executeRefund]: 4,
  [QUEUES.processWebhook]: 8,
  [QUEUES.recoverWebhooks]: 1,
  [QUEUES.recoverApproved]: 1,
  [QUEUES.scanRefunds]: 1,
  [QUEUES.expireRequests]: 1,
} as const);

export const EXPECTED_WORKER_CONSUMERS = Object.freeze([
  {
    queue: QUEUES.executeRefund,
    localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.executeRefund],
    maxRunningAgeMs: 10 * MINUTE_MILLISECONDS,
  },
  {
    queue: QUEUES.processWebhook,
    localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.processWebhook],
    maxRunningAgeMs: 5 * MINUTE_MILLISECONDS,
  },
  {
    queue: QUEUES.recoverWebhooks,
    localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.recoverWebhooks],
    maxRunningAgeMs: 55 * SECOND_MILLISECONDS,
  },
  {
    queue: QUEUES.recoverApproved,
    localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.recoverApproved],
    maxRunningAgeMs: 55 * SECOND_MILLISECONDS,
  },
  {
    queue: QUEUES.scanRefunds,
    localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.scanRefunds],
    maxRunningAgeMs: 14 * MINUTE_MILLISECONDS,
  },
  {
    queue: QUEUES.expireRequests,
    localConcurrency: WORKER_CONSUMER_CONCURRENCY[QUEUES.expireRequests],
    maxRunningAgeMs: 4 * MINUTE_MILLISECONDS,
  },
] as const);

const EXPECTED_WORKER_CONSUMER_COUNT = EXPECTED_WORKER_CONSUMERS.reduce(
  (count, consumer) => count + consumer.localConcurrency,
  0,
);

export const EXPECTED_WORKER_SCHEDULES = Object.freeze([
  {
    queue: QUEUES.recoverWebhooks,
    key: "pilot_webhook_recovery_v1",
    cron: "* * * * *",
    timezone: "UTC",
    scope: "recoverable",
  },
  {
    queue: QUEUES.recoverApproved,
    key: "pilot_approved_recovery_v1",
    cron: "* * * * *",
    timezone: "UTC",
    scope: "approved",
  },
  {
    queue: QUEUES.scanRefunds,
    key: "pilot_refund_scan_v1",
    cron: "*/15 * * * *",
    timezone: "UTC",
    scope: "all",
  },
  {
    queue: QUEUES.expireRequests,
    key: "pilot_request_expire_v1",
    cron: "*/5 * * * *",
    timezone: "UTC",
    scope: "due",
  },
] as const);

export type PgBossConsumerState = "created" | "active" | "stopping" | "stopped";

/**
 * Minimal, redacted projection of pg-boss WIP state. In particular, worker IDs,
 * job payloads and error objects never cross the readiness boundary.
 */
export interface WorkerConsumerSnapshot {
  readonly name: string;
  readonly state: PgBossConsumerState;
  readonly count: number;
  readonly createdOn: number;
  readonly lastFetchedOn: number | null;
  readonly lastJobStartedOn: number | null;
}

/**
 * Minimal schedule projection. `data` is checked as an exact one-field scope
 * object so an unexpected scheduled command fails closed.
 */
export interface WorkerScheduleSnapshot {
  readonly name: string;
  readonly key: string;
  readonly cron: string;
  readonly timezone: string;
  readonly data?: unknown;
}

export interface WorkerRuntimeSnapshot {
  readonly stopping: boolean;
  readonly globalLiveEnabled: boolean;
  readonly schedulingEnabled: boolean;
  readonly consumers: readonly WorkerConsumerSnapshot[];
  readonly schedules: readonly WorkerScheduleSnapshot[];
}

export interface WorkerRuntimeReadinessSource {
  snapshot(): Promise<WorkerRuntimeSnapshot>;
}

export interface PgBossReadinessClient {
  getWipData(options?: { readonly includeInternal?: boolean }): readonly WorkerConsumerSnapshot[];
  getSchedules(name?: string, key?: string): Promise<readonly WorkerScheduleSnapshot[]>;
}

export interface PgBossRuntimeReadinessSourceOptions {
  readonly boss: PgBossReadinessClient;
  readonly isStopping: () => boolean;
  readonly isGlobalLiveEnabled: () => boolean;
  readonly schedulingEnabled: boolean;
}

/**
 * Adapts a running PgBoss instance without retaining identifiers, errors or job
 * data from WIP records. `isStopping` is evaluated after the asynchronous
 * schedule read so a concurrent graceful shutdown fails readiness promptly.
 */
export function createPgBossRuntimeReadinessSource(
  options: PgBossRuntimeReadinessSourceOptions,
): WorkerRuntimeReadinessSource {
  return {
    async snapshot(): Promise<WorkerRuntimeSnapshot> {
      const consumers = options.boss.getWipData({ includeInternal: false }).map((consumer) => ({
        name: consumer.name,
        state: consumer.state,
        count: consumer.count,
        createdOn: consumer.createdOn,
        lastFetchedOn: consumer.lastFetchedOn,
        lastJobStartedOn: consumer.lastJobStartedOn,
      }));
      const schedules = options.schedulingEnabled
        ? (await options.boss.getSchedules()).map((schedule) => ({
            name: schedule.name,
            key: schedule.key,
            cron: schedule.cron,
            timezone: schedule.timezone,
            ...("data" in schedule ? { data: schedule.data } : {}),
          }))
        : [];
      return {
        stopping: options.isStopping(),
        globalLiveEnabled: options.isGlobalLiveEnabled(),
        schedulingEnabled: options.schedulingEnabled,
        consumers,
        schedules,
      };
    },
  };
}

export type ScannerCoverageStatus =
  "unchecked" | "no_installations" | "warming" | "fresh" | "stale";

export type WorkerReadinessFailureCode =
  | "process_stopping"
  | "live_enabled"
  | "consumer_unavailable"
  | "schedule_mismatch"
  | "scanner_stale"
  | "dependency_unavailable";

export type WorkerReadinessResult =
  | {
      readonly ready: true;
      readonly scanner: Exclude<ScannerCoverageStatus, "unchecked" | "stale">;
    }
  | {
      readonly ready: false;
      readonly scanner: ScannerCoverageStatus;
      readonly code: WorkerReadinessFailureCode;
    };

export interface WorkerReadinessProbe {
  check(): Promise<WorkerReadinessResult>;
}

type ScannerReadinessStore = Pick<
  WorkerStore,
  "listScannableInstallations" | "loadReconciliationCheckpoint"
>;

export interface WorkerReadinessThresholds {
  readonly consumerPollMaxAgeMs: number;
  readonly scannerMaxLagMs: number;
  readonly scannerWarmupMs: number;
  readonly futureTimestampToleranceMs: number;
}

export interface WorkerReadinessDependencies {
  readonly runtime: WorkerRuntimeReadinessSource;
  readonly store: ScannerReadinessStore;
  readonly clock: Clock;
  readonly thresholds?: Partial<WorkerReadinessThresholds>;
}

export type IncidentAdmissionReadinessDependencies = Pick<
  WorkerReadinessDependencies,
  "runtime" | "clock" | "thresholds"
>;

type ScannerCoverageResult =
  | {
      readonly ready: true;
      readonly status: Exclude<ScannerCoverageStatus, "unchecked" | "stale">;
    }
  | {
      readonly ready: false;
      readonly status: "stale";
    };

function positiveFiniteThreshold(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function resolveThresholds(
  overrides: Partial<WorkerReadinessThresholds> | undefined,
): WorkerReadinessThresholds {
  const thresholds = {
    ...DEFAULT_WORKER_READINESS_THRESHOLDS,
    ...overrides,
  };
  if (
    !positiveFiniteThreshold(thresholds.consumerPollMaxAgeMs) ||
    !positiveFiniteThreshold(thresholds.scannerMaxLagMs) ||
    !positiveFiniteThreshold(thresholds.scannerWarmupMs) ||
    !positiveFiniteThreshold(thresholds.futureTimestampToleranceMs)
  ) {
    throw new Error("INVALID_WORKER_READINESS_THRESHOLDS");
  }
  return thresholds;
}

function timestampIsWithinAge(
  timestamp: number,
  nowMs: number,
  maxAgeMs: number,
  futureToleranceMs: number,
): boolean {
  return (
    Number.isFinite(timestamp) &&
    timestamp <= nowMs + futureToleranceMs &&
    nowMs - timestamp <= maxAgeMs
  );
}

function consumerIsHealthy(
  consumer: WorkerConsumerSnapshot,
  nowMs: number,
  maxRunningAgeMs: number,
  thresholds: WorkerReadinessThresholds,
): boolean {
  if (
    consumer.state !== "active" ||
    !Number.isSafeInteger(consumer.count) ||
    consumer.count < 0 ||
    !Number.isFinite(consumer.createdOn) ||
    consumer.lastFetchedOn === null
  ) {
    return false;
  }

  if (consumer.count === 0) {
    return timestampIsWithinAge(
      consumer.lastFetchedOn,
      nowMs,
      thresholds.consumerPollMaxAgeMs,
      thresholds.futureTimestampToleranceMs,
    );
  }

  if (consumer.lastJobStartedOn === null) {
    return false;
  }

  return (
    timestampIsWithinAge(
      consumer.lastJobStartedOn,
      nowMs,
      maxRunningAgeMs,
      thresholds.futureTimestampToleranceMs,
    ) &&
    consumer.lastFetchedOn <= consumer.lastJobStartedOn + thresholds.futureTimestampToleranceMs &&
    consumer.lastFetchedOn <= nowMs + thresholds.futureTimestampToleranceMs
  );
}

function consumersAreReady(
  consumers: readonly WorkerConsumerSnapshot[],
  nowMs: number,
  thresholds: WorkerReadinessThresholds,
): boolean {
  if (consumers.length !== EXPECTED_WORKER_CONSUMER_COUNT) {
    return false;
  }
  const expectedQueues: ReadonlySet<string> = new Set(
    EXPECTED_WORKER_CONSUMERS.map((consumer) => consumer.queue),
  );
  if (consumers.some((consumer) => !expectedQueues.has(consumer.name))) {
    return false;
  }

  return EXPECTED_WORKER_CONSUMERS.every((expected) => {
    const matchingConsumers = consumers.filter((consumer) => consumer.name === expected.queue);
    return (
      matchingConsumers.length === expected.localConcurrency &&
      matchingConsumers.every((consumer) =>
        consumerIsHealthy(consumer, nowMs, expected.maxRunningAgeMs, thresholds),
      )
    );
  });
}

function hasExactScope(data: unknown, scope: string): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const keys = Object.keys(data);
  return (
    keys.length === 1 &&
    keys[0] === "scope" &&
    "scope" in data &&
    (data as { readonly scope?: unknown }).scope === scope
  );
}

function schedulesAreReady(schedules: readonly WorkerScheduleSnapshot[]): boolean {
  if (schedules.length !== EXPECTED_WORKER_SCHEDULES.length) {
    return false;
  }

  return EXPECTED_WORKER_SCHEDULES.every((expected) => {
    const matches = schedules.filter(
      (schedule) =>
        schedule.name === expected.queue &&
        schedule.key === expected.key &&
        schedule.cron === expected.cron &&
        schedule.timezone === expected.timezone &&
        hasExactScope(schedule.data, expected.scope),
    );
    return matches.length === 1;
  });
}

function validPilotInstallation(installation: ScannableWorkerInstallation): boolean {
  return (
    installation.active &&
    installation.environment !== "live" &&
    !installation.tenantLiveEnabled &&
    !Number.isNaN(installation.installedAt.getTime())
  );
}

function validCheckpoint(
  checkpoint: ReconciliationCheckpoint,
  nowMs: number,
  thresholds: WorkerReadinessThresholds,
): boolean {
  const windowEndMs = checkpoint.windowEnd.getTime();
  return (
    !Number.isNaN(windowEndMs) &&
    timestampIsWithinAge(
      windowEndMs,
      nowMs,
      thresholds.scannerMaxLagMs,
      thresholds.futureTimestampToleranceMs,
    )
  );
}

async function evaluateScannerCoverage(
  store: ScannerReadinessStore,
  nowMs: number,
  thresholds: WorkerReadinessThresholds,
): Promise<ScannerCoverageResult> {
  const installations = await store.listScannableInstallations();
  if (installations.length === 0) {
    return { ready: true, status: "no_installations" };
  }

  let warming = false;
  for (const installation of installations) {
    if (!validPilotInstallation(installation)) {
      return { ready: false, status: "stale" };
    }
    const installedAtMs = installation.installedAt.getTime();
    if (installedAtMs > nowMs + thresholds.futureTimestampToleranceMs) {
      return { ready: false, status: "stale" };
    }

    const checkpoint = await store.loadReconciliationCheckpoint(
      installation.tenantId,
      installation.installationId,
    );
    if (checkpoint === null) {
      if (nowMs - installedAtMs <= thresholds.scannerWarmupMs) {
        warming = true;
        continue;
      }
      return { ready: false, status: "stale" };
    }
    if (!validCheckpoint(checkpoint, nowMs, thresholds)) {
      return { ready: false, status: "stale" };
    }
  }

  return { ready: true, status: warming ? "warming" : "fresh" };
}

export async function evaluateWorkerReadiness(
  dependencies: WorkerReadinessDependencies,
): Promise<WorkerReadinessResult> {
  let thresholds: WorkerReadinessThresholds;
  let runtime: WorkerRuntimeSnapshot;
  let nowMs: number;
  try {
    thresholds = resolveThresholds(dependencies.thresholds);
    runtime = await dependencies.runtime.snapshot();
    nowMs = dependencies.clock.now().getTime();
  } catch {
    return {
      ready: false,
      scanner: "unchecked",
      code: "dependency_unavailable",
    };
  }

  if (!Number.isFinite(nowMs)) {
    return {
      ready: false,
      scanner: "unchecked",
      code: "dependency_unavailable",
    };
  }
  if (runtime.stopping) {
    return {
      ready: false,
      scanner: "unchecked",
      code: "process_stopping",
    };
  }
  if (runtime.globalLiveEnabled) {
    return {
      ready: false,
      scanner: "unchecked",
      code: "live_enabled",
    };
  }
  if (!runtime.schedulingEnabled) {
    return { ready: false, scanner: "unchecked", code: "schedule_mismatch" };
  }
  if (!consumersAreReady(runtime.consumers, nowMs, thresholds)) {
    return {
      ready: false,
      scanner: "unchecked",
      code: "consumer_unavailable",
    };
  }
  if (!schedulesAreReady(runtime.schedules)) {
    return {
      ready: false,
      scanner: "unchecked",
      code: "schedule_mismatch",
    };
  }

  try {
    const scanner = await evaluateScannerCoverage(dependencies.store, nowMs, thresholds);
    if (!scanner.ready) {
      return {
        ready: false,
        scanner: scanner.status,
        code: "scanner_stale",
      };
    }
    return {
      ready: true,
      scanner: scanner.status,
    };
  } catch {
    return {
      ready: false,
      scanner: "unchecked",
      code: "dependency_unavailable",
    };
  }
}

/**
 * Readiness for the one-shot ADR 0036 runtime. It deliberately has no scanner
 * dependency: the incident runtime may consume only the refund-execution queue
 * and must expose neither schedules nor any other consumer.
 */
export async function evaluateIncidentAdmissionReadiness(
  dependencies: IncidentAdmissionReadinessDependencies,
): Promise<WorkerReadinessResult> {
  let thresholds: WorkerReadinessThresholds;
  let runtime: WorkerRuntimeSnapshot;
  let nowMs: number;
  try {
    thresholds = resolveThresholds(dependencies.thresholds);
    runtime = await dependencies.runtime.snapshot();
    nowMs = dependencies.clock.now().getTime();
  } catch {
    return { ready: false, scanner: "unchecked", code: "dependency_unavailable" };
  }
  if (!Number.isFinite(nowMs)) {
    return { ready: false, scanner: "unchecked", code: "dependency_unavailable" };
  }
  if (runtime.stopping) {
    return { ready: false, scanner: "unchecked", code: "process_stopping" };
  }
  if (runtime.globalLiveEnabled) {
    return { ready: false, scanner: "unchecked", code: "live_enabled" };
  }
  if (runtime.schedulingEnabled) {
    return { ready: false, scanner: "unchecked", code: "schedule_mismatch" };
  }
  const consumers = runtime.consumers;
  const expectedCount = WORKER_CONSUMER_CONCURRENCY[QUEUES.executeRefund];
  if (
    runtime.schedules.length !== 0 ||
    consumers.length !== expectedCount ||
    consumers.some(
      (consumer) =>
        consumer.name !== QUEUES.executeRefund ||
        !consumerIsHealthy(consumer, nowMs, 10 * MINUTE_MILLISECONDS, thresholds),
    )
  ) {
    return {
      ready: false,
      scanner: "unchecked",
      code: runtime.schedules.length === 0 ? "consumer_unavailable" : "schedule_mismatch",
    };
  }
  return { ready: true, scanner: "no_installations" };
}

export function createIncidentAdmissionReadinessProbe(
  dependencies: IncidentAdmissionReadinessDependencies,
): WorkerReadinessProbe {
  return {
    check: () => evaluateIncidentAdmissionReadiness(dependencies),
  };
}

export function createWorkerReadinessProbe(
  dependencies: WorkerReadinessDependencies,
): WorkerReadinessProbe {
  return {
    check: () => evaluateWorkerReadiness(dependencies),
  };
}
