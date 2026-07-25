import { Client } from "pg";

import {
  assertRuntimePrincipalsAreSeparated,
  databasePrincipal,
  loadLocalEnvironment,
  requirePostgresUrl,
} from "../../../scripts/local-environment.mjs";

loadLocalEnvironment();
assertRuntimePrincipalsAreSeparated();

const migrationUrl = requirePostgresUrl("DATABASE_MIGRATION_URL");

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

const client = new Client({
  connectionString: migrationUrl.toString(),
  application_name: "refunddesk-pgboss-runtime-grant",
});

try {
  await client.connect();
  const schemaResult = await client.query(
    `SELECT current_user, owner.rolname AS schema_owner
       FROM pg_namespace namespace
       JOIN pg_roles owner ON owner.oid = namespace.nspowner
      WHERE namespace.nspname = 'pgboss'`,
  );
  const schema = schemaResult.rows[0];
  if (schema === undefined) {
    throw new Error("PGBOSS_SCHEMA_MISSING");
  }
  if (
    schema.current_user !== databasePrincipal(migrationUrl) ||
    schema.schema_owner !== schema.current_user
  ) {
    throw new Error("PGBOSS_SCHEMA_MUST_BE_OWNED_BY_MIGRATION_ROLE");
  }

  const owner = quoteIdentifier(schema.schema_owner);
  const worker = quoteIdentifier("refunddesk_worker");
  const web = quoteIdentifier("refunddesk_runtime");
  const pgBoss = quoteIdentifier("pgboss");

  // RefundDesk queues use pg-boss' non-partitioned default. The worker
  // deliberately receives no CREATE privilege; partition DDL remains an
  // owner migration responsibility.
  await client.query("BEGIN");
  await client.query(`REVOKE ALL ON SCHEMA ${pgBoss} FROM PUBLIC, ${web}`);
  await client.query(`REVOKE CREATE ON SCHEMA ${pgBoss} FROM ${worker}`);
  await client.query(`GRANT USAGE ON SCHEMA ${pgBoss} TO ${worker}`);

  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${pgBoss} FROM PUBLIC, ${web}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${pgBoss} TO ${worker}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${pgBoss} FROM PUBLIC, ${web}`,
  );
  await client.query(
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${pgBoss} TO ${worker}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ${pgBoss} FROM PUBLIC, ${web}`,
  );
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${pgBoss} TO ${worker}`);

  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       REVOKE ALL ON TABLES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${worker}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       REVOKE ALL ON SEQUENCES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${worker}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       GRANT EXECUTE ON FUNCTIONS TO ${worker}`,
  );
  await client.query("COMMIT");
  process.stdout.write("pg-boss runtime privileges are ready.\n");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.message
        : "PGBOSS_RUNTIME_GRANT_FAILED";
  process.stderr.write(`${JSON.stringify({ component: "pgboss-runtime-grant", code })}\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
