import { describe, expect, it, vi } from "vitest";

import {
  startWorkerOperationalMonitor,
  WORKER_OPERATIONAL_MONITOR_INTERVAL_MS,
  type WorkerOperationalMonitorScheduler,
  type WorkerOperationalMonitorTimer,
} from "../src/operational-monitor.js";
import type { WorkerReadinessProbe, WorkerReadinessResult } from "../src/readiness.js";
import type { WorkerLogger } from "../src/ports.js";
import { FakeLogger } from "./helpers.js";

const HEALTHY: WorkerReadinessResult = {
  ready: true,
  scanner: "fresh",
};

class FakeTimer implements WorkerOperationalMonitorTimer {
  unrefCalls = 0;

  unref(): void {
    this.unrefCalls += 1;
  }
}

class FakeScheduler implements WorkerOperationalMonitorScheduler {
  readonly timer = new FakeTimer();
  callback: (() => void) | null = null;
  clearCalls = 0;
  intervalMilliseconds: number | null = null;

  setInterval(callback: () => void, intervalMilliseconds: number): WorkerOperationalMonitorTimer {
    this.callback = callback;
    this.intervalMilliseconds = intervalMilliseconds;
    return this.timer;
  }

  clearInterval(timer: WorkerOperationalMonitorTimer): void {
    expect(timer).toBe(this.timer);
    this.clearCalls += 1;
  }

  fire(): void {
    if (this.callback === null) {
      throw new Error("FAKE_OPERATIONAL_MONITOR_TIMER_MISSING");
    }
    this.callback();
  }
}

function sequenceProbe(outcomes: readonly (WorkerReadinessResult | Error)[]): WorkerReadinessProbe {
  let index = 0;
  return {
    check(): Promise<WorkerReadinessResult> {
      const outcome = outcomes[index];
      index += 1;
      if (outcome instanceof Error) {
        return Promise.reject(outcome);
      }
      if (outcome === undefined) {
        return Promise.reject(new Error("FAKE_READINESS_OUTCOME_MISSING"));
      }
      return Promise.resolve(outcome);
    },
  };
}

function alertEntries(logger: FakeLogger) {
  return logger.entries.filter((entry) => entry.context["event"] === "operational_alert");
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

describe("worker operational monitor", () => {
  it("uses one unref'ed 60-second interval and emits an allowlisted healthy sample", async () => {
    const logger = new FakeLogger();
    const scheduler = new FakeScheduler();
    const monitor = startWorkerOperationalMonitor({
      logger,
      readiness: sequenceProbe([HEALTHY]),
      scheduler,
    });

    expect(scheduler.intervalMilliseconds).toBe(WORKER_OPERATIONAL_MONITOR_INTERVAL_MS);
    expect(WORKER_OPERATIONAL_MONITOR_INTERVAL_MS).toBe(60_000);
    expect(scheduler.timer.unrefCalls).toBe(1);

    scheduler.fire();
    await vi.waitFor(() => {
      expect(logger.entries).toHaveLength(1);
    });
    expect(logger.entries).toEqual([
      {
        level: "info",
        context: {
          event: "operational_readiness_sample",
          ready: true,
          scanner: "fresh",
        },
        message: "Worker operational readiness sampled",
      },
    ]);

    await monitor.stop();
    expect(scheduler.clearCalls).toBe(1);
  });

  it.each([
    ["live_enabled", "S0", "error"],
    ["consumer_unavailable", "S1", "warn"],
    ["schedule_mismatch", "S1", "warn"],
    ["scanner_stale", "S1", "warn"],
    ["dependency_unavailable", "S1", "warn"],
  ] as const)("maps %s to one %s alert", async (code, severity, level) => {
    const logger = new FakeLogger();
    const monitor = startWorkerOperationalMonitor({
      logger,
      readiness: sequenceProbe([
        {
          ready: false,
          scanner: code === "scanner_stale" ? "stale" : "unchecked",
          code,
        },
      ]),
      scheduler: new FakeScheduler(),
    });

    await monitor.sampleNow();

    expect(alertEntries(logger)).toEqual([
      {
        level,
        context: {
          event: "operational_alert",
          status: "raised",
          code,
          severity,
          source: "worker_readiness",
        },
        message: "Worker operational alert raised",
      },
    ]);
    await monitor.stop();
  });

  it("deduplicates repeated failures and resolves before changing or clearing an alert", async () => {
    const logger = new FakeLogger();
    const monitor = startWorkerOperationalMonitor({
      logger,
      readiness: sequenceProbe([
        { ready: false, scanner: "stale", code: "scanner_stale" },
        { ready: false, scanner: "stale", code: "scanner_stale" },
        { ready: false, scanner: "unchecked", code: "consumer_unavailable" },
        HEALTHY,
        HEALTHY,
      ]),
      scheduler: new FakeScheduler(),
    });

    for (let index = 0; index < 5; index += 1) {
      await monitor.sampleNow();
    }

    expect(alertEntries(logger).map((entry) => entry.context)).toEqual([
      {
        event: "operational_alert",
        status: "raised",
        code: "scanner_stale",
        severity: "S1",
        source: "worker_readiness",
      },
      {
        event: "operational_alert",
        status: "resolved",
        code: "scanner_stale",
        severity: "S1",
        source: "worker_readiness",
      },
      {
        event: "operational_alert",
        status: "raised",
        code: "consumer_unavailable",
        severity: "S1",
        source: "worker_readiness",
      },
      {
        event: "operational_alert",
        status: "resolved",
        code: "consumer_unavailable",
        severity: "S1",
        source: "worker_readiness",
      },
    ]);
    expect(
      logger.entries.filter((entry) => entry.context["event"] === "operational_readiness_sample"),
    ).toHaveLength(5);
    await monitor.stop();
  });

  it("samples process_stopping without raising or resolving an alert", async () => {
    const logger = new FakeLogger();
    const monitor = startWorkerOperationalMonitor({
      logger,
      readiness: sequenceProbe([
        { ready: false, scanner: "stale", code: "scanner_stale" },
        { ready: false, scanner: "unchecked", code: "process_stopping" },
      ]),
      scheduler: new FakeScheduler(),
    });

    await monitor.sampleNow();
    await monitor.sampleNow();

    expect(alertEntries(logger)).toHaveLength(1);
    expect(logger.entries.at(-1)?.context).toEqual({
      event: "operational_readiness_sample",
      ready: false,
      scanner: "unchecked",
      failure_code: "process_stopping",
    });
    await monitor.stop();
  });

  it("normalizes a thrown readiness error without retaining its text or identifiers", async () => {
    const logger = new FakeLogger();
    const monitor = startWorkerOperationalMonitor({
      logger,
      readiness: sequenceProbe([
        new Error("sk_test_sensitive acct_sensitive tenant_sensitive request_sensitive"),
      ]),
      scheduler: new FakeScheduler(),
    });

    await monitor.sampleNow();

    expect(logger.entries.map((entry) => entry.context)).toEqual([
      {
        event: "operational_readiness_sample",
        ready: false,
        scanner: "unchecked",
        failure_code: "dependency_unavailable",
      },
      {
        event: "operational_alert",
        status: "raised",
        code: "dependency_unavailable",
        severity: "S1",
        source: "worker_readiness",
      },
    ]);
    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain("sensitive");
    expect(serialized).not.toContain("acct_");
    expect(serialized).not.toContain("tenant_");
    expect(serialized).not.toContain("request_");
    await monitor.stop();
  });

  it("coalesces overlapping samples and stops without waiting for the active sample", async () => {
    const readinessResult = deferred<WorkerReadinessResult>();
    const logger = new FakeLogger();
    const scheduler = new FakeScheduler();
    const check = vi.fn(() => readinessResult.promise);
    const monitor = startWorkerOperationalMonitor({
      logger,
      readiness: { check },
      scheduler,
    });

    const first = monitor.sampleNow();
    const second = monitor.sampleNow();
    expect(second).toBe(first);
    expect(check).toHaveBeenCalledOnce();

    await expect(monitor.stop()).resolves.toBeUndefined();
    expect(scheduler.clearCalls).toBe(1);
    expect(logger.entries).toEqual([]);

    await monitor.sampleNow();
    scheduler.fire();
    await Promise.resolve();
    expect(check).toHaveBeenCalledOnce();

    readinessResult.resolve(HEALTHY);
    await first;
    await second;
    expect(logger.entries).toEqual([]);
    expect(scheduler.clearCalls).toBe(1);
  });

  it("contains logger failures and remains stoppable", async () => {
    const scheduler = new FakeScheduler();
    const throwing = vi.fn(() => {
      throw new Error("LOGGER_UNAVAILABLE");
    });
    const monitor = startWorkerOperationalMonitor({
      logger: {
        debug: throwing,
        info: throwing,
        warn: throwing,
        error: throwing,
      },
      readiness: sequenceProbe([{ ready: false, scanner: "stale", code: "scanner_stale" }]),
      scheduler,
    });

    await expect(monitor.sampleNow()).resolves.toBeUndefined();
    await expect(monitor.stop()).resolves.toBeUndefined();
    expect(scheduler.clearCalls).toBe(1);
  });

  it("retries an alert raise after a transient logger failure", async () => {
    const captured = new FakeLogger();
    let raiseAttempts = 0;
    const logger: WorkerLogger = {
      debug: (context, message) => captured.debug(context, message),
      info: (context, message) => captured.info(context, message),
      warn(context, message) {
        raiseAttempts += 1;
        if (raiseAttempts === 1) {
          throw new Error("TRANSIENT_LOGGER_FAILURE");
        }
        captured.warn(context, message);
      },
      error: (context, message) => captured.error(context, message),
    };
    const monitor = startWorkerOperationalMonitor({
      logger,
      readiness: sequenceProbe([
        { ready: false, scanner: "stale", code: "scanner_stale" },
        { ready: false, scanner: "stale", code: "scanner_stale" },
      ]),
      scheduler: new FakeScheduler(),
    });

    await monitor.sampleNow();
    expect(alertEntries(captured)).toEqual([]);
    await monitor.sampleNow();

    expect(raiseAttempts).toBe(2);
    expect(alertEntries(captured).map((entry) => entry.context)).toEqual([
      {
        event: "operational_alert",
        status: "raised",
        code: "scanner_stale",
        severity: "S1",
        source: "worker_readiness",
      },
    ]);
    await monitor.stop();
  });

  it("retries an alert resolution after a transient logger failure", async () => {
    const captured = new FakeLogger();
    let resolutionAttempts = 0;
    const logger: WorkerLogger = {
      debug: (context, message) => captured.debug(context, message),
      info(context, message) {
        if (context["event"] === "operational_alert" && context["status"] === "resolved") {
          resolutionAttempts += 1;
          if (resolutionAttempts === 1) {
            throw new Error("TRANSIENT_LOGGER_FAILURE");
          }
        }
        captured.info(context, message);
      },
      warn: (context, message) => captured.warn(context, message),
      error: (context, message) => captured.error(context, message),
    };
    const monitor = startWorkerOperationalMonitor({
      logger,
      readiness: sequenceProbe([
        { ready: false, scanner: "stale", code: "scanner_stale" },
        HEALTHY,
        HEALTHY,
      ]),
      scheduler: new FakeScheduler(),
    });

    await monitor.sampleNow();
    await monitor.sampleNow();
    expect(alertEntries(captured)).toHaveLength(1);
    await monitor.sampleNow();

    expect(resolutionAttempts).toBe(2);
    expect(alertEntries(captured).map((entry) => entry.context)).toEqual([
      {
        event: "operational_alert",
        status: "raised",
        code: "scanner_stale",
        severity: "S1",
        source: "worker_readiness",
      },
      {
        event: "operational_alert",
        status: "resolved",
        code: "scanner_stale",
        severity: "S1",
        source: "worker_readiness",
      },
    ]);
    await monitor.stop();
  });
});
