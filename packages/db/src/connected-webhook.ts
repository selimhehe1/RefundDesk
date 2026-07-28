import { z } from "zod";

const currencySchema = z.string().regex(/^[a-z]{3}$/u);

export const accountWebhookEnvironmentSchema = z.enum(["test", "sandbox"]);
export type AccountWebhookEnvironment = z.infer<typeof accountWebhookEnvironmentSchema>;

export const accountWebhookEndpointSchema = z.enum(["account_test", "account_sandbox"]);
export type AccountWebhookEndpoint = z.infer<typeof accountWebhookEndpointSchema>;

export const legacyConnectedWebhookEndpointSchema = z.enum(["connected_test", "connected_sandbox"]);
export type LegacyConnectedWebhookEndpoint = z.infer<typeof legacyConnectedWebhookEndpointSchema>;

export const storedWebhookEndpointSchema = z.union([
  accountWebhookEndpointSchema,
  legacyConnectedWebhookEndpointSchema,
]);
export type StoredWebhookEndpoint = z.infer<typeof storedWebhookEndpointSchema>;

/** @deprecated Use accountWebhookEnvironmentSchema. */
export const connectedWebhookEnvironmentSchema = accountWebhookEnvironmentSchema;
/** @deprecated Use AccountWebhookEnvironment. */
export type ConnectedWebhookEnvironment = AccountWebhookEnvironment;
/** @deprecated Historical endpoint labels are recovery-only. */
export const connectedWebhookEndpointSchema = legacyConnectedWebhookEndpointSchema;
/** @deprecated Historical endpoint labels are recovery-only. */
export type ConnectedWebhookEndpoint = LegacyConnectedWebhookEndpoint;

export const accountWebhookEventTypeSchema = z.enum([
  "refund.created",
  "refund.updated",
  "refund.failed",
  "account.application.authorized",
  "account.application.deauthorized",
]);
export type AccountWebhookEventType = z.infer<typeof accountWebhookEventTypeSchema>;

/** @deprecated Use accountWebhookEventTypeSchema. */
export const connectedWebhookEventTypeSchema = accountWebhookEventTypeSchema;
/** @deprecated Use AccountWebhookEventType. */
export type ConnectedWebhookEventType = AccountWebhookEventType;

export const refundWebhookEventTypeSchema = z.enum([
  "refund.created",
  "refund.updated",
  "refund.failed",
]);
export type RefundWebhookEventType = z.infer<typeof refundWebhookEventTypeSchema>;

const stripeObjectId = z
  .string()
  .regex(/^[a-z]+_[A-Za-z0-9]+$/u)
  .max(255);
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .max(32);
const optionalMetadataValue = z.string().min(1).max(255).nullable();

export const normalizedWebhookRefundSchema = z
  .object({
    refund_id: z
      .string()
      .regex(/^re_[A-Za-z0-9]+$/u)
      .max(255),
    payment_intent_id: z
      .string()
      .regex(/^pi_[A-Za-z0-9]+$/u)
      .max(255)
      .nullable(),
    charge_id: z
      .string()
      .regex(/^ch_[A-Za-z0-9]+$/u)
      .max(255)
      .nullable(),
    amount_minor: positiveAmountMinor,
    currency: currencySchema,
    status: z.enum(["pending", "requires_action", "succeeded", "failed", "canceled"]).nullable(),
    created: z.number().int().nonnegative(),
    metadata_request_id: optionalMetadataValue,
    metadata_proof: optionalMetadataValue,
  })
  .strict()
  .superRefine((refund, context) => {
    if (refund.payment_intent_id === null && refund.charge_id === null) {
      context.addIssue({
        code: "custom",
        path: ["payment_intent_id"],
        message: "A refund must reference a PaymentIntent or Charge",
      });
    }
  });

export type NormalizedWebhookRefund = z.infer<typeof normalizedWebhookRefundSchema>;

const durableWebhookBase = z.object({
  schema_version: z.literal(1),
  environment: accountWebhookEnvironmentSchema,
  event_created: z.number().int().nonnegative(),
  event_idempotency_key: z.string().min(1).max(255).nullable(),
});

export const normalizedRefundWebhookPayloadSchema = durableWebhookBase
  .extend({
    event_type: refundWebhookEventTypeSchema,
    refund: normalizedWebhookRefundSchema,
  })
  .strict();

export const normalizedInstallationWebhookPayloadSchema = durableWebhookBase
  .extend({
    event_type: z.enum(["account.application.authorized", "account.application.deauthorized"]),
    application_id: stripeObjectId,
  })
  .strict();

export const normalizedAccountWebhookPayloadSchema = z.union([
  normalizedRefundWebhookPayloadSchema,
  normalizedInstallationWebhookPayloadSchema,
]);

export type NormalizedRefundWebhookPayload = z.infer<typeof normalizedRefundWebhookPayloadSchema>;
export type NormalizedInstallationWebhookPayload = z.infer<
  typeof normalizedInstallationWebhookPayloadSchema
>;
export type NormalizedAccountWebhookPayload = z.infer<typeof normalizedAccountWebhookPayloadSchema>;

/** @deprecated The normalized payload is shared with the direct account webhook contract. */
export const normalizedConnectedWebhookPayloadSchema = normalizedAccountWebhookPayloadSchema;
/** @deprecated Use NormalizedAccountWebhookPayload. */
export type NormalizedConnectedWebhookPayload = NormalizedAccountWebhookPayload;

export function accountEndpointForWebhookEnvironment(
  environment: AccountWebhookEnvironment,
): AccountWebhookEndpoint {
  return environment === "test" ? "account_test" : "account_sandbox";
}

export function environmentForStoredWebhookEndpoint(
  endpoint: StoredWebhookEndpoint,
): AccountWebhookEnvironment {
  return endpoint === "account_test" || endpoint === "connected_test" ? "test" : "sandbox";
}

/** @deprecated Use accountEndpointForWebhookEnvironment. */
export const endpointForWebhookEnvironment = accountEndpointForWebhookEnvironment;

export function assertNormalizedAccountWebhookRowConsistency(input: {
  readonly endpoint: StoredWebhookEndpoint;
  readonly eventType: string;
  readonly objectId: string | null;
  readonly stripeCreatedAt: Date;
  readonly normalizedPayload: unknown;
}): NormalizedAccountWebhookPayload {
  const payload = normalizedAccountWebhookPayloadSchema.parse(input.normalizedPayload);
  if (environmentForStoredWebhookEndpoint(input.endpoint) !== payload.environment) {
    throw new TypeError("Webhook endpoint and normalized environment differ");
  }
  if (payload.event_type !== input.eventType) {
    throw new TypeError("Webhook event type and normalized payload differ");
  }
  const expectedObjectId = "refund" in payload ? payload.refund.refund_id : payload.application_id;
  if (expectedObjectId !== input.objectId) {
    throw new TypeError("Webhook object ID and normalized payload differ");
  }
  if (input.stripeCreatedAt.getTime() !== payload.event_created * 1_000) {
    throw new TypeError("Webhook creation time and normalized payload differ");
  }
  return payload;
}

/** @deprecated Use assertNormalizedAccountWebhookRowConsistency. */
export function assertNormalizedWebhookRowConsistency(input: {
  readonly endpoint: StoredWebhookEndpoint;
  readonly eventType: string;
  readonly objectId: string | null;
  readonly stripeCreatedAt: Date;
  readonly normalizedPayload: unknown;
}): NormalizedAccountWebhookPayload {
  return assertNormalizedAccountWebhookRowConsistency(input);
}
