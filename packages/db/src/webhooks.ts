import {
  assertNormalizedAccountWebhookRowConsistency,
  storedWebhookEndpointSchema,
  type NormalizedAccountWebhookPayload,
  type StoredWebhookEndpoint,
} from "./connected-webhook.js";

import type { PrismaClient, ReceiptStatus } from "./generated/prisma/client.js";

const STRIPE_EVENT_PATTERN = /^evt_[A-Za-z0-9]+$/u;
const STRIPE_ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]+$/u;

export interface ExistingWebhookReceipt {
  readonly tenantId: string;
  readonly installationId: string;
  readonly receiptId: string;
  readonly status: ReceiptStatus;
}

export interface RecoverableWebhookReceipt extends ExistingWebhookReceipt {
  readonly endpoint: StoredWebhookEndpoint;
  readonly stripeEventId: string;
  readonly stripeAccountId: string;
  readonly eventType: NormalizedAccountWebhookPayload["event_type"];
  readonly objectId: string;
  readonly stripeCreatedAt: Date;
  readonly normalizedPayload: NormalizedAccountWebhookPayload;
  readonly processingAttempts: number;
}

interface ExistingWebhookReceiptRow {
  readonly tenant_id: string;
  readonly installation_id: string;
  readonly receipt_id: string;
  readonly receipt_status: ReceiptStatus;
}

interface RecoverableWebhookReceiptRow extends ExistingWebhookReceiptRow {
  readonly endpoint: string;
  readonly stripe_event_id: string;
  readonly stripe_account_id: string;
  readonly event_type: string;
  readonly object_id: string;
  readonly stripe_created_at: Date;
  readonly normalized_payload: unknown;
  readonly processing_attempts: number;
}

function assertStripeEventId(stripeEventId: string): void {
  if (!STRIPE_EVENT_PATTERN.test(stripeEventId)) {
    throw new TypeError("Invalid Stripe event ID");
  }
}

function assertStripeAccountId(stripeAccountId: string): void {
  if (!STRIPE_ACCOUNT_PATTERN.test(stripeAccountId)) {
    throw new TypeError("Invalid Stripe account ID");
  }
}

export async function findWebhookReceipt(
  client: PrismaClient,
  endpoint: StoredWebhookEndpoint,
  stripeEventId: string,
  stripeAccountId: string,
): Promise<ExistingWebhookReceipt | null> {
  storedWebhookEndpointSchema.parse(endpoint);
  assertStripeEventId(stripeEventId);
  assertStripeAccountId(stripeAccountId);
  const rows = await client.$queryRaw<readonly ExistingWebhookReceiptRow[]>`
    SELECT tenant_id, installation_id, receipt_id, receipt_status
    FROM refunddesk_find_webhook_receipt_v2(
      ${endpoint}::webhook_endpoint,
      ${stripeEventId}::VARCHAR,
      ${stripeAccountId}::VARCHAR
    )
  `;
  const row = rows[0];
  return row === undefined
    ? null
    : {
        tenantId: row.tenant_id,
        installationId: row.installation_id,
        receiptId: row.receipt_id,
        status: row.receipt_status,
      };
}

export async function listRecoverableWebhookReceipts(
  client: PrismaClient,
  limit = 100,
): Promise<readonly RecoverableWebhookReceipt[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Webhook recovery limit must be between 1 and 1000");
  }
  const rows = await client.$queryRaw<readonly RecoverableWebhookReceiptRow[]>`
    SELECT
      tenant_id,
      installation_id,
      receipt_id,
      endpoint,
      stripe_event_id,
      stripe_account_id,
      event_type,
      object_id,
      stripe_created_at,
      normalized_payload,
      receipt_status,
      processing_attempts
    FROM refunddesk_list_recoverable_webhook_receipts_v2(${limit}::INTEGER)
  `;
  return rows.map((row) => {
    const endpoint = storedWebhookEndpointSchema.parse(row.endpoint);
    assertStripeEventId(row.stripe_event_id);
    assertStripeAccountId(row.stripe_account_id);
    const normalizedPayload = assertNormalizedAccountWebhookRowConsistency({
      endpoint,
      eventType: row.event_type,
      objectId: row.object_id,
      stripeCreatedAt: row.stripe_created_at,
      normalizedPayload: row.normalized_payload,
    });
    return {
      tenantId: row.tenant_id,
      installationId: row.installation_id,
      receiptId: row.receipt_id,
      endpoint,
      stripeEventId: row.stripe_event_id,
      stripeAccountId: row.stripe_account_id,
      eventType: normalizedPayload.event_type,
      objectId: row.object_id,
      stripeCreatedAt: row.stripe_created_at,
      normalizedPayload,
      status: row.receipt_status,
      processingAttempts: row.processing_attempts,
    };
  });
}
