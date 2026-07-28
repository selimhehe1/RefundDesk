import { Pool } from "pg";

import { isPlatformReady, PLATFORM_READINESS_SQL, type PlatformReadinessRow } from "./readiness";

const READY_CACHE_MILLISECONDS = 2_000;
const NOT_READY_CACHE_MILLISECONDS = 250;

export interface PlatformReadinessProbe {
  check(): Promise<boolean>;
}

export interface PlatformReadinessProbeDependencies {
  readonly load: () => Promise<PlatformReadinessRow | undefined>;
  readonly now?: () => number;
  readonly readyCacheMilliseconds?: number;
  readonly notReadyCacheMilliseconds?: number;
}

export function createPlatformReadinessProbe(
  dependencies: PlatformReadinessProbeDependencies,
): PlatformReadinessProbe {
  const now = dependencies.now ?? Date.now;
  const readyCacheMilliseconds = dependencies.readyCacheMilliseconds ?? READY_CACHE_MILLISECONDS;
  const notReadyCacheMilliseconds =
    dependencies.notReadyCacheMilliseconds ?? NOT_READY_CACHE_MILLISECONDS;
  if (
    !Number.isFinite(readyCacheMilliseconds) ||
    readyCacheMilliseconds <= 0 ||
    !Number.isFinite(notReadyCacheMilliseconds) ||
    notReadyCacheMilliseconds <= 0
  ) {
    throw new Error("INVALID_PLATFORM_READINESS_CACHE");
  }

  let cached: { readonly ready: boolean; readonly expiresAt: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  return {
    async check(): Promise<boolean> {
      const currentTime = now();
      if (cached !== null && Number.isFinite(currentTime) && currentTime < cached.expiresAt) {
        return cached.ready;
      }
      if (inFlight !== null) {
        return inFlight;
      }

      const operation = dependencies
        .load()
        .then((row) => isPlatformReady(row))
        .catch(() => false)
        .then((ready) => {
          const completedAt = now();
          if (Number.isFinite(completedAt)) {
            cached = {
              ready,
              expiresAt: completedAt + (ready ? readyCacheMilliseconds : notReadyCacheMilliseconds),
            };
          }
          return ready;
        });
      inFlight = operation;
      try {
        return await operation;
      } finally {
        if (inFlight === operation) {
          inFlight = null;
        }
      }
    },
  };
}

export function createPostgresPlatformReadinessProbe(
  connectionString: string,
): PlatformReadinessProbe {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 2_500,
    idleTimeoutMillis: 30_000,
    max: 1,
    options: "-c search_path=pg_catalog,public",
    query_timeout: 2_500,
    statement_timeout: 2_000,
  });
  pool.on("error", () => undefined);
  return createPlatformReadinessProbe({
    load: async () => {
      const result = await pool.query<PlatformReadinessRow>(PLATFORM_READINESS_SQL);
      return result.rows[0];
    },
  });
}
