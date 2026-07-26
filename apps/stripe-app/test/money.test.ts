import { describe, expect, it } from "vitest";

import { formatMinorAmount } from "../src/money";

describe("exact money presentation", () => {
  it("shows readable and exact two-decimal card amounts", () => {
    expect(formatMinorAmount("109", "eur")).toBe("1.09 EUR — 109 minor units");
    expect(formatMinorAmount("9007199254740993", "usd")).toBe(
      "90071992547409.93 USD — 9007199254740993 minor units",
    );
  });

  it("supports Stripe zero- and three-decimal currencies without floating point", () => {
    expect(formatMinorAmount("109", "jpy")).toBe("109 JPY — 109 minor units");
    expect(formatMinorAmount("109", "kwd")).toBe("0.109 KWD — 109 minor units");
    expect(formatMinorAmount("500", "ugx")).toBe("5.00 UGX — 500 minor units");
  });
});
