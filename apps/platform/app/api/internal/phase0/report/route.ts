import { randomUUID } from "node:crypto";

import { z } from "zod";

import { loadConfig } from "@refunddesk/config";
import { canonicalJson } from "@refunddesk/contracts";

import { apiError, extensionOptionsResponse, jsonResponse } from "../../../../../src/server/http";
import { isPhase0Administrator } from "../../../../../src/server/phase0-proof";
import { phase0Store } from "../../../../../src/server/phase0-store";
import {
  SignedRequestError,
  verifySignedExtensionRequest,
} from "../../../../../src/server/signed-request";

export const runtime = "nodejs";

const MAX_SIGNED_BODY_BYTES = 32 * 1_024;
const MAX_EVIDENCE_ITEMS = 500;
const commandSchema = z.object({}).strict();

function redactStripeId(value: string): string {
  const separator = value.indexOf("_");
  const prefix = separator < 0 ? "id" : value.slice(0, separator);
  return `${prefix}_…${value.slice(-6)}`;
}

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
    if (url.pathname !== "/api/internal/phase0/report" || url.search.length > 0) {
      return apiError(
        "ROUTE_MISMATCH",
        "The signed operation does not match this API route",
        400,
        requestId,
        true,
      );
    }
    if (
      envelope.operation !== "phase0.report" ||
      envelope.mode !== "test" ||
      envelope.resource_type !== "payment_intent"
    ) {
      return apiError(
        "PHASE0_SCOPE_REJECTED",
        "The report accepts only test PaymentIntents",
        403,
        requestId,
        true,
      );
    }
    if (!isPhase0Administrator(envelope.stripe_roles)) {
      return apiError(
        "ADMIN_REQUIRED",
        "A signed Stripe Administrator role is required for the phase-0 report",
        403,
        requestId,
        true,
      );
    }
    if (!config.phase0AllowedPaymentIntents.has(envelope.resource_id)) {
      return apiError(
        "PAYMENT_NOT_ALLOWLISTED",
        "This synthetic payment is not allowlisted for the report",
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

    const environment = envelope.is_sandbox ? "sandbox" : "test";
    const report = phase0Store.report(envelope.account_id, environment);
    const visibleEvidence = report.evidence.slice(-MAX_EVIDENCE_ITEMS);
    return jsonResponse(
      {
        request_id: requestId,
        environment,
        probe_count: report.probes,
        evidence_count: report.evidence.length,
        truncated: visibleEvidence.length !== report.evidence.length,
        evidence: visibleEvidence.map((item) => ({
          observed_at: item.observedAt,
          refund_id: redactStripeId(item.refundId),
          correlation: item.correlation,
          request_bound: item.requestNonce !== null,
        })),
      },
      200,
      true,
    );
  } catch (error) {
    if (error instanceof SignedRequestError) {
      const status =
        error.code === "SIGNATURE_MISSING" || error.code === "SIGNATURE_INVALID" ? 401 : 400;
      return apiError(error.code, error.message, status, requestId, true);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return apiError("COMMAND_INVALID", "The signed command is invalid", 400, requestId, true);
    }
    return apiError(
      "PHASE0_REPORT_FAILED",
      "The phase-0 report failed safely",
      503,
      requestId,
      true,
    );
  }
}
