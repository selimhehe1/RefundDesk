import type { CanonicalJsonValue, PilotOperation, SignedEnvelope } from "@refunddesk/contracts";
import type { IneligibilityCode, WorkflowStatus } from "@refunddesk/domain";

export type PilotEnvironment = "sandbox" | "test";
export type PilotPaymentResourceType = "charge" | "payment_intent";

export interface PilotSignedIdentity {
  readonly accountId: string;
  readonly environment: PilotEnvironment;
  readonly roles: SignedEnvelope["stripe_roles"];
  readonly userId: string;
}

export interface PilotTenantContext {
  readonly actor: {
    readonly id: string;
    readonly approverEnabled: boolean;
    readonly stripeUserId: string;
  };
  readonly environment: PilotEnvironment;
  readonly installationId: string;
  readonly installationStatus: "active" | "deauthorized" | "suspended";
  readonly stripeAccountId: string;
  readonly tenantId: string;
  readonly tenantStatus: "active" | "deauthorized" | "pending_deletion" | "suspended";
}

export interface PilotPaymentResource {
  readonly id: string;
  readonly type: PilotPaymentResourceType;
}

export interface PilotPayment {
  readonly amountCaptured: bigint;
  readonly amountRefunded: bigint;
  readonly captured: boolean;
  readonly chargeId: string;
  readonly currency: string;
  readonly disputed: boolean;
  readonly hasConnectSemantics: boolean;
  readonly paid: boolean;
  readonly paymentIntentId: string | null;
  readonly paymentKey: string;
  readonly paymentMethodType: string | null;
}

export interface PilotPaymentReader {
  retrievePayment(
    context: PilotTenantContext,
    resource: PilotPaymentResource,
  ): Promise<PilotPayment>;
}

export interface PilotRequestSummary {
  readonly amount_minor: string;
  readonly can_cancel: boolean;
  readonly can_decide: boolean;
  readonly created_at: string;
  readonly currency: string;
  readonly id: string;
  readonly is_requester: boolean;
  readonly justification: string | null;
  readonly requester_user_id: string;
  readonly resource_id: string;
  readonly resource_type: PilotPaymentResourceType;
  readonly status: WorkflowStatus;
}

export interface PilotRequestRecord extends PilotRequestSummary {
  readonly charge_id: string;
  readonly payment_intent_id: string | null;
}

export interface PilotActiveRequest {
  readonly id: string;
  readonly status: WorkflowStatus;
}

export interface PilotExternalAlert {
  readonly acknowledged: boolean;
  readonly amount_minor: string;
  readonly classification: "external" | "proof_replay" | "tampered";
  readonly currency: string;
  readonly detected_at: string;
  readonly id: string;
  readonly refund_id: string;
}

export interface PilotSettings {
  readonly approver_user_ids: readonly string[];
  readonly expiration_days: 7;
  readonly onboarding_completed: boolean;
}

export interface PilotPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface PilotStoredResponse {
  readonly body: Readonly<Record<string, CanonicalJsonValue>>;
  readonly status: number;
}

export interface PilotMutationReceipt {
  readonly actorId: string;
  readonly canonicalRequestHash: Uint8Array;
  readonly operation: PilotOperation;
  readonly response: PilotStoredResponse;
}

export interface PilotMutationMetadata {
  readonly actorId: string;
  readonly canonicalRequestHash: Uint8Array;
  readonly operation: PilotOperation;
  readonly requestNonce: string;
  readonly responseRequestId: string;
}

export type PilotMutation =
  | {
      readonly kind: "context_sync";
    }
  | {
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly justification: string;
      readonly kind: "refund_request_create";
      readonly payment: PilotPayment;
      readonly reason: "duplicate" | "fraudulent" | "requested_by_customer";
      readonly resource: PilotPaymentResource;
    }
  | {
      readonly decision: "approve" | "reject";
      readonly justification?: string;
      readonly kind: "refund_request_decide";
      readonly requestId: string;
      readonly resource: PilotPaymentResource;
    }
  | {
      readonly kind: "refund_request_cancel";
      readonly requestId: string;
      readonly resource: PilotPaymentResource;
    }
  | {
      readonly alertId: string;
      readonly kind: "external_alert_acknowledge";
    }
  | {
      readonly approverUserIds: readonly string[];
      readonly expirationDays: 7;
      readonly kind: "settings_update";
      readonly onboardingCompleted: boolean;
    }
  | {
      readonly format: "csv";
      readonly kind: "audit_export";
    };

export interface PilotRepository {
  resolveContext(
    identity: PilotSignedIdentity,
    options: { readonly allowProvision: boolean },
  ): Promise<PilotTenantContext | null>;

  findMutationReceipt(
    context: PilotTenantContext,
    requestNonce: string,
  ): Promise<PilotMutationReceipt | null>;

  executeMutation(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    mutation: PilotMutation,
  ): Promise<PilotStoredResponse>;

  storeMutationReceipt(
    context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    response: PilotStoredResponse,
  ): Promise<PilotStoredResponse>;

  findActiveRequest(
    context: PilotTenantContext,
    paymentKey: string,
  ): Promise<PilotActiveRequest | null>;

  listRefundRequests(
    context: PilotTenantContext,
    input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly scope: "all_activity" | "awaiting_my_approval" | "my_requests";
    },
  ): Promise<PilotPage<PilotRequestSummary>>;

  getRefundRequest(
    context: PilotTenantContext,
    requestId: string,
  ): Promise<PilotRequestRecord | null>;

  listExternalAlerts(
    context: PilotTenantContext,
    input: { readonly cursor?: string; readonly limit: number },
  ): Promise<PilotPage<PilotExternalAlert>>;

  getSettings(context: PilotTenantContext): Promise<PilotSettings>;
}

export interface PilotAccessPolicy {
  assertAllowed(
    context: PilotTenantContext,
    input: {
      readonly operation: PilotOperation;
      readonly mutation: boolean;
      readonly roles: SignedEnvelope["stripe_roles"];
    },
  ): void;
}

export interface PilotEligibilityDescription {
  readonly code: IneligibilityCode;
  readonly message: string;
}
