import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  parseOperationCommand,
  type CanonicalJsonValue,
} from "@refunddesk/contracts";

import {
  getEdgeAdmissionGate,
  type EdgeAdmissionGate,
  type EdgeAdmissionLease,
} from "./edge-admission";
import {
  BoundedRequestBodyError,
  readBoundedRequestBody,
  REQUEST_BODY_DEADLINE_MS,
} from "./bounded-request-body";
import { apiError, jsonResponse } from "./http";
import {
  type SignedRequestRateLimiter,
  type SignedRequestRateLimitScope,
} from "./mutation-rate-limit";
import { asSafePilotError, PilotApiError } from "./pilot-errors";
import type { PilotPaymentResource } from "./pilot-ports";
import type { PilotRouteSpec } from "./pilot-routes";
import type { PilotDispatchRequest, PilotService } from "./pilot-service";
import {
  SignedRequestAttestationConflictError,
  SignedRequestError,
  SignedRequestVerifierUnavailableError,
  type SignedRequestVerifier,
} from "./signed-request";

const MAX_SIGNED_BODY_BYTES = 32 * 1_024;
const RATE_LIMIT_FAILURE_RETRY_AFTER_SECONDS = 60;

export type PilotOperationalSignal =
  "edge_admission_unavailable" | "edge_rate_limited" | "signed_request_rate_limiter_unavailable";

export interface PilotHttpDependencies {
  readonly edgeAdmissionGate?: EdgeAdmissionGate;
  readonly emitOperationalSignal: (signal: PilotOperationalSignal) => void;
  readonly signedRequestRateLimiter: SignedRequestRateLimiter;
  readonly service: PilotService;
  readonly signedRequestVerifier: SignedRequestVerifier;
}

function emitSignalSafely(
  emitOperationalSignal: PilotHttpDependencies["emitOperationalSignal"],
  signal: PilotOperationalSignal,
): void {
  try {
    emitOperationalSignal(signal);
  } catch {
    // Observability must never alter an admission decision.
  }
}

function edgeAdmissionDeniedResponse(
  status: 429 | 503,
  requestId: ReturnType<typeof randomUUID>,
  retryAfterSeconds: number,
): Response {
  const response = apiError(
    status === 429 ? "EDGE_RATE_LIMITED" : "EDGE_ADMISSION_UNAVAILABLE",
    status === 429
      ? "Request admission capacity is temporarily exhausted."
      : "Request admission is temporarily unavailable.",
    status,
    requestId,
    true,
  );
  response.headers.set("Access-Control-Expose-Headers", "Retry-After");
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

function acquireEdgeAdmission(
  dependencies: PilotHttpDependencies,
  request: Request,
  requestId: ReturnType<typeof randomUUID>,
): { readonly lease: EdgeAdmissionLease } | { readonly response: Response } {
  let decision;
  try {
    decision = (dependencies.edgeAdmissionGate ?? getEdgeAdmissionGate()).acquire(
      request.headers,
      "signed_api",
    );
  } catch {
    emitSignalSafely(dependencies.emitOperationalSignal, "edge_admission_unavailable");
    return { response: edgeAdmissionDeniedResponse(503, requestId, 60) };
  }
  if (decision.allowed) {
    return { lease: decision.lease };
  }
  if (
    decision.status === 429 &&
    Number.isSafeInteger(decision.retryAfterSeconds) &&
    (decision.retryAfterSeconds ?? 0) > 0
  ) {
    emitSignalSafely(dependencies.emitOperationalSignal, "edge_rate_limited");
    return {
      response: edgeAdmissionDeniedResponse(429, requestId, decision.retryAfterSeconds ?? 1),
    };
  }
  emitSignalSafely(dependencies.emitOperationalSignal, "edge_admission_unavailable");
  return { response: edgeAdmissionDeniedResponse(503, requestId, 60) };
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

async function signedRequestCapacityResponse(
  limiter: SignedRequestRateLimiter,
  scope: SignedRequestRateLimitScope,
  requestId: ReturnType<typeof randomUUID>,
  emitOperationalSignal: PilotHttpDependencies["emitOperationalSignal"],
): Promise<Response | null> {
  try {
    const decision = await limiter.consume(scope);
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

async function readBoundedSignedBody(request: Request, deadlineAtMs: number): Promise<string> {
  let boundedBytes: Buffer;
  try {
    boundedBytes = await readBoundedRequestBody(request, {
      deadlineAtMs,
      maximumBytes: MAX_SIGNED_BODY_BYTES,
    });
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) {
      if (error.code === "deadline_exceeded") {
        throw error;
      }
      if (error.code === "too_large") {
        reject("REQUEST_TOO_LARGE", 413, "The signed request body is too large.");
      }
      reject("COMMAND_INVALID", 400, "The signed request body is invalid.");
    }
    throw error;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(boundedBytes);
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
  let edgeLease: EdgeAdmissionLease | null = null;
  try {
    assertRoute(request, spec);
    const edgeAdmission = acquireEdgeAdmission(dependencies, request, requestId);
    if ("response" in edgeAdmission) {
      return edgeAdmission.response;
    }
    edgeLease = edgeAdmission.lease;
    const verificationDeadlineAtMs = Date.now() + REQUEST_BODY_DEADLINE_MS;
    const stripeSignature = request.headers.get("stripe-signature");
    if (stripeSignature === null || stripeSignature.length === 0) {
      throw new SignedRequestError("SIGNATURE_MISSING", "Stripe-Signature is required");
    }

    assertSignedBodyHeaders(request);
    const rawText = await readBoundedSignedBody(request, verificationDeadlineAtMs);

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

    const capacityResponse = await signedRequestCapacityResponse(
      dependencies.signedRequestRateLimiter,
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

    const approvalAttestationId =
      envelope.operation === "refund_request.decide" &&
      parseOperationCommand("refund_request.decide", envelope.command_json).decision === "approve"
        ? await dependencies.signedRequestVerifier.attestApproval(verified, stripeSignature)
        : null;

    edgeLease.release();
    edgeLease = null;

    const dispatchRequest = {
      approvalAttestationId,
      canonicalRequestHash: verified.canonicalRequestHash,
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
    if (error instanceof BoundedRequestBodyError && error.code === "deadline_exceeded") {
      return apiError(
        "REQUEST_TIMEOUT",
        "The signed request body did not complete in time.",
        408,
        requestId,
        true,
      );
    }
    if (error instanceof SignedRequestAttestationConflictError) {
      return apiError(
        "IDEMPOTENCY_CONFLICT",
        "The request nonce was already used for a different mutation.",
        409,
        requestId,
        true,
      );
    }
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
  } finally {
    edgeLease?.release();
  }
}
