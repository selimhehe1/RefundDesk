import type {
  CreateRefundInput,
  NormalizedPayment,
  NormalizedRefund,
  StripeInstallation,
} from "@refunddesk/stripe-adapter";

import { createPhase0Proof } from "./phase0-proof";
import type {
  Phase0Store,
  Phase0Correlation,
  Phase0Probe,
  Phase0ProbeIdentity,
} from "./phase0-store";

export type Phase0RefundReason = "duplicate" | "fraudulent" | "requested_by_customer";

export interface Phase0ProbeGateway {
  retrievePayment(
    installation: StripeInstallation,
    resourceType: "payment_intent",
    resourceId: string,
  ): Promise<NormalizedPayment>;
  createRefund(input: CreateRefundInput): Promise<NormalizedRefund>;
}

export interface ExecutePhase0ProbeInput {
  readonly installation: StripeInstallation & {
    readonly environment: "test" | "sandbox";
  };
  readonly actorUserId: string;
  readonly requestNonce: string;
  readonly paymentIntentId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reason: Phase0RefundReason;
}

export interface ExecutePhase0ProbeDependencies {
  readonly stripe: Phase0ProbeGateway;
  readonly store: Phase0Store;
  readonly proofKey: Buffer;
}

export interface ExecutePhase0ProbeResult {
  readonly refund: NormalizedRefund;
  readonly correlation: Phase0Correlation;
  readonly replay: boolean;
}

export class Phase0PaymentIneligibleError extends Error {
  constructor() {
    super("The payment is not an eligible captured card payment");
    this.name = "Phase0PaymentIneligibleError";
  }
}

export class Phase0RefundResponseMismatchError extends Error {
  constructor() {
    super("Stripe returned a Refund that does not match the phase-0 request");
    this.name = "Phase0RefundResponseMismatchError";
  }
}

function assertEligiblePayment(payment: NormalizedPayment, input: ExecutePhase0ProbeInput): void {
  const remaining = payment.amountCaptured - payment.amountRefunded;
  if (
    !payment.paid ||
    !payment.captured ||
    payment.disputed ||
    payment.paymentMethodType !== "card" ||
    payment.hasConnectSemantics ||
    payment.paymentIntentId !== input.paymentIntentId ||
    payment.paymentKey !== input.paymentIntentId ||
    input.currency !== payment.currency ||
    input.amountMinor <= 0n ||
    input.amountMinor > remaining
  ) {
    throw new Phase0PaymentIneligibleError();
  }
}

function assertMatchingRefund(refund: NormalizedRefund, probe: Phase0Probe): void {
  if (
    refund.paymentIntentId !== probe.targetId ||
    refund.amountMinor !== BigInt(probe.amountMinor) ||
    refund.currency !== probe.currency ||
    refund.metadata["refunddesk_request_id"] !== probe.requestNonce ||
    refund.metadata["refunddesk_proof"] !== probe.proof
  ) {
    throw new Phase0RefundResponseMismatchError();
  }
}

export async function executePhase0Probe(
  input: ExecutePhase0ProbeInput,
  dependencies: ExecutePhase0ProbeDependencies,
): Promise<ExecutePhase0ProbeResult> {
  const idempotencyKey = `refunddesk:p0:${input.requestNonce}`;
  const identity: Phase0ProbeIdentity = {
    accountId: input.installation.stripeAccountId,
    actorUserId: input.actorUserId,
    environment: input.installation.environment,
    requestNonce: input.requestNonce,
    targetType: "payment_intent",
    targetId: input.paymentIntentId,
    amountMinor: input.amountMinor.toString(),
    currency: input.currency,
    reason: input.reason,
    idempotencyKey,
  };

  let probe = dependencies.store.resolve(identity);
  let replay = probe !== null;
  if (probe === null) {
    const payment = await dependencies.stripe.retrievePayment(
      input.installation,
      "payment_intent",
      input.paymentIntentId,
    );
    assertEligiblePayment(payment, input);
    const proofPayload = {
      accountId: identity.accountId,
      environment: identity.environment,
      requestNonce: identity.requestNonce,
      paymentKey: payment.paymentKey,
      amountMinor: identity.amountMinor,
      currency: identity.currency,
    } as const;
    const candidate: Phase0Probe = {
      ...identity,
      paymentKey: payment.paymentKey,
      proof: createPhase0Proof(proofPayload, dependencies.proofKey),
      firstRefundId: null,
      candidateRefundIds: new Set(),
    };
    probe = dependencies.store.register(candidate);
    replay = probe !== candidate;
  }

  const refund = await dependencies.stripe.createRefund({
    installation: input.installation,
    paymentIntentId: probe.targetId,
    amountMinor: BigInt(probe.amountMinor),
    reason: probe.reason,
    metadata: {
      refunddesk_request_id: probe.requestNonce,
      refunddesk_proof: probe.proof,
    },
    idempotencyKey: probe.idempotencyKey,
  });
  assertMatchingRefund(refund, probe);

  return {
    refund,
    correlation: dependencies.store.bindApiResponse(
      probe.accountId,
      probe.environment,
      probe.requestNonce,
      refund.id,
    ),
    replay,
  };
}
