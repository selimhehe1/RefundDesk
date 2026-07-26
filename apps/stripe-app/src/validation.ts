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

export function parseApproverUserIds(value: string): string[] {
  return parseApproverUserIdsStrict(value).approverUserIds;
}

export function parseApproverUserIdsStrict(value: string): {
  readonly approverUserIds: string[];
  readonly invalidValues: string[];
} {
  const values = value
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return {
    approverUserIds: [...new Set(values.filter((item) => /^usr_[A-Za-z0-9]+$/u.test(item)))],
    invalidValues: [...new Set(values.filter((item) => !/^usr_[A-Za-z0-9]+$/u.test(item)))],
  };
}
