import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "@refunddesk/contracts";
import type { StripeRole } from "@refunddesk/contracts";
import { hasStripeAdministratorRole } from "@refunddesk/domain";

export interface Phase0ProofPayload {
  readonly accountId: string;
  readonly environment: "test" | "sandbox";
  readonly requestNonce: string;
  readonly paymentKey: string;
  readonly amountMinor: string;
  readonly currency: string;
}

export function isPhase0Administrator(roles: readonly StripeRole[]): boolean {
  return hasStripeAdministratorRole(roles);
}

function digest(payload: Phase0ProofPayload, key: Buffer): string {
  return createHmac("sha256", key)
    .update(
      canonicalJson({
        account_id: payload.accountId,
        amount_minor: payload.amountMinor,
        currency: payload.currency,
        environment: payload.environment,
        payment_key: payload.paymentKey,
        request_nonce: payload.requestNonce,
      }),
    )
    .digest("base64url");
}

export function createPhase0Proof(payload: Phase0ProofPayload, key: Buffer): string {
  return `v1.${digest(payload, key)}`;
}

export function verifyPhase0Proof(
  proof: string,
  payload: Phase0ProofPayload,
  key: Buffer,
): boolean {
  const expected = createPhase0Proof(payload, key);
  const actualBuffer = Buffer.from(proof);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
