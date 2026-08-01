import type { SafeLogContext, WorkerLogger } from "./ports.js";
import type {
  WorkerReadinessFailureCode,
  WorkerReadinessProbe,
  WorkerReadinessResult,
} from "./readiness.js";

export const WORKER_OPERATIONAL_MONITOR_INTERVAL_MS = 60_000;

export type WorkerOperationalAlertSeverity = "S0" | "S1";
export type WorkerOperationalAlertCode = Exclude<WorkerReadinessFailureCode, "process_stopping">;

const ALERT_SEVERITY = Object.freeze({
  live_enabled: "S0",
  consumer_unavailable: "S1",
  schedule_mismatch: "S1",
  scanner_stale: "S1",
  dependency_unavailable: "S1",
} satisfies Readonly<Record<WorkerOperationalAlertCode, WorkerOperationalAlertSeverity>>);

const READINESS_SAMPLE_MESSAGE = "Worker operational readiness sampled";
const ALERT_RAISED_MESSAGE = "Worker operational alert raised";
const ALERT_RESOLVED_MESSAGE = "Worker operational alert resolved";

export interface WorkerOperationalMonitorTimer {
  unref(): void;
}

export interface WorkerOperationalMonitorScheduler {
  setInterval(callback: () => void, intervalMilliseconds: number): WorkerOperationalMonitorTimer;
  clearInterval(timer: WorkerOperationalMonitorTimer): void;
}

export interface WorkerOperationalMonitorOptions {
  readonly logger: WorkerLogger;
  readonly readiness: WorkerReadinessProbe;
  readonly scheduler?: WorkerOperationalMonitorScheduler;
}

export interface RunningWorkerOperationalMonitor {
  sampleNow(): Promise<void>;
  stop(): Promise<void>;
}

const systemScheduler: WorkerOperationalMonitorScheduler = {
  setInterval(callback, intervalMilliseconds) {
    return setInterval(callback, intervalMilliseconds);
  },
  clearInterval(timer) {
    clearInterval(timer as ReturnType<typeof setInterval>);
  },
};

type AlertDecision =
  | { readonly kind: "clear" }
  | { readonly kind: "ignore" }
  | {
      readonly kind: "alert";
      readonly code: WorkerOperationalAlertCode;
      readonly severity: WorkerOperationalAlertSeverity;
    };

function alertDecision(result: WorkerReadinessResult): AlertDecision {
  if (result.ready) {
    return { kind: "clear" };
  }
  if (result.code === "process_stopping") {
    return { kind: "ignore" };
  }
  return {
    kind: "alert",
    code: result.code,
    severity: ALERT_SEVERITY[result.code],
  };
}

function sampleContext(result: WorkerReadinessResult): SafeLogContext {
  if (result.ready) {
    return {
      event: "operational_readiness_sample",
      ready: true,
      scanner: result.scanner,
    };
  }
  return {
    event: "operational_readiness_sample",
    ready: false,
    scanner: result.scanner,
    failure_code: result.code,
  };
}

function alertContext(
  code: WorkerOperationalAlertCode,
  severity: WorkerOperationalAlertSeverity,
  status: "raised" | "resolved",
): SafeLogContext {
  return {
    event: "operational_alert",
    status,
    code,
    severity,
    source: "worker_readiness",
  };
}

function safeLog(
  logger: WorkerLogger,
  level: "info" | "warn" | "error",
  context: SafeLogContext,
  message: string,
): boolean {
  try {
    logger[level](context, message);
    return true;
  } catch {
    // Observability must never affect worker availability or financial state.
    return false;
  }
}

function dependencyUnavailable(): WorkerReadinessResult {
  return {
    ready: false,
    scanner: "unchecked",
    code: "dependency_unavailable",
  };
}

export function startWorkerOperationalMonitor(
  options: WorkerOperationalMonitorOptions,
): RunningWorkerOperationalMonitor {
  const scheduler = options.scheduler ?? systemScheduler;
  let activeAlert: {
    readonly code: WorkerOperationalAlertCode;
    readonly severity: WorkerOperationalAlertSeverity;
  } | null = null;
  let activeSample: Promise<void> | null = null;
  let stopped = false;

  const performSample = async (): Promise<void> => {
    let result: WorkerReadinessResult;
    try {
      result = await options.readiness.check();
    } catch {
      result = dependencyUnavailable();
    }
    if (stopped) {
      return;
    }

    safeLog(options.logger, "info", sampleContext(result), READINESS_SAMPLE_MESSAGE);
    const decision = alertDecision(result);
    if (decision.kind === "ignore") {
      return;
    }
    if (decision.kind === "clear") {
      if (activeAlert !== null) {
        const resolved = safeLog(
          options.logger,
          "info",
          alertContext(activeAlert.code, activeAlert.severity, "resolved"),
          ALERT_RESOLVED_MESSAGE,
        );
        if (resolved) {
          activeAlert = null;
        }
      }
      return;
    }
    if (activeAlert?.code === decision.code) {
      return;
    }
    if (activeAlert !== null) {
      const resolved = safeLog(
        options.logger,
        "info",
        alertContext(activeAlert.code, activeAlert.severity, "resolved"),
        ALERT_RESOLVED_MESSAGE,
      );
      if (!resolved) {
        return;
      }
      activeAlert = null;
    }
    const raised = safeLog(
      options.logger,
      decision.severity === "S0" ? "error" : "warn",
      alertContext(decision.code, decision.severity, "raised"),
      ALERT_RAISED_MESSAGE,
    );
    if (raised) {
      activeAlert = {
        code: decision.code,
        severity: decision.severity,
      };
    }
  };

  const sampleNow = (): Promise<void> => {
    if (stopped) {
      return Promise.resolve();
    }
    if (activeSample !== null) {
      return activeSample;
    }
    const operation = performSample()
      .catch(() => undefined)
      .finally(() => {
        if (activeSample === operation) {
          activeSample = null;
        }
      });
    activeSample = operation;
    return operation;
  };

  const timer = scheduler.setInterval(() => {
    void sampleNow();
  }, WORKER_OPERATIONAL_MONITOR_INTERVAL_MS);
  try {
    timer.unref();
  } catch (error) {
    try {
      scheduler.clearInterval(timer);
    } catch {
      // Preserve the original startup failure.
    }
    throw error;
  }

  return {
    sampleNow,
    stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        try {
          scheduler.clearInterval(timer);
        } catch {
          // A local monitor cannot block worker shutdown.
        }
      }
      return Promise.resolve();
    },
  };
}
