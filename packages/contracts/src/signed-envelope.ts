import type { CanonicalJsonValue } from "./canonical-json.js";
import { canonicalJson } from "./canonical-json.js";
import type { SignedEnvelope } from "./schemas.js";

export const SIGNED_ENVELOPE_FIELD_ORDER = [
  "operation",
  "request_nonce",
  "mode",
  "is_sandbox",
  "resource_type",
  "resource_id",
  "command_json",
  "stripe_roles",
  "user_id",
  "account_id",
] as const;

export function serializeSignedEnvelope(envelope: SignedEnvelope): string {
  return JSON.stringify({
    operation: envelope.operation,
    request_nonce: envelope.request_nonce,
    mode: envelope.mode,
    is_sandbox: envelope.is_sandbox,
    resource_type: envelope.resource_type,
    resource_id: envelope.resource_id,
    command_json: envelope.command_json,
    stripe_roles: envelope.stripe_roles,
    user_id: envelope.user_id,
    account_id: envelope.account_id,
  });
}

export function serializeCommand(command: CanonicalJsonValue): string {
  return canonicalJson(command);
}
