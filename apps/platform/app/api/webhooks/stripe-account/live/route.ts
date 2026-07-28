import { receiveAccountWebhook } from "../../../../../src/server/account-webhook";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return receiveAccountWebhook(request, "live");
}
