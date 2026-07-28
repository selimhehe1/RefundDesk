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
const runtimeLoginPrincipals = new Set([
  databasePrincipal(requirePostgresUrl("DATABASE_URL")),
  databasePrincipal(requirePostgresUrl("WORKER_DATABASE_URL")),
  databasePrincipal(requirePostgresUrl("PGBOSS_DATABASE_URL")),
]);

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function listExplicitSchemaGrantees(client, schemaName) {
  const result = await client.query(
    `WITH explicit_grantee(grantee) AS (
       SELECT privilege.grantee
       FROM pg_namespace AS namespace
       CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
       WHERE namespace.nspname = $1
       UNION
       SELECT privilege.grantee
       FROM pg_class AS relation
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(relation.relacl) AS privilege
       WHERE namespace.nspname = $1
       UNION
       SELECT privilege.grantee
       FROM pg_attribute AS attribute
       INNER JOIN pg_class AS relation
         ON relation.oid = attribute.attrelid
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
       WHERE namespace.nspname = $1
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       UNION
       SELECT privilege.grantee
       FROM pg_proc AS routine
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = routine.pronamespace
       CROSS JOIN LATERAL aclexplode(routine.proacl) AS privilege
       WHERE namespace.nspname = $1
       UNION
       SELECT privilege.grantee
       FROM pg_type AS type
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = type.typnamespace
       CROSS JOIN LATERAL aclexplode(type.typacl) AS privilege
       WHERE namespace.nspname = $1
       UNION
       SELECT privilege.grantee
       FROM pg_default_acl AS default_acl
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = default_acl.defaclnamespace
       CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS privilege
       WHERE default_acl.defaclrole = current_user::regrole
         AND namespace.nspname = $1
     )
     SELECT role.rolname
     FROM explicit_grantee
     INNER JOIN pg_roles AS role ON role.oid = explicit_grantee.grantee
     WHERE explicit_grantee.grantee <> current_user::regrole
     GROUP BY role.rolname
     ORDER BY role.rolname`,
    [schemaName],
  );
  return result.rows.map((row) => row.rolname);
}

async function listGrantableSchemaTypes(client, schemaName) {
  const result = await client.query(
    `SELECT type.typname
       FROM pg_type AS type
       INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = $1
        AND type.typtype IN ('d', 'e', 'm', 'r')
      ORDER BY type.typname`,
    [schemaName],
  );
  return result.rows.map((row) => row.typname);
}

const client = new Client({
  connectionString: migrationUrl.toString(),
  application_name: "refunddesk-pgboss-runtime-grant",
  options: "-c search_path=pg_catalog,public",
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
  const queue = quoteIdentifier("refunddesk_queue");
  const web = quoteIdentifier("refunddesk_runtime");
  const attestationWriter = quoteIdentifier("refunddesk_attestation_writer");
  const pgBoss = quoteIdentifier("pgboss");

  // RefundDesk queues use pg-boss' non-partitioned default. The queue capability
  // deliberately receives no CREATE privilege; partition DDL remains an
  // owner migration responsibility.
  await client.query("BEGIN");
  const staleGrantees = new Set([
    ...(await listExplicitSchemaGrantees(client, "pgboss")),
    ...runtimeLoginPrincipals,
    "refunddesk_runtime",
    "refunddesk_worker",
    "refunddesk_queue",
    "refunddesk_maintenance",
    "refunddesk_attestation_writer",
  ]);
  const schemaTypes = await listGrantableSchemaTypes(client, "pgboss");
  for (const staleGrantee of staleGrantees) {
    const grantee = quoteIdentifier(staleGrantee);
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA ${pgBoss} FROM ${grantee}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${pgBoss} FROM ${grantee}`);
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${pgBoss} FROM ${grantee}`,
    );
    await client.query(`REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA ${pgBoss} FROM ${grantee}`);
    for (const schemaType of schemaTypes) {
      await client.query(
        `REVOKE ALL PRIVILEGES ON TYPE ${pgBoss}.${quoteIdentifier(schemaType)}
           FROM ${grantee}`,
      );
    }
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
         REVOKE ALL PRIVILEGES ON TABLES FROM ${grantee}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
         REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${grantee}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
         REVOKE ALL PRIVILEGES ON ROUTINES FROM ${grantee}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
         REVOKE ALL PRIVILEGES ON TYPES FROM ${grantee}`,
    );
  }
  await client.query(
    `REVOKE ALL PRIVILEGES ON SCHEMA ${pgBoss}
       FROM PUBLIC, ${web}, ${worker}, ${queue}, ${quoteIdentifier("refunddesk_maintenance")},
         ${attestationWriter}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${pgBoss}
       FROM PUBLIC, ${web}, ${worker}, ${queue}, ${quoteIdentifier("refunddesk_maintenance")},
         ${attestationWriter}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${pgBoss}
       FROM PUBLIC, ${web}, ${worker}, ${queue}, ${quoteIdentifier("refunddesk_maintenance")},
         ${attestationWriter}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA ${pgBoss}
       FROM PUBLIC, ${web}, ${worker}, ${queue}, ${quoteIdentifier("refunddesk_maintenance")},
         ${attestationWriter}`,
  );
  await client.query(`GRANT USAGE ON SCHEMA ${pgBoss} TO ${queue}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${pgBoss} TO ${queue}`,
  );
  await client.query(
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${pgBoss} TO ${queue}`,
  );
  await client.query(`GRANT EXECUTE ON ALL ROUTINES IN SCHEMA ${pgBoss} TO ${queue}`);
  for (const schemaType of schemaTypes) {
    const type = `${pgBoss}.${quoteIdentifier(schemaType)}`;
    await client.query(
      `REVOKE ALL PRIVILEGES ON TYPE ${type}
         FROM PUBLIC, ${web}, ${worker}, ${queue}, ${quoteIdentifier("refunddesk_maintenance")},
           ${attestationWriter}`,
    );
    await client.query(`GRANT USAGE ON TYPE ${type} TO ${queue}`);
  }

  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       REVOKE ALL ON TABLES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${queue}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       REVOKE ALL ON SEQUENCES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${queue}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       REVOKE EXECUTE ON ROUTINES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       GRANT EXECUTE ON ROUTINES TO ${queue}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       REVOKE ALL ON TYPES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${pgBoss}
       GRANT USAGE ON TYPES TO ${queue}`,
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
