import { describe, expect, it, vi } from "vitest";

import { MutationIntentRegistry } from "../src/api/mutation-intent";

describe("MutationIntentRegistry", () => {
  it("keeps one nonce across an ambiguous retry and rotates after completion", () => {
    const createNonce = vi
      .fn<() => string>()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const registry = new MutationIntentRegistry(createNonce);

    expect(registry.begin("refund:create")).toEqual({
      status: "started",
      requestNonce: "00000000-0000-4000-8000-000000000001",
    });
    registry.release("refund:create");
    expect(registry.begin("refund:create")).toEqual({
      status: "started",
      requestNonce: "00000000-0000-4000-8000-000000000001",
    });
    registry.complete("refund:create");
    expect(registry.begin("refund:create")).toEqual({
      status: "started",
      requestNonce: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("serializes all mutations and isolates independent intentions", () => {
    const createNonce = vi
      .fn<() => string>()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const registry = new MutationIntentRegistry(createNonce);

    expect(registry.begin("request-1:approve")).toEqual({
      status: "started",
      requestNonce: "00000000-0000-4000-8000-000000000001",
    });
    expect(registry.begin("request-1:approve")).toEqual({ status: "busy" });
    expect(registry.begin("request-2:approve")).toEqual({ status: "busy" });
    registry.release("request-1:approve");
    expect(registry.begin("request-2:approve")).toEqual({
      status: "started",
      requestNonce: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("starts a new intention after editable command data changes", () => {
    const createNonce = vi
      .fn<() => string>()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const registry = new MutationIntentRegistry(createNonce);

    expect(registry.begin("settings:update")).toEqual({
      status: "started",
      requestNonce: "00000000-0000-4000-8000-000000000001",
    });
    registry.release("settings:update");
    registry.reset("settings:update");
    expect(registry.begin("settings:update")).toEqual({
      status: "started",
      requestNonce: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("returns nonce generation failures without locking the view", () => {
    const registry = new MutationIntentRegistry(() => {
      throw new Error("Secure random unavailable");
    });

    const failed = registry.begin("refund:create");
    expect(failed.status).toBe("failed");
    if (failed.status !== "failed") {
      throw new TypeError("Expected nonce creation to fail");
    }
    if (!(failed.error instanceof Error)) {
      throw new TypeError("Expected an Error instance");
    }
    expect(failed.error.message).toBe("Secure random unavailable");
    expect(registry.begin("refund:cancel")).toMatchObject({
      status: "failed",
    });
  });
});
