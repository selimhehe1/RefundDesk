export const REQUEST_BODY_DEADLINE_MS = 30_000;
export const MAXIMUM_REQUEST_BODY_CHUNKS = 1_024;

export type BoundedRequestBodyErrorCode = "body_invalid" | "deadline_exceeded" | "too_large";

export class BoundedRequestBodyError extends Error {
  constructor(readonly code: BoundedRequestBodyErrorCode) {
    super("The bounded request body could not be read");
    this.name = "BoundedRequestBodyError";
  }
}

export async function readBoundedRequestBody(
  request: Request,
  options: {
    readonly deadlineAtMs: number;
    readonly maximumBytes: number;
  },
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(options.deadlineAtMs) ||
    options.deadlineAtMs < 0 ||
    !Number.isSafeInteger(options.maximumBytes) ||
    options.maximumBytes <= 0
  ) {
    throw new BoundedRequestBodyError("body_invalid");
  }
  if (Date.now() >= options.deadlineAtMs) {
    throw new BoundedRequestBodyError("deadline_exceeded");
  }
  if (request.body === null) {
    return Buffer.alloc(0);
  }

  const reader = request.body.getReader();
  let body: Buffer | undefined;
  let chunkCount = 0;
  let totalBytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new BoundedRequestBodyError("deadline_exceeded")),
      Math.max(1, Math.min(2_147_483_647, options.deadlineAtMs - Date.now())),
    );
  });
  const consume = async (): Promise<Buffer> => {
    while (true) {
      // An already-buffered stream can resolve reads only through microtasks and starve timers.
      // Checking the absolute clock inside the loop keeps that path inside the same deadline.
      if (Date.now() >= options.deadlineAtMs) {
        throw new BoundedRequestBodyError("deadline_exceeded");
      }
      const result = await reader.read();
      if (Date.now() >= options.deadlineAtMs) {
        throw new BoundedRequestBodyError("deadline_exceeded");
      }
      if (result.done) {
        return body?.subarray(0, totalBytes) ?? Buffer.alloc(0);
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new BoundedRequestBodyError("body_invalid");
      }
      chunkCount += 1;
      if (chunkCount > MAXIMUM_REQUEST_BODY_CHUNKS) {
        throw new BoundedRequestBodyError("too_large");
      }
      if (result.value.byteLength > options.maximumBytes - totalBytes) {
        throw new BoundedRequestBodyError("too_large");
      }
      if (result.value.byteLength > 0) {
        // Avoid Buffer's shared small-allocation pool so each admitted request owns exactly one
        // allocation whose capacity is the configured maximum.
        body ??= Buffer.allocUnsafeSlow(options.maximumBytes);
        body.set(result.value, totalBytes);
        totalBytes += result.value.byteLength;
      }
    }
  };

  try {
    // Race the complete consumer once. Racing every read against the same promise retains one
    // reaction and closure per chunk until the deadline settles.
    return await Promise.race([consume(), deadline]);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    try {
      reader.releaseLock();
    } catch {
      // Cancellation settles any pending read; the request can release the lock afterwards.
    }
  }
}
