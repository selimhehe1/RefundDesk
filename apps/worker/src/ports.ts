import type {
  EffectState,
  RefundProofPayload,
  RefundReason,
  StripeRefundStatus,
} from "@refunddesk/domain";
import type {
  CreateRefundInput,
  NormalizedPayment,
  NormalizedRefund,
  RefundPage,
  StripeInstallation,
} from "@refunddesk/stripe-adapter";

import type { ProcessWebhookJob } from "./jobs.js";

export interface WorkerInstallation extends StripeInstallation {
  readonly tenantId: string;
  readonly installationId: string;
  readonly tenantLiveEnabled: boolean;
}

export interface ScannableWorkerInstallation extends WorkerInstallation {
  readonly installedAt: Date;
}

export interface LinkedRefundReconciliationTarget {
  readonly requestId: string;
  readonly refundId: string;
}

export interface RefundExecutionRecord {
  readonly tenantId: string;
  readonly requestId: string;
  readonly installation: WorkerInstallation;
  readonly resourceType: "payment_intent" | "charge";
  readonly resourceId: string;
  readonly paymentKey: string;
  readonly paymentIntentId: string | null;
  readonly chargeId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reason: RefundReason;
  readonly effectState: EffectState;
  readonly linkedRefundId: string | null;
}

export interface ApprovedRefundExecution {
  readonly tenantId: string;
  readonly requestId: string;
  readonly installation: WorkerInstallation;
}

export interface PersistApprovalAttestationInput {
  readonly signedEnvelopeHash: Uint8Array;
  readonly requestNonce: string;
  readonly stripeAccountId: string;
  readonly environment: "test" | "sandbox";
  readonly resourceType: "payment_intent" | "charge";
  readonly resourceId: string;
  readonly requestId: string;
  readonly expectedRequestVersion: number;
  readonly approverStripeUserId: string;
  readonly requesterStripeUserId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reason: RefundReason;
  readonly verifiedAt: Date;
}

export interface PersistedApprovalAttestation {
  readonly id: string;
  readonly signedEnvelopeHash: Uint8Array;
}

export class ApprovalAttestationStoreError extends Error {
  /**
   * `reason` names the precondition that failed, for the operator only. The public
   * response carries no reason: an "invalid" attestation surfaces as a signed-request
   * rejection, which is indistinguishable from a malformed envelope to the caller and
   * was indistinguishable to the operator too, because nothing recorded which of the
   * twenty-odd preconditions actually failed. It is logged, never returned.
   */
  constructor(
    readonly code: "conflict" | "invalid" | "unavailable",
    readonly reason?: ApprovalAttestationRejection,
  ) {
    super("Approval attestation persistence failed");
    this.name = "ApprovalAttestationStoreError";
  }
}

export type ApprovalAttestationRejection =
  | "installation_not_active"
  | "request_not_found"
  | "approver_not_eligible"
  | "request_not_approvable"
  | "resource_mismatch"
  | "request_not_pending_approval"
  | "attestation_window_empty";

export type EffectBoundaryDecision =
  | {
      readonly kind: "execute";
      readonly attemptId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "already_identified";
      readonly refundId: string;
    }
  | {
      readonly kind: "reconciliation_required" | "not_executable";
    };

export interface PersistEffectBoundaryInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly at: Date;
}

export interface IdentifiedRefundInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly refundId: string;
  readonly refundStatus: StripeRefundStatus | null;
  readonly stripeRequestId: string | null;
  readonly responseMatchesRequest: boolean;
  readonly at: Date;
}

export interface AttemptFailureInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly errorCode: string;
  readonly at: Date;
}

export interface TerminalWithoutEffectInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly errorCode: string;
  readonly at: Date;
}

export interface ReconciliationRequiredInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly errorCode: string;
  readonly at: Date;
}

export interface RefundObservation {
  readonly refundId: string;
  readonly paymentIntentId: string | null;
  readonly chargeId: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: StripeRefundStatus | null;
  readonly created: number;
  readonly metadataRequestId: string | null;
  readonly metadataProof: string | null;
}

export type RefundObservationSource =
  | {
      readonly kind: "webhook";
      readonly receiptId: string;
      readonly stripeEventId: string;
      readonly stripeAccountId: string;
      readonly eventIdempotencyKey: string | null;
      readonly eventType: "refund.created" | "refund.updated" | "refund.failed";
      readonly eventCreated: number;
    }
  | {
      readonly kind: "scan";
      readonly eventIdempotencyKey: null;
      readonly scanWindowEnd: Date;
    };

export interface InstallationLifecycleInput {
  readonly tenantId: string;
  readonly installationId: string;
  readonly receiptId: string;
  readonly stripeEventId: string;
  readonly stripeAccountId: string;
  readonly environment: "test" | "sandbox";
  readonly eventType: "account.application.authorized" | "account.application.deauthorized";
  readonly eventCreated: number;
  readonly eventIdempotencyKey: string | null;
  readonly applicationId: string;
  readonly processedAt: Date;
}

export interface ObserveRefundInput {
  readonly tenantId: string;
  readonly installationId: string;
  readonly environment: WorkerInstallation["environment"];
  readonly refund: RefundObservation;
  readonly source: RefundObservationSource;
  readonly observedAt: Date;
}

/**
 * A direct Stripe snapshot for an already-linked immutable Refund ID.
 * `scanWindowEnd` is an observation cutoff, not a Stripe Event timestamp:
 * implementations must not replace `lastStripeEventCreatedAt` with it.
 */
export interface ObserveLinkedRefundInput {
  readonly tenantId: string;
  readonly installationId: string;
  readonly environment: Exclude<WorkerInstallation["environment"], "live">;
  readonly requestId: string;
  readonly expectedRefundId: string;
  readonly refund: RefundObservation;
  readonly scanWindowEnd: Date;
  readonly observedAt: Date;
}

export interface ReconciliationCheckpoint {
  readonly windowEnd: Date;
}

export interface CommitCheckpointInput {
  readonly tenantId: string;
  readonly installationId: string;
  readonly previousWindowEnd: Date | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly pageCount: number;
  readonly refundCount: number;
  readonly completedAt: Date;
}

/**
 * Every method is a complete database unit of work. Implementations must finish
 * their transaction before resolving; the worker never passes a callback that
 * could perform network I/O inside a database transaction.
 */
export interface WorkerStore {
  close?(): Promise<void>;
  persistApprovalAttestation(
    input: PersistApprovalAttestationInput,
  ): Promise<PersistedApprovalAttestation>;
  loadRefundExecution(tenantId: string, requestId: string): Promise<RefundExecutionRecord | null>;
  persistEffectBoundary(input: PersistEffectBoundaryInput): Promise<EffectBoundaryDecision>;
  recordIdentifiedRefund(input: IdentifiedRefundInput): Promise<void>;
  recordRetryableAttemptFailure(input: AttemptFailureInput): Promise<void>;
  recordAmbiguousAttemptFailure(input: AttemptFailureInput): Promise<void>;
  recordTerminalAttemptWithoutEffect(input: AttemptFailureInput): Promise<void>;
  recordTerminalWithoutEffect(input: TerminalWithoutEffectInput): Promise<void>;
  recordReconciliationRequired(input: ReconciliationRequiredInput): Promise<void>;
  listApprovedRefundExecutions(limit: number): Promise<readonly ApprovedRefundExecution[]>;
  listRecoverableWebhookJobs(limit: number): Promise<readonly ProcessWebhookJob[]>;
  observeRefund(input: ObserveRefundInput): Promise<void>;
  processInstallationLifecycle(input: InstallationLifecycleInput): Promise<void>;
  markWebhookReceiptFailed(tenantId: string, receiptId: string, errorCode: string): Promise<void>;
  listScannableInstallations(): Promise<readonly ScannableWorkerInstallation[]>;
  /**
   * Returns targets ordered by `requestId`, strictly after `afterRequestId`.
   */
  listLinkedRefundReconciliationTargets(
    tenantId: string,
    installationId: string,
    afterRequestId: string | null,
    limit: number,
  ): Promise<readonly LinkedRefundReconciliationTarget[]>;
  observeLinkedRefund(input: ObserveLinkedRefundInput): Promise<void>;
  loadReconciliationCheckpoint(
    tenantId: string,
    installationId: string,
  ): Promise<ReconciliationCheckpoint | null>;
  commitReconciliationCheckpoint(input: CommitCheckpointInput): Promise<void>;
  expireDueRequests(now: Date, limit: number): Promise<number>;
}

export interface StripeGateway {
  retrievePayment(
    installation: StripeInstallation,
    resourceType: "payment_intent" | "charge",
    resourceId: string,
  ): Promise<NormalizedPayment>;
  createRefund(input: CreateRefundInput): Promise<NormalizedRefund>;
  retrieveRefund(installation: StripeInstallation, refundId: string): Promise<NormalizedRefund>;
  listRefunds(
    installation: StripeInstallation,
    created: { readonly gte: number; readonly lte: number },
    startingAfter?: string,
  ): Promise<RefundPage>;
}

export interface RefundProofSigner {
  sign(payload: RefundProofPayload): string;
}

export interface Clock {
  now(): Date;
}

export type SafeLogValue = string | number | boolean | null;
export type SafeLogContext = Readonly<Record<string, SafeLogValue>>;

export interface WorkerLogger {
  debug(context: SafeLogContext, message: string): void;
  info(context: SafeLogContext, message: string): void;
  warn(context: SafeLogContext, message: string): void;
  error(context: SafeLogContext, message: string): void;
}

export interface CrashHooks {
  beforeEffectBoundary?(): void | Promise<void>;
  afterEffectBoundary?(): void | Promise<void>;
  afterStripeResponse?(): void | Promise<void>;
  afterIdentifiedPersisted?(): void | Promise<void>;
}
