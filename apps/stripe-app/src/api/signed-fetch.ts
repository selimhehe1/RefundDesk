import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { fetchStripeSignature } from "@stripe/ui-extension-sdk/utils";

import { canonicalJson, type JsonValue } from "./canonical-json";

export type PilotResourceType = "account" | "charge" | "payment_intent";

type StripeSignatureValue =
  | null
  | boolean
  | number
  | string
  | StripeSignatureValue[]
  | { [key: string]: StripeSignatureValue };

export type SignedEndpoint =
  | "/v1/audit/export"
  | "/v1/context/sync"
  | "/v1/external-alerts/acknowledge"
  | "/v1/external-alerts/list"
  | "/v1/payments/eligibility"
  | "/v1/refund-requests/cancel"
  | "/v1/refund-requests/create"
  | "/v1/refund-requests/decide"
  | "/v1/refund-requests/get"
  | "/v1/refund-requests/list"
  | "/v1/settings/get"
  | "/v1/settings/update"
  | "/internal/phase0/refund-probe"
  | "/internal/phase0/report";

export interface SignedRequestInput {
  readonly endpoint: SignedEndpoint;
  readonly operation: string;
  readonly resourceType: PilotResourceType;
  readonly resourceId: string;
  readonly command: JsonValue;
  readonly requestNonce?: string;
}

export interface SignedStripeRole {
  readonly [key: string]: StripeSignatureValue;
  readonly name: string;
  readonly type: "builtIn" | "custom";
}

export interface SignaturePayload {
  readonly [key: string]: StripeSignatureValue;
  readonly operation: string;
  readonly request_nonce: string;
  readonly mode: "test";
  readonly is_sandbox: boolean;
  readonly resource_type: PilotResourceType;
  readonly resource_id: string;
  readonly command_json: string;
  readonly stripe_roles: SignedStripeRole[];
}

export interface PreparedSignedRequest {
  readonly apiUrl: string;
  readonly body: string;
  readonly signaturePayload: SignaturePayload;
}

type SignatureFetcher = (payload: SignaturePayload) => Promise<string>;

type HttpFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SignedFetchDependencies {
  readonly fetcher?: HttpFetcher;
  readonly signatureFetcher?: SignatureFetcher;
}

export class SignedExtensionRequestError extends Error {
  constructor(
    readonly code:
      | "API_CONFIGURATION_INVALID"
      | "IDENTITY_UNAVAILABLE"
      | "LIVE_MODE_DISABLED"
      | "REQUEST_FAILED"
      | "RESPONSE_INVALID",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SignedExtensionRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConstant(context: ExtensionContextValue, name: string): unknown {
  const constants = context.environment.constants;
  return isRecord(constants) ? constants[name] : undefined;
}

function isLocalDevelopmentUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}

export function getApiBase(context: ExtensionContextValue): string {
  const configured = readConstant(context, "API_BASE");
  if (typeof configured !== "string") {
    throw new SignedExtensionRequestError(
      "API_CONFIGURATION_INVALID",
      "RefundDesk API configuration is unavailable.",
    );
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new SignedExtensionRequestError(
      "API_CONFIGURATION_INVALID",
      "RefundDesk API configuration is invalid.",
    );
  }

  if (url.protocol !== "https:" && !isLocalDevelopmentUrl(url)) {
    throw new SignedExtensionRequestError(
      "API_CONFIGURATION_INVALID",
      "RefundDesk API configuration must use HTTPS.",
    );
  }

  return url.toString().replace(/\/+$/u, "");
}

export function getPilotEnvironment(context: ExtensionContextValue): "sandbox" | "test" {
  if (context.environment.mode === "live") {
    throw new SignedExtensionRequestError(
      "LIVE_MODE_DISABLED",
      "Live mode is disabled for the RefundDesk pilot.",
    );
  }
  return context.userContext.account.isSandbox ? "sandbox" : "test";
}

export function isPhase0ProbeEnabled(context: ExtensionContextValue): boolean {
  return readConstant(context, "PHASE0_PROBE_ENABLED") === true;
}

export function isAdministrator(context: ExtensionContextValue): boolean {
  return (context.userContext.roles ?? []).some(
    (role) => role.type === "builtIn" && role.name === "Administrator",
  );
}

function requireIdentity(context: ExtensionContextValue): {
  readonly accountId: string;
  readonly userId: string;
} {
  const userId = context.userContext.id;
  const accountId = context.userContext.account.id;
  if (typeof userId !== "string" || userId.length === 0 || accountId.length === 0) {
    throw new SignedExtensionRequestError(
      "IDENTITY_UNAVAILABLE",
      "The signed Stripe user context is unavailable.",
    );
  }
  return { accountId, userId };
}

function createRequestNonce(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new SignedExtensionRequestError(
      "API_CONFIGURATION_INVALID",
      "Secure request nonces are unavailable.",
    );
  }
  return globalThis.crypto.randomUUID();
}

export function prepareSignedRequest(
  context: ExtensionContextValue,
  input: SignedRequestInput,
): PreparedSignedRequest {
  getPilotEnvironment(context);
  const { accountId, userId } = requireIdentity(context);
  const signaturePayload: SignaturePayload = {
    operation: input.operation,
    request_nonce: input.requestNonce ?? createRequestNonce(),
    mode: "test",
    is_sandbox: context.userContext.account.isSandbox,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    command_json: canonicalJson(input.command),
    stripe_roles: (context.userContext.roles ?? []).map((role) => ({
      name: role.name,
      type: role.type,
    })),
  };
  const body = JSON.stringify({
    ...signaturePayload,
    user_id: userId,
    account_id: accountId,
  });

  return {
    apiUrl: `${getApiBase(context)}${input.endpoint}`,
    body,
    signaturePayload,
  };
}

function readApiError(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  return typeof payload["code"] === "string" ? payload["code"] : undefined;
}

async function parseResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    throw new SignedExtensionRequestError(
      "RESPONSE_INVALID",
      "RefundDesk returned an unreadable response.",
      response.status,
    );
  }

  if (!response.ok) {
    const apiCode = readApiError(payload);
    throw new SignedExtensionRequestError(
      "REQUEST_FAILED",
      apiCode === undefined
        ? "RefundDesk could not complete the request."
        : `RefundDesk could not complete the request (${apiCode}).`,
      response.status,
    );
  }
  return payload;
}

export async function signedApiRequest(
  context: ExtensionContextValue,
  input: SignedRequestInput,
  dependencies: SignedFetchDependencies = {},
): Promise<unknown> {
  const prepared = prepareSignedRequest(context, input);
  const signatureFetcher =
    dependencies.signatureFetcher ?? ((payload: SignaturePayload) => fetchStripeSignature(payload));
  const fetcher = dependencies.fetcher ?? globalThis.fetch;
  const signature = await signatureFetcher(prepared.signaturePayload);
  const response = await fetcher(prepared.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature,
    },
    body: prepared.body,
    cache: "no-store",
    credentials: "omit",
  });
  return parseResponse(response);
}

export function publicRequestError(error: unknown): string {
  if (error instanceof SignedExtensionRequestError) {
    return error.message;
  }
  return "RefundDesk could not complete the request. Try again.";
}
