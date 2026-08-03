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
    id: z.string().min(1).max(255).optional(),
    type: z.enum(["builtIn", "custom"]),
    name: z.string().min(1).max(255),
  })
  .strict();

const signedEnvelopeBase = {
  operation: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/u),
  request_nonce: uuidSchema,
  mode: z.enum(["live", "test"]),
  is_sandbox: z.boolean(),
  command_json: z.string().min(2).max(8_192),
  user_id: stripeUserIdSchema,
  account_id: stripeAccountIdSchema,
} as const;

const assertedRoles = {
  roles_asserted: z.literal(true),
  stripe_roles: z.array(stripeRoleSchema).min(1).max(32),
} as const;

const unassertedRoles = {
  roles_asserted: z.literal(false),
} as const;

const accountResource = {
  resource_type: z.literal("account"),
} as const;

const paymentResource = {
  resource_type: z.enum(["payment_intent", "charge"]),
  resource_id: stripeIdSchema,
} as const;

export const signedEnvelopeSchema = z.union([
  z.object({ ...signedEnvelopeBase, ...accountResource, ...unassertedRoles }).strict(),
  z.object({ ...signedEnvelopeBase, ...accountResource, ...assertedRoles }).strict(),
  z.object({ ...signedEnvelopeBase, ...paymentResource, ...unassertedRoles }).strict(),
  z.object({ ...signedEnvelopeBase, ...paymentResource, ...assertedRoles }).strict(),
]);

export const refundRequestCommandSchema = z
  .object({
    amount_minor: moneyMinorSchema.refine((value) => BigInt(value) > 0n, "Amount must be positive"),
    currency: currencySchema,
    reason: refundReasonSchema,
    justification: z.string().trim().min(10).max(2_000),
  })
  .strict();

export const approvalSnapshotSchema = z
  .object({
    amount_minor: moneyMinorSchema.refine((value) => BigInt(value) > 0n, "Amount must be positive"),
    currency: currencySchema,
    reason: refundReasonSchema,
    requester_user_id: stripeUserIdSchema,
  })
  .strict();

const approveDecisionCommandSchema = z
  .object({
    request_id: uuidSchema,
    decision: z.literal("approve"),
    expected_request_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    approval_snapshot: approvalSnapshotSchema,
  })
  .strict();

const rejectDecisionCommandSchema = z
  .object({
    request_id: uuidSchema,
    decision: z.literal("reject"),
    justification: z.string().trim().min(10).max(2_000),
  })
  .strict();

export const decisionCommandSchema = z.discriminatedUnion("decision", [
  approveDecisionCommandSchema,
  rejectDecisionCommandSchema,
]);

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

/**
 * `context.sync` may carry the Dashboard display name of the signing user, which the
 * Stripe extension context provides without any additional permission. It lets Settings
 * offer a list of people to tick instead of demanding raw `usr_…` identifiers.
 *
 * The field is optional so an already-installed extension version, which sends `{}`,
 * stays valid.
 */
export const contextSyncCommandSchema = z
  .object({
    display_name: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

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
export type StripeRole = z.infer<typeof stripeRoleSchema>;
export type RefundRequestCommand = z.infer<typeof refundRequestCommandSchema>;
export type ApprovalSnapshot = z.infer<typeof approvalSnapshotSchema>;
export type DecisionCommand = z.infer<typeof decisionCommandSchema>;
export type Environment = z.infer<typeof environmentSchema>;
