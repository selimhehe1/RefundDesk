import { z } from "zod";

import {
  normalizedInstallationWebhookPayloadSchema,
  normalizedRefundWebhookPayloadSchema,
  normalizedWebhookRefundSchema,
} from "@refunddesk/db";

export const QUEUES = {
  executeRefund: "refunddesk_refund_execute",
  processWebhook: "refunddesk_webhook_process",
  recoverWebhooks: "refunddesk_webhook_recovery",
  recoverApproved: "refunddesk_approved_recovery",
  scanRefunds: "refunddesk_refund_scan",
  expireRequests: "refunddesk_request_expire",
} as const;

const uuid = z.uuid();

export const executeRefundJobSchema = z
  .object({
    tenant_id: uuid,
    request_id: uuid,
  })
  .strict();

export type ExecuteRefundJob = z.infer<typeof executeRefundJobSchema>;

export const refundObservationSchema = normalizedWebhookRefundSchema;

export type RefundObservationJobData = z.infer<typeof refundObservationSchema>;

const webhookJobIdentitySchema = z
  .object({
    tenant_id: uuid,
    installation_id: uuid,
    receipt_id: uuid,
    stripe_event_id: z
      .string()
      .regex(/^evt_[A-Za-z0-9]+$/u)
      .max(255),
    stripe_account_id: z
      .string()
      .regex(/^acct_[A-Za-z0-9]+$/u)
      .max(255),
  })
  .strict();

export const processWebhookJobSchema = z.union([
  webhookJobIdentitySchema.extend(normalizedRefundWebhookPayloadSchema.shape).strict(),
  webhookJobIdentitySchema.extend(normalizedInstallationWebhookPayloadSchema.shape).strict(),
]);

export type ProcessWebhookJob = z.infer<typeof processWebhookJobSchema>;

export const recoverWebhooksJobSchema = z
  .object({
    scope: z.literal("recoverable"),
  })
  .strict();

export type RecoverWebhooksJob = z.infer<typeof recoverWebhooksJobSchema>;

export const recoverApprovedJobSchema = z
  .object({
    scope: z.literal("approved"),
  })
  .strict();

export type RecoverApprovedJob = z.infer<typeof recoverApprovedJobSchema>;

export const scanRefundsJobSchema = z
  .object({
    scope: z.literal("all"),
  })
  .strict();

export type ScanRefundsJob = z.infer<typeof scanRefundsJobSchema>;

export const expireRequestsJobSchema = z
  .object({
    scope: z.literal("due"),
  })
  .strict();

export type ExpireRequestsJob = z.infer<typeof expireRequestsJobSchema>;
