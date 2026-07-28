import { readFile } from "node:fs/promises";

import { Client } from "pg";

import {
  databasePrincipal,
  loadLocalEnvironment,
  requirePostgresUrl,
} from "../../../scripts/local-environment.mjs";

loadLocalEnvironment();

const migrationUrl = requirePostgresUrl("DATABASE_MIGRATION_URL");
const localHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const databaseName = decodeURIComponent(migrationUrl.pathname.slice(1));

if (
  !localHosts.has(migrationUrl.hostname) ||
  databaseName !== "refunddesk" ||
  databasePrincipal(migrationUrl) !== "refunddesk_owner" ||
  process.env["NODE_ENV"] === "production"
) {
  throw new Error("LOCAL_DATABASE_BOOTSTRAP_REFUSED");
}

const sql = await readFile(
  new URL("../../../docker/postgres/init/10-local-runtime-logins.sql", import.meta.url),
  "utf8",
);
const client = new Client({
  connectionString: migrationUrl.toString(),
  application_name: "refunddesk-local-role-bootstrap",
  options: "-c search_path=pg_catalog,public",
});

try {
  await client.connect();
  await client.query(sql);
  process.stdout.write("Local PostgreSQL login roles are ready.\n");
} catch (error) {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "LOCAL_ROLE_BOOTSTRAP_FAILED";
  process.stderr.write(`${JSON.stringify({ component: "database-bootstrap", code })}\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
