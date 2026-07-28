export type PilotErrorCode =
  | "ACCOUNT_ENVIRONMENT_MISMATCH"
  | "ADMIN_REQUIRED"
  | "APPROVAL_ATTESTATION_REQUIRED"
  | "APPROVER_REQUIRED"
  | "COMMAND_INVALID"
  | "ENVELOPE_NON_CANONICAL"
  | "IDEMPOTENCY_CONFLICT"
  | "INSTALLATION_INACTIVE"
  | "INSTALLATION_NOT_FOUND"
  | "INTERNAL_ERROR"
  | "LIVE_MODE_DISABLED"
  | "NO_DISTINCT_APPROVER"
  | "PAYMENT_NOT_ELIGIBLE"
  | "PILOT_BACKEND_UNAVAILABLE"
  | "REQUEST_TOO_LARGE"
  | "REQUEST_NOT_FOUND"
  | "RESOURCE_MISMATCH"
  | "ROUTE_MISMATCH"
  | "SELF_APPROVAL"
  | "UNAUTHORIZED"
  | "WORKFLOW_CONFLICT";

export class PilotApiError extends Error {
  constructor(
    readonly code: PilotErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 500 | 503,
    publicMessage: string,
    options?: ErrorOptions,
  ) {
    super(publicMessage, options);
    this.name = "PilotApiError";
  }
}

export function asSafePilotError(error: unknown): PilotApiError {
  if (error instanceof PilotApiError) {
    return error;
  }
  return new PilotApiError("INTERNAL_ERROR", 500, "RefundDesk could not complete the request.");
}
