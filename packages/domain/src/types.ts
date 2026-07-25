export const WORKFLOW_STATUSES = [
  "pending_approval",
  "approved",
  "executing",
  "reconciliation_required",
  "succeeded",
  "failed_terminal",
  "rejected",
  "canceled",
  "expired",
  "stale",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const STRIPE_REFUND_STATUSES = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
] as const;

export type StripeRefundStatus = (typeof STRIPE_REFUND_STATUSES)[number];

export const ABSENCE_PROVING_STRIPE_REFUND_STATUSES = ["failed", "canceled"] as const;

export type AbsenceProvingStripeRefundStatus =
  (typeof ABSENCE_PROVING_STRIPE_REFUND_STATUSES)[number];

export const EFFECT_STATES = ["not_started", "possible", "identified", "absence_proven"] as const;

export type EffectState = (typeof EFFECT_STATES)[number];

export type StripeEnvironment = "live" | "test" | "sandbox";
export type RefundReason = "duplicate" | "fraudulent" | "requested_by_customer";
export type ApprovalDecisionKind = "approve" | "reject";

export interface ApprovalDecision {
  readonly approverId: string;
  readonly decision: ApprovalDecisionKind;
  readonly decidedAt: Date;
}

export interface RefundWorkflow {
  readonly id: string;
  readonly requesterId: string;
  readonly requiredApprovals: number;
  readonly expiresAt: Date;
  readonly status: WorkflowStatus;
  readonly effectState: EffectState;
  readonly stripeRefundId: string | null;
  readonly stripeRefundStatus: StripeRefundStatus | null;
  readonly decisions: readonly ApprovalDecision[];
}
