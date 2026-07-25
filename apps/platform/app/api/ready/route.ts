import { Pool } from "pg";

import { loadConfig } from "@refunddesk/config";

import {
  isPlatformReady,
  PLATFORM_READINESS_SQL,
  type PlatformReadinessRow,
} from "../../../src/server/readiness";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  let pool: Pool | undefined;
  try {
    const config = loadConfig();
    pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
    const result = await pool.query<PlatformReadinessRow>(PLATFORM_READINESS_SQL);
    if (!isPlatformReady(result.rows[0])) {
      throw new Error("PLATFORM_DEPENDENCIES_NOT_READY");
    }
    return Response.json(
      { status: "ready", database: "ok", schema: "ok", isolation: "forced" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "not_ready", database: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await pool?.end();
  }
}
