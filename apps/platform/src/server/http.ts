import { randomUUID } from "node:crypto";

export const extensionCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store",
} as const;

export function extensionOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: extensionCorsHeaders });
}

export function jsonResponse(body: unknown, status = 200, cors = false): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(cors ? extensionCorsHeaders : {}),
    },
  });
}

export function apiError(
  code: string,
  message: string,
  status: number,
  requestId = randomUUID(),
  cors = false,
): Response {
  return jsonResponse({ code, message, request_id: requestId }, status, cors);
}
