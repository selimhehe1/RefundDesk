import { extensionOptionsResponse } from "../../../../../src/server/http";
import { handlePilotRoute } from "../../../../../src/server/pilot-http";
import { PILOT_ROUTE_SPECS } from "../../../../../src/server/pilot-routes";
import { getPilotRuntime } from "../../../../../src/server/pilot-runtime";

export const runtime = "nodejs";

export function OPTIONS(): Response {
  return extensionOptionsResponse();
}

export function POST(request: Request): Promise<Response> {
  return handlePilotRoute(request, PILOT_ROUTE_SPECS.refundRequestCreate, getPilotRuntime());
}
