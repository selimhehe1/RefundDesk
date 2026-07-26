import { describe, expect, it } from "vitest";

import {
  parseApproverUserIds,
  parseApproverUserIdsStrict,
  validateRefundForm,
} from "../src/validation";

describe("refund form validation", () => {
  it("accepts an exact positive minor-unit amount", () => {
    expect(
      validateRefundForm(
        {
          amountMinor: "9007199254740993",
          reason: "requested_by_customer",
          justification: "Customer requested the refund.",
        },
        "9007199254740993",
      ),
    ).toEqual({});
  });

  it("rejects decimals, zero, over-refunds, and short justification", () => {
    const invalid = validateRefundForm(
      {
        amountMinor: "10.50",
        reason: "duplicate",
        justification: "short",
      },
      "1000",
    );
    expect(invalid.amount).toBeTypeOf("string");
    expect(invalid.justification).toBeTypeOf("string");
    expect(
      validateRefundForm(
        {
          amountMinor: "1001",
          reason: "duplicate",
          justification: "Duplicate payment confirmed.",
        },
        "1000",
      ).amount,
    ).toContain("exceeds");
    expect(
      validateRefundForm(
        {
          amountMinor: "0",
          reason: "duplicate",
          justification: "Duplicate payment confirmed.",
        },
        "1000",
      ).amount,
    ).toContain("positive");
  });
});

describe("approver IDs", () => {
  it("deduplicates valid Stripe user IDs without accepting e-mail addresses", () => {
    expect(parseApproverUserIds("usr_Admin\nusr_Reviewer, usr_Admin, person@example.com")).toEqual([
      "usr_Admin",
      "usr_Reviewer",
    ]);
  });

  it("reports every invalid approver value instead of silently dropping it", () => {
    expect(
      parseApproverUserIdsStrict("usr_Admin\nperson@example.com, display-name, person@example.com"),
    ).toEqual({
      approverUserIds: ["usr_Admin"],
      invalidValues: ["person@example.com", "display-name"],
    });
  });
});
