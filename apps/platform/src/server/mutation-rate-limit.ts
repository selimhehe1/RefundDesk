import { performance } from "node:perf_hooks";

export interface SignedRequestRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

export type SignedRequestRateLimitClass = "mutation" | "read";

export interface SignedRequestRateLimitScope {
  readonly accountId: string;
  readonly environment: "sandbox" | "test";
  readonly requestClass: SignedRequestRateLimitClass;
}

export interface SignedRequestRateLimiter {
  consume(scope: SignedRequestRateLimitScope): SignedRequestRateLimitDecision;
}

interface TokenBucketPolicy {
  readonly capacity: number;
  readonly refillTokensPerSecond: number;
}

interface BoundedSignedRequestRateLimiterOptions {
  readonly idleTtlMilliseconds: number;
  readonly maxScopes: number;
  readonly monotonicNow?: () => number;
  readonly policies: Readonly<Record<SignedRequestRateLimitClass, TokenBucketPolicy>>;
}

interface TokenBucketState {
  availableTokens: number;
  lastRefillAtMilliseconds: number;
  lastSeenAtMilliseconds: number;
}

const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/u;

export class RateLimiterUnavailableError extends Error {
  constructor() {
    super("Signed-request rate limiter is unavailable");
    this.name = "RateLimiterUnavailableError";
  }
}

function assertPolicy(name: SignedRequestRateLimitClass, policy: TokenBucketPolicy): void {
  if (!Number.isInteger(policy.capacity) || policy.capacity < 1) {
    throw new TypeError(`${name} rate-limit capacity must be a positive integer.`);
  }
  if (!Number.isFinite(policy.refillTokensPerSecond) || policy.refillTokensPerSecond <= 0) {
    throw new TypeError(`${name} rate-limit refill speed must be positive.`);
  }
  const fullRefillMilliseconds = (policy.capacity / policy.refillTokensPerSecond) * 1_000;
  if (!Number.isFinite(fullRefillMilliseconds)) {
    throw new TypeError(`${name} rate-limit refill interval must be finite.`);
  }
}

export class BoundedSignedRequestRateLimiter implements SignedRequestRateLimiter {
  readonly #buckets = new Map<string, TokenBucketState>();
  readonly #idleTtlMilliseconds: number;
  readonly #maxScopes: number;
  readonly #monotonicNow: () => number;
  readonly #policies: Readonly<Record<SignedRequestRateLimitClass, TokenBucketPolicy>>;
  #lastObservedAtMilliseconds: number | undefined;

  constructor(options: BoundedSignedRequestRateLimiterOptions) {
    if (!Number.isInteger(options.maxScopes) || options.maxScopes < 1) {
      throw new TypeError("Rate-limit scope capacity must be a positive integer.");
    }
    if (!Number.isFinite(options.idleTtlMilliseconds) || options.idleTtlMilliseconds <= 0) {
      throw new TypeError("Rate-limit idle TTL must be positive.");
    }
    assertPolicy("mutation", options.policies.mutation);
    assertPolicy("read", options.policies.read);

    const longestFullRefillMilliseconds = Math.max(
      (options.policies.mutation.capacity / options.policies.mutation.refillTokensPerSecond) *
        1_000,
      (options.policies.read.capacity / options.policies.read.refillTokensPerSecond) * 1_000,
    );
    if (options.idleTtlMilliseconds < longestFullRefillMilliseconds) {
      throw new TypeError("Rate-limit idle TTL cannot be shorter than a complete bucket refill.");
    }

    this.#idleTtlMilliseconds = options.idleTtlMilliseconds;
    this.#maxScopes = options.maxScopes;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#policies = options.policies;
  }

  consume(scope: SignedRequestRateLimitScope): SignedRequestRateLimitDecision {
    if (
      !ACCOUNT_ID_PATTERN.test(scope.accountId) ||
      scope.accountId.length > 255 ||
      (scope.environment !== "sandbox" && scope.environment !== "test") ||
      (scope.requestClass !== "mutation" && scope.requestClass !== "read")
    ) {
      throw new RateLimiterUnavailableError();
    }

    const observedAtMilliseconds = this.#readMonotonicTime();
    const key = JSON.stringify([scope.accountId, scope.environment, scope.requestClass]);
    let bucket = this.#buckets.get(key);
    if (
      bucket !== undefined &&
      observedAtMilliseconds - bucket.lastSeenAtMilliseconds >= this.#idleTtlMilliseconds
    ) {
      this.#buckets.delete(key);
      bucket = undefined;
    }

    if (bucket === undefined) {
      if (this.#buckets.size >= this.#maxScopes) {
        this.#removeIdleScopes(observedAtMilliseconds);
      }
      if (this.#buckets.size >= this.#maxScopes) {
        throw new RateLimiterUnavailableError();
      }
      const policy = this.#policies[scope.requestClass];
      bucket = {
        availableTokens: policy.capacity,
        lastRefillAtMilliseconds: observedAtMilliseconds,
        lastSeenAtMilliseconds: observedAtMilliseconds,
      };
      this.#buckets.set(key, bucket);
    }

    const policy = this.#policies[scope.requestClass];
    const elapsedMilliseconds = observedAtMilliseconds - bucket.lastRefillAtMilliseconds;
    if (elapsedMilliseconds > 0) {
      bucket.availableTokens = Math.min(
        policy.capacity,
        bucket.availableTokens + elapsedMilliseconds * (policy.refillTokensPerSecond / 1_000),
      );
      bucket.lastRefillAtMilliseconds = observedAtMilliseconds;
    }
    bucket.lastSeenAtMilliseconds = observedAtMilliseconds;

    if (bucket.availableTokens >= 1) {
      bucket.availableTokens -= 1;
      return { allowed: true };
    }

    const millisecondsUntilToken =
      ((1 - bucket.availableTokens) / policy.refillTokensPerSecond) * 1_000;
    const retryAfterSeconds = Math.max(1, Math.ceil(millisecondsUntilToken / 1_000));
    if (!Number.isSafeInteger(retryAfterSeconds)) {
      throw new RateLimiterUnavailableError();
    }
    return {
      allowed: false,
      retryAfterSeconds,
    };
  }

  #readMonotonicTime(): number {
    const observedAtMilliseconds = this.#monotonicNow();
    if (
      !Number.isFinite(observedAtMilliseconds) ||
      observedAtMilliseconds < 0 ||
      (this.#lastObservedAtMilliseconds !== undefined &&
        observedAtMilliseconds < this.#lastObservedAtMilliseconds)
    ) {
      throw new RateLimiterUnavailableError();
    }
    this.#lastObservedAtMilliseconds = observedAtMilliseconds;
    return observedAtMilliseconds;
  }

  #removeIdleScopes(observedAtMilliseconds: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (observedAtMilliseconds - bucket.lastSeenAtMilliseconds >= this.#idleTtlMilliseconds) {
        this.#buckets.delete(key);
      }
    }
  }
}

const globalLimiterRegistry = globalThis as typeof globalThis & {
  __refunddeskSandboxSignedRequestRateLimiterV2?: SignedRequestRateLimiter;
};

export function sandboxSignedRequestRateLimiter(): SignedRequestRateLimiter {
  globalLimiterRegistry.__refunddeskSandboxSignedRequestRateLimiterV2 ??=
    new BoundedSignedRequestRateLimiter({
      idleTtlMilliseconds: 10 * 60 * 1_000,
      maxScopes: 256,
      policies: {
        mutation: {
          capacity: 30,
          refillTokensPerSecond: 0.5,
        },
        read: {
          capacity: 60,
          refillTokensPerSecond: 1,
        },
      },
    });
  return globalLimiterRegistry.__refunddeskSandboxSignedRequestRateLimiterV2;
}
