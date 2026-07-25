import type { NormalizedRefund } from "@refunddesk/stripe-adapter";

import { scanRefundsJobSchema, type ScanRefundsJob } from "./jobs.js";
import type {
  Clock,
  RefundObservation,
  ScannableWorkerInstallation,
  StripeGateway,
  WorkerLogger,
  WorkerStore,
} from "./ports.js";

const OVERLAP_MILLISECONDS = 60 * 60 * 1_000;
const MAX_PAGES_PER_INSTALLATION = 10_000;
const LINKED_REFUND_PAGE_SIZE = 100;
const MAX_LINKED_REFUND_PAGES_PER_INSTALLATION = 10_000;

export interface ReconciliationScannerDependencies {
  readonly store: WorkerStore;
  readonly stripe: StripeGateway;
  readonly clock: Clock;
  readonly logger: WorkerLogger;
}

type PilotScannableInstallation = ScannableWorkerInstallation & {
  readonly environment: "test" | "sandbox";
};

function isPilotScannableInstallation(
  installation: ScannableWorkerInstallation,
): installation is PilotScannableInstallation {
  return (
    installation.active && installation.environment !== "live" && !installation.tenantLiveEnabled
  );
}

function observationFromStripe(refund: NormalizedRefund): RefundObservation {
  return {
    refundId: refund.id,
    paymentIntentId: refund.paymentIntentId,
    chargeId: refund.chargeId,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    status: refund.status,
    created: refund.created,
    metadataRequestId: refund.metadata["refunddesk_request_id"] ?? null,
    metadataProof: refund.metadata["refunddesk_proof"] ?? null,
  };
}

function stripeTimestamp(date: Date): number {
  return Math.max(0, Math.floor(date.getTime() / 1_000));
}

async function refreshLinkedRefunds(
  installation: PilotScannableInstallation,
  dependencies: ReconciliationScannerDependencies,
  scanWindowEnd: Date,
): Promise<number> {
  let afterRequestId: string | null = null;
  let pageCount = 0;
  let failedRefundCount = 0;

  for (;;) {
    if (pageCount >= MAX_LINKED_REFUND_PAGES_PER_INSTALLATION) {
      throw new Error("LINKED_REFUND_SCAN_PAGE_LIMIT_EXCEEDED");
    }
    const targets = await dependencies.store.listLinkedRefundReconciliationTargets(
      installation.tenantId,
      installation.installationId,
      afterRequestId,
      LINKED_REFUND_PAGE_SIZE,
    );
    pageCount += 1;
    if (targets.length > LINKED_REFUND_PAGE_SIZE) {
      throw new Error("LINKED_REFUND_SCAN_PAGE_SIZE_EXCEEDED");
    }

    let previousRequestId = afterRequestId;
    for (const target of targets) {
      if (previousRequestId !== null && target.requestId <= previousRequestId) {
        throw new Error("LINKED_REFUND_SCAN_CURSOR_DID_NOT_ADVANCE");
      }
      previousRequestId = target.requestId;

      try {
        const refund = await dependencies.stripe.retrieveRefund(installation, target.refundId);
        if (refund.id !== target.refundId) {
          throw new Error("LINKED_REFUND_ID_MISMATCH");
        }
        await dependencies.store.observeLinkedRefund({
          tenantId: installation.tenantId,
          installationId: installation.installationId,
          environment: installation.environment,
          requestId: target.requestId,
          expectedRefundId: target.refundId,
          refund: observationFromStripe(refund),
          scanWindowEnd,
          observedAt: dependencies.clock.now(),
        });
      } catch {
        failedRefundCount += 1;
        dependencies.logger.error(
          {
            code: "LINKED_REFUND_REFRESH_FAILED",
            installationId: installation.installationId,
            refundId: target.refundId,
            requestId: target.requestId,
            tenantId: installation.tenantId,
          },
          "Linked Stripe Refund status refresh failed",
        );
      }
    }

    if (targets.length < LINKED_REFUND_PAGE_SIZE) {
      return failedRefundCount;
    }
    const lastTarget = targets.at(-1);
    if (lastTarget === undefined || lastTarget.requestId === afterRequestId) {
      throw new Error("LINKED_REFUND_SCAN_CURSOR_DID_NOT_ADVANCE");
    }
    afterRequestId = lastTarget.requestId;
  }
}

async function scanInstallation(
  installation: ScannableWorkerInstallation,
  dependencies: ReconciliationScannerDependencies,
  windowEnd: Date,
): Promise<void> {
  const checkpoint = await dependencies.store.loadReconciliationCheckpoint(
    installation.tenantId,
    installation.installationId,
  );
  const previousWindowEnd =
    checkpoint === null
      ? null
      : new Date(Math.min(checkpoint.windowEnd.getTime(), windowEnd.getTime()));
  const initialWindowEnd = Math.min(installation.installedAt.getTime(), windowEnd.getTime());
  const windowStart = new Date(
    (previousWindowEnd?.getTime() ?? initialWindowEnd) - OVERLAP_MILLISECONDS,
  );

  let startingAfter: string | undefined;
  let pageCount = 0;
  let refundCount = 0;

  for (;;) {
    if (pageCount >= MAX_PAGES_PER_INSTALLATION) {
      throw new Error("REFUND_SCAN_PAGE_LIMIT_EXCEEDED");
    }

    const page = await dependencies.stripe.listRefunds(
      installation,
      {
        gte: stripeTimestamp(windowStart),
        lte: stripeTimestamp(windowEnd),
      },
      startingAfter,
    );
    pageCount += 1;

    for (const refund of page.refunds) {
      await dependencies.store.observeRefund({
        tenantId: installation.tenantId,
        installationId: installation.installationId,
        environment: installation.environment,
        refund: observationFromStripe(refund),
        source: { kind: "scan", eventIdempotencyKey: null, scanWindowEnd: windowEnd },
        observedAt: dependencies.clock.now(),
      });
      refundCount += 1;
    }

    if (!page.hasMore) {
      break;
    }
    const lastRefund = page.refunds.at(-1);
    if (lastRefund === undefined) {
      throw new Error("REFUND_SCAN_EMPTY_PAGE_WITH_MORE");
    }
    if (lastRefund.id === startingAfter) {
      throw new Error("REFUND_SCAN_CURSOR_DID_NOT_ADVANCE");
    }
    startingAfter = lastRefund.id;
  }

  await dependencies.store.commitReconciliationCheckpoint({
    tenantId: installation.tenantId,
    installationId: installation.installationId,
    previousWindowEnd,
    windowStart,
    windowEnd,
    pageCount,
    refundCount,
    completedAt: dependencies.clock.now(),
  });

  dependencies.logger.info(
    {
      installationId: installation.installationId,
      pageCount,
      refundCount,
      tenantId: installation.tenantId,
    },
    "Refund reconciliation scan completed",
  );
}

export async function handleReconciliationScanJob(
  untrustedJob: unknown,
  dependencies: ReconciliationScannerDependencies,
): Promise<void> {
  const job: ScanRefundsJob = scanRefundsJobSchema.parse(untrustedJob);
  void job;
  const windowEnd = dependencies.clock.now();
  const installations = await dependencies.store.listScannableInstallations();
  let failureCount = 0;

  for (const installation of installations) {
    if (!isPilotScannableInstallation(installation)) {
      dependencies.logger.warn(
        {
          code: "INSTALLATION_NOT_SCANNABLE",
          installationId: installation.installationId,
          tenantId: installation.tenantId,
        },
        "Refund scan skipped a fail-closed installation",
      );
      continue;
    }

    try {
      failureCount += await refreshLinkedRefunds(installation, dependencies, windowEnd);
    } catch {
      failureCount += 1;
      dependencies.logger.error(
        {
          code: "LINKED_REFUND_REFRESH_LIST_FAILED",
          installationId: installation.installationId,
          tenantId: installation.tenantId,
        },
        "Linked Stripe Refund target refresh failed for an installation",
      );
    }

    try {
      await scanInstallation(installation, dependencies, windowEnd);
    } catch {
      failureCount += 1;
      dependencies.logger.error(
        {
          code: "REFUND_SCAN_INSTALLATION_FAILED",
          installationId: installation.installationId,
          tenantId: installation.tenantId,
        },
        "Refund reconciliation scan failed for an installation",
      );
    }
  }

  if (failureCount > 0) {
    throw new Error("REFUND_SCAN_PARTIAL_FAILURE");
  }
}
