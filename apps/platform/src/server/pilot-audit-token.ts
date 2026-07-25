import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "@refunddesk/contracts";

const TOKEN_VERSION = "v1";

export interface PilotAuditTokenPayload {
  readonly actor_id: string;
  readonly environment: "sandbox" | "test";
  readonly expires_at: string;
  readonly installation_id: string;
  readonly nonce: string;
  readonly tenant_id: string;
}

function signature(payloadSegment: string, key: Uint8Array): Buffer {
  return createHmac("sha256", key).update(`${TOKEN_VERSION}.${payloadSegment}`, "utf8").digest();
}

export function createPilotAuditToken(
  payload: Omit<PilotAuditTokenPayload, "nonce">,
  key: Uint8Array,
): string {
  const payloadSegment = Buffer.from(
    canonicalJson({ ...payload, nonce: randomUUID() }),
    "utf8",
  ).toString("base64url");
  return `${TOKEN_VERSION}.${payloadSegment}.${signature(payloadSegment, key).toString("base64url")}`;
}

export function verifyPilotAuditToken(
  token: string,
  key: Uint8Array,
  now = new Date(),
): PilotAuditTokenPayload | null {
  const [version, payloadSegment, signatureSegment, extra] = token.split(".");
  if (
    version !== TOKEN_VERSION ||
    payloadSegment === undefined ||
    signatureSegment === undefined ||
    extra !== undefined
  ) {
    return null;
  }
  const actual = Buffer.from(signatureSegment, "base64url");
  const expected = signature(payloadSegment, key);
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    return null;
  }

  try {
    const value = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Readonly<Record<string, unknown>>;
    if (
      typeof record["actor_id"] !== "string" ||
      (record["environment"] !== "sandbox" && record["environment"] !== "test") ||
      typeof record["expires_at"] !== "string" ||
      typeof record["installation_id"] !== "string" ||
      typeof record["nonce"] !== "string" ||
      typeof record["tenant_id"] !== "string" ||
      Object.keys(record).length !== 6
    ) {
      return null;
    }
    const expiresAt = new Date(record["expires_at"]);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    return {
      actor_id: record["actor_id"],
      environment: record["environment"],
      expires_at: record["expires_at"],
      installation_id: record["installation_id"],
      nonce: record["nonce"],
      tenant_id: record["tenant_id"],
    };
  } catch {
    return null;
  }
}
