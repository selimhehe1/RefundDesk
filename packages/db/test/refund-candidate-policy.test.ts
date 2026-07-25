import { describe, expect, it } from "vitest";

import { decideRefundCandidate } from "../src/index.js";

const base = {
  linkedRefundId: null,
  candidateRefundId: "re_candidate",
  eventIdempotencyEvidence: "absent",
  candidateCount: 1,
  completeScan: false,
  scanCoversExecution: false,
} as const;

describe("durable refund candidate policy", () => {
  it("does not let a webhook-before-response HMAC candidate link by arrival order", () => {
    expect(decideRefundCandidate(base)).toBe("wait_for_complete_scan");
    expect(
      decideRefundCandidate({
        ...base,
        eventIdempotencyEvidence: "exact",
      }),
    ).toBe("link_exact");
  });

  it("links a weak candidate only after one complete scan covers the effect boundary", () => {
    expect(
      decideRefundCandidate({
        ...base,
        completeScan: true,
        scanCoversExecution: false,
      }),
    ).toBe("wait_for_complete_scan");
    expect(
      decideRefundCandidate({
        ...base,
        completeScan: true,
        scanCoversExecution: true,
      }),
    ).toBe("link_unique");
  });

  it("makes two candidates conflict regardless of which Refund arrived first", () => {
    for (const candidateRefundId of ["re_first", "re_second"]) {
      expect(
        decideRefundCandidate({
          ...base,
          candidateRefundId,
          candidateCount: 2,
          completeScan: true,
          scanCoversExecution: true,
        }),
      ).toBe("conflict");
    }
  });

  it("never treats a mismatching Event idempotency key as unique evidence", () => {
    expect(
      decideRefundCandidate({
        ...base,
        eventIdempotencyEvidence: "mismatch",
        completeScan: true,
        scanCoversExecution: true,
      }),
    ).toBe("conflict");
  });
});
