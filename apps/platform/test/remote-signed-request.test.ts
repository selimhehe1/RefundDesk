import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalJson, serializeSignedEnvelope, type SignedEnvelope } from "@refunddesk/contracts";

import {
  RemoteSignedRequestVerifier,
  SignedRequestVerifierUnavailableError,
} from "../src/server/signed-request.js";

const ENDPOINT = "https://worker.example/internal/v1/signed-requests/verify";
const TOKEN = Buffer.alloc(32, 9).toString("base64");
const ATTESTATION_ID = "f874c90b-25b8-4628-90f7-9643cc206799";

function envelope(): SignedEnvelope {
  return {
    account_id: "acct_platformtest",
    command_json: canonicalJson({
      approval_snapshot: {
        amount_minor: "500",
        currency: "eur",
        reason: "requested_by_customer",
        requester_user_id: "usr_requester",
      },
      decision: "approve",
      expected_request_version: 0,
      request_id: "cc3cb5d1-268c-49b4-831f-a6f392097189",
    }),
    is_sandbox: false,
    mode: "test",
    operation: "refund_request.decide",
    request_nonce: "1d48dd30-0eb4-4ce0-a731-57423e57567d",
    resource_id: "pi_platform",
    resource_type: "payment_intent",
    roles_asserted: false,
    user_id: "usr_approver",
  };
}

describe("remote signed-request verifier", () => {
  it("forwards the exact body and accepts only a hash-matched attested approval", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const hash = createHash("sha256").update(raw).digest("hex");
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          approval_attestation_id: ATTESTATION_ID,
          canonical_request_hash: hash,
          envelope: signedEnvelope,
        }),
      ),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(verifier.verify(raw, "t=1,v1=synthetic")).resolves.toMatchObject({
      approvalAttestationId: ATTESTATION_ID,
      envelope: signedEnvelope,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const call = fetchImplementation.mock.calls[0];
    expect(call?.[0]).toBe(ENDPOINT);
    expect(call?.[1]?.body).toBe(raw);
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.redirect).toBe("error");
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("stripe-signature")).toBe("t=1,v1=synthetic");
  });

  it("fails closed when the verifier response is not bound to the exact body", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          approval_attestation_id: ATTESTATION_ID,
          canonical_request_hash: "0".repeat(64),
          envelope: signedEnvelope,
        }),
      ),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(verifier.verify(raw, "synthetic")).rejects.toBeInstanceOf(
      SignedRequestVerifierUnavailableError,
    );
  });
});
