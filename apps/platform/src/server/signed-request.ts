import { createHash } from "node:crypto";

import {
  parseOperationCommand,
  serializeSignedEnvelope,
  signedEnvelopeSchema,
  type SignedEnvelope,
} from "@refunddesk/contracts";
import {
  SignedExtensionRequestError,
  verifySignedExtensionRequest as verifyStripeSignedExtensionRequest,
} from "@refunddesk/stripe-adapter";
import { z } from "zod";

const VERIFIER_TIMEOUT_MS = 5_000;

const verifierResponseSchema = z
  .object({
    approval_attestation_id: z.uuid().nullable(),
    canonical_request_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    envelope: signedEnvelopeSchema,
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
  readonly approvalAttestationId: string | null;
}

export interface SignedRequestVerifier {
  verify(rawText: string, signature: string | null): Promise<VerifiedSignedRequest>;
}

export class SignedRequestVerifierUnavailableError extends Error {
  constructor() {
    super("The signed-request verifier is unavailable");
    this.name = "SignedRequestVerifierUnavailableError";
  }
}

export function verifySignedExtensionRequest(
  rawText: string,
  signature: string | null,
  signingSecret: string,
): VerifiedSignedRequest {
  try {
    const verified = verifyStripeSignedExtensionRequest(rawText, signature, signingSecret);
    return { ...verified, approvalAttestationId: null };
  } catch (error) {
    if (error instanceof SignedExtensionRequestError) {
      throw new SignedRequestError(error.code, error.message);
    }
    throw error;
  }
}

function requiresApprovalAttestation(envelope: SignedEnvelope): boolean {
  if (envelope.operation !== "refund_request.decide") {
    return false;
  }
  const command = parseOperationCommand("refund_request.decide", envelope.command_json);
  return command.decision === "approve";
}

export class RemoteSignedRequestVerifier implements SignedRequestVerifier {
  constructor(
    private readonly endpoint: string,
    private readonly authorizationToken: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async verify(rawText: string, signature: string | null): Promise<VerifiedSignedRequest> {
    if (signature === null || signature.length === 0) {
      throw new SignedRequestError("SIGNATURE_MISSING", "Stripe-Signature is required");
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
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

    if (!response.ok) {
      if (response.status === 401) {
        throw new SignedRequestError("SIGNATURE_INVALID", "The signed request is invalid");
      }
      if (response.status === 400) {
        throw new SignedRequestError("ENVELOPE_INVALID", "Signed request envelope is invalid");
      }
      throw new SignedRequestVerifierUnavailableError();
    }

    let parsed: z.infer<typeof verifierResponseSchema>;
    try {
      parsed = verifierResponseSchema.parse(await response.json());
    } catch {
      throw new SignedRequestVerifierUnavailableError();
    }

    const rawBody = Buffer.from(rawText, "utf8");
    const expectedHash = createHash("sha256").update(rawBody).digest("hex");
    if (
      parsed.canonical_request_hash !== expectedHash ||
      serializeSignedEnvelope(parsed.envelope) !== rawText ||
      (parsed.approval_attestation_id !== null) !== requiresApprovalAttestation(parsed.envelope)
    ) {
      throw new SignedRequestVerifierUnavailableError();
    }

    return {
      approvalAttestationId: parsed.approval_attestation_id,
      envelope: parsed.envelope,
      rawBody,
    };
  }
}
