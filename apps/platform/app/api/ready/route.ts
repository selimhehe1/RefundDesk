import { loadPlatformConfig } from "@refunddesk/config";

import {
  createPostgresPlatformReadinessProbe,
  type PlatformReadinessProbe,
} from "../../../src/server/readiness-runtime";

export const runtime = "nodejs";

let readinessProbe: PlatformReadinessProbe | undefined;
let readinessDatabaseUrl: string | undefined;

function getReadinessProbe(databaseUrl: string): PlatformReadinessProbe {
  if (readinessDatabaseUrl !== undefined && readinessDatabaseUrl !== databaseUrl) {
    throw new Error("PLATFORM_READINESS_DATABASE_CHANGED");
  }
  readinessDatabaseUrl = databaseUrl;
  readinessProbe ??= createPostgresPlatformReadinessProbe(databaseUrl);
  return readinessProbe;
}

export async function GET(): Promise<Response> {
  try {
    const config = loadPlatformConfig();
    if (!(await getReadinessProbe(config.databaseUrl).check())) {
      throw new Error("PLATFORM_DEPENDENCIES_NOT_READY");
    }
    return Response.json(
      { status: "ready", service: "platform" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "not_ready", service: "platform" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
