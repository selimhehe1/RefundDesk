import {
  assertNormalizedWebhookRowConsistency,
  connectedWebhookEndpointSchema,
  type NormalizedConnectedWebhookPayload,
} from "./connected-webhook.js";

import type {
  ApiMutationReceipt,
  ApprovalPolicy,
  ApprovalDecision,
  AuditEvent,
  ExternalRefundAlert,
  ExecutionAttemptState,
  Prisma,
  ReconciliationCheckpoint,
  RefundExecution,
  RefundExecutionAttempt,
  RefundRequest,
  StripeEnvironment,
  StripeInstallation,
  StripeRefundStatus,
  TenantUser,
  WebhookReceipt,
} from "./generated/prisma/client.js";
import { decideRefundCandidate } from "./refund-candidate-policy.js";

export interface DecisionResult {
  readonly decision: ApprovalDecision;
  readonly becameApproved: boolean;
  readonly becameRejected: boolean;
}

export interface EnsureExecutionInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly canonicalParametersHash: Uint8Array;
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface IdentifiedRefundInput {
  readonly requestId: string;
  readonly stripeRefundId: string;
  readonly stripeRefundStatus: StripeRefundStatus | null;
  readonly reconciliationResolution: "preserve" | "resolve";
  readonly stripeRequestId?: string;
  readonly stripeEventId?: string;
  readonly stripeEventCreatedAt?: Date;
  readonly observedAt: Date;
}

export interface BeginCheckpointInput {
  readonly installationId: string;
  readonly initialCommittedThrough: Date;
  readonly scanWindowEnd: Date;
}

export interface ObserveTenantUserInput {
  readonly stripeUserId: string;
  readonly displayName?: string | null;
  readonly stripeRoles?: Prisma.InputJsonValue;
  readonly verifiedAt: Date;
}

export type InstallationContext = Prisma.StripeInstallationGetPayload<{
  include: { tenant: true };
}>;

export type RefundRequestDetail = Prisma.RefundRequestGetPayload<{
  include: {
    decisions: true;
    execution: { include: { attempts: true } };
  };
}>;

export interface RequestListInput {
  readonly scope: "all" | "requester" | "awaiting_approval";
  readonly actorUserId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AlertListInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly status?: "open" | "acknowledged";
}

export interface AuditListInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly occurredFrom?: Date;
  readonly occurredTo?: Date;
}

export interface SettingsSnapshot {
  readonly installation: InstallationContext;
  readonly activePolicy: ApprovalPolicy | null;
  readonly approvers: readonly TenantUser[];
}

export interface WebhookReceiptInsertResult {
  readonly receipt: WebhookReceipt;
  readonly inserted: boolean;
}

export interface WebhookReceiptInsertInput {
  readonly installationId: string;
  readonly endpoint: "connected_test" | "connected_sandbox";
  readonly stripeEventId: string;
  readonly stripeAccountId: string;
  readonly eventType: NormalizedConnectedWebhookPayload["event_type"];
  readonly objectId: string;
  readonly stripeCreatedAt: Date;
  readonly receivedAt?: Date;
  readonly normalizedPayload: NormalizedConnectedWebhookPayload;
}

export interface RefundCorrelationCandidateInput {
  readonly requestId: string;
  readonly installationId: string;
  readonly stripeRefundId: string;
  readonly paymentKey: string;
  readonly paymentIntentId: string | null;
  readonly chargeId: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly stripeRefundStatus: StripeRefundStatus | null;
  readonly stripeCreatedAt: Date;
  readonly stripeEventId: string | null;
  readonly stripeEventCreatedAt: Date | null;
  readonly eventIdempotencyCorrelation: "absent" | "exact" | "mismatch";
  readonly scanWindowEnd: Date | null;
  readonly observedAt: Date;
}

export interface RefundCorrelationCandidateResult {
  readonly candidateCount: number;
  readonly state: "pending" | "exact_linked" | "unique_linked" | "conflict";
}

export interface WebhookDeauthorizationInput {
  readonly installationId: string;
  readonly stripeEventId: string;
  readonly stripeEventCreatedAt: Date;
  readonly purgeAt: Date;
}

interface DeauthorizationLockedRequest {
  readonly id: string;
  readonly workflow_status:
    | "pending_approval"
    | "approved"
    | "executing"
    | "reconciliation_required"
    | "succeeded"
    | "failed_terminal"
    | "rejected"
    | "canceled"
    | "expired"
    | "stale";
  readonly effect_state: "not_started" | "possible" | "identified" | "absence_proven";
  readonly payment_guard_released_at: Date | null;
}

export type ExecutionWorkItem = Prisma.RefundRequestGetPayload<{
  include: { installation: true; tenant: true; execution: true };
}>;

export interface LinkedRefundReconciliationTarget {
  readonly requestId: string;
  readonly refundId: string;
}

export interface FinishExecutionAttemptInput {
  readonly attemptId: string;
  readonly state: Exclude<ExecutionAttemptState, "started">;
  readonly normalizedErrorCode?: string;
  readonly stripeRequestId?: string;
  readonly finishedAt: Date;
}

export interface ExternalRefundObservationInput {
  readonly installationId: string;
  readonly stripeRefundId: string;
  readonly stripeRefundCreatedAt: Date;
  readonly paymentKey: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly classification: "external" | "tampered" | "proof_replay";
  readonly observedAt: Date;
}

interface ExternalPaymentLockedRequest {
  readonly id: string;
  readonly workflow_status:
    | "pending_approval"
    | "approved"
    | "executing"
    | "reconciliation_required"
    | "succeeded"
    | "failed_terminal"
    | "rejected"
    | "canceled"
    | "expired"
    | "stale";
  readonly effect_state: "not_started" | "possible" | "identified" | "absence_proven";
  readonly payment_guard_released_at: Date | null;
  readonly execution_started_at: Date | null;
  readonly terminal_at: Date | null;
}

interface LockedRefundObservation {
  readonly id: string;
  readonly workflow_status:
    | "pending_approval"
    | "approved"
    | "executing"
    | "reconciliation_required"
    | "succeeded"
    | "failed_terminal"
    | "rejected"
    | "canceled"
    | "expired"
    | "stale";
  readonly effect_state: "not_started" | "possible" | "identified" | "absence_proven";
  readonly execution_id: string;
  readonly stripe_refund_id: string | null;
  readonly stripe_refund_status: StripeRefundStatus | null;
  readonly last_stripe_event_created_at: Date | null;
}

function shouldApplyRefundObservation(
  locked: LockedRefundObservation,
  input: IdentifiedRefundInput,
): boolean {
  const currentStatus = locked.stripe_refund_status;
  const incomingStatus = input.stripeRefundStatus;
  const currentEventCreatedAt = locked.last_stripe_event_created_at;
  const incomingEventCreatedAt = input.stripeEventCreatedAt;

  if (
    incomingEventCreatedAt !== undefined &&
    currentEventCreatedAt !== null &&
    incomingEventCreatedAt.getTime() < currentEventCreatedAt.getTime()
  ) {
    return false;
  }

  if (currentStatus === "failed" || currentStatus === "canceled") {
    return incomingStatus === currentStatus;
  }
  if (currentStatus === "succeeded" && incomingStatus !== "succeeded") {
    return incomingStatus === "failed";
  }
  if (currentStatus !== null && incomingStatus === null) {
    return false;
  }

  if (
    incomingEventCreatedAt !== undefined &&
    currentEventCreatedAt !== null &&
    incomingEventCreatedAt.getTime() === currentEventCreatedAt.getTime() &&
    incomingStatus !== currentStatus
  ) {
    if (incomingStatus === "failed") {
      return true;
    }
    if (currentStatus === null && incomingStatus !== null) {
      return true;
    }
    return incomingStatus === "succeeded" || incomingStatus === "canceled";
  }

  return true;
}

export class TenantRepositories {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    readonly tenantId: string,
  ) {}

  observeTenantUser(input: ObserveTenantUserInput): Promise<TenantUser> {
    return this.tx.tenantUser.upsert({
      where: {
        tenantId_stripeUserId: {
          tenantId: this.tenantId,
          stripeUserId: input.stripeUserId,
        },
      },
      create: {
        tenantId: this.tenantId,
        stripeUserId: input.stripeUserId,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.stripeRoles === undefined ? {} : { stripeRoles: input.stripeRoles }),
        lastVerifiedAt: input.verifiedAt,
      },
      update: {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.stripeRoles === undefined
          ? {}
          : {
              stripeRoles: input.stripeRoles,
              lastVerifiedAt: input.verifiedAt,
            }),
      },
    });
  }

  getInstallationContext(installationId: string): Promise<InstallationContext | null> {
    return this.tx.stripeInstallation.findFirst({
      where: { id: installationId, tenantId: this.tenantId },
      include: { tenant: true },
    });
  }

  listInstallations(): Promise<readonly StripeInstallation[]> {
    return this.tx.stripeInstallation.findMany({
      where: { tenantId: this.tenantId },
      orderBy: [{ installedAt: "asc" }, { id: "asc" }],
    });
  }

  getActiveApprovalPolicy(): Promise<ApprovalPolicy | null> {
    return this.tx.approvalPolicy.findFirst({
      where: { tenantId: this.tenantId, active: true },
    });
  }

  listApprovers(): Promise<readonly TenantUser[]> {
    return this.tx.tenantUser.findMany({
      where: { tenantId: this.tenantId, approverEnabled: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    });
  }

  listObservedTenantUsers(): Promise<readonly TenantUser[]> {
    return this.tx.tenantUser.findMany({
      where: { tenantId: this.tenantId },
      orderBy: [{ displayName: "asc" }, { stripeUserId: "asc" }],
    });
  }

  getTenantUserByStripeUserId(stripeUserId: string): Promise<TenantUser | null> {
    return this.tx.tenantUser.findUnique({
      where: {
        tenantId_stripeUserId: {
          tenantId: this.tenantId,
          stripeUserId,
        },
      },
    });
  }

  async setApproverEnabled(userId: string, enabled: boolean): Promise<TenantUser | null> {
    const updated = await this.tx.tenantUser.updateMany({
      where: { id: userId, tenantId: this.tenantId },
      data: { approverEnabled: enabled },
    });
    return updated.count === 1
      ? this.tx.tenantUser.findFirst({
          where: { id: userId, tenantId: this.tenantId },
        })
      : null;
  }

  async setApproverEnabledByStripeUserId(
    stripeUserId: string,
    enabled: boolean,
  ): Promise<TenantUser | null> {
    const updated = await this.tx.tenantUser.updateMany({
      where: { tenantId: this.tenantId, stripeUserId },
      data: { approverEnabled: enabled },
    });
    return updated.count === 1 ? this.getTenantUserByStripeUserId(stripeUserId) : null;
  }

  countEligibleDistinctApprovers(requesterUserId: string): Promise<number> {
    return this.tx.tenantUser.count({
      where: {
        tenantId: this.tenantId,
        approverEnabled: true,
        id: { not: requesterUserId },
      },
    });
  }

  async getSettings(installationId: string): Promise<SettingsSnapshot | null> {
    const [installation, activePolicy, approvers] = await Promise.all([
      this.getInstallationContext(installationId),
      this.getActiveApprovalPolicy(),
      this.listApprovers(),
    ]);
    return installation === null ? null : { installation, activePolicy, approvers };
  }

  async completeOnboarding(installationId: string, completedAt: Date): Promise<boolean> {
    const result = await this.tx.stripeInstallation.updateMany({
      where: {
        id: installationId,
        tenantId: this.tenantId,
        status: "active",
      },
      data: { onboardingCompletedAt: completedAt },
    });
    return result.count === 1;
  }

  private async settleRequestsForDeauthorization(occurredAt: Date): Promise<void> {
    // Keep the lock order aligned with the worker's effect-boundary transaction:
    // installation (held by the caller) -> tenant -> requests. Once these locks
    // are held, either the boundary committed first (and the effect is possible)
    // or deauthorization wins and the request can no longer cross it.
    const lockedTenant = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM tenants
      WHERE id = ${this.tenantId}::UUID
      FOR UPDATE
    `;
    if (lockedTenant.length !== 1) {
      throw new Error("DEAUTHORIZATION_TENANT_LOCK_FAILED");
    }
    const lockedRequests = await this.tx.$queryRaw<readonly DeauthorizationLockedRequest[]>`
      SELECT id, workflow_status, effect_state, payment_guard_released_at
      FROM refund_requests
      WHERE tenant_id = ${this.tenantId}::UUID
      ORDER BY id
      FOR UPDATE
    `;

    const staleCount = lockedRequests.filter(
      (request) =>
        request.payment_guard_released_at === null &&
        request.effect_state === "not_started" &&
        (request.workflow_status === "pending_approval" || request.workflow_status === "approved"),
    ).length;
    const terminalCount = lockedRequests.filter(
      (request) =>
        request.payment_guard_released_at === null &&
        request.workflow_status === "executing" &&
        (request.effect_state === "not_started" || request.effect_state === "absence_proven"),
    ).length;
    const reconciliationCount = lockedRequests.filter(
      (request) =>
        request.payment_guard_released_at === null &&
        request.workflow_status === "executing" &&
        (request.effect_state === "possible" || request.effect_state === "identified"),
    ).length;

    const stale = await this.tx.refundRequest.updateMany({
      where: {
        tenantId: this.tenantId,
        workflowStatus: { in: ["pending_approval", "approved"] },
        effectState: "not_started",
        paymentGuardReleasedAt: null,
      },
      data: {
        workflowStatus: "stale",
        effectState: "absence_proven",
        terminalAt: occurredAt,
        paymentGuardReleasedAt: occurredAt,
        version: { increment: 1 },
      },
    });
    const terminal = await this.tx.refundRequest.updateMany({
      where: {
        tenantId: this.tenantId,
        workflowStatus: "executing",
        effectState: { in: ["not_started", "absence_proven"] },
        paymentGuardReleasedAt: null,
      },
      data: {
        workflowStatus: "failed_terminal",
        effectState: "absence_proven",
        terminalAt: occurredAt,
        paymentGuardReleasedAt: occurredAt,
        version: { increment: 1 },
      },
    });
    const reconciliation = await this.tx.refundRequest.updateMany({
      where: {
        tenantId: this.tenantId,
        workflowStatus: "executing",
        effectState: { in: ["possible", "identified"] },
        paymentGuardReleasedAt: null,
      },
      data: {
        workflowStatus: "reconciliation_required",
        version: { increment: 1 },
      },
    });
    if (
      stale.count !== staleCount ||
      terminal.count !== terminalCount ||
      reconciliation.count !== reconciliationCount
    ) {
      throw new Error("DEAUTHORIZATION_REQUEST_COMPARE_AND_SET_FAILED");
    }
  }

  async deauthorizeInstallation(
    installationId: string,
    deauthorizedAt: Date,
    purgeAt: Date,
  ): Promise<boolean> {
    if (purgeAt.getTime() <= deauthorizedAt.getTime()) {
      throw new RangeError("Tenant purge must be scheduled after deauthorization");
    }
    const locked = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM stripe_installations
      WHERE id = ${installationId}::UUID
        AND tenant_id = ${this.tenantId}::UUID
      FOR UPDATE
    `;
    if (locked.length !== 1) {
      return false;
    }
    const installation = await this.tx.stripeInstallation.updateMany({
      where: { id: installationId, tenantId: this.tenantId },
      data: {
        status: "deauthorized",
        deauthorizedAt,
      },
    });
    if (installation.count !== 1) {
      throw new Error("DEAUTHORIZATION_INSTALLATION_COMPARE_AND_SET_FAILED");
    }
    // The role-boundary trigger permits only monotone protective lifecycle
    // changes once the installation is durably non-executable. Keep this order
    // aligned with the connected-webhook path; the transaction rolls it all
    // back if request settlement fails.
    await this.settleRequestsForDeauthorization(deauthorizedAt);
    await this.tx.tenant.updateMany({
      where: { id: this.tenantId },
      data: {
        status: "pending_deletion",
        pendingDeleteAt: purgeAt,
      },
    });
    return true;
  }

  async applyWebhookDeauthorization(input: WebhookDeauthorizationInput): Promise<boolean> {
    if (input.purgeAt.getTime() <= input.stripeEventCreatedAt.getTime()) {
      throw new RangeError("Tenant purge must be scheduled after deauthorization");
    }
    const locked = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM stripe_installations
      WHERE id = ${input.installationId}::UUID
        AND tenant_id = ${this.tenantId}::UUID
      FOR UPDATE
    `;
    if (locked.length !== 1) {
      return false;
    }
    const installation = await this.tx.stripeInstallation.findFirst({
      where: { id: input.installationId, tenantId: this.tenantId },
    });
    if (installation === null || installation.environment === "live") {
      return false;
    }
    const priorCreatedAt = installation.lastLifecycleEventCreatedAt;
    const sameTimestamp = priorCreatedAt?.getTime() === input.stripeEventCreatedAt.getTime();
    const shouldApply =
      priorCreatedAt === null ||
      input.stripeEventCreatedAt.getTime() > priorCreatedAt.getTime() ||
      (sameTimestamp &&
        (installation.lastLifecycleEventId === input.stripeEventId ||
          installation.lastLifecycleEventType === "account.application.authorized"));
    if (!shouldApply) {
      return false;
    }

    await this.tx.stripeInstallation.update({
      where: { id: installation.id },
      data: {
        status: "deauthorized",
        deauthorizedAt: input.stripeEventCreatedAt,
        lastLifecycleEventId: input.stripeEventId,
        lastLifecycleEventType: "account.application.deauthorized",
        lastLifecycleEventCreatedAt: input.stripeEventCreatedAt,
      },
    });
    await this.settleRequestsForDeauthorization(input.stripeEventCreatedAt);
    await this.tx.tenant.update({
      where: { id: this.tenantId },
      data: {
        status: "pending_deletion",
        pendingDeleteAt: input.purgeAt,
      },
    });
    return true;
  }

  async createApprovalPolicy(createdByStripeUserId: string): Promise<ApprovalPolicy> {
    const latest = await this.tx.approvalPolicy.aggregate({
      where: { tenantId: this.tenantId },
      _max: { version: true },
    });
    await this.tx.approvalPolicy.updateMany({
      where: { tenantId: this.tenantId, active: true },
      data: { active: false },
    });
    return this.tx.approvalPolicy.create({
      data: {
        tenantId: this.tenantId,
        version: (latest._max.version ?? 0) + 1,
        active: true,
        requiredApprovals: 1,
        expiresAfterSeconds: 604_800,
        createdByStripeUserId,
      },
    });
  }

  createRefundRequest(
    data: Omit<Prisma.RefundRequestUncheckedCreateInput, "tenantId">,
  ): Promise<RefundRequest> {
    return this.tx.refundRequest.create({
      data: { ...data, tenantId: this.tenantId },
    });
  }

  getRefundRequest(requestId: string): Promise<RefundRequest | null> {
    return this.tx.refundRequest.findFirst({
      where: { id: requestId, tenantId: this.tenantId },
    });
  }

  getRefundRequestDetail(requestId: string): Promise<RefundRequestDetail | null> {
    return this.tx.refundRequest.findFirst({
      where: { id: requestId, tenantId: this.tenantId },
      include: {
        decisions: { orderBy: [{ decidedAt: "asc" }, { id: "asc" }] },
        execution: { include: { attempts: { orderBy: { attemptNumber: "asc" } } } },
      },
    });
  }

  getActiveRequestByPayment(
    environment: StripeEnvironment,
    paymentKey: string,
  ): Promise<RefundRequest | null> {
    return this.tx.refundRequest.findFirst({
      where: {
        tenantId: this.tenantId,
        environment,
        paymentKey,
        paymentGuardReleasedAt: null,
      },
    });
  }

  listRefundRequests(input: RequestListInput): Promise<readonly RefundRequestDetail[]> {
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Request page size must be between 1 and 100");
    }
    const scopeWhere: Prisma.RefundRequestWhereInput =
      input.scope === "requester"
        ? { requesterUserId: input.actorUserId }
        : input.scope === "awaiting_approval"
          ? {
              workflowStatus: "pending_approval",
              requesterUserId: { not: input.actorUserId },
              decisions: { none: { approverUserId: input.actorUserId } },
            }
          : {};
    return this.tx.refundRequest.findMany({
      where: { tenantId: this.tenantId, ...scopeWhere },
      ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
      take: limit,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        decisions: { orderBy: [{ decidedAt: "asc" }, { id: "asc" }] },
        execution: { include: { attempts: { orderBy: { attemptNumber: "asc" } } } },
      },
    });
  }

  async recordDecision(
    data: Omit<Prisma.ApprovalDecisionUncheckedCreateInput, "tenantId">,
    now: Date,
  ): Promise<DecisionResult> {
    const decision = await this.tx.approvalDecision.create({
      data: { ...data, tenantId: this.tenantId },
    });
    if (decision.decision === "reject") {
      const rejected = await this.tx.refundRequest.updateMany({
        where: {
          id: decision.requestId,
          tenantId: this.tenantId,
          workflowStatus: "pending_approval",
          effectState: "not_started",
        },
        data: {
          workflowStatus: "rejected",
          terminalAt: now,
          paymentGuardReleasedAt: now,
          version: { increment: 1 },
        },
      });
      return {
        decision,
        becameApproved: false,
        becameRejected: rejected.count === 1,
      };
    }

    const approved = await this.tx.refundRequest.updateMany({
      where: {
        id: decision.requestId,
        tenantId: this.tenantId,
        workflowStatus: "pending_approval",
      },
      data: {
        workflowStatus: "approved",
        approvedAt: now,
        version: { increment: 1 },
      },
    });
    return {
      decision,
      becameApproved: approved.count === 1,
      becameRejected: false,
    };
  }

  async cancelPendingRequest(
    requestId: string,
    requesterUserId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.tx.refundRequest.updateMany({
      where: {
        id: requestId,
        tenantId: this.tenantId,
        requesterUserId,
        workflowStatus: "pending_approval",
        effectState: "not_started",
      },
      data: {
        workflowStatus: "canceled",
        terminalAt: now,
        paymentGuardReleasedAt: now,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  async claimExecution(requestId: string, now: Date): Promise<RefundRequest | null> {
    const claimed = await this.tx.refundRequest.updateMany({
      where: {
        id: requestId,
        tenantId: this.tenantId,
        workflowStatus: "approved",
        effectState: "not_started",
        paymentGuardReleasedAt: null,
        environment: { in: ["test", "sandbox"] },
        tenant: {
          status: "active",
          liveEnabled: false,
        },
        installation: {
          status: "active",
          environment: { in: ["test", "sandbox"] },
        },
      },
      data: {
        workflowStatus: "executing",
        executionStartedAt: now,
        version: { increment: 1 },
      },
    });
    return claimed.count === 1 ? this.getRefundRequest(requestId) : null;
  }

  getExecutionWorkItem(requestId: string): Promise<ExecutionWorkItem | null> {
    return this.tx.refundRequest.findFirst({
      where: { id: requestId, tenantId: this.tenantId },
      include: { installation: true, tenant: true, execution: true },
    });
  }

  async lockExecutionAuthorization(requestId: string, installationId: string): Promise<boolean> {
    // Keep the lock order aligned with webhook deauthorization:
    // installation -> tenant -> request.
    const installation = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM stripe_installations
      WHERE id = ${installationId}::UUID
        AND tenant_id = ${this.tenantId}::UUID
      FOR UPDATE
    `;
    if (installation.length !== 1) {
      return false;
    }
    const tenant = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM tenants
      WHERE id = ${this.tenantId}::UUID
      FOR UPDATE
    `;
    if (tenant.length !== 1) {
      return false;
    }
    const request = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM refund_requests
      WHERE id = ${requestId}::UUID
        AND tenant_id = ${this.tenantId}::UUID
        AND installation_id = ${installationId}::UUID
      FOR UPDATE
    `;
    return request.length === 1;
  }

  async claimExecutionWorkItem(requestId: string, now: Date): Promise<ExecutionWorkItem | null> {
    const claimed = await this.claimExecution(requestId, now);
    return claimed === null ? null : this.getExecutionWorkItem(requestId);
  }

  async resumeExecutionAfterAbsence(requestId: string, now: Date): Promise<RefundRequest | null> {
    const resumed = await this.tx.refundRequest.updateMany({
      where: {
        id: requestId,
        tenantId: this.tenantId,
        workflowStatus: "reconciliation_required",
        effectState: "absence_proven",
      },
      data: {
        workflowStatus: "executing",
        executionStartedAt: now,
        version: { increment: 1 },
      },
    });
    return resumed.count === 1 ? this.getRefundRequest(requestId) : null;
  }

  async markEffectPossible(requestId: string): Promise<boolean> {
    const result = await this.tx.refundRequest.updateMany({
      where: {
        id: requestId,
        tenantId: this.tenantId,
        workflowStatus: "executing",
        effectState: { in: ["not_started", "absence_proven"] },
      },
      data: {
        effectState: "possible",
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  async markReconciliationRequired(requestId: string): Promise<boolean> {
    const result = await this.tx.refundRequest.updateMany({
      where: {
        id: requestId,
        tenantId: this.tenantId,
        workflowStatus: "executing",
        paymentGuardReleasedAt: null,
      },
      data: {
        workflowStatus: "reconciliation_required",
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  async markAbsenceProven(requestId: string): Promise<boolean> {
    const result = await this.tx.refundRequest.updateMany({
      where: {
        id: requestId,
        tenantId: this.tenantId,
        workflowStatus: "reconciliation_required",
        effectState: "possible",
      },
      data: {
        effectState: "absence_proven",
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  async markCertainAbsenceWhileExecuting(requestId: string): Promise<boolean> {
    const result = await this.tx.refundRequest.updateMany({
      where: {
        id: requestId,
        tenantId: this.tenantId,
        workflowStatus: "executing",
        effectState: "possible",
      },
      data: {
        effectState: "absence_proven",
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  ensureExecution(input: EnsureExecutionInput): Promise<RefundExecution> {
    return this.tx.refundExecution.upsert({
      where: {
        requestId_tenantId: {
          requestId: input.requestId,
          tenantId: this.tenantId,
        },
      },
      create: {
        tenantId: this.tenantId,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        canonicalParametersHash: Uint8Array.from(input.canonicalParametersHash),
        amountMinor: input.amountMinor,
        currency: input.currency,
      },
      update: {},
    });
  }

  beginExecutionAttempt(
    executionId: string,
    attemptNumber: number,
    startedAt: Date,
  ): Promise<RefundExecutionAttempt> {
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
      throw new RangeError("Execution attempt number must be positive");
    }
    return this.tx.refundExecutionAttempt.create({
      data: {
        tenantId: this.tenantId,
        executionId,
        attemptNumber,
        state: "started",
        startedAt,
      },
    });
  }

  async finishExecutionAttempt(input: FinishExecutionAttemptInput): Promise<boolean> {
    const result = await this.tx.refundExecutionAttempt.updateMany({
      where: {
        id: input.attemptId,
        tenantId: this.tenantId,
        state: "started",
      },
      data: {
        state: input.state,
        ...(input.normalizedErrorCode === undefined
          ? {}
          : { normalizedErrorCode: input.normalizedErrorCode }),
        ...(input.stripeRequestId === undefined ? {} : { stripeRequestId: input.stripeRequestId }),
        finishedAt: input.finishedAt,
      },
    });
    return result.count === 1;
  }

  async markRefundIdentified(input: IdentifiedRefundInput): Promise<boolean> {
    const locked = await this.tx.$queryRaw<readonly LockedRefundObservation[]>`
      SELECT
        request.id,
        request.workflow_status,
        request.effect_state,
        execution.id AS execution_id,
        execution.stripe_refund_id,
        execution.stripe_refund_status,
        execution.last_stripe_event_created_at
      FROM refund_requests AS request
      INNER JOIN refund_executions AS execution
        ON execution.request_id = request.id
       AND execution.tenant_id = request.tenant_id
      WHERE request.id = ${input.requestId}::UUID
        AND request.tenant_id = ${this.tenantId}::UUID
      FOR UPDATE OF request, execution
    `;
    if (locked.length !== 1) {
      return false;
    }
    const lockedRequest = locked[0];
    if (
      lockedRequest === undefined ||
      (lockedRequest.stripe_refund_id !== null &&
        lockedRequest.stripe_refund_id !== input.stripeRefundId)
    ) {
      return false;
    }
    if (!shouldApplyRefundObservation(lockedRequest, input)) {
      return true;
    }

    const execution = await this.tx.refundExecution.updateMany({
      where: {
        id: lockedRequest.execution_id,
        tenantId: this.tenantId,
        requestId: input.requestId,
        stripeRefundId: lockedRequest.stripe_refund_id,
        stripeRefundStatus: lockedRequest.stripe_refund_status,
        lastStripeEventCreatedAt: lockedRequest.last_stripe_event_created_at,
      },
      data: {
        stripeRefundId: input.stripeRefundId,
        stripeRefundStatus: input.stripeRefundStatus,
        ...(input.stripeRequestId === undefined
          ? {}
          : { lastStripeRequestId: input.stripeRequestId }),
        ...(input.stripeEventId === undefined ? {} : { lastStripeEventId: input.stripeEventId }),
        ...(input.stripeEventCreatedAt === undefined
          ? {}
          : { lastStripeEventCreatedAt: input.stripeEventCreatedAt }),
        reconciledAt: input.observedAt,
      },
    });
    if (execution.count !== 1) {
      return false;
    }

    if (
      lockedRequest.workflow_status === "succeeded" &&
      lockedRequest.stripe_refund_status === "succeeded" &&
      input.stripeRefundStatus === "failed"
    ) {
      const corrected = await this.tx.refundRequest.updateMany({
        where: {
          id: input.requestId,
          tenantId: this.tenantId,
          workflowStatus: "succeeded",
          effectState: "identified",
        },
        data: {
          effectState: "absence_proven",
          workflowStatus: "failed_terminal",
          version: { increment: 1 },
        },
      });
      return corrected.count === 1;
    }

    if (
      lockedRequest.workflow_status !== "executing" &&
      lockedRequest.workflow_status !== "reconciliation_required"
    ) {
      return true;
    }

    if (
      lockedRequest.workflow_status === "reconciliation_required" &&
      input.reconciliationResolution === "preserve"
    ) {
      if (
        lockedRequest.effect_state === "not_started" ||
        lockedRequest.effect_state === "absence_proven"
      ) {
        const possible = await this.tx.refundRequest.updateMany({
          where: {
            id: input.requestId,
            tenantId: this.tenantId,
            workflowStatus: "reconciliation_required",
            effectState: lockedRequest.effect_state,
            paymentGuardReleasedAt: null,
          },
          data: {
            effectState: "possible",
            version: { increment: 1 },
          },
        });
        if (possible.count !== 1) {
          return false;
        }
      }
      const protectedReconciliation = await this.tx.refundRequest.updateMany({
        where: {
          id: input.requestId,
          tenantId: this.tenantId,
          workflowStatus: "reconciliation_required",
          effectState: { in: ["possible", "identified"] },
          paymentGuardReleasedAt: null,
        },
        data: {
          effectState: "identified",
          version: { increment: 1 },
        },
      });
      return protectedReconciliation.count === 1;
    }

    if (input.stripeRefundStatus === null) {
      const uncertain = await this.tx.refundRequest.updateMany({
        where: {
          id: input.requestId,
          tenantId: this.tenantId,
          workflowStatus: { in: ["executing", "reconciliation_required"] },
          effectState: { in: ["possible", "identified"] },
        },
        data: {
          effectState: "identified",
          workflowStatus: "reconciliation_required",
          version: { increment: 1 },
        },
      });
      return uncertain.count === 1;
    }

    if (input.stripeRefundStatus === "pending" || input.stripeRefundStatus === "requires_action") {
      const request = await this.tx.refundRequest.updateMany({
        where: {
          id: input.requestId,
          tenantId: this.tenantId,
          workflowStatus: { in: ["executing", "reconciliation_required"] },
          effectState: { in: ["possible", "identified"] },
        },
        data: {
          effectState: "identified",
          version: { increment: 1 },
        },
      });
      return request.count === 1;
    }

    if (input.stripeRefundStatus === "succeeded") {
      const request = await this.tx.refundRequest.updateMany({
        where: {
          id: input.requestId,
          tenantId: this.tenantId,
          workflowStatus: { in: ["executing", "reconciliation_required"] },
          effectState: { in: ["possible", "identified"] },
        },
        data: {
          effectState: "identified",
          workflowStatus: "succeeded",
          terminalAt: input.observedAt,
          paymentGuardReleasedAt: input.observedAt,
          version: { increment: 1 },
        },
      });
      return request.count === 1;
    }

    const failed = await this.tx.refundRequest.updateMany({
      where: {
        id: input.requestId,
        tenantId: this.tenantId,
        workflowStatus: { in: ["executing", "reconciliation_required"] },
        effectState: { in: ["possible", "identified"] },
      },
      data: {
        effectState: "absence_proven",
        workflowStatus: "failed_terminal",
        terminalAt: input.observedAt,
        paymentGuardReleasedAt: input.observedAt,
        version: { increment: 1 },
      },
    });
    return failed.count === 1;
  }

  async recordRefundCorrelationCandidate(
    input: RefundCorrelationCandidateInput,
  ): Promise<RefundCorrelationCandidateResult> {
    const locked = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM refund_requests
      WHERE id = ${input.requestId}::UUID
        AND tenant_id = ${this.tenantId}::UUID
      FOR UPDATE
    `;
    if (locked.length !== 1) {
      throw new Error("REFUND_CANDIDATE_REQUEST_NOT_FOUND");
    }

    const candidate = await this.tx.refundCorrelationCandidate.upsert({
      where: {
        requestId_stripeRefundId: {
          requestId: input.requestId,
          stripeRefundId: input.stripeRefundId,
        },
      },
      create: {
        tenantId: this.tenantId,
        requestId: input.requestId,
        installationId: input.installationId,
        stripeRefundId: input.stripeRefundId,
        paymentKey: input.paymentKey,
        paymentIntentId: input.paymentIntentId,
        chargeId: input.chargeId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        stripeRefundStatus: input.stripeRefundStatus,
        stripeCreatedAt: input.stripeCreatedAt,
        stripeStateObservedAt:
          input.stripeEventCreatedAt ?? input.scanWindowEnd ?? input.observedAt,
        stripeEventId: input.stripeEventId,
        stripeEventCreatedAt: input.stripeEventCreatedAt,
        eventIdempotencyCorrelation: input.eventIdempotencyCorrelation,
        lastSeenScanWindowEnd: input.scanWindowEnd,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
      },
      update: {},
    });
    if (
      candidate.tenantId !== this.tenantId ||
      candidate.installationId !== input.installationId ||
      candidate.paymentKey !== input.paymentKey ||
      candidate.paymentIntentId !== input.paymentIntentId ||
      candidate.chargeId !== input.chargeId ||
      candidate.amountMinor !== input.amountMinor ||
      candidate.currency !== input.currency ||
      candidate.stripeCreatedAt.getTime() !== input.stripeCreatedAt.getTime()
    ) {
      throw new Error("REFUND_CANDIDATE_TUPLE_CONFLICT");
    }

    const eventIdempotencyCorrelation =
      candidate.eventIdempotencyCorrelation === "exact" ||
      input.eventIdempotencyCorrelation === "exact"
        ? "exact"
        : candidate.eventIdempotencyCorrelation === "mismatch" ||
            input.eventIdempotencyCorrelation === "mismatch"
          ? "mismatch"
          : "absent";
    const lastSeenScanWindowEnd =
      input.scanWindowEnd === null
        ? candidate.lastSeenScanWindowEnd
        : candidate.lastSeenScanWindowEnd === null ||
            input.scanWindowEnd.getTime() > candidate.lastSeenScanWindowEnd.getTime()
          ? input.scanWindowEnd
          : candidate.lastSeenScanWindowEnd;
    const stripeStateObservedAt =
      input.stripeEventCreatedAt ?? input.scanWindowEnd ?? input.observedAt;
    const hasNewerStripeState =
      stripeStateObservedAt.getTime() >= candidate.stripeStateObservedAt.getTime();
    const preserveExactEvent =
      candidate.eventIdempotencyCorrelation === "exact" &&
      input.eventIdempotencyCorrelation !== "exact";
    const replaceEvent =
      input.stripeEventId !== null &&
      !preserveExactEvent &&
      (input.eventIdempotencyCorrelation === "exact" ||
        candidate.stripeEventCreatedAt === null ||
        (input.stripeEventCreatedAt !== null &&
          input.stripeEventCreatedAt.getTime() >= candidate.stripeEventCreatedAt.getTime()));
    const updated = await this.tx.refundCorrelationCandidate.update({
      where: { id: candidate.id },
      data: {
        stripeRefundStatus: hasNewerStripeState
          ? input.stripeRefundStatus
          : candidate.stripeRefundStatus,
        stripeStateObservedAt: hasNewerStripeState
          ? stripeStateObservedAt
          : candidate.stripeStateObservedAt,
        stripeEventId: replaceEvent ? input.stripeEventId : candidate.stripeEventId,
        stripeEventCreatedAt: replaceEvent
          ? input.stripeEventCreatedAt
          : candidate.stripeEventCreatedAt,
        eventIdempotencyCorrelation,
        lastSeenScanWindowEnd,
        lastObservedAt:
          input.observedAt.getTime() > candidate.lastObservedAt.getTime()
            ? input.observedAt
            : candidate.lastObservedAt,
      },
    });
    const candidateCount = await this.tx.refundCorrelationCandidate.count({
      where: { tenantId: this.tenantId, requestId: input.requestId },
    });
    if (candidateCount > 1) {
      await this.tx.refundCorrelationCandidate.updateMany({
        where: {
          tenantId: this.tenantId,
          requestId: input.requestId,
          state: "pending",
        },
        data: { state: "conflict", resolvedAt: null },
      });
      return { candidateCount, state: "conflict" };
    }
    return { candidateCount, state: updated.state };
  }

  async markRefundCorrelationCandidateLinked(
    requestId: string,
    stripeRefundId: string,
    state: "exact_linked" | "unique_linked",
    resolvedAt: Date,
  ): Promise<boolean> {
    const linked = await this.tx.refundCorrelationCandidate.updateMany({
      where: {
        tenantId: this.tenantId,
        requestId,
        stripeRefundId,
        state: { in: ["pending", "conflict", state] },
      },
      data: { state, resolvedAt },
    });
    return linked.count === 1;
  }

  listRefundCorrelationCandidates(requestId: string) {
    return this.tx.refundCorrelationCandidate.findMany({
      where: { tenantId: this.tenantId, requestId },
      orderBy: [{ stripeCreatedAt: "asc" }, { stripeRefundId: "asc" }],
    });
  }

  async resolveUniqueRefundCandidates(
    installationId: string,
    completedScanWindowStart: Date,
    completedScanWindowEnd: Date,
    resolvedAt: Date,
  ): Promise<{ readonly resolved: number; readonly conflicts: number }> {
    const seen = await this.tx.refundCorrelationCandidate.findMany({
      where: {
        tenantId: this.tenantId,
        installationId,
        lastSeenScanWindowEnd: completedScanWindowEnd,
      },
      distinct: ["requestId"],
      select: { requestId: true },
    });
    const coveredAmbiguities = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM refund_requests
      WHERE tenant_id = ${this.tenantId}::UUID
        AND installation_id = ${installationId}::UUID
        AND workflow_status = 'reconciliation_required'
        AND effect_state = 'possible'
        AND payment_guard_released_at IS NULL
        AND execution_started_at >= ${completedScanWindowStart.toISOString()}::TIMESTAMPTZ
        AND reconciliation_safe_after_at IS NOT NULL
        AND reconciliation_safe_after_at >= execution_started_at
        AND reconciliation_safe_after_at <= ${completedScanWindowEnd.toISOString()}::TIMESTAMPTZ
      ORDER BY id
    `;
    const requestIds = [
      ...new Set([
        ...seen.map(({ requestId }) => requestId),
        ...coveredAmbiguities.map(({ id }) => id),
      ]),
    ].sort();
    let resolved = 0;
    let conflicts = 0;
    for (const requestId of requestIds) {
      await this.tx.$queryRaw`
        SELECT id
        FROM refund_requests
        WHERE id = ${requestId}::UUID
          AND tenant_id = ${this.tenantId}::UUID
        FOR UPDATE
      `;
      const candidates = await this.tx.refundCorrelationCandidate.findMany({
        where: { tenantId: this.tenantId, requestId },
        orderBy: [{ stripeCreatedAt: "asc" }, { stripeRefundId: "asc" }],
      });
      const request = await this.getRefundRequestDetail(requestId);
      if (request === null || request.execution === null) {
        continue;
      }
      if (request.execution.stripeRefundId !== null) {
        continue;
      }
      const scanCoversExecution =
        request.executionStartedAt !== null &&
        request.reconciliationSafeAfterAt !== null &&
        request.executionStartedAt.getTime() >= completedScanWindowStart.getTime() &&
        request.reconciliationSafeAfterAt.getTime() >= request.executionStartedAt.getTime() &&
        request.reconciliationSafeAfterAt.getTime() <= completedScanWindowEnd.getTime();
      if (!scanCoversExecution) {
        continue;
      }
      const unresolvedExternalConflict = await this.tx.externalRefundAlert.findFirst({
        where: {
          tenantId: this.tenantId,
          installationId,
          environment: request.environment,
          paymentKey: request.paymentKey,
          classification: { in: ["external", "tampered", "proof_replay"] },
          reconciledAt: null,
        },
        select: { id: true },
      });
      if (candidates.length === 0) {
        if (unresolvedExternalConflict !== null) {
          conflicts += 1;
          await this.markReconciliationRequired(requestId);
          continue;
        }
        const absenceProven = await this.markAbsenceProven(requestId);
        if (!absenceProven) {
          throw new Error("REFUND_ABSENCE_COMPARE_AND_SET_FAILED");
        }
        const resumed = await this.resumeExecutionAfterAbsence(requestId, resolvedAt);
        if (resumed === null) {
          throw new Error("REFUND_ABSENCE_RESUME_COMPARE_AND_SET_FAILED");
        }
        resolved += 1;
        continue;
      }
      const candidate = candidates[0];
      const decision = decideRefundCandidate({
        linkedRefundId: null,
        candidateRefundId: candidate?.stripeRefundId ?? "re_missing",
        eventIdempotencyEvidence: candidate?.eventIdempotencyCorrelation ?? "absent",
        candidateCount: Math.max(1, candidates.length),
        completeScan: true,
        scanCoversExecution,
      });
      if (decision === "conflict") {
        conflicts += 1;
        await this.tx.refundCorrelationCandidate.updateMany({
          where: { tenantId: this.tenantId, requestId, state: "pending" },
          data: { state: "conflict", resolvedAt: null },
        });
        await this.markReconciliationRequired(requestId);
        continue;
      }
      if (
        decision !== "link_unique" ||
        candidate === undefined ||
        candidate.lastSeenScanWindowEnd === null ||
        candidate.state === "conflict"
      ) {
        await this.markReconciliationRequired(requestId);
        continue;
      }
      const identified = await this.markRefundIdentified({
        requestId,
        stripeRefundId: candidate.stripeRefundId,
        stripeRefundStatus: candidate.stripeRefundStatus,
        reconciliationResolution: unresolvedExternalConflict === null ? "resolve" : "preserve",
        ...(candidate.stripeEventId === null
          ? {}
          : {
              stripeEventId: candidate.stripeEventId,
              stripeEventCreatedAt: candidate.stripeEventCreatedAt ?? candidate.stripeCreatedAt,
            }),
        observedAt: resolvedAt,
      });
      if (!identified) {
        throw new Error("UNIQUE_REFUND_CANDIDATE_COMPARE_AND_SET_FAILED");
      }
      await this.markRefundCorrelationCandidateLinked(
        requestId,
        candidate.stripeRefundId,
        "unique_linked",
        resolvedAt,
      );
      if (unresolvedExternalConflict === null) {
        resolved += 1;
      } else {
        conflicts += 1;
      }
    }
    return { resolved, conflicts };
  }

  async markTerminalFailureAfterAbsence(requestId: string, now: Date): Promise<boolean> {
    const result = await this.tx.refundRequest.updateMany({
      where: {
        id: requestId,
        tenantId: this.tenantId,
        workflowStatus: "executing",
        effectState: { in: ["not_started", "absence_proven"] },
      },
      data: {
        effectState: "absence_proven",
        workflowStatus: "failed_terminal",
        terminalAt: now,
        paymentGuardReleasedAt: now,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  async expirePendingRequests(now: Date, limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Expiry batch limit must be between 1 and 1000");
    }
    const candidates = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM refund_requests
      WHERE tenant_id = ${this.tenantId}::UUID
        AND workflow_status = 'pending_approval'
        AND effect_state = 'not_started'
        AND expires_at <= ${now}
      ORDER BY expires_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (candidates.length === 0) {
      return 0;
    }
    const result = await this.tx.refundRequest.updateMany({
      where: {
        tenantId: this.tenantId,
        id: { in: candidates.map((candidate) => candidate.id) },
        workflowStatus: "pending_approval",
        effectState: "not_started",
      },
      data: {
        workflowStatus: "expired",
        terminalAt: now,
        paymentGuardReleasedAt: now,
        version: { increment: 1 },
      },
    });
    return result.count;
  }

  appendAuditEvent(
    data: Omit<Prisma.AuditEventUncheckedCreateInput, "tenantId">,
  ): Promise<AuditEvent> {
    return this.tx.auditEvent.create({
      data: { ...data, tenantId: this.tenantId },
    });
  }

  listAuditEvents(input: AuditListInput = {}): Promise<readonly AuditEvent[]> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Audit page size must be between 1 and 1000");
    }
    const occurredAt: Prisma.DateTimeFilter | undefined =
      input.occurredFrom === undefined && input.occurredTo === undefined
        ? undefined
        : {
            ...(input.occurredFrom === undefined ? {} : { gte: input.occurredFrom }),
            ...(input.occurredTo === undefined ? {} : { lte: input.occurredTo }),
          };
    return this.tx.auditEvent.findMany({
      where: {
        tenantId: this.tenantId,
        ...(occurredAt === undefined ? {} : { occurredAt }),
      },
      ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
      take: limit,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    });
  }

  findMutationReceipt(requestNonce: string): Promise<ApiMutationReceipt | null> {
    return this.tx.apiMutationReceipt.findUnique({
      where: {
        tenantId_requestNonce: {
          tenantId: this.tenantId,
          requestNonce,
        },
      },
    });
  }

  createMutationReceipt(
    data: Omit<Prisma.ApiMutationReceiptUncheckedCreateInput, "tenantId">,
  ): Promise<ApiMutationReceipt> {
    return this.tx.apiMutationReceipt.create({
      data: { ...data, tenantId: this.tenantId },
    });
  }

  async insertWebhookReceipt(data: WebhookReceiptInsertInput): Promise<WebhookReceiptInsertResult> {
    const endpoint = connectedWebhookEndpointSchema.parse(data.endpoint);
    const normalizedPayload = assertNormalizedWebhookRowConsistency({
      endpoint,
      eventType: data.eventType,
      objectId: data.objectId,
      stripeCreatedAt: data.stripeCreatedAt,
      normalizedPayload: data.normalizedPayload,
    });
    const inserted = await this.tx.webhookReceipt.createMany({
      data: [
        {
          tenantId: this.tenantId,
          installationId: data.installationId,
          endpoint,
          stripeEventId: data.stripeEventId,
          stripeAccountId: data.stripeAccountId,
          eventType: data.eventType,
          objectId: data.objectId,
          normalizedPayload,
          stripeCreatedAt: data.stripeCreatedAt,
          ...(data.receivedAt === undefined ? {} : { receivedAt: data.receivedAt }),
        },
      ],
      skipDuplicates: true,
    });
    const receipt = await this.tx.webhookReceipt.findUnique({
      where: {
        endpoint_stripeEventId: {
          endpoint: data.endpoint,
          stripeEventId: data.stripeEventId,
        },
      },
    });
    if (receipt === null) {
      throw new Error("Webhook receipt could not be read after insertion");
    }
    return { receipt, inserted: inserted.count === 1 };
  }

  getWebhookReceipt(receiptId: string): Promise<WebhookReceipt | null> {
    return this.tx.webhookReceipt.findFirst({
      where: { id: receiptId, tenantId: this.tenantId },
    });
  }

  async markWebhookReceiptFailed(receiptId: string, errorCode: string): Promise<boolean> {
    const updated = await this.tx.webhookReceipt.updateMany({
      where: {
        id: receiptId,
        tenantId: this.tenantId,
        status: { in: ["received", "processing", "failed"] },
      },
      data: {
        status: "failed",
        processingAttempts: { increment: 1 },
        processedAt: null,
        lastErrorCode: errorCode.slice(0, 64),
      },
    });
    return updated.count === 1;
  }

  listExternalRefundAlerts(input: AlertListInput = {}): Promise<readonly ExternalRefundAlert[]> {
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Alert page size must be between 1 and 100");
    }
    return this.tx.externalRefundAlert.findMany({
      where: {
        tenantId: this.tenantId,
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
      take: limit,
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
    });
  }

  async observeExternalRefund(input: ExternalRefundObservationInput): Promise<{
    readonly alert: ExternalRefundAlert;
    readonly requestTransition: "none" | "stale" | "failed_terminal" | "reconciliation_required";
  }> {
    if (
      Number.isNaN(input.stripeRefundCreatedAt.getTime()) ||
      Number.isNaN(input.observedAt.getTime()) ||
      input.stripeRefundCreatedAt.getTime() > input.observedAt.getTime()
    ) {
      throw new RangeError("External refund creation time must not exceed observation time");
    }

    const installation = await this.tx.stripeInstallation.findFirst({
      where: {
        id: input.installationId,
        tenantId: this.tenantId,
        environment: { in: ["test", "sandbox"] },
      },
      select: { environment: true },
    });
    if (installation === null || installation.environment === "live") {
      throw new Error("EXTERNAL_REFUND_INSTALLATION_NOT_FOUND");
    }
    const environment = installation.environment;
    const paymentLocks = await this.tx.$queryRaw<readonly { locked: boolean }[]>`
      SELECT (
        refunddesk_lock_payment_scope(
          ${this.tenantId}::UUID,
          ${input.installationId}::UUID,
          ${environment}::stripe_environment,
          ${input.paymentKey}::VARCHAR
        ) IS NULL
      ) AS locked
    `;
    if (paymentLocks.length !== 1) {
      throw new Error("EXTERNAL_REFUND_PAYMENT_LOCK_FAILED");
    }
    const lockedRequests = await this.tx.$queryRaw<readonly ExternalPaymentLockedRequest[]>`
      SELECT
        id,
        workflow_status,
        effect_state,
        payment_guard_released_at,
        execution_started_at,
        terminal_at
      FROM refund_requests
      WHERE tenant_id = ${this.tenantId}::UUID
        AND installation_id = ${input.installationId}::UUID
        AND environment = ${environment}::stripe_environment
        AND payment_key = ${input.paymentKey}
      ORDER BY execution_started_at DESC NULLS LAST, id
      FOR UPDATE
    `;
    const overlappedRequests = await this.tx.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM refund_requests
      WHERE tenant_id = ${this.tenantId}::UUID
        AND installation_id = ${input.installationId}::UUID
        AND environment = ${environment}::stripe_environment
        AND payment_key = ${input.paymentKey}
        AND workflow_status IN ('succeeded', 'failed_terminal')
        AND execution_started_at <= ${input.stripeRefundCreatedAt.toISOString()}::TIMESTAMPTZ
        AND ${input.stripeRefundCreatedAt.toISOString()}::TIMESTAMPTZ <= terminal_at
      ORDER BY execution_started_at DESC, id
      LIMIT 1
    `;
    const overlappedRequestId = overlappedRequests[0]?.id ?? null;

    // Keep this INSERT explicit. The runtime roles intentionally have
    // column-scoped INSERT grants so callers cannot choose protected lifecycle
    // fields such as status, acknowledged_at, or reconciled_at. Prisma's
    // createMany includes database-defaulted columns in its generated INSERT,
    // which requires privileges outside that allowlist on PostgreSQL.
    await this.tx.$executeRaw`
      INSERT INTO "external_refund_alerts" (
        "tenant_id",
        "installation_id",
        "environment",
        "stripe_refund_id",
        "stripe_refund_created_at",
        "payment_key",
        "amount_minor",
        "currency",
        "classification",
        "detected_at",
        "overlapped_request_id"
      )
      VALUES (
        ${this.tenantId}::UUID,
        ${input.installationId}::UUID,
        ${environment}::"stripe_environment",
        ${input.stripeRefundId},
        ${input.stripeRefundCreatedAt.toISOString()}::TIMESTAMPTZ,
        ${input.paymentKey},
        ${input.amountMinor},
        ${input.currency},
        ${input.classification},
        ${input.observedAt.toISOString()}::TIMESTAMPTZ,
        ${overlappedRequestId}::UUID
      )
      ON CONFLICT ("installation_id", "stripe_refund_id") DO NOTHING
    `;
    const alert = await this.tx.externalRefundAlert.findUnique({
      where: {
        installationId_stripeRefundId: {
          installationId: input.installationId,
          stripeRefundId: input.stripeRefundId,
        },
      },
    });
    if (
      alert === null ||
      alert.tenantId !== this.tenantId ||
      alert.installationId !== input.installationId ||
      alert.environment !== environment ||
      alert.stripeRefundId !== input.stripeRefundId ||
      alert.stripeRefundCreatedAt.getTime() !== input.stripeRefundCreatedAt.getTime() ||
      alert.paymentKey !== input.paymentKey ||
      alert.amountMinor !== input.amountMinor ||
      alert.currency !== input.currency ||
      alert.classification !== input.classification ||
      (alert.overlappedRequestId !== null && alert.overlappedRequestId !== overlappedRequestId) ||
      alert.reconciledAt !== null
    ) {
      throw new Error("EXTERNAL_REFUND_ALERT_CONFLICT");
    }

    const expectedStale = lockedRequests.filter(
      (request) =>
        (request.workflow_status === "pending_approval" ||
          request.workflow_status === "approved") &&
        request.effect_state === "not_started" &&
        request.payment_guard_released_at === null,
    ).length;
    const stale = await this.tx.refundRequest.updateMany({
      where: {
        tenantId: this.tenantId,
        installationId: input.installationId,
        environment,
        paymentKey: input.paymentKey,
        workflowStatus: { in: ["pending_approval", "approved"] },
        effectState: "not_started",
        paymentGuardReleasedAt: null,
      },
      data: {
        effectState: "absence_proven",
        workflowStatus: "stale",
        terminalAt: input.observedAt,
        paymentGuardReleasedAt: input.observedAt,
        version: { increment: 1 },
      },
    });

    const expectedTerminal = lockedRequests.filter(
      (request) =>
        request.workflow_status === "executing" &&
        (request.effect_state === "not_started" || request.effect_state === "absence_proven") &&
        request.payment_guard_released_at === null,
    ).length;
    const terminal = await this.tx.refundRequest.updateMany({
      where: {
        tenantId: this.tenantId,
        installationId: input.installationId,
        environment,
        paymentKey: input.paymentKey,
        workflowStatus: "executing",
        effectState: { in: ["not_started", "absence_proven"] },
        paymentGuardReleasedAt: null,
      },
      data: {
        effectState: "absence_proven",
        workflowStatus: "failed_terminal",
        terminalAt: input.observedAt,
        paymentGuardReleasedAt: input.observedAt,
        version: { increment: 1 },
      },
    });

    const expectedReconciliation = lockedRequests.filter(
      (request) =>
        request.workflow_status === "executing" &&
        (request.effect_state === "possible" || request.effect_state === "identified") &&
        request.payment_guard_released_at === null,
    ).length;
    const reconciliation = await this.tx.refundRequest.updateMany({
      where: {
        tenantId: this.tenantId,
        installationId: input.installationId,
        environment,
        paymentKey: input.paymentKey,
        workflowStatus: "executing",
        effectState: { in: ["possible", "identified"] },
        paymentGuardReleasedAt: null,
      },
      data: {
        workflowStatus: "reconciliation_required",
        version: { increment: 1 },
      },
    });
    if (
      stale.count !== expectedStale ||
      terminal.count !== expectedTerminal ||
      reconciliation.count !== expectedReconciliation
    ) {
      throw new Error("EXTERNAL_REFUND_REQUEST_COMPARE_AND_SET_FAILED");
    }
    return {
      alert,
      requestTransition:
        reconciliation.count > 0
          ? "reconciliation_required"
          : terminal.count > 0
            ? "failed_terminal"
            : stale.count > 0
              ? "stale"
              : "none",
    };
  }

  async markWebhookReceiptProcessed(receiptId: string, processedAt: Date): Promise<boolean> {
    const updated = await this.tx.webhookReceipt.updateMany({
      where: {
        id: receiptId,
        tenantId: this.tenantId,
        status: { in: ["received", "processing", "failed"] },
      },
      data: {
        status: "processed",
        processedAt,
        lastErrorCode: null,
      },
    });
    return updated.count === 1;
  }

  async acknowledgeExternalRefundAlert(
    alertId: string,
    acknowledgedByUserId: string,
    acknowledgedAt: Date,
  ): Promise<ExternalRefundAlert | null> {
    const updated = await this.tx.externalRefundAlert.updateMany({
      where: {
        id: alertId,
        tenantId: this.tenantId,
        status: "open",
      },
      data: {
        status: "acknowledged",
        acknowledgedAt,
        acknowledgedByUserId,
      },
    });
    return updated.count === 1
      ? this.tx.externalRefundAlert.findFirst({
          where: { id: alertId, tenantId: this.tenantId },
        })
      : null;
  }

  listExecutionWork(limit = 100): Promise<readonly ExecutionWorkItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Execution work limit must be between 1 and 1000");
    }
    return this.tx.refundRequest.findMany({
      where: {
        tenantId: this.tenantId,
        workflowStatus: { in: ["approved", "executing", "reconciliation_required"] },
      },
      take: limit,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { installation: true, tenant: true, execution: true },
    });
  }

  listApprovedExecutionWork(limit = 100): Promise<readonly ExecutionWorkItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Approved execution work limit must be between 1 and 1000");
    }
    return this.tx.refundRequest.findMany({
      where: {
        tenantId: this.tenantId,
        environment: { in: ["test", "sandbox"] },
        workflowStatus: "approved",
        effectState: "not_started",
        paymentGuardReleasedAt: null,
      },
      take: limit,
      orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
      include: { installation: true, tenant: true, execution: true },
    });
  }

  async prepareExecutionRecoveryWork(limit = 100): Promise<readonly ExecutionWorkItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Execution recovery limit must be between 1 and 1000");
    }
    const candidates = await this.tx.refundRequest.findMany({
      where: {
        tenantId: this.tenantId,
        environment: { in: ["test", "sandbox"] },
        paymentGuardReleasedAt: null,
        tenant: {
          status: "active",
          liveEnabled: false,
        },
        installation: {
          status: "active",
          environment: { in: ["test", "sandbox"] },
        },
        OR: [
          {
            workflowStatus: "approved",
            effectState: "not_started",
          },
          {
            workflowStatus: "executing",
            effectState: { in: ["not_started", "possible", "absence_proven"] },
          },
        ],
      },
      take: limit,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const recoverableRequests: typeof candidates = [];
    for (const candidate of candidates) {
      if (candidate.workflowStatus === "executing" && candidate.effectState === "possible") {
        // A persisted effect boundary may already have reached Stripe. A lost or
        // exhausted job must therefore be reconciled before it can be retried.
        await this.markReconciliationRequired(candidate.id);
        continue;
      }
      recoverableRequests.push(candidate);
    }
    if (recoverableRequests.length === 0) {
      return [];
    }

    // Prisma's relation include plan fans out sibling reads. With an
    // interactive adapter-pg transaction, that sends overlapping query() calls
    // through one pg Client. Load the same relations in explicit sequence.
    const tenant = await this.tx.tenant.findFirst({
      where: { id: this.tenantId },
    });
    const installationIds = [
      ...new Set(recoverableRequests.map((request) => request.installationId)),
    ];
    const installations = await this.tx.stripeInstallation.findMany({
      where: {
        tenantId: this.tenantId,
        id: { in: installationIds },
      },
    });
    const executions = await this.tx.refundExecution.findMany({
      where: {
        tenantId: this.tenantId,
        requestId: { in: recoverableRequests.map((request) => request.id) },
      },
    });
    if (tenant === null) {
      throw new Error("EXECUTION_RECOVERY_TENANT_NOT_FOUND");
    }
    const installationById = new Map(
      installations.map((installation) => [installation.id, installation]),
    );
    const executionByRequestId = new Map(
      executions.map((execution) => [execution.requestId, execution]),
    );

    return recoverableRequests.map((request) => {
      const installation = installationById.get(request.installationId);
      if (installation === undefined) {
        throw new Error("EXECUTION_RECOVERY_INSTALLATION_NOT_FOUND");
      }
      return {
        ...request,
        tenant,
        installation,
        execution: executionByRequestId.get(request.id) ?? null,
      };
    });
  }

  async listLinkedRefundReconciliationTargets(
    installationId: string,
    afterRequestId: string | null,
    limit = 100,
  ): Promise<readonly LinkedRefundReconciliationTarget[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Linked Refund reconciliation limit must be between 1 and 1000");
    }
    const requests = await this.tx.refundRequest.findMany({
      where: {
        tenantId: this.tenantId,
        installationId,
        environment: { in: ["test", "sandbox"] },
        workflowStatus: { in: ["executing", "reconciliation_required", "succeeded"] },
        ...(afterRequestId === null ? {} : { id: { gt: afterRequestId } }),
        execution: {
          is: {
            stripeRefundId: { not: null },
            OR: [
              { stripeRefundStatus: null },
              { stripeRefundStatus: { in: ["pending", "requires_action", "succeeded"] } },
            ],
          },
        },
      },
      select: {
        id: true,
        execution: { select: { stripeRefundId: true } },
      },
      take: limit,
      orderBy: { id: "asc" },
    });
    return requests.flatMap((request) =>
      request.execution?.stripeRefundId === null || request.execution === null
        ? []
        : [{ requestId: request.id, refundId: request.execution.stripeRefundId }],
    );
  }

  getReconciliationCheckpoint(installationId: string): Promise<ReconciliationCheckpoint | null> {
    return this.tx.reconciliationCheckpoint.findFirst({
      where: { tenantId: this.tenantId, installationId },
    });
  }

  beginReconciliationWindow(input: BeginCheckpointInput): Promise<ReconciliationCheckpoint> {
    return this.tx.reconciliationCheckpoint.upsert({
      where: { installationId: input.installationId },
      create: {
        tenantId: this.tenantId,
        installationId: input.installationId,
        committedThrough: input.initialCommittedThrough,
        scanWindowEnd: input.scanWindowEnd,
        pageInProgress: true,
      },
      update: {
        scanWindowEnd: input.scanWindowEnd,
        startingAfter: null,
        pageInProgress: true,
      },
    });
  }

  saveReconciliationCursor(
    installationId: string,
    startingAfter: string,
    expectedPreviousCursor: string | null,
  ): Promise<ReconciliationCheckpoint> {
    return this.saveReconciliationCursorCas(installationId, startingAfter, expectedPreviousCursor);
  }

  private async saveReconciliationCursorCas(
    installationId: string,
    startingAfter: string,
    expectedPreviousCursor: string | null,
  ): Promise<ReconciliationCheckpoint> {
    const updated = await this.tx.reconciliationCheckpoint.updateMany({
      where: {
        tenantId: this.tenantId,
        installationId,
        startingAfter: expectedPreviousCursor,
        pageInProgress: true,
        scanWindowEnd: { not: null },
      },
      data: { startingAfter },
    });
    if (updated.count !== 1) {
      throw new Error("Reconciliation cursor compare-and-set failed");
    }
    const checkpoint = await this.getReconciliationCheckpoint(installationId);
    if (checkpoint === null) {
      throw new Error("Reconciliation checkpoint disappeared");
    }
    return checkpoint;
  }

  async completeReconciliationWindow(
    installationId: string,
    expectedScanWindowEnd: Date,
    expectedLastCursor: string | null,
  ): Promise<ReconciliationCheckpoint> {
    const updated = await this.tx.reconciliationCheckpoint.updateMany({
      where: {
        tenantId: this.tenantId,
        installationId,
        scanWindowEnd: expectedScanWindowEnd,
        startingAfter: expectedLastCursor,
        pageInProgress: true,
      },
      data: {
        committedThrough: expectedScanWindowEnd,
        scanWindowEnd: null,
        startingAfter: null,
        pageInProgress: false,
      },
    });
    if (updated.count !== 1) {
      throw new Error("Reconciliation checkpoint completion compare-and-set failed");
    }
    const checkpoint = await this.getReconciliationCheckpoint(installationId);
    if (checkpoint === null) {
      throw new Error("Reconciliation checkpoint disappeared");
    }
    return checkpoint;
  }
}
