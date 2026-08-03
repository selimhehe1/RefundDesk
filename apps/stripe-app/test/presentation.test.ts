import { describe, expect, it } from "vitest";

import {
  externalAlertClassificationSchema,
  refundReasonSchema,
  workflowStatusSchema,
} from "../src/api/client";
import {
  alertClassificationLabel,
  expiryNotice,
  formatTimestamp,
  refundReasonLabel,
  workflowStatusLabel,
} from "../src/presentation";

// Derived from the schema, like the other unions, so a new classification fails here
// rather than reaching a user unlabelled.
const ALERT_CLASSIFICATIONS = externalAlertClassificationSchema.options;

describe("workflowStatusLabel", () => {
  it("labels every workflow status the API can return", () => {
    for (const status of workflowStatusSchema.options) {
      const label = workflowStatusLabel(status);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("_");
      expect(label).not.toBe(status);
    }
  });

  it("keeps every label distinct so two states never read alike", () => {
    const labels = workflowStatusSchema.options.map((status) => workflowStatusLabel(status));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names the states that carry financial meaning without overstating them", () => {
    expect(workflowStatusLabel("pending_approval")).toBe("Awaiting approval");
    expect(workflowStatusLabel("reconciliation_required")).toBe("Needs reconciliation");
    expect(workflowStatusLabel("succeeded")).toBe("Refunded");
    expect(workflowStatusLabel("failed_terminal")).toBe("Failed");
    // `stale` is the one token that says nothing to a reader on its own, so its label
    // must keep explaining that the request can no longer be acted on.
    expect(workflowStatusLabel("stale")).toContain("no longer actionable");
  });

  it("never claims that a guard-sensitive state left the money untouched", () => {
    // These five release the payment guard only when the effect state proves no Stripe
    // effect exists, and the API summary does not expose that effect state.
    const forbidden = ["no refund", "not refunded", "nothing was refunded", "no money"];
    for (const status of ["rejected", "canceled", "expired", "stale", "failed_terminal"] as const) {
      const label = workflowStatusLabel(status).toLowerCase();
      for (const claim of forbidden) {
        expect(label).not.toContain(claim);
      }
    }
  });
});

describe("alertClassificationLabel", () => {
  it("labels every external alert classification", () => {
    for (const classification of ALERT_CLASSIFICATIONS) {
      const label = alertClassificationLabel(classification);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("_");
      expect(label).not.toBe(classification);
    }
  });

  it("keeps every label distinct", () => {
    const labels = ALERT_CLASSIFICATIONS.map((value) => alertClassificationLabel(value));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("refundReasonLabel", () => {
  it("labels every Stripe refund reason", () => {
    for (const reason of refundReasonSchema.options) {
      const label = refundReasonLabel(reason);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("_");
      expect(label).not.toBe(reason);
    }
  });
});

describe("expiryNotice", () => {
  const now = new Date("2026-08-03T12:00:00Z");

  it("counts down in the unit a person thinks in", () => {
    expect(expiryNotice("2026-08-10T12:00:00Z", now)).toBe("Expires in 7 days");
    expect(expiryNotice("2026-08-04T12:00:00Z", now)).toBe("Expires in 1 day");
    expect(expiryNotice("2026-08-03T15:00:00Z", now)).toBe("Expires in 3 hours");
    expect(expiryNotice("2026-08-03T13:00:00Z", now)).toBe("Expires in 1 hour");
    expect(expiryNotice("2026-08-03T12:30:00Z", now)).toBe("Expires in under an hour");
  });

  it("states plainly that the window has closed", () => {
    expect(expiryNotice("2026-08-03T12:00:00Z", now)).toBe("Expired");
    expect(expiryNotice("2026-08-01T12:00:00Z", now)).toBe("Expired");
  });

  it("renders nothing rather than a misleading countdown", () => {
    expect(expiryNotice("not-a-date", now)).toBeNull();
    expect(expiryNotice("", now)).toBeNull();
  });
});

describe("formatTimestamp", () => {
  it("renders an explicit UTC instant", () => {
    expect(formatTimestamp("2026-08-02T21:53:04Z")).toBe("2 Aug 2026, 21:53 UTC");
  });

  it("normalises an offset to the same UTC instant", () => {
    expect(formatTimestamp("2026-08-02T23:53:04+02:00")).toBe("2 Aug 2026, 21:53 UTC");
  });

  it("ignores sub-second precision", () => {
    expect(formatTimestamp("2026-08-02T21:53:04.123Z")).toBe("2 Aug 2026, 21:53 UTC");
  });

  it("pads hours and minutes but not the day", () => {
    expect(formatTimestamp("2026-01-05T04:07:00Z")).toBe("5 Jan 2026, 04:07 UTC");
  });

  it("returns the original value when the instant cannot be parsed", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatTimestamp("")).toBe("");
  });
});
