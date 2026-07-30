import { describe, expect, it } from "vitest";

import {
  assertDedicatedPostgresClusterPreflight,
  assertDisposablePostgresCluster,
  assertExclusiveSingletonEnqueue,
  DISPOSABLE_POSTGRES_CLUSTER_CONSENT,
  readSandboxE2EScenario,
  SANDBOX_E2E_SCENARIO_PAYMENT_METHODS,
  SANDBOX_E2E_SCENARIOS,
} from "./sandbox-harness-guards.js";

describe("sandbox harness guards", () => {
  it("requires an explicit supported real-Stripe scenario", () => {
    expect(SANDBOX_E2E_SCENARIOS).toEqual(["normal", "pending_refund", "failed_refund_scanner"]);
    expect(SANDBOX_E2E_SCENARIO_PAYMENT_METHODS).toEqual({
      normal: "pm_card_visa",
      pending_refund: "pm_card_pendingRefund",
      failed_refund_scanner: "pm_card_refundFail",
    });
    for (const scenario of SANDBOX_E2E_SCENARIOS) {
      expect(
        readSandboxE2EScenario({
          REFUNDDESK_SANDBOX_E2E_SCENARIO: scenario,
        }),
      ).toBe(scenario);
    }
    expect(() => readSandboxE2EScenario({})).toThrow("SANDBOX_E2E_SCENARIO_INVALID_OR_MISSING");
    expect(() =>
      readSandboxE2EScenario({
        REFUNDDESK_SANDBOX_E2E_SCENARIO: "unknown",
      }),
    ).toThrow("SANDBOX_E2E_SCENARIO_INVALID_OR_MISSING");
  });

  it("refuses to relabel an unsigned local observation as a webhook scenario", () => {
    expect(() =>
      readSandboxE2EScenario({
        REFUNDDESK_SANDBOX_E2E_SCENARIO: "failed_refund_webhook",
      }),
    ).toThrow("SANDBOX_E2E_FAILED_REFUND_WEBHOOK_REQUIRES_HOSTED_SIGNED_DELIVERY");
  });

  it("fails closed unless the PostgreSQL cluster is explicitly dedicated and disposable", () => {
    expect(() => assertDisposablePostgresCluster({})).toThrow(
      "SANDBOX_E2E_DEDICATED_DISPOSABLE_POSTGRES_CLUSTER_REQUIRED",
    );
    expect(() =>
      assertDisposablePostgresCluster({
        REFUNDDESK_SANDBOX_E2E_DISPOSABLE_POSTGRES_CLUSTER: "yes",
      }),
    ).toThrow("SANDBOX_E2E_DEDICATED_DISPOSABLE_POSTGRES_CLUSTER_REQUIRED");

    expect(() =>
      assertDisposablePostgresCluster({
        REFUNDDESK_SANDBOX_E2E_DISPOSABLE_POSTGRES_CLUSTER: DISPOSABLE_POSTGRES_CLUSTER_CONSENT,
      }),
    ).not.toThrow();
  });

  it("rejects a shared, mismatched, or concurrently used PostgreSQL cluster", () => {
    const validPreflight = {
      connectedDatabase: "postgres",
      expectedControlDatabase: "postgres",
      harnessLockAcquired: true,
      otherConnectableDatabaseCount: 0,
    } as const;

    expect(() =>
      assertDedicatedPostgresClusterPreflight({
        ...validPreflight,
        connectedDatabase: "refunddesk",
      }),
    ).toThrow("SANDBOX_E2E_POSTGRES_CONTROL_DATABASE_MISMATCH");
    expect(() =>
      assertDedicatedPostgresClusterPreflight({
        ...validPreflight,
        harnessLockAcquired: false,
      }),
    ).toThrow("SANDBOX_E2E_POSTGRES_HARNESS_ALREADY_RUNNING");
    expect(() =>
      assertDedicatedPostgresClusterPreflight({
        ...validPreflight,
        otherConnectableDatabaseCount: 1,
      }),
    ).toThrow("SANDBOX_E2E_POSTGRES_CLUSTER_NOT_DEDICATED");
    expect(() => assertDedicatedPostgresClusterPreflight(validPreflight)).not.toThrow();
  });

  it("accepts only one queued job while the first singleton remains pending", () => {
    expect(assertExclusiveSingletonEnqueue("job-1", null)).toBe("job-1");
    expect(() => assertExclusiveSingletonEnqueue(null, null)).toThrow(
      "SANDBOX_E2E_QUEUE_SINGLETON_FIRST_JOB_REJECTED",
    );
    expect(() => assertExclusiveSingletonEnqueue("job-1", "job-2")).toThrow(
      "SANDBOX_E2E_QUEUE_SINGLETON_DUPLICATE_ACCEPTED",
    );
  });
});
