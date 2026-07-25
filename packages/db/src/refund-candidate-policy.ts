export type EventIdempotencyEvidence = "absent" | "exact" | "mismatch";

export type RefundCandidateDecision =
  | "already_linked"
  | "proof_replay"
  | "link_exact"
  | "link_unique"
  | "wait_for_complete_scan"
  | "conflict";

export function decideRefundCandidate(input: {
  readonly linkedRefundId: string | null;
  readonly candidateRefundId: string;
  readonly eventIdempotencyEvidence: EventIdempotencyEvidence;
  readonly candidateCount: number;
  readonly completeScan: boolean;
  readonly scanCoversExecution: boolean;
}): RefundCandidateDecision {
  if (!Number.isSafeInteger(input.candidateCount) || input.candidateCount < 1) {
    throw new RangeError("candidateCount must be a positive integer");
  }
  if (input.linkedRefundId !== null) {
    return input.linkedRefundId === input.candidateRefundId ? "already_linked" : "proof_replay";
  }
  if (input.eventIdempotencyEvidence === "exact") {
    return "link_exact";
  }
  if (input.eventIdempotencyEvidence === "mismatch" || input.candidateCount > 1) {
    return "conflict";
  }
  if (input.completeScan && input.scanCoversExecution) {
    return "link_unique";
  }
  return "wait_for_complete_scan";
}
