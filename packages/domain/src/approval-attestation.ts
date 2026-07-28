import { createHmac, timingSafeEqual } from "node:crypto";

import { DomainError } from "./errors.js";
import { assertPositiveMinorAmount, normalizeCurrency } from "./money.js";
import type { VersionedSecret } from "./refund-proof.js";
import type { RefundReason } from "./types.js";

const DOMAIN_SEPARATOR = Buffer.from("refunddesk\0approval-attestation\0payload-v1\0", "utf8");
const VERSION_PATTERN = /^v[1-9]\d{0,8}$/u;
const TOKEN_PATTERN = /^(v[1-9]\d{0,8})\.([A-Za-z0-9_-]{43})$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STRIPE_ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]+$/u;
const STRIPE_USER_PATTERN = /^usr_[A-Za-z0-9]+$/u;
const PAYMENT_INTENT_PATTERN = /^pi_[A-Za-z0-9]+$/u;
const CHARGE_PATTERN = /^ch_[A-Za-z0-9]+$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REFUND_REASONS = new Set<RefundReason>(["duplicate", "fraudulent", "requested_by_customer"]);

export type ApprovalAttestationEnvironment = "test" | "sandbox";
export type ApprovalAttestationResourceType = "payment_intent" | "charge";

export interface ApprovalAttestationPayload {
  readonly canonicalRequestHash: Uint8Array;
  readonly requestNonce: string;
  readonly tenantId: string;
  readonly installationId: string;
  readonly stripeAccountId: string;
  readonly environment: ApprovalAttestationEnvironment;
  readonly resourceType: ApprovalAttestationResourceType;
  readonly resourceId: string;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly approverUserId: string;
  readonly requesterUserId: string;
  readonly approverStripeUserId: string;
  readonly requesterStripeUserId: string;
  readonly paymentKey: string;
  readonly paymentIntentId: string | null;
  readonly chargeId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reason: RefundReason;
  readonly policyVersion: number;
  readonly requiredApprovals: number;
  readonly expiresAt: string;
  readonly verifiedAt: string;
  readonly consumeBefore: string;
}

export interface ApprovalAttestationKeys {
  readonly active: VersionedSecret;
  readonly verificationOnly?: Readonly<Record<string, Uint8Array>>;
}

function invalidAttestation(message: string): never {
  throw new DomainError("INVALID_APPROVAL_ATTESTATION", message);
}

function validateSecret(secret: VersionedSecret): VersionedSecret {
  if (
    !VERSION_PATTERN.test(secret.version) ||
    !(secret.key instanceof Uint8Array) ||
    secret.key.byteLength < 32
  ) {
    return invalidAttestation(
      "Approval attestation keys require a vN version and at least 256 bits",
    );
  }
  return {
    version: secret.version,
    key: Uint8Array.from(secret.key),
  };
}

function assertBoundedMatch(
  value: string,
  pattern: RegExp,
  label: string,
  maximumLength = 255,
): void {
  if (value.length > maximumLength || !pattern.test(value)) {
    invalidAttestation(`Invalid approval attestation ${label}`);
  }
}

function parseCanonicalInstant(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (
    !ISO_INSTANT_PATTERN.test(value) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    invalidAttestation(`Invalid approval attestation ${label}`);
  }
  return timestamp;
}

function canonicalPayload(payload: ApprovalAttestationPayload): string {
  if (
    !(payload.canonicalRequestHash instanceof Uint8Array) ||
    payload.canonicalRequestHash.byteLength !== 32
  ) {
    invalidAttestation("The canonical request hash must contain exactly 32 bytes");
  }
  assertBoundedMatch(payload.requestNonce, UUID_PATTERN, "request nonce", 36);
  assertBoundedMatch(payload.tenantId, UUID_PATTERN, "tenant identifier", 36);
  assertBoundedMatch(payload.installationId, UUID_PATTERN, "installation identifier", 36);
  assertBoundedMatch(payload.requestId, UUID_PATTERN, "request identifier", 36);
  if (!Number.isSafeInteger(payload.requestVersion) || payload.requestVersion < 0) {
    invalidAttestation("The approval attestation request version must be a non-negative integer");
  }
  assertBoundedMatch(payload.stripeAccountId, STRIPE_ACCOUNT_PATTERN, "Stripe account");
  assertBoundedMatch(payload.approverUserId, UUID_PATTERN, "approver user identifier", 36);
  assertBoundedMatch(payload.requesterUserId, UUID_PATTERN, "requester user identifier", 36);
  if (payload.approverUserId === payload.requesterUserId) {
    invalidAttestation("The internal approver must be distinct from the requester");
  }
  assertBoundedMatch(payload.approverStripeUserId, STRIPE_USER_PATTERN, "approver");
  assertBoundedMatch(payload.requesterStripeUserId, STRIPE_USER_PATTERN, "requester");
  if (payload.approverStripeUserId === payload.requesterStripeUserId) {
    invalidAttestation("The approver must be distinct from the requester");
  }
  if (payload.environment !== "test" && payload.environment !== "sandbox") {
    invalidAttestation("Approval attestations are limited to test and sandbox environments");
  }
  if (payload.resourceType === "payment_intent") {
    assertBoundedMatch(payload.resourceId, PAYMENT_INTENT_PATTERN, "PaymentIntent");
  } else if (payload.resourceType === "charge") {
    assertBoundedMatch(payload.resourceId, CHARGE_PATTERN, "Charge");
  } else {
    invalidAttestation("Invalid approval attestation resource type");
  }
  assertBoundedMatch(payload.paymentKey, /^(?:pi|ch)_[A-Za-z0-9]+$/u, "payment key");
  if (payload.paymentIntentId !== null) {
    assertBoundedMatch(payload.paymentIntentId, PAYMENT_INTENT_PATTERN, "PaymentIntent snapshot");
  }
  assertBoundedMatch(payload.chargeId, CHARGE_PATTERN, "Charge snapshot");
  if (payload.paymentKey !== (payload.paymentIntentId ?? payload.chargeId)) {
    invalidAttestation("The approval attestation payment key is inconsistent");
  }
  if (
    (payload.resourceType === "payment_intent" && payload.resourceId !== payload.paymentIntentId) ||
    (payload.resourceType === "charge" && payload.resourceId !== payload.chargeId)
  ) {
    invalidAttestation("The approval attestation resource snapshot is inconsistent");
  }
  if (typeof payload.amountMinor !== "bigint") {
    invalidAttestation("Approval attestation amounts must use bigint");
  }
  assertPositiveMinorAmount(payload.amountMinor);
  const currency = normalizeCurrency(payload.currency);
  if (currency !== payload.currency) {
    invalidAttestation("Approval attestation currency must be canonical lowercase");
  }
  if (!REFUND_REASONS.has(payload.reason)) {
    invalidAttestation("Invalid approval attestation refund reason");
  }
  if (!Number.isSafeInteger(payload.policyVersion) || payload.policyVersion < 1) {
    invalidAttestation("The approval policy version must be a positive integer");
  }
  if (!Number.isSafeInteger(payload.requiredApprovals) || payload.requiredApprovals < 1) {
    invalidAttestation("The required approval count must be a positive integer");
  }
  const expiresAt = parseCanonicalInstant(payload.expiresAt, "expiration instant");
  const verifiedAt = parseCanonicalInstant(payload.verifiedAt, "verification instant");
  const consumeBefore = parseCanonicalInstant(payload.consumeBefore, "consumption deadline");
  if (verifiedAt >= consumeBefore || consumeBefore > expiresAt) {
    invalidAttestation("The approval attestation time window is inconsistent");
  }

  return JSON.stringify([
    Buffer.from(payload.canonicalRequestHash).toString("base64url"),
    payload.requestNonce,
    payload.tenantId,
    payload.installationId,
    payload.stripeAccountId,
    payload.environment,
    payload.resourceType,
    payload.resourceId,
    payload.requestId,
    payload.requestVersion,
    payload.approverUserId,
    payload.requesterUserId,
    payload.approverStripeUserId,
    payload.requesterStripeUserId,
    payload.paymentKey,
    payload.paymentIntentId,
    payload.chargeId,
    payload.amountMinor.toString(),
    currency,
    payload.reason,
    payload.policyVersion,
    payload.requiredApprovals,
    payload.expiresAt,
    payload.verifiedAt,
    payload.consumeBefore,
  ]);
}

function digest(payload: ApprovalAttestationPayload, key: Uint8Array): Buffer {
  return createHmac("sha256", key)
    .update(DOMAIN_SEPARATOR)
    .update(canonicalPayload(payload), "utf8")
    .digest();
}

export class ApprovalAttestationKeyring {
  private readonly active: VersionedSecret;
  private readonly verificationKeys: ReadonlyMap<string, Uint8Array>;

  constructor(keys: ApprovalAttestationKeys) {
    const active = validateSecret(keys.active);
    const verificationKeys = new Map<string, Uint8Array>();
    verificationKeys.set(active.version, active.key);
    for (const [version, key] of Object.entries(keys.verificationOnly ?? {})) {
      const verificationKey = validateSecret({ version, key });
      if (version === active.version) {
        invalidAttestation("The active key cannot also be verification-only");
      }
      verificationKeys.set(version, verificationKey.key);
    }
    this.active = active;
    this.verificationKeys = verificationKeys;
  }

  sign(payload: ApprovalAttestationPayload): string {
    const signature = digest(payload, this.active.key);
    return `${this.active.version}.${signature.toString("base64url")}`;
  }

  verify(payload: ApprovalAttestationPayload, token: string): boolean {
    const parsed = TOKEN_PATTERN.exec(token);
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
    if (supplied.toString("base64url") !== encodedDigest) {
      return false;
    }
    const expected = digest(payload, key);
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  }
}
