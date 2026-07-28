import { describe, expect, it } from "vitest";

import {
  isRetryableTransactionError,
  transactionRetryDelayMilliseconds,
} from "../src/tenant-transaction.js";

describe("tenant transaction adapter error classification", () => {
  it("recognizes Prisma adapter-pg transaction write conflicts", () => {
    expect(
      isRetryableTransactionError({
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict" },
      }),
    ).toBe(true);
    expect(
      isRetryableTransactionError({
        code: "P2010",
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: "40001",
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("does not retry unrelated adapter failures", () => {
    expect(
      isRetryableTransactionError({
        name: "DriverAdapterError",
        cause: { kind: "AuthenticationFailed" },
      }),
    ).toBe(false);
  });

  it("uses bounded exponential jitter between serializable retries", () => {
    expect(transactionRetryDelayMilliseconds(1, 0)).toBe(10);
    expect(transactionRetryDelayMilliseconds(1, 0.999)).toBe(19);
    expect(transactionRetryDelayMilliseconds(2, 0)).toBe(20);
    expect(transactionRetryDelayMilliseconds(3, 0.5)).toBe(60);
    expect(transactionRetryDelayMilliseconds(10, 0)).toBe(250);
    expect(transactionRetryDelayMilliseconds(10, 0.999)).toBe(499);
    expect(() => transactionRetryDelayMilliseconds(0, 0)).toThrow(RangeError);
    expect(() => transactionRetryDelayMilliseconds(1, 1)).toThrow(RangeError);
  });
});
