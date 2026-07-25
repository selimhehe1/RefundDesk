import { describe, expect, it } from "vitest";

import {
  authoritativeObservedRefundStatus,
  shouldApplyLinkedRefundObservation,
} from "../src/db-store.js";
import type { ObserveRefundInput } from "../src/ports.js";

const eventCreated = 1_900_000_000;

function refund(status: ObserveRefundInput["refund"]["status"]): ObserveRefundInput["refund"] {
  return {
    refundId: "re_linked",
    paymentIntentId: "pi_linked",
    chargeId: "ch_linked",
    amountMinor: 500n,
    currency: "eur",
    status,
    created: eventCreated - 10,
    metadataRequestId: "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
    metadataProof: "proof",
  };
}

function webhook(
  status: ObserveRefundInput["refund"]["status"],
  created: number,
): Pick<ObserveRefundInput, "refund" | "source"> {
  return {
    refund: refund(status),
    source: {
      kind: "webhook",
      receiptId: "receipt-linked",
      stripeEventId: `evt_${created}`,
      stripeAccountId: "acct_linked",
      eventIdempotencyKey: "refunddesk:refund-request:request:v1",
      eventType: status === "failed" ? "refund.failed" : "refund.updated",
      eventCreated: created,
    },
  };
}

function scan(
  status: ObserveRefundInput["refund"]["status"],
): Pick<ObserveRefundInput, "refund" | "source"> {
  return {
    refund: refund(status),
    source: {
      kind: "scan",
      eventIdempotencyKey: null,
      scanWindowEnd: new Date("2030-03-17T17:46:40.000Z"),
    },
  };
}

describe("linked refund observation freshness", () => {
  it("applies a failed webhook after an API-observed success", () => {
    expect(
      shouldApplyLinkedRefundObservation({
        currentStatus: "succeeded",
        lastStripeEventCreatedAt: null,
        observation: webhook("failed", eventCreated),
      }),
    ).toBe(true);
  });

  it("ignores a stale webhook", () => {
    expect(
      shouldApplyLinkedRefundObservation({
        currentStatus: "succeeded",
        lastStripeEventCreatedAt: new Date((eventCreated + 1) * 1_000),
        observation: webhook("failed", eventCreated),
      }),
    ).toBe(false);
  });

  it("gives failed priority when webhook timestamps are equal", () => {
    const lastStripeEventCreatedAt = new Date(eventCreated * 1_000);

    expect(
      shouldApplyLinkedRefundObservation({
        currentStatus: "succeeded",
        lastStripeEventCreatedAt,
        observation: webhook("failed", eventCreated),
      }),
    ).toBe(true);
    expect(
      shouldApplyLinkedRefundObservation({
        currentStatus: "failed",
        lastStripeEventCreatedAt,
        observation: webhook("succeeded", eventCreated),
      }),
    ).toBe(false);
  });

  it("treats the refund.failed event type as failure evidence when status is absent", () => {
    const observation = webhook(null, eventCreated);
    if (observation.source.kind !== "webhook") {
      throw new Error("TEST_WEBHOOK_SOURCE_EXPECTED");
    }
    const failedObservation = {
      ...observation,
      source: {
        ...observation.source,
        eventType: "refund.failed" as const,
      },
    };

    expect(
      shouldApplyLinkedRefundObservation({
        currentStatus: "succeeded",
        lastStripeEventCreatedAt: new Date(eventCreated * 1_000),
        observation: failedObservation,
      }),
    ).toBe(true);
    expect(authoritativeObservedRefundStatus(failedObservation)).toBe("failed");
  });

  it("offers changed scanner snapshots for repository convergence", () => {
    expect(
      shouldApplyLinkedRefundObservation({
        currentStatus: "succeeded",
        lastStripeEventCreatedAt: new Date(eventCreated * 1_000),
        observation: scan("failed"),
      }),
    ).toBe(true);
    expect(
      shouldApplyLinkedRefundObservation({
        currentStatus: "failed",
        lastStripeEventCreatedAt: new Date(eventCreated * 1_000),
        observation: scan("failed"),
      }),
    ).toBe(false);
  });
});
