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
