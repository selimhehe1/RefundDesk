import { describe, expect, it } from "vitest";

import { formatMinorAsDecimal, parseAmountToMinor } from "../src/money";

describe("formatMinorAsDecimal", () => {
  it("renders the decimal a person would type back", () => {
    expect(formatMinorAsDecimal("500", "eur")).toBe("5.00");
    expect(formatMinorAsDecimal("1", "eur")).toBe("0.01");
    expect(formatMinorAsDecimal("0", "eur")).toBe("0.00");
    expect(formatMinorAsDecimal("123456", "usd")).toBe("1234.56");
  });

  it("follows the currency exponent rather than assuming two decimals", () => {
    expect(formatMinorAsDecimal("500", "jpy")).toBe("500");
    expect(formatMinorAsDecimal("1234", "bhd")).toBe("1.234");
  });

  it("returns the raw value when it cannot be interpreted", () => {
    expect(formatMinorAsDecimal("abc", "eur")).toBe("abc");
    expect(formatMinorAsDecimal("500", "EURO")).toBe("500");
  });
});

describe("parseAmountToMinor", () => {
  it("converts what a person types into exact minor units", () => {
    expect(parseAmountToMinor("25", "eur")).toEqual({ minorAmount: "2500" });
    expect(parseAmountToMinor("25.00", "eur")).toEqual({ minorAmount: "2500" });
    expect(parseAmountToMinor("0.01", "eur")).toEqual({ minorAmount: "1" });
    expect(parseAmountToMinor("1234.5", "eur")).toEqual({ minorAmount: "123450" });
  });

  it("accepts a comma as the decimal separator", () => {
    expect(parseAmountToMinor("25,50", "eur")).toEqual({ minorAmount: "2550" });
  });

  it("ignores surrounding and grouping whitespace", () => {
    expect(parseAmountToMinor("  1 234.56  ", "eur")).toEqual({ minorAmount: "123456" });
  });

  it("stays exact on values that binary floating point cannot represent", () => {
    // 1.005 * 100 is 100.49999999999999 in IEEE-754; string arithmetic must not round it.
    expect(parseAmountToMinor("1.005", "bhd")).toEqual({ minorAmount: "1005" });
    expect(parseAmountToMinor("8.87", "eur")).toEqual({ minorAmount: "887" });
    expect(parseAmountToMinor("9007199254740993.99", "eur")).toEqual({
      minorAmount: "900719925474099399",
    });
  });

  it("honours a zero-decimal currency", () => {
    expect(parseAmountToMinor("500", "jpy")).toEqual({ minorAmount: "500" });
    expect(parseAmountToMinor("500.0", "jpy")).toEqual({ minorAmount: "500" });
    expect(parseAmountToMinor("500.5", "jpy")).toEqual({
      error: "JPY amounts cannot have decimals.",
    });
  });

  it("honours a three-decimal currency", () => {
    expect(parseAmountToMinor("1.234", "bhd")).toEqual({ minorAmount: "1234" });
    expect(parseAmountToMinor("1.2345", "bhd")).toEqual({
      error: "BHD amounts cannot have more than 3 decimals.",
    });
  });

  it("refuses more precision than the currency has", () => {
    expect(parseAmountToMinor("1.234", "eur")).toEqual({
      error: "EUR amounts cannot have more than 2 decimals.",
    });
  });

  it("refuses anything that is not a positive amount", () => {
    for (const input of ["", "   ", "abc", "-5", "5-", "1.2.3", "1,2,3", ".", "1e3", "+5"]) {
      expect(parseAmountToMinor(input, "eur")).toEqual({
        error: "Enter an amount, such as 12.34.",
      });
    }
  });

  it("refuses zero, however it is written", () => {
    for (const input of ["0", "0.00", "0,0", "00"]) {
      expect(parseAmountToMinor(input, "eur")).toEqual({
        error: "Enter an amount greater than zero.",
      });
    }
  });
});
