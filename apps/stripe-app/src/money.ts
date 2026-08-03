const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

function currencyExponent(currency: string): 0 | 2 | 3 {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    return 0;
  }
  return THREE_DECIMAL_CURRENCIES.has(currency) ? 3 : 2;
}

const MINOR_AMOUNT_PATTERN = /^(?:0|[1-9]\d*)$/u;
const CURRENCY_PATTERN = /^[a-z]{3}$/u;

/**
 * Renders a minor-unit amount as the decimal a person types, without the unit suffix that
 * `formatMinorAmount` adds. Used to prefill and echo the refund amount field.
 */
export function formatMinorAsDecimal(amountMinor: string, currency: string): string {
  if (!MINOR_AMOUNT_PATTERN.test(amountMinor) || !CURRENCY_PATTERN.test(currency)) {
    return amountMinor;
  }
  const exponent = currencyExponent(currency);
  if (exponent === 0) {
    return amountMinor;
  }
  const padded = amountMinor.padStart(exponent + 1, "0");
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

export type ParsedAmount = { readonly minorAmount: string } | { readonly error: string };

/**
 * Converts a human amount ("25.50") into exact Stripe minor units ("2550").
 *
 * The conversion is string arithmetic on purpose: `Number("1.005") * 1000` is
 * 1004.9999999999999 in IEEE-754, and a refund that silently loses a unit is a financial
 * defect, not a rounding detail. Precision beyond the currency exponent is refused rather
 * than rounded, so the person decides what to refund instead of the code.
 */
export function parseAmountToMinor(input: string, currency: string): ParsedAmount {
  const invalid = { error: "Enter an amount, such as 12.34." } as const;
  if (!CURRENCY_PATTERN.test(currency)) {
    return { error: "The currency of this payment is unavailable." };
  }
  // Grouping spaces are common in French and German locales. `\s` with the unicode flag
  // already covers the non-breaking and narrow no-break spaces those locales use.
  const normalized = input.replace(/\s/gu, "").replace(",", ".");
  if (normalized.length === 0 || !/^\d+(?:\.\d+)?$/u.test(normalized)) {
    return invalid;
  }

  const exponent = currencyExponent(currency);
  const separatorIndex = normalized.indexOf(".");
  const whole = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const fraction = separatorIndex === -1 ? "" : normalized.slice(separatorIndex + 1);

  if (fraction.length > exponent) {
    const trimmed = fraction.replace(/0+$/u, "");
    if (trimmed.length > exponent) {
      return {
        error:
          exponent === 0
            ? `${currency.toUpperCase()} amounts cannot have decimals.`
            : `${currency.toUpperCase()} amounts cannot have more than ${exponent} decimals.`,
      };
    }
  }

  const minorAmount = `${whole}${fraction.padEnd(exponent, "0").slice(0, exponent)}`.replace(
    /^0+(?=\d)/u,
    "",
  );
  if (!MINOR_AMOUNT_PATTERN.test(minorAmount)) {
    return invalid;
  }
  if (minorAmount === "0") {
    return { error: "Enter an amount greater than zero." };
  }
  return { minorAmount };
}

export function formatMinorAmount(amountMinor: string, currency: string): string {
  if (!/^(?:0|[1-9]\d*)$/u.test(amountMinor) || !/^[a-z]{3}$/u.test(currency)) {
    return `${amountMinor} minor units (${currency.toUpperCase()})`;
  }
  const exponent = currencyExponent(currency);
  const padded = amountMinor.padStart(exponent + 1, "0");
  const decimalAmount =
    exponent === 0 ? padded : `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
  return `${decimalAmount} ${currency.toUpperCase()} — ${amountMinor} minor units`;
}
