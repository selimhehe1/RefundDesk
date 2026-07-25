export type DomainErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_CURRENCY"
  | "INVALID_EFFECT_TRANSITION"
  | "INVALID_ENCRYPTION_KEY"
  | "INVALID_PROOF"
  | "INVALID_QUORUM"
  | "INVALID_WORKFLOW_TRANSITION"
  | "REQUEST_EXPIRED"
  | "SELF_APPROVAL"
  | "DUPLICATE_DECISION"
  | "REJECTION_JUSTIFICATION_REQUIRED"
  | "UNAUTHORIZED_CANCELLATION";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
