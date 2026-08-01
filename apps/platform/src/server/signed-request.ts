import { createHash } from "node:crypto";

import {
  serializeSignedEnvelope,
  signedEnvelopeSchema,
  type SignedEnvelope,
} from "@refunddesk/contracts";
import { z } from "zod";

const VERIFIER_TIMEOUT_MS = 5_000;

const verificationResponseSchema = z
  .object({
    canonical_request_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    envelope: signedEnvelopeSchema,
  })
  .strict();

const attestationResponseSchema = verificationResponseSchema
  .extend({
    approval_attestation_id: z.uuid(),
  })
  .strict();

export class SignedRequestError extends Error {
  constructor(
    readonly code: "SIGNATURE_MISSING" | "SIGNATURE_INVALID" | "ENVELOPE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SignedRequestError";
  }
}

export interface VerifiedSignedRequest {
  readonly rawBody: Buffer;
  readonly envelope: SignedEnvelope;
  readonly canonicalRequestHash: Buffer;
}

export interface SignedRequestVerifier {
  verify(rawText: string, signature: string | null): Promise<VerifiedSignedRequest>;
  attestApproval(verified: VerifiedSignedRequest, signature: string): Promise<string>;
}

export class SignedRequestVerifierUnavailableError extends Error {
  constructor() {
    super("The signed-request verifier is unavailable");
    this.name = "SignedRequestVerifierUnavailableError";
  }
}

export class SignedRequestAttestationConflictError extends Error {
  constructor() {
    super("The approval attestation nonce conflicts with another signed request");
    this.name = "SignedRequestAttestationConflictError";
  }
}

export class RemoteSignedRequestVerifier implements SignedRequestVerifier {
  private readonly attestationEndpoint: string;

  constructor(
    private readonly endpoint: string,
    private readonly authorizationToken: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    const attestationUrl = new URL(endpoint);
    if (attestationUrl.pathname !== "/internal/v1/signed-requests/verify") {
      throw new Error("INVALID_SIGNED_REQUEST_VERIFIER_ENDPOINT");
    }
    attestationUrl.pathname = "/internal/v1/signed-requests/attest";
    this.attestationEndpoint = attestationUrl.toString();
  }

  private async post(rawText: string, signature: string, endpoint: string): Promise<Response> {
    try {
      return await this.fetchImplementation(endpoint, {
        body: rawText,
        headers: {
          Authorization: `Bearer ${this.authorizationToken}`,
          "Content-Type": "application/json",
          "Stripe-Signature": signature,
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(VERIFIER_TIMEOUT_MS),
      });
    } catch {
      throw new SignedRequestVerifierUnavailableError();
    }
  }

  private assertResponseStatus(response: Response): void {
    if (response.status === 200) {
      return;
    }
    if (response.status === 401) {
      throw new SignedRequestError("SIGNATURE_INVALID", "The signed request is invalid");
    }
    if (response.status === 400) {
      throw new SignedRequestError("ENVELOPE_INVALID", "Signed request envelope is invalid");
    }
    throw new SignedRequestVerifierUnavailableError();
  }

  async verify(rawText: string, signature: string | null): Promise<VerifiedSignedRequest> {
    if (signature === null || signature.length === 0) {
      throw new SignedRequestError("SIGNATURE_MISSING", "Stripe-Signature is required");
    }

    const response = await this.post(rawText, signature, this.endpoint);
    this.assertResponseStatus(response);

    let parsed: z.infer<typeof verificationResponseSchema>;
    try {
      parsed = verificationResponseSchema.parse(await response.json());
    } catch {
      throw new SignedRequestVerifierUnavailableError();
    }

    const rawBody = Buffer.from(rawText, "utf8");
    const expectedHash = createHash("sha256").update(rawBody).digest("hex");
    if (
      parsed.canonical_request_hash !== expectedHash ||
      serializeSignedEnvelope(parsed.envelope) !== rawText
    ) {
      throw new SignedRequestVerifierUnavailableError();
    }

    return {
      canonicalRequestHash: Buffer.from(expectedHash, "hex"),
      envelope: parsed.envelope,
      rawBody,
    };
  }

  async attestApproval(verified: VerifiedSignedRequest, signature: string): Promise<string> {
    const rawText = verified.rawBody.toString("utf8");
    const expectedHash = createHash("sha256").update(verified.rawBody).digest("hex");
    if (
      Buffer.from(verified.canonicalRequestHash).toString("hex") !== expectedHash ||
      serializeSignedEnvelope(verified.envelope) !== rawText
    ) {
      throw new SignedRequestVerifierUnavailableError();
    }

    const response = await this.post(rawText, signature, this.attestationEndpoint);
    if (response.status === 409) {
      throw new SignedRequestAttestationConflictError();
    }
    this.assertResponseStatus(response);

    let parsed: z.infer<typeof attestationResponseSchema>;
    try {
      parsed = attestationResponseSchema.parse(await response.json());
    } catch {
      throw new SignedRequestVerifierUnavailableError();
    }

    if (
      parsed.canonical_request_hash !== expectedHash ||
      serializeSignedEnvelope(parsed.envelope) !== rawText ||
      serializeSignedEnvelope(parsed.envelope) !== serializeSignedEnvelope(verified.envelope)
    ) {
      throw new SignedRequestVerifierUnavailableError();
    }
    return parsed.approval_attestation_id;
  }
}
