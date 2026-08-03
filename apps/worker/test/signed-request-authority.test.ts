import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { canonicalJson, serializeSignedEnvelope, type SignedEnvelope } from "@refunddesk/contracts";

import { StripeSignedRequestAuthority } from "../src/signed-request-authority.js";
import { FakeStore } from "./helpers.js";

const SIGNING_SECRET = ["absec", "worker", "authority", "E".repeat(24)].join("_");
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

function signed(
  envelope: SignedEnvelope,
  secret = SIGNING_SECRET,
): { readonly raw: string; readonly signature: string } {
  const raw = serializeSignedEnvelope(envelope);
  return {
    raw,
    signature: Stripe.webhooks.generateTestHeaderString({
      payload: raw,
      secret,
      timestamp: Math.floor(Date.now() / 1_000),
    }),
  };
}

describe("worker signed-request authority", () => {
  it("verifies an approval request without touching the attestation store", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority(SIGNING_SECRET, store);
    const request = signed(approvalEnvelope());

    const result = await authority.verify(request.raw, request.signature);

    expect(result.canonicalRequestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.envelope).toEqual(approvalEnvelope());
    expect(result).not.toHaveProperty("approvalAttestationId");
    expect(store.trace).toEqual([]);
  });

  it("re-verifies the exact approval bytes before persisting an attestation", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority(SIGNING_SECRET, store);
    const request = signed(approvalEnvelope());

    const verified = await authority.verify(request.raw, request.signature);
    const attested = await authority.attestApproval(request.raw, request.signature);

    expect(attested.approvalAttestationId).toBe("0dddf88a-4d04-4ae0-a0ce-4a3056d8bf4b");
    expect(attested.canonicalRequestHash).toBe(verified.canonicalRequestHash);
    expect(attested.envelope).toEqual(verified.envelope);
    expect(store.trace).toEqual(["store.attestation"]);
  });

  it("does not carry verification authority across a changed attestation request", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority(SIGNING_SECRET, store);
    const request = signed(approvalEnvelope());
    await authority.verify(request.raw, request.signature);
    const changed = request.raw.replace("500", "501");
    expect(changed).not.toBe(request.raw);

    await expect(authority.attestApproval(changed, request.signature)).rejects.toMatchObject({
      code: "signature_invalid",
      status: 401,
    });
    expect(store.trace).toEqual([]);
  });

  it("rejects live mode before persistence", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority(SIGNING_SECRET, store);
    const request = signed(approvalEnvelope({ mode: "live" }));

    await expect(authority.verify(request.raw, request.signature)).rejects.toMatchObject({
      code: "live_forbidden",
      status: 403,
    });
    expect(store.trace).toEqual([]);
  });

  it("refuses to attest non-decision and rejection commands", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority(SIGNING_SECRET, store);
    const nonDecision = signed(
      approvalEnvelope({
        command_json: canonicalJson({}),
        operation: "payment.eligibility",
      }),
    );
    const rejection = signed(
      approvalEnvelope({
        command_json: canonicalJson({
          decision: "reject",
          justification: "The refund request was reviewed and rejected.",
          request_id: REQUEST_ID,
        }),
      }),
    );

    await expect(
      authority.attestApproval(nonDecision.raw, nonDecision.signature),
    ).rejects.toMatchObject({ code: "envelope_invalid", status: 400 });
    await expect(
      authority.attestApproval(rejection.raw, rejection.signature),
    ).rejects.toMatchObject({ code: "envelope_invalid", status: 400 });
    expect(store.trace).toEqual([]);
  });
});

describe("App signing secret rotation overlap", () => {
  // Stripe keeps a retired App signing secret valid for an overlap window and may sign an
  // extension request with either. A runtime holding one refuses whichever half it does not
  // have, which the merchant sees as a Dashboard action that simply fails.
  const ROLLED_SECRET = ["absec", "worker", "authority", "R".repeat(24)].join("_");
  const FOREIGN_SECRET = ["absec", "someone", "else", "X".repeat(24)].join("_");

  it("accepts a request still signed with the previous secret during a roll", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority([ROLLED_SECRET, SIGNING_SECRET], store);
    const request = signed(approvalEnvelope(), SIGNING_SECRET);

    const result = await authority.verify(request.raw, request.signature);

    expect(result.envelope).toEqual(approvalEnvelope());
  });

  it("accepts a request signed with the new secret in the same roll", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority([ROLLED_SECRET, SIGNING_SECRET], store);
    const request = signed(approvalEnvelope(), ROLLED_SECRET);

    const result = await authority.verify(request.raw, request.signature);

    expect(result.envelope).toEqual(approvalEnvelope());
  });

  it("still refuses a secret that is neither the new nor the previous one", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority([ROLLED_SECRET, SIGNING_SECRET], store);
    const request = signed(approvalEnvelope(), FOREIGN_SECRET);

    await expect(authority.verify(request.raw, request.signature)).rejects.toMatchObject({
      code: "signature_invalid",
      status: 401,
    });
    expect(store.trace).toEqual([]);
  });

  it("refuses the previous secret once the roll is finished", async () => {
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority([ROLLED_SECRET], store);
    const request = signed(approvalEnvelope(), SIGNING_SECRET);

    await expect(authority.verify(request.raw, request.signature)).rejects.toMatchObject({
      code: "signature_invalid",
      status: 401,
    });
  });

  it("reports a missing signature as missing, not as invalid against the last secret", async () => {
    // Only an invalid signature depends on which secret was used. Retrying the other failures
    // across secrets would report the last attempt instead of the real cause.
    const store = new FakeStore();
    const authority = new StripeSignedRequestAuthority([ROLLED_SECRET, SIGNING_SECRET], store);
    const request = signed(approvalEnvelope());

    await expect(authority.verify(request.raw, null)).rejects.toMatchObject({
      code: "signature_missing",
      status: 401,
    });
  });

  it("refuses to exist with no secret at all", () => {
    const store = new FakeStore();
    expect(() => new StripeSignedRequestAuthority([], store)).toThrow("SIGNING_SECRET_REQUIRED");
  });
});
