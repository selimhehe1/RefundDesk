import { describe, expect, it } from "vitest";

import { QUEUES } from "../src/jobs.js";
import type { Clock, ReconciliationCheckpoint, ScannableWorkerInstallation } from "../src/ports.js";
import {
  createPgBossRuntimeReadinessSource,
  DEFAULT_WORKER_READINESS_THRESHOLDS,
  evaluateWorkerReadiness,
  EXPECTED_WORKER_CONSUMERS,
  EXPECTED_WORKER_SCHEDULES,
  type WorkerConsumerSnapshot,
  type WorkerReadinessDependencies,
  type WorkerRuntimeSnapshot,
  type WorkerScheduleSnapshot,
} from "../src/readiness.js";

const NOW = new Date("2030-01-01T12:00:00.000Z");
const NOW_MS = NOW.getTime();

const clock: Clock = {
  now: () => new Date(NOW),
};

function healthyConsumers(): WorkerConsumerSnapshot[] {
  return EXPECTED_WORKER_CONSUMERS.flatMap((expected) =>
    Array.from({ length: expected.localConcurrency }, () => ({
      name: expected.queue,
      state: "active" as const,
      count: 0,
      createdOn: NOW_MS - 60_000,
      lastFetchedOn: NOW_MS - 1_000,
      lastJobStartedOn: null,
    })),
  );
}

function healthySchedules(): WorkerScheduleSnapshot[] {
  return EXPECTED_WORKER_SCHEDULES.map((expected) => ({
    name: expected.queue,
    key: expected.key,
    cron: expected.cron,
    timezone: expected.timezone,
    data: { scope: expected.scope },
  }));
}

function runtime(
  overrides: Partial<WorkerRuntimeSnapshot> = {},
): WorkerReadinessDependencies["runtime"] {
  return {
    snapshot: () =>
      Promise.resolve({
        stopping: false,
        globalLiveEnabled: false,
        consumers: healthyConsumers(),
        schedules: healthySchedules(),
        ...overrides,
      }),
  };
}

function installation(
  index: number,
  overrides: Partial<ScannableWorkerInstallation> = {},
): ScannableWorkerInstallation {
  const suffix = index.toString().padStart(12, "0");
  return {
    tenantId: `11111111-1111-4111-8111-${suffix}`,
    installationId: `22222222-2222-4222-8222-${suffix}`,
    stripeAccountId: `acct_readiness_${index}`,
    environment: "sandbox",
    active: true,
    tenantLiveEnabled: false,
    installedAt: new Date(NOW_MS - 5 * 60_000),
    ...overrides,
  };
}

class ScannerStore {
  readonly installations: ScannableWorkerInstallation[] = [];
  readonly checkpointCalls: Array<{
    readonly tenantId: string;
    readonly installationId: string;
  }> = [];
  readonly checkpoints = new Map<string, ReconciliationCheckpoint | null>();
  listError: Error | null = null;
  checkpointError: Error | null = null;

  listScannableInstallations(): Promise<readonly ScannableWorkerInstallation[]> {
    if (this.listError !== null) {
      return Promise.reject(this.listError);
    }
    return Promise.resolve(this.installations);
  }

  loadReconciliationCheckpoint(
    tenantId: string,
    installationId: string,
  ): Promise<ReconciliationCheckpoint | null> {
    this.checkpointCalls.push({ tenantId, installationId });
    if (this.checkpointError !== null) {
      return Promise.reject(this.checkpointError);
    }
    return Promise.resolve(this.checkpoints.get(installationId) ?? null);
  }
}

function dependencies(
  store: ScannerStore,
  overrides: Partial<WorkerReadinessDependencies> = {},
): WorkerReadinessDependencies {
  return {
    runtime: runtime(),
    store,
    clock,
    ...overrides,
  };
}

describe("worker runtime readiness", () => {
  it("is ready with all sixteen configured consumer instances and four exact schedules", async () => {
    const store = new ScannerStore();
    expect(healthyConsumers()).toHaveLength(16);

    await expect(evaluateWorkerReadiness(dependencies(store))).resolves.toEqual({
      ready: true,
      scanner: "no_installations",
    });
    expect(store.checkpointCalls).toEqual([]);
  });

  it("fails before database inspection once graceful shutdown starts", async () => {
    const store = new ScannerStore();
    store.listError = new Error("MUST_NOT_BE_REACHED");

    await expect(
      evaluateWorkerReadiness(
        dependencies(store, {
          runtime: runtime({
            stopping: true,
            consumers: [],
            schedules: [],
          }),
        }),
      ),
    ).resolves.toEqual({
      ready: false,
      scanner: "unchecked",
      code: "process_stopping",
    });
  });

  it("fails closed if the global live interlock is not false", async () => {
    const store = new ScannerStore();

    await expect(
      evaluateWorkerReadiness(
        dependencies(store, {
          runtime: runtime({ globalLiveEnabled: true }),
        }),
      ),
    ).resolves.toEqual({
      ready: false,
      scanner: "unchecked",
      code: "live_enabled",
    });
  });

  it.each([
    {
      name: "a queue has no consumer",
      mutate: (consumers: WorkerConsumerSnapshot[]) =>
        consumers.filter((consumer) => consumer.name !== QUEUES.processWebhook),
    },
    {
      name: "an unexpected queue is consumed",
      mutate: (consumers: WorkerConsumerSnapshot[]) => [
        ...consumers,
        {
          ...consumers[0]!,
          name: "refunddesk_unexpected_queue",
        },
      ],
    },
    {
      name: "an expected queue has one consumer too many",
      mutate: (consumers: WorkerConsumerSnapshot[]) => [...consumers, { ...consumers[0]! }],
    },
    {
      name: "an expected queue has one consumer too few",
      mutate: (consumers: WorkerConsumerSnapshot[]) => consumers.slice(1),
    },
    {
      name: "one expected consumer is stopping",
      mutate: (consumers: WorkerConsumerSnapshot[]) =>
        consumers.map((consumer) =>
          consumer.name === QUEUES.executeRefund
            ? { ...consumer, state: "stopping" as const }
            : consumer,
        ),
    },
    {
      name: "an idle consumer has never polled",
      mutate: (consumers: WorkerConsumerSnapshot[]) =>
        consumers.map((consumer) =>
          consumer.name === QUEUES.executeRefund ? { ...consumer, lastFetchedOn: null } : consumer,
        ),
    },
    {
      name: "an idle consumer poll is stale",
      mutate: (consumers: WorkerConsumerSnapshot[]) =>
        consumers.map((consumer) =>
          consumer.name === QUEUES.executeRefund
            ? {
                ...consumer,
                lastFetchedOn:
                  NOW_MS - DEFAULT_WORKER_READINESS_THRESHOLDS.consumerPollMaxAgeMs - 1,
              }
            : consumer,
        ),
    },
  ])("fails when $name", async ({ mutate }) => {
    const store = new ScannerStore();

    await expect(
      evaluateWorkerReadiness(
        dependencies(store, {
          runtime: runtime({ consumers: mutate(healthyConsumers()) }),
        }),
      ),
    ).resolves.toEqual({
      ready: false,
      scanner: "unchecked",
      code: "consumer_unavailable",
    });
  });

  it("treats a bounded running scan as healthy even though it cannot poll while handling the job", async () => {
    const store = new ScannerStore();
    const consumers = healthyConsumers().map((consumer) =>
      consumer.name === QUEUES.scanRefunds
        ? {
            ...consumer,
            count: 1,
            lastFetchedOn: NOW_MS - 5 * 60_000,
            lastJobStartedOn: NOW_MS - 5 * 60_000,
          }
        : consumer,
    );

    await expect(
      evaluateWorkerReadiness(
        dependencies(store, {
          runtime: runtime({ consumers }),
        }),
      ),
    ).resolves.toEqual({
      ready: true,
      scanner: "no_installations",
    });
  });

  it("fails a running job that exceeds its queue-specific safe age", async () => {
    const store = new ScannerStore();
    const consumers = healthyConsumers().map((consumer) =>
      consumer.name === QUEUES.scanRefunds
        ? {
            ...consumer,
            count: 1,
            lastFetchedOn: NOW_MS - 15 * 60_000,
            lastJobStartedOn: NOW_MS - 15 * 60_000,
          }
        : consumer,
    );

    await expect(
      evaluateWorkerReadiness(
        dependencies(store, {
          runtime: runtime({ consumers }),
        }),
      ),
    ).resolves.toEqual({
      ready: false,
      scanner: "unchecked",
      code: "consumer_unavailable",
    });
  });

  it.each([
    {
      name: "one schedule is missing",
      mutate: (schedules: WorkerScheduleSnapshot[]) => schedules.slice(1),
    },
    {
      name: "an extra schedule exists",
      mutate: (schedules: WorkerScheduleSnapshot[]) => [
        ...schedules,
        {
          name: "refunddesk_unexpected",
          key: "unexpected",
          cron: "* * * * *",
          timezone: "UTC",
          data: { scope: "all" },
        },
      ],
    },
    {
      name: "a key differs",
      mutate: (schedules: WorkerScheduleSnapshot[]) =>
        schedules.map((schedule) =>
          schedule.name === QUEUES.scanRefunds ? { ...schedule, key: "wrong" } : schedule,
        ),
    },
    {
      name: "a cron differs",
      mutate: (schedules: WorkerScheduleSnapshot[]) =>
        schedules.map((schedule) =>
          schedule.name === QUEUES.scanRefunds ? { ...schedule, cron: "* * * * *" } : schedule,
        ),
    },
    {
      name: "a timezone differs",
      mutate: (schedules: WorkerScheduleSnapshot[]) =>
        schedules.map((schedule) =>
          schedule.name === QUEUES.scanRefunds
            ? { ...schedule, timezone: "Europe/Paris" }
            : schedule,
        ),
    },
    {
      name: "a command scope has an additional field",
      mutate: (schedules: WorkerScheduleSnapshot[]) =>
        schedules.map((schedule) =>
          schedule.name === QUEUES.scanRefunds
            ? { ...schedule, data: { scope: "all", unsafe: true } }
            : schedule,
        ),
    },
  ])("requires exact schedules when $name", async ({ mutate }) => {
    const store = new ScannerStore();

    await expect(
      evaluateWorkerReadiness(
        dependencies(store, {
          runtime: runtime({ schedules: mutate(healthySchedules()) }),
        }),
      ),
    ).resolves.toEqual({
      ready: false,
      scanner: "unchecked",
      code: "schedule_mismatch",
    });
  });

  it("returns a generic dependency failure instead of propagating runtime details", async () => {
    const store = new ScannerStore();

    const result = await evaluateWorkerReadiness(
      dependencies(store, {
        runtime: {
          snapshot: () => Promise.reject(new Error("rk_test_sensitive_value")),
        },
      }),
    );

    expect(result).toEqual({
      ready: false,
      scanner: "unchecked",
      code: "dependency_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("rk_test_sensitive_value");
  });

  it("redacts pg-boss worker IDs, errors and schedule options from its runtime projection", async () => {
    let stopping = false;
    const rawConsumer = {
      ...healthyConsumers()[0]!,
      id: "worker-sensitive-id",
      workId: "work-sensitive-id",
      lastError: { message: "sensitive database failure" },
    };
    const rawSchedule = {
      ...healthySchedules()[0]!,
      options: { key: "sensitive-option" },
    };
    const source = createPgBossRuntimeReadinessSource({
      boss: {
        getWipData: () => [rawConsumer],
        getSchedules: () => {
          stopping = true;
          return Promise.resolve([rawSchedule]);
        },
      },
      isStopping: () => stopping,
      isGlobalLiveEnabled: () => false,
    });

    const snapshot = await source.snapshot();

    expect(snapshot.stopping).toBe(true);
    expect(snapshot.consumers).toEqual([
      {
        name: rawConsumer.name,
        state: rawConsumer.state,
        count: rawConsumer.count,
        createdOn: rawConsumer.createdOn,
        lastFetchedOn: rawConsumer.lastFetchedOn,
        lastJobStartedOn: rawConsumer.lastJobStartedOn,
      },
    ]);
    expect(snapshot.schedules).toEqual([healthySchedules()[0]]);
    expect(JSON.stringify(snapshot)).not.toContain("sensitive");
  });
});

describe("scanner checkpoint readiness", () => {
  it("allows a new installation to warm up without a checkpoint for thirty minutes", async () => {
    const store = new ScannerStore();
    store.installations.push(
      installation(1, {
        installedAt: new Date(NOW_MS - DEFAULT_WORKER_READINESS_THRESHOLDS.scannerWarmupMs + 1),
      }),
    );

    await expect(evaluateWorkerReadiness(dependencies(store))).resolves.toEqual({
      ready: true,
      scanner: "warming",
    });
  });

  it("fails an installation with no checkpoint once the warmup window expires", async () => {
    const store = new ScannerStore();
    store.installations.push(
      installation(1, {
        installedAt: new Date(NOW_MS - DEFAULT_WORKER_READINESS_THRESHOLDS.scannerWarmupMs - 1),
      }),
    );

    await expect(evaluateWorkerReadiness(dependencies(store))).resolves.toEqual({
      ready: false,
      scanner: "stale",
      code: "scanner_stale",
    });
  });

  it("accepts complete checkpoint coverage newer than thirty minutes", async () => {
    const store = new ScannerStore();
    const target = installation(1, {
      installedAt: new Date(NOW_MS - 24 * 60 * 60_000),
    });
    store.installations.push(target);
    store.checkpoints.set(target.installationId, {
      windowEnd: new Date(NOW_MS - 29 * 60_000),
    });

    await expect(evaluateWorkerReadiness(dependencies(store))).resolves.toEqual({
      ready: true,
      scanner: "fresh",
    });
  });

  it("fails when any installation checkpoint is older than thirty minutes", async () => {
    const store = new ScannerStore();
    const fresh = installation(1, {
      installedAt: new Date(NOW_MS - 24 * 60 * 60_000),
    });
    const stale = installation(2, {
      installedAt: new Date(NOW_MS - 24 * 60 * 60_000),
    });
    store.installations.push(fresh, stale);
    store.checkpoints.set(fresh.installationId, {
      windowEnd: new Date(NOW_MS - 5 * 60_000),
    });
    store.checkpoints.set(stale.installationId, {
      windowEnd: new Date(NOW_MS - DEFAULT_WORKER_READINESS_THRESHOLDS.scannerMaxLagMs - 1),
    });

    await expect(evaluateWorkerReadiness(dependencies(store))).resolves.toEqual({
      ready: false,
      scanner: "stale",
      code: "scanner_stale",
    });
  });

  it("reports warming when fresh and new installations coexist", async () => {
    const store = new ScannerStore();
    const fresh = installation(1, {
      installedAt: new Date(NOW_MS - 24 * 60 * 60_000),
    });
    const warming = installation(2);
    store.installations.push(fresh, warming);
    store.checkpoints.set(fresh.installationId, {
      windowEnd: new Date(NOW_MS - 5 * 60_000),
    });

    await expect(evaluateWorkerReadiness(dependencies(store))).resolves.toEqual({
      ready: true,
      scanner: "warming",
    });
    expect(store.checkpointCalls).toHaveLength(2);
  });

  it.each([
    {
      name: "a live installation leaks into the scan set",
      overrides: { environment: "live" as const },
    },
    {
      name: "tenant live is enabled",
      overrides: { tenantLiveEnabled: true },
    },
    {
      name: "the installation is inactive",
      overrides: { active: false },
    },
    {
      name: "the installation timestamp is materially in the future",
      overrides: {
        installedAt: new Date(
          NOW_MS + DEFAULT_WORKER_READINESS_THRESHOLDS.futureTimestampToleranceMs + 1,
        ),
      },
    },
  ])("fails closed when $name", async ({ overrides }) => {
    const store = new ScannerStore();
    store.installations.push(installation(1, overrides));

    await expect(evaluateWorkerReadiness(dependencies(store))).resolves.toEqual({
      ready: false,
      scanner: "stale",
      code: "scanner_stale",
    });
    expect(store.checkpointCalls).toEqual([]);
  });

  it("fails closed on a future checkpoint", async () => {
    const store = new ScannerStore();
    const target = installation(1, {
      installedAt: new Date(NOW_MS - 24 * 60 * 60_000),
    });
    store.installations.push(target);
    store.checkpoints.set(target.installationId, {
      windowEnd: new Date(
        NOW_MS + DEFAULT_WORKER_READINESS_THRESHOLDS.futureTimestampToleranceMs + 1,
      ),
    });

    await expect(evaluateWorkerReadiness(dependencies(store))).resolves.toEqual({
      ready: false,
      scanner: "stale",
      code: "scanner_stale",
    });
  });

  it("contains no store error or installation identifier when checkpoint inspection fails", async () => {
    const store = new ScannerStore();
    store.installations.push(installation(1));
    store.checkpointError = new Error("acct_sensitive_checkpoint_failure");

    const result = await evaluateWorkerReadiness(dependencies(store));

    expect(result).toEqual({
      ready: false,
      scanner: "unchecked",
      code: "dependency_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("acct_");
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("uses the injected clock and rejects invalid threshold configuration", async () => {
    const store = new ScannerStore();

    await expect(
      evaluateWorkerReadiness(
        dependencies(store, {
          clock: { now: () => new Date(Number.NaN) },
        }),
      ),
    ).resolves.toEqual({
      ready: false,
      scanner: "unchecked",
      code: "dependency_unavailable",
    });

    await expect(
      evaluateWorkerReadiness(
        dependencies(store, {
          thresholds: { scannerMaxLagMs: 0 },
        }),
      ),
    ).resolves.toEqual({
      ready: false,
      scanner: "unchecked",
      code: "dependency_unavailable",
    });
  });
});
