import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { canonicalJson, serializeSignedEnvelope, type SignedEnvelope } from "@refunddesk/contracts";

import { StripeSignedRequestAuthority } from "../src/signed-request-authority.js";
import { FakeStore } from "./helpers.js";

const SIGNING_SECRET = "absec_worker_authority_test";
const REQUEST_ID = "cc3cb5d1-268c-49b4-831f-a6f392097189";
const REQUEST_NONCE = "1d48dd30-0eb4-4ce0-a731-57423e57567d";

function approvalEnvelope(overrides: Partial<SignedEnvelope> = {}): SignedEnvelope {
  return {
    account_id: "acct_testworker",
    command_json: canonicalJson({
      approval_snapshot: {
        amount_minor: "500",
        currency: "eur",
        reason: "requested_by_customer",
        requester_user_id: "usr_requester",
      },
      decision: "approve",
      expected_request_version: 0,
      request_id: REQUEST_ID,
    }),
    is_sandbox: false,
    mode: "test",
    operation: "refund_request.decide",
    request_nonce: REQUEST_NONCE,
    resource_id: "pi_worker",
    resource_type: "payment_intent",
    roles_asserted: true,
    stripe_roles: [{ name: "Administrator", type: "builtIn" }],
    user_id: "usr_approver",
    ...overrides,
  };
}

function signed(envelope: SignedEnvelope): { readonly raw: string; readonly signature: string } {
  const raw = serializeSignedEnvelope(envelope);
  return {
    raw,
    signature: Stripe.webhooks.generateTestHeaderString({
      payload: raw,
      secret: SIGNING_SECRET,
      timestamp: Math.floor(Date.now() / 1_000),
    }),
  };
}

describe("worker signed-request authority", () => {
  it("creates an approval attestation only from the exact Stripe-signed snapshot", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority(SIGNING_SECRET, store);
    const request = signed(approvalEnvelope());

    const result = await authority.verifyAndAttest(request.raw, request.signature);

    expect(result.approvalAttestationId).toBe("0dddf88a-4d04-4ae0-a0ce-4a3056d8bf4b");
    expect(result.canonicalRequestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(store.trace).toEqual(["store.attestation"]);
  });

  it("rejects a body changed after Stripe signed it", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority(SIGNING_SECRET, store);
    const request = signed(approvalEnvelope());
    const changed = request.raw.replace("500", "501");
    expect(changed).not.toBe(request.raw);

    await expect(authority.verifyAndAttest(changed, request.signature)).rejects.toMatchObject({
      code: "signature_invalid",
      status: 401,
    });
    expect(store.trace).toEqual([]);
  });

  it("rejects live mode before persistence", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority(SIGNING_SECRET, store);
    const request = signed(approvalEnvelope({ mode: "live" }));

    await expect(authority.verifyAndAttest(request.raw, request.signature)).rejects.toMatchObject({
      code: "live_forbidden",
      status: 403,
    });
    expect(store.trace).toEqual([]);
  });

  it("verifies non-approval requests without granting an attestation", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority(SIGNING_SECRET, store);
    const request = signed(
      approvalEnvelope({
        command_json: canonicalJson({}),
        operation: "payment.eligibility",
      }),
    );

    await expect(authority.verifyAndAttest(request.raw, request.signature)).resolves.toMatchObject({
      approvalAttestationId: null,
    });
    expect(store.trace).toEqual([]);
  });
});
