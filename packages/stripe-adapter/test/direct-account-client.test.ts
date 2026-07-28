import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  retrieveCharge: vi.fn(),
  createRefund: vi.fn(),
  retrieveRefund: vi.fn(),
  listRefunds: vi.fn(),
}));

vi.mock("stripe", () => {
  class FakeStripe {
    static readonly webhooks = {
      constructEvent: vi.fn(),
    };

    readonly paymentIntents = {
      retrieve: stripeMocks.retrievePaymentIntent,
    };

    readonly charges = {
      retrieve: stripeMocks.retrieveCharge,
    };

    readonly refunds = {
      create: stripeMocks.createRefund,
      retrieve: stripeMocks.retrieveRefund,
      list: stripeMocks.listRefunds,
    };

    constructor(apiKey: string, options: unknown) {
      stripeMocks.constructor(apiKey, options);
    }
  }

  return { default: FakeStripe };
});

import {
  DirectAccountStripeClient,
  StripeAccountMismatchError,
  StripeConnectSemanticsError,
  StripeCredentialResolver,
} from "../src/index.js";

const testInstallation = {
  active: true,
  environment: "test",
  stripeAccountId: "acct_direct_test",
} as const;

function createClient(): DirectAccountStripeClient {
  return new DirectAccountStripeClient(
    new StripeCredentialResolver({
      platformTest: {
        apiKey: "platform-test-key",
        expectedAccountId: "acct_direct_test",
      },
      managedSandbox: {
        apiKey: "managed-sandbox-key",
        expectedAccountId: "acct_direct_sandbox",
      },
    }),
  );
}

function directRefund(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "re_direct",
    payment_intent: "pi_direct",
    charge: "ch_direct",
    amount: 500,
    currency: "eur",
    status: "succeeded",
    created: 1_800_000_000,
    metadata: {},
    source_transfer_reversal: null,
    transfer_reversal: null,
    ...overrides,
  };
}

function directCharge(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "ch_direct",
    payment_intent: "pi_direct",
    amount_captured: 1_000,
    amount_refunded: 0,
    currency: "eur",
    captured: true,
    paid: true,
    disputed: false,
    payment_method_details: { type: "card" },
    application: null,
    application_fee: null,
    on_behalf_of: null,
    source_transfer: null,
    transfer: null,
    transfer_group: null,
    ...overrides,
  };
}

function directPaymentIntent(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "pi_direct",
    latest_charge: directCharge(),
    application: null,
    application_fee_amount: null,
    on_behalf_of: null,
    transfer_data: null,
    transfer_group: null,
    ...overrides,
  };
}

describe("DirectAccountStripeClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an account mismatch before constructing a Stripe client or making a request", async () => {
    const client = createClient();

    await expect(
      client.retrieveRefund(
        {
          ...testInstallation,
          stripeAccountId: "acct_wrong",
        },
        "re_direct",
      ),
    ).rejects.toThrow(StripeAccountMismatchError);

    expect(stripeMocks.constructor).not.toHaveBeenCalled();
    expect(stripeMocks.retrieveRefund).not.toHaveBeenCalled();
  });

  it("retrieves direct-account payments without Stripe-Account request options", async () => {
    stripeMocks.retrievePaymentIntent.mockResolvedValue(directPaymentIntent());
    const client = createClient();

    await expect(
      client.retrievePayment(testInstallation, "payment_intent", "pi_direct"),
    ).resolves.toMatchObject({
      paymentIntentId: "pi_direct",
      chargeId: "ch_direct",
      hasConnectSemantics: false,
    });

    expect(stripeMocks.retrievePaymentIntent).toHaveBeenCalledWith("pi_direct", {
      expand: ["latest_charge"],
    });
  });

  it("preserves only the deterministic idempotency key in refund request options", async () => {
    stripeMocks.createRefund.mockResolvedValue({
      ...directRefund(),
      lastResponse: { requestId: "req_direct" },
    });
    const client = createClient();

    await client.createRefund({
      installation: testInstallation,
      paymentIntentId: "pi_direct",
      amountMinor: 500n,
      reason: "requested_by_customer",
      metadata: {
        refunddesk_request_id: "11111111-1111-4111-8111-111111111111",
        refunddesk_proof: "v1.proof",
      },
      idempotencyKey: "refunddesk:refund-request:11111111-1111-4111-8111-111111111111:v1",
    });

    expect(stripeMocks.createRefund).toHaveBeenCalledWith(
      {
        payment_intent: "pi_direct",
        amount: 500,
        reason: "requested_by_customer",
        metadata: {
          refunddesk_request_id: "11111111-1111-4111-8111-111111111111",
          refunddesk_proof: "v1.proof",
        },
      },
      {
        idempotencyKey: "refunddesk:refund-request:11111111-1111-4111-8111-111111111111:v1",
      },
    );
  });

  it("lists direct-account refunds without Stripe-Account request options", async () => {
    stripeMocks.listRefunds.mockResolvedValue({
      data: [directRefund()],
      has_more: false,
    });
    const client = createClient();

    await client.listRefunds(testInstallation, {
      gte: 1_799_999_000,
      lte: 1_800_000_000,
    });

    expect(stripeMocks.listRefunds).toHaveBeenCalledWith({
      created: {
        gte: 1_799_999_000,
        lte: 1_800_000_000,
      },
      limit: 100,
    });
  });

  it("rejects a PaymentIntent carrying Connect semantics", async () => {
    stripeMocks.retrievePaymentIntent.mockResolvedValue(
      directPaymentIntent({ transfer_group: "group_connect" }),
    );
    const client = createClient();

    await expect(
      client.retrievePayment(testInstallation, "payment_intent", "pi_direct"),
    ).rejects.toThrow(StripeConnectSemanticsError);
  });

  it("rejects a Charge carrying Connect semantics before retrieving its PaymentIntent", async () => {
    stripeMocks.retrieveCharge.mockResolvedValue(directCharge({ on_behalf_of: "acct_connected" }));
    const client = createClient();

    await expect(client.retrievePayment(testInstallation, "charge", "ch_direct")).rejects.toThrow(
      StripeConnectSemanticsError,
    );

    expect(stripeMocks.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects Refund objects carrying Connect transfer-reversal semantics", async () => {
    stripeMocks.retrieveRefund.mockResolvedValue(
      directRefund({ transfer_reversal: "trr_connect" }),
    );
    const client = createClient();

    await expect(client.retrieveRefund(testInstallation, "re_direct")).rejects.toThrow(
      StripeConnectSemanticsError,
    );
  });
});
