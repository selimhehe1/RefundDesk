import type { RefundReason } from "./api/client";

export interface RefundFormValues {
  readonly amountMinor: string;
  readonly justification: string;
  readonly reason: RefundReason;
}

export interface RefundFormErrors {
  readonly amount?: string;
  readonly justification?: string;
}

export function validateRefundForm(
  values: RefundFormValues,
  remainingAmountMinor: string,
): RefundFormErrors {
  const errors: { amount?: string; justification?: string } = {};
  if (!/^[1-9]\d*$/u.test(values.amountMinor)) {
    errors.amount = "Enter a positive whole amount in minor units.";
  } else {
    try {
      if (BigInt(values.amountMinor) > BigInt(remainingAmountMinor)) {
        errors.amount = "The amount exceeds the refundable balance.";
      }
    } catch {
      errors.amount = "The refundable balance is unavailable.";
    }
  }

  const justificationLength = values.justification.trim().length;
  if (justificationLength < 10 || justificationLength > 2_000) {
    errors.justification = "Provide a justification between 10 and 2,000 characters.";
  }
  return errors;
}

// Approver identifiers are no longer typed: Settings ticks people returned by the API, so
// the free-text parsers that used to back that field were removed with it.
