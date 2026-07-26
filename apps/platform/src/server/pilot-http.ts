import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  parseOperationCommand,
  type CanonicalJsonValue,
} from "@refunddesk/contracts";

import { apiError, jsonResponse } from "./http";
import { asSafePilotError, PilotApiError } from "./pilot-errors";
import type { PilotPaymentResource } from "./pilot-ports";
import type { PilotRouteSpec } from "./pilot-routes";
import type { PilotDispatchRequest, PilotService } from "./pilot-service";
import { SignedRequestError, verifySignedExtensionRequest } from "./signed-request";

const MAX_SIGNED_BODY_BYTES = 32 * 1_024;

export interface PilotHttpDependencies {
  readonly service: PilotService;
  readonly signingSecret: string;
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
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && Number.parseInt(contentLength, 10) > MAX_SIGNED_BODY_BYTES) {
      reject("REQUEST_TOO_LARGE", 413, "The signed request body is too large.");
    }

    const rawText = await request.text();
    const rawByteLength = Buffer.byteLength(rawText, "utf8");
    if (rawByteLength > MAX_SIGNED_BODY_BYTES) {
      reject("REQUEST_TOO_LARGE", 413, "The signed request body is too large.");
    }

    const verified = verifySignedExtensionRequest(
      rawText,
      request.headers.get("stripe-signature"),
      dependencies.signingSecret,
    );
    const { envelope } = verified;

    assertRoute(request, spec);
    if (!envelope.account_id.startsWith("acct_") || !envelope.user_id.startsWith("usr_")) {
      reject(
        "ACCOUNT_ENVIRONMENT_MISMATCH",
        403,
        "The signed Stripe account or user identity is invalid.",
      );
    }
    if (envelope.operation !== spec.operation) {
      reject("ROUTE_MISMATCH", 400, "The signed operation does not match this API route.");
    }
    if (envelope.mode !== "test") {
      reject("LIVE_MODE_DISABLED", 403, "RefundDesk pilot operations are disabled in live mode.");
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
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return apiError("COMMAND_INVALID", "The signed command is invalid.", 400, requestId, true);
    }
    const safeError = asSafePilotError(error);
    return apiError(safeError.code, safeError.message, safeError.status, requestId, true);
  }
}
