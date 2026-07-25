export type RefundFailureClass = "retryable" | "terminal" | "ambiguous";

export type RefundFailureKind =
  | "network"
  | "timeout"
  | "rate_limit"
  | "api_error"
  | "authentication"
  | "permission"
  | "invalid_request"
  | "idempotency"
  | "not_found"
  | "conflict"
  | "unknown";

export interface RefundFailureSignal {
  readonly kind: RefundFailureKind;
  readonly httpStatus?: number;
  readonly effectBoundaryCrossed: boolean;
}

export interface ClassifiedRefundFailure {
  readonly classification: RefundFailureClass;
  readonly retryWithSameIdempotencyKey: boolean;
}

export function classifyRefundFailure(signal: RefundFailureSignal): ClassifiedRefundFailure {
  if (
    signal.effectBoundaryCrossed &&
    (signal.kind === "network" ||
      signal.kind === "timeout" ||
      signal.kind === "api_error" ||
      signal.kind === "idempotency" ||
      signal.kind === "conflict" ||
      signal.kind === "unknown" ||
      signal.httpStatus === 409 ||
      (signal.httpStatus !== undefined && signal.httpStatus >= 500))
  ) {
    return { classification: "ambiguous", retryWithSameIdempotencyKey: true };
  }

  if (
    signal.kind === "authentication" ||
    signal.kind === "permission" ||
    signal.kind === "invalid_request" ||
    signal.kind === "idempotency" ||
    signal.kind === "not_found" ||
    signal.kind === "conflict" ||
    (signal.httpStatus !== undefined &&
      signal.httpStatus >= 400 &&
      signal.httpStatus < 500 &&
      signal.httpStatus !== 409 &&
      signal.httpStatus !== 429)
  ) {
    return { classification: "terminal", retryWithSameIdempotencyKey: false };
  }

  if (signal.kind === "rate_limit" || signal.httpStatus === 429) {
    return { classification: "retryable", retryWithSameIdempotencyKey: true };
  }

  return { classification: "retryable", retryWithSameIdempotencyKey: true };
}
