import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "../src/index.js";

describe("log redaction contract", () => {
  it("redacts fields that may contain Stripe or customer data", () => {
    let output = "";
    const stream = new Writable({
      write(
        chunk: Buffer | string,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        callback();
      },
    });
    const logger = createLogger("redaction-test", "info", stream);

    logger.info(
      {
        email: "person@example.test",
        justification: "sensitive",
        rawBody: "whsec_not-a-real-secret",
        err: Object.assign(new Error("customer text sk_test_not_real"), {
          code: "sk_test_x",
        }),
      },
      "caller accidentally repeated customer text",
    );

    expect(output).not.toContain("person@example.test");
    expect(output).not.toContain("sensitive");
    expect(output).not.toContain("customer text");
    expect(output).not.toContain("caller accidentally repeated");
    expect(output).not.toContain("sk_test_not_real");
    expect(output).toContain("UNCLASSIFIED");
  });
});
