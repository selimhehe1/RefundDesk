import { handlePilotAuditDownload } from "../../../../../src/server/pilot-audit-download";
import { getPilotRuntime } from "../../../../../src/server/pilot-runtime";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handlePilotAuditDownload(request, getPilotRuntime());
}
