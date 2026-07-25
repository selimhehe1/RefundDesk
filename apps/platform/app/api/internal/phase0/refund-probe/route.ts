import { randomUUID } from "node:crypto";

import { z } from "zod";

import { loadConfig } from "@refunddesk/config";
import { canonicalJson } from "@refunddesk/contracts";
import { ConnectedAccountStripeClient, StripeCredentialResolver } from "@refunddesk/stripe-adapter";

import { apiError, extensionOptionsResponse, jsonResponse } from "../../../../../src/server/http";
import { isPhase0Administrator } from "../../../../../src/server/phase0-proof";
import {
  executePhase0Probe,
  Phase0PaymentIneligibleError,
  Phase0RefundResponseMismatchError,
} from "../../../../../src/server/phase0-probe";
import { Phase0NonceConflictError, phase0Store } from "../../../../../src/server/phase0-store";
import {
  SignedRequestError,
  verifySignedExtensionRequest,
} from "../../../../../src/server/signed-request";

export const runtime = "nodejs";

const MAX_SIGNED_BODY_BYTES = 32 * 1_024;

const commandSchema = z
  .object({
    amount_minor: z.string().regex(/^[1-9]\d*$/u),
    currency: z.string().regex(/^[a-z]{3}$/u),
    reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]),
  })
  .strict();

export function OPTIONS(): Response {
  return extensionOptionsResponse();
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const config = loadConfig();
    if (!config.phase0ProbeEnabled || config.nodeEnv === "production") {
      return new Response(null, { status: 404 });
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && Number.parseInt(contentLength, 10) > MAX_SIGNED_BODY_BYTES) {
      return apiError(
        "REQUEST_TOO_LARGE",
        "The signed request body is too large",
        413,
        requestId,
        true,
      );
    }
    const rawText = await request.text();
    if (Buffer.byteLength(rawText, "utf8") > MAX_SIGNED_BODY_BYTES) {
      return apiError(
        "REQUEST_TOO_LARGE",
        "The signed request body is too large",
        413,
        requestId,
        true,
      );
    }
    const { envelope } = verifySignedExtensionRequest(
      rawText,
      request.headers.get("stripe-signature"),
      config.stripe.appSigningSecret,
    );
    const url = new URL(request.url);
    if (url.pathname !== "/api/internal/phase0/refund-probe" || url.search.length > 0) {
      return apiError(
        "ROUTE_MISMATCH",
        "The signed operation does not match this API route",
        400,
        requestId,
        true,
      );
    }
    if (
      envelope.operation !== "phase0.refund_probe" ||
      envelope.mode !== "test" ||
      envelope.resource_type !== "payment_intent"
    ) {
      return apiError(
        "PHASE0_SCOPE_REJECTED",
        "The probe accepts only test PaymentIntents",
        403,
        requestId,
        true,
      );
    }
    if (!isPhase0Administrator(envelope.stripe_roles)) {
      return apiError(
        "ADMIN_REQUIRED",
        "A signed Stripe Administrator role is required for the phase-0 probe",
        403,
        requestId,
        true,
      );
    }
    if (!config.phase0AllowedPaymentIntents.has(envelope.resource_id)) {
      return apiError(
        "PAYMENT_NOT_ALLOWLISTED",
        "This synthetic payment is not allowlisted for the probe",
        403,
        requestId,
        true,
      );
    }

    const command = commandSchema.parse(JSON.parse(envelope.command_json));
    if (canonicalJson(command) !== envelope.command_json) {
      return apiError(
        "ENVELOPE_NON_CANONICAL",
        "The signed command is not canonical",
        400,
        requestId,
        true,
      );
    }
    const amountMinor = BigInt(command.amount_minor);
    if (amountMinor > 10_000n) {
      return apiError(
        "PHASE0_AMOUNT_LIMIT",
        "The phase-0 amount is above the test limit",
        422,
        requestId,
        true,
      );
    }

    const environment = envelope.is_sandbox ? "sandbox" : "test";
    const installation = {
      stripeAccountId: envelope.account_id,
      environment,
      active: true,
    } as const;
    const stripe = new ConnectedAccountStripeClient(
      new StripeCredentialResolver({
        platformTestKey: config.stripe.platformTestKey,
        managedSandboxKey: config.stripe.managedSandboxKey,
      }),
    );
    const result = await executePhase0Probe(
      {
        installation,
        actorUserId: envelope.user_id,
        requestNonce: envelope.request_nonce,
        paymentIntentId: envelope.resource_id,
        amountMinor,
        currency: command.currency,
        reason: command.reason,
      },
      {
        stripe,
        store: phase0Store,
        proofKey: config.keys.proofV1,
      },
    );

    return jsonResponse(
      {
        request_id: requestId,
        refund_id: result.refund.id,
        stripe_request_id: result.refund.requestId,
        correlation: result.correlation,
        replay: result.replay,
        status: result.refund.status,
      },
      200,
      true,
    );
  } catch (error) {
    if (error instanceof Phase0NonceConflictError) {
      return apiError(
        "IDEMPOTENCY_CONFLICT",
        "The request nonce was already used for different probe data",
        409,
        requestId,
        true,
      );
    }
    if (error instanceof Phase0PaymentIneligibleError) {
      return apiError(
        "PAYMENT_NOT_ELIGIBLE",
        "The payment is not an eligible captured card payment",
        422,
        requestId,
        true,
      );
    }
    if (error instanceof Phase0RefundResponseMismatchError) {
      return apiError(
        "REFUND_RESPONSE_MISMATCH",
        "Stripe returned an unexpected Refund response",
        502,
        requestId,
        true,
      );
    }
    if (error instanceof SignedRequestError) {
      const status =
        error.code === "SIGNATURE_MISSING" || error.code === "SIGNATURE_INVALID" ? 401 : 400;
      return apiError(error.code, error.message, status, requestId, true);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return apiError("COMMAND_INVALID", "The signed command is invalid", 400, requestId, true);
    }
    return apiError("PHASE0_PROBE_FAILED", "The phase-0 probe failed safely", 502, requestId, true);
  }
}
