import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../src/api/canonical-json";
import {
  isAdministrator,
  isDefinitiveMutationRejection,
  prepareSignedRequest,
  SignedExtensionRequestError,
  signedApiRequest,
  type SignaturePayload,
} from "../src/api/signed-fetch";

describe("mutation response certainty", () => {
  it("rotates only after an authoritative non-retryable 4xx rejection", () => {
    expect(
      isDefinitiveMutationRejection(
        new SignedExtensionRequestError("REQUEST_FAILED", "Rejected", 422),
      ),
    ).toBe(true);
    expect(
      isDefinitiveMutationRejection(
        new SignedExtensionRequestError("REQUEST_FAILED", "Unavailable", 500),
      ),
    ).toBe(false);
    expect(
      isDefinitiveMutationRejection(
        new SignedExtensionRequestError("REQUEST_FAILED", "Rate limited", 429),
      ),
    ).toBe(false);
    expect(
      isDefinitiveMutationRejection(
        new SignedExtensionRequestError("REQUEST_FAILED", "Request timed out", 408),
      ),
    ).toBe(false);
    expect(
      isDefinitiveMutationRejection(
        new SignedExtensionRequestError("REQUEST_FAILED", "Too early", 425),
      ),
    ).toBe(false);
    expect(
      isDefinitiveMutationRejection(
        new SignedExtensionRequestError("REQUEST_FAILED", "Unexpected intermediary response", 418),
      ),
    ).toBe(false);
    expect(
      isDefinitiveMutationRejection(
        new SignedExtensionRequestError("REQUEST_FAILED", "Capacity unavailable", 503),
      ),
    ).toBe(false);
    expect(
      isDefinitiveMutationRejection(
        new SignedExtensionRequestError("RESPONSE_INVALID", "Unreadable success", 200),
      ),
    ).toBe(false);
    expect(isDefinitiveMutationRejection(new TypeError("Network failed"))).toBe(false);
  });
});

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

  it("rejects oversized Stripe role collections", () => {
    const tooManyRoles = createContext();
    tooManyRoles.userContext.roles = Array.from({ length: 33 }, (_, index) => ({
      id: `role_${index}`,
      type: "custom",
      name: `Role ${index}`,
    })) as unknown as NonNullable<ExtensionContextValue["userContext"]["roles"]>;
    expect(() => prepareSignedRequest(tooManyRoles, requestInput)).toThrow(
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
      "roles_asserted",
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
    expect(prepared.signaturePayload.roles_asserted).toBe(true);
    if (!prepared.signaturePayload.roles_asserted) {
      throw new Error("Expected an asserted Administrator payload.");
    }
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

describe("signedApiRequest error reporting", () => {
  function failingRequest(body: string, status = 422) {
    const context = createContext();
    return signedApiRequest(context, requestInput, {
      signatureFetcher: () => Promise.resolve("t=1,v1=test"),
      fetcher: () =>
        Promise.resolve(
          new Response(body, { status, headers: { "Content-Type": "application/json" } }),
        ),
    });
  }

  it("turns a code into language the person can act on, never the raw code", async () => {
    await expect(
      failingRequest(
        JSON.stringify({
          code: "NO_DISTINCT_APPROVER",
          message: "internal detail must not be exposed",
        }),
      ),
    ).rejects.toThrow("a requester can never approve their own refund");
  });

  it("never lets the server's message reach the user", async () => {
    let observed: unknown;
    try {
      await failingRequest(
        JSON.stringify({ code: "SELF_APPROVAL", message: "internal detail must not be exposed" }),
      );
    } catch (error) {
      observed = error;
    }
    expect(String(observed)).not.toContain("internal detail must not be exposed");
    expect(String(observed)).not.toContain("SELF_APPROVAL");
    expect(String(observed)).toContain("You cannot approve or reject your own request.");
  });

  it("keeps an unrecognised code visible for support but refuses a malformed one", async () => {
    await expect(failingRequest(JSON.stringify({ code: "SOME_FUTURE_CODE" }))).rejects.toThrow(
      "RefundDesk could not complete the request (SOME_FUTURE_CODE).",
    );
    await expect(
      failingRequest(JSON.stringify({ code: "<script>alert(1)</script>" })),
    ).rejects.toThrow("RefundDesk could not complete the request. Try again.");
    await expect(failingRequest(JSON.stringify({ unexpected: true }))).rejects.toThrow(
      "RefundDesk could not complete the request. Try again.",
    );
  });
});

describe("signedApiRequest", () => {
  it("uses the original Stripe role objects for signing and a canonical ordered body", async () => {
    const context = createContext();
    const rawRole = {
      name: "Super Administrator",
      type: "builtIn",
      id: "super_admin",
      permissions: ["charge_read", "charge_write"],
    } as const;
    const rawRoles = [rawRole] as unknown as NonNullable<
      ExtensionContextValue["userContext"]["roles"]
    >;
    context.userContext.roles = rawRoles;
    const signatureFetcher = vi.fn((payload: SignaturePayload) => {
      void payload;
      return Promise.resolve("t=1,v1=test");
    });
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

    await signedApiRequest(context, requestInput, {
      signatureFetcher,
      fetcher,
    });

    expect(signatureFetcher).toHaveBeenCalledOnce();
    const [signaturePayload] = signatureFetcher.mock.calls[0] ?? [];
    expect(signaturePayload?.roles_asserted).toBe(true);
    if (signaturePayload === undefined || !signaturePayload.roles_asserted) {
      throw new Error("Expected an asserted Administrator payload.");
    }
    expect(signaturePayload?.stripe_roles).toBe(rawRoles);
    expect(signaturePayload?.stripe_roles[0]).toBe(rawRole);
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "Stripe-Signature": "t=1,v1=test",
    });
    if (typeof init?.body !== "string") {
      throw new Error("Expected a serialized request body.");
    }
    const parsedBody = JSON.parse(init.body) as {
      readonly stripe_roles: Record<string, unknown>[];
    };
    expect(parsedBody.stripe_roles).toEqual([
      { id: "super_admin", type: "builtIn", name: "Super Administrator" },
    ]);
    expect(Object.keys(parsedBody.stripe_roles[0] ?? {})).toEqual(["id", "type", "name"]);
  });

  it("omits the role assertion for a non-admin while preserving identity and command data", async () => {
    const context = createContext();
    context.userContext.roles = [
      { id: "view_only", type: "builtIn", name: "View only" },
    ] as unknown as NonNullable<ExtensionContextValue["userContext"]["roles"]>;
    const signatureFetcher = vi.fn((payload: SignaturePayload) => {
      void payload;
      return Promise.resolve("t=1,v1=test");
    });
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

    await signedApiRequest(context, requestInput, { signatureFetcher, fetcher });

    const [signaturePayload] = signatureFetcher.mock.calls[0] ?? [];
    expect(signaturePayload?.roles_asserted).toBe(false);
    expect(signaturePayload).not.toHaveProperty("stripe_roles");
    expect(signaturePayload).toMatchObject({
      command_json:
        '{"amount_minor":"1250","currency":"eur","justification":"Customer requested this refund.","reason":"requested_by_customer"}',
      operation: "refund_request.create",
      resource_id: "pi_123",
    });
    const [, init] = fetcher.mock.calls[0] ?? [];
    if (typeof init?.body !== "string") {
      throw new Error("Expected a serialized request body.");
    }
    const parsedBody = JSON.parse(init.body) as Record<string, unknown>;
    expect(parsedBody["roles_asserted"]).toBe(false);
    expect(parsedBody).not.toHaveProperty("stripe_roles");
  });

  it("omits resource_id from account-scoped payloads and bodies", () => {
    const prepared = prepareSignedRequest(createContext(), {
      endpoint: "/v1/refund-requests/list",
      operation: "refund_request.list",
      resourceType: "account",
      requestNonce: "1c06e580-8e3d-45ee-a258-ad97ab40a90a",
      command: { scope: "my_requests", limit: 25 },
    });

    expect(prepared.signaturePayload).not.toHaveProperty("resource_id");
    expect(Object.keys(JSON.parse(prepared.body) as object)).toEqual([
      "operation",
      "request_nonce",
      "mode",
      "is_sandbox",
      "resource_type",
      "command_json",
      "roles_asserted",
      "stripe_roles",
      "user_id",
      "account_id",
    ]);
  });

  it("does not call the backend when Stripe signature generation fails", async () => {
    const fetcher = vi.fn();

    await expect(
      signedApiRequest(createContext(), requestInput, {
        signatureFetcher: () => Promise.reject(new Error("Stripe signature unavailable")),
        fetcher,
      }),
    ).rejects.toThrow("Stripe signature unavailable");
    expect(fetcher).not.toHaveBeenCalled();
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

  it.each([429, 503])(
    "preserves retryable HTTP %i as a non-definitive mutation outcome",
    async (status) => {
      const fetcher = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: status === 429 ? "RATE_LIMITED" : "RATE_LIMITER_UNAVAILABLE",
              message: "internal detail must not be exposed",
            }),
            {
              status,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "7",
              },
            },
          ),
        ),
      );

      let observed: unknown;
      try {
        await signedApiRequest(createContext(), requestInput, {
          signatureFetcher: () => Promise.resolve("t=1,v1=test"),
          fetcher,
        });
      } catch (error) {
        observed = error;
      }

      expect(observed).toBeInstanceOf(SignedExtensionRequestError);
      expect(observed).toMatchObject({
        code: "REQUEST_FAILED",
        status,
      });
      expect(isDefinitiveMutationRejection(observed)).toBe(false);
      expect(String(observed)).not.toContain("internal detail must not be exposed");
    },
  );
});
