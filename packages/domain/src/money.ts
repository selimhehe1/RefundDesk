import { DomainError } from "./errors.js";

const CURRENCY_PATTERN = /^[a-z]{3}$/u;

export function normalizeCurrency(currency: string): string {
  const normalized = currency.trim().toLowerCase();
  if (!CURRENCY_PATTERN.test(normalized)) {
    throw new DomainError("INVALID_CURRENCY", "Currency must be a three-letter ISO code");
  }
  return normalized;
}

export function assertPositiveMinorAmount(amountMinor: bigint): void {
  if (amountMinor <= 0n) {
    throw new DomainError("INVALID_AMOUNT", "Amount must be positive");
  }
}

export function remainingRefundableAmount(amountCaptured: bigint, amountRefunded: bigint): bigint {
  if (amountCaptured < 0n || amountRefunded < 0n || amountRefunded > amountCaptured) {
    throw new DomainError("INVALID_AMOUNT", "Payment totals are inconsistent");
  }
  return amountCaptured - amountRefunded;
}

export function assertRefundAmountWithinRemaining(
  amountMinor: bigint,
  remainingMinor: bigint,
): void {
  assertPositiveMinorAmount(amountMinor);
  if (remainingMinor < 0n || amountMinor > remainingMinor) {
    throw new DomainError("INVALID_AMOUNT", "Amount exceeds the refundable balance");
  }
}
