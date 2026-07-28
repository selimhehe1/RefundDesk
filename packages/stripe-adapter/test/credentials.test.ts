import { describe, expect, it } from "vitest";

import {
  StripeAccountMismatchError,
  StripeCredentialResolver,
  UnsupportedStripeEnvironmentError,
} from "../src/index.js";

describe("StripeCredentialResolver", () => {
  const resolver = new StripeCredentialResolver({
    platformTest: {
      apiKey: "test-key",
      expectedAccountId: "acct_test",
    },
    managedSandbox: {
      apiKey: "sandbox-key",
      expectedAccountId: "acct_sandbox",
    },
  });

  it("returns the key and expected account bound to the verified environment", () => {
    expect(
      resolver.resolve({
        active: true,
        environment: "sandbox",
        stripeAccountId: "acct_sandbox",
      }),
    ).toEqual({
      apiKey: "sandbox-key",
      expectedAccountId: "acct_sandbox",
    });
  });

  it("rejects an installation whose account does not match the credential binding", () => {
    expect(() =>
      resolver.resolve({
        active: true,
        environment: "test",
        stripeAccountId: "acct_sandbox",
      }),
    ).toThrow(StripeAccountMismatchError);
  });

  it("rejects an inactive installation before returning a credential", () => {
    expect(() =>
      resolver.resolve({
        active: false,
        environment: "test",
        stripeAccountId: "acct_test",
      }),
    ).toThrow("Stripe installation is not active");
  });

  it("fails closed for live mode", () => {
    expect(() =>
      resolver.resolve({
        active: true,
        environment: "live",
        stripeAccountId: "acct_test",
      }),
    ).toThrow(UnsupportedStripeEnvironmentError);
  });
});
