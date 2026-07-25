import { PgBoss } from "pg-boss";

import { loadConfig } from "@refunddesk/config";
import { createLogger } from "@refunddesk/observability";

async function migrate(): Promise<void> {
  const config = loadConfig();
  const connectionString = config.migrationDatabaseUrl;
  if (connectionString === undefined) {
    throw new Error("DATABASE_MIGRATION_URL_REQUIRED");
  }
  const logger = createLogger("refunddesk-pgboss-migration", config.logLevel);
  const boss = new PgBoss({
    connectionString,
    application_name: "refunddesk-pgboss-migration",
    createSchema: true,
    migrate: true,
    schedule: false,
    supervise: false,
  });
  boss.on("error", (error) => {
    logger.error({ code: error.name }, "pg-boss migration error");
  });
  await boss.start();
  const version = await boss.schemaVersion();
  await boss.stop({ graceful: true, timeout: 30_000 });
  logger.info({ schemaVersion: version }, "pg-boss schema is ready");
}

migrate().catch(() => {
  process.exitCode = 1;
});
