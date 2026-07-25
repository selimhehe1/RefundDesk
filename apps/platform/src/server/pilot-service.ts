import { timingSafeEqual } from "node:crypto";

import type { OperationCommand, PilotOperation } from "@refunddesk/contracts";
import { evaluatePaymentEligibility, type IneligibilityCode } from "@refunddesk/domain";

import { PilotApiError } from "./pilot-errors";
import type {
  PilotAccessPolicy,
  PilotMutationMetadata,
  PilotPayment,
  PilotPaymentReader,
  PilotPaymentResource,
  PilotRepository,
  PilotRequestRecord,
  PilotRequestSummary,
  PilotSignedIdentity,
  PilotStoredResponse,
  PilotTenantContext,
} from "./pilot-ports";

export type PilotDispatchRequest = {
  [Operation in PilotOperation]: {
    readonly canonicalRequestHash: Uint8Array;
    readonly command: OperationCommand<Operation>;
    readonly identity: PilotSignedIdentity;
    readonly mutation: boolean;
    readonly operation: Operation;
    readonly requestNonce: string;
    readonly responseRequestId: string;
    readonly resource: PilotPaymentResource | null;
  };
}[PilotOperation];

const INELIGIBILITY_MESSAGES = {
  AMOUNT_EXCEEDS_REMAINING: "The requested amount exceeds the remaining refundable balance.",
  CARD_PRESENT_UNSUPPORTED: "Card-present payments are not supported during the pilot.",
  CONNECT_UNSUPPORTED:
    "Payments with Connect transfer semantics are not supported during the pilot.",
  CURRENCY_MISMATCH: "The requested currency does not match the payment.",
  DISPUTED: "Disputed payments are not eligible for this workflow.",
  NOTHING_REFUNDABLE: "This payment has no refundable balance remaining.",
  NOT_CAPTURED: "The payment has not been captured.",
  NOT_PAID: "The payment has not been paid.",
  PAYMENT_METHOD_UNSUPPORTED: "Only captured card payments are supported during the pilot.",
} as const satisfies Readonly<Record<IneligibilityCode, string>>;

function response(body: PilotStoredResponse["body"], status = 200): PilotStoredResponse {
  return { body, status };
}

function isAdministrator(identity: PilotSignedIdentity): boolean {
  return identity.roles.some((role) => role.name === "Administrator" && role.type === "builtIn");
}

function requireApprover(context: PilotTenantContext): void {
  if (!context.actor.approverEnabled) {
    throw new PilotApiError(
      "APPROVER_REQUIRED",
      403,
      "This action requires an explicitly enabled approver.",
    );
  }
}

function requirePaymentResource(resource: PilotPaymentResource | null): PilotPaymentResource {
  if (resource === null) {
    throw new PilotApiError(
      "RESOURCE_MISMATCH",
      400,
      "This operation requires a Charge or PaymentIntent resource.",
    );
  }
  return resource;
}

function requestMatchesResource(
  request: PilotRequestRecord,
  resource: PilotPaymentResource,
): boolean {
  return resource.type === "charge"
    ? request.charge_id === resource.id
    : request.payment_intent_id === resource.id;
}

function paymentMatchesResource(payment: PilotPayment, resource: PilotPaymentResource): boolean {
  return resource.type === "charge"
    ? payment.chargeId === resource.id
    : payment.paymentIntentId === resource.id;
}

function publicRequestSummary(request: PilotRequestRecord): PilotRequestSummary {
  return {
    amount_minor: request.amount_minor,
    can_cancel: request.can_cancel,
    can_decide: request.can_decide,
    created_at: request.created_at,
    currency: request.currency,
    id: request.id,
    is_requester: request.is_requester,
    justification: request.justification,
    requester_user_id: request.requester_user_id,
    resource_id: request.resource_id,
    resource_type: request.resource_type,
    status: request.status,
  };
}

function requestSummaryJson(request: PilotRequestSummary) {
  return {
    amount_minor: request.amount_minor,
    can_cancel: request.can_cancel,
    can_decide: request.can_decide,
    created_at: request.created_at,
    currency: request.currency,
    id: request.id,
    is_requester: request.is_requester,
    justification: request.justification,
    requester_user_id: request.requester_user_id,
    resource_id: request.resource_id,
    resource_type: request.resource_type,
    status: request.status,
  } as const;
}

function hashesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function assertReceiptMatches(
  receipt: Awaited<ReturnType<PilotRepository["findMutationReceipt"]>>,
  metadata: PilotMutationMetadata,
): asserts receipt is NonNullable<typeof receipt> {
  if (
    receipt === null ||
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

function assertContextBinding(context: PilotTenantContext, identity: PilotSignedIdentity): void {
  if (
    context.stripeAccountId !== identity.accountId ||
    context.environment !== identity.environment
  ) {
    throw new PilotApiError(
      "ACCOUNT_ENVIRONMENT_MISMATCH",
      403,
      "The signed account and environment do not match the installation.",
    );
  }
  if (context.actor.stripeUserId !== identity.userId) {
    throw new PilotApiError(
      "UNAUTHORIZED",
      403,
      "The signed Stripe user does not match the tenant actor.",
    );
  }
}

function eligibilityInput(payment: PilotPayment) {
  return {
    amountCaptured: payment.amountCaptured,
    amountRefunded: payment.amountRefunded,
    captured: payment.captured,
    currency: payment.currency,
    disputed: payment.disputed,
    hasConnectSemantics: payment.hasConnectSemantics,
    paid: payment.paid,
    paymentKey: payment.paymentKey,
    paymentMethodType: payment.paymentMethodType,
  } as const;
}

export class PilotService {
  constructor(
    private readonly repository: PilotRepository,
    private readonly paymentReader: PilotPaymentReader,
    private readonly accessPolicy: PilotAccessPolicy,
  ) {}

  async dispatch(input: PilotDispatchRequest): Promise<PilotStoredResponse> {
    const context = await this.repository.resolveContext(input.identity, {
      allowProvision: input.operation === "context.sync" && isAdministrator(input.identity),
    });
    if (context === null) {
      throw new PilotApiError(
        "INSTALLATION_NOT_FOUND",
        404,
        "No RefundDesk installation matches this account and environment.",
      );
    }
    assertContextBinding(context, input.identity);
    this.accessPolicy.assertAllowed(context, {
      mutation: input.mutation,
      operation: input.operation,
      roles: input.identity.roles,
    });

    const metadata: PilotMutationMetadata = {
      actorId: input.identity.userId,
      canonicalRequestHash: input.canonicalRequestHash,
      operation: input.operation,
      requestNonce: input.requestNonce,
      responseRequestId: input.responseRequestId,
    };
    if (input.mutation) {
      const receipt = await this.repository.findMutationReceipt(context, input.requestNonce);
      if (receipt !== null) {
        assertReceiptMatches(receipt, metadata);
        return receipt.response;
      }
    }

    try {
      switch (input.operation) {
        case "context.sync":
          return await this.repository.executeMutation(context, metadata, {
            kind: "context_sync",
          });

        case "payment.eligibility":
          return await this.paymentEligibility(context, input.resource);

        case "refund_request.create":
          return await this.createRefundRequest(context, metadata, input);

        case "refund_request.list": {
          if (
            input.command.scope === "awaiting_my_approval" ||
            input.command.scope === "all_activity"
          ) {
            requireApprover(context);
          }
          const page = await this.repository.listRefundRequests(context, {
            ...(input.command.cursor === undefined ? {} : { cursor: input.command.cursor }),
            limit: input.command.limit,
            scope: input.command.scope,
          });
          return response({
            items: page.items.map((item) => requestSummaryJson(item)),
            next_cursor: page.next_cursor,
          });
        }

        case "refund_request.get": {
          const request = await this.requireRequest(
            context,
            input.command.request_id,
            requirePaymentResource(input.resource),
          );
          return response(requestSummaryJson(publicRequestSummary(request)));
        }

        case "refund_request.decide":
          return await this.decideRefundRequest(context, metadata, input);

        case "refund_request.cancel":
          return await this.cancelRefundRequest(context, metadata, input);

        case "external_alert.list": {
          requireApprover(context);
          const page = await this.repository.listExternalAlerts(context, {
            ...(input.command.cursor === undefined ? {} : { cursor: input.command.cursor }),
            limit: input.command.limit,
          });
          return response({
            items: page.items.map((item) => ({
              acknowledged: item.acknowledged,
              amount_minor: item.amount_minor,
              classification: item.classification,
              currency: item.currency,
              detected_at: item.detected_at,
              id: item.id,
              refund_id: item.refund_id,
            })),
            next_cursor: page.next_cursor,
          });
        }

        case "external_alert.acknowledge":
          requireApprover(context);
          return await this.repository.executeMutation(context, metadata, {
            alertId: input.command.alert_id,
            kind: "external_alert_acknowledge",
          });

        case "settings.get": {
          const settings = await this.repository.getSettings(context);
          return response({
            approver_user_ids: settings.approver_user_ids,
            expiration_days: settings.expiration_days,
            onboarding_completed: settings.onboarding_completed,
          });
        }

        case "settings.update": {
          if (!isAdministrator(input.identity)) {
            throw new PilotApiError(
              "ADMIN_REQUIRED",
              403,
              "A signed Stripe Administrator role is required.",
            );
          }
          const approverUserIds = [...new Set(input.command.approver_user_ids)];
          if (approverUserIds.length === 0) {
            throw new PilotApiError(
              "NO_DISTINCT_APPROVER",
              422,
              "At least one explicit approver must remain enabled.",
            );
          }
          return await this.repository.executeMutation(context, metadata, {
            approverUserIds,
            expirationDays: input.command.expiration_days,
            kind: "settings_update",
            onboardingCompleted: input.command.onboarding_completed,
          });
        }

        case "audit.export":
          if (!context.actor.approverEnabled && !isAdministrator(input.identity)) {
            throw new PilotApiError(
              "UNAUTHORIZED",
              403,
              "Audit export requires an Administrator or explicit approver.",
            );
          }
          return await this.repository.executeMutation(context, metadata, {
            format: input.command.format,
            kind: "audit_export",
          });
      }
    } catch (error) {
      if (!input.mutation || !(error instanceof PilotApiError) || error.status >= 500) {
        throw error;
      }
      return this.repository.storeMutationReceipt(context, metadata, {
        body: {
          code: error.code,
          message: error.message,
          request_id: metadata.responseRequestId,
        },
        status: error.status,
      });
    }
  }

  private async paymentEligibility(
    context: PilotTenantContext,
    possibleResource: PilotPaymentResource | null,
  ): Promise<PilotStoredResponse> {
    const resource = requirePaymentResource(possibleResource);
    const payment = await this.paymentReader.retrievePayment(context, resource);
    if (!paymentMatchesResource(payment, resource)) {
      throw new PilotApiError(
        "RESOURCE_MISMATCH",
        422,
        "Stripe returned a payment that does not match the signed resource.",
      );
    }
    const eligibility = evaluatePaymentEligibility(eligibilityInput(payment));
    const remaining =
      payment.amountCaptured > payment.amountRefunded
        ? payment.amountCaptured - payment.amountRefunded
        : 0n;
    const activeRequest = await this.repository.findActiveRequest(context, payment.paymentKey);
    return response({
      active_request:
        activeRequest === null ? null : { id: activeRequest.id, status: activeRequest.status },
      approvals_required: 1,
      currency: payment.currency.toLowerCase(),
      eligible: eligibility.eligible,
      ineligible_reason: eligibility.eligible ? null : INELIGIBILITY_MESSAGES[eligibility.code],
      remaining_amount_minor: remaining.toString(),
    });
  }

  private async createRefundRequest(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    input: Extract<PilotDispatchRequest, { operation: "refund_request.create" }>,
  ): Promise<PilotStoredResponse> {
    const resource = requirePaymentResource(input.resource);
    const payment = await this.paymentReader.retrievePayment(context, resource);
    if (!paymentMatchesResource(payment, resource)) {
      throw new PilotApiError(
        "RESOURCE_MISMATCH",
        422,
        "Stripe returned a payment that does not match the signed resource.",
      );
    }
    const eligibility = evaluatePaymentEligibility({
      ...eligibilityInput(payment),
      requestedAmountMinor: BigInt(input.command.amount_minor),
      requestedCurrency: input.command.currency,
    });
    if (!eligibility.eligible) {
      throw new PilotApiError(
        "PAYMENT_NOT_ELIGIBLE",
        422,
        INELIGIBILITY_MESSAGES[eligibility.code],
      );
    }
    const activeRequest = await this.repository.findActiveRequest(context, payment.paymentKey);
    if (activeRequest !== null) {
      throw new PilotApiError(
        "WORKFLOW_CONFLICT",
        409,
        "A non-terminal refund request already exists for this payment.",
      );
    }
    return this.repository.executeMutation(context, metadata, {
      amountMinor: BigInt(input.command.amount_minor),
      currency: eligibility.currency,
      justification: input.command.justification,
      kind: "refund_request_create",
      payment,
      reason: input.command.reason,
      resource,
    });
  }

  private async decideRefundRequest(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    input: Extract<PilotDispatchRequest, { operation: "refund_request.decide" }>,
  ): Promise<PilotStoredResponse> {
    requireApprover(context);
    const resource = requirePaymentResource(input.resource);
    const request = await this.requireRequest(context, input.command.request_id, resource);
    if (request.requester_user_id === context.actor.stripeUserId) {
      throw new PilotApiError(
        "SELF_APPROVAL",
        403,
        "A requester cannot approve or reject their own request.",
      );
    }
    if (request.status !== "pending_approval") {
      throw new PilotApiError("WORKFLOW_CONFLICT", 409, "Only a pending request can be decided.");
    }
    return this.repository.executeMutation(context, metadata, {
      decision: input.command.decision,
      ...(input.command.justification === undefined
        ? {}
        : { justification: input.command.justification }),
      kind: "refund_request_decide",
      requestId: input.command.request_id,
      resource,
    });
  }

  private async cancelRefundRequest(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    input: Extract<PilotDispatchRequest, { operation: "refund_request.cancel" }>,
  ): Promise<PilotStoredResponse> {
    const resource = requirePaymentResource(input.resource);
    const request = await this.requireRequest(context, input.command.request_id, resource);
    if (request.requester_user_id !== context.actor.stripeUserId) {
      throw new PilotApiError(
        "UNAUTHORIZED",
        403,
        "Only the original requester can cancel this request.",
      );
    }
    if (request.status !== "pending_approval") {
      throw new PilotApiError("WORKFLOW_CONFLICT", 409, "Only a pending request can be canceled.");
    }
    return this.repository.executeMutation(context, metadata, {
      kind: "refund_request_cancel",
      requestId: input.command.request_id,
      resource,
    });
  }

  private async requireRequest(
    context: PilotTenantContext,
    requestId: string,
    resource: PilotPaymentResource,
  ): Promise<PilotRequestRecord> {
    const request = await this.repository.getRefundRequest(context, requestId);
    if (request === null) {
      throw new PilotApiError("REQUEST_NOT_FOUND", 404, "The refund request was not found.");
    }
    if (!requestMatchesResource(request, resource)) {
      throw new PilotApiError(
        "RESOURCE_MISMATCH",
        403,
        "The request does not belong to the signed payment resource.",
      );
    }
    if (!request.is_requester && !context.actor.approverEnabled) {
      throw new PilotApiError(
        "UNAUTHORIZED",
        403,
        "Only the requester or an explicit approver can read this request.",
      );
    }
    return request;
  }
}
