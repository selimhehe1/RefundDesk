import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  assertNormalizedWebhookRowConsistency,
  decideRefundCandidate,
  listActiveTenantIds,
  listRecoverableWebhookReceipts,
  listScannableInstallations as listDbScannableInstallations,
  type NormalizedConnectedWebhookPayload,
  type PrismaClient,
  type TenantRepositories,
  withTenantTransaction,
} from "@refunddesk/db";
import { canonicalJson } from "@refunddesk/contracts";
import {
  classifyRefundEvidence,
  normalizeCurrency,
  refundIdempotencyKey,
  type RefundProofKeyring,
} from "@refunddesk/domain";

import type {
  ApprovedRefundExecution,
  AttemptFailureInput,
  CommitCheckpointInput,
  EffectBoundaryDecision,
  IdentifiedRefundInput,
  InstallationLifecycleInput,
  LinkedRefundReconciliationTarget,
  ObserveLinkedRefundInput,
  ObserveRefundInput,
  PersistEffectBoundaryInput,
  ReconciliationCheckpoint,
  ReconciliationRequiredInput,
  RefundExecutionRecord,
  ScannableWorkerInstallation,
  TerminalWithoutEffectInput,
  WorkerStore,
} from "./ports.js";
import { processWebhookJobSchema, type ProcessWebhookJob } from "./jobs.js";

const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TENANT_PURGE_DELAY_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

function canonicalExecutionHash(record: {
  readonly tenantId: string;
  readonly requestId: string;
  readonly stripeAccountId: string;
  readonly environment: string;
  readonly paymentKey: string;
  readonly paymentIntentId: string | null;
  readonly chargeId: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reason: string;
}): Buffer {
  return createHash("sha256")
    .update(
      JSON.stringify([
        record.tenantId,
        record.requestId,
        record.stripeAccountId,
        record.environment,
        record.paymentKey,
        record.paymentIntentId,
        record.chargeId,
        record.amountMinor.toString(),
        normalizeCurrency(record.currency),
        record.reason,
      ]),
      "utf8",
    )
    .digest();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function paymentKeyOf(input: Pick<ObserveRefundInput, "refund">): string {
  const paymentKey = input.refund.paymentIntentId ?? input.refund.chargeId;
  if (paymentKey === null) {
    throw new Error("REFUND_OBSERVATION_PAYMENT_MISSING");
  }
  return paymentKey;
}

export function authoritativeObservedRefundStatus(
  input: Pick<ObserveRefundInput, "refund" | "source">,
): ObserveRefundInput["refund"]["status"] {
  return input.source.kind === "webhook" && input.source.eventType === "refund.failed"
    ? "failed"
    : input.refund.status;
}

interface LinkedRefundObservationFreshnessInput {
  readonly currentStatus: ObserveRefundInput["refund"]["status"];
  readonly lastStripeEventCreatedAt: Date | null;
  readonly observation: Pick<ObserveRefundInput, "refund" | "source">;
}

/**
 * Stripe Event.created is the ordering clock for webhooks. At the same
 * timestamp, failure wins because retaining a successful local state would
 * release the financial guard while Stripe reports that the refund failed.
 *
 * Scanner observations are current Stripe snapshots, so a changed status must
 * be offered to the repository for convergence. The repository remains the
 * final, locked compare-and-set boundary.
 */
export function shouldApplyLinkedRefundObservation({
  currentStatus,
  lastStripeEventCreatedAt,
  observation,
}: LinkedRefundObservationFreshnessInput): boolean {
  if (observation.source.kind === "scan") {
    return currentStatus !== observation.refund.status;
  }

  if (lastStripeEventCreatedAt === null) {
    return true;
  }

  const incomingEventCreatedAt = observation.source.eventCreated * 1_000;
  const previousEventCreatedAt = lastStripeEventCreatedAt.getTime();
  if (incomingEventCreatedAt > previousEventCreatedAt) {
    return true;
  }
  if (incomingEventCreatedAt < previousEventCreatedAt) {
    return false;
  }

  const incomingStatus =
    observation.source.eventType === "refund.failed" ? "failed" : observation.refund.status;
  if (incomingStatus === "failed") {
    return currentStatus !== "failed";
  }
  if (incomingStatus === "canceled") {
    return currentStatus !== "failed" && currentStatus !== "canceled";
  }
  return false;
}

function dateEquals(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function normalizedPayloadEquals(
  left: NormalizedConnectedWebhookPayload,
  right: NormalizedConnectedWebhookPayload,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function hasActivePilotExecutionContext(item: {
  readonly environment: string;
  readonly tenant: {
    readonly status: string;
    readonly liveEnabled: boolean;
  };
  readonly installation: {
    readonly status: string;
    readonly environment: string;
  };
}): boolean {
  return (
    item.tenant.status === "active" &&
    item.installation.status === "active" &&
    !item.tenant.liveEnabled &&
    (item.environment === "test" || item.environment === "sandbox") &&
    item.installation.environment === item.environment
  );
}

async function requireExecutionReconciliation(
  repositories: TenantRepositories,
  requestId: string,
): Promise<void> {
  const marked = await repositories.markReconciliationRequired(requestId);
  if (marked) {
    return;
  }
  const current = await repositories.getExecutionWorkItem(requestId);
  if (current?.workflowStatus !== "reconciliation_required") {
    throw new Error("EXECUTION_RECOVERY_RECONCILIATION_COMPARE_AND_SET_FAILED");
  }
}

export class PrismaWorkerStore implements WorkerStore {
  constructor(
    private readonly client: PrismaClient,
    private readonly proofs: RefundProofKeyring,
  ) {}

  async close(): Promise<void> {
    await this.client.$disconnect();
  }

  async loadRefundExecution(
    tenantId: string,
    requestId: string,
  ): Promise<RefundExecutionRecord | null> {
    return withTenantTransaction(this.client, tenantId, async ({ repositories }) => {
      let item = await repositories.getExecutionWorkItem(requestId);
      if (item === null || !hasActivePilotExecutionContext(item)) {
        return null;
      }
      const authorizationLocked = await repositories.lockExecutionAuthorization(
        item.id,
        item.installationId,
      );
      if (!authorizationLocked) {
        return null;
      }
      item = await repositories.getExecutionWorkItem(requestId);
      if (item === null || !hasActivePilotExecutionContext(item)) {
        return null;
      }
      if (item.workflowStatus === "approved" && item.effectState === "not_started") {
        item = await repositories.claimExecutionWorkItem(requestId, new Date());
      }
      if (
        item === null ||
        !hasActivePilotExecutionContext(item) ||
        item.workflowStatus !== "executing" ||
        (item.effectState !== "not_started" &&
          item.effectState !== "possible" &&
          item.effectState !== "absence_proven") ||
        item.chargeId === null
      ) {
        return null;
      }
      const expectedIdempotencyKey = refundIdempotencyKey(item.id);
      if (
        item.effectState === "possible" ||
        (item.effectState === "absence_proven" && item.execution === null) ||
        (item.execution !== null && item.execution.idempotencyKey !== expectedIdempotencyKey)
      ) {
        await requireExecutionReconciliation(repositories, item.id);
        return null;
      }

      const resourceType = item.paymentIntentId === null ? "charge" : "payment_intent";
      const resourceId = item.paymentIntentId ?? item.chargeId;
      return {
        tenantId: item.tenantId,
        requestId: item.id,
        installation: {
          tenantId: item.tenantId,
          installationId: item.installationId,
          stripeAccountId: item.installation.stripeAccountId,
          environment: item.environment,
          active: item.installation.status === "active",
          tenantLiveEnabled: item.tenant.liveEnabled,
        },
        resourceType,
        resourceId,
        paymentKey: item.paymentKey,
        paymentIntentId: item.paymentIntentId,
        chargeId: item.chargeId,
        amountMinor: item.amountMinor,
        currency: item.currency,
        reason: item.reason,
        effectState: item.effectState,
        linkedRefundId: item.execution?.stripeRefundId ?? null,
      };
    });
  }

  async persistEffectBoundary(input: PersistEffectBoundaryInput): Promise<EffectBoundaryDecision> {
    return withTenantTransaction(this.client, input.tenantId, async ({ repositories, tx }) => {
      let item = await repositories.getExecutionWorkItem(input.requestId);
      if (item === null || item.workflowStatus !== "executing") {
        return item?.workflowStatus === "reconciliation_required"
          ? { kind: "reconciliation_required" }
          : { kind: "not_executable" };
      }
      if (!hasActivePilotExecutionContext(item) || item.paymentGuardReleasedAt !== null) {
        return { kind: "not_executable" };
      }
      const authorizationLocked = await repositories.lockExecutionAuthorization(
        item.id,
        item.installationId,
      );
      if (!authorizationLocked) {
        return { kind: "not_executable" };
      }
      item = await repositories.getExecutionWorkItem(input.requestId);
      if (
        item === null ||
        item.workflowStatus !== "executing" ||
        !hasActivePilotExecutionContext(item) ||
        item.paymentGuardReleasedAt !== null
      ) {
        return item?.workflowStatus === "reconciliation_required"
          ? { kind: "reconciliation_required" }
          : { kind: "not_executable" };
      }
      if (item.execution?.stripeRefundId !== null && item.execution !== null) {
        return {
          kind: "already_identified",
          refundId: item.execution.stripeRefundId,
        };
      }
      if (
        item.effectState === "possible" ||
        (item.effectState === "absence_proven" && item.execution === null) ||
        (item.execution !== null && item.execution.idempotencyKey !== input.idempotencyKey)
      ) {
        await requireExecutionReconciliation(repositories, item.id);
        return { kind: "reconciliation_required" };
      }
      if (item.effectState !== "not_started" && item.effectState !== "absence_proven") {
        return { kind: "not_executable" };
      }

      const parametersHash = canonicalExecutionHash({
        tenantId: item.tenantId,
        requestId: item.id,
        stripeAccountId: item.installation.stripeAccountId,
        environment: item.environment,
        paymentKey: item.paymentKey,
        paymentIntentId: item.paymentIntentId,
        chargeId: item.chargeId,
        amountMinor: item.amountMinor,
        currency: item.currency,
        reason: item.reason,
      });
      const execution = await repositories.ensureExecution({
        requestId: item.id,
        idempotencyKey: input.idempotencyKey,
        canonicalParametersHash: parametersHash,
        amountMinor: item.amountMinor,
        currency: item.currency,
      });
      if (
        execution.idempotencyKey !== input.idempotencyKey ||
        execution.amountMinor !== item.amountMinor ||
        normalizeCurrency(execution.currency) !== normalizeCurrency(item.currency) ||
        !equalBytes(execution.canonicalParametersHash, parametersHash)
      ) {
        throw new Error("EXECUTION_IDEMPOTENCY_CONFLICT");
      }

      const marked = await repositories.markEffectPossible(item.id);
      if (!marked) {
        throw new Error("EFFECT_BOUNDARY_COMPARE_AND_SET_FAILED");
      }
      const maximum = await tx.refundExecutionAttempt.aggregate({
        where: { tenantId: input.tenantId, executionId: execution.id },
        _max: { attemptNumber: true },
      });
      const attempt = await repositories.beginExecutionAttempt(
        execution.id,
        (maximum._max.attemptNumber ?? 0) + 1,
        input.at,
      );
      return {
        kind: "execute",
        attemptId: attempt.id,
        idempotencyKey: execution.idempotencyKey,
      };
    });
  }

  async recordIdentifiedRefund(input: IdentifiedRefundInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      const item = await repositories.getExecutionWorkItem(input.requestId);
      if (item?.execution === null || item === null) {
        throw new Error("EXECUTION_NOT_FOUND");
      }
      if (item.execution.idempotencyKey !== input.idempotencyKey) {
        throw new Error("EXECUTION_IDEMPOTENCY_CONFLICT");
      }
      const identified = await repositories.markRefundIdentified({
        requestId: input.requestId,
        stripeRefundId: input.refundId,
        stripeRefundStatus: input.responseMatchesRequest ? input.refundStatus : null,
        reconciliationResolution: "preserve",
        ...(input.stripeRequestId === null ? {} : { stripeRequestId: input.stripeRequestId }),
        observedAt: input.at,
      });
      if (!identified) {
        throw new Error("REFUND_IDENTITY_COMPARE_AND_SET_FAILED");
      }
      await repositories.markRefundCorrelationCandidateLinked(
        input.requestId,
        input.refundId,
        "exact_linked",
        input.at,
      );
      const candidates = await repositories.listRefundCorrelationCandidates(input.requestId);
      for (const conflict of candidates) {
        if (conflict.stripeRefundId !== input.refundId) {
          await repositories.observeExternalRefund({
            installationId: item.installationId,
            stripeRefundId: conflict.stripeRefundId,
            stripeRefundCreatedAt: conflict.stripeCreatedAt,
            paymentKey: conflict.paymentKey,
            amountMinor: conflict.amountMinor,
            currency: normalizeCurrency(conflict.currency),
            classification: "proof_replay",
            observedAt: input.at,
          });
        }
      }
      const finished = await repositories.finishExecutionAttempt({
        attemptId: input.attemptId,
        state: "completed",
        ...(input.stripeRequestId === null ? {} : { stripeRequestId: input.stripeRequestId }),
        finishedAt: input.at,
      });
      if (!finished) {
        throw new Error("EXECUTION_ATTEMPT_COMPARE_AND_SET_FAILED");
      }
    });
  }

  async recordRetryableAttemptFailure(input: AttemptFailureInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      const finished = await repositories.finishExecutionAttempt({
        attemptId: input.attemptId,
        state: "retryable_failure",
        normalizedErrorCode: input.errorCode,
        finishedAt: input.at,
      });
      const absence = await repositories.markCertainAbsenceWhileExecuting(input.requestId);
      if (!finished || !absence) {
        throw new Error("RETRYABLE_FAILURE_COMPARE_AND_SET_FAILED");
      }
    });
  }

  async recordAmbiguousAttemptFailure(input: AttemptFailureInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      const finished = await repositories.finishExecutionAttempt({
        attemptId: input.attemptId,
        state: "ambiguous_failure",
        normalizedErrorCode: input.errorCode,
        finishedAt: input.at,
      });
      const reconciliation = await repositories.markReconciliationRequired(input.requestId);
      if (!finished || !reconciliation) {
        throw new Error("AMBIGUOUS_FAILURE_COMPARE_AND_SET_FAILED");
      }
    });
  }

  async recordTerminalAttemptWithoutEffect(input: AttemptFailureInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      const finished = await repositories.finishExecutionAttempt({
        attemptId: input.attemptId,
        state: "terminal_failure",
        normalizedErrorCode: input.errorCode,
        finishedAt: input.at,
      });
      const absence = await repositories.markCertainAbsenceWhileExecuting(input.requestId);
      const terminal = await repositories.markTerminalFailureAfterAbsence(
        input.requestId,
        input.at,
      );
      if (!finished || !absence || !terminal) {
        throw new Error("TERMINAL_FAILURE_COMPARE_AND_SET_FAILED");
      }
    });
  }

  async recordTerminalWithoutEffect(input: TerminalWithoutEffectInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      const terminal = await repositories.markTerminalFailureAfterAbsence(
        input.requestId,
        input.at,
      );
      if (!terminal) {
        const current = await repositories.getExecutionWorkItem(input.requestId);
        if (current?.workflowStatus !== "failed_terminal") {
          throw new Error("TERMINAL_PREFLIGHT_COMPARE_AND_SET_FAILED");
        }
      }
    });
  }

  async recordReconciliationRequired(input: ReconciliationRequiredInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      const marked = await repositories.markReconciliationRequired(input.requestId);
      if (!marked) {
        const current = await repositories.getExecutionWorkItem(input.requestId);
        if (current?.workflowStatus !== "reconciliation_required") {
          throw new Error("RECONCILIATION_COMPARE_AND_SET_FAILED");
        }
      }
    });
  }

  async listApprovedRefundExecutions(limit: number): Promise<readonly ApprovedRefundExecution[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Approved recovery limit must be between 1 and 1000");
    }

    const candidates: ApprovedRefundExecution[] = [];
    const tenantIds = await listActiveTenantIds(this.client);
    for (const tenantId of tenantIds) {
      const remaining = limit - candidates.length;
      if (remaining <= 0) {
        break;
      }
      const work = await withTenantTransaction(this.client, tenantId, ({ repositories }) =>
        repositories.prepareExecutionRecoveryWork(Math.min(remaining, 100)),
      );
      for (const item of work) {
        const expectedIdempotencyKey = refundIdempotencyKey(item.id);
        const executionCannotBeRecovered =
          (item.workflowStatus === "executing" &&
            item.effectState === "absence_proven" &&
            item.execution === null) ||
          (item.execution !== null &&
            (item.execution.stripeRefundId !== null ||
              item.execution.idempotencyKey !== expectedIdempotencyKey));
        if (executionCannotBeRecovered) {
          if (item.workflowStatus === "executing") {
            await withTenantTransaction(this.client, tenantId, async ({ repositories }) => {
              await requireExecutionReconciliation(repositories, item.id);
            });
          }
          continue;
        }
        candidates.push({
          tenantId: item.tenantId,
          requestId: item.id,
          installation: {
            tenantId: item.tenantId,
            installationId: item.installationId,
            stripeAccountId: item.installation.stripeAccountId,
            environment: item.environment,
            active: item.tenant.status === "active" && item.installation.status === "active",
            tenantLiveEnabled: item.tenant.liveEnabled,
          },
        });
      }
    }
    return candidates;
  }

  async listRecoverableWebhookJobs(limit: number): Promise<readonly ProcessWebhookJob[]> {
    const receipts = await listRecoverableWebhookReceipts(this.client, limit);
    return receipts.map((receipt) =>
      processWebhookJobSchema.parse({
        tenant_id: receipt.tenantId,
        installation_id: receipt.installationId,
        receipt_id: receipt.receiptId,
        stripe_event_id: receipt.stripeEventId,
        stripe_account_id: receipt.stripeAccountId,
        ...receipt.normalizedPayload,
      }),
    );
  }

  async markWebhookReceiptFailed(
    tenantId: string,
    receiptId: string,
    errorCode: string,
  ): Promise<void> {
    await withTenantTransaction(this.client, tenantId, async ({ repositories }) => {
      const receipt = await repositories.getWebhookReceipt(receiptId);
      if (receipt?.status === "processed") {
        return;
      }
      const marked = await repositories.markWebhookReceiptFailed(receiptId, errorCode);
      if (!marked) {
        throw new Error("WEBHOOK_RECEIPT_FAILURE_COMPARE_AND_SET_FAILED");
      }
    });
  }

  async processInstallationLifecycle(input: InstallationLifecycleInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      const receipt = await repositories.getWebhookReceipt(input.receiptId);
      if (receipt === null) {
        throw new Error("WEBHOOK_RECEIPT_NOT_FOUND");
      }
      if (receipt.status === "processed") {
        return;
      }
      const endpoint = input.environment === "test" ? "connected_test" : "connected_sandbox";
      const storedPayload = assertNormalizedWebhookRowConsistency({
        endpoint,
        eventType: receipt.eventType,
        objectId: receipt.objectId,
        stripeCreatedAt: receipt.stripeCreatedAt,
        normalizedPayload: receipt.normalizedPayload,
      });
      const expectedPayload: NormalizedConnectedWebhookPayload = {
        schema_version: 1,
        environment: input.environment,
        event_type: input.eventType,
        event_created: input.eventCreated,
        event_idempotency_key: input.eventIdempotencyKey,
        application_id: input.applicationId,
      };
      if (
        receipt.installationId !== input.installationId ||
        receipt.endpoint !== endpoint ||
        receipt.stripeEventId !== input.stripeEventId ||
        receipt.stripeAccountId !== input.stripeAccountId ||
        !normalizedPayloadEquals(storedPayload, expectedPayload)
      ) {
        throw new Error("WEBHOOK_RECEIPT_JOB_MISMATCH");
      }
      const installation = await repositories.getInstallationContext(input.installationId);
      if (
        installation === null ||
        installation.stripeAccountId !== input.stripeAccountId ||
        installation.environment !== input.environment ||
        installation.tenant.liveEnabled
      ) {
        throw new Error("WEBHOOK_LIFECYCLE_INSTALLATION_MISMATCH");
      }
      let applied =
        installation.lastLifecycleEventId === input.stripeEventId &&
        installation.lastLifecycleEventType === input.eventType;
      if (input.eventType === "account.application.deauthorized") {
        const eventCreatedAt = new Date(input.eventCreated * 1_000);
        applied = await repositories.applyWebhookDeauthorization({
          installationId: input.installationId,
          stripeEventId: input.stripeEventId,
          stripeEventCreatedAt: eventCreatedAt,
          purgeAt: new Date(eventCreatedAt.getTime() + TENANT_PURGE_DELAY_MILLISECONDS),
        });
      }
      const marked = await repositories.markWebhookReceiptProcessed(
        input.receiptId,
        input.processedAt,
      );
      if (!marked) {
        throw new Error("WEBHOOK_RECEIPT_PROCESS_COMPARE_AND_SET_FAILED");
      }
      await repositories.appendAuditEvent({
        actorType: "webhook",
        action:
          input.eventType === "account.application.authorized"
            ? "installation.authorized"
            : "installation.deauthorized",
        entityType: "stripe_installation",
        entityId: input.installationId,
        payload: {
          applied,
          environment: input.environment,
          stripe_event_id: input.stripeEventId,
        },
        correlationRequestId: randomUUID(),
        occurredAt: input.processedAt,
      });
    });
  }

  async observeRefund(input: ObserveRefundInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      if (input.environment === "live") {
        throw new Error("REFUND_OBSERVATION_INSTALLATION_MISMATCH");
      }
      if (input.source.kind === "webhook") {
        const receipt = await repositories.getWebhookReceipt(input.source.receiptId);
        if (receipt === null) {
          throw new Error("WEBHOOK_RECEIPT_NOT_FOUND");
        }
        if (receipt.status === "processed") {
          return;
        }
        const endpoint = input.environment === "test" ? "connected_test" : "connected_sandbox";
        const storedPayload = assertNormalizedWebhookRowConsistency({
          endpoint,
          eventType: receipt.eventType,
          objectId: receipt.objectId,
          stripeCreatedAt: receipt.stripeCreatedAt,
          normalizedPayload: receipt.normalizedPayload,
        });
        const expectedPayload: NormalizedConnectedWebhookPayload = {
          schema_version: 1,
          environment: input.environment,
          event_type: input.source.eventType,
          event_created: input.source.eventCreated,
          event_idempotency_key: input.source.eventIdempotencyKey,
          refund: {
            refund_id: input.refund.refundId,
            payment_intent_id: input.refund.paymentIntentId,
            charge_id: input.refund.chargeId,
            amount_minor: input.refund.amountMinor.toString(),
            currency: input.refund.currency,
            status: input.refund.status,
            created: input.refund.created,
            metadata_request_id: input.refund.metadataRequestId,
            metadata_proof: input.refund.metadataProof,
          },
        };
        if (
          receipt.installationId !== input.installationId ||
          receipt.endpoint !== endpoint ||
          receipt.stripeEventId !== input.source.stripeEventId ||
          receipt.stripeAccountId !== input.source.stripeAccountId ||
          !normalizedPayloadEquals(storedPayload, expectedPayload)
        ) {
          throw new Error("WEBHOOK_RECEIPT_JOB_MISMATCH");
        }
      }
      const installation = await repositories.getInstallationContext(input.installationId);
      if (
        installation === null ||
        installation.environment !== input.environment ||
        installation.status !== "active" ||
        installation.tenant.status !== "active" ||
        installation.tenant.liveEnabled
      ) {
        throw new Error("REFUND_OBSERVATION_INSTALLATION_MISMATCH");
      }

      const paymentKey = paymentKeyOf(input);
      const observedRefundStatus = authoritativeObservedRefundStatus(input);
      const metadataRequestId = input.refund.metadataRequestId;
      const request =
        metadataRequestId === null || !DATABASE_UUID_PATTERN.test(metadataRequestId)
          ? null
          : await repositories.getRefundRequestDetail(metadataRequestId);
      const tupleMatches =
        request !== null &&
        request.installationId === input.installationId &&
        request.environment === input.environment &&
        request.paymentKey === paymentKey &&
        request.amountMinor === input.refund.amountMinor &&
        normalizeCurrency(request.currency) === normalizeCurrency(input.refund.currency) &&
        (request.paymentIntentId === null ||
          request.paymentIntentId === input.refund.paymentIntentId) &&
        (request.chargeId === null || request.chargeId === input.refund.chargeId);
      const proofValid =
        tupleMatches &&
        input.refund.metadataProof !== null &&
        request !== null &&
        this.proofs.verify(
          {
            tenantId: input.tenantId,
            stripeAccountId: installation.stripeAccountId,
            requestId: request.id,
            paymentKey: request.paymentKey,
            amountMinor: request.amountMinor,
            currency: request.currency,
            environment: request.environment,
          },
          input.refund.metadataProof,
        );
      let classification:
        "external" | "tampered" | "workflow_candidate" | "workflow_refund" | "proof_replay";
      if (metadataRequestId !== null && request === null) {
        classification = "tampered";
      } else {
        classification = classifyRefundEvidence({
          candidateRefundId: input.refund.refundId,
          metadataRequestId,
          metadataProof: input.refund.metadataProof,
          expectedRequestId: request?.id ?? "",
          proofValid,
          linkedRefundId: request?.execution?.stripeRefundId ?? null,
        });
      }

      const workflowEvidence =
        classification === "workflow_candidate" || classification === "workflow_refund";
      const alreadyLinked =
        workflowEvidence && request?.execution?.stripeRefundId === input.refund.refundId;
      const knownObservationAlreadyHandled =
        alreadyLinked &&
        request?.execution !== null &&
        request?.execution !== undefined &&
        !shouldApplyLinkedRefundObservation({
          currentStatus: request.execution.stripeRefundStatus,
          lastStripeEventCreatedAt: request.execution.lastStripeEventCreatedAt,
          observation: input,
        });

      const eventIdempotencyCorrelation =
        input.source.kind === "scan" || input.source.eventIdempotencyKey === null
          ? "absent"
          : request?.execution !== null &&
              request?.execution !== undefined &&
              input.source.eventIdempotencyKey === request.execution.idempotencyKey
            ? "exact"
            : "mismatch";
      const canPersistCandidate =
        request !== null &&
        request.execution !== null &&
        tupleMatches &&
        proofValid &&
        (classification === "workflow_candidate" ||
          classification === "workflow_refund" ||
          classification === "proof_replay");
      let candidateCount = 0;
      if (canPersistCandidate && request !== null) {
        const candidate = await repositories.recordRefundCorrelationCandidate({
          requestId: request.id,
          installationId: input.installationId,
          stripeRefundId: input.refund.refundId,
          paymentKey,
          paymentIntentId: input.refund.paymentIntentId,
          chargeId: input.refund.chargeId,
          amountMinor: input.refund.amountMinor,
          currency: normalizeCurrency(input.refund.currency),
          stripeRefundStatus: observedRefundStatus,
          stripeCreatedAt: new Date(input.refund.created * 1_000),
          stripeEventId: input.source.kind === "webhook" ? input.source.stripeEventId : null,
          stripeEventCreatedAt:
            input.source.kind === "webhook" ? new Date(input.source.eventCreated * 1_000) : null,
          eventIdempotencyCorrelation,
          scanWindowEnd: input.source.kind === "scan" ? input.source.scanWindowEnd : null,
          observedAt: input.observedAt,
        });
        candidateCount = candidate.candidateCount;
      }

      const unlinkedCandidate =
        classification === "workflow_candidate" &&
        request !== null &&
        request.execution !== null &&
        request.execution.stripeRefundId === null &&
        (request.workflowStatus === "executing" ||
          request.workflowStatus === "reconciliation_required");
      if (unlinkedCandidate && request !== null && !knownObservationAlreadyHandled) {
        const candidateDecision = decideRefundCandidate({
          linkedRefundId: request.execution?.stripeRefundId ?? null,
          candidateRefundId: input.refund.refundId,
          eventIdempotencyEvidence: eventIdempotencyCorrelation,
          candidateCount: Math.max(1, candidateCount),
          completeScan: false,
          scanCoversExecution: false,
        });
        if (candidateDecision === "link_exact") {
          const identified = await repositories.markRefundIdentified({
            requestId: request.id,
            stripeRefundId: input.refund.refundId,
            stripeRefundStatus: observedRefundStatus,
            reconciliationResolution: "preserve",
            ...(input.source.kind === "webhook"
              ? {
                  stripeEventId: input.source.stripeEventId,
                  stripeEventCreatedAt: new Date(input.source.eventCreated * 1_000),
                }
              : {}),
            observedAt: input.observedAt,
          });
          if (!identified) {
            throw new Error("OBSERVED_REFUND_COMPARE_AND_SET_FAILED");
          }
          await repositories.markRefundCorrelationCandidateLinked(
            request.id,
            input.refund.refundId,
            "exact_linked",
            input.observedAt,
          );
          const candidates = await repositories.listRefundCorrelationCandidates(request.id);
          for (const conflict of candidates) {
            if (conflict.stripeRefundId !== input.refund.refundId) {
              await repositories.observeExternalRefund({
                installationId: input.installationId,
                stripeRefundId: conflict.stripeRefundId,
                stripeRefundCreatedAt: conflict.stripeCreatedAt,
                paymentKey: conflict.paymentKey,
                amountMinor: conflict.amountMinor,
                currency: normalizeCurrency(conflict.currency),
                classification: "proof_replay",
                observedAt: input.observedAt,
              });
            }
          }
          classification = "workflow_refund";
        } else {
          await repositories.markReconciliationRequired(request.id);
          if (candidateDecision === "conflict" && eventIdempotencyCorrelation === "mismatch") {
            classification = "tampered";
          } else if (candidateDecision === "conflict") {
            classification = "proof_replay";
          }
        }
      } else if (
        workflowEvidence &&
        alreadyLinked &&
        request !== null &&
        request.execution !== null &&
        !knownObservationAlreadyHandled
      ) {
        const identified = await repositories.markRefundIdentified({
          requestId: request.id,
          stripeRefundId: input.refund.refundId,
          stripeRefundStatus: observedRefundStatus,
          reconciliationResolution: "preserve",
          ...(input.source.kind === "webhook"
            ? {
                stripeEventId: input.source.stripeEventId,
                stripeEventCreatedAt: new Date(input.source.eventCreated * 1_000),
              }
            : {}),
          observedAt: input.observedAt,
        });
        if (!identified) {
          throw new Error("OBSERVED_REFUND_COMPARE_AND_SET_FAILED");
        }
      }

      const needsExternalAlert =
        !knownObservationAlreadyHandled &&
        (classification === "external" ||
          classification === "tampered" ||
          classification === "proof_replay");
      if (needsExternalAlert) {
        const alertClassification =
          classification === "proof_replay"
            ? "proof_replay"
            : classification === "tampered"
              ? "tampered"
              : "external";
        await repositories.observeExternalRefund({
          installationId: input.installationId,
          stripeRefundId: input.refund.refundId,
          stripeRefundCreatedAt: new Date(input.refund.created * 1_000),
          paymentKey,
          amountMinor: input.refund.amountMinor,
          currency: normalizeCurrency(input.refund.currency),
          classification: alertClassification,
          observedAt: input.observedAt,
        });
      }

      if (input.source.kind === "webhook") {
        const marked = await repositories.markWebhookReceiptProcessed(
          input.source.receiptId,
          input.observedAt,
        );
        if (!marked) {
          throw new Error("WEBHOOK_RECEIPT_PROCESS_COMPARE_AND_SET_FAILED");
        }
      }
      await repositories.appendAuditEvent({
        actorType: "worker",
        action: "refund.observed",
        entityType: "stripe_refund",
        entityId: input.refund.refundId,
        payload: {
          source: input.source.kind,
          classification,
          event_idempotency_key_present: input.source.eventIdempotencyKey !== null,
        },
        correlationRequestId: randomUUID(),
        occurredAt: input.observedAt,
      });
    });
  }

  async listScannableInstallations(): Promise<readonly ScannableWorkerInstallation[]> {
    const installations = await listDbScannableInstallations(this.client);
    return installations.map((installation) => ({
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      stripeAccountId: installation.stripeAccountId,
      environment: installation.environment,
      active:
        installation.tenantStatus === "active" && installation.installationStatus === "active",
      tenantLiveEnabled: installation.liveEnabled,
      installedAt: installation.installedAt,
    }));
  }

  async listLinkedRefundReconciliationTargets(
    tenantId: string,
    installationId: string,
    afterRequestId: string | null,
    limit: number,
  ): Promise<readonly LinkedRefundReconciliationTarget[]> {
    return withTenantTransaction(this.client, tenantId, async ({ repositories }) => {
      const installation = await repositories.getInstallationContext(installationId);
      if (
        installation === null ||
        installation.status !== "active" ||
        installation.environment === "live" ||
        installation.tenant.status !== "active" ||
        installation.tenant.liveEnabled
      ) {
        throw new Error("LINKED_REFUND_RECONCILIATION_INSTALLATION_MISMATCH");
      }
      return repositories.listLinkedRefundReconciliationTargets(
        installationId,
        afterRequestId,
        limit,
      );
    });
  }

  async observeLinkedRefund(input: ObserveLinkedRefundInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      if (
        Number.isNaN(input.scanWindowEnd.getTime()) ||
        Number.isNaN(input.observedAt.getTime()) ||
        input.observedAt.getTime() < input.scanWindowEnd.getTime() ||
        !/^re_[A-Za-z0-9]+$/u.test(input.expectedRefundId) ||
        input.refund.refundId !== input.expectedRefundId
      ) {
        throw new Error("LINKED_REFUND_RECONCILIATION_INPUT_MISMATCH");
      }
      const authorizationLocked = await repositories.lockExecutionAuthorization(
        input.requestId,
        input.installationId,
      );
      if (!authorizationLocked) {
        throw new Error("LINKED_REFUND_RECONCILIATION_REQUEST_NOT_FOUND");
      }
      const item = await repositories.getExecutionWorkItem(input.requestId);
      if (
        item === null ||
        !hasActivePilotExecutionContext(item) ||
        item.installationId !== input.installationId ||
        item.environment !== input.environment ||
        item.execution === null ||
        item.execution.stripeRefundId !== input.expectedRefundId
      ) {
        throw new Error("LINKED_REFUND_RECONCILIATION_REQUEST_MISMATCH");
      }

      const paymentKey = paymentKeyOf(input);
      const tupleMatches =
        item.paymentKey === paymentKey &&
        item.amountMinor === input.refund.amountMinor &&
        normalizeCurrency(item.currency) === normalizeCurrency(input.refund.currency) &&
        item.execution.amountMinor === item.amountMinor &&
        normalizeCurrency(item.execution.currency) === normalizeCurrency(item.currency) &&
        (item.paymentIntentId === null || item.paymentIntentId === input.refund.paymentIntentId) &&
        (item.chargeId === null || item.chargeId === input.refund.chargeId);
      if (!tupleMatches) {
        throw new Error("LINKED_REFUND_RECONCILIATION_TUPLE_MISMATCH");
      }

      const identified = await repositories.markRefundIdentified({
        requestId: item.id,
        stripeRefundId: input.expectedRefundId,
        stripeRefundStatus: input.refund.status,
        reconciliationResolution:
          input.refund.status === "succeeded" ||
          input.refund.status === "failed" ||
          input.refund.status === "canceled"
            ? "resolve"
            : "preserve",
        observedAt: input.observedAt,
      });
      if (!identified) {
        throw new Error("LINKED_REFUND_RECONCILIATION_COMPARE_AND_SET_FAILED");
      }
      await repositories.appendAuditEvent({
        actorType: "worker",
        action: "refund.linked_status_refreshed",
        entityType: "stripe_refund",
        entityId: input.expectedRefundId,
        payload: {
          source: "linked_scan",
          scan_window_end: input.scanWindowEnd.toISOString(),
          stripe_refund_status: input.refund.status,
        },
        correlationRequestId: randomUUID(),
        occurredAt: input.observedAt,
      });
    });
  }

  async loadReconciliationCheckpoint(
    tenantId: string,
    installationId: string,
  ): Promise<ReconciliationCheckpoint | null> {
    return withTenantTransaction(this.client, tenantId, async ({ repositories }) => {
      const checkpoint = await repositories.getReconciliationCheckpoint(installationId);
      return checkpoint === null ? null : { windowEnd: checkpoint.committedThrough };
    });
  }

  async commitReconciliationCheckpoint(input: CommitCheckpointInput): Promise<void> {
    await withTenantTransaction(this.client, input.tenantId, async ({ repositories }) => {
      const current = await repositories.getReconciliationCheckpoint(input.installationId);
      if (
        (current === null && input.previousWindowEnd !== null) ||
        (current !== null &&
          (input.previousWindowEnd === null ||
            !dateEquals(current.committedThrough, input.previousWindowEnd)))
      ) {
        throw new Error("RECONCILIATION_CHECKPOINT_COMPARE_AND_SET_FAILED");
      }
      await repositories.beginReconciliationWindow({
        installationId: input.installationId,
        initialCommittedThrough: input.previousWindowEnd ?? input.windowStart,
        scanWindowEnd: input.windowEnd,
      });
      await repositories.completeReconciliationWindow(input.installationId, input.windowEnd, null);
      await repositories.resolveUniqueRefundCandidates(
        input.installationId,
        input.windowStart,
        input.windowEnd,
        input.completedAt,
      );
    });
  }

  async expireDueRequests(now: Date, limit: number): Promise<number> {
    const tenantIds = await listActiveTenantIds(this.client);
    let expired = 0;
    for (const tenantId of tenantIds) {
      const remaining = limit - expired;
      if (remaining <= 0) {
        break;
      }
      expired += await withTenantTransaction(this.client, tenantId, ({ repositories }) =>
        repositories.expirePendingRequests(now, remaining),
      );
    }
    return expired;
  }
}
