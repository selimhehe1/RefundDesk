import { Client } from "pg";

import {
  assertRuntimePrincipalsAreSeparated,
  databasePrincipal,
  loadLocalEnvironment,
  requirePostgresUrl,
} from "../../../scripts/local-environment.mjs";

loadLocalEnvironment();
assertRuntimePrincipalsAreSeparated();

const webUrl = requirePostgresUrl("DATABASE_URL");
const workerUrl = requirePostgresUrl("WORKER_DATABASE_URL");
const queueUrl = requirePostgresUrl("PGBOSS_DATABASE_URL");
const webPrincipal = databasePrincipal(webUrl);
const workerPrincipal = databasePrincipal(workerUrl);
const queuePrincipal = databasePrincipal(queueUrl);
const collectiveRoleNames = ["refunddesk_runtime", "refunddesk_worker", "refunddesk_maintenance"];

async function verifyCollectiveRoleAttributes(client) {
  const result = await client.query(
    `SELECT
       rolname,
       rolcanlogin,
       rolsuper,
       rolcreatedb,
       rolcreaterole,
       rolinherit,
       rolreplication,
       rolbypassrls,
       EXISTS (
         SELECT 1
         FROM pg_auth_members membership
         WHERE membership.member = pg_roles.oid
       ) AS has_parent_membership
     FROM pg_roles
     WHERE rolname = ANY($1::text[])`,
    [collectiveRoleNames],
  );
  if (result.rowCount !== collectiveRoleNames.length) {
    throw new Error("DATABASE_COLLECTIVE_ROLE_MISSING");
  }
  for (const role of result.rows) {
    if (
      role.rolcanlogin !== false ||
      role.rolsuper !== false ||
      role.rolcreatedb !== false ||
      role.rolcreaterole !== false ||
      role.rolinherit !== false ||
      role.rolreplication !== false ||
      role.rolbypassrls !== false ||
      role.has_parent_membership !== false
    ) {
      throw new Error("DATABASE_COLLECTIVE_ROLE_IS_PRIVILEGED");
    }
  }
}

async function verifyMaintenanceCapability(client) {
  const result = await client.query(
    `SELECT
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND CASE
             WHEN relation.relkind IN ('r', 'p', 'v', 'm', 'f') THEN
               has_table_privilege(
                 'refunddesk_maintenance',
                 relation.oid,
                 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
               )
             ELSE false
           END
       ) AS has_direct_table_access,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND CASE
             WHEN relation.relkind IN ('r', 'p', 'm') THEN
               has_table_privilege(
                 'refunddesk_maintenance',
                 relation.oid,
                 'MAINTAIN'
               )
             ELSE false
           END
       ) AS has_relation_maintain,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_namespace AS namespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND has_schema_privilege(
             'refunddesk_maintenance',
             namespace.oid,
             'CREATE'
           )
       ) AS has_schema_create,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS sequence
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = sequence.relnamespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND CASE
             WHEN sequence.relkind = 'S' THEN
               has_sequence_privilege(
                 'refunddesk_maintenance',
                 sequence.oid,
                 'USAGE,SELECT,UPDATE'
               )
             ELSE false
           END
       ) AS has_sequence_access,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS routine
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND routine.oid <> to_regprocedure(
             'public.refunddesk_purge_tenant(uuid,character varying)'
           )
           AND CASE
             WHEN routine.prokind IN ('f', 'a', 'w') THEN
               has_function_privilege(
                 'refunddesk_maintenance',
                 routine.oid,
                 'EXECUTE'
               )
             ELSE false
           END
       ) AS has_other_function_execute,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS routine
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = routine.pronamespace
         CROSS JOIN LATERAL aclexplode(
           COALESCE(routine.proacl, acldefault('f', routine.proowner))
         ) AS privilege
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND routine.prokind = 'p'
           AND privilege.privilege_type = 'EXECUTE'
           AND (
             privilege.grantee = 0
             OR privilege.grantee = 'refunddesk_maintenance'::regrole
           )
       ) AS has_other_procedure_execute,
       has_function_privilege(
         'refunddesk_maintenance',
         'public.refunddesk_purge_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS maintenance_can_purge,
       has_function_privilege(
         'refunddesk_runtime',
         'public.refunddesk_purge_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS web_can_purge,
       has_function_privilege(
         'refunddesk_worker',
         'public.refunddesk_purge_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS worker_can_purge`,
  );
  const capability = result.rows[0];
  if (
    capability?.has_direct_table_access !== false ||
    capability.has_relation_maintain !== false ||
    capability.has_schema_create !== false ||
    capability.has_sequence_access !== false ||
    capability.has_other_function_execute !== false ||
    capability.has_other_procedure_execute !== false ||
    capability.maintenance_can_purge !== true ||
    capability.web_can_purge !== false ||
    capability.worker_can_purge !== false
  ) {
    throw new Error("DATABASE_MAINTENANCE_CAPABILITY_CHECK_FAILED");
  }
}

async function verifyLogin(client, expectedPrincipal, expectedMembership) {
  const result = await client.query(
    `SELECT
       current_user,
       role.rolcanlogin,
       role.rolsuper,
       role.rolbypassrls,
       role.rolinherit,
       pg_has_role(current_user, $1, 'USAGE') AS expected_membership
     FROM pg_roles role
     WHERE role.rolname = current_user`,
    [expectedMembership],
  );
  const role = result.rows[0];
  if (
    role?.current_user !== expectedPrincipal ||
    role.rolcanlogin !== true ||
    role.rolsuper !== false ||
    role.rolbypassrls !== false ||
    role.rolinherit !== true ||
    role.expected_membership !== true
  ) {
    throw new Error("DATABASE_RUNTIME_IDENTITY_CHECK_FAILED");
  }
}

async function expectFailClosed(client) {
  const result = await client.query("SELECT count(*)::int AS count FROM tenants");
  if (result.rows[0]?.count !== 0) {
    throw new Error("DATABASE_RLS_DID_NOT_FAIL_CLOSED");
  }
}

async function verifyWebDataCapabilities(client) {
  const result = await client.query(
    `WITH worker_owned(relation_name) AS (
       VALUES
         ('refund_executions'::regclass),
         ('refund_execution_attempts'::regclass),
         ('refund_correlation_candidates'::regclass)
     )
     SELECT
       has_table_privilege(current_user, 'refund_requests', 'SELECT') AS request_read,
       has_table_privilege(current_user, 'refund_requests', 'INSERT') AS request_insert,
       has_table_privilege(current_user, 'refund_requests', 'UPDATE') AS request_update,
       has_table_privilege(current_user, 'approval_decisions', 'INSERT') AS decision_insert,
       has_table_privilege(current_user, 'refund_executions', 'SELECT') AS execution_read,
       has_table_privilege(current_user, 'refund_execution_attempts', 'SELECT') AS attempt_read,
       (
         has_table_privilege(current_user, 'refund_correlation_candidates', 'SELECT')
         OR has_any_column_privilege(
           current_user,
           'refund_correlation_candidates',
           'SELECT'
         )
       ) AS candidate_read,
       NOT EXISTS (
         SELECT 1
         FROM worker_owned
         WHERE has_table_privilege(current_user, relation_name, 'INSERT')
            OR has_any_column_privilege(current_user, relation_name, 'INSERT')
            OR has_table_privilege(current_user, relation_name, 'UPDATE')
            OR has_any_column_privilege(current_user, relation_name, 'UPDATE')
            OR has_table_privilege(current_user, relation_name, 'DELETE')
            OR has_table_privilege(current_user, relation_name, 'TRUNCATE')
       ) AS no_worker_owned_writes`,
  );
  const capabilities = result.rows[0];
  if (
    capabilities?.request_read !== true ||
    capabilities.request_insert !== true ||
    capabilities.request_update !== true ||
    capabilities.decision_insert !== true ||
    capabilities.execution_read !== true ||
    capabilities.attempt_read !== true ||
    capabilities.candidate_read !== false ||
    capabilities.no_worker_owned_writes !== true
  ) {
    throw new Error("DATABASE_WEB_DATA_CAPABILITY_CHECK_FAILED");
  }
}

async function verifyWorkerDataCapabilities(client) {
  const result = await client.query(
    `WITH worker_owned(relation_name) AS (
       VALUES
         ('refund_executions'::regclass),
         ('refund_execution_attempts'::regclass),
         ('refund_correlation_candidates'::regclass)
     )
     SELECT
       NOT EXISTS (
         SELECT 1
         FROM worker_owned
         WHERE NOT has_table_privilege(current_user, relation_name, 'SELECT')
            OR NOT has_table_privilege(current_user, relation_name, 'INSERT')
            OR NOT has_table_privilege(current_user, relation_name, 'UPDATE')
       ) AS worker_owned_read_write,
       has_table_privilege(current_user, 'refund_requests', 'UPDATE') AS request_update,
       (
         has_table_privilege(current_user, 'refund_requests', 'INSERT')
         OR has_any_column_privilege(current_user, 'refund_requests', 'INSERT')
       ) AS request_insert,
       (
         has_table_privilege(current_user, 'approval_decisions', 'INSERT')
         OR has_any_column_privilege(current_user, 'approval_decisions', 'INSERT')
       ) AS decision_insert`,
  );
  const capabilities = result.rows[0];
  if (
    capabilities?.worker_owned_read_write !== true ||
    capabilities.request_update !== true ||
    capabilities.request_insert !== false ||
    capabilities.decision_insert !== false
  ) {
    throw new Error("DATABASE_WORKER_DATA_CAPABILITY_CHECK_FAILED");
  }
}

async function checkWeb() {
  const client = new Client({
    connectionString: webUrl.toString(),
    application_name: "refunddesk-web-access-check",
  });
  try {
    await client.connect();
    await verifyCollectiveRoleAttributes(client);
    await verifyMaintenanceCapability(client);
    await verifyLogin(client, webPrincipal, "refunddesk_runtime");
    await expectFailClosed(client);
    await verifyWebDataCapabilities(client);
    const privileges = await client.query(
      `SELECT
         has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
         has_table_privilege(current_user, 'tenants', 'SELECT') AS tenant_read,
         has_schema_privilege(current_user, 'pgboss', 'USAGE') AS pgboss_usage,
         has_schema_privilege(current_user, 'public', 'CREATE') AS public_create`,
    );
    const value = privileges.rows[0];
    if (
      value?.public_usage !== true ||
      value.tenant_read !== true ||
      value.pgboss_usage !== false ||
      value.public_create !== false
    ) {
      throw new Error("DATABASE_WEB_PRIVILEGE_CHECK_FAILED");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkWorkerDataAccess() {
  const client = new Client({
    connectionString: workerUrl.toString(),
    application_name: "refunddesk-worker-data-access-check",
  });
  try {
    await client.connect();
    await verifyLogin(client, workerPrincipal, "refunddesk_worker");
    await expectFailClosed(client);
    await verifyWorkerDataCapabilities(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkQueueAccess() {
  const client = new Client({
    connectionString: queueUrl.toString(),
    application_name: "refunddesk-worker-queue-access-check",
  });
  const probeQueue = "__refunddesk_access_probe__";
  try {
    await client.connect();
    await verifyLogin(client, queuePrincipal, "refunddesk_worker");
    const privileges = await client.query(
      `SELECT
         has_schema_privilege(current_user, 'pgboss', 'USAGE') AS schema_usage,
         has_schema_privilege(current_user, 'pgboss', 'CREATE') AS schema_create,
         has_table_privilege(
           current_user,
           'pgboss.job',
           'SELECT,INSERT,UPDATE,DELETE'
         ) AS job_dml,
         has_function_privilege(
           current_user,
           'pgboss.create_queue(text,jsonb)',
           'EXECUTE'
         ) AS create_queue_execute`,
    );
    const value = privileges.rows[0];
    if (
      value?.schema_usage !== true ||
      value.schema_create !== false ||
      value.job_dml !== true ||
      value.create_queue_execute !== true
    ) {
      throw new Error("DATABASE_PGBOSS_PRIVILEGE_CHECK_FAILED");
    }

    await client.query("BEGIN");
    await client.query("SELECT pgboss.create_queue($1, $2::jsonb)", [
      probeQueue,
      JSON.stringify({
        policy: "standard",
        retryLimit: 1,
        retryDelay: 0,
        retryBackoff: false,
        expireInSeconds: 60,
        retentionSeconds: 60,
        deleteAfterSeconds: 60,
        partition: false,
      }),
    ]);
    await client.query("ROLLBACK");
    const residue = await client.query(
      "SELECT count(*)::int AS count FROM pgboss.queue WHERE name = $1",
      [probeQueue],
    );
    if (residue.rows[0]?.count !== 0) {
      throw new Error("DATABASE_PGBOSS_ACCESS_PROBE_LEFT_RESIDUE");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

try {
  await checkWeb();
  await checkWorkerDataAccess();
  await checkQueueAccess();
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      web_principal: webPrincipal,
      worker_principal: workerPrincipal,
      queue_principal: queuePrincipal,
    })}\n`,
  );
} catch (error) {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.message
        : "DATABASE_ACCESS_CHECK_FAILED";
  process.stderr.write(`${JSON.stringify({ component: "database-access-check", code })}\n`);
  process.exitCode = 1;
}
