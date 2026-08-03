import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { z } from "zod";

import type { JsonValue } from "./canonical-json";
import {
  SignedExtensionRequestError,
  signedApiRequest,
  type SignedRequestInput,
} from "./signed-fetch";

const minorAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u)
  .max(32);
const currencySchema = z.string().regex(/^[a-z]{3}$/u);
const paymentResourceTypeSchema = z.enum(["charge", "payment_intent"]);
export const workflowStatusSchema = z.enum([
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
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

export const paymentResourceSchema = z
  .object({
    resourceType: paymentResourceTypeSchema,
    resourceId: z.string().min(1).max(255),
  })
  .strict();

export type PaymentResource = z.infer<typeof paymentResourceSchema>;

export const refundReasonSchema = z.enum(["duplicate", "fraudulent", "requested_by_customer"]);
export type RefundReason = z.infer<typeof refundReasonSchema>;

const activeRequestSchema = z
  .object({
    can_cancel: z.boolean(),
    id: z.uuid(),
    status: workflowStatusSchema,
  })
  .strict();

const eligibilityResponseSchema = z
  .object({
    eligible: z.boolean(),
    ineligible_reason: z.string().max(512).nullable().default(null),
    currency: currencySchema,
    remaining_amount_minor: minorAmountSchema,
    approvals_required: z.literal(1),
    active_request: activeRequestSchema.nullable().default(null),
  })
  .strict();

const createRequestResponseSchema = z
  .object({
    request_id: z.uuid(),
    status: workflowStatusSchema,
  })
  .strict();

const refundRequestSummarySchema = z
  .object({
    id: z.uuid(),
    resource_type: paymentResourceTypeSchema,
    resource_id: z.string().min(1).max(255),
    amount_minor: minorAmountSchema,
    currency: currencySchema,
    status: workflowStatusSchema,
    requester_user_id: z.string().min(1).max(255),
    justification: z.string().min(10).max(2_000).nullable(),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    can_decide: z.boolean(),
    can_cancel: z.boolean(),
    is_requester: z.boolean(),
    reason: refundReasonSchema,
  })
  .strict();

const requestListResponseSchema = z
  .object({
    items: z.array(refundRequestSummarySchema),
    next_cursor: z.string().max(512).nullable(),
  })
  .strict();

const requestMutationResponseSchema = z
  .object({
    request_id: z.uuid(),
    status: workflowStatusSchema,
  })
  .strict();

export const externalAlertClassificationSchema = z.enum(["external", "tampered", "proof_replay"]);

const externalAlertSchema = z
  .object({
    id: z.uuid(),
    refund_id: z.string().regex(/^re_[A-Za-z0-9]+$/u),
    amount_minor: minorAmountSchema,
    classification: externalAlertClassificationSchema,
    currency: currencySchema,
    detected_at: z.iso.datetime(),
    acknowledged: z.boolean(),
  })
  .strict();

const externalAlertListResponseSchema = z
  .object({
    items: z.array(externalAlertSchema),
    next_cursor: z.string().max(512).nullable(),
  })
  .strict();

const alertMutationResponseSchema = z
  .object({
    alert_id: z.uuid(),
    acknowledged: z.literal(true),
  })
  .strict();

const observedUserSchema = z
  .object({
    stripe_user_id: z
      .string()
      .regex(/^usr_[A-Za-z0-9]+$/u)
      .max(255),
    display_name: z.string().max(255).nullable(),
    approver_enabled: z.boolean(),
    last_seen_at: z.iso.datetime(),
  })
  .strict();

const settingsResponseSchema = z
  .object({
    approver_user_ids: z.array(z.string().min(1).max(255)),
    expiration_days: z.literal(7),
    onboarding_completed: z.boolean(),
    observed_users: z.array(observedUserSchema).max(500),
  })
  .strict();

const contextSyncResponseSchema = z
  .object({
    installation_active: z.boolean(),
    onboarding_completed: z.boolean(),
    current_user_is_approver: z.boolean(),
    approvals_required: z.literal(1),
  })
  .strict();

const auditExportResponseSchema = z
  .object({
    download_url: z.url(),
    expires_at: z.iso.datetime(),
  })
  .strict();

export type EligibilityResponse = z.infer<typeof eligibilityResponseSchema>;
export type RefundRequestSummary = z.infer<typeof refundRequestSummarySchema>;
export type RefundRequestListResponse = z.infer<typeof requestListResponseSchema>;
export type ExternalAlert = z.infer<typeof externalAlertSchema>;
export type ExternalAlertListResponse = z.infer<typeof externalAlertListResponseSchema>;
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;
export type ObservedUser = z.infer<typeof observedUserSchema>;

type RequestScope = "all_activity" | "awaiting_my_approval" | "my_requests";
type RefundDecisionCommand =
  | {
      readonly request_id: string;
      readonly decision: "approve";
      readonly expected_request_version: number;
      readonly approval_snapshot: {
        readonly amount_minor: string;
        readonly currency: string;
        readonly reason: RefundReason;
        readonly requester_user_id: string;
      };
    }
  | {
      readonly request_id: string;
      readonly decision: "reject";
      readonly justification: string;
    };

function accountResource(context: ExtensionContextValue): {
  readonly resourceType: "account";
} {
  void context;
  return {
    resourceType: "account",
  };
}

async function requestAndParse<T extends z.ZodType>(
  context: ExtensionContextValue,
  input: SignedRequestInput,
  schema: T,
): Promise<z.output<T>> {
  const payload = await signedApiRequest(context, input);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new SignedExtensionRequestError(
      "RESPONSE_INVALID",
      "RefundDesk returned an unexpected response.",
    );
  }
  return parsed.data;
}

export function getPaymentResource(context: ExtensionContextValue): PaymentResource | null {
  const objectContext = context.environment.objectContext;
  if (
    objectContext === null ||
    objectContext === undefined ||
    (objectContext.object !== "charge" && objectContext.object !== "payment_intent")
  ) {
    return null;
  }
  return {
    resourceType: objectContext.object,
    resourceId: objectContext.id,
  };
}

export const refundDeskApi = {
  syncContext(context: ExtensionContextValue) {
    // The Stripe context supplies the signing user's display name without any extra
    // permission. Sending it here is what lets Settings show people instead of raw
    // usr_… identifiers; it is omitted when Stripe does not provide one.
    const displayName = context.userContext.name;
    const command =
      typeof displayName === "string" && displayName.trim().length > 0
        ? { display_name: displayName.trim().slice(0, 255) }
        : {};
    return requestAndParse(
      context,
      {
        endpoint: "/v1/context/sync",
        operation: "context.sync",
        ...accountResource(context),
        command,
      },
      contextSyncResponseSchema,
    );
  },

  getEligibility(context: ExtensionContextValue, resource: PaymentResource) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/payments/eligibility",
        operation: "payment.eligibility",
        ...resource,
        command: {},
      },
      eligibilityResponseSchema,
    );
  },

  createRefundRequest(
    context: ExtensionContextValue,
    resource: PaymentResource,
    command: {
      readonly amount_minor: string;
      readonly currency: string;
      readonly reason: RefundReason;
      readonly justification: string;
    },
    requestNonce: string,
  ) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/refund-requests/create",
        operation: "refund_request.create",
        ...resource,
        command,
        requestNonce,
      },
      createRequestResponseSchema,
    );
  },

  listRefundRequests(context: ExtensionContextValue, scope: RequestScope, cursor?: string) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/refund-requests/list",
        operation: "refund_request.list",
        ...accountResource(context),
        command: {
          scope,
          limit: 25,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      requestListResponseSchema,
    );
  },

  getRefundRequest(context: ExtensionContextValue, resource: PaymentResource, requestId: string) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/refund-requests/get",
        operation: "refund_request.get",
        ...resource,
        command: { request_id: requestId },
      },
      refundRequestSummarySchema,
    );
  },

  decideRefundRequest(
    context: ExtensionContextValue,
    resource: PaymentResource,
    command: RefundDecisionCommand,
    requestNonce: string,
  ) {
    const canonicalCommand: JsonValue =
      command.decision === "approve"
        ? {
            request_id: command.request_id,
            decision: command.decision,
            expected_request_version: command.expected_request_version,
            approval_snapshot: command.approval_snapshot,
          }
        : {
            request_id: command.request_id,
            decision: command.decision,
            justification: command.justification,
          };
    return requestAndParse(
      context,
      {
        endpoint: "/v1/refund-requests/decide",
        operation: "refund_request.decide",
        ...resource,
        command: canonicalCommand,
        requestNonce,
      },
      requestMutationResponseSchema,
    );
  },

  cancelRefundRequest(
    context: ExtensionContextValue,
    resource: PaymentResource,
    requestId: string,
    requestNonce: string,
  ) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/refund-requests/cancel",
        operation: "refund_request.cancel",
        ...resource,
        command: { request_id: requestId },
        requestNonce,
      },
      requestMutationResponseSchema,
    );
  },

  listExternalAlerts(context: ExtensionContextValue, cursor?: string) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/external-alerts/list",
        operation: "external_alert.list",
        ...accountResource(context),
        command: {
          limit: 25,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      externalAlertListResponseSchema,
    );
  },

  acknowledgeExternalAlert(context: ExtensionContextValue, alertId: string, requestNonce: string) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/external-alerts/acknowledge",
        operation: "external_alert.acknowledge",
        ...accountResource(context),
        command: { alert_id: alertId },
        requestNonce,
      },
      alertMutationResponseSchema,
    );
  },

  getSettings(context: ExtensionContextValue) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/settings/get",
        operation: "settings.get",
        ...accountResource(context),
        command: {},
      },
      settingsResponseSchema,
    );
  },

  updateSettings(
    context: ExtensionContextValue,
    command: {
      readonly approver_user_ids: readonly string[];
      readonly expiration_days: 7;
      readonly onboarding_completed: boolean;
    },
    requestNonce: string,
  ) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/settings/update",
        operation: "settings.update",
        ...accountResource(context),
        command,
        requestNonce,
      },
      settingsResponseSchema,
    );
  },

  createAuditExport(context: ExtensionContextValue, requestNonce: string) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/audit/export",
        operation: "audit.export",
        ...accountResource(context),
        command: { format: "csv" },
        requestNonce,
      },
      auditExportResponseSchema,
    );
  },
} as const;
