import {
  consumeSignedRequestRateLimit,
  type PrismaClient,
  type SignedRequestRateLimitDecision,
  type SignedRequestRateLimitScope,
} from "@refunddesk/db";

export type {
  SignedRequestRateLimitClass,
  SignedRequestRateLimitDecision,
  SignedRequestRateLimitScope,
} from "@refunddesk/db";

export interface SignedRequestRateLimiter {
  consume(scope: SignedRequestRateLimitScope): Promise<SignedRequestRateLimitDecision>;
}

export class PostgresSignedRequestRateLimiter implements SignedRequestRateLimiter {
  constructor(private readonly client: PrismaClient) {}

  consume(scope: SignedRequestRateLimitScope): Promise<SignedRequestRateLimitDecision> {
    return consumeSignedRequestRateLimit(this.client, scope);
  }
}
