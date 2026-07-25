import { receiveConnectedWebhook } from "../../../../../src/server/connected-webhook";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return receiveConnectedWebhook(request, "test");
}
