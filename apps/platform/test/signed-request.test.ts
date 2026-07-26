import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { serializeSignedEnvelope, type SignedEnvelope } from "@refunddesk/contracts";

import { SignedRequestError, verifySignedExtensionRequest } from "../src/server/signed-request.js";

const signingSecret = "absec_synthetic";
const envelope: SignedEnvelope = {
  operation: "payment.eligibility",
  request_nonce: "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9",
  mode: "test",
  is_sandbox: false,
  resource_type: "payment_intent",
  resource_id: "pi_synthetic",
  command_json: "{}",
  roles_asserted: true,
  stripe_roles: [{ id: "view_only", type: "builtIn", name: "View only" }],
  user_id: "usr_synthetic",
  account_id: "acct_synthetic",
};
const unassertedEnvelope: SignedEnvelope = {
  operation: "settings.get",
  request_nonce: "4c47821e-4248-4d38-ab97-b1bcaee68e4e",
  mode: "test",
  is_sandbox: false,
  resource_type: "account",
  command_json: "{}",
  roles_asserted: false,
  user_id: "usr_synthetic",
  account_id: "acct_synthetic",
};

function signatureFor(payload: string): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: signingSecret,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

describe("verifySignedExtensionRequest", () => {
  it("accepts the exact raw payload signed by Stripe", () => {
    const raw = serializeSignedEnvelope(envelope);
    expect(verifySignedExtensionRequest(raw, signatureFor(raw), signingSecret).envelope).toEqual(
      envelope,
    );
  });

  it("accepts an account-scoped payload without a resource ID or role assertion", () => {
    const raw = serializeSignedEnvelope(unassertedEnvelope);

    expect(raw).not.toContain('"resource_id"');
    expect(raw).not.toContain('"stripe_roles"');
    expect(verifySignedExtensionRequest(raw, signatureFor(raw), signingSecret).envelope).toEqual(
      unassertedEnvelope,
    );
  });

  it("rejects reordered bytes even when the JSON values are equivalent", () => {
    const { account_id: accountId, ...remainingEnvelope } = envelope;
    const reordered = JSON.stringify({
      account_id: accountId,
      ...remainingEnvelope,
    });

    expect(() =>
      verifySignedExtensionRequest(reordered, signatureFor(reordered), signingSecret),
    ).toThrow(SignedRequestError);
  });

  it("rejects additional signed fields at the strict schema boundary", () => {
    const raw = JSON.stringify({ ...envelope, unexpected: true });
    expect(() => verifySignedExtensionRequest(raw, signatureFor(raw), signingSecret)).toThrowError(
      expect.objectContaining({ code: "ENVELOPE_INVALID" }),
    );
  });

  it("rejects signatures older than the five-minute tolerance", () => {
    const raw = serializeSignedEnvelope(envelope);
    const expiredSignature = Stripe.webhooks.generateTestHeaderString({
      payload: raw,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000) - 301,
    });
    expect(() => verifySignedExtensionRequest(raw, expiredSignature, signingSecret)).toThrowError(
      expect.objectContaining({ code: "SIGNATURE_INVALID" }),
    );
  });
});
