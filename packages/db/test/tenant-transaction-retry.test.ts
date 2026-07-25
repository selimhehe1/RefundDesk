import { describe, expect, it } from "vitest";

import { isRetryableTransactionError } from "../src/tenant-transaction.js";

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
});
