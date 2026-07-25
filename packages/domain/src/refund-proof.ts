import { createHmac, timingSafeEqual } from "node:crypto";

import { DomainError } from "./errors.js";
import { assertPositiveMinorAmount, normalizeCurrency } from "./money.js";
import type { StripeEnvironment } from "./types.js";

const VERSION_PATTERN = /^v[1-9]\d*$/u;
const PROOF_PATTERN = /^(v[1-9]\d*)\.([A-Za-z0-9_-]{43})$/u;

export interface RefundProofPayload {
  readonly tenantId: string;
  readonly stripeAccountId: string;
  readonly requestId: string;
  readonly paymentKey: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly environment: StripeEnvironment;
}

export interface VersionedSecret {
  readonly version: string;
  readonly key: Uint8Array;
}

export interface RefundProofKeys {
  readonly active: VersionedSecret;
  readonly verificationOnly?: Readonly<Record<string, Uint8Array>>;
}

function validateSecret(secret: VersionedSecret): void {
  if (!VERSION_PATTERN.test(secret.version) || secret.key.byteLength < 32) {
    throw new DomainError("INVALID_PROOF", "Proof keys require a vN version and at least 256 bits");
  }
}

function canonicalProofPayload(payload: RefundProofPayload): string {
  assertPositiveMinorAmount(payload.amountMinor);
  const fields = [
    payload.tenantId,
    payload.stripeAccountId,
    payload.requestId,
    payload.paymentKey,
    payload.amountMinor.toString(),
    normalizeCurrency(payload.currency),
    payload.environment,
  ];
  if (fields.some((field) => field.length === 0)) {
    throw new DomainError("INVALID_PROOF", "Proof fields cannot be empty");
  }
  return JSON.stringify(fields);
}

function digest(payload: RefundProofPayload, key: Uint8Array): Buffer {
  return createHmac("sha256", key).update(canonicalProofPayload(payload), "utf8").digest();
}

export class RefundProofKeyring {
  private readonly active: VersionedSecret;
  private readonly verificationKeys: ReadonlyMap<string, Uint8Array>;

  constructor(keys: RefundProofKeys) {
    validateSecret(keys.active);
    const verificationKeys = new Map<string, Uint8Array>();
    verificationKeys.set(keys.active.version, keys.active.key);
    for (const [version, key] of Object.entries(keys.verificationOnly ?? {})) {
      validateSecret({ version, key });
      if (version === keys.active.version) {
        throw new DomainError("INVALID_PROOF", "The active key cannot also be verification-only");
      }
      verificationKeys.set(version, key);
    }
    this.active = keys.active;
    this.verificationKeys = verificationKeys;
  }

  sign(payload: RefundProofPayload): string {
    return `${this.active.version}.${digest(payload, this.active.key).toString("base64url")}`;
  }

  verify(payload: RefundProofPayload, proof: string): boolean {
    const parsed = PROOF_PATTERN.exec(proof);
    if (parsed === null) {
      return false;
    }
    const version = parsed[1];
    const encodedDigest = parsed[2];
    if (version === undefined || encodedDigest === undefined) {
      return false;
    }
    const key = this.verificationKeys.get(version);
    if (key === undefined) {
      return false;
    }
    const supplied = Buffer.from(encodedDigest, "base64url");
    const expected = digest(payload, key);
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  }
}

export type RefundEvidenceClassification =
  "external" | "tampered" | "workflow_candidate" | "workflow_refund" | "proof_replay";

export interface RefundEvidenceInput {
  readonly candidateRefundId: string;
  readonly metadataRequestId: string | null;
  readonly metadataProof: string | null;
  readonly expectedRequestId: string;
  readonly proofValid: boolean;
  readonly linkedRefundId: string | null;
}

export function classifyRefundEvidence(
  evidence: RefundEvidenceInput,
): RefundEvidenceClassification {
  if (evidence.metadataRequestId === null || evidence.metadataProof === null) {
    return "external";
  }
  if (evidence.metadataRequestId !== evidence.expectedRequestId || !evidence.proofValid) {
    return "tampered";
  }
  if (evidence.linkedRefundId === null) {
    return "workflow_candidate";
  }
  return evidence.linkedRefundId === evidence.candidateRefundId
    ? "workflow_refund"
    : "proof_replay";
}

export function refundIdempotencyKey(requestId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)
  ) {
    throw new DomainError("INVALID_PROOF", "Invalid request identifier");
  }
  return `refunddesk:refund-request:${requestId.toLowerCase()}:v1`;
}
