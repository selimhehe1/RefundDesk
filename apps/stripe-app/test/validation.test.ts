import { describe, expect, it } from "vitest";

import { validateRefundForm } from "../src/validation";

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
