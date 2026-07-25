import { classifyRefundFailure, type RefundFailureKind } from "@refunddesk/domain";

export interface NormalizedStripeFailure {
  readonly code: string;
  readonly classification: "retryable" | "terminal" | "ambiguous";
  readonly retryWithSameIdempotencyKey: boolean;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function statusCodeOf(error: Readonly<Record<string, unknown>>): number | undefined {
  const value = error["statusCode"];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function kindOf(error: Readonly<Record<string, unknown>>): RefundFailureKind {
  const type = error["type"];
  const code = error["code"];
  const name = error["name"];

  if (type === "StripeRateLimitError" || code === "rate_limit") {
    return "rate_limit";
  }
  if (type === "StripeAuthenticationError") {
    return "authentication";
  }
  if (type === "StripePermissionError") {
    return "permission";
  }
  if (type === "StripeInvalidRequestError") {
    return "invalid_request";
  }
  if (type === "StripeIdempotencyError") {
    return "idempotency";
  }
  if (type === "StripeAPIError") {
    return "api_error";
  }
  if (type === "StripeConnectionError") {
    return "network";
  }
  if (name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return "timeout";
  }
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ENETUNREACH"
  ) {
    return "network";
  }

  const statusCode = statusCodeOf(error);
  if (statusCode === 404) {
    return "not_found";
  }
  if (statusCode === 409) {
    return "conflict";
  }
  return "unknown";
}

function safeCode(kind: RefundFailureKind, error: Readonly<Record<string, unknown>>): string {
  const supplied = error["code"];
  if (
    typeof supplied === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$/u.test(supplied) &&
    !/^(?:(?:sk|rk)_(?:test|live)_|(?:whsec|absec)_)/u.test(supplied)
  ) {
    return supplied;
  }
  return `STRIPE_${kind.toUpperCase()}`;
}

export function normalizeStripeFailure(
  value: unknown,
  effectBoundaryCrossed: boolean,
): NormalizedStripeFailure {
  const error = recordOf(value);
  const kind = kindOf(error);
  const statusCode = statusCodeOf(error);
  const classification = classifyRefundFailure({
    kind,
    effectBoundaryCrossed,
    ...(statusCode === undefined ? {} : { httpStatus: statusCode }),
  });
  return {
    code: safeCode(kind, error),
    ...classification,
  };
}
