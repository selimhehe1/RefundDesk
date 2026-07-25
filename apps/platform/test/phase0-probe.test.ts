import { describe, expect, it } from "vitest";

import type {
  CreateRefundInput,
  NormalizedPayment,
  NormalizedRefund,
} from "@refunddesk/stripe-adapter";

import {
  executePhase0Probe,
  Phase0PaymentIneligibleError,
  type ExecutePhase0ProbeInput,
  type Phase0ProbeGateway,
} from "../src/server/phase0-probe.js";
import { Phase0NonceConflictError, Phase0Store } from "../src/server/phase0-store.js";

const proofKey = Buffer.alloc(32, 7);
const installation = {
  stripeAccountId: "acct_phase0",
  environment: "test",
  active: true,
} as const;

function probeInput(overrides: Partial<ExecutePhase0ProbeInput> = {}): ExecutePhase0ProbeInput {
  return {
    installation,
    actorUserId: "usr_phase0",
    requestNonce: "nonce-full-refund",
    paymentIntentId: "pi_phase0",
    amountMinor: 1_000n,
    currency: "eur",
    reason: "requested_by_customer",
    ...overrides,
  };
}

class FakePhase0Stripe implements Phase0ProbeGateway {
  readonly createCalls: CreateRefundInput[] = [];
  retrieveCalls = 0;
  payment: NormalizedPayment = {
    paymentKey: "pi_phase0",
    paymentIntentId: "pi_phase0",
    chargeId: "ch_phase0",
    amountCaptured: 1_000n,
    amountRefunded: 0n,
    currency: "eur",
    captured: true,
    paid: true,
    disputed: false,
    paymentMethodType: "card",
    hasConnectSemantics: false,
  };
  private readonly refundsByKey = new Map<string, NormalizedRefund>();

  retrievePayment(): Promise<NormalizedPayment> {
    this.retrieveCalls += 1;
    return Promise.resolve(this.payment);
  }

  createRefund(input: CreateRefundInput): Promise<NormalizedRefund> {
    this.createCalls.push(input);
    const existing = this.refundsByKey.get(input.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const refund: NormalizedRefund = {
      id: "re_phase0_first",
      paymentIntentId: input.paymentIntentId ?? null,
      chargeId: "ch_phase0",
      amountMinor: input.amountMinor,
      currency: "eur",
      status: "succeeded",
      created: 1_893_499_200,
      metadata: input.metadata,
      requestId: "req_phase0",
    };
    this.refundsByKey.set(input.idempotencyKey, refund);
    this.payment = {
      ...this.payment,
      amountRefunded: this.payment.amountRefunded + input.amountMinor,
    };
    return Promise.resolve(refund);
  }
}

describe("executePhase0Probe", () => {
  it("calls Stripe twice with the same key after a full Refund and links the same Refund ID", async () => {
    const store = new Phase0Store();
    const stripe = new FakePhase0Stripe();
    const dependencies = { store, stripe, proofKey };

    const first = await executePhase0Probe(probeInput(), dependencies);
    const replay = await executePhase0Probe(probeInput(), dependencies);

    expect(first.refund.id).toBe("re_phase0_first");
    expect(replay.refund.id).toBe("re_phase0_first");
    expect(first.correlation).toBe("internal");
    expect(replay.correlation).toBe("internal");
    expect(first.replay).toBe(false);
    expect(replay.replay).toBe(true);
    expect(stripe.retrieveCalls).toBe(1);
    expect(stripe.createCalls).toHaveLength(2);
    expect(stripe.createCalls[0]?.idempotencyKey).toBe("refunddesk:p0:nonce-full-refund");
    expect(stripe.createCalls[1]).toEqual(stripe.createCalls[0]);
    expect(store.report("acct_phase0", "test").probes).toBe(1);
  });

  it("rejects a changed reason or target before a second Stripe call", async () => {
    const store = new Phase0Store();
    const stripe = new FakePhase0Stripe();
    const dependencies = { store, stripe, proofKey };
    await executePhase0Probe(probeInput({ amountMinor: 100n }), dependencies);

    await expect(
      executePhase0Probe(probeInput({ amountMinor: 100n, reason: "duplicate" }), dependencies),
    ).rejects.toBeInstanceOf(Phase0NonceConflictError);
    await expect(
      executePhase0Probe(
        probeInput({ amountMinor: 100n, paymentIntentId: "pi_other" }),
        dependencies,
      ),
    ).rejects.toBeInstanceOf(Phase0NonceConflictError);
    await expect(
      executePhase0Probe(probeInput({ amountMinor: 100n, actorUserId: "usr_other" }), dependencies),
    ).rejects.toBeInstanceOf(Phase0NonceConflictError);

    expect(stripe.retrieveCalls).toBe(1);
    expect(stripe.createCalls).toHaveLength(1);
  });

  it("still revalidates the remaining amount for every fresh nonce", async () => {
    const store = new Phase0Store();
    const stripe = new FakePhase0Stripe();
    const dependencies = { store, stripe, proofKey };
    await executePhase0Probe(probeInput(), dependencies);

    await expect(
      executePhase0Probe(probeInput({ requestNonce: "fresh-nonce" }), dependencies),
    ).rejects.toBeInstanceOf(Phase0PaymentIneligibleError);

    expect(stripe.retrieveCalls).toBe(2);
    expect(stripe.createCalls).toHaveLength(1);
  });
});
