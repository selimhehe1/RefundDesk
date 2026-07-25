import { describe, expect, it } from "vitest";

import { isPhase0Administrator } from "../src/server/phase0-proof.js";
import { Phase0NonceConflictError, Phase0Store } from "../src/server/phase0-store.js";

describe("phase-0 probe authorization", () => {
  it("accepts only the signed built-in Administrator role", () => {
    expect(
      isPhase0Administrator([{ id: "super_admin", type: "builtIn", name: "Super Administrator" }]),
    ).toBe(true);
    expect(isPhase0Administrator([{ id: "admin", type: "builtIn", name: "Administrator" }])).toBe(
      true,
    );
    expect(isPhase0Administrator([{ name: "Administrator", type: "builtIn" }])).toBe(true);
    expect(
      isPhase0Administrator([{ id: "super_admin", type: "custom", name: "Super Administrator" }]),
    ).toBe(false);
    expect(
      isPhase0Administrator([{ id: "view_only", type: "builtIn", name: "Super Administrator" }]),
    ).toBe(false);
    expect(isPhase0Administrator([{ name: "View only", type: "builtIn" }])).toBe(false);
  });
});

describe("Phase0Store", () => {
  it("preserves the first Refund across an exact nonce replay and rejects changed data", () => {
    const store = new Phase0Store();
    const probe = {
      requestNonce: "nonce",
      accountId: "acct_1",
      actorUserId: "usr_1",
      environment: "test",
      targetType: "payment_intent",
      targetId: "pi_1",
      paymentKey: "pi_1",
      amountMinor: "100",
      currency: "eur",
      reason: "requested_by_customer",
      idempotencyKey: "refunddesk:p0:nonce",
      proof: "v1.proof",
      firstRefundId: null,
      candidateRefundIds: new Set<string>(),
    } as const;
    store.register(probe);
    expect(store.bindApiResponse("acct_1", "test", "nonce", "re_first")).toBe("internal");

    store.register({ ...probe, firstRefundId: null, candidateRefundIds: new Set() });
    expect(store.bindApiResponse("acct_1", "test", "nonce", "re_first")).toBe("internal");
    expect(() =>
      store.register({
        ...probe,
        amountMinor: "200",
        firstRefundId: null,
        candidateRefundIds: new Set(),
      }),
    ).toThrow(Phase0NonceConflictError);
  });

  it("flags a second Refund ID carrying a valid copied proof", () => {
    const store = new Phase0Store();
    store.register({
      requestNonce: "nonce",
      accountId: "acct_1",
      actorUserId: "usr_1",
      environment: "test",
      targetType: "payment_intent",
      targetId: "pi_1",
      paymentKey: "pi_1",
      amountMinor: "100",
      currency: "eur",
      reason: "requested_by_customer",
      idempotencyKey: "refunddesk:p0:nonce",
      proof: "v1.proof",
      firstRefundId: "re_first",
      candidateRefundIds: new Set(),
    });

    expect(
      store.observe({
        eventId: "evt_second",
        refundId: "re_second",
        accountId: "acct_1",
        environment: "test",
        paymentKey: "pi_1",
        amountMinor: "100",
        currency: "eur",
        requestNonce: "nonce",
        proof: "v1.proof",
        eventIdempotencyKey: null,
      }),
    ).toBe("proof_replay");
  });

  it("deduplicates a replayed Stripe Event receipt", () => {
    const store = new Phase0Store();
    const observedRefund = {
      eventId: "evt_external",
      refundId: "re_external",
      accountId: "acct_1",
      environment: "test",
      paymentKey: "pi_1",
      amountMinor: "100",
      currency: "eur",
      requestNonce: null,
      proof: null,
      eventIdempotencyKey: null,
    } as const;

    expect(store.observe(observedRefund)).toBe("outside_workflow");
    expect(store.observe(observedRefund)).toBe("outside_workflow");
    expect(store.report().evidence).toHaveLength(1);
  });

  it("scopes report evidence to the signed Stripe account and environment", () => {
    const store = new Phase0Store();
    for (const observed of [
      {
        eventId: "evt_test",
        refundId: "re_test",
        accountId: "acct_1",
        environment: "test",
      },
      {
        eventId: "evt_sandbox",
        refundId: "re_sandbox",
        accountId: "acct_1",
        environment: "sandbox",
      },
      {
        eventId: "evt_other",
        refundId: "re_other",
        accountId: "acct_2",
        environment: "test",
      },
    ] as const) {
      store.observe({
        ...observed,
        paymentKey: "pi_1",
        amountMinor: "100",
        currency: "eur",
        requestNonce: null,
        proof: null,
        eventIdempotencyKey: null,
      });
    }

    expect(store.report("acct_1", "test").evidence.map((item) => item.refundId)).toEqual([
      "re_test",
    ]);
  });

  it("resolves a webhook-before-response candidate without trusting metadata alone", () => {
    const store = new Phase0Store();
    store.register({
      requestNonce: "nonce",
      accountId: "acct_1",
      actorUserId: "usr_1",
      environment: "sandbox",
      targetType: "payment_intent",
      targetId: "pi_1",
      paymentKey: "pi_1",
      amountMinor: "100",
      currency: "eur",
      reason: "requested_by_customer",
      idempotencyKey: "refunddesk:p0:nonce",
      proof: "v1.proof",
      firstRefundId: null,
      candidateRefundIds: new Set(),
    });

    expect(
      store.observe({
        eventId: "evt_candidate",
        refundId: "re_candidate",
        accountId: "acct_1",
        environment: "sandbox",
        paymentKey: "pi_1",
        amountMinor: "100",
        currency: "eur",
        requestNonce: "nonce",
        proof: "v1.proof",
        eventIdempotencyKey: null,
      }),
    ).toBe("pending_correlation");

    expect(store.bindApiResponse("acct_1", "sandbox", "nonce", "re_candidate")).toBe("internal");
    expect(store.report().evidence.at(-1)?.correlation).toBe("internal");
  });
});
