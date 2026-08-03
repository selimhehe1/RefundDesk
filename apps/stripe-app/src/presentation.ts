import type { ExternalAlert, RefundReason, WorkflowStatus } from "./api/client";

export type AlertClassification = ExternalAlert["classification"];

/**
 * Workflow statuses are domain values, never user-facing text.
 *
 * Labels state only what the status alone establishes. In particular `rejected`,
 * `canceled`, `expired`, `stale` and `failed_terminal` release the payment guard only
 * when the effect state proves no Stripe effect exists (see
 * `canReleasePaymentGuard` in `@refunddesk/domain`), and the API summary does not
 * expose that effect state. No label may therefore claim that nothing was refunded.
 */
const WORKFLOW_STATUS_LABELS: Readonly<Record<WorkflowStatus, string>> = {
  pending_approval: "Awaiting approval",
  approved: "Approved",
  executing: "Refund in progress",
  reconciliation_required: "Needs reconciliation",
  succeeded: "Refunded",
  failed_terminal: "Failed",
  rejected: "Rejected",
  canceled: "Canceled",
  expired: "Expired",
  // Terminal with no outgoing transition, so the request can no longer be acted on.
  // It says nothing about whether a Stripe refund exists.
  stale: "Stale (no longer actionable)",
};

const ALERT_CLASSIFICATION_LABELS: Readonly<Record<AlertClassification, string>> = {
  external: "Outside RefundDesk",
  tampered: "Invalid RefundDesk metadata",
  proof_replay: "Copied RefundDesk proof",
};

const REFUND_REASON_LABELS: Readonly<Record<RefundReason, string>> = {
  duplicate: "Duplicate",
  fraudulent: "Fraudulent",
  requested_by_customer: "Requested by customer",
};

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Says how long an undecided request still has. Requests lapse after a fixed window and
 * nothing notifies anyone, so a silent expiry is the most likely way a refund never
 * happens. The deadline comes from the API; it is never recomputed here.
 *
 * Returns `null` when the instant cannot be read, so the caller renders nothing rather
 * than a misleading countdown.
 */
export function expiryNotice(expiresAt: string, now: Date): string | null {
  const deadline = new Date(expiresAt);
  const remaining = deadline.getTime() - now.getTime();
  if (!Number.isFinite(remaining)) {
    return null;
  }
  if (remaining <= 0) {
    return "Expired";
  }
  const hours = Math.floor(remaining / 3_600_000);
  if (hours < 1) {
    return "Expires in under an hour";
  }
  if (hours < 24) {
    return hours === 1 ? "Expires in 1 hour" : `Expires in ${hours} hours`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
}

export function workflowStatusLabel(status: WorkflowStatus): string {
  return WORKFLOW_STATUS_LABELS[status];
}

export function alertClassificationLabel(classification: AlertClassification): string {
  return ALERT_CLASSIFICATION_LABELS[classification];
}

export function refundReasonLabel(reason: RefundReason): string {
  return REFUND_REASON_LABELS[reason];
}

/**
 * Renders an API timestamp as an explicit UTC instant, for example
 * `2 Aug 2026, 21:53 UTC`.
 *
 * `Intl` is deliberately avoided: the output stays identical under test, inside the
 * extension sandbox and across operator locales.
 *
 * Two honest limits. Minutes are the displayed precision, so the audit export stays the
 * authority for correlating two events inside the same minute. And `Date` silently rolls
 * some out-of-calendar strings over (`2026-02-29` becomes 1 March), so only a string it
 * rejects outright is returned unchanged; callers are protected upstream because every
 * timestamp reaching this function is validated by `z.iso.datetime()` in the API client.
 */
export function formatTimestamp(iso: string): string {
  const instant = new Date(iso);
  const epochMilliseconds = instant.getTime();
  if (!Number.isFinite(epochMilliseconds)) {
    return iso;
  }

  const month = MONTH_NAMES[instant.getUTCMonth()];
  if (month === undefined) {
    return iso;
  }

  const day = String(instant.getUTCDate());
  const year = String(instant.getUTCFullYear());
  const hours = String(instant.getUTCHours()).padStart(2, "0");
  const minutes = String(instant.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hours}:${minutes} UTC`;
}
