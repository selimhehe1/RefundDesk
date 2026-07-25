import {
  evaluatePaymentEligibility,
  normalizeCurrency,
  refundIdempotencyKey,
} from "@refunddesk/domain";

import { executeRefundJobSchema, type ExecuteRefundJob } from "./jobs.js";
import type {
  Clock,
  CrashHooks,
  RefundExecutionRecord,
  RefundProofSigner,
  StripeGateway,
  WorkerLogger,
  WorkerStore,
} from "./ports.js";
import { assertPilotInstallation } from "./safety.js";
import { normalizeStripeFailure } from "./stripe-failure.js";

export class RetryableWorkerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("A retryable worker operation failed");
    this.name = "RetryableWorkerError";
    this.code = code;
  }
}

export interface RefundExecutionDependencies {
  readonly store: WorkerStore;
  readonly stripe: StripeGateway;
  readonly proofs: RefundProofSigner;
  readonly clock: Clock;
  readonly logger: WorkerLogger;
  readonly crashHooks?: CrashHooks;
}

function paymentIdentityMatches(
  record: RefundExecutionRecord,
  payment: Awaited<ReturnType<StripeGateway["retrievePayment"]>>,
): boolean {
  if (payment.paymentKey !== record.paymentKey || payment.chargeId !== record.chargeId) {
    return false;
  }
  return record.paymentIntentId === null || payment.paymentIntentId === record.paymentIntentId;
}

function refundResponseMatches(
  record: RefundExecutionRecord,
  refund: Awaited<ReturnType<StripeGateway["createRefund"]>>,
): boolean {
  const targetMatches =
    record.resourceType === "payment_intent"
      ? refund.paymentIntentId === record.resourceId
      : refund.chargeId === record.resourceId;
  return (
    targetMatches &&
    refund.amountMinor === record.amountMinor &&
    normalizeCurrency(refund.currency) === normalizeCurrency(record.currency)
  );
}

async function markPreflightFailure(
  dependencies: RefundExecutionDependencies,
  record: RefundExecutionRecord,
  code: string,
  ambiguous: boolean,
): Promise<void> {
  const at = dependencies.clock.now();
  if (ambiguous || record.effectState === "possible") {
    await dependencies.store.recordReconciliationRequired({
      tenantId: record.tenantId,
      requestId: record.requestId,
      errorCode: code,
      at,
    });
    dependencies.logger.warn(
      {
        code,
        tenantId: record.tenantId,
        requestId: record.requestId,
      },
      "Refund execution requires reconciliation before an effect retry",
    );
    return;
  }

  await dependencies.store.recordTerminalWithoutEffect({
    tenantId: record.tenantId,
    requestId: record.requestId,
    errorCode: code,
    at,
  });
}

export async function handleRefundExecutionJob(
  untrustedJob: unknown,
  dependencies: RefundExecutionDependencies,
): Promise<void> {
  const job: ExecuteRefundJob = executeRefundJobSchema.parse(untrustedJob);
  const record = await dependencies.store.loadRefundExecution(job.tenant_id, job.request_id);
  if (record === null) {
    dependencies.logger.info(
      { tenantId: job.tenant_id, requestId: job.request_id },
      "Refund execution job has no executable request",
    );
    return;
  }

  assertPilotInstallation(record.installation);
  const idempotencyKey = refundIdempotencyKey(record.requestId);

  let payment: Awaited<ReturnType<StripeGateway["retrievePayment"]>>;
  try {
    payment = await dependencies.stripe.retrievePayment(
      record.installation,
      record.resourceType,
      record.resourceId,
    );
  } catch (error: unknown) {
    const failure = normalizeStripeFailure(
      error,
      record.effectState === "possible" || record.effectState === "identified",
    );
    if (failure.classification === "retryable") {
      dependencies.logger.warn(
        {
          code: failure.code,
          tenantId: record.tenantId,
          requestId: record.requestId,
        },
        "Stripe payment revalidation will retry",
      );
      throw new RetryableWorkerError(failure.code);
    }
    await markPreflightFailure(
      dependencies,
      record,
      failure.code,
      failure.classification === "ambiguous",
    );
    return;
  }

  if (!paymentIdentityMatches(record, payment)) {
    await markPreflightFailure(
      dependencies,
      record,
      "PAYMENT_IDENTITY_MISMATCH",
      record.effectState === "possible",
    );
    return;
  }

  const eligibility = evaluatePaymentEligibility({
    ...payment,
    requestedAmountMinor: record.amountMinor,
    requestedCurrency: record.currency,
  });
  if (!eligibility.eligible) {
    await markPreflightFailure(
      dependencies,
      record,
      eligibility.code,
      record.effectState === "possible",
    );
    return;
  }

  await dependencies.crashHooks?.beforeEffectBoundary?.();

  const boundary = await dependencies.store.persistEffectBoundary({
    tenantId: record.tenantId,
    requestId: record.requestId,
    idempotencyKey,
    at: dependencies.clock.now(),
  });
  if (boundary.kind !== "execute") {
    dependencies.logger.info(
      {
        outcome: boundary.kind,
        tenantId: record.tenantId,
        requestId: record.requestId,
      },
      "Refund execution stopped at the durable effect boundary",
    );
    return;
  }
  if (boundary.idempotencyKey !== idempotencyKey) {
    throw new Error("IDEMPOTENCY_KEY_INVARIANT_VIOLATION");
  }

  await dependencies.crashHooks?.afterEffectBoundary?.();

  const proof = dependencies.proofs.sign({
    tenantId: record.tenantId,
    requestId: record.requestId,
    stripeAccountId: record.installation.stripeAccountId,
    paymentKey: record.paymentKey,
    amountMinor: record.amountMinor,
    currency: record.currency,
    environment: record.installation.environment,
  });

  let refund: Awaited<ReturnType<StripeGateway["createRefund"]>>;
  try {
    refund = await dependencies.stripe.createRefund({
      installation: record.installation,
      ...(record.resourceType === "payment_intent"
        ? { paymentIntentId: record.resourceId }
        : { chargeId: record.resourceId }),
      amountMinor: record.amountMinor,
      reason: record.reason,
      metadata: {
        refunddesk_request_id: record.requestId,
        refunddesk_proof: proof,
      },
      idempotencyKey,
    });
  } catch (error: unknown) {
    const failure = normalizeStripeFailure(error, true);
    const failureInput = {
      tenantId: record.tenantId,
      requestId: record.requestId,
      attemptId: boundary.attemptId,
      errorCode: failure.code,
      at: dependencies.clock.now(),
    };
    if (failure.classification === "ambiguous") {
      await dependencies.store.recordAmbiguousAttemptFailure(failureInput);
      dependencies.logger.warn(
        {
          code: failure.code,
          tenantId: record.tenantId,
          requestId: record.requestId,
        },
        "Ambiguous Stripe outcome moved to reconciliation",
      );
      return;
    }
    if (failure.classification === "terminal") {
      await dependencies.store.recordTerminalAttemptWithoutEffect(failureInput);
      return;
    }

    await dependencies.store.recordRetryableAttemptFailure(failureInput);
    dependencies.logger.warn(
      {
        code: failure.code,
        tenantId: record.tenantId,
        requestId: record.requestId,
      },
      "Stripe refund attempt will retry with the same idempotency key",
    );
    throw new RetryableWorkerError(failure.code);
  }

  await dependencies.crashHooks?.afterStripeResponse?.();

  await dependencies.store.recordIdentifiedRefund({
    tenantId: record.tenantId,
    requestId: record.requestId,
    attemptId: boundary.attemptId,
    idempotencyKey,
    refundId: refund.id,
    refundStatus: refund.status,
    stripeRequestId: refund.requestId,
    responseMatchesRequest: refundResponseMatches(record, refund),
    at: dependencies.clock.now(),
  });

  await dependencies.crashHooks?.afterIdentifiedPersisted?.();

  dependencies.logger.info(
    {
      refundId: refund.id,
      tenantId: record.tenantId,
      requestId: record.requestId,
    },
    "Stripe Refund identity persisted",
  );
}
