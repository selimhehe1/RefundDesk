import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalJson, serializeSignedEnvelope, type SignedEnvelope } from "@refunddesk/contracts";

import {
  RemoteSignedRequestVerifier,
  SignedRequestAttestationConflictError,
  SignedRequestVerifierUnavailableError,
} from "../src/server/signed-request.js";

const ENDPOINT = "https://worker.example/internal/v1/signed-requests/verify";
const TOKEN = Buffer.alloc(32, 9).toString("base64");
const ATTESTATION_ID = "f874c90b-25b8-4628-90f7-9643cc206799";
const SIGNATURE = "t=1,v1=synthetic";

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

function rejectionEnvelope(): SignedEnvelope {
  return {
    ...envelope(),
    command_json: canonicalJson({
      decision: "reject",
      justification: "The payment does not match the support request.",
      request_id: "cc3cb5d1-268c-49b4-831f-a6f392097189",
    }),
  };
}

function verifierResponse(signedEnvelope: SignedEnvelope, raw: string): Response {
  return Response.json({
    canonical_request_hash: createHash("sha256").update(raw).digest("hex"),
    envelope: signedEnvelope,
  });
}

function attestationResponse(signedEnvelope: SignedEnvelope, raw: string): Response {
  return Response.json({
    approval_attestation_id: ATTESTATION_ID,
    canonical_request_hash: createHash("sha256").update(raw).digest("hex"),
    envelope: signedEnvelope,
  });
}

describe("remote signed-request verifier", () => {
  it("forwards the exact body and verifies an approval without persisting an attestation", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const hash = createHash("sha256").update(raw).digest("hex");
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          canonical_request_hash: hash,
          envelope: signedEnvelope,
        }),
      ),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(verifier.verify(raw, SIGNATURE)).resolves.toMatchObject({
      canonicalRequestHash: Buffer.from(hash, "hex"),
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
    expect(headers.get("stripe-signature")).toBe(SIGNATURE);
  });

  it("reattests the same exact signed bytes on the dedicated endpoint", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(verifierResponse(signedEnvelope, raw))
      .mockResolvedValueOnce(attestationResponse(signedEnvelope, raw));
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    const verified = await verifier.verify(raw, SIGNATURE);
    await expect(verifier.attestApproval(verified, SIGNATURE)).resolves.toBe(ATTESTATION_ID);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const attestationCall = fetchImplementation.mock.calls[1];
    expect(attestationCall?.[0]).toBe("https://worker.example/internal/v1/signed-requests/attest");
    expect(attestationCall?.[1]?.body).toBe(raw);
    expect(new Headers(attestationCall?.[1]?.headers).get("stripe-signature")).toBe(SIGNATURE);
  });

  it("fails before attestation when the first-pass hash no longer matches the raw bytes", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(verifierResponse(signedEnvelope, raw));
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);
    const verified = await verifier.verify(raw, SIGNATURE);
    verified.canonicalRequestHash.fill(0);

    await expect(verifier.attestApproval(verified, SIGNATURE)).rejects.toBeInstanceOf(
      SignedRequestVerifierUnavailableError,
    );
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("maps only an attestation 409 to a durable nonce conflict", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(verifierResponse(signedEnvelope, raw))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);
    const verified = await verifier.verify(raw, SIGNATURE);

    await expect(verifier.attestApproval(verified, SIGNATURE)).rejects.toBeInstanceOf(
      SignedRequestAttestationConflictError,
    );
  });

  it.each([201, 204])(
    "requires an exact worker 200 from the attestation endpoint instead of HTTP %i",
    async (status) => {
      const signedEnvelope = envelope();
      const raw = serializeSignedEnvelope(signedEnvelope);
      const attestationResult =
        status === 201
          ? Response.json(
              {
                approval_attestation_id: ATTESTATION_ID,
                canonical_request_hash: createHash("sha256").update(raw).digest("hex"),
                envelope: signedEnvelope,
              },
              { status },
            )
          : new Response(null, { status });
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(verifierResponse(signedEnvelope, raw))
        .mockResolvedValueOnce(attestationResult);
      const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);
      const verified = await verifier.verify(raw, SIGNATURE);

      await expect(verifier.attestApproval(verified, SIGNATURE)).rejects.toBeInstanceOf(
        SignedRequestVerifierUnavailableError,
      );
    },
  );

  it.each([null, ""])(
    "rejects a missing signature before allocating a remote request (%s)",
    async (signature) => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

      await expect(verifier.verify(serializeSignedEnvelope(envelope()), signature)).rejects.toEqual(
        expect.objectContaining({ code: "SIGNATURE_MISSING" }),
      );
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the verifier cannot be reached", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error("synthetic network failure")),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(
      verifier.verify(serializeSignedEnvelope(envelope()), SIGNATURE),
    ).rejects.toBeInstanceOf(SignedRequestVerifierUnavailableError);
  });

  it("maps only a worker 401 to an invalid Stripe signature", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(verifier.verify(serializeSignedEnvelope(envelope()), SIGNATURE)).rejects.toEqual(
      expect.objectContaining({ code: "SIGNATURE_INVALID" }),
    );
  });

  it("treats a worker 403 service-auth rejection as verifier unavailability", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 403 })),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(
      verifier.verify(serializeSignedEnvelope(envelope()), SIGNATURE),
    ).rejects.toBeInstanceOf(SignedRequestVerifierUnavailableError);
  });

  it("maps a worker 400 to an invalid signed envelope", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 400 })),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(verifier.verify(serializeSignedEnvelope(envelope()), SIGNATURE)).rejects.toEqual(
      expect.objectContaining({ code: "ENVELOPE_INVALID" }),
    );
  });

  it.each([404, 409, 429, 500, 503])(
    "fails closed when the verifier returns an unmapped status (%i)",
    async (status) => {
      const fetchImplementation = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(null, { status })),
      );
      const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

      await expect(
        verifier.verify(serializeSignedEnvelope(envelope()), SIGNATURE),
      ).rejects.toBeInstanceOf(SignedRequestVerifierUnavailableError);
    },
  );

  it.each([201, 204])(
    "requires an exact worker 200 instead of accepting HTTP %i",
    async (status) => {
      const signedEnvelope = envelope();
      const raw = serializeSignedEnvelope(signedEnvelope);
      const response =
        status === 201
          ? Response.json(
              {
                canonical_request_hash: createHash("sha256").update(raw).digest("hex"),
                envelope: signedEnvelope,
              },
              { status },
            )
          : new Response(null, { status });
      const fetchImplementation = vi.fn<typeof fetch>(() => Promise.resolve(response));
      const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

      await expect(verifier.verify(raw, SIGNATURE)).rejects.toBeInstanceOf(
        SignedRequestVerifierUnavailableError,
      );
    },
  );

  it.each([
    ["malformed JSON", () => new Response("{")],
    [
      "a response outside the strict schema",
      () =>
        Response.json({
          approval_attestation_id: ATTESTATION_ID,
          canonical_request_hash: "0".repeat(64),
          envelope: envelope(),
          unexpected: true,
        }),
    ],
  ])("fails closed on %s", async (_description, responseFactory) => {
    const fetchImplementation = vi.fn<typeof fetch>(() => Promise.resolve(responseFactory()));
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(
      verifier.verify(serializeSignedEnvelope(envelope()), SIGNATURE),
    ).rejects.toBeInstanceOf(SignedRequestVerifierUnavailableError);
  });

  it("fails closed when the verifier response is not bound to the exact body", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          canonical_request_hash: "0".repeat(64),
          envelope: signedEnvelope,
        }),
      ),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(verifier.verify(raw, SIGNATURE)).rejects.toBeInstanceOf(
      SignedRequestVerifierUnavailableError,
    );
  });

  it("fails closed when the response envelope is not the exact canonical request", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const alteredEnvelope = { ...signedEnvelope, user_id: "usr_other" };
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(verifierResponse(alteredEnvelope, raw)),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(verifier.verify(raw, SIGNATURE)).rejects.toBeInstanceOf(
      SignedRequestVerifierUnavailableError,
    );
  });

  it("accepts hash-matched approvals and non-approvals without any verification-side effect", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(verifierResponse(signedEnvelope, raw)),
    );
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);

    await expect(verifier.verify(raw, SIGNATURE)).resolves.toMatchObject({
      envelope: signedEnvelope,
    });

    const rejectedEnvelope = rejectionEnvelope();
    const rejectedRaw = serializeSignedEnvelope(rejectedEnvelope);
    fetchImplementation.mockResolvedValueOnce(verifierResponse(rejectedEnvelope, rejectedRaw));
    await expect(verifier.verify(rejectedRaw, SIGNATURE)).resolves.toMatchObject({
      envelope: rejectedEnvelope,
    });
  });

  it("fails closed when an attestation is not bound to the already verified request", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const alteredEnvelope = { ...signedEnvelope, user_id: "usr_other" };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(verifierResponse(signedEnvelope, raw))
      .mockResolvedValueOnce(attestationResponse(alteredEnvelope, raw));
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);
    const verified = await verifier.verify(raw, SIGNATURE);

    await expect(verifier.attestApproval(verified, SIGNATURE)).rejects.toBeInstanceOf(
      SignedRequestVerifierUnavailableError,
    );
  });

  it("fails closed when the attestation endpoint is unavailable or returns a malformed proof", async () => {
    const signedEnvelope = envelope();
    const raw = serializeSignedEnvelope(signedEnvelope);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(verifierResponse(signedEnvelope, raw))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const verifier = new RemoteSignedRequestVerifier(ENDPOINT, TOKEN, fetchImplementation);
    const verified = await verifier.verify(raw, SIGNATURE);

    await expect(verifier.attestApproval(verified, SIGNATURE)).rejects.toBeInstanceOf(
      SignedRequestVerifierUnavailableError,
    );

    fetchImplementation.mockResolvedValueOnce(
      Response.json({
        canonical_request_hash: createHash("sha256").update(raw).digest("hex"),
        envelope: signedEnvelope,
      }),
    );
    await expect(verifier.attestApproval(verified, SIGNATURE)).rejects.toBeInstanceOf(
      SignedRequestVerifierUnavailableError,
    );
  });
});
