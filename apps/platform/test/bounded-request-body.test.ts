import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAXIMUM_REQUEST_BODY_CHUNKS,
  readBoundedRequestBody,
} from "../src/server/bounded-request-body.js";

function fragmentedRequest(
  chunkCount: number,
  chunk: Uint8Array,
): {
  readonly request: Request;
  readonly wasCancelled: () => boolean;
} {
  let cancelled = false;
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true;
    },
    pull: (controller) => {
      if (emitted >= chunkCount) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(chunk);
    },
  });
  const init: RequestInit & { duplex: "half" } = { body, duplex: "half", method: "POST" };
  return {
    request: new Request("https://refunddesk.invalid/", init),
    wasCancelled: () => cancelled,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readBoundedRequestBody", () => {
  it("copies a fragmented body into one bounded allocation", async () => {
    const allocation = vi.spyOn(Buffer, "allocUnsafeSlow");
    const { request } = fragmentedRequest(32, new Uint8Array([0x61]));

    const body = await readBoundedRequestBody(request, {
      deadlineAtMs: Date.now() + 1_000,
      maximumBytes: 32,
    });

    expect(body.toString("utf8")).toBe("a".repeat(32));
    expect(allocation).toHaveBeenCalledTimes(1);
    expect(allocation).toHaveBeenCalledWith(32);
  });

  it("rejects and cancels excessive zero-length fragmentation", async () => {
    const { request, wasCancelled } = fragmentedRequest(
      MAXIMUM_REQUEST_BODY_CHUNKS * 100,
      new Uint8Array(0),
    );

    await expect(
      readBoundedRequestBody(request, {
        deadlineAtMs: Date.now() + 1_000,
        maximumBytes: 32 * 1_024,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    await Promise.resolve();
    expect(wasCancelled()).toBe(true);
  });

  it("checks the absolute clock while already-buffered reads starve the timer", async () => {
    let observedMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      observedMs += 1;
      return observedMs;
    });
    const { request, wasCancelled } = fragmentedRequest(100_000, new Uint8Array(0));

    await expect(
      readBoundedRequestBody(request, { deadlineAtMs: 20, maximumBytes: 32 * 1_024 }),
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
    await Promise.resolve();
    expect(wasCancelled()).toBe(true);
  });
});
