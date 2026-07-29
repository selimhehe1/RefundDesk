import type { ExtensionContextValue, RoleDefinition } from "@stripe/ui-extension-sdk/context";
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
  | "/v1/settings/update";

interface SignedRequestInputBase {
  readonly endpoint: SignedEndpoint;
  readonly operation: string;
  readonly command: JsonValue;
  readonly requestNonce?: string;
}

export type SignedRequestInput = SignedRequestInputBase &
  (
    | {
        readonly resourceType: "account";
        readonly resourceId?: never;
      }
    | {
        readonly resourceType: "charge" | "payment_intent";
        readonly resourceId: string;
      }
  );

export interface SignedStripeRole {
  readonly [key: string]: StripeSignatureValue;
  readonly id?: string;
  readonly name: string;
  readonly type: "builtIn" | "custom";
}

interface SignaturePayloadBase {
  readonly operation: string;
  readonly request_nonce: string;
  readonly mode: "test";
  readonly is_sandbox: boolean;
  readonly resource_type: PilotResourceType;
  readonly command_json: string;
}

type SignatureResource =
  | {
      readonly resource_type: "account";
    }
  | {
      readonly resource_type: "charge" | "payment_intent";
      readonly resource_id: string;
    };

type SignatureRoleAssertion =
  | {
      readonly roles_asserted: false;
    }
  | {
      readonly roles_asserted: true;
      readonly stripe_roles: SignedStripeRole[];
    };

export type SignaturePayload = SignaturePayloadBase & SignatureResource & SignatureRoleAssertion;

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
      | "RESPONSE_INVALID"
      | "ROLE_CONTEXT_INVALID",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SignedExtensionRequestError";
  }
}

export function isDefinitiveMutationRejection(error: unknown): boolean {
  const definitivePilotStatuses = new Set([400, 401, 403, 404, 409, 413, 422]);
  return (
    error instanceof SignedExtensionRequestError &&
    error.code === "REQUEST_FAILED" &&
    error.status !== undefined &&
    definitivePilotStatuses.has(error.status)
  );
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

function isAdministratorRole(role: SignedStripeRole): boolean {
  if (role.type !== "builtIn") {
    return false;
  }
  return role.id === undefined
    ? role.name === "Administrator" || role.name === "Super Administrator"
    : role.id === "admin" || role.id === "super_admin";
}

export function isAdministrator(context: ExtensionContextValue): boolean {
  return normalizedStripeRoles(context).some((role) => isAdministratorRole(role));
}

function validatedRawStripeRoles(context: ExtensionContextValue): readonly RoleDefinition[] {
  const roles = context.userContext.roles ?? [];
  if (!Array.isArray(roles) || roles.length > 32) {
    throw new SignedExtensionRequestError(
      "ROLE_CONTEXT_INVALID",
      "The signed Stripe role context is invalid.",
    );
  }

  for (const role of roles) {
    if (!isRecord(role)) {
      throw new SignedExtensionRequestError(
        "ROLE_CONTEXT_INVALID",
        "The signed Stripe role context is invalid.",
      );
    }
    const runtimeRole = role as unknown as Record<string, unknown>;
    const id = runtimeRole["id"];
    const name = runtimeRole["name"];
    const type = runtimeRole["type"];
    if (
      (id !== undefined && (typeof id !== "string" || id.length === 0 || id.length > 255)) ||
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 255 ||
      (type !== "builtIn" && type !== "custom")
    ) {
      throw new SignedExtensionRequestError(
        "ROLE_CONTEXT_INVALID",
        "The signed Stripe role context is invalid.",
      );
    }
  }

  return roles;
}

function normalizedStripeRoles(context: ExtensionContextValue): SignedStripeRole[] {
  return validatedRawStripeRoles(context).map((role) => {
    const runtimeRole = role as typeof role & { readonly id?: string };
    return {
      ...(runtimeRole.id === undefined ? {} : { id: runtimeRole.id }),
      type: role.type,
      name: role.name,
    };
  });
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

export function createRequestNonce(): string {
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
  const normalizedRoles = normalizedStripeRoles(context);
  const administrator = normalizedRoles.some((role) => isAdministratorRole(role));
  const commonPayload = {
    operation: input.operation,
    request_nonce: input.requestNonce ?? createRequestNonce(),
    mode: "test" as const,
    is_sandbox: context.userContext.account.isSandbox,
    ...(input.resourceType === "account"
      ? { resource_type: "account" as const }
      : {
          resource_type: input.resourceType,
          resource_id: input.resourceId,
        }),
    command_json: canonicalJson(input.command),
  };
  const signaturePayload: SignaturePayload = administrator
    ? {
        ...commonPayload,
        roles_asserted: true,
        stripe_roles: normalizedRoles,
      }
    : {
        ...commonPayload,
        roles_asserted: false,
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
    dependencies.signatureFetcher ??
    ((payload: SignaturePayload) =>
      fetchStripeSignature(payload as unknown as Record<string, StripeSignatureValue>));
  const fetcher = dependencies.fetcher ?? globalThis.fetch;
  // Stripe treats stripe_roles specially. Preserve its original RoleDefinition
  // objects only when an Administrator role is being asserted. Ordinary workflows
  // omit the key entirely and sign the exact same fields sent to the backend.
  const stripeSignaturePayload: SignaturePayload = prepared.signaturePayload.roles_asserted
    ? {
        ...prepared.signaturePayload,
        stripe_roles: validatedRawStripeRoles(context) as SignedStripeRole[],
      }
    : prepared.signaturePayload;
  const signature = await signatureFetcher(stripeSignaturePayload);
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
