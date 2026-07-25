import { describe, expect, it } from "vitest";

import { StripeCredentialResolver, UnsupportedStripeEnvironmentError } from "../src/index.js";

describe("StripeCredentialResolver", () => {
  const resolver = new StripeCredentialResolver({
    platformTestKey: "test-key",
    managedSandboxKey: "sandbox-key",
  });

  it("selects credentials only from the verified installation environment", () => {
    expect(
      resolver.resolve({
        active: true,
        environment: "sandbox",
        stripeAccountId: "acct_123",
      }),
    ).toBe("sandbox-key");
  });

  it("fails closed for live mode", () => {
    expect(() =>
      resolver.resolve({
        active: true,
        environment: "live",
        stripeAccountId: "acct_123",
      }),
    ).toThrow(UnsupportedStripeEnvironmentError);
  });
});
