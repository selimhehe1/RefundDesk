import type { PrismaClient } from "./generated/prisma/client.js";

const STRIPE_ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]+$/u;

export type SignedRequestRateLimitClass = "mutation" | "read";

export interface SignedRequestRateLimitScope {
  readonly accountId: string;
  readonly environment: "sandbox" | "test";
  readonly requestClass: SignedRequestRateLimitClass;
}

export interface SignedRequestRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

interface SignedRequestRateLimitRow {
  readonly allowed: boolean;
  readonly retry_after_seconds: number | null;
}

function assertScope(scope: SignedRequestRateLimitScope): void {
  if (!STRIPE_ACCOUNT_PATTERN.test(scope.accountId) || scope.accountId.length > 255) {
    throw new TypeError("Invalid signed request rate-limit account");
  }
  if (scope.environment !== "sandbox" && scope.environment !== "test") {
    throw new TypeError("Invalid signed request rate-limit environment");
  }
  if (scope.requestClass !== "mutation" && scope.requestClass !== "read") {
    throw new TypeError("Invalid signed request rate-limit class");
  }
}

export async function consumeSignedRequestRateLimit(
  client: PrismaClient,
  scope: SignedRequestRateLimitScope,
): Promise<SignedRequestRateLimitDecision> {
  assertScope(scope);
  const rows = await client.$queryRaw<readonly SignedRequestRateLimitRow[]>`
    SELECT allowed, retry_after_seconds
    FROM refunddesk_consume_signed_request_rate_limit(
      ${scope.accountId}::VARCHAR,
      ${scope.environment}::stripe_environment,
      ${scope.requestClass}::VARCHAR
    )
  `;
  if (rows.length !== 1) {
    throw new Error("Signed request rate limiter returned an invalid row count");
  }
  const row = rows[0];
  if (row?.allowed === true && row.retry_after_seconds === null) {
    return { allowed: true };
  }
  if (
    row?.allowed === false &&
    Number.isSafeInteger(row.retry_after_seconds) &&
    (row.retry_after_seconds ?? 0) > 0
  ) {
    return {
      allowed: false,
      retryAfterSeconds: row.retry_after_seconds ?? 1,
    };
  }
  throw new Error("Signed request rate limiter returned an invalid decision");
}
