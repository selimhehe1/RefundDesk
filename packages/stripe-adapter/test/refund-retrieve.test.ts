import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  retrieveRefund: vi.fn(),
}));

vi.mock("stripe", () => {
  class FakeStripe {
    static readonly webhooks = {
      constructEvent: vi.fn(),
    };

    readonly refunds = {
      retrieve: stripeMocks.retrieveRefund,
    };
  }

  return { default: FakeStripe };
});

import { ConnectedAccountStripeClient, StripeCredentialResolver } from "../src/index.js";

describe("ConnectedAccountStripeClient.retrieveRefund", () => {
  beforeEach(() => {
    stripeMocks.retrieveRefund.mockReset();
  });

  it("retrieves and normalizes a linked Refund in its connected test account", async () => {
    stripeMocks.retrieveRefund.mockResolvedValue({
      id: "re_linked",
      payment_intent: "pi_linked",
      charge: "ch_linked",
      amount: 500,
      currency: "eur",
      status: "failed",
      created: 1_800_000_000,
      metadata: {
        refunddesk_request_id: "11111111-1111-4111-8111-111111111111",
      },
    });
    const client = new ConnectedAccountStripeClient(
      new StripeCredentialResolver({
        platformTestKey: "sk_test_platform",
        managedSandboxKey: "sk_test_sandbox",
      }),
    );

    await expect(
      client.retrieveRefund(
        {
          active: true,
          environment: "test",
          stripeAccountId: "acct_linked",
        },
        "re_linked",
      ),
    ).resolves.toEqual({
      id: "re_linked",
      paymentIntentId: "pi_linked",
      chargeId: "ch_linked",
      amountMinor: 500n,
      currency: "eur",
      status: "failed",
      created: 1_800_000_000,
      metadata: {
        refunddesk_request_id: "11111111-1111-4111-8111-111111111111",
      },
      requestId: null,
    });
    expect(stripeMocks.retrieveRefund).toHaveBeenCalledWith(
      "re_linked",
      {},
      { stripeAccount: "acct_linked" },
    );
  });

  it("rejects malformed Refund IDs before making a Stripe request", async () => {
    const client = new ConnectedAccountStripeClient(
      new StripeCredentialResolver({
        platformTestKey: "sk_test_platform",
        managedSandboxKey: "sk_test_sandbox",
      }),
    );

    await expect(
      client.retrieveRefund(
        {
          active: true,
          environment: "test",
          stripeAccountId: "acct_linked",
        },
        "pi_not_a_refund",
      ),
    ).rejects.toThrow("Invalid Stripe Refund identifier");
    expect(stripeMocks.retrieveRefund).not.toHaveBeenCalled();
  });
});
