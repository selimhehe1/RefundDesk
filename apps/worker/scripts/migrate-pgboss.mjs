import { PgBoss } from "pg-boss";

import {
  assertRuntimePrincipalsAreSeparated,
  loadLocalEnvironment,
  requirePostgresUrl,
} from "../../../scripts/local-environment.mjs";

loadLocalEnvironment();
assertRuntimePrincipalsAreSeparated();

const migrationUrl = requirePostgresUrl("DATABASE_MIGRATION_URL");
const boss = new PgBoss({
  connectionString: migrationUrl.toString(),
  application_name: "refunddesk-pgboss-owner-migration",
  createSchema: true,
  migrate: true,
  schedule: false,
  supervise: false,
});

boss.on("error", (error) => {
  process.stderr.write(
    `${JSON.stringify({
      component: "pgboss-owner-migration",
      code: error.name,
    })}\n`,
  );
});

try {
  await boss.start();
  const schemaVersion = await boss.schemaVersion();
  await boss.stop({ graceful: true, timeout: 30_000 });
  process.stdout.write(`${JSON.stringify({ status: "ready", schema_version: schemaVersion })}\n`);
} catch (error) {
  await boss.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.name
        : "PGBOSS_OWNER_MIGRATION_FAILED";
  process.stderr.write(`${JSON.stringify({ component: "pgboss-owner-migration", code })}\n`);
  process.exitCode = 1;
}
