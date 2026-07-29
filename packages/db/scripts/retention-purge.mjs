import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

const MAXIMUM_BATCH_SIZE = 100;
const DEFAULT_BATCH_SIZE = 25;
const MAXIMUM_BATCHES_PER_RUN = 20;
const RETENTION_LOCK_NAME = "refunddesk:retention-purge:test-sandbox:v1";
const MAINTENANCE_DATABASE_PRINCIPAL = "refunddesk_maintenance_login";
const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z0-9_]{3,64}$/u;
const RETENTION_BLOCKER_REASONS = new Set([
  "checkpoint_state",
  "correlation_state",
  "deadline_invalid",
  "execution_attempt",
  "financial_state",
  "installation_missing",
  "installation_state",
  "legal_hold",
  "webhook_state",
]);
const ALLOWED_REFUNDDESK_VARIABLES = new Set([
  "REFUNDDESK_MAINTENANCE_DATABASE_URL",
  "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1",
  "REFUNDDESK_RETENTION_BATCH_SIZE",
  "REFUNDDESK_RETENTION_SCOPE",
]);
const FORBIDDEN_DATABASE_VARIABLES = new Set([
  "DATABASE_MIGRATION_URL",
  "DATABASE_URL",
  "PGBOSS_DATABASE_URL",
  "WORKER_DATABASE_URL",
]);
const FORBIDDEN_POSTGRES_QUERY_PARAMETERS = new Set([
  "database",
  "dbname",
  "host",
  "hostaddr",
  "options",
  "passfile",
  "password",
  "port",
  "role",
  "service",
  "servicefile",
  "session_authorization",
  "user",
]);
const FORBIDDEN_POSTGRES_PROCESS_VARIABLES = new Set([
  "PGCLIENTENCODING",
  "PGCONNECT_TIMEOUT",
  "PGDATABASE",
  "PGHOST",
  "PGHOSTADDR",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGPASSWORD",
  "PGPORT",
  "PGREPLICATION",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
  "PGSSLROOTCERT",
  "PGUSER",
]);

function requiredValue(source, name) {
  const value = source[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

function parseDatabaseUrl(value, nodeEnvironment) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REFUNDDESK_MAINTENANCE_DATABASE_URL_INVALID");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.hostname.length === 0 ||
    url.pathname.length <= 1 ||
    url.hash.length > 0 ||
    [...url.searchParams.keys()].some((name) =>
      FORBIDDEN_POSTGRES_QUERY_PARAMETERS.has(name.toLowerCase()),
    )
  ) {
    throw new Error("REFUNDDESK_MAINTENANCE_DATABASE_URL_INVALID");
  }

  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const sslModes = url.searchParams.getAll("sslmode");
  if (
    nodeEnvironment === "production" &&
    !loopback &&
    (sslModes.length !== 1 || sslModes[0] !== "verify-full")
  ) {
    throw new Error("REFUNDDESK_MAINTENANCE_DATABASE_TLS_INVALID");
  }

  let principal;
  try {
    principal = decodeURIComponent(url.username);
  } catch {
    throw new Error("REFUNDDESK_MAINTENANCE_DATABASE_URL_INVALID");
  }
  if (principal.length === 0) {
    throw new Error("REFUNDDESK_MAINTENANCE_DATABASE_URL_INVALID");
  }
  let password;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error("REFUNDDESK_MAINTENANCE_DATABASE_URL_INVALID");
  }
  if (
    principal !== MAINTENANCE_DATABASE_PRINCIPAL ||
    password.length === 0 ||
    (nodeEnvironment === "production" && password.length < 32)
  ) {
    throw new Error("REFUNDDESK_MAINTENANCE_DATABASE_URL_INVALID");
  }
  return { connectionString: url.toString(), principal };
}

function parsePseudonymKey(value) {
  let key;
  try {
    key = Buffer.from(value, "base64");
  } catch {
    throw new Error("REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1_INVALID");
  }
  if (key.byteLength !== 32 || key.toString("base64") !== value) {
    key.fill(0);
    throw new Error("REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1_INVALID");
  }
  return key;
}

function parseBatchSize(value) {
  if (value === undefined) {
    return DEFAULT_BATCH_SIZE;
  }
  if (!/^[1-9][0-9]{0,2}$/u.test(value)) {
    throw new Error("REFUNDDESK_RETENTION_BATCH_SIZE_INVALID");
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed > MAXIMUM_BATCH_SIZE) {
    throw new Error("REFUNDDESK_RETENTION_BATCH_SIZE_INVALID");
  }
  return parsed;
}

function assertIsolatedEnvironment(source) {
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (
      FORBIDDEN_DATABASE_VARIABLES.has(name) ||
      FORBIDDEN_POSTGRES_PROCESS_VARIABLES.has(name) ||
      name.startsWith("STRIPE_") ||
      (name.startsWith("REFUNDDESK_") && !ALLOWED_REFUNDDESK_VARIABLES.has(name))
    ) {
      throw new Error("RETENTION_FOREIGN_AUTHORITY_FORBIDDEN");
    }
  }
}

export function loadRetentionPurgeConfig(source = process.env) {
  assertIsolatedEnvironment(source);
  const nodeEnvironment = requiredValue(source, "NODE_ENV");
  if (nodeEnvironment !== "production" && nodeEnvironment !== "test") {
    throw new Error("RETENTION_NODE_ENV_INVALID");
  }
  if (requiredValue(source, "REFUNDDESK_RETENTION_SCOPE") !== "test_sandbox") {
    throw new Error("REFUNDDESK_RETENTION_SCOPE_INVALID");
  }

  const database = parseDatabaseUrl(
    requiredValue(source, "REFUNDDESK_MAINTENANCE_DATABASE_URL"),
    nodeEnvironment,
  );
  const batchSize = parseBatchSize(source["REFUNDDESK_RETENTION_BATCH_SIZE"]);
  const pseudonymKey = parsePseudonymKey(
    requiredValue(source, "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1"),
  );

  return {
    batchSize,
    databaseUrl: database.connectionString,
    databasePrincipal: database.principal,
    pseudonymKey,
  };
}

export function tenantPurgePseudonym(tenantId, pseudonymKey) {
  if (
    !TENANT_ID_PATTERN.test(tenantId) ||
    !Buffer.isBuffer(pseudonymKey) ||
    pseudonymKey.byteLength !== 32
  ) {
    throw new Error("RETENTION_PURGE_CANDIDATE_INVALID");
  }
  return `v1.${createHmac("sha256", pseudonymKey)
    .update("refunddesk:tenant-purge:v1\u0000", "utf8")
    .update(tenantId, "ascii")
    .digest("base64url")}`;
}

export function assertMaintenanceIdentity(identity, expectedPrincipal) {
  if (
    identity?.current_user !== expectedPrincipal ||
    identity.session_user !== expectedPrincipal ||
    identity.rolcanlogin !== true ||
    identity.rolsuper !== false ||
    identity.rolcreatedb !== false ||
    identity.rolcreaterole !== false ||
    identity.rolinherit !== true ||
    identity.rolreplication !== false ||
    identity.rolbypassrls !== false ||
    identity.replication_role_is_origin !== true ||
    identity.can_set_replication_role !== false ||
    identity.can_alter_system_replication_role !== false ||
    identity.admin_option_absent !== true ||
    !Array.isArray(identity.parent_roles) ||
    identity.parent_roles.length !== 1 ||
    identity.parent_roles[0] !== "refunddesk_maintenance"
  ) {
    throw new Error("RETENTION_DATABASE_IDENTITY_INVALID");
  }
}

export function assertMaintenanceCapabilities(capability) {
  if (
    capability?.has_schema_usage !== true ||
    capability.has_schema_create !== false ||
    capability.has_pgboss_schema_usage !== false ||
    capability.has_pgboss_schema_create !== false ||
    capability.has_direct_table_access !== false ||
    capability.has_relation_maintain !== false ||
    capability.has_sequence_access !== false ||
    capability.has_other_function_execute !== false ||
    capability.has_procedure_execute !== false ||
    capability.can_list_due_purges !== true ||
    capability.can_guarded_purge !== true ||
    capability.can_raw_purge !== false
  ) {
    throw new Error("RETENTION_DATABASE_CAPABILITY_INVALID");
  }
}

export async function verifyMaintenanceAuthority(client, expectedPrincipal) {
  const identityResult = await client.query(
    `WITH RECURSIVE parent_membership(roleid) AS (
       SELECT membership.roleid
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.member = (
         SELECT oid
         FROM pg_catalog.pg_roles
         WHERE rolname = current_user
       )
       UNION
       SELECT membership.roleid
       FROM pg_catalog.pg_auth_members AS membership
       INNER JOIN parent_membership
         ON parent_membership.roleid = membership.member
     )
     SELECT
       current_user,
       session_user,
       role.rolcanlogin,
       role.rolsuper,
       role.rolcreatedb,
       role.rolcreaterole,
       role.rolinherit,
       role.rolreplication,
       role.rolbypassrls,
       current_setting('session_replication_role') = 'origin'
         AS replication_role_is_origin,
       has_parameter_privilege(
         current_user,
         'session_replication_role',
         'SET'
       ) AS can_set_replication_role,
       has_parameter_privilege(
         current_user,
         'session_replication_role',
         'ALTER SYSTEM'
       ) AS can_alter_system_replication_role,
       NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.member = role.oid
           AND membership.admin_option
       ) AS admin_option_absent,
       ARRAY(
         SELECT parent.rolname::text
         FROM parent_membership
         INNER JOIN pg_catalog.pg_roles AS parent
           ON parent.oid = parent_membership.roleid
         ORDER BY parent.rolname
       ) AS parent_roles
     FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = current_user`,
  );
  if (identityResult.rows.length !== 1) {
    throw new Error("RETENTION_DATABASE_IDENTITY_INVALID");
  }
  assertMaintenanceIdentity(identityResult.rows[0], expectedPrincipal);

  const capabilityResult = await client.query(
    `SELECT
       has_schema_privilege(current_user, 'public', 'USAGE')
         AS has_schema_usage,
       has_schema_privilege(current_user, 'public', 'CREATE')
         AS has_schema_create,
       has_schema_privilege(current_user, 'pgboss', 'USAGE')
         AS has_pgboss_schema_usage,
       has_schema_privilege(current_user, 'pgboss', 'CREATE')
         AS has_pgboss_schema_create,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND (
             has_table_privilege(
               current_user,
               relation.oid,
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
             )
             OR has_any_column_privilege(
               current_user,
               relation.oid,
               'SELECT,INSERT,UPDATE,REFERENCES'
             )
           )
       ) AS has_direct_table_access,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND relation.relkind IN ('r', 'p', 'm')
           AND has_table_privilege(current_user, relation.oid, 'MAINTAIN')
       ) AS has_relation_maintain,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS sequence
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = sequence.relnamespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND sequence.relkind = 'S'
           AND has_sequence_privilege(
             current_user,
             sequence.oid,
             'USAGE,SELECT,UPDATE'
           )
       ) AS has_sequence_access,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS routine
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND routine.prokind IN ('f', 'a', 'w')
           AND routine.oid NOT IN (
             to_regprocedure(
               'public.refunddesk_list_due_tenant_purges(integer)'
             ),
             to_regprocedure(
               'public.refunddesk_purge_test_sandbox_tenant(uuid,character varying)'
             )
           )
           AND has_function_privilege(current_user, routine.oid, 'EXECUTE')
       ) AS has_other_function_execute,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS routine
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND routine.prokind = 'p'
           AND has_function_privilege(current_user, routine.oid, 'EXECUTE')
       ) AS has_procedure_execute,
       has_function_privilege(
         current_user,
         'public.refunddesk_list_due_tenant_purges(integer)',
         'EXECUTE'
       ) AS can_list_due_purges,
       has_function_privilege(
         current_user,
         'public.refunddesk_purge_test_sandbox_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS can_guarded_purge,
       has_function_privilege(
         current_user,
         'public.refunddesk_purge_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS can_raw_purge`,
  );
  if (capabilityResult.rows.length !== 1) {
    throw new Error("RETENTION_DATABASE_CAPABILITY_INVALID");
  }
  assertMaintenanceCapabilities(capabilityResult.rows[0]);
}

function databaseErrorCode(error) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export async function runRetentionPurge(client, config) {
  await verifyMaintenanceAuthority(client, config.databasePrincipal);

  let lockAcquired = false;
  try {
    const lock = await client.query(
      `SELECT pg_try_advisory_lock(
         hashtextextended($1::text, 0)
       ) AS acquired`,
      [RETENTION_LOCK_NAME],
    );
    if (lock.rows[0]?.acquired !== true) {
      throw new Error("RETENTION_PURGE_ALREADY_RUNNING");
    }
    lockAcquired = true;

    let batches = 0;
    let oldestOverdueSeconds = 0;
    let purged = 0;
    let selected = 0;
    let blockedAfterSelection = 0;
    const blockedByReason = {};
    let drained = false;
    for (let batchNumber = 1; batchNumber <= MAXIMUM_BATCHES_PER_RUN; batchNumber += 1) {
      const candidates = await client.query(
        `SELECT
           tenant_id::text,
           blocker_reason::text,
           overdue_seconds::bigint
         FROM public.refunddesk_list_due_tenant_purges($1::integer)`,
        [config.batchSize],
      );
      batches = batchNumber;
      selected += candidates.rows.length;
      if (candidates.rows.length === 0) {
        drained = true;
        break;
      }

      const seen = new Set();
      let batchBlocked = 0;
      for (const candidate of candidates.rows) {
        const tenantId = candidate.tenant_id;
        const blockerReason = candidate.blocker_reason;
        const overdueSeconds = Number(candidate.overdue_seconds);
        if (
          typeof tenantId !== "string" ||
          seen.has(tenantId) ||
          !TENANT_ID_PATTERN.test(tenantId) ||
          (blockerReason !== null &&
            (typeof blockerReason !== "string" || !RETENTION_BLOCKER_REASONS.has(blockerReason))) ||
          !Number.isSafeInteger(overdueSeconds) ||
          overdueSeconds < 0
        ) {
          throw new Error("RETENTION_PURGE_CANDIDATE_INVALID");
        }
        seen.add(tenantId);
        oldestOverdueSeconds = Math.max(oldestOverdueSeconds, overdueSeconds);
        if (blockerReason !== null) {
          blockedAfterSelection += 1;
          batchBlocked += 1;
          blockedByReason[blockerReason] = (blockedByReason[blockerReason] ?? 0) + 1;
          continue;
        }
        const pseudonym = tenantPurgePseudonym(tenantId, config.pseudonymKey);
        try {
          const result = await client.query(
            `SELECT result
             FROM public.refunddesk_purge_test_sandbox_tenant(
               $1::uuid,
               $2::varchar
             )`,
            [tenantId, pseudonym],
          );
          if (result.rows.length !== 1 || result.rows[0]?.result !== "completed") {
            throw new Error("RETENTION_PURGE_RESULT_INVALID");
          }
          purged += 1;
        } catch (error) {
          if (databaseErrorCode(error) === "55000") {
            blockedAfterSelection += 1;
            batchBlocked += 1;
            blockedByReason.revalidation = (blockedByReason.revalidation ?? 0) + 1;
            continue;
          }
          throw error;
        }
      }
      if (candidates.rows.length < config.batchSize || batchBlocked > 0) {
        drained = true;
        break;
      }
    }
    if (!drained) {
      throw new Error("RETENTION_PURGE_DRAIN_LIMIT_REACHED");
    }

    return {
      batches,
      blockedByReason,
      blockedAfterSelection,
      oldestOverdueSeconds,
      purged,
      selected,
    };
  } finally {
    if (lockAcquired) {
      await client
        .query(
          `SELECT pg_advisory_unlock(
             hashtextextended($1::text, 0)
           )`,
          [RETENTION_LOCK_NAME],
        )
        .catch(() => undefined);
    }
  }
}

export function safeRetentionErrorCode(error) {
  const code = databaseErrorCode(error);
  if (code !== undefined && SAFE_ERROR_CODE_PATTERN.test(code)) {
    return code;
  }
  if (error instanceof Error && SAFE_ERROR_CODE_PATTERN.test(error.message)) {
    return error.message;
  }
  return "RETENTION_PURGE_FAILED";
}
