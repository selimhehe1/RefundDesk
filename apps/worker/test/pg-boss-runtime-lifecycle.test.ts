import { describe, expect, it, vi } from "vitest";

import { startPgBossWithCleanup, type PgBossLifecycle } from "../src/pg-boss-runtime.js";

describe("pg-boss startup lifecycle", () => {
  it("force-stops a partially started runtime when schedule or work registration fails", async () => {
    const startupError = new Error("synthetic schedule failure");
    const start = vi.fn(() => Promise.resolve());
    const stop = vi.fn(() => Promise.resolve());
    const boss: PgBossLifecycle = {
      start,
      stop,
    };

    await expect(startPgBossWithCleanup(boss, () => Promise.reject(startupError))).rejects.toBe(
      startupError,
    );
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith({
      graceful: false,
      timeout: 5_000,
    });
  });

  it("also attempts cleanup when pg-boss start itself fails", async () => {
    const startupError = new Error("synthetic start failure");
    const start = vi.fn(() => Promise.reject(startupError));
    const stop = vi.fn(() => Promise.resolve());
    const boss: PgBossLifecycle = {
      start,
      stop,
    };
    const initialize = vi.fn(() => Promise.resolve());

    await expect(startPgBossWithCleanup(boss, initialize)).rejects.toBe(startupError);
    expect(initialize).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith({
      graceful: false,
      timeout: 5_000,
    });
  });
});
