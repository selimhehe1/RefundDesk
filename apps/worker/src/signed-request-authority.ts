import { createHash } from "node:crypto";

import { parseOperationCommand, type SignedEnvelope } from "@refunddesk/contracts";
import {
  SignedExtensionRequestError,
  verifySignedExtensionRequest,
} from "@refunddesk/stripe-adapter";
import { z } from "zod";

import { ApprovalAttestationStoreError, type WorkerStore } from "./ports.js";

export interface WorkerSignedRequestVerification {
  readonly approvalAttestationId: string | null;
  readonly canonicalRequestHash: string;
  readonly envelope: SignedEnvelope;
}

export interface WorkerSignedRequestAuthority {
  verifyAndAttest(
    rawText: string,
    stripeSignature: string | null,
  ): Promise<WorkerSignedRequestVerification>;
}

export class WorkerSignedRequestAuthorityError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409 | 503,
    readonly code:
      | "approval_conflict"
      | "approval_unavailable"
      | "envelope_invalid"
      | "live_forbidden"
      | "signature_invalid"
      | "signature_missing",
  ) {
    super("The signed request could not be authorized");
    this.name = "WorkerSignedRequestAuthorityError";
  }
}

export class StripeSignedRequestAuthority implements WorkerSignedRequestAuthority {
  constructor(
    private readonly signingSecret: string,
    private readonly store: Pick<WorkerStore, "persistApprovalAttestation">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verifyAndAttest(
    rawText: string,
    stripeSignature: string | null,
  ): Promise<WorkerSignedRequestVerification> {
    let verified: ReturnType<typeof verifySignedExtensionRequest>;
    try {
      verified = verifySignedExtensionRequest(rawText, stripeSignature, this.signingSecret);
    } catch (error) {
      if (error instanceof SignedExtensionRequestError) {
        throw new WorkerSignedRequestAuthorityError(
          error.code === "SIGNATURE_MISSING" || error.code === "SIGNATURE_INVALID" ? 401 : 400,
          error.code === "SIGNATURE_MISSING"
            ? "signature_missing"
            : error.code === "SIGNATURE_INVALID"
              ? "signature_invalid"
              : "envelope_invalid",
        );
      }
      throw error;
    }

    const { envelope, rawBody } = verified;
    if (envelope.mode !== "test") {
      throw new WorkerSignedRequestAuthorityError(403, "live_forbidden");
    }
    const canonicalRequestHash = createHash("sha256").update(rawBody).digest();
    let approvalAttestationId: string | null = null;
    if (envelope.operation === "refund_request.decide") {
      try {
        const command = parseOperationCommand("refund_request.decide", envelope.command_json);
        if (command.decision === "approve") {
          if (envelope.resource_type === "account") {
            throw new WorkerSignedRequestAuthorityError(400, "envelope_invalid");
          }
          const persisted = await this.store.persistApprovalAttestation({
            amountMinor: BigInt(command.approval_snapshot.amount_minor),
            approverStripeUserId: envelope.user_id,
            currency: command.approval_snapshot.currency,
            environment: envelope.is_sandbox ? "sandbox" : "test",
            expectedRequestVersion: command.expected_request_version,
            reason: command.approval_snapshot.reason,
            requestId: command.request_id,
            requestNonce: envelope.request_nonce,
            requesterStripeUserId: command.approval_snapshot.requester_user_id,
            resourceId: envelope.resource_id,
            resourceType: envelope.resource_type,
            signedEnvelopeHash: canonicalRequestHash,
            stripeAccountId: envelope.account_id,
            verifiedAt: this.now(),
          });
          if (!Buffer.from(persisted.signedEnvelopeHash).equals(canonicalRequestHash)) {
            throw new WorkerSignedRequestAuthorityError(409, "approval_conflict");
          }
          approvalAttestationId = persisted.id;
        }
      } catch (error) {
        if (error instanceof WorkerSignedRequestAuthorityError) {
          throw error;
        }
        if (error instanceof ApprovalAttestationStoreError) {
          throw new WorkerSignedRequestAuthorityError(
            error.code === "conflict" ? 409 : error.code === "invalid" ? 400 : 503,
            error.code === "conflict"
              ? "approval_conflict"
              : error.code === "invalid"
                ? "envelope_invalid"
                : "approval_unavailable",
          );
        }
        if (error instanceof z.ZodError || error instanceof SyntaxError) {
          throw new WorkerSignedRequestAuthorityError(400, "envelope_invalid");
        }
        throw error;
      }
    }

    return {
      approvalAttestationId,
      canonicalRequestHash: canonicalRequestHash.toString("hex"),
      envelope,
    };
  }
}
