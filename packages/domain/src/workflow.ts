import { DomainError } from "./errors.js";
import { transitionEffectState } from "./effect.js";
import type {
  ApprovalDecision,
  ApprovalDecisionKind,
  EffectState,
  RefundWorkflow,
  StripeRefundStatus,
  WorkflowStatus,
} from "./types.js";

const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  pending_approval: ["approved", "rejected", "canceled", "expired", "stale"],
  approved: ["executing", "stale"],
  executing: ["succeeded", "reconciliation_required", "failed_terminal"],
  reconciliation_required: ["succeeded", "failed_terminal", "executing"],
  succeeded: ["failed_terminal"],
  failed_terminal: [],
  rejected: [],
  canceled: [],
  expired: [],
  stale: [],
};

export interface LinkedRefundTerminalCorrection {
  readonly kind: "linked_refund_terminal_correction";
  readonly previousEffectState: "identified";
  readonly nextEffectState: "absence_proven";
  readonly linkedStripeRefundId: string;
  readonly observedStripeRefundId: string;
  readonly previousStripeRefundStatus: "succeeded";
  readonly authoritativeStripeRefundStatus: "failed";
}

export interface StandardTransitionContext {
  readonly effectState: EffectState;
  readonly stripeRefundStatus?: StripeRefundStatus | null;
  readonly linkedRefundTerminalCorrection?: never;
}

export interface LinkedRefundTerminalCorrectionContext {
  readonly effectState: "absence_proven";
  readonly stripeRefundStatus: "failed";
  readonly linkedRefundTerminalCorrection: LinkedRefundTerminalCorrection;
}

export type TransitionContext = StandardTransitionContext | LinkedRefundTerminalCorrectionContext;

export function transitionWorkflowStatus(
  current: WorkflowStatus,
  target: WorkflowStatus,
  context: TransitionContext,
): WorkflowStatus {
  if (current === target) {
    return current;
  }
  if (!WORKFLOW_TRANSITIONS[current].includes(target)) {
    throw new DomainError(
      "INVALID_WORKFLOW_TRANSITION",
      `Workflow cannot transition from ${current} to ${target}`,
    );
  }
  const correction = context.linkedRefundTerminalCorrection;
  const isLinkedRefundTerminalCorrection = current === "succeeded" && target === "failed_terminal";
  if (correction !== undefined && !isLinkedRefundTerminalCorrection) {
    throw new DomainError(
      "INVALID_WORKFLOW_TRANSITION",
      "Linked Refund terminal correction evidence is valid only for succeeded to failed_terminal",
    );
  }
  if (isLinkedRefundTerminalCorrection) {
    if (
      correction === undefined ||
      correction.kind !== "linked_refund_terminal_correction" ||
      correction.previousEffectState !== "identified" ||
      correction.nextEffectState !== "absence_proven" ||
      correction.previousStripeRefundStatus !== "succeeded" ||
      correction.authoritativeStripeRefundStatus !== context.stripeRefundStatus ||
      context.effectState !== "absence_proven"
    ) {
      throw new DomainError(
        "INVALID_WORKFLOW_TRANSITION",
        "A succeeded workflow can fail only from an explicit terminal correction of its linked Refund",
      );
    }
    transitionEffectState(correction.previousEffectState, correction.nextEffectState, {
      authoritativeStripeRefundStatus: correction.authoritativeStripeRefundStatus,
      linkedStripeRefundId: correction.linkedStripeRefundId,
      observedStripeRefundId: correction.observedStripeRefundId,
    });
  }
  if (
    current === "reconciliation_required" &&
    target === "executing" &&
    context.effectState !== "absence_proven"
  ) {
    throw new DomainError(
      "INVALID_WORKFLOW_TRANSITION",
      "Execution may resume only after absence of a matching refund is proven",
    );
  }
  if (
    target === "succeeded" &&
    (context.effectState !== "identified" || context.stripeRefundStatus !== "succeeded")
  ) {
    throw new DomainError(
      "INVALID_WORKFLOW_TRANSITION",
      "Workflow succeeds only after Stripe confirms the identified refund succeeded",
    );
  }
  if (
    (target === "failed_terminal" || target === "stale") &&
    context.effectState !== "absence_proven"
  ) {
    throw new DomainError(
      "INVALID_WORKFLOW_TRANSITION",
      `${target} requires certain absence of the requested effect`,
    );
  }
  return target;
}

export interface CorrectLinkedRefundTerminalStatusInput {
  readonly workflow: RefundWorkflow;
  readonly observedStripeRefundId: string;
  readonly authoritativeStripeRefundStatus: "failed";
}

export function correctLinkedRefundTerminalStatus(
  input: CorrectLinkedRefundTerminalStatusInput,
): RefundWorkflow {
  const { workflow } = input;
  if (
    workflow.status !== "succeeded" ||
    workflow.effectState !== "identified" ||
    workflow.stripeRefundStatus !== "succeeded" ||
    workflow.stripeRefundId === null
  ) {
    throw new DomainError(
      "INVALID_WORKFLOW_TRANSITION",
      "Terminal Stripe correction requires a succeeded workflow with one identified successful Refund",
    );
  }

  const correction: LinkedRefundTerminalCorrection = {
    kind: "linked_refund_terminal_correction",
    previousEffectState: "identified",
    nextEffectState: "absence_proven",
    linkedStripeRefundId: workflow.stripeRefundId,
    observedStripeRefundId: input.observedStripeRefundId,
    previousStripeRefundStatus: "succeeded",
    authoritativeStripeRefundStatus: input.authoritativeStripeRefundStatus,
  };
  const effectState = transitionEffectState(workflow.effectState, correction.nextEffectState, {
    authoritativeStripeRefundStatus: correction.authoritativeStripeRefundStatus,
    linkedStripeRefundId: correction.linkedStripeRefundId,
    observedStripeRefundId: correction.observedStripeRefundId,
  });
  const status = transitionWorkflowStatus(workflow.status, "failed_terminal", {
    effectState,
    stripeRefundStatus: correction.authoritativeStripeRefundStatus,
    linkedRefundTerminalCorrection: correction,
  });

  return {
    ...workflow,
    status,
    effectState,
    stripeRefundStatus: correction.authoritativeStripeRefundStatus,
  };
}

export interface RecordDecisionInput {
  readonly workflow: RefundWorkflow;
  readonly approverId: string;
  readonly decision: ApprovalDecisionKind;
  readonly decidedAt: Date;
  readonly rejectionJustification?: string;
}

export function recordDecision(input: RecordDecisionInput): RefundWorkflow {
  const { workflow } = input;
  if (workflow.status !== "pending_approval") {
    throw new DomainError(
      "INVALID_WORKFLOW_TRANSITION",
      "Only a pending request can receive a decision",
    );
  }
  if (input.decidedAt.getTime() >= workflow.expiresAt.getTime()) {
    throw new DomainError("REQUEST_EXPIRED", "The request has expired");
  }
  if (workflow.requesterId === input.approverId) {
    throw new DomainError("SELF_APPROVAL", "The requester cannot approve their own request");
  }
  if (workflow.decisions.some((decision) => decision.approverId === input.approverId)) {
    throw new DomainError("DUPLICATE_DECISION", "An approver can decide a request only once");
  }
  if (
    input.decision === "reject" &&
    (input.rejectionJustification === undefined || input.rejectionJustification.trim().length < 10)
  ) {
    throw new DomainError(
      "REJECTION_JUSTIFICATION_REQUIRED",
      "A rejection justification of at least 10 characters is required",
    );
  }

  const decision: ApprovalDecision = {
    approverId: input.approverId,
    decision: input.decision,
    decidedAt: new Date(input.decidedAt),
  };
  const decisions = [...workflow.decisions, decision];
  const approvals = decisions.filter((item) => item.decision === "approve").length;
  const target =
    input.decision === "reject"
      ? "rejected"
      : approvals >= workflow.requiredApprovals
        ? "approved"
        : "pending_approval";

  return {
    ...workflow,
    decisions,
    status: transitionWorkflowStatus(workflow.status, target, {
      effectState: workflow.effectState,
    }),
  };
}

export function validateRequiredApprovals(requiredApprovals: number): void {
  if (!Number.isSafeInteger(requiredApprovals) || requiredApprovals < 1) {
    throw new DomainError("INVALID_QUORUM", "At least one human approval is required");
  }
}

export function cancelPendingWorkflow(workflow: RefundWorkflow, actorId: string): RefundWorkflow {
  if (actorId !== workflow.requesterId) {
    throw new DomainError("UNAUTHORIZED_CANCELLATION", "Only the requester can cancel a request");
  }
  return {
    ...workflow,
    status: transitionWorkflowStatus(workflow.status, "canceled", {
      effectState: workflow.effectState,
    }),
  };
}

export function expirePendingWorkflow(workflow: RefundWorkflow, now: Date): RefundWorkflow {
  if (now.getTime() < workflow.expiresAt.getTime()) {
    throw new DomainError("INVALID_WORKFLOW_TRANSITION", "The request has not expired");
  }
  return {
    ...workflow,
    status: transitionWorkflowStatus(workflow.status, "expired", {
      effectState: workflow.effectState,
    }),
  };
}
