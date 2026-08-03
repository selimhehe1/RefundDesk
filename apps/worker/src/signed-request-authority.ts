import { createHash } from "node:crypto";

import { parseOperationCommand, type SignedEnvelope } from "@refunddesk/contracts";
import {
  SignedExtensionRequestError,
  verifySignedExtensionRequest,
} from "@refunddesk/stripe-adapter";
import { z } from "zod";

import { ApprovalAttestationStoreError, type WorkerStore } from "./ports.js";

export interface WorkerSignedRequestVerification {
  readonly canonicalRequestHash: string;
  readonly envelope: SignedEnvelope;
}

export interface WorkerSignedApprovalAttestation extends WorkerSignedRequestVerification {
  readonly approvalAttestationId: string;
}

export interface WorkerSignedRequestAuthority {
  verify(rawText: string, stripeSignature: string | null): Promise<WorkerSignedRequestVerification>;
  attestApproval(
    rawText: string,
    stripeSignature: string | null,
  ): Promise<WorkerSignedApprovalAttestation>;
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
  private readonly signingSecrets: readonly string[];

  /**
   * `signingSecret` accepts one value or several, active first. Several only while the App
   * signing secret is being rolled: Stripe keeps the retired secret valid for an overlap
   * window and may sign an extension request with either, so a runtime holding just one
   * refuses whichever half it does not have. That is a visible Dashboard failure for the
   * merchant until the two sides are synchronised, and it is avoidable (ADR 0028).
   */
  constructor(
    signingSecret: string | readonly string[],
    private readonly store: Pick<WorkerStore, "persistApprovalAttestation">,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.signingSecrets = typeof signingSecret === "string" ? [signingSecret] : signingSecret;
    if (this.signingSecrets.length === 0) {
      throw new Error("SIGNING_SECRET_REQUIRED");
    }
  }

  private verifyExact(
    rawText: string,
    stripeSignature: string | null,
  ): { readonly canonicalRequestHash: Buffer; readonly envelope: SignedEnvelope } {
    let verified: ReturnType<typeof verifySignedExtensionRequest> | null = null;
    for (const secret of this.signingSecrets) {
      try {
        verified = verifySignedExtensionRequest(rawText, stripeSignature, secret);
        break;
      } catch (error) {
        // Only an invalid signature depends on which secret was used. A missing signature or a
        // malformed envelope fails the same way against every secret, so retrying would waste
        // work and, worse, report the failure of the last secret rather than the real cause.
        if (error instanceof SignedExtensionRequestError && error.code === "SIGNATURE_INVALID") {
          continue;
        }
        if (error instanceof SignedExtensionRequestError) {
          throw new WorkerSignedRequestAuthorityError(
            error.code === "SIGNATURE_MISSING" ? 401 : 400,
            error.code === "SIGNATURE_MISSING" ? "signature_missing" : "envelope_invalid",
          );
        }
        throw error;
      }
    }
    if (verified === null) {
      // Identical whichever secret failed: a caller never learns which one is live.
      throw new WorkerSignedRequestAuthorityError(401, "signature_invalid");
    }

    const { envelope, rawBody } = verified;
    if (envelope.mode !== "test") {
      throw new WorkerSignedRequestAuthorityError(403, "live_forbidden");
    }
    return {
      canonicalRequestHash: createHash("sha256").update(rawBody).digest(),
      envelope,
    };
  }

  verify(
    rawText: string,
    stripeSignature: string | null,
  ): Promise<WorkerSignedRequestVerification> {
    return Promise.resolve().then(() => {
      const verified = this.verifyExact(rawText, stripeSignature);
      return {
        canonicalRequestHash: verified.canonicalRequestHash.toString("hex"),
        envelope: verified.envelope,
      };
    });
  }

  async attestApproval(
    rawText: string,
    stripeSignature: string | null,
  ): Promise<WorkerSignedApprovalAttestation> {
    // This second boundary deliberately re-verifies the exact raw bytes and
    // Stripe signature instead of trusting a prior verification response.
    const { canonicalRequestHash, envelope } = this.verifyExact(rawText, stripeSignature);
    try {
      if (envelope.operation !== "refund_request.decide") {
        throw new WorkerSignedRequestAuthorityError(400, "envelope_invalid");
      }
      const command = parseOperationCommand("refund_request.decide", envelope.command_json);
      if (command.decision !== "approve" || envelope.resource_type === "account") {
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
      return {
        approvalAttestationId: persisted.id,
        canonicalRequestHash: canonicalRequestHash.toString("hex"),
        envelope,
      };
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
}
