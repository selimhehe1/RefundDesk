import { randomUUID, timingSafeEqual } from "node:crypto";

import { isPilotOperation, type CanonicalJsonValue } from "@refunddesk/contracts";
import {
  provisionInstallation,
  resolveInstallation,
  withTenantTransaction,
  Prisma,
  type PrismaClient,
  type RefundRequestDetail,
  type TenantRepositories,
} from "@refunddesk/db";
import type { FieldEncryptionKeyring } from "@refunddesk/domain";

import { createPilotAuditToken } from "./pilot-audit-token";
import { PilotApiError } from "./pilot-errors";
import type {
  PilotActiveRequest,
  PilotExternalAlert,
  PilotMutation,
  PilotMutationMetadata,
  PilotMutationReceipt,
  PilotPage,
  PilotRepository,
  PilotRequestRecord,
  PilotRequestSummary,
  PilotSettings,
  PilotSignedIdentity,
  PilotStoredResponse,
  PilotTenantContext,
} from "./pilot-ports";

const RECEIPT_RETENTION_MILLISECONDS = 365 * 24 * 60 * 60 * 1_000;
const AUDIT_LINK_LIFETIME_MILLISECONDS = 5 * 60 * 1_000;

export interface PilotPrismaRepositoryOptions {
  readonly appBaseUrl: string;
  readonly auditSigningKey: Uint8Array;
  readonly client: PrismaClient;
  readonly fieldKeyring: FieldEncryptionKeyring;
  readonly now?: () => Date;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as Readonly<Record<string, unknown>>;
  return typeof record["code"] === "string" ? record["code"] : errorCode(record["cause"]);
}

function canonicalFromPrisma(value: Prisma.JsonValue): CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PilotApiError("INTERNAL_ERROR", 500, "A stored API response is invalid.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalFromPrisma(item));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (item === undefined) {
        throw new PilotApiError("INTERNAL_ERROR", 500, "A stored API response is invalid.");
      }
      return [key, canonicalFromPrisma(item)];
    }),
  );
}

function isCanonicalArray(value: CanonicalJsonValue): value is readonly CanonicalJsonValue[] {
  return Array.isArray(value);
}

function prismaJson(value: CanonicalJsonValue): Prisma.InputJsonValue | null {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (value === null) {
    return null;
  }
  if (isCanonicalArray(value)) {
    return value.map((item) => prismaJson(item));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prismaJson(item)]));
}

function prismaJsonObject(
  value: Readonly<Record<string, CanonicalJsonValue>>,
): Prisma.InputJsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prismaJson(item)]));
}

function databaseJson(value: Prisma.JsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const converted = prismaJson(canonicalFromPrisma(value));
  return converted === null ? Prisma.JsonNull : converted;
}

function isCanonicalObject(
  value: CanonicalJsonValue,
): value is { readonly [key: string]: CanonicalJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function storedResponse(status: number, body: Prisma.JsonValue): PilotStoredResponse {
  const canonical = canonicalFromPrisma(body);
  if (!isCanonicalObject(canonical)) {
    throw new PilotApiError("INTERNAL_ERROR", 500, "A stored API response is invalid.");
  }
  return { body: canonical, status };
}

function hashesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function receiptFromDatabase(receipt: {
  readonly actorId: string;
  readonly canonicalRequestHash: Uint8Array;
  readonly operation: string;
  readonly responseBody: Prisma.JsonValue;
  readonly responseStatus: number;
}): PilotMutationReceipt {
  if (!isPilotOperation(receipt.operation)) {
    throw new PilotApiError("INTERNAL_ERROR", 500, "A stored mutation receipt is invalid.");
  }
  return {
    actorId: receipt.actorId,
    canonicalRequestHash: receipt.canonicalRequestHash,
    operation: receipt.operation,
    response: storedResponse(receipt.responseStatus, receipt.responseBody),
  };
}

function assertReceiptMatches(
  receipt: PilotMutationReceipt,
  metadata: PilotMutationMetadata,
): void {
  if (
    receipt.actorId !== metadata.actorId ||
    receipt.operation !== metadata.operation ||
    !hashesEqual(receipt.canonicalRequestHash, metadata.canonicalRequestHash)
  ) {
    throw new PilotApiError(
      "IDEMPOTENCY_CONFLICT",
      409,
      "The request nonce was already used for a different mutation.",
    );
  }
}

function response(body: PilotStoredResponse["body"], status = 200): PilotStoredResponse {
  return { body, status };
}

function assertCurrentInstallation(
  installation: Awaited<ReturnType<TenantRepositories["getInstallationContext"]>>,
  context: PilotTenantContext,
): asserts installation is NonNullable<typeof installation> {
  if (
    installation === null ||
    installation.stripeAccountId !== context.stripeAccountId ||
    installation.environment !== context.environment
  ) {
    throw new PilotApiError(
      "ACCOUNT_ENVIRONMENT_MISMATCH",
      403,
      "The installation binding changed during the request.",
    );
  }
  if (installation.status !== "active" || installation.tenant.status !== "active") {
    throw new PilotApiError("INSTALLATION_INACTIVE", 403, "The Stripe installation is not active.");
  }
}

function requestResource(detail: RefundRequestDetail): {
  readonly resourceId: string;
  readonly resourceType: "charge" | "payment_intent";
} {
  if (detail.paymentIntentId !== null) {
    return {
      resourceId: detail.paymentIntentId,
      resourceType: "payment_intent",
    };
  }
  if (detail.chargeId !== null) {
    return { resourceId: detail.chargeId, resourceType: "charge" };
  }
  throw new PilotApiError("INTERNAL_ERROR", 500, "A refund request has no payment resource.");
}

function requestMatchesMutationResource(
  detail: RefundRequestDetail,
  mutation: Extract<
    PilotMutation,
    {
      kind: "refund_request_cancel" | "refund_request_decide";
    }
  >,
): boolean {
  return mutation.resource.type === "charge"
    ? detail.chargeId === mutation.resource.id
    : detail.paymentIntentId === mutation.resource.id;
}

function mapRequest(
  detail: RefundRequestDetail,
  context: PilotTenantContext,
  requesterStripeUserId: string,
  fieldKeyring: FieldEncryptionKeyring,
): PilotRequestRecord {
  if (detail.chargeId === null) {
    throw new PilotApiError("INTERNAL_ERROR", 500, "A refund request has no Charge identifier.");
  }
  const resource = requestResource(detail);
  const isRequester = detail.requesterUserId === context.actor.id;
  const alreadyDecided = detail.decisions.some(
    (decision) => decision.approverUserId === context.actor.id,
  );
  const justification =
    isRequester || context.actor.approverEnabled
      ? fieldKeyring.decrypt(
          {
            algorithm: "aes-256-gcm",
            authenticationTag: Buffer.from(detail.justificationAuthTag).toString("base64url"),
            ciphertext: Buffer.from(detail.justificationCiphertext).toString("base64url"),
            keyVersion: detail.justificationKeyVersion,
            nonce: Buffer.from(detail.justificationNonce).toString("base64url"),
          },
          {
            entityId: detail.id,
            field: "justification",
            table: "refund_requests",
            tenantId: context.tenantId,
          },
        )
      : null;
  return {
    amount_minor: detail.amountMinor.toString(),
    can_cancel: isRequester && detail.workflowStatus === "pending_approval",
    can_decide:
      context.actor.approverEnabled &&
      !isRequester &&
      !alreadyDecided &&
      detail.workflowStatus === "pending_approval",
    charge_id: detail.chargeId,
    created_at: detail.createdAt.toISOString(),
    currency: detail.currency.toLowerCase(),
    id: detail.id,
    is_requester: isRequester,
    justification,
    payment_intent_id: detail.paymentIntentId,
    requester_user_id: requesterStripeUserId,
    resource_id: resource.resourceId,
    resource_type: resource.resourceType,
    status: detail.workflowStatus,
  };
}

function page<T extends { readonly id: string }>(
  items: readonly T[],
  requestedLimit: number,
): PilotPage<T> {
  return {
    items,
    next_cursor: items.length === requestedLimit ? (items.at(-1)?.id ?? null) : null,
  };
}

function alertClassification(value: string): PilotExternalAlert["classification"] {
  if (value === "external" || value === "proof_replay" || value === "tampered") {
    return value;
  }
  throw new PilotApiError(
    "INTERNAL_ERROR",
    500,
    "An external refund alert has an invalid classification.",
  );
}

export function pilotStripeRolesJson(roles: PilotSignedIdentity["roles"]): Prisma.InputJsonArray {
  return roles.map((role) => ({
    ...(role.id === undefined ? {} : { id: role.id }),
    type: role.type,
    name: role.name,
  }));
}

export class PilotPrismaRepository implements PilotRepository {
  private readonly now: () => Date;

  constructor(private readonly options: PilotPrismaRepositoryOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async resolveContext(
    identity: PilotSignedIdentity,
    options: { readonly allowProvision: boolean },
  ): Promise<PilotTenantContext | null> {
    let resolved = await resolveInstallation(
      this.options.client,
      identity.accountId,
      identity.environment,
    );
    if (resolved === null && options.allowProvision) {
      resolved = await provisionInstallation(
        this.options.client,
        identity.accountId,
        identity.environment,
      );
    }
    if (resolved === null) {
      return null;
    }

    return withTenantTransaction(
      this.options.client,
      resolved.tenantId,
      async ({ repositories }) => {
        const [installation, actor] = await Promise.all([
          repositories.getInstallationContext(resolved.installationId),
          repositories.observeTenantUser({
            stripeRoles: pilotStripeRolesJson(identity.roles),
            stripeUserId: identity.userId,
            verifiedAt: this.now(),
          }),
        ]);
        if (installation === null) {
          return null;
        }
        return {
          actor: {
            approverEnabled: actor.approverEnabled,
            id: actor.id,
            stripeUserId: actor.stripeUserId,
          },
          environment: identity.environment,
          installationId: installation.id,
          installationStatus: installation.status,
          stripeAccountId: installation.stripeAccountId,
          tenantId: installation.tenantId,
          tenantStatus: installation.tenant.status,
        };
      },
    );
  }

  findMutationReceipt(
    context: PilotTenantContext,
    requestNonce: string,
  ): Promise<PilotMutationReceipt | null> {
    return withTenantTransaction(
      this.options.client,
      context.tenantId,
      async ({ repositories }) => {
        const receipt = await repositories.findMutationReceipt(requestNonce);
        return receipt === null ? null : receiptFromDatabase(receipt);
      },
    );
  }

  async executeMutation(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    mutation: PilotMutation,
  ): Promise<PilotStoredResponse> {
    try {
      return await withTenantTransaction(
        this.options.client,
        context.tenantId,
        async ({ repositories, tx }) => {
          const existing = await repositories.findMutationReceipt(metadata.requestNonce);
          if (existing !== null) {
            const receipt = receiptFromDatabase(existing);
            assertReceiptMatches(receipt, metadata);
            return receipt.response;
          }

          const installation = await repositories.getInstallationContext(context.installationId);
          assertCurrentInstallation(installation, context);
          const result = await this.performMutation(context, metadata, mutation, repositories, tx);
          if (result.status < 500) {
            await repositories.createMutationReceipt({
              actorId: metadata.actorId,
              canonicalRequestHash: Buffer.from(metadata.canonicalRequestHash),
              expiresAt: new Date(this.now().getTime() + RECEIPT_RETENTION_MILLISECONDS),
              operation: metadata.operation,
              requestNonce: metadata.requestNonce,
              responseBody: prismaJsonObject(result.body),
              responseStatus: result.status,
            });
          }
          return result;
        },
      );
    } catch (error) {
      if (errorCode(error) === "P2002") {
        const receipt = await this.findMutationReceipt(context, metadata.requestNonce);
        if (receipt !== null) {
          assertReceiptMatches(receipt, metadata);
          return receipt.response;
        }
        throw new PilotApiError("WORKFLOW_CONFLICT", 409, "The workflow changed concurrently.", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async storeMutationReceipt(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    responseToStore: PilotStoredResponse,
  ): Promise<PilotStoredResponse> {
    if (
      !Number.isSafeInteger(responseToStore.status) ||
      responseToStore.status < 200 ||
      responseToStore.status >= 500
    ) {
      throw new PilotApiError("INTERNAL_ERROR", 500, "A mutation receipt response is invalid.");
    }

    try {
      return await withTenantTransaction(
        this.options.client,
        context.tenantId,
        async ({ repositories }) => {
          const existing = await repositories.findMutationReceipt(metadata.requestNonce);
          if (existing !== null) {
            const receipt = receiptFromDatabase(existing);
            assertReceiptMatches(receipt, metadata);
            return receipt.response;
          }

          const installation = await repositories.getInstallationContext(context.installationId);
          assertCurrentInstallation(installation, context);
          await repositories.createMutationReceipt({
            actorId: metadata.actorId,
            canonicalRequestHash: Buffer.from(metadata.canonicalRequestHash),
            expiresAt: new Date(this.now().getTime() + RECEIPT_RETENTION_MILLISECONDS),
            operation: metadata.operation,
            requestNonce: metadata.requestNonce,
            responseBody: prismaJsonObject(responseToStore.body),
            responseStatus: responseToStore.status,
          });
          return responseToStore;
        },
      );
    } catch (error) {
      if (errorCode(error) === "P2002") {
        const receipt = await this.findMutationReceipt(context, metadata.requestNonce);
        if (receipt !== null) {
          assertReceiptMatches(receipt, metadata);
          return receipt.response;
        }
        throw new PilotApiError("WORKFLOW_CONFLICT", 409, "The workflow changed concurrently.", {
          cause: error,
        });
      }
      throw error;
    }
  }

  findActiveRequest(
    context: PilotTenantContext,
    paymentKey: string,
  ): Promise<PilotActiveRequest | null> {
    return withTenantTransaction(
      this.options.client,
      context.tenantId,
      async ({ repositories }) => {
        const request = await repositories.getActiveRequestByPayment(
          context.environment,
          paymentKey,
        );
        return request === null ? null : { id: request.id, status: request.workflowStatus };
      },
    );
  }

  listRefundRequests(
    context: PilotTenantContext,
    input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly scope: "all_activity" | "awaiting_my_approval" | "my_requests";
    },
  ): Promise<PilotPage<PilotRequestSummary>> {
    return withTenantTransaction(
      this.options.client,
      context.tenantId,
      async ({ repositories, tx }) => {
        const requests = await repositories.listRefundRequests({
          actorUserId: context.actor.id,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          limit: input.limit,
          scope:
            input.scope === "my_requests"
              ? "requester"
              : input.scope === "awaiting_my_approval"
                ? "awaiting_approval"
                : "all",
        });
        const requesterIds = [...new Set(requests.map((request) => request.requesterUserId))];
        const requesters = await tx.tenantUser.findMany({
          where: {
            id: { in: requesterIds },
            tenantId: context.tenantId,
          },
        });
        const stripeIds = new Map(
          requesters.map((requester) => [requester.id, requester.stripeUserId]),
        );
        const mapped = requests.map((request) => {
          const requesterStripeUserId = stripeIds.get(request.requesterUserId);
          if (requesterStripeUserId === undefined) {
            throw new PilotApiError(
              "INTERNAL_ERROR",
              500,
              "A refund requester could not be resolved.",
            );
          }
          return mapRequest(request, context, requesterStripeUserId, this.options.fieldKeyring);
        });
        return page(mapped, input.limit);
      },
    );
  }

  getRefundRequest(
    context: PilotTenantContext,
    requestId: string,
  ): Promise<PilotRequestRecord | null> {
    return withTenantTransaction(
      this.options.client,
      context.tenantId,
      async ({ repositories, tx }) => {
        const request = await repositories.getRefundRequestDetail(requestId);
        if (request === null) {
          return null;
        }
        const requester = await tx.tenantUser.findFirst({
          where: {
            id: request.requesterUserId,
            tenantId: context.tenantId,
          },
        });
        if (requester === null) {
          throw new PilotApiError(
            "INTERNAL_ERROR",
            500,
            "A refund requester could not be resolved.",
          );
        }
        return mapRequest(request, context, requester.stripeUserId, this.options.fieldKeyring);
      },
    );
  }

  listExternalAlerts(
    context: PilotTenantContext,
    input: { readonly cursor?: string; readonly limit: number },
  ): Promise<PilotPage<PilotExternalAlert>> {
    return withTenantTransaction(
      this.options.client,
      context.tenantId,
      async ({ repositories }) => {
        const alerts = await repositories.listExternalRefundAlerts({
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          limit: input.limit,
        });
        return page(
          alerts.map((alert) => ({
            acknowledged: alert.status === "acknowledged",
            amount_minor: alert.amountMinor.toString(),
            classification: alertClassification(alert.classification),
            currency: alert.currency.toLowerCase(),
            detected_at: alert.detectedAt.toISOString(),
            id: alert.id,
            refund_id: alert.stripeRefundId,
          })),
          input.limit,
        );
      },
    );
  }

  getSettings(context: PilotTenantContext): Promise<PilotSettings> {
    return withTenantTransaction(
      this.options.client,
      context.tenantId,
      async ({ repositories }) => {
        const snapshot = await repositories.getSettings(context.installationId);
        if (snapshot === null) {
          throw new PilotApiError(
            "INSTALLATION_NOT_FOUND",
            404,
            "The Stripe installation was not found.",
          );
        }
        return {
          approver_user_ids: snapshot.approvers.map((approver) => approver.stripeUserId),
          expiration_days: 7,
          onboarding_completed: snapshot.installation.onboardingCompletedAt !== null,
        };
      },
    );
  }

  private async performMutation(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    mutation: PilotMutation,
    repositories: TenantRepositories,
    tx: Prisma.TransactionClient,
  ): Promise<PilotStoredResponse> {
    switch (mutation.kind) {
      case "context_sync":
        return this.synchronizeContext(context, repositories);
      case "refund_request_create":
        return this.createRefundRequest(context, metadata, mutation, repositories);
      case "refund_request_decide":
        return this.decideRefundRequest(context, metadata, mutation, repositories, tx);
      case "refund_request_cancel":
        return this.cancelRefundRequest(context, metadata, mutation, repositories);
      case "external_alert_acknowledge":
        return this.acknowledgeAlert(context, metadata, mutation.alertId, repositories, tx);
      case "settings_update":
        return this.updateSettings(context, metadata, mutation, repositories, tx);
      case "audit_export":
        return this.createAuditExport(context, metadata, repositories);
    }
  }

  private async synchronizeContext(
    context: PilotTenantContext,
    repositories: TenantRepositories,
  ): Promise<PilotStoredResponse> {
    const settings = await repositories.getSettings(context.installationId);
    if (settings === null) {
      throw new PilotApiError(
        "INSTALLATION_NOT_FOUND",
        404,
        "The Stripe installation was not found.",
      );
    }
    return response({
      approvals_required: 1,
      current_user_is_approver: settings.approvers.some(
        (approver) => approver.id === context.actor.id,
      ),
      installation_active:
        settings.installation.status === "active" &&
        settings.installation.tenant.status === "active",
      onboarding_completed: settings.installation.onboardingCompletedAt !== null,
    });
  }

  private async createRefundRequest(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    mutation: Extract<PilotMutation, { kind: "refund_request_create" }>,
    repositories: TenantRepositories,
  ): Promise<PilotStoredResponse> {
    const [policy, activeRequest, distinctApprovers] = await Promise.all([
      repositories.getActiveApprovalPolicy(),
      repositories.getActiveRequestByPayment(context.environment, mutation.payment.paymentKey),
      repositories.countEligibleDistinctApprovers(context.actor.id),
    ]);
    if (
      policy === null ||
      policy.requiredApprovals !== 1 ||
      policy.expiresAfterSeconds !== 604_800
    ) {
      throw new PilotApiError(
        "INSTALLATION_INACTIVE",
        403,
        "Complete the one-approver pilot setup before creating requests.",
      );
    }
    if (distinctApprovers < 1) {
      throw new PilotApiError(
        "NO_DISTINCT_APPROVER",
        422,
        "A different explicit approver is required for this requester.",
      );
    }
    if (activeRequest !== null) {
      throw new PilotApiError(
        "WORKFLOW_CONFLICT",
        409,
        "A non-terminal refund request already exists for this payment.",
      );
    }

    const requestId = randomUUID();
    const encrypted = this.options.fieldKeyring.encrypt(mutation.justification, {
      entityId: requestId,
      field: "justification",
      table: "refund_requests",
      tenantId: context.tenantId,
    });
    const now = this.now();
    const request = await repositories.createRefundRequest({
      amountMinor: mutation.amountMinor,
      chargeId: mutation.payment.chargeId,
      currency: mutation.currency,
      environment: context.environment,
      expiresAt: new Date(now.getTime() + policy.expiresAfterSeconds * 1_000),
      id: requestId,
      installationId: context.installationId,
      justificationAuthTag: Buffer.from(encrypted.authenticationTag, "base64url"),
      justificationCiphertext: Buffer.from(encrypted.ciphertext, "base64url"),
      justificationKeyVersion: encrypted.keyVersion,
      justificationNonce: Buffer.from(encrypted.nonce, "base64url"),
      paymentIntentId: mutation.payment.paymentIntentId,
      paymentKey: mutation.payment.paymentKey,
      policyVersion: policy.version,
      reason: mutation.reason,
      requesterUserId: context.actor.id,
      requiredApprovals: policy.requiredApprovals,
    });
    await repositories.appendAuditEvent({
      action: "refund_request.created",
      actorId: context.actor.stripeUserId,
      actorSnapshot: {},
      actorType: "stripe_user",
      correlationRequestId: metadata.requestNonce,
      entityId: request.id,
      entityType: "refund_request",
      payload: {
        amount_minor: mutation.amountMinor.toString(),
        currency: mutation.currency,
        payment_key: mutation.payment.paymentKey,
      },
    });
    return response({
      request_id: request.id,
      status: request.workflowStatus,
    });
  }

  private async decideRefundRequest(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    mutation: Extract<PilotMutation, { kind: "refund_request_decide" }>,
    repositories: TenantRepositories,
    tx: Prisma.TransactionClient,
  ): Promise<PilotStoredResponse> {
    const [request, actor] = await Promise.all([
      repositories.getRefundRequestDetail(mutation.requestId),
      tx.tenantUser.findFirst({
        where: { id: context.actor.id, tenantId: context.tenantId },
      }),
    ]);
    if (request === null) {
      throw new PilotApiError("REQUEST_NOT_FOUND", 404, "The refund request was not found.");
    }
    if (actor === null || !actor.approverEnabled) {
      throw new PilotApiError(
        "APPROVER_REQUIRED",
        403,
        "This action requires an explicitly enabled approver.",
      );
    }
    if (request.requesterUserId === actor.id) {
      throw new PilotApiError(
        "SELF_APPROVAL",
        403,
        "A requester cannot approve or reject their own request.",
      );
    }
    if (
      request.workflowStatus !== "pending_approval" ||
      !requestMatchesMutationResource(request, mutation)
    ) {
      throw new PilotApiError(
        "WORKFLOW_CONFLICT",
        409,
        "The pending request no longer matches this decision.",
      );
    }

    const decisionId = randomUUID();
    const rejection =
      mutation.decision === "reject" && mutation.justification !== undefined
        ? this.options.fieldKeyring.encrypt(mutation.justification, {
            entityId: decisionId,
            field: "rejection",
            table: "approval_decisions",
            tenantId: context.tenantId,
          })
        : null;
    const now = this.now();
    const result = await repositories.recordDecision(
      {
        approverUserId: actor.id,
        decision: mutation.decision,
        id: decisionId,
        ...(rejection === null
          ? {}
          : {
              rejectionAuthTag: Buffer.from(rejection.authenticationTag, "base64url"),
              rejectionCiphertext: Buffer.from(rejection.ciphertext, "base64url"),
              rejectionKeyVersion: rejection.keyVersion,
              rejectionNonce: Buffer.from(rejection.nonce, "base64url"),
            }),
        requestId: mutation.requestId,
        stripeRolesSnapshot: databaseJson(actor.stripeRoles),
      },
      now,
    );
    const expectedTransition =
      mutation.decision === "approve" ? result.becameApproved : result.becameRejected;
    if (!expectedTransition) {
      throw new PilotApiError("WORKFLOW_CONFLICT", 409, "The request was already decided.");
    }
    const status = mutation.decision === "approve" ? "approved" : "rejected";
    await repositories.appendAuditEvent({
      action: `refund_request.${mutation.decision}d`,
      actorId: actor.stripeUserId,
      actorSnapshot: databaseJson(actor.stripeRoles),
      actorType: "stripe_user",
      correlationRequestId: metadata.requestNonce,
      entityId: mutation.requestId,
      entityType: "refund_request",
      payload: { decision: mutation.decision },
    });
    return response({ request_id: mutation.requestId, status });
  }

  private async cancelRefundRequest(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    mutation: Extract<PilotMutation, { kind: "refund_request_cancel" }>,
    repositories: TenantRepositories,
  ): Promise<PilotStoredResponse> {
    const request = await repositories.getRefundRequestDetail(mutation.requestId);
    if (request === null) {
      throw new PilotApiError("REQUEST_NOT_FOUND", 404, "The refund request was not found.");
    }
    if (
      request.requesterUserId !== context.actor.id ||
      !requestMatchesMutationResource(request, mutation)
    ) {
      throw new PilotApiError(
        "UNAUTHORIZED",
        403,
        "Only the requester can cancel this payment request.",
      );
    }
    const canceled = await repositories.cancelPendingRequest(
      mutation.requestId,
      context.actor.id,
      this.now(),
    );
    if (!canceled) {
      throw new PilotApiError("WORKFLOW_CONFLICT", 409, "Only a pending request can be canceled.");
    }
    await repositories.appendAuditEvent({
      action: "refund_request.canceled",
      actorId: context.actor.stripeUserId,
      actorSnapshot: {},
      actorType: "stripe_user",
      correlationRequestId: metadata.requestNonce,
      entityId: mutation.requestId,
      entityType: "refund_request",
      payload: {},
    });
    return response({
      request_id: mutation.requestId,
      status: "canceled",
    });
  }

  private async acknowledgeAlert(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    alertId: string,
    repositories: TenantRepositories,
    tx: Prisma.TransactionClient,
  ): Promise<PilotStoredResponse> {
    const actor = await tx.tenantUser.findFirst({
      where: { id: context.actor.id, tenantId: context.tenantId },
    });
    if (actor === null || !actor.approverEnabled) {
      throw new PilotApiError(
        "APPROVER_REQUIRED",
        403,
        "This action requires an explicitly enabled approver.",
      );
    }
    const alert = await repositories.acknowledgeExternalRefundAlert(alertId, actor.id, this.now());
    if (alert === null) {
      throw new PilotApiError(
        "WORKFLOW_CONFLICT",
        409,
        "The external refund alert is missing or already acknowledged.",
      );
    }
    await repositories.appendAuditEvent({
      action: "external_refund_alert.acknowledged",
      actorId: actor.stripeUserId,
      actorSnapshot: databaseJson(actor.stripeRoles),
      actorType: "stripe_user",
      correlationRequestId: metadata.requestNonce,
      entityId: alert.id,
      entityType: "external_refund_alert",
      payload: { stripe_refund_id: alert.stripeRefundId },
    });
    return response({ acknowledged: true, alert_id: alert.id });
  }

  private async updateSettings(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    mutation: Extract<PilotMutation, { kind: "settings_update" }>,
    repositories: TenantRepositories,
    tx: Prisma.TransactionClient,
  ): Promise<PilotStoredResponse> {
    const users = await tx.tenantUser.findMany({
      where: {
        stripeUserId: { in: [...mutation.approverUserIds] },
        tenantId: context.tenantId,
      },
    });
    if (users.length !== mutation.approverUserIds.length) {
      throw new PilotApiError(
        "NO_DISTINCT_APPROVER",
        422,
        "Every approver must open RefundDesk once before activation.",
      );
    }
    await tx.tenantUser.updateMany({
      where: { approverEnabled: true, tenantId: context.tenantId },
      data: { approverEnabled: false },
    });
    await tx.tenantUser.updateMany({
      where: {
        id: { in: users.map((user) => user.id) },
        tenantId: context.tenantId,
      },
      data: { approverEnabled: true },
    });
    await repositories.createApprovalPolicy(context.actor.stripeUserId);
    if (mutation.onboardingCompleted) {
      const completed = await repositories.completeOnboarding(context.installationId, this.now());
      if (!completed) {
        throw new PilotApiError(
          "INSTALLATION_INACTIVE",
          403,
          "The Stripe installation is not active.",
        );
      }
    }
    await repositories.appendAuditEvent({
      action: "settings.updated",
      actorId: context.actor.stripeUserId,
      actorSnapshot: {},
      actorType: "stripe_user",
      correlationRequestId: metadata.requestNonce,
      entityId: context.installationId,
      entityType: "stripe_installation",
      payload: {
        approver_count: users.length,
        expiration_days: mutation.expirationDays,
        onboarding_completed: mutation.onboardingCompleted,
      },
    });
    const settings = await repositories.getSettings(context.installationId);
    if (settings === null) {
      throw new PilotApiError(
        "INSTALLATION_NOT_FOUND",
        404,
        "The Stripe installation was not found.",
      );
    }
    return response({
      approver_user_ids: settings.approvers.map((approver) => approver.stripeUserId),
      expiration_days: 7,
      onboarding_completed: settings.installation.onboardingCompletedAt !== null,
    });
  }

  private async createAuditExport(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    repositories: TenantRepositories,
  ): Promise<PilotStoredResponse> {
    const expiresAt = new Date(this.now().getTime() + AUDIT_LINK_LIFETIME_MILLISECONDS);
    const token = createPilotAuditToken(
      {
        actor_id: context.actor.stripeUserId,
        environment: context.environment,
        expires_at: expiresAt.toISOString(),
        installation_id: context.installationId,
        tenant_id: context.tenantId,
      },
      this.options.auditSigningKey,
    );
    const downloadUrl = new URL("/api/v1/audit/download", this.options.appBaseUrl);
    downloadUrl.searchParams.set("token", token);
    await repositories.appendAuditEvent({
      action: "audit.export_prepared",
      actorId: context.actor.stripeUserId,
      actorSnapshot: {},
      actorType: "stripe_user",
      correlationRequestId: metadata.requestNonce,
      entityId: context.installationId,
      entityType: "stripe_installation",
      payload: { expires_at: expiresAt.toISOString(), format: "csv" },
    });
    return response({
      download_url: downloadUrl.toString(),
      expires_at: expiresAt.toISOString(),
    });
  }
}
