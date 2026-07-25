import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { canonicalJson, serializeSignedEnvelope, type SignedEnvelope } from "@refunddesk/contracts";
import type { CreateRefundInput, NormalizedRefund } from "@refunddesk/stripe-adapter";

const stripeState = vi.hoisted(() => ({
  amountRefunded: 0n,
  createCalls: [] as CreateRefundInput[],
  retrieveCalls: 0,
  refundsByKey: new Map<string, NormalizedRefund>(),
}));

vi.mock("@refunddesk/config", () => ({
  loadConfig: () => ({
    nodeEnv: "test",
    phase0ProbeEnabled: true,
    phase0AllowedPaymentIntents: new Set(["pi_phase0route"]),
    stripe: {
      appSigningSecret: "absec_phase0_route_test",
      platformTestKey: "sk_test_phase0_route",
      managedSandboxKey: "sk_test_phase0_sandbox",
    },
    keys: { proofV1: Buffer.alloc(32, 9) },
  }),
}));

vi.mock("@refunddesk/stripe-adapter", () => ({
  StripeCredentialResolver: class StripeCredentialResolver {},
  ConnectedAccountStripeClient: class ConnectedAccountStripeClient {
    retrievePayment() {
      stripeState.retrieveCalls += 1;
      return Promise.resolve({
        paymentKey: "pi_phase0route",
        paymentIntentId: "pi_phase0route",
        chargeId: "ch_phase0route",
        amountCaptured: 1_000n,
        amountRefunded: stripeState.amountRefunded,
        currency: "eur",
        captured: true,
        paid: true,
        disputed: false,
        paymentMethodType: "card",
        hasConnectSemantics: false,
      });
    }

    createRefund(input: CreateRefundInput) {
      stripeState.createCalls.push(input);
      const prior = stripeState.refundsByKey.get(input.idempotencyKey);
      if (prior !== undefined) {
        return Promise.resolve(prior);
      }
      const refund: NormalizedRefund = {
        id: "re_phase0route",
        paymentIntentId: input.paymentIntentId ?? null,
        chargeId: "ch_phase0route",
        amountMinor: input.amountMinor,
        currency: "eur",
        status: "succeeded",
        created: 1_893_499_200,
        metadata: input.metadata,
        requestId: "req_phase0route",
      };
      stripeState.refundsByKey.set(input.idempotencyKey, refund);
      stripeState.amountRefunded += input.amountMinor;
      return Promise.resolve(refund);
    }
  },
}));

import { POST } from "../app/api/internal/phase0/refund-probe/route.js";

function signedRequest(
  reason: "duplicate" | "fraudulent" | "requested_by_customer" = "requested_by_customer",
  userId = "usr_Phase0Route",
  roles: SignedEnvelope["stripe_roles"] = [
    { id: "super_admin", type: "builtIn", name: "Super Administrator" },
  ],
): Request {
  const command = {
    amount_minor: "1000",
    currency: "eur",
    reason,
  } as const;
  const envelope: SignedEnvelope = {
    operation: "phase0.refund_probe",
    request_nonce: "9a4c531b-450e-44b0-b840-3073fb054373",
    mode: "test",
    is_sandbox: false,
    resource_type: "payment_intent",
    resource_id: "pi_phase0route",
    command_json: canonicalJson(command),
    stripe_roles: roles,
    user_id: userId,
    account_id: "acct_Phase0Route",
  };
  const body = serializeSignedEnvelope(envelope);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: "absec_phase0_route_test",
  });
  return new Request("http://localhost/api/internal/phase0/refund-probe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body,
  });
}

describe("phase-0 Refund route idempotency", () => {
  it("rejects a custom role even when its stable ID and display name mimic an Administrator", async () => {
    const response = await POST(
      signedRequest("requested_by_customer", "usr_CustomRole", [
        { id: "super_admin", type: "custom", name: "Super Administrator" },
      ]),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(stripeState.createCalls).toHaveLength(0);
  });

  it("replays a full Refund through Stripe and rejects changed parameters before another call", async () => {
    const first = await POST(signedRequest());
    const replay = await POST(signedRequest());
    const conflict = await POST(signedRequest("duplicate"));
    const actorConflict = await POST(
      signedRequest("requested_by_customer", "usr_OtherPhase0Admin"),
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      refund_id: "re_phase0route",
      correlation: "internal",
      replay: false,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      refund_id: "re_phase0route",
      correlation: "internal",
      replay: true,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(actorConflict.status).toBe(409);
    expect(await actorConflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(stripeState.retrieveCalls).toBe(1);
    expect(stripeState.createCalls).toHaveLength(2);
    expect(stripeState.createCalls[1]).toEqual(stripeState.createCalls[0]);
  });
});
