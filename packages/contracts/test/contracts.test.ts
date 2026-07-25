import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  parseOperationCommand,
  refundRequestCommandSchema,
  serializeSignedEnvelope,
  signedEnvelopeSchema,
} from "../src/index.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: "x" }, list: [2, 1] })).toBe(
      '{"a":{"b":"x","y":true},"list":[2,1],"z":1}',
    );
  });
});

describe("refund request contract", () => {
  it("uses a decimal string for exact minor-unit money", () => {
    expect(
      refundRequestCommandSchema.parse({
        amount_minor: "9007199254740993",
        currency: "eur",
        reason: "requested_by_customer",
        justification: "Customer requested the refund in ticket 42.",
      }).amount_minor,
    ).toBe("9007199254740993");
  });
});

describe("signed envelope serialization", () => {
  it("locks the Stripe-sensitive field order", () => {
    const serialized = serializeSignedEnvelope({
      operation: "refund_request.create",
      request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
      mode: "test",
      is_sandbox: true,
      resource_type: "payment_intent",
      resource_id: "pi_123",
      command_json: "{}",
      stripe_roles: [
        { id: "view_only", type: "builtIn", name: "View only" },
        { type: "custom", name: "Legacy custom role" },
      ],
      user_id: "usr_123",
      account_id: "acct_123",
    });

    expect(Object.keys(JSON.parse(serialized) as object)).toEqual([
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
    const parsed = JSON.parse(serialized) as { stripe_roles: Record<string, unknown>[] };
    expect(parsed.stripe_roles.map((role) => Object.keys(role))).toEqual([
      ["id", "type", "name"],
      ["type", "name"],
    ]);
  });
});

describe("operation contracts", () => {
  it("rejects additional mutation fields", () => {
    expect(() =>
      parseOperationCommand(
        "refund_request.cancel",
        JSON.stringify({
          request_id: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
          force: true,
        }),
      ),
    ).toThrow();
  });

  it("accepts authentic Stripe role definitions only", () => {
    expect(() =>
      signedEnvelopeSchema.parse({
        operation: "context.sync",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: false,
        resource_type: "account",
        resource_id: "acct_123",
        command_json: "{}",
        stripe_roles: [{ id: "view_only", type: "builtIn", name: "View only" }],
        user_id: "usr_123",
        account_id: "acct_123",
      }),
    ).not.toThrow();
    expect(() =>
      signedEnvelopeSchema.parse({
        operation: "context.sync",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: false,
        resource_type: "account",
        resource_id: "acct_123",
        command_json: "{}",
        stripe_roles: [
          {
            id: "view_only",
            type: "builtIn",
            name: "View only",
            unexpected: true,
          },
        ],
        user_id: "usr_123",
        account_id: "acct_123",
      }),
    ).toThrow();
  });

  it("accepts only Stripe user IDs in the explicit approver list", () => {
    expect(() =>
      parseOperationCommand(
        "settings.update",
        JSON.stringify({
          approver_user_ids: ["pi_not_a_user"],
          expiration_days: 7,
          onboarding_completed: true,
        }),
      ),
    ).toThrow();
  });
});
