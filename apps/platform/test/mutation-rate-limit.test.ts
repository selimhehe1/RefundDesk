import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@refunddesk/db";

import { PostgresSignedRequestRateLimiter } from "../src/server/mutation-rate-limit.js";

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

describe("PostgreSQL signed-request rate limiter adapter", () => {
  it("delegates the authenticated scope to the durable database function", async () => {
    const { calls, client, queryRaw } = clientReturning([
      { allowed: false, retry_after_seconds: 2 },
    ]);
    const limiter = new PostgresSignedRequestRateLimiter(client);

    await expect(
      limiter.consume({
        accountId: "acct_DurableLimiter",
        environment: "sandbox",
        requestClass: "mutation",
      }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 2 });

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(calls[0]?.query.join("?")).toContain("refunddesk_consume_signed_request_rate_limit");
    expect(calls[0]?.values).toEqual(["acct_DurableLimiter", "sandbox", "mutation"]);
  });

  it("fails closed when PostgreSQL returns no decision", async () => {
    const { client } = clientReturning([]);
    const limiter = new PostgresSignedRequestRateLimiter(client);

    await expect(
      limiter.consume({
        accountId: "acct_DurableLimiter",
        environment: "test",
        requestClass: "read",
      }),
    ).rejects.toThrow("invalid row count");
  });
});
