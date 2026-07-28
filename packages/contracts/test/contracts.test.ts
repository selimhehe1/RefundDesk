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
  it.each([
    {
      name: "account scope without an asserted role set",
      envelope: {
        operation: "context.sync",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: true,
        resource_type: "account",
        command_json: "{}",
        roles_asserted: false,
        user_id: "usr_123",
        account_id: "acct_123",
      },
      expectedKeys: [
        "operation",
        "request_nonce",
        "mode",
        "is_sandbox",
        "resource_type",
        "command_json",
        "roles_asserted",
        "user_id",
        "account_id",
      ],
    },
    {
      name: "account scope with an asserted role set",
      envelope: {
        operation: "context.sync",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: true,
        resource_type: "account",
        command_json: "{}",
        roles_asserted: true,
        stripe_roles: [
          { id: "administrator", type: "builtIn", name: "Administrator" },
          { type: "custom", name: "Legacy custom role" },
        ],
        user_id: "usr_123",
        account_id: "acct_123",
      },
      expectedKeys: [
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
      ],
    },
    {
      name: "payment scope without an asserted role set",
      envelope: {
        operation: "refund_request.create",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: true,
        resource_type: "payment_intent",
        resource_id: "pi_123",
        command_json: "{}",
        roles_asserted: false,
        user_id: "usr_123",
        account_id: "acct_123",
      },
      expectedKeys: [
        "operation",
        "request_nonce",
        "mode",
        "is_sandbox",
        "resource_type",
        "resource_id",
        "command_json",
        "roles_asserted",
        "user_id",
        "account_id",
      ],
    },
    {
      name: "payment scope with an asserted role set",
      envelope: {
        operation: "refund_request.create",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: true,
        resource_type: "payment_intent",
        resource_id: "pi_123",
        command_json: "{}",
        roles_asserted: true,
        stripe_roles: [
          { id: "administrator", type: "builtIn", name: "Administrator" },
          { type: "custom", name: "Legacy custom role" },
        ],
        user_id: "usr_123",
        account_id: "acct_123",
      },
      expectedKeys: [
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
      ],
    },
  ])("locks the canonical field order for $name", ({ envelope, expectedKeys }) => {
    const parsedEnvelope = signedEnvelopeSchema.parse(envelope);
    const serialized = serializeSignedEnvelope(parsedEnvelope);
    const serializedEnvelope = JSON.parse(serialized) as Record<string, unknown>;

    expect(Object.keys(serializedEnvelope)).toEqual(expectedKeys);
    expect(signedEnvelopeSchema.parse(serializedEnvelope)).toEqual(parsedEnvelope);

    if (parsedEnvelope.roles_asserted) {
      expect(
        (serializedEnvelope.stripe_roles as Record<string, unknown>[]).map((role) =>
          Object.keys(role),
        ),
      ).toEqual([
        ["id", "type", "name"],
        ["type", "name"],
      ]);
    } else {
      expect(serializedEnvelope).not.toHaveProperty("stripe_roles");
    }
  });

  it.each([
    {
      name: "an account resource with resource_id",
      envelope: {
        operation: "context.sync",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: false,
        resource_type: "account",
        resource_id: "acct_123",
        command_json: "{}",
        roles_asserted: false,
        user_id: "usr_123",
        account_id: "acct_123",
      },
    },
    {
      name: "a payment resource without resource_id",
      envelope: {
        operation: "refund_request.create",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: false,
        resource_type: "payment_intent",
        command_json: "{}",
        roles_asserted: false,
        user_id: "usr_123",
        account_id: "acct_123",
      },
    },
    {
      name: "unasserted roles with stripe_roles",
      envelope: {
        operation: "context.sync",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: false,
        resource_type: "account",
        command_json: "{}",
        roles_asserted: false,
        stripe_roles: [{ id: "view_only", type: "builtIn", name: "View only" }],
        user_id: "usr_123",
        account_id: "acct_123",
      },
    },
    {
      name: "asserted roles without stripe_roles",
      envelope: {
        operation: "context.sync",
        request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
        mode: "test",
        is_sandbox: false,
        resource_type: "account",
        command_json: "{}",
        roles_asserted: true,
        user_id: "usr_123",
        account_id: "acct_123",
      },
    },
  ])("rejects $name", ({ envelope }) => {
    expect(() => signedEnvelopeSchema.parse(envelope)).toThrow();
  });
});

describe("operation contracts", () => {
  const requestId = "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9";
  const approvalSnapshot = {
    amount_minor: "1250",
    currency: "eur",
    reason: "requested_by_customer",
    requester_user_id: "usr_Requester",
  } as const;

  it("requires an exact financial snapshot for approval", () => {
    expect(
      parseOperationCommand(
        "refund_request.decide",
        JSON.stringify({
          request_id: requestId,
          decision: "approve",
          expected_request_version: 3,
          approval_snapshot: approvalSnapshot,
        }),
      ),
    ).toEqual({
      request_id: requestId,
      decision: "approve",
      expected_request_version: 3,
      approval_snapshot: approvalSnapshot,
    });

    expect(() =>
      parseOperationCommand(
        "refund_request.decide",
        JSON.stringify({
          request_id: requestId,
          decision: "approve",
          expected_request_version: 3,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOperationCommand(
        "refund_request.decide",
        JSON.stringify({
          request_id: requestId,
          decision: "approve",
          approval_snapshot: approvalSnapshot,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOperationCommand(
        "refund_request.decide",
        JSON.stringify({
          request_id: requestId,
          decision: "approve",
          expected_request_version: 3,
          approval_snapshot: approvalSnapshot,
          justification: "Approval must not carry a rejection reason.",
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOperationCommand(
        "refund_request.decide",
        JSON.stringify({
          request_id: requestId,
          decision: "approve",
          expected_request_version: -1,
          approval_snapshot: approvalSnapshot,
        }),
      ),
    ).toThrow();
  });

  it("requires a rejection justification and forbids an approval snapshot", () => {
    expect(
      parseOperationCommand(
        "refund_request.decide",
        JSON.stringify({
          request_id: requestId,
          decision: "reject",
          justification: "The amount does not match the support ticket.",
        }),
      ),
    ).toEqual({
      request_id: requestId,
      decision: "reject",
      justification: "The amount does not match the support ticket.",
    });

    expect(() =>
      parseOperationCommand(
        "refund_request.decide",
        JSON.stringify({
          request_id: requestId,
          decision: "reject",
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOperationCommand(
        "refund_request.decide",
        JSON.stringify({
          request_id: requestId,
          decision: "reject",
          justification: "The amount does not match the support ticket.",
          approval_snapshot: approvalSnapshot,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOperationCommand(
        "refund_request.decide",
        JSON.stringify({
          request_id: requestId,
          decision: "reject",
          justification: "The amount does not match the support ticket.",
          expected_request_version: 3,
        }),
      ),
    ).toThrow();
  });

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
        command_json: "{}",
        roles_asserted: true,
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
        command_json: "{}",
        roles_asserted: true,
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
