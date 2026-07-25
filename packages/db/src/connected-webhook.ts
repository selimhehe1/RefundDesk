import { z } from "zod";

const currencySchema = z.string().regex(/^[a-z]{3}$/u);

export const connectedWebhookEnvironmentSchema = z.enum(["test", "sandbox"]);
export type ConnectedWebhookEnvironment = z.infer<typeof connectedWebhookEnvironmentSchema>;

export const connectedWebhookEndpointSchema = z.enum(["connected_test", "connected_sandbox"]);
export type ConnectedWebhookEndpoint = z.infer<typeof connectedWebhookEndpointSchema>;

export const connectedWebhookEventTypeSchema = z.enum([
  "refund.created",
  "refund.updated",
  "refund.failed",
  "account.application.authorized",
  "account.application.deauthorized",
]);
export type ConnectedWebhookEventType = z.infer<typeof connectedWebhookEventTypeSchema>;

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
  environment: connectedWebhookEnvironmentSchema,
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

export const normalizedConnectedWebhookPayloadSchema = z.union([
  normalizedRefundWebhookPayloadSchema,
  normalizedInstallationWebhookPayloadSchema,
]);

export type NormalizedRefundWebhookPayload = z.infer<typeof normalizedRefundWebhookPayloadSchema>;
export type NormalizedInstallationWebhookPayload = z.infer<
  typeof normalizedInstallationWebhookPayloadSchema
>;
export type NormalizedConnectedWebhookPayload = z.infer<
  typeof normalizedConnectedWebhookPayloadSchema
>;

export function endpointForWebhookEnvironment(
  environment: ConnectedWebhookEnvironment,
): ConnectedWebhookEndpoint {
  return environment === "test" ? "connected_test" : "connected_sandbox";
}

export function assertNormalizedWebhookRowConsistency(input: {
  readonly endpoint: ConnectedWebhookEndpoint;
  readonly eventType: string;
  readonly objectId: string | null;
  readonly stripeCreatedAt: Date;
  readonly normalizedPayload: unknown;
}): NormalizedConnectedWebhookPayload {
  const payload = normalizedConnectedWebhookPayloadSchema.parse(input.normalizedPayload);
  if (endpointForWebhookEnvironment(payload.environment) !== input.endpoint) {
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
