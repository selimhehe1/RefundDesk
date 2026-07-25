import {
  processWebhookJobSchema,
  type ProcessWebhookJob,
  type RefundObservationJobData,
} from "./jobs.js";
import type { Clock, RefundObservation, WorkerLogger, WorkerStore } from "./ports.js";

export interface WebhookProcessingDependencies {
  readonly store: WorkerStore;
  readonly clock: Clock;
  readonly logger: WorkerLogger;
}

export function refundObservationFromJob(refund: RefundObservationJobData): RefundObservation {
  return {
    refundId: refund.refund_id,
    paymentIntentId: refund.payment_intent_id,
    chargeId: refund.charge_id,
    amountMinor: BigInt(refund.amount_minor),
    currency: refund.currency,
    status: refund.status,
    created: refund.created,
    metadataRequestId: refund.metadata_request_id,
    metadataProof: refund.metadata_proof,
  };
}

export async function handleWebhookJob(
  untrustedJob: unknown,
  dependencies: WebhookProcessingDependencies,
): Promise<void> {
  let job: ProcessWebhookJob;
  try {
    job = processWebhookJobSchema.parse(untrustedJob);
  } catch {
    throw new Error("WEBHOOK_JOB_INVALID");
  }

  try {
    if ("refund" in job) {
      await dependencies.store.observeRefund({
        tenantId: job.tenant_id,
        installationId: job.installation_id,
        environment: job.environment,
        refund: refundObservationFromJob(job.refund),
        source: {
          kind: "webhook",
          receiptId: job.receipt_id,
          stripeEventId: job.stripe_event_id,
          stripeAccountId: job.stripe_account_id,
          eventIdempotencyKey: job.event_idempotency_key,
          eventType: job.event_type,
          eventCreated: job.event_created,
        },
        observedAt: dependencies.clock.now(),
      });
    } else {
      await dependencies.store.processInstallationLifecycle({
        tenantId: job.tenant_id,
        installationId: job.installation_id,
        receiptId: job.receipt_id,
        stripeEventId: job.stripe_event_id,
        stripeAccountId: job.stripe_account_id,
        environment: job.environment,
        eventType: job.event_type,
        eventCreated: job.event_created,
        eventIdempotencyKey: job.event_idempotency_key,
        applicationId: job.application_id,
        processedAt: dependencies.clock.now(),
      });
    }
  } catch {
    try {
      await dependencies.store.markWebhookReceiptFailed(
        job.tenant_id,
        job.receipt_id,
        "WEBHOOK_PROCESSING_FAILED",
      );
    } catch {
      dependencies.logger.warn(
        {
          code: "WEBHOOK_RECEIPT_FAILURE_MARK_FAILED",
          receiptId: job.receipt_id,
          tenantId: job.tenant_id,
        },
        "Webhook receipt failure state could not be persisted",
      );
    }
    throw new Error("WEBHOOK_PROCESSING_FAILED");
  }

  dependencies.logger.info(
    {
      eventType: job.event_type,
      stripeEventId: job.stripe_event_id,
      tenantId: job.tenant_id,
    },
    "Verified Stripe webhook observation processed asynchronously",
  );
}
