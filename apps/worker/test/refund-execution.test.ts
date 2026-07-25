import { describe, expect, it } from "vitest";

import { refundIdempotencyKey } from "@refunddesk/domain";

import {
  handleRefundExecutionJob,
  RetryableWorkerError,
  type RefundExecutionDependencies,
} from "../src/refund-execution.js";
import { LiveModeRejectedError } from "../src/safety.js";
import {
  FakeLogger,
  FakeProofs,
  FakeStore,
  FakeStripe,
  REQUEST_ID,
  TENANT_ID,
  executionRecord,
  fixedClock,
  normalizedPayment,
} from "./helpers.js";

const job = {
  tenant_id: TENANT_ID,
  request_id: REQUEST_ID,
} as const;

function dependencies(
  store: FakeStore,
  stripe: FakeStripe,
  crashHooks?: RefundExecutionDependencies["crashHooks"],
): RefundExecutionDependencies {
  return {
    store,
    stripe,
    proofs: new FakeProofs(),
    clock: fixedClock,
    logger: new FakeLogger(),
    ...(crashHooks === undefined ? {} : { crashHooks }),
  };
}

function crashOnce(): () => void {
  let crashed = false;
  return () => {
    if (!crashed) {
      crashed = true;
      throw new Error("INJECTED_PROCESS_CRASH");
    }
  };
}

describe("refund execution", () => {
  it("revalidates before persisting the effect boundary and creating a Refund", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();

    await handleRefundExecutionJob(job, dependencies(store, stripe));

    expect(stripe.trace).toEqual(["stripe.retrieve", "stripe.create"]);
    expect(store.trace).toEqual(["store.load", "store.boundary", "store.identified"]);
    expect(store.effectState).toBe("identified");
    expect(store.refundId).toBe("re_worker");
    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.createCalls[0]?.idempotencyKey).toBe(refundIdempotencyKey(REQUEST_ID));
    expect(stripe.createCalls[0]?.installation.environment).toBe("test");
  });

  it("binds the proof to the Stripe account", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    const proofs = new FakeProofs();

    await handleRefundExecutionJob(job, {
      ...dependencies(store, stripe),
      proofs,
    });

    expect(proofs.payloads).toEqual([
      expect.objectContaining({
        stripeAccountId: "acct_test_worker",
        tenantId: TENANT_ID,
        requestId: REQUEST_ID,
      }),
    ]);
  });

  it("fails closed for live before any Stripe network call", async () => {
    const store = new FakeStore();
    store.record = executionRecord({
      installation: {
        tenantId: TENANT_ID,
        installationId: store.record?.installation.installationId ?? "",
        stripeAccountId: "acct_live_forbidden",
        environment: "live",
        active: true,
        tenantLiveEnabled: true,
      },
    });
    const stripe = new FakeStripe();

    await expect(handleRefundExecutionJob(job, dependencies(store, stripe))).rejects.toBeInstanceOf(
      LiveModeRejectedError,
    );
    expect(stripe.trace).toEqual([]);
    expect(store.effectState).toBe("not_started");
  });

  it("terminates an ineligible request without crossing the effect boundary", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    stripe.payment = normalizedPayment({ paymentMethodType: "card_present" });

    await handleRefundExecutionJob(job, dependencies(store, stripe));

    expect(stripe.createCalls).toEqual([]);
    expect(store.idempotencyKey).toBeNull();
    expect(store.terminalPreflightFailures[0]?.errorCode).toBe("CARD_PRESENT_UNSUPPORTED");
    expect(store.effectState).toBe("absence_proven");
  });

  it("moves a post-boundary timeout to reconciliation without an automatic retry", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    stripe.createOutcomes = [
      Object.assign(new Error("must not be logged"), {
        type: "StripeConnectionError",
      }),
    ];

    await handleRefundExecutionJob(job, dependencies(store, stripe));

    expect(store.workflowState).toBe("reconciliation_required");
    expect(store.effectState).toBe("possible");
    expect(store.ambiguousFailures).toHaveLength(1);
    expect(stripe.createCalls).toHaveLength(1);
  });

  it("retries a rate limit with exactly the same idempotency key", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    stripe.createOutcomes = [
      Object.assign(new Error("rate limited"), {
        type: "StripeRateLimitError",
        code: "rate_limit",
        statusCode: 429,
      }),
      {
        id: "re_after_rate_limit",
        paymentIntentId: "pi_worker",
        chargeId: "ch_worker",
        amountMinor: 500n,
        currency: "eur",
        status: "succeeded",
        created: 1_893_499_200,
        metadata: {},
        requestId: "req_after_rate_limit",
      },
    ];
    const deps = dependencies(store, stripe);

    await expect(handleRefundExecutionJob(job, deps)).rejects.toBeInstanceOf(RetryableWorkerError);
    await handleRefundExecutionJob(job, deps);

    expect(stripe.createCalls).toHaveLength(2);
    expect(new Set(stripe.createCalls.map((call) => call.idempotencyKey)).size).toBe(1);
    expect(store.refundId).toBe("re_after_rate_limit");
  });

  it.each([
    ["before boundary", "beforeEffectBoundary"],
    ["after identified commit", "afterIdentifiedPersisted"],
  ] as const)("recovers directly from a crash %s", async (_label, hookName) => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    const hook = crashOnce();
    const deps = dependencies(store, stripe, { [hookName]: hook });

    await expect(handleRefundExecutionJob(job, deps)).rejects.toThrow("INJECTED_PROCESS_CRASH");
    await handleRefundExecutionJob(job, deps);

    const keys = stripe.createCalls.map((call) => call.idempotencyKey);
    expect(new Set(keys).size).toBeLessThanOrEqual(1);
    expect(store.refundId).toBe("re_worker");
    expect(store.identified).toHaveLength(1);
    expect(stripe.createCalls).toHaveLength(1);
  });

  it("requires reconciliation after a crash at the durable boundary, then reuses the same key", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    const deps = dependencies(store, stripe, {
      afterEffectBoundary: crashOnce(),
    });

    await expect(handleRefundExecutionJob(job, deps)).rejects.toThrow("INJECTED_PROCESS_CRASH");
    await handleRefundExecutionJob(job, deps);

    expect(store.workflowState).toBe("reconciliation_required");
    expect(store.effectState).toBe("possible");
    expect(stripe.createCalls).toHaveLength(0);

    // A complete reconciliation scan proves absence before execution can resume.
    store.workflowState = "executable";
    store.effectState = "absence_proven";
    await handleRefundExecutionJob(job, deps);

    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.createCalls[0]?.idempotencyKey).toBe(refundIdempotencyKey(REQUEST_ID));
    expect(store.refundId).toBe("re_worker");
  });

  it("never replays Stripe before reconciliation after a crash with an unpersisted response", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    const deps = dependencies(store, stripe, {
      afterStripeResponse: crashOnce(),
    });

    await expect(handleRefundExecutionJob(job, deps)).rejects.toThrow("INJECTED_PROCESS_CRASH");
    expect(stripe.createCalls).toHaveLength(1);

    await handleRefundExecutionJob(job, deps);

    expect(store.workflowState).toBe("reconciliation_required");
    expect(store.effectState).toBe("possible");
    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.createCalls[0]?.idempotencyKey).toBe(refundIdempotencyKey(REQUEST_ID));
  });

  it("links a mismatched response once but requires reconciliation", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    stripe.createOutcomes = [
      {
        id: "re_mismatched",
        paymentIntentId: "pi_other",
        chargeId: "ch_other",
        amountMinor: 501n,
        currency: "eur",
        status: "succeeded",
        created: 1_893_499_200,
        metadata: {},
        requestId: "req_mismatched",
      },
    ];

    await handleRefundExecutionJob(job, dependencies(store, stripe));

    expect(store.refundId).toBe("re_mismatched");
    expect(store.workflowState).toBe("reconciliation_required");
    expect(store.identified[0]?.responseMatchesRequest).toBe(false);
  });

  it("never logs raw Stripe error messages", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    const logger = new FakeLogger();
    stripe.createOutcomes = [
      Object.assign(new Error("customer@example.com sk_test_do_not_log"), {
        code: "sk_test_x",
        type: "StripeConnectionError",
      }),
    ];

    await handleRefundExecutionJob(job, {
      ...dependencies(store, stripe),
      logger,
    });

    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain("customer@example.com");
    expect(serialized).not.toContain("sk_test_do_not_log");
    expect(serialized).not.toContain("sk_test_x");
  });
});
