import { z } from "zod";

export const uuidSchema = z.uuid();
export const moneyMinorSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u)
  .max(32);
export const currencySchema = z.string().regex(/^[a-z]{3}$/u);
export const stripeIdSchema = z
  .string()
  .regex(/^[a-z]+_[A-Za-z0-9]+$/u)
  .max(255);
export const stripeAccountIdSchema = z
  .string()
  .regex(/^acct_[A-Za-z0-9]+$/u)
  .max(255);
export const stripeUserIdSchema = z
  .string()
  .regex(/^usr_[A-Za-z0-9]+$/u)
  .max(255);
export const refundReasonSchema = z.enum(["duplicate", "fraudulent", "requested_by_customer"]);
export const environmentSchema = z.enum(["live", "test", "sandbox"]);
export const resourceTypeSchema = z.enum(["account", "payment_intent", "charge"]);

export const stripeRoleSchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z.enum(["builtIn", "custom"]),
  })
  .strict();

export const signedEnvelopeSchema = z
  .object({
    operation: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/u),
    request_nonce: uuidSchema,
    mode: z.enum(["live", "test"]),
    is_sandbox: z.boolean(),
    resource_type: resourceTypeSchema,
    resource_id: stripeIdSchema,
    command_json: z.string().min(2).max(8_192),
    stripe_roles: z.array(stripeRoleSchema).max(32),
    user_id: stripeUserIdSchema,
    account_id: stripeAccountIdSchema,
  })
  .strict();

export const refundRequestCommandSchema = z
  .object({
    amount_minor: moneyMinorSchema.refine((value) => BigInt(value) > 0n, "Amount must be positive"),
    currency: currencySchema,
    reason: refundReasonSchema,
    justification: z.string().trim().min(10).max(2_000),
  })
  .strict();

export const decisionCommandSchema = z
  .object({
    request_id: uuidSchema,
    decision: z.enum(["approve", "reject"]),
    justification: z.string().trim().min(10).max(2_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "reject" && value.justification === undefined) {
      context.addIssue({
        code: "custom",
        path: ["justification"],
        message: "A rejection justification is required",
      });
    }
  });

export const requestIdCommandSchema = z
  .object({
    request_id: uuidSchema,
  })
  .strict();

export const requestListCommandSchema = z
  .object({
    scope: z.enum(["awaiting_my_approval", "my_requests", "all_activity"]),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const alertListCommandSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const alertAcknowledgeCommandSchema = z
  .object({
    alert_id: uuidSchema,
  })
  .strict();

export const settingsUpdateCommandSchema = z
  .object({
    approver_user_ids: z.array(stripeUserIdSchema).max(100),
    expiration_days: z.literal(7),
    onboarding_completed: z.boolean(),
  })
  .strict();

export const auditExportCommandSchema = z
  .object({
    format: z.literal("csv"),
  })
  .strict();

export const emptyCommandSchema = z.object({}).strict();

export const cursorPageSchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

export const apiErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    request_id: uuidSchema,
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type SignedEnvelope = z.infer<typeof signedEnvelopeSchema>;
export type RefundRequestCommand = z.infer<typeof refundRequestCommandSchema>;
export type DecisionCommand = z.infer<typeof decisionCommandSchema>;
export type Environment = z.infer<typeof environmentSchema>;
