import type { CanonicalJsonValue } from "./canonical-json.js";
import { canonicalJson } from "./canonical-json.js";
import type { SignedEnvelope } from "./schemas.js";

const SIGNED_ENVELOPE_PREFIX = [
  "operation",
  "request_nonce",
  "mode",
  "is_sandbox",
  "resource_type",
] as const;

const SIGNED_ENVELOPE_SUFFIX = ["user_id", "account_id"] as const;

export const SIGNED_ENVELOPE_FIELD_ORDERS = {
  account_unasserted: [
    ...SIGNED_ENVELOPE_PREFIX,
    "command_json",
    "roles_asserted",
    ...SIGNED_ENVELOPE_SUFFIX,
  ],
  account_asserted: [
    ...SIGNED_ENVELOPE_PREFIX,
    "command_json",
    "roles_asserted",
    "stripe_roles",
    ...SIGNED_ENVELOPE_SUFFIX,
  ],
  payment_unasserted: [
    ...SIGNED_ENVELOPE_PREFIX,
    "resource_id",
    "command_json",
    "roles_asserted",
    ...SIGNED_ENVELOPE_SUFFIX,
  ],
  payment_asserted: [
    ...SIGNED_ENVELOPE_PREFIX,
    "resource_id",
    "command_json",
    "roles_asserted",
    "stripe_roles",
    ...SIGNED_ENVELOPE_SUFFIX,
  ],
} as const;

export function serializeSignedEnvelope(envelope: SignedEnvelope): string {
  return JSON.stringify({
    operation: envelope.operation,
    request_nonce: envelope.request_nonce,
    mode: envelope.mode,
    is_sandbox: envelope.is_sandbox,
    resource_type: envelope.resource_type,
    ...(envelope.resource_type === "account" ? {} : { resource_id: envelope.resource_id }),
    command_json: envelope.command_json,
    roles_asserted: envelope.roles_asserted,
    ...(envelope.roles_asserted
      ? {
          stripe_roles: envelope.stripe_roles.map((role) => ({
            ...(role.id === undefined ? {} : { id: role.id }),
            type: role.type,
            name: role.name,
          })),
        }
      : {}),
    user_id: envelope.user_id,
    account_id: envelope.account_id,
  });
}

export function serializeCommand(command: CanonicalJsonValue): string {
  return canonicalJson(command);
}
