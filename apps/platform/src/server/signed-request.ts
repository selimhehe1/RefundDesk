import Stripe from "stripe";

import {
  serializeSignedEnvelope,
  signedEnvelopeSchema,
  type SignedEnvelope,
} from "@refunddesk/contracts";

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
}

export function verifySignedExtensionRequest(
  rawText: string,
  signature: string | null,
  signingSecret: string,
): VerifiedSignedRequest {
  if (signature === null || signature.length === 0) {
    throw new SignedRequestError("SIGNATURE_MISSING", "Stripe-Signature is required");
  }

  const rawBody = Buffer.from(rawText, "utf8");
  try {
    const verifier = Stripe.webhooks.signature;
    if (verifier === null) {
      throw new Error("Stripe signature verification is unavailable");
    }
    verifier.verifyHeader(rawBody, signature, signingSecret, 300);
  } catch {
    throw new SignedRequestError("SIGNATURE_INVALID", "The signed request is invalid");
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new SignedRequestError("ENVELOPE_INVALID", "Request body must be valid JSON");
  }

  const parsed = signedEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new SignedRequestError("ENVELOPE_INVALID", "Signed request envelope is invalid");
  }
  if (serializeSignedEnvelope(parsed.data) !== rawText) {
    throw new SignedRequestError(
      "ENVELOPE_INVALID",
      "Signed request envelope is not in canonical field order",
    );
  }

  return { rawBody, envelope: parsed.data };
}
