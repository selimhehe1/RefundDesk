import { DomainError } from "./errors.js";
import type {
  AbsenceProvingStripeRefundStatus,
  EffectState,
  StripeRefundStatus,
  WorkflowStatus,
} from "./types.js";

const EFFECT_TRANSITIONS: Readonly<Record<EffectState, readonly EffectState[]>> = {
  not_started: ["possible", "absence_proven"],
  possible: ["identified", "absence_proven"],
  identified: ["absence_proven"],
  absence_proven: ["possible"],
};

export interface IdentifiedRefundAbsenceEvidence {
  readonly authoritativeStripeRefundStatus: AbsenceProvingStripeRefundStatus;
  readonly linkedStripeRefundId: string;
  readonly observedStripeRefundId: string;
}

export type EffectTransitionContext =
  | IdentifiedRefundAbsenceEvidence
  | {
      readonly authoritativeStripeRefundStatus?: never;
      readonly linkedStripeRefundId?: never;
      readonly observedStripeRefundId?: never;
    };

export function transitionEffectState<TTarget extends EffectState>(
  current: EffectState,
  target: TTarget,
  context: EffectTransitionContext = {},
): TTarget {
  if (current === target) {
    return target;
  }
  if (!EFFECT_TRANSITIONS[current].includes(target)) {
    throw new DomainError(
      "INVALID_EFFECT_TRANSITION",
      `Effect cannot transition from ${current} to ${target}`,
    );
  }
  if (current === "identified" && target === "absence_proven") {
    if (
      (context.authoritativeStripeRefundStatus !== "failed" &&
        context.authoritativeStripeRefundStatus !== "canceled") ||
      !/^re_[A-Za-z0-9]+$/u.test(context.linkedStripeRefundId ?? "") ||
      context.observedStripeRefundId !== context.linkedStripeRefundId
    ) {
      throw new DomainError(
        "INVALID_EFFECT_TRANSITION",
        "An identified effect becomes absent only when Stripe fails or cancels the same linked Refund",
      );
    }
  }
  return target;
}

export function hasCertainAbsenceOfEffect(effectState: EffectState): boolean {
  return effectState === "not_started" || effectState === "absence_proven";
}

export interface GuardState {
  readonly workflowStatus: WorkflowStatus;
  readonly effectState: EffectState;
  readonly stripeRefundStatus: StripeRefundStatus | null;
}

export function canReleasePaymentGuard(state: GuardState): boolean {
  if (state.workflowStatus === "reconciliation_required") {
    return false;
  }

  if (
    state.workflowStatus === "rejected" ||
    state.workflowStatus === "canceled" ||
    state.workflowStatus === "expired"
  ) {
    return hasCertainAbsenceOfEffect(state.effectState);
  }

  if (state.workflowStatus === "failed_terminal" || state.workflowStatus === "stale") {
    return state.effectState === "absence_proven";
  }

  if (state.workflowStatus === "succeeded") {
    return state.stripeRefundStatus === "succeeded";
  }

  return false;
}
