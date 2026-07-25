import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { z } from "zod";

import type { JsonValue } from "./canonical-json";
import {
  SignedExtensionRequestError,
  signedApiRequest,
  type PilotResourceType,
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
    can_decide: z.boolean(),
    can_cancel: z.boolean(),
    is_requester: z.boolean(),
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

const externalAlertSchema = z
  .object({
    id: z.uuid(),
    refund_id: z.string().regex(/^re_[A-Za-z0-9]+$/u),
    amount_minor: minorAmountSchema,
    classification: z.enum(["external", "tampered", "proof_replay"]),
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

const settingsResponseSchema = z
  .object({
    approver_user_ids: z.array(z.string().min(1).max(255)),
    expiration_days: z.literal(7),
    onboarding_completed: z.boolean(),
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

const phase0ProbeResponseSchema = z
  .object({
    request_id: z.uuid(),
    refund_id: z.string().regex(/^re_[A-Za-z0-9]+$/u),
    stripe_request_id: z.string().nullable(),
    correlation: z.string().min(1).max(64),
    replay: z.boolean(),
    status: z.string().min(1).max(64).nullable(),
  })
  .strict();

const phase0ReportResponseSchema = z
  .object({
    request_id: z.uuid(),
    environment: z.enum(["test", "sandbox"]),
    probe_count: z.number().int().nonnegative(),
    evidence_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    evidence: z.array(
      z
        .object({
          observed_at: z.iso.datetime(),
          refund_id: z.string().min(1).max(64),
          correlation: z.enum([
            "internal",
            "pending_correlation",
            "outside_workflow",
            "invalid_proof",
            "proof_replay",
          ]),
          request_bound: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type EligibilityResponse = z.infer<typeof eligibilityResponseSchema>;
export type RefundRequestSummary = z.infer<typeof refundRequestSummarySchema>;
export type RefundRequestListResponse = z.infer<typeof requestListResponseSchema>;
export type ExternalAlert = z.infer<typeof externalAlertSchema>;
export type ExternalAlertListResponse = z.infer<typeof externalAlertListResponseSchema>;
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

type RequestScope = "all_activity" | "awaiting_my_approval" | "my_requests";

function accountResource(context: ExtensionContextValue): {
  readonly resourceType: "account";
  readonly resourceId: string;
} {
  return {
    resourceType: "account",
    resourceId: context.userContext.account.id,
  };
}

async function requestAndParse<T extends z.ZodType>(
  context: ExtensionContextValue,
  input: {
    readonly endpoint: Parameters<typeof signedApiRequest>[1]["endpoint"];
    readonly operation: string;
    readonly resourceType: PilotResourceType;
    readonly resourceId: string;
    readonly command: JsonValue;
  },
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
    return requestAndParse(
      context,
      {
        endpoint: "/v1/context/sync",
        operation: "context.sync",
        ...accountResource(context),
        command: {},
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
  ) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/refund-requests/create",
        operation: "refund_request.create",
        ...resource,
        command,
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
    command: {
      readonly request_id: string;
      readonly decision: "approve" | "reject";
      readonly justification?: string;
    },
  ) {
    const canonicalCommand: JsonValue = {
      request_id: command.request_id,
      decision: command.decision,
      ...(command.justification === undefined ? {} : { justification: command.justification }),
    };
    return requestAndParse(
      context,
      {
        endpoint: "/v1/refund-requests/decide",
        operation: "refund_request.decide",
        ...resource,
        command: canonicalCommand,
      },
      requestMutationResponseSchema,
    );
  },

  cancelRefundRequest(
    context: ExtensionContextValue,
    resource: PaymentResource,
    requestId: string,
  ) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/refund-requests/cancel",
        operation: "refund_request.cancel",
        ...resource,
        command: { request_id: requestId },
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

  acknowledgeExternalAlert(context: ExtensionContextValue, alertId: string) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/external-alerts/acknowledge",
        operation: "external_alert.acknowledge",
        ...accountResource(context),
        command: { alert_id: alertId },
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
  ) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/settings/update",
        operation: "settings.update",
        ...accountResource(context),
        command,
      },
      settingsResponseSchema,
    );
  },

  createAuditExport(context: ExtensionContextValue) {
    return requestAndParse(
      context,
      {
        endpoint: "/v1/audit/export",
        operation: "audit.export",
        ...accountResource(context),
        command: { format: "csv" },
      },
      auditExportResponseSchema,
    );
  },

  runPhase0Probe(
    context: ExtensionContextValue,
    resource: PaymentResource,
    command: {
      readonly amount_minor: string;
      readonly currency: string;
      readonly reason: RefundReason;
    },
  ) {
    if (resource.resourceType !== "payment_intent") {
      throw new SignedExtensionRequestError(
        "REQUEST_FAILED",
        "The phase-0 probe requires a synthetic PaymentIntent.",
      );
    }
    return requestAndParse(
      context,
      {
        endpoint: "/internal/phase0/refund-probe",
        operation: "phase0.refund_probe",
        ...resource,
        command,
      },
      phase0ProbeResponseSchema,
    );
  },

  getPhase0Report(context: ExtensionContextValue, resource: PaymentResource) {
    if (resource.resourceType !== "payment_intent") {
      throw new SignedExtensionRequestError(
        "REQUEST_FAILED",
        "The phase-0 report requires a synthetic PaymentIntent.",
      );
    }
    return requestAndParse(
      context,
      {
        endpoint: "/internal/phase0/report",
        operation: "phase0.report",
        ...resource,
        command: {},
      },
      phase0ReportResponseSchema,
    );
  },
} as const;
