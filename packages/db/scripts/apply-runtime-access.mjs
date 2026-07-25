import { readFile } from "node:fs/promises";

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
const webPrincipal = databasePrincipal(requirePostgresUrl("DATABASE_URL"));
const workerPrincipals = new Set([
  databasePrincipal(requirePostgresUrl("WORKER_DATABASE_URL")),
  databasePrincipal(requirePostgresUrl("PGBOSS_DATABASE_URL")),
]);
const runtimeRolesSql = await readFile(
  new URL("../prisma/runtime-roles.sql", import.meta.url),
  "utf8",
);

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

const client = new Client({
  connectionString: migrationUrl.toString(),
  application_name: "refunddesk-runtime-access-migration",
});

try {
  await client.connect();
  const identity = await client.query("SELECT current_user");
  if (identity.rows[0]?.current_user !== databasePrincipal(migrationUrl)) {
    throw new Error("MIGRATION_DATABASE_IDENTITY_MISMATCH");
  }

  await client.query("BEGIN");
  await client.query(runtimeRolesSql);
  await client.query(
    `GRANT ${quoteIdentifier("refunddesk_runtime")} TO ${quoteIdentifier(webPrincipal)}`,
  );
  await client.query(
    `REVOKE ${quoteIdentifier("refunddesk_worker")} FROM ${quoteIdentifier(webPrincipal)}`,
  );
  for (const relation of [
    "refund_executions",
    "refund_execution_attempts",
    "refund_correlation_candidates",
  ]) {
    const quotedRelation = quoteIdentifier(relation);
    const quotedWebPrincipal = quoteIdentifier(webPrincipal);
    await client.query(
      `REVOKE ALL PRIVILEGES ON TABLE ${quotedRelation} FROM ${quotedWebPrincipal}`,
    );
    const columns = await client.query(
      `SELECT attribute.attname AS column_name
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = $1::regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum`,
      [relation],
    );
    const quotedColumns = columns.rows
      .map((column) => quoteIdentifier(column.column_name))
      .join(", ");
    if (quotedColumns.length > 0) {
      await client.query(
        `REVOKE SELECT (${quotedColumns}), INSERT (${quotedColumns}), UPDATE (${quotedColumns}), REFERENCES (${quotedColumns})
           ON TABLE ${quotedRelation}
         FROM ${quotedWebPrincipal}`,
      );
    }
  }
  for (const workerPrincipal of workerPrincipals) {
    await client.query(
      `GRANT ${quoteIdentifier("refunddesk_worker")} TO ${quoteIdentifier(workerPrincipal)}`,
    );
    await client.query(
      `REVOKE ${quoteIdentifier("refunddesk_runtime")} FROM ${quoteIdentifier(workerPrincipal)}`,
    );
  }

  const loginPrincipals = [webPrincipal, ...workerPrincipals];
  const roleResult = await client.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit
       FROM pg_roles
      WHERE rolname = ANY($1::text[])`,
    [loginPrincipals],
  );
  if (roleResult.rowCount !== loginPrincipals.length) {
    throw new Error("DATABASE_RUNTIME_LOGIN_ROLE_MISSING");
  }
  for (const role of roleResult.rows) {
    if (
      role.rolcanlogin !== true ||
      role.rolsuper !== false ||
      role.rolbypassrls !== false ||
      role.rolinherit !== true
    ) {
      throw new Error("DATABASE_RUNTIME_LOGIN_ROLE_IS_PRIVILEGED");
    }
  }

  await client.query("COMMIT");
  process.stdout.write("Application runtime roles and memberships are ready.\n");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.message
        : "RUNTIME_ACCESS_MIGRATION_FAILED";
  process.stderr.write(`${JSON.stringify({ component: "runtime-access", code })}\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
