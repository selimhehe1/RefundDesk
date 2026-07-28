import Stripe from "stripe";

export * from "./signed-extension-request.js";

export type StripeEnvironment = "test" | "sandbox" | "live";

export interface StripeInstallation {
  readonly stripeAccountId: string;
  readonly environment: StripeEnvironment;
  readonly active: boolean;
}

export interface StripeCredentialSet {
  readonly platformTestKey: string;
  readonly managedSandboxKey: string;
}

export class UnsupportedStripeEnvironmentError extends Error {
  constructor(environment: StripeEnvironment) {
    super(`No enabled Stripe credentials for environment: ${environment}`);
    this.name = "UnsupportedStripeEnvironmentError";
  }
}

export class StripeCredentialResolver {
  constructor(private readonly credentials: StripeCredentialSet) {}

  resolve(installation: StripeInstallation): string {
    if (!installation.active) {
      throw new Error("Stripe installation is not active");
    }

    switch (installation.environment) {
      case "test":
        return this.credentials.platformTestKey;
      case "sandbox":
        return this.credentials.managedSandboxKey;
      case "live":
        throw new UnsupportedStripeEnvironmentError("live");
    }
  }
}

export interface NormalizedPayment {
  readonly paymentKey: string;
  readonly paymentIntentId: string | null;
  readonly chargeId: string;
  readonly amountCaptured: bigint;
  readonly amountRefunded: bigint;
  readonly currency: string;
  readonly captured: boolean;
  readonly paid: boolean;
  readonly disputed: boolean;
  readonly paymentMethodType: string | null;
  readonly hasConnectSemantics: boolean;
}

export interface CreateRefundInput {
  readonly installation: StripeInstallation;
  readonly paymentIntentId?: string;
  readonly chargeId?: string;
  readonly amountMinor: bigint;
  readonly reason: "duplicate" | "fraudulent" | "requested_by_customer";
  readonly metadata: {
    readonly refunddesk_request_id: string;
    readonly refunddesk_proof: string;
  };
  readonly idempotencyKey: string;
}

export interface NormalizedRefund {
  readonly id: string;
  readonly paymentIntentId: string | null;
  readonly chargeId: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled" | null;
  readonly created: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly requestId: string | null;
}

export interface RefundPage {
  readonly refunds: readonly NormalizedRefund[];
  readonly hasMore: boolean;
}

const apiVersion = "2026-06-24.dahlia" as const;

function stripeId(value: string | { id: string } | null): string | null {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : value.id;
}

function normalizeRefundStatus(status: string | null): NormalizedRefund["status"] {
  switch (status) {
    case "pending":
    case "requires_action":
    case "succeeded":
    case "failed":
    case "canceled":
      return status;
    default:
      return null;
  }
}

function normalizeRefund(refund: Stripe.Refund, requestId: string | null = null): NormalizedRefund {
  return {
    id: refund.id,
    paymentIntentId: stripeId(refund.payment_intent),
    chargeId: stripeId(refund.charge),
    amountMinor: BigInt(refund.amount),
    currency: refund.currency,
    status: normalizeRefundStatus(refund.status),
    created: refund.created,
    metadata: refund.metadata ?? {},
    requestId,
  };
}

export class ConnectedAccountStripeClient {
  constructor(private readonly resolver: StripeCredentialResolver) {}

  private client(installation: StripeInstallation): Stripe {
    return new Stripe(this.resolver.resolve(installation), {
      apiVersion,
      maxNetworkRetries: 0,
      telemetry: false,
    });
  }

  async retrievePayment(
    installation: StripeInstallation,
    resourceType: "payment_intent" | "charge",
    resourceId: string,
  ): Promise<NormalizedPayment> {
    const stripe = this.client(installation);
    const options: Stripe.RequestOptions = { stripeAccount: installation.stripeAccountId };

    let paymentIntent: Stripe.PaymentIntent | null = null;
    let charge: Stripe.Charge;

    if (resourceType === "payment_intent") {
      paymentIntent = await stripe.paymentIntents.retrieve(
        resourceId,
        { expand: ["latest_charge"] },
        options,
      );
      if (paymentIntent.latest_charge === null || typeof paymentIntent.latest_charge === "string") {
        throw new Error("PaymentIntent has no retrievable latest Charge");
      }
      charge = paymentIntent.latest_charge;
    } else {
      charge = await stripe.charges.retrieve(resourceId, {}, options);
      const paymentIntentId = stripeId(charge.payment_intent);
      if (paymentIntentId !== null) {
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {}, options);
      }
    }

    return {
      paymentKey: paymentIntent?.id ?? charge.id,
      paymentIntentId: paymentIntent?.id ?? stripeId(charge.payment_intent),
      chargeId: charge.id,
      amountCaptured: BigInt(charge.amount_captured),
      amountRefunded: BigInt(charge.amount_refunded),
      currency: charge.currency,
      captured: charge.captured,
      paid: charge.paid,
      disputed: charge.disputed,
      paymentMethodType: charge.payment_method_details?.type ?? null,
      hasConnectSemantics:
        charge.application != null ||
        charge.application_fee != null ||
        charge.on_behalf_of != null ||
        charge.source_transfer != null ||
        charge.transfer != null ||
        charge.transfer_group != null ||
        paymentIntent?.application != null ||
        paymentIntent?.application_fee_amount != null ||
        paymentIntent?.on_behalf_of != null ||
        paymentIntent?.transfer_data != null ||
        paymentIntent?.transfer_group != null,
    };
  }

  async createRefund(input: CreateRefundInput): Promise<NormalizedRefund> {
    if ((input.paymentIntentId === undefined) === (input.chargeId === undefined)) {
      throw new TypeError("Provide exactly one PaymentIntent or Charge identifier");
    }

    if (input.amountMinor <= 0n || input.amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("Refund amount is outside Stripe's safe integer range");
    }

    const stripe = this.client(input.installation);
    let target: Stripe.RefundCreateParams;
    if (input.paymentIntentId !== undefined) {
      target = { payment_intent: input.paymentIntentId };
    } else if (input.chargeId !== undefined) {
      target = { charge: input.chargeId };
    } else {
      throw new TypeError("A Stripe refund target is required");
    }
    const refund = await stripe.refunds.create(
      {
        ...target,
        amount: Number(input.amountMinor),
        reason: input.reason,
        metadata: input.metadata,
      },
      {
        stripeAccount: input.installation.stripeAccountId,
        idempotencyKey: input.idempotencyKey,
      },
    );
    return normalizeRefund(refund, refund.lastResponse.requestId);
  }

  async retrieveRefund(
    installation: StripeInstallation,
    refundId: string,
  ): Promise<NormalizedRefund> {
    if (!/^re_[A-Za-z0-9]+$/u.test(refundId)) {
      throw new TypeError("Invalid Stripe Refund identifier");
    }

    const stripe = this.client(installation);
    const refund = await stripe.refunds.retrieve(
      refundId,
      {},
      { stripeAccount: installation.stripeAccountId },
    );
    return normalizeRefund(refund);
  }

  async listRefunds(
    installation: StripeInstallation,
    created: { readonly gte: number; readonly lte: number },
    startingAfter?: string,
  ): Promise<RefundPage> {
    const stripe = this.client(installation);
    const page = await stripe.refunds.list(
      {
        created: { gte: created.gte, lte: created.lte },
        limit: 100,
        ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
      },
      { stripeAccount: installation.stripeAccountId },
    );
    return {
      refunds: page.data.map((refund) => normalizeRefund(refund)),
      hasMore: page.has_more,
    };
  }

  constructWebhookEvent(rawBody: Buffer, signature: string, signingSecret: string): Stripe.Event {
    return Stripe.webhooks.constructEvent(rawBody, signature, signingSecret, 300);
  }
}
