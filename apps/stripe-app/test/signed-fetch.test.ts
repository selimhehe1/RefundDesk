import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../src/api/canonical-json";
import { isAdministrator, prepareSignedRequest, signedApiRequest } from "../src/api/signed-fetch";

function createContext(
  overrides: {
    readonly isSandbox?: boolean;
    readonly mode?: "live" | "test";
  } = {},
): ExtensionContextValue {
  const roles = [
    { id: "super_admin", type: "builtIn", name: "Super Administrator" },
    { id: "refund_reviewer", type: "custom", name: "Refund reviewer" },
  ] as unknown as NonNullable<ExtensionContextValue["userContext"]["roles"]>;

  return {
    userContext: {
      id: "usr_123",
      account: {
        country: "FR",
        id: "acct_123",
        isSandbox: overrides.isSandbox ?? true,
      },
      locale: "en",
      roles,
    },
    environment: {
      constants: {
        API_BASE: "http://localhost:3000/api",
        PHASE0_PROBE_ENABLED: true,
        PILOT_LIVE_ENABLED: false,
      },
      mode: overrides.mode ?? "test",
      viewportID: "stripe.dashboard.payment.detail",
      objectContext: {
        id: "pi_123",
        object: "payment_intent",
      },
    },
    appContext: {
      authorizedPermissions: ["charge_read", "charge_write", "event_read", "payment_intent_read"],
    },
  };
}

const requestInput = {
  endpoint: "/v1/refund-requests/create",
  operation: "refund_request.create",
  resourceType: "payment_intent",
  resourceId: "pi_123",
  requestNonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
  command: {
    reason: "requested_by_customer",
    currency: "eur",
    amount_minor: "1250",
    justification: "Customer requested this refund.",
  },
} as const;

describe("canonicalJson", () => {
  it("sorts nested object keys and preserves array order", () => {
    expect(
      canonicalJson({
        z: 1,
        command: { reason: "duplicate", amount_minor: "100" },
        roles: ["second", "first"],
      }),
    ).toBe(
      '{"command":{"amount_minor":"100","reason":"duplicate"},"roles":["second","first"],"z":1}',
    );
  });
});

describe("prepareSignedRequest", () => {
  it("recognizes only Stripe's signed built-in Administrator role", () => {
    expect(isAdministrator(createContext())).toBe(true);
    const customAdministrator = createContext();
    customAdministrator.userContext.roles = [
      { id: "super_admin", type: "custom", name: "Super Administrator" },
    ] as unknown as NonNullable<ExtensionContextValue["userContext"]["roles"]>;
    expect(isAdministrator(customAdministrator)).toBe(false);

    const misleadingName = createContext();
    misleadingName.userContext.roles = [
      { id: "view_only", type: "builtIn", name: "Super Administrator" },
    ] as unknown as NonNullable<ExtensionContextValue["userContext"]["roles"]>;
    expect(isAdministrator(misleadingName)).toBe(false);
  });

  it.each(["", 42, null])("rejects a malformed present Stripe role ID: %s", (id) => {
    const malformedRole = createContext();
    malformedRole.userContext.roles = [
      { id, type: "builtIn", name: "Super Administrator" },
    ] as unknown as NonNullable<ExtensionContextValue["userContext"]["roles"]>;

    expect(() => isAdministrator(malformedRole)).toThrow("signed Stripe role context is invalid");
    expect(() => prepareSignedRequest(malformedRole, requestInput)).toThrow(
      "signed Stripe role context is invalid",
    );
  });

  it("locks the Stripe-sensitive body field order", () => {
    const prepared = prepareSignedRequest(createContext(), requestInput);
    expect(Object.keys(JSON.parse(prepared.body) as object)).toEqual([
      "operation",
      "request_nonce",
      "mode",
      "is_sandbox",
      "resource_type",
      "resource_id",
      "command_json",
      "stripe_roles",
      "user_id",
      "account_id",
    ]);
    expect(prepared.signaturePayload.command_json).toBe(
      '{"amount_minor":"1250","currency":"eur","justification":"Customer requested this refund.","reason":"requested_by_customer"}',
    );
  });

  it("passes authentic Stripe role definitions in the special signed field", () => {
    const prepared = prepareSignedRequest(createContext(), requestInput);
    expect(prepared.signaturePayload.stripe_roles).toEqual([
      { id: "super_admin", type: "builtIn", name: "Super Administrator" },
      { id: "refund_reviewer", type: "custom", name: "Refund reviewer" },
    ]);
    expect(prepared.signaturePayload.stripe_roles.map((role) => Object.keys(role))).toEqual([
      ["id", "type", "name"],
      ["id", "type", "name"],
    ]);
    expect(prepared.signaturePayload).not.toHaveProperty("user_id");
    expect(prepared.signaturePayload).not.toHaveProperty("account_id");
  });

  it("marks managed sandbox separately while retaining Stripe test mode", () => {
    const sandbox = prepareSignedRequest(createContext({ isSandbox: true }), requestInput);
    const testMode = prepareSignedRequest(createContext({ isSandbox: false }), requestInput);
    expect(sandbox.signaturePayload).toMatchObject({
      mode: "test",
      is_sandbox: true,
    });
    expect(testMode.signaturePayload).toMatchObject({
      mode: "test",
      is_sandbox: false,
    });
  });

  it("rejects live mode before signing or fetching", () => {
    expect(() => prepareSignedRequest(createContext({ mode: "live" }), requestInput)).toThrow(
      "Live mode is disabled",
    );
  });
});

describe("signedApiRequest", () => {
  it("uses the same payload for Stripe signing and the ordered body", async () => {
    const signatureFetcher = vi.fn(() => Promise.resolve("t=1,v1=test"));
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    await signedApiRequest(createContext(), requestInput, {
      signatureFetcher,
      fetcher,
    });

    expect(signatureFetcher).toHaveBeenCalledOnce();
    expect(signatureFetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_roles: [
          { id: "super_admin", type: "builtIn", name: "Super Administrator" },
          { id: "refund_reviewer", type: "custom", name: "Refund reviewer" },
        ],
      }),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "Stripe-Signature": "t=1,v1=test",
    });
  });

  it("does not expose a backend message or stack in client errors", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: "INTERNAL_FAILURE",
            message: "database-password and private stack trace",
            stack: "sensitive",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    });

    const promise = signedApiRequest(createContext(), requestInput, {
      signatureFetcher: () => Promise.resolve("t=1,v1=test"),
      fetcher,
    });
    await expect(promise).rejects.toThrow(
      "RefundDesk could not complete the request (INTERNAL_FAILURE).",
    );
    await expect(promise).rejects.not.toThrow(/database-password|stack/u);
  });
});
