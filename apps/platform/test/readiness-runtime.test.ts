import { describe, expect, it } from "vitest";

import {
  createPlatformReadinessProbe,
  type PlatformReadinessProbeDependencies,
} from "../src/server/readiness-runtime.js";
import type { PlatformReadinessRow } from "../src/server/readiness.js";

const readyRow: PlatformReadinessRow = {
  audit_append_only: true,
  database_writable: true,
  postgres_supported: true,
  restricted_runtime_role: true,
  rls_forced: true,
  runtime_authority_ready: true,
  schema_contract_ready: true,
  schema_ready: true,
};

describe("platform readiness runtime", () => {
  it("coalesces concurrent public probes and serves a bounded cache", async () => {
    let now = 1_000;
    let loads = 0;
    const dependencies: PlatformReadinessProbeDependencies = {
      load: async () => {
        loads += 1;
        await Promise.resolve();
        return readyRow;
      },
      now: () => now,
      readyCacheMilliseconds: 2_000,
      notReadyCacheMilliseconds: 100,
    };
    const probe = createPlatformReadinessProbe(dependencies);

    await expect(Promise.all(Array.from({ length: 50 }, () => probe.check()))).resolves.toEqual(
      Array.from({ length: 50 }, () => true),
    );
    expect(loads).toBe(1);
    await expect(probe.check()).resolves.toBe(true);
    expect(loads).toBe(1);

    now += 2_001;
    await expect(probe.check()).resolves.toBe(true);
    expect(loads).toBe(2);
  });

  it("fails closed and only caches an unavailable dependency briefly", async () => {
    let now = 5_000;
    let loads = 0;
    const probe = createPlatformReadinessProbe({
      load: () => {
        loads += 1;
        if (loads === 1) {
          return Promise.reject(new Error("synthetic unavailable dependency"));
        }
        return Promise.resolve(readyRow);
      },
      now: () => now,
      readyCacheMilliseconds: 2_000,
      notReadyCacheMilliseconds: 100,
    });

    await expect(probe.check()).resolves.toBe(false);
    await expect(probe.check()).resolves.toBe(false);
    expect(loads).toBe(1);

    now += 101;
    await expect(probe.check()).resolves.toBe(true);
    expect(loads).toBe(2);
  });
});
