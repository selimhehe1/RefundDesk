import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  parseOperationCommand,
  type CanonicalJsonValue,
} from "@refunddesk/contracts";

import { apiError, jsonResponse } from "./http";
import {
  sandboxSignedRequestRateLimiter,
  type SignedRequestRateLimiter,
  type SignedRequestRateLimitScope,
} from "./mutation-rate-limit";
import { asSafePilotError, PilotApiError } from "./pilot-errors";
import type { PilotPaymentResource } from "./pilot-ports";
import type { PilotRouteSpec } from "./pilot-routes";
import type { PilotDispatchRequest, PilotService } from "./pilot-service";
import {
  SignedRequestError,
  SignedRequestVerifierUnavailableError,
  type SignedRequestVerifier,
} from "./signed-request";

const MAX_SIGNED_BODY_BYTES = 32 * 1_024;
const RATE_LIMIT_FAILURE_RETRY_AFTER_SECONDS = 60;

export type PilotOperationalSignal = "signed_request_rate_limiter_unavailable";

export interface PilotHttpDependencies {
  readonly emitOperationalSignal: (signal: PilotOperationalSignal) => void;
  readonly signedRequestRateLimiter?: SignedRequestRateLimiter;
  readonly service: PilotService;
  readonly signedRequestVerifier: SignedRequestVerifier;
}

function retryableCapacityResponse(
  requestId: ReturnType<typeof randomUUID>,
  status: 429 | 503,
  retryAfterSeconds: number,
): Response {
  const response = apiError(
    status === 429 ? "RATE_LIMITED" : "RATE_LIMITER_UNAVAILABLE",
    status === 429
      ? "Too many signed requests. Retry after the indicated delay."
      : "Signed request capacity is temporarily unavailable.",
    status,
    requestId,
    true,
  );
  response.headers.set("Access-Control-Expose-Headers", "Retry-After");
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

function signedRequestCapacityResponse(
  limiter: SignedRequestRateLimiter,
  scope: SignedRequestRateLimitScope,
  requestId: ReturnType<typeof randomUUID>,
  emitOperationalSignal: PilotHttpDependencies["emitOperationalSignal"],
): Response | null {
  try {
    const decision = limiter.consume(scope);
    if (decision.allowed === true && decision.retryAfterSeconds === undefined) {
      return null;
    }
    if (
      decision.allowed === false &&
      Number.isSafeInteger(decision.retryAfterSeconds) &&
      (decision.retryAfterSeconds ?? 0) > 0
    ) {
      return retryableCapacityResponse(requestId, 429, decision.retryAfterSeconds ?? 1);
    }
  } catch {
    // The public signal deliberately exposes no scope, account, key or internal exception.
  }
  try {
    emitOperationalSignal("signed_request_rate_limiter_unavailable");
  } catch {
    // Observability failure must not convert a bounded capacity failure into an unbounded retry.
  }
  return retryableCapacityResponse(requestId, 503, RATE_LIMIT_FAILURE_RETRY_AFTER_SECONDS);
}

function reject(
  code: ConstructorParameters<typeof PilotApiError>[0],
  status: ConstructorParameters<typeof PilotApiError>[1],
  message: string,
): never {
  throw new PilotApiError(code, status, message);
}

function assertRoute(request: Request, spec: PilotRouteSpec): void {
  const url = new URL(request.url);
  if (url.pathname !== spec.path || url.search.length > 0) {
    reject("ROUTE_MISMATCH", 400, "The signed operation does not match this API route.");
  }
}

function assertSignedBodyHeaders(request: Request): void {
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding.trim().toLowerCase() !== "identity") {
    reject("COMMAND_INVALID", 400, "The signed request encoding is invalid.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength === null) {
    return;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) {
    reject("COMMAND_INVALID", 400, "The signed request length is invalid.");
  }
  if (BigInt(contentLength) > BigInt(MAX_SIGNED_BODY_BYTES)) {
    reject("REQUEST_TOO_LARGE", 413, "The signed request body is too large.");
  }
}

async function readBoundedSignedBody(request: Request): Promise<string> {
  if (request.body === null) {
    return "";
  }

  const reader = request.body.getReader();
  const boundedBytes = Buffer.allocUnsafe(MAX_SIGNED_BODY_BYTES);
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        reject("COMMAND_INVALID", 400, "The signed request body is invalid.");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_SIGNED_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        reject("REQUEST_TOO_LARGE", 413, "The signed request body is too large.");
      }
      boundedBytes.set(result.value, totalBytes - result.value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(boundedBytes.subarray(0, totalBytes));
  } catch {
    reject("COMMAND_INVALID", 400, "The signed request body is invalid.");
  }
}

function paymentResource(
  resourceType: string,
  resourceId: string | undefined,
): PilotPaymentResource | null {
  if (resourceId === undefined) {
    return null;
  }
  if (resourceType === "charge") {
    if (!resourceId.startsWith("ch_")) {
      reject("RESOURCE_MISMATCH", 400, "The resource ID does not match the signed resource type.");
    }
    return { id: resourceId, type: "charge" };
  }
  if (resourceType === "payment_intent") {
    if (!resourceId.startsWith("pi_")) {
      reject("RESOURCE_MISMATCH", 400, "The resource ID does not match the signed resource type.");
    }
    return { id: resourceId, type: "payment_intent" };
  }
  return null;
}

function safeSignedRequestError(
  error: SignedRequestError,
  requestId: ReturnType<typeof randomUUID>,
): Response {
  const nonCanonical =
    error.code === "ENVELOPE_INVALID" && error.message.includes("canonical field order");
  return apiError(
    nonCanonical ? "ENVELOPE_NON_CANONICAL" : error.code,
    nonCanonical
      ? "The signed request envelope is not canonical."
      : "The signed request could not be verified.",
    error.code === "SIGNATURE_MISSING" || error.code === "SIGNATURE_INVALID" ? 401 : 400,
    requestId,
    true,
  );
}

export async function handlePilotRoute(
  request: Request,
  spec: PilotRouteSpec,
  dependencies: PilotHttpDependencies,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    assertRoute(request, spec);
    const stripeSignature = request.headers.get("stripe-signature");
    if (stripeSignature === null || stripeSignature.length === 0) {
      throw new SignedRequestError("SIGNATURE_MISSING", "Stripe-Signature is required");
    }

    assertSignedBodyHeaders(request);
    const rawText = await readBoundedSignedBody(request);

    const verified = await dependencies.signedRequestVerifier.verify(rawText, stripeSignature);
    const { envelope } = verified;

    if (!envelope.account_id.startsWith("acct_") || !envelope.user_id.startsWith("usr_")) {
      reject(
        "ACCOUNT_ENVIRONMENT_MISMATCH",
        403,
        "The signed Stripe account or user identity is invalid.",
      );
    }
    if (envelope.mode !== "test") {
      reject("LIVE_MODE_DISABLED", 403, "RefundDesk pilot operations are disabled in live mode.");
    }

    const capacityResponse = signedRequestCapacityResponse(
      dependencies.signedRequestRateLimiter ?? sandboxSignedRequestRateLimiter(),
      {
        accountId: envelope.account_id,
        environment: envelope.is_sandbox ? "sandbox" : "test",
        requestClass: spec.mutation ? "mutation" : "read",
      },
      requestId,
      dependencies.emitOperationalSignal,
    );
    if (capacityResponse !== null) {
      return capacityResponse;
    }

    if (envelope.operation !== spec.operation) {
      reject("ROUTE_MISMATCH", 400, "The signed operation does not match this API route.");
    }

    let resource: PilotPaymentResource | null;
    if (spec.resource === "account") {
      if (envelope.resource_type !== "account") {
        reject(
          "RESOURCE_MISMATCH",
          403,
          "This route must be signed for the current Stripe account.",
        );
      }
      resource = null;
    } else {
      resource =
        envelope.resource_type === "account"
          ? null
          : paymentResource(envelope.resource_type, envelope.resource_id);
      if (resource === null) {
        reject(
          "RESOURCE_MISMATCH",
          400,
          "This route must be signed for a Charge or PaymentIntent.",
        );
      }
    }

    const command = parseOperationCommand(spec.operation, envelope.command_json);
    if (canonicalJson(command as CanonicalJsonValue) !== envelope.command_json) {
      reject("ENVELOPE_NON_CANONICAL", 400, "The signed command is not canonical.");
    }

    const dispatchRequest = {
      approvalAttestationId: verified.approvalAttestationId,
      canonicalRequestHash: createHash("sha256").update(verified.rawBody).digest(),
      command,
      identity: {
        accountId: envelope.account_id,
        environment: envelope.is_sandbox ? "sandbox" : "test",
        roles: envelope.roles_asserted ? envelope.stripe_roles : [],
        rolesAsserted: envelope.roles_asserted,
        userId: envelope.user_id,
      },
      mutation: spec.mutation,
      operation: spec.operation,
      requestNonce: envelope.request_nonce,
      responseRequestId: requestId,
      resource,
    } as PilotDispatchRequest;
    const result = await dependencies.service.dispatch(dispatchRequest);
    return jsonResponse(result.body, result.status, true);
  } catch (error) {
    if (error instanceof SignedRequestError) {
      return safeSignedRequestError(error, requestId);
    }
    if (error instanceof SignedRequestVerifierUnavailableError) {
      return apiError(
        "SIGNATURE_VERIFIER_UNAVAILABLE",
        "Signed requests cannot be verified right now.",
        503,
        requestId,
        true,
      );
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return apiError("COMMAND_INVALID", "The signed command is invalid.", 400, requestId, true);
    }
    const safeError = asSafePilotError(error);
    return apiError(safeError.code, safeError.message, safeError.status, requestId, true);
  }
}
