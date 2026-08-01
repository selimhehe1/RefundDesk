import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "@refunddesk/config";

import type { WorkerDependencies } from "../src/dependencies.js";
import { QUEUES } from "../src/jobs.js";
import {
  startPgBossWithCleanup,
  startPgBossWorker,
  type PgBossLifecycle,
} from "../src/pg-boss-runtime.js";

const operationalMonitor = vi.hoisted(() => ({
  sampleNow: vi.fn<() => Promise<void>>(),
  start: vi.fn<(options: unknown) => { sampleNow(): Promise<void>; stop(): Promise<void> }>(),
  stop: vi.fn<() => Promise<void>>(),
}));

const pgBoss = vi.hoisted(() => ({
  createQueue: vi.fn<(name: string, options: unknown) => Promise<void>>(),
  getSchedules: vi.fn<() => Promise<never[]>>(),
  getWipData: vi.fn<() => never[]>(),
  on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
  schedule: vi.fn<(name: string, cron: string, data: unknown, options: unknown) => Promise<void>>(),
  send: vi.fn<(name: string, data: unknown) => Promise<string | null>>(),
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<(options: unknown) => Promise<void>>(),
  work: vi.fn<(name: string, options: unknown, handler: unknown) => Promise<string>>(),
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    createQueue = pgBoss.createQueue;
    getSchedules = pgBoss.getSchedules;
    getWipData = pgBoss.getWipData;
    on = pgBoss.on;
    schedule = pgBoss.schedule;
    send = pgBoss.send;
    start = pgBoss.start;
    stop = pgBoss.stop;
    work = pgBoss.work;
  },
}));

vi.mock("../src/operational-monitor.js", () => ({
  startWorkerOperationalMonitor: operationalMonitor.start,
}));

const workerConfig = {
  liveEnabled: false,
  pgBossDatabaseUrl: "postgresql://queue@localhost/refunddesk",
} as WorkerConfig;

function workerDependencies() {
  const info = vi.fn();
  const listScannableInstallations = vi.fn<() => Promise<readonly never[]>>(() =>
    Promise.resolve([]),
  );
  return {
    dependencies: {
      clock: { now: () => new Date("2026-07-30T00:00:00.000Z") },
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info,
        warn: vi.fn(),
      },
      proofs: {},
      store: { listScannableInstallations },
      stripe: {},
    } as unknown as WorkerDependencies,
    info,
    listScannableInstallations,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("pg-boss startup lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    pgBoss.createQueue.mockResolvedValue();
    pgBoss.getSchedules.mockResolvedValue([]);
    pgBoss.getWipData.mockReturnValue([]);
    pgBoss.schedule.mockResolvedValue();
    pgBoss.send.mockResolvedValue("job-id");
    pgBoss.start.mockResolvedValue();
    pgBoss.stop.mockResolvedValue();
    pgBoss.work.mockResolvedValue("worker-id");
    operationalMonitor.sampleNow.mockResolvedValue();
    operationalMonitor.stop.mockResolvedValue();
    operationalMonitor.start.mockReturnValue({
      sampleNow: operationalMonitor.sampleNow,
      stop: operationalMonitor.stop,
    });
  });

  it("force-stops a partially started runtime when schedule or work registration fails", async () => {
    const startupError = new Error("synthetic schedule failure");
    const start = vi.fn(() => Promise.resolve());
    const stop = vi.fn(() => Promise.resolve());
    const boss: PgBossLifecycle = {
      start,
      stop,
    };

    await expect(startPgBossWithCleanup(boss, () => Promise.reject(startupError))).rejects.toBe(
      startupError,
    );
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith({
      graceful: false,
      timeout: 5_000,
    });
  });

  it("also attempts cleanup when pg-boss start itself fails", async () => {
    const startupError = new Error("synthetic start failure");
    const start = vi.fn(() => Promise.reject(startupError));
    const stop = vi.fn(() => Promise.resolve());
    const boss: PgBossLifecycle = {
      start,
      stop,
    };
    const initialize = vi.fn(() => Promise.resolve());

    await expect(startPgBossWithCleanup(boss, initialize)).rejects.toBe(startupError);
    expect(initialize).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith({
      graceful: false,
      timeout: 5_000,
    });
  });

  it("blocks every recovery enqueue and consumer until the startup reconciliation catch-up completes", async () => {
    const catchUp = deferred<readonly never[]>();
    const { dependencies, info, listScannableInstallations } = workerDependencies();
    listScannableInstallations.mockReturnValue(catchUp.promise);
    const startup = startPgBossWorker(workerConfig, dependencies);

    await vi.waitFor(() => {
      expect(listScannableInstallations).toHaveBeenCalledOnce();
    });
    expect(pgBoss.send).not.toHaveBeenCalled();
    expect(pgBoss.work).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();

    catchUp.resolve([]);
    const worker = await startup;

    expect(pgBoss.schedule).toHaveBeenCalledWith(
      QUEUES.scanRefunds,
      "*/15 * * * *",
      { scope: "all" },
      { key: "pilot_refund_scan_v1" },
    );
    expect(pgBoss.send.mock.calls).toEqual([
      [QUEUES.recoverWebhooks, { scope: "recoverable" }],
      [QUEUES.recoverApproved, { scope: "approved" }],
    ]);
    expect(listScannableInstallations.mock.invocationCallOrder[0]).toBeLessThan(
      pgBoss.send.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
    expect(listScannableInstallations.mock.invocationCallOrder[0]).toBeLessThan(
      pgBoss.work.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
    expect(info).toHaveBeenNthCalledWith(
      1,
      { queue: QUEUES.scanRefunds },
      "Startup reconciliation catch-up completed",
    );
    await worker.stop();
  });

  it("fails closed and force-stops pg-boss when the startup reconciliation catch-up fails", async () => {
    const startupError = new Error("synthetic startup scan failure");
    const { dependencies, info, listScannableInstallations } = workerDependencies();
    listScannableInstallations.mockRejectedValue(startupError);

    await expect(startPgBossWorker(workerConfig, dependencies)).rejects.toBe(startupError);
    expect(pgBoss.send).not.toHaveBeenCalled();
    expect(pgBoss.stop).toHaveBeenCalledWith({
      graceful: false,
      timeout: 5_000,
    });
    expect(pgBoss.work).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("stops the local operational monitor before gracefully stopping pg-boss", async () => {
    const { dependencies } = workerDependencies();
    const worker = await startPgBossWorker(workerConfig, dependencies);

    expect(operationalMonitor.start).toHaveBeenCalledWith({
      logger: dependencies.logger,
      readiness: worker.readiness,
    });
    await worker.stop();

    expect(operationalMonitor.stop).toHaveBeenCalledOnce();
    expect(pgBoss.stop).toHaveBeenCalledWith({
      graceful: true,
      timeout: 30_000,
    });
    expect(operationalMonitor.stop.mock.invocationCallOrder[0]).toBeLessThan(
      pgBoss.stop.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("force-stops pg-boss when the local operational monitor cannot start", async () => {
    const startupError = new Error("synthetic operational monitor failure");
    operationalMonitor.start.mockImplementationOnce(() => {
      throw startupError;
    });
    const { dependencies } = workerDependencies();

    await expect(startPgBossWorker(workerConfig, dependencies)).rejects.toBe(startupError);
    expect(pgBoss.stop).toHaveBeenCalledWith({
      graceful: false,
      timeout: 5_000,
    });
  });
});
