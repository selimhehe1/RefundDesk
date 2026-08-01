import { describe, expect, it, vi } from "vitest";

import {
  consumeSignedRequestRateLimit,
  type PrismaClient,
  type SignedRequestRateLimitScope,
} from "../src/index.js";

function clientReturning(rows: readonly unknown[]): {
  readonly calls: Array<{
    readonly query: TemplateStringsArray;
    readonly values: readonly unknown[];
  }>;
  readonly client: PrismaClient;
  readonly queryRaw: ReturnType<typeof vi.fn>;
} {
  const calls: Array<{
    readonly query: TemplateStringsArray;
    readonly values: readonly unknown[];
  }> = [];
  const queryRaw = vi.fn((query: TemplateStringsArray, ...values: readonly unknown[]) => {
    calls.push({ query, values });
    return Promise.resolve(rows);
  });
  return {
    calls,
    client: { $queryRaw: queryRaw } as unknown as PrismaClient,
    queryRaw,
  };
}

const scope = {
  accountId: "acct_DurableLimiter",
  environment: "test",
  requestClass: "mutation",
} as const;

describe("durable signed-request rate-limit query", () => {
  it("accepts one internally consistent allow or deny decision", async () => {
    const allowed = clientReturning([{ allowed: true, retry_after_seconds: null }]);
    const denied = clientReturning([{ allowed: false, retry_after_seconds: 2 }]);

    await expect(consumeSignedRequestRateLimit(allowed.client, scope)).resolves.toEqual({
      allowed: true,
    });
    await expect(consumeSignedRequestRateLimit(denied.client, scope)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 2,
    });

    expect(allowed.calls[0]?.query.join("?")).toContain(
      "refunddesk_consume_signed_request_rate_limit",
    );
    expect(allowed.calls[0]?.values).toEqual(["acct_DurableLimiter", "test", "mutation"]);
  });

  it.each([
    { rows: [] },
    {
      rows: [
        { allowed: true, retry_after_seconds: null },
        { allowed: true, retry_after_seconds: null },
      ],
    },
    { rows: [{ allowed: true, retry_after_seconds: 1 }] },
    { rows: [{ allowed: false, retry_after_seconds: null }] },
    { rows: [{ allowed: false, retry_after_seconds: 0 }] },
    { rows: [{ allowed: false, retry_after_seconds: Number.MAX_SAFE_INTEGER + 1 }] },
    { rows: [{ allowed: "true", retry_after_seconds: null }] },
  ])("rejects an invalid database decision %#", async ({ rows }) => {
    const { client } = clientReturning(rows);

    await expect(consumeSignedRequestRateLimit(client, scope)).rejects.toThrow(
      /invalid (?:row count|decision)/u,
    );
  });

  it.each([
    { ...scope, accountId: "not_an_account" },
    { ...scope, accountId: `acct_${"A".repeat(251)}` },
    { ...scope, environment: "live" },
    { ...scope, requestClass: "write" },
  ])("rejects an invalid scope before querying PostgreSQL %#", async (candidate) => {
    const { client, queryRaw } = clientReturning([{ allowed: true, retry_after_seconds: null }]);

    await expect(
      consumeSignedRequestRateLimit(client, candidate as unknown as SignedRequestRateLimitScope),
    ).rejects.toThrow(TypeError);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("does not translate a PostgreSQL failure into an allow decision", async () => {
    const databaseError = new Error("synthetic database failure");
    const queryRaw = vi.fn(() => Promise.reject(databaseError));
    const client = { $queryRaw: queryRaw } as unknown as PrismaClient;

    await expect(consumeSignedRequestRateLimit(client, scope)).rejects.toBe(databaseError);
  });
});
