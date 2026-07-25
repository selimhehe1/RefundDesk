import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { TenantRepositories } from "./tenant-repositories.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface TenantTransactionContext {
  readonly tenantId: string;
  readonly tx: Prisma.TransactionClient;
  readonly repositories: TenantRepositories;
}

export interface TenantTransactionOptions {
  readonly maxAttempts?: number;
  readonly maxWaitMilliseconds?: number;
  readonly timeoutMilliseconds?: number;
}

export class TransactionRetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(`Serializable tenant transaction failed after ${attempts} attempts`, options);
    this.name = "TransactionRetryExhaustedError";
  }
}

export function assertTenantId(tenantId: string): void {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new TypeError("tenantId must be a UUID");
  }
}

function hasRetryableTransactionMarker(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): boolean {
  if (typeof value === "string") {
    return (
      value === "P2034" ||
      value === "40001" ||
      value === "40P01" ||
      value === "TransactionWriteConflict"
    );
  }
  if (typeof value !== "object" || value === null || depth > 8 || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.values(value as Readonly<Record<string, unknown>>).some((nested) =>
    hasRetryableTransactionMarker(nested, seen, depth + 1),
  );
}

export function isRetryableTransactionError(error: unknown): boolean {
  return hasRetryableTransactionMarker(error, new WeakSet<object>(), 0);
}

export async function withTenantTransaction<TResult>(
  client: PrismaClient,
  tenantId: string,
  operation: (context: TenantTransactionContext) => Promise<TResult>,
  options: TenantTransactionOptions = {},
): Promise<TResult> {
  assertTenantId(tenantId);
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new RangeError("maxAttempts must be between 1 and 10");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          const repositories = new TenantRepositories(tx, tenantId);
          return operation({ tenantId, tx, repositories });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: options.maxWaitMilliseconds ?? 5_000,
          timeout: options.timeoutMilliseconds ?? 10_000,
        },
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error)) {
        throw error;
      }
    }
  }

  throw new TransactionRetryExhaustedError(maxAttempts, { cause: lastError });
}
