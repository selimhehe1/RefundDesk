import {
  assertRefundAmountWithinRemaining,
  normalizeCurrency,
  remainingRefundableAmount,
} from "./money.js";

export type IneligibilityCode =
  | "NOT_PAID"
  | "NOT_CAPTURED"
  | "DISPUTED"
  | "CONNECT_UNSUPPORTED"
  | "PAYMENT_METHOD_UNSUPPORTED"
  | "CARD_PRESENT_UNSUPPORTED"
  | "NOTHING_REFUNDABLE"
  | "AMOUNT_EXCEEDS_REMAINING"
  | "CURRENCY_MISMATCH";

export interface PaymentEligibilityInput {
  readonly paymentKey: string;
  readonly amountCaptured: bigint;
  readonly amountRefunded: bigint;
  readonly currency: string;
  readonly paid: boolean;
  readonly captured: boolean;
  readonly disputed: boolean;
  readonly paymentMethodType: string | null;
  readonly hasConnectSemantics: boolean;
  readonly requestedAmountMinor?: bigint;
  readonly requestedCurrency?: string;
}

export type PaymentEligibility =
  | {
      readonly eligible: true;
      readonly paymentKey: string;
      readonly currency: string;
      readonly remainingMinor: bigint;
    }
  | {
      readonly eligible: false;
      readonly code: IneligibilityCode;
    };

export function evaluatePaymentEligibility(payment: PaymentEligibilityInput): PaymentEligibility {
  if (!payment.paid) {
    return { eligible: false, code: "NOT_PAID" };
  }
  if (!payment.captured) {
    return { eligible: false, code: "NOT_CAPTURED" };
  }
  if (payment.disputed) {
    return { eligible: false, code: "DISPUTED" };
  }
  if (payment.hasConnectSemantics) {
    return { eligible: false, code: "CONNECT_UNSUPPORTED" };
  }
  if (payment.paymentMethodType === "card_present") {
    return { eligible: false, code: "CARD_PRESENT_UNSUPPORTED" };
  }
  if (payment.paymentMethodType !== "card") {
    return { eligible: false, code: "PAYMENT_METHOD_UNSUPPORTED" };
  }

  const currency = normalizeCurrency(payment.currency);
  const remainingMinor = remainingRefundableAmount(payment.amountCaptured, payment.amountRefunded);
  if (remainingMinor === 0n) {
    return { eligible: false, code: "NOTHING_REFUNDABLE" };
  }

  if (
    payment.requestedCurrency !== undefined &&
    normalizeCurrency(payment.requestedCurrency) !== currency
  ) {
    return { eligible: false, code: "CURRENCY_MISMATCH" };
  }

  if (payment.requestedAmountMinor !== undefined) {
    try {
      assertRefundAmountWithinRemaining(payment.requestedAmountMinor, remainingMinor);
    } catch {
      return { eligible: false, code: "AMOUNT_EXCEEDS_REMAINING" };
    }
  }

  return {
    eligible: true,
    paymentKey: payment.paymentKey,
    currency,
    remainingMinor,
  };
}
