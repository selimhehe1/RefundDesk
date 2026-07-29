import { describe, expect, it } from "vitest";

import {
  BoundedSignedRequestRateLimiter,
  RateLimiterUnavailableError,
} from "../src/server/mutation-rate-limit.js";

const policies = {
  mutation: {
    capacity: 2,
    refillTokensPerSecond: 0.5,
  },
  read: {
    capacity: 1,
    refillTokensPerSecond: 1,
  },
} as const;

describe("bounded signed-request rate limiter", () => {
  it("uses an injectable monotonic clock for burst, denial and refill", () => {
    let now = 0;
    const limiter = new BoundedSignedRequestRateLimiter({
      idleTtlMilliseconds: 10_000,
      maxScopes: 8,
      monotonicNow: () => now,
      policies,
    });
    const scope = {
      accountId: "acct_A",
      environment: "test",
      requestClass: "mutation",
    } as const;

    expect(limiter.consume(scope)).toEqual({ allowed: true });
    expect(limiter.consume(scope)).toEqual({ allowed: true });
    expect(limiter.consume(scope)).toEqual({ allowed: false, retryAfterSeconds: 2 });

    now = 1_000;
    expect(limiter.consume(scope)).toEqual({ allowed: false, retryAfterSeconds: 1 });

    now = 2_000;
    expect(limiter.consume(scope)).toEqual({ allowed: true });
  });

  it("isolates account, environment and read/mutation capacity", () => {
    const limiter = new BoundedSignedRequestRateLimiter({
      idleTtlMilliseconds: 10_000,
      maxScopes: 8,
      monotonicNow: () => 0,
      policies,
    });
    const mutationTest = {
      accountId: "acct_A",
      environment: "test",
      requestClass: "mutation",
    } as const;

    expect(limiter.consume(mutationTest)).toEqual({ allowed: true });
    expect(limiter.consume(mutationTest)).toEqual({ allowed: true });
    expect(limiter.consume(mutationTest)).toEqual({
      allowed: false,
      retryAfterSeconds: 2,
    });
    expect(limiter.consume({ ...mutationTest, accountId: "acct_B" })).toEqual({ allowed: true });
    expect(limiter.consume({ ...mutationTest, environment: "sandbox" })).toEqual({ allowed: true });
    expect(limiter.consume({ ...mutationTest, requestClass: "read" })).toEqual({ allowed: true });
  });

  it("bounds scope cardinality without evicting an active bucket", () => {
    let now = 0;
    const limiter = new BoundedSignedRequestRateLimiter({
      idleTtlMilliseconds: 4_000,
      maxScopes: 2,
      monotonicNow: () => now,
      policies,
    });

    expect(
      limiter.consume({
        accountId: "acct_A",
        environment: "test",
        requestClass: "mutation",
      }),
    ).toEqual({ allowed: true });
    expect(
      limiter.consume({
        accountId: "acct_B",
        environment: "test",
        requestClass: "mutation",
      }),
    ).toEqual({ allowed: true });
    expect(() =>
      limiter.consume({
        accountId: "acct_C",
        environment: "test",
        requestClass: "mutation",
      }),
    ).toThrow(RateLimiterUnavailableError);

    now = 4_000;
    expect(
      limiter.consume({
        accountId: "acct_C",
        environment: "test",
        requestClass: "mutation",
      }),
    ).toEqual({ allowed: true });
  });

  it("fails closed for a non-finite or backwards monotonic reading", () => {
    let now = 10_000;
    const limiter = new BoundedSignedRequestRateLimiter({
      idleTtlMilliseconds: 10_000,
      maxScopes: 8,
      monotonicNow: () => now,
      policies,
    });
    const scope = {
      accountId: "acct_A",
      environment: "test",
      requestClass: "read",
    } as const;

    expect(limiter.consume(scope)).toEqual({ allowed: true });
    now = 9_999;
    expect(() => limiter.consume(scope)).toThrow(RateLimiterUnavailableError);

    const invalidClockLimiter = new BoundedSignedRequestRateLimiter({
      idleTtlMilliseconds: 10_000,
      maxScopes: 8,
      monotonicNow: () => Number.NaN,
      policies,
    });
    expect(() => invalidClockLimiter.consume(scope)).toThrow(RateLimiterUnavailableError);
  });

  it("rejects an eviction TTL that could reset a bucket faster than refill", () => {
    expect(
      () =>
        new BoundedSignedRequestRateLimiter({
          idleTtlMilliseconds: 3_999,
          maxScopes: 8,
          policies,
        }),
    ).toThrow("cannot be shorter than a complete bucket refill");
  });
});
