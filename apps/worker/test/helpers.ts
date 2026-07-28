import type { RefundProofPayload } from "@refunddesk/domain";
import type {
  CreateRefundInput,
  NormalizedPayment,
  NormalizedRefund,
  RefundPage,
  StripeInstallation,
} from "@refunddesk/stripe-adapter";

import type {
  ApprovedRefundExecution,
  AttemptFailureInput,
  Clock,
  CommitCheckpointInput,
  EffectBoundaryDecision,
  IdentifiedRefundInput,
  InstallationLifecycleInput,
  LinkedRefundReconciliationTarget,
  ObserveLinkedRefundInput,
  ObserveRefundInput,
  PersistApprovalAttestationInput,
  PersistEffectBoundaryInput,
  PersistedApprovalAttestation,
  ReconciliationCheckpoint,
  ReconciliationRequiredInput,
  RefundExecutionRecord,
  RefundProofSigner,
  SafeLogContext,
  ScannableWorkerInstallation,
  StripeGateway,
  TerminalWithoutEffectInput,
  WorkerLogger,
  WorkerStore,
} from "../src/ports.js";
import type { ProcessWebhookJob } from "../src/jobs.js";

export const TENANT_ID = "4f7718e3-783b-4698-8f86-af631bd4c91e";
export const REQUEST_ID = "cc3cb5d1-268c-49b4-831f-a6f392097189";
export const INSTALLATION_ID = "8f9dd61e-5ce4-4c74-a88f-297730aab274";

export const fixedClock: Clock = {
  now: () => new Date("2030-01-01T12:00:00.000Z"),
};

export function executionRecord(
  overrides: Partial<RefundExecutionRecord> = {},
): RefundExecutionRecord {
  return {
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    installation: {
      tenantId: TENANT_ID,
      installationId: INSTALLATION_ID,
      stripeAccountId: "acct_test_worker",
      environment: "test",
      active: true,
      tenantLiveEnabled: false,
    },
    resourceType: "payment_intent",
    resourceId: "pi_worker",
    paymentKey: "pi_worker",
    paymentIntentId: "pi_worker",
    chargeId: "ch_worker",
    amountMinor: 500n,
    currency: "eur",
    reason: "requested_by_customer",
    effectState: "not_started",
    linkedRefundId: null,
    ...overrides,
  };
}

export function normalizedPayment(overrides: Partial<NormalizedPayment> = {}): NormalizedPayment {
  return {
    paymentKey: "pi_worker",
    paymentIntentId: "pi_worker",
    chargeId: "ch_worker",
    amountCaptured: 1_000n,
    amountRefunded: 0n,
    currency: "eur",
    captured: true,
    paid: true,
    disputed: false,
    paymentMethodType: "card",
    hasConnectSemantics: false,
    ...overrides,
  };
}

export function normalizedRefund(overrides: Partial<NormalizedRefund> = {}): NormalizedRefund {
  return {
    id: "re_worker",
    paymentIntentId: "pi_worker",
    chargeId: "ch_worker",
    amountMinor: 500n,
    currency: "eur",
    status: "succeeded",
    created: 1_893_499_200,
    metadata: {},
    requestId: "req_worker",
    ...overrides,
  };
}

export class FakeStore implements WorkerStore {
  readonly trace: string[] = [];
  readonly observations: ObserveRefundInput[] = [];
  readonly linkedRefundObservations: ObserveLinkedRefundInput[] = [];
  readonly linkedRefundTargets: LinkedRefundReconciliationTarget[] = [];
  readonly linkedRefundTargetListCalls: Array<{
    readonly tenantId: string;
    readonly installationId: string;
    readonly afterRequestId: string | null;
    readonly limit: number;
  }> = [];
  readonly checkpointCommits: CommitCheckpointInput[] = [];
  readonly retryableFailures: AttemptFailureInput[] = [];
  readonly ambiguousFailures: AttemptFailureInput[] = [];
  readonly terminalAttemptFailures: AttemptFailureInput[] = [];
  readonly terminalPreflightFailures: TerminalWithoutEffectInput[] = [];
  readonly reconciliationFailures: ReconciliationRequiredInput[] = [];
  readonly identified: IdentifiedRefundInput[] = [];
  readonly installations: ScannableWorkerInstallation[] = [];
  readonly approvedExecutions: ApprovedRefundExecution[] = [];
  readonly recoverableWebhookJobs: ProcessWebhookJob[] = [];
  readonly lifecycleEvents: InstallationLifecycleInput[] = [];
  readonly failedWebhookReceipts: Array<{
    readonly tenantId: string;
    readonly receiptId: string;
    readonly errorCode: string;
  }> = [];
  readonly expirationResults: number[] = [0];
  checkpoint: ReconciliationCheckpoint | null = null;
  record: RefundExecutionRecord | null = executionRecord();
  workflowState: "executable" | "completed" | "reconciliation_required" | "terminal" = "executable";
  effectState: RefundExecutionRecord["effectState"] = "not_started";
  idempotencyKey: string | null = null;
  refundId: string | null = null;
  attemptNumber = 0;

  persistApprovalAttestation(
    input: PersistApprovalAttestationInput,
  ): Promise<PersistedApprovalAttestation> {
    this.trace.push("store.attestation");
    return Promise.resolve({
      id: "0dddf88a-4d04-4ae0-a0ce-4a3056d8bf4b",
      signedEnvelopeHash: input.signedEnvelopeHash,
    });
  }

  loadRefundExecution(tenantId: string, requestId: string): Promise<RefundExecutionRecord | null> {
    this.trace.push("store.load");
    if (
      this.record === null ||
      this.workflowState !== "executable" ||
      this.record.tenantId !== tenantId ||
      this.record.requestId !== requestId
    ) {
      return Promise.resolve(null);
    }
    if (this.effectState === "possible") {
      this.workflowState = "reconciliation_required";
      return Promise.resolve(null);
    }
    return Promise.resolve({
      ...this.record,
      effectState: this.effectState,
      linkedRefundId: this.refundId,
    });
  }

  persistEffectBoundary(input: PersistEffectBoundaryInput): Promise<EffectBoundaryDecision> {
    this.trace.push("store.boundary");
    if (this.workflowState === "reconciliation_required") {
      return Promise.resolve({ kind: "reconciliation_required" });
    }
    if (this.workflowState !== "executable") {
      return Promise.resolve({ kind: "not_executable" });
    }
    if (this.refundId !== null) {
      return Promise.resolve({
        kind: "already_identified",
        refundId: this.refundId,
      });
    }
    if (this.idempotencyKey !== null && this.idempotencyKey !== input.idempotencyKey) {
      return Promise.reject(new Error("FAKE_IDEMPOTENCY_CONFLICT"));
    }
    this.idempotencyKey = input.idempotencyKey;
    this.effectState = "possible";
    this.attemptNumber += 1;
    return Promise.resolve({
      kind: "execute",
      attemptId: `attempt-${this.attemptNumber}`,
      idempotencyKey: input.idempotencyKey,
    });
  }

  recordIdentifiedRefund(input: IdentifiedRefundInput): Promise<void> {
    this.trace.push("store.identified");
    if (this.refundId !== null && this.refundId !== input.refundId) {
      return Promise.reject(new Error("FAKE_IMMUTABLE_REFUND_CONFLICT"));
    }
    if (this.idempotencyKey !== input.idempotencyKey) {
      return Promise.reject(new Error("FAKE_IDEMPOTENCY_CONFLICT"));
    }
    this.refundId = input.refundId;
    this.effectState = "identified";
    this.workflowState = input.responseMatchesRequest ? "completed" : "reconciliation_required";
    this.identified.push(input);
    return Promise.resolve();
  }

  recordRetryableAttemptFailure(input: AttemptFailureInput): Promise<void> {
    this.trace.push("store.retryable");
    this.effectState = "absence_proven";
    this.retryableFailures.push(input);
    return Promise.resolve();
  }

  recordAmbiguousAttemptFailure(input: AttemptFailureInput): Promise<void> {
    this.trace.push("store.ambiguous");
    this.workflowState = "reconciliation_required";
    this.effectState = "possible";
    this.ambiguousFailures.push(input);
    return Promise.resolve();
  }

  recordTerminalAttemptWithoutEffect(input: AttemptFailureInput): Promise<void> {
    this.trace.push("store.terminal_attempt");
    this.workflowState = "terminal";
    this.effectState = "absence_proven";
    this.terminalAttemptFailures.push(input);
    return Promise.resolve();
  }

  recordTerminalWithoutEffect(input: TerminalWithoutEffectInput): Promise<void> {
    this.trace.push("store.terminal_preflight");
    this.workflowState = "terminal";
    this.effectState = "absence_proven";
    this.terminalPreflightFailures.push(input);
    return Promise.resolve();
  }

  recordReconciliationRequired(input: ReconciliationRequiredInput): Promise<void> {
    this.trace.push("store.reconciliation");
    this.workflowState = "reconciliation_required";
    this.reconciliationFailures.push(input);
    return Promise.resolve();
  }

  listApprovedRefundExecutions(limit: number): Promise<readonly ApprovedRefundExecution[]> {
    this.trace.push("store.approved");
    return Promise.resolve(this.approvedExecutions.slice(0, limit));
  }

  listRecoverableWebhookJobs(limit: number): Promise<readonly ProcessWebhookJob[]> {
    this.trace.push("store.webhook.recoverable");
    return Promise.resolve(this.recoverableWebhookJobs.slice(0, limit));
  }

  observeRefund(input: ObserveRefundInput): Promise<void> {
    this.trace.push(`store.observe.${input.refund.refundId}`);
    this.observations.push(input);
    return Promise.resolve();
  }

  processInstallationLifecycle(input: InstallationLifecycleInput): Promise<void> {
    this.trace.push(`store.lifecycle.${input.eventType}`);
    this.lifecycleEvents.push(input);
    return Promise.resolve();
  }

  markWebhookReceiptFailed(tenantId: string, receiptId: string, errorCode: string): Promise<void> {
    this.trace.push("store.webhook.failed");
    this.failedWebhookReceipts.push({ tenantId, receiptId, errorCode });
    return Promise.resolve();
  }

  listScannableInstallations(): Promise<readonly ScannableWorkerInstallation[]> {
    this.trace.push("store.installations");
    return Promise.resolve(this.installations);
  }

  listLinkedRefundReconciliationTargets(
    tenantId: string,
    installationId: string,
    afterRequestId: string | null,
    limit: number,
  ): Promise<readonly LinkedRefundReconciliationTarget[]> {
    this.trace.push("store.linked.list");
    this.linkedRefundTargetListCalls.push({
      tenantId,
      installationId,
      afterRequestId,
      limit,
    });
    return Promise.resolve(
      this.linkedRefundTargets
        .filter((target) => afterRequestId === null || target.requestId > afterRequestId)
        .toSorted((left, right) => left.requestId.localeCompare(right.requestId))
        .slice(0, limit),
    );
  }

  observeLinkedRefund(input: ObserveLinkedRefundInput): Promise<void> {
    this.trace.push(`store.linked.observe.${input.refund.refundId}`);
    this.linkedRefundObservations.push(input);
    return Promise.resolve();
  }

  loadReconciliationCheckpoint(): Promise<ReconciliationCheckpoint | null> {
    this.trace.push("store.checkpoint.load");
    return Promise.resolve(this.checkpoint);
  }

  commitReconciliationCheckpoint(input: CommitCheckpointInput): Promise<void> {
    this.trace.push("store.checkpoint.commit");
    this.checkpointCommits.push(input);
    this.checkpoint = { windowEnd: input.windowEnd };
    return Promise.resolve();
  }

  expireDueRequests(): Promise<number> {
    this.trace.push("store.expire");
    return Promise.resolve(this.expirationResults.shift() ?? 0);
  }
}

export class FakeStripe implements StripeGateway {
  readonly trace: string[] = [];
  readonly createCalls: CreateRefundInput[] = [];
  readonly listCalls: Array<{
    installation: StripeInstallation;
    created: { readonly gte: number; readonly lte: number };
    startingAfter?: string;
  }> = [];
  readonly refundRetrieveCalls: Array<{
    readonly installation: StripeInstallation;
    readonly refundId: string;
  }> = [];
  payment: NormalizedPayment = normalizedPayment();
  retrieveError: unknown = null;
  createOutcomes: unknown[] = [normalizedRefund()];
  pageHandler: (startingAfter: string | undefined) => RefundPage | Promise<RefundPage> = () => ({
    refunds: [],
    hasMore: false,
  });
  refundRetrieveHandler: (
    refundId: string,
    installation: StripeInstallation,
  ) => NormalizedRefund | Promise<NormalizedRefund> = (refundId) =>
    normalizedRefund({ id: refundId });
  private readonly refundByIdempotencyKey = new Map<string, NormalizedRefund>();

  retrievePayment(): Promise<NormalizedPayment> {
    this.trace.push("stripe.retrieve");
    if (this.retrieveError !== null) {
      return Promise.reject(
        this.retrieveError instanceof Error
          ? this.retrieveError
          : new Error("FAKE_STRIPE_RETRIEVE_ERROR"),
      );
    }
    return Promise.resolve(this.payment);
  }

  createRefund(input: CreateRefundInput): Promise<NormalizedRefund> {
    this.trace.push("stripe.create");
    this.createCalls.push(input);
    const prior = this.refundByIdempotencyKey.get(input.idempotencyKey);
    if (prior !== undefined) {
      return Promise.resolve(prior);
    }
    const outcome = this.createOutcomes.shift();
    if (outcome instanceof Error) {
      return Promise.reject(outcome);
    }
    if (typeof outcome !== "object" || outcome === null || !("id" in outcome)) {
      return Promise.reject(new Error("FAKE_STRIPE_OUTCOME_MISSING"));
    }
    const refund = outcome as NormalizedRefund;
    this.refundByIdempotencyKey.set(input.idempotencyKey, refund);
    return Promise.resolve(refund);
  }

  retrieveRefund(installation: StripeInstallation, refundId: string): Promise<NormalizedRefund> {
    this.trace.push(`stripe.refund.retrieve.${refundId}`);
    this.refundRetrieveCalls.push({ installation, refundId });
    return Promise.resolve(this.refundRetrieveHandler(refundId, installation));
  }

  listRefunds(
    installation: StripeInstallation,
    created: { readonly gte: number; readonly lte: number },
    startingAfter?: string,
  ): Promise<RefundPage> {
    this.trace.push(`stripe.list.${startingAfter ?? "first"}`);
    this.listCalls.push({
      installation,
      created,
      ...(startingAfter === undefined ? {} : { startingAfter }),
    });
    return Promise.resolve(this.pageHandler(startingAfter));
  }
}

export class FakeProofs implements RefundProofSigner {
  readonly payloads: RefundProofPayload[] = [];

  sign(payload: RefundProofPayload): string {
    this.payloads.push(payload);
    return "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  }
}

export class FakeLogger implements WorkerLogger {
  readonly entries: Array<{
    level: "debug" | "info" | "warn" | "error";
    context: SafeLogContext;
    message: string;
  }> = [];

  debug(context: SafeLogContext, message: string): void {
    this.entries.push({ level: "debug", context, message });
  }

  info(context: SafeLogContext, message: string): void {
    this.entries.push({ level: "info", context, message });
  }

  warn(context: SafeLogContext, message: string): void {
    this.entries.push({ level: "warn", context, message });
  }

  error(context: SafeLogContext, message: string): void {
    this.entries.push({ level: "error", context, message });
  }
}
