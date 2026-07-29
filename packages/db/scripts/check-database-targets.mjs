import { Client } from "pg";

import {
  assertRuntimePrincipalsAreSeparated,
  databasePrincipal,
  loadLocalEnvironment,
  requirePostgresUrl,
} from "../../../scripts/local-environment.mjs";
import { classifyPreflightCollectiveRoleSet } from "./runtime-membership.mjs";

loadLocalEnvironment();
assertRuntimePrincipalsAreSeparated();

const mode = process.argv[2];
if (mode !== "preflight" && mode !== "postflight") {
  throw new Error("DATABASE_TARGET_CHECK_MODE_REQUIRED");
}

const urls = {
  owner: requirePostgresUrl("DATABASE_MIGRATION_URL"),
  web: requirePostgresUrl("DATABASE_URL"),
  worker: requirePostgresUrl("WORKER_DATABASE_URL"),
  queue: requirePostgresUrl("PGBOSS_DATABASE_URL"),
};
const maintenancePrincipal = "refunddesk_maintenance_login";
if (Object.values(urls).some((url) => databasePrincipal(url) === maintenancePrincipal)) {
  throw new Error("DATABASE_RUNTIME_PRINCIPALS_MUST_BE_DISTINCT");
}

function createClient(url, applicationName) {
  return new Client({
    connectionString: url.toString(),
    application_name: applicationName,
    connectionTimeoutMillis: 5_000,
    options: "-c search_path=pg_catalog,public",
    query_timeout: 5_000,
    statement_timeout: 4_000,
  });
}

function assertBaseIdentity(row, expectedPrincipal) {
  if (
    row === undefined ||
    row.current_user !== expectedPrincipal ||
    row.database_owner !== databasePrincipal(urls.owner) ||
    typeof row.database_name !== "string" ||
    typeof row.system_identifier !== "string" ||
    row.postgres_supported !== true ||
    row.database_writable !== true
  ) {
    throw new Error("DATABASE_TARGET_BASE_IDENTITY_INVALID");
  }
  return {
    databaseName: row.database_name,
    systemIdentifier: row.system_identifier,
  };
}

function assertApplicationIdentity(row) {
  if (
    row === undefined ||
    typeof row.identity_id !== "string" ||
    typeof row.release_nonce !== "string" ||
    row.schema_contract_version !== 1
  ) {
    throw new Error("DATABASE_TARGET_APPLICATION_IDENTITY_INVALID");
  }
  return {
    identityId: row.identity_id,
    releaseNonce: row.release_nonce,
  };
}

async function readBaseIdentity(client, expectedPrincipal) {
  const result = await client.query(
    `SELECT current_user,
            current_database() AS database_name,
            owner.rolname AS database_owner,
            control.system_identifier::text AS system_identifier,
            current_setting('server_version_num')::integer >= 180000
              AND current_setting('server_version_num')::integer < 190000
              AS postgres_supported,
            current_setting('transaction_read_only') = 'off'
              AND NOT pg_is_in_recovery() AS database_writable
       FROM pg_control_system() AS control
       INNER JOIN pg_database AS database
         ON database.datname = current_database()
       INNER JOIN pg_roles AS owner ON owner.oid = database.datdba`,
  );
  if (result.rowCount !== 1) {
    throw new Error("DATABASE_TARGET_BASE_IDENTITY_MISSING");
  }
  return assertBaseIdentity(result.rows[0], expectedPrincipal);
}

async function verifyRuntimeSessionSafety(client) {
  const result = await client.query(
    `SELECT
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
       ) AS can_alter_system_replication_role`,
  );
  const safety = result.rows[0];
  if (
    safety?.replication_role_is_origin !== true ||
    safety.can_set_replication_role !== false ||
    safety.can_alter_system_replication_role !== false
  ) {
    throw new Error("DATABASE_RUNTIME_SESSION_REPLICATION_UNSAFE");
  }
}

async function readApplicationIdentity(client) {
  const relation = await client.query(
    "SELECT to_regclass('public.refunddesk_database_identity') IS NOT NULL AS present",
  );
  if (relation.rows[0]?.present !== true) {
    return null;
  }
  const result = await client.query(
    `SELECT identity_id::text,
            release_nonce::text,
            schema_contract_version
       FROM public.refunddesk_database_identity
      WHERE singleton`,
  );
  if (result.rowCount !== 1) {
    throw new Error("DATABASE_TARGET_APPLICATION_IDENTITY_MISSING");
  }
  return assertApplicationIdentity(result.rows[0]);
}

async function readPreflightIdentity(kind, url) {
  const client = createClient(url, `refunddesk-database-target-${kind}-preflight`);
  try {
    await client.connect();
    if (kind !== "owner") {
      await verifyRuntimeSessionSafety(client);
    }
    let application = null;
    try {
      application = await readApplicationIdentity(client);
    } catch (error) {
      const permissionDenied =
        typeof error === "object" && error !== null && "code" in error && error.code === "42501";
      if (kind === "owner" || !permissionDenied) {
        throw error;
      }
    }
    return {
      base: await readBaseIdentity(client, databasePrincipal(url)),
      application,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function sameBaseIdentity(left, right) {
  return (
    left.databaseName === right.databaseName && left.systemIdentifier === right.systemIdentifier
  );
}

function sameApplicationIdentity(left, right) {
  return left.identityId === right.identityId && left.releaseNonce === right.releaseNonce;
}

async function verifyPreflightRuntimeRoles() {
  const webPrincipal = databasePrincipal(urls.web);
  const workerPrincipal = databasePrincipal(urls.worker);
  const queuePrincipal = databasePrincipal(urls.queue);
  const collectiveRoleNames = [
    "refunddesk_attestation_writer",
    "refunddesk_maintenance",
    "refunddesk_queue",
    "refunddesk_runtime",
    "refunddesk_worker",
  ];
  const client = createClient(urls.owner, "refunddesk-database-runtime-role-preflight");
  try {
    await client.connect();
    const collectiveRoleResult = await client.query(
      `SELECT rolname
         FROM pg_roles
        WHERE rolname = ANY($1::text[])
        ORDER BY rolname`,
      [collectiveRoleNames],
    );
    const collectiveRoleSet = classifyPreflightCollectiveRoleSet(
      collectiveRoleResult.rows.map((role) => role.rolname),
    );
    const queueMembership =
      collectiveRoleSet === "current" ? "refunddesk_queue" : "refunddesk_worker";
    const applicationCapabilitiesPresent =
      collectiveRoleSet !== "absent" && collectiveRoleSet !== "maintenance-bootstrap";
    const expectedMembershipByPrincipal = new Map([
      [webPrincipal, "refunddesk_runtime"],
      [workerPrincipal, "refunddesk_worker"],
      [queuePrincipal, queueMembership],
    ]);
    if (collectiveRoleSet !== "absent") {
      expectedMembershipByPrincipal.set(maintenancePrincipal, "refunddesk_maintenance");
    }
    const expectedParentsByPrincipal = new Map([
      [webPrincipal, applicationCapabilitiesPresent ? ["refunddesk_runtime"] : []],
      [
        workerPrincipal,
        !applicationCapabilitiesPresent
          ? []
          : collectiveRoleSet === "legacy"
            ? ["refunddesk_worker"]
            : ["refunddesk_attestation_writer", "refunddesk_worker"],
      ],
      [
        queuePrincipal,
        !applicationCapabilitiesPresent
          ? []
          : collectiveRoleSet === "current"
            ? ["refunddesk_queue"]
            : ["refunddesk_worker"],
      ],
    ]);
    if (collectiveRoleSet !== "absent") {
      expectedParentsByPrincipal.set(maintenancePrincipal, ["refunddesk_maintenance"]);
    }
    const principals = [...expectedMembershipByPrincipal.keys()];
    const expectedMemberships = principals.map((principal) =>
      expectedMembershipByPrincipal.get(principal),
    );
    const result = await client.query(
      `WITH RECURSIVE expected(role_name, expected_membership) AS (
         SELECT * FROM unnest($1::text[], $2::text[])
       ),
       login_role AS (
         SELECT expected.expected_membership, role.*
         FROM expected
         INNER JOIN pg_roles AS role ON role.rolname = expected.role_name
       ),
       parent_membership(login_oid, roleid) AS (
         SELECT login_role.oid, membership.roleid
         FROM login_role
         INNER JOIN pg_auth_members AS membership
           ON membership.member = login_role.oid
         UNION
         SELECT parent_membership.login_oid, membership.roleid
         FROM parent_membership
         INNER JOIN pg_auth_members AS membership
           ON membership.member = parent_membership.roleid
       )
       SELECT
         login_role.rolname,
         login_role.expected_membership,
         login_role.rolcanlogin,
         login_role.rolsuper,
         login_role.rolcreatedb,
         login_role.rolcreaterole,
         login_role.rolinherit,
         login_role.rolreplication,
         login_role.rolbypassrls,
         EXISTS (
           SELECT 1
           FROM pg_auth_members AS direct_membership
           INNER JOIN pg_roles AS expected_role
             ON expected_role.oid = direct_membership.roleid
           WHERE direct_membership.member = login_role.oid
             AND expected_role.rolname = login_role.expected_membership
             AND direct_membership.admin_option
         ) AS expected_admin_option,
         EXISTS (
           SELECT 1
           FROM pg_auth_members AS direct_membership
           INNER JOIN pg_roles AS expected_role
             ON expected_role.oid = direct_membership.roleid
           WHERE direct_membership.member = login_role.oid
             AND expected_role.rolname = login_role.expected_membership
             AND NOT direct_membership.inherit_option
         ) AS expected_inherit_disabled,
         ARRAY(
           SELECT parent.rolname::text
           FROM parent_membership
           INNER JOIN pg_roles AS parent ON parent.oid = parent_membership.roleid
           WHERE parent_membership.login_oid = login_role.oid
           ORDER BY parent.rolname
         ) AS parent_roles
       FROM login_role
       ORDER BY login_role.rolname`,
      [principals, expectedMemberships],
    );
    if (result.rowCount !== principals.length) {
      throw new Error("DATABASE_RUNTIME_LOGIN_ROLE_MISSING");
    }
    for (const role of result.rows) {
      const expectedParents = expectedParentsByPrincipal.get(role.rolname);
      if (
        expectedParents === undefined ||
        role.rolcanlogin !== true ||
        role.rolsuper !== false ||
        role.rolcreatedb !== false ||
        role.rolcreaterole !== false ||
        role.rolinherit !== true ||
        role.rolreplication !== false ||
        role.rolbypassrls !== false ||
        role.expected_admin_option !== false ||
        role.expected_inherit_disabled !== false ||
        !Array.isArray(role.parent_roles) ||
        role.parent_roles.length !== expectedParents.length ||
        role.parent_roles.some((parentRole, index) => parentRole !== expectedParents[index])
      ) {
        throw new Error("DATABASE_RUNTIME_LOGIN_ROLE_IS_PRIVILEGED");
      }
    }
    const loginMembers = await client.query(
      `SELECT parent.rolname AS parent_role, member.rolname AS member_role
         FROM pg_auth_members AS membership
         INNER JOIN pg_roles AS parent ON parent.oid = membership.roleid
         INNER JOIN pg_roles AS member ON member.oid = membership.member
        WHERE parent.rolname = ANY($1::text[])
        ORDER BY parent.rolname, member.rolname`,
      [principals],
    );
    if (loginMembers.rowCount !== 0) {
      throw new Error("DATABASE_RUNTIME_LOGIN_HAS_MEMBERS");
    }
    if (collectiveRoleSet !== "absent") {
      const collectiveMembers = await client.query(
        `SELECT
           parent.rolname AS collective_role,
           member.rolname AS member_role,
           membership.admin_option
         FROM pg_auth_members AS membership
         INNER JOIN pg_roles AS parent ON parent.oid = membership.roleid
         INNER JOIN pg_roles AS member ON member.oid = membership.member
         WHERE parent.rolname = ANY($1::text[])
         ORDER BY parent.rolname, member.rolname`,
        [collectiveRoleNames],
      );
      const expectedMembers = new Map([
        ["refunddesk_maintenance", new Set([maintenancePrincipal])],
      ]);
      if (collectiveRoleSet !== "maintenance-bootstrap") {
        expectedMembers.set("refunddesk_runtime", new Set([webPrincipal]));
        expectedMembers.set("refunddesk_worker", new Set([workerPrincipal, queuePrincipal]));
      }
      if (collectiveRoleSet !== "maintenance-bootstrap" && collectiveRoleSet !== "legacy") {
        expectedMembers.set("refunddesk_attestation_writer", new Set([workerPrincipal]));
      }
      if (collectiveRoleSet === "current") {
        expectedMembers.set("refunddesk_worker", new Set([workerPrincipal]));
        expectedMembers.set("refunddesk_queue", new Set([queuePrincipal]));
      }
      for (const membership of collectiveMembers.rows) {
        const members = expectedMembers.get(membership.collective_role);
        if (
          members === undefined ||
          !members.delete(membership.member_role) ||
          membership.admin_option !== false
        ) {
          throw new Error("DATABASE_COLLECTIVE_ROLE_MEMBERSHIP_INVALID");
        }
      }
      if ([...expectedMembers.values()].some((members) => members.size !== 0)) {
        throw new Error("DATABASE_COLLECTIVE_ROLE_MEMBERSHIP_INVALID");
      }
    }
    const ownership = await client.query(
      `WITH runtime_role AS (
         SELECT oid
         FROM pg_roles
         WHERE rolname = ANY($1::text[])
       )
       SELECT
         EXISTS (
           SELECT 1
           FROM pg_database
           WHERE datname = current_database()
             AND datdba IN (SELECT oid FROM runtime_role)
         )
         OR EXISTS (
           SELECT 1
           FROM pg_namespace
           WHERE nspowner IN (SELECT oid FROM runtime_role)
             AND nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
             AND nspname !~ '^pg_(?:temp|toast_temp)_'
         )
         OR EXISTS (
           SELECT 1
           FROM pg_class
           INNER JOIN pg_namespace
             ON pg_namespace.oid = pg_class.relnamespace
           WHERE pg_class.relowner IN (SELECT oid FROM runtime_role)
             AND pg_namespace.nspname NOT IN (
               'pg_catalog',
               'information_schema',
               'pg_toast'
             )
             AND pg_namespace.nspname !~ '^pg_(?:temp|toast_temp)_'
         )
         OR EXISTS (
           SELECT 1
           FROM pg_proc
           INNER JOIN pg_namespace
             ON pg_namespace.oid = pg_proc.pronamespace
           WHERE pg_proc.proowner IN (SELECT oid FROM runtime_role)
             AND pg_namespace.nspname NOT IN (
               'pg_catalog',
               'information_schema',
               'pg_toast'
             )
             AND pg_namespace.nspname !~ '^pg_(?:temp|toast_temp)_'
         )
         OR EXISTS (
           SELECT 1
           FROM pg_type
           INNER JOIN pg_namespace
             ON pg_namespace.oid = pg_type.typnamespace
           WHERE pg_type.typowner IN (SELECT oid FROM runtime_role)
             AND pg_namespace.nspname NOT IN (
               'pg_catalog',
               'information_schema',
               'pg_toast'
             )
             AND pg_namespace.nspname !~ '^pg_(?:temp|toast_temp)_'
         )
         OR EXISTS (
           SELECT 1
           FROM pg_extension
           WHERE extowner IN (SELECT oid FROM runtime_role)
         ) AS owns_database_objects`,
      [principals],
    );
    if (ownership.rows[0]?.owns_database_objects !== false) {
      throw new Error("DATABASE_RUNTIME_LOGIN_OWNS_OBJECTS");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runPreflight() {
  const entries = await Promise.all(
    Object.entries(urls).map(async ([kind, url]) => ({
      kind,
      identity: await readPreflightIdentity(kind, url),
    })),
  );
  const owner = entries.find((entry) => entry.kind === "owner")?.identity;
  if (
    owner === undefined ||
    !entries.every((entry) => sameBaseIdentity(entry.identity.base, owner.base))
  ) {
    throw new Error("DATABASE_TARGETS_DIVERGED");
  }

  const ownerApplication = owner.application;
  const runtimeApplications = entries
    .filter((entry) => entry.kind !== "owner")
    .map((entry) => entry.identity.application);
  if (
    (ownerApplication === null && runtimeApplications.some((identity) => identity !== null)) ||
    (ownerApplication !== null &&
      runtimeApplications.some(
        (identity) => identity !== null && !sameApplicationIdentity(identity, ownerApplication),
      ))
  ) {
    throw new Error("DATABASE_APPLICATION_IDENTITIES_DIVERGED");
  }
  await verifyPreflightRuntimeRoles();
}

async function rotateOwnerReleaseNonce() {
  const client = createClient(urls.owner, "refunddesk-database-target-owner-postflight");
  try {
    await client.connect();
    await client.query("BEGIN");
    const base = await readBaseIdentity(client, databasePrincipal(urls.owner));
    const result = await client.query(
      `UPDATE public.refunddesk_database_identity
          SET release_nonce = gen_random_uuid(),
              updated_at = clock_timestamp()
        WHERE singleton
          AND schema_contract_version = 1
      RETURNING identity_id::text,
                release_nonce::text,
                schema_contract_version`,
    );
    if (result.rowCount !== 1) {
      throw new Error("DATABASE_TARGET_APPLICATION_IDENTITY_MISSING");
    }
    const application = assertApplicationIdentity(result.rows[0]);
    await client.query("COMMIT");
    return { base, application };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function readPostflightRuntimeIdentity(kind, url) {
  const client = createClient(url, `refunddesk-database-target-${kind}-postflight`);
  try {
    await client.connect();
    await verifyRuntimeSessionSafety(client);
    return {
      base: await readBaseIdentity(client, databasePrincipal(url)),
      application: await readApplicationIdentity(client),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function readPostflightQueueBaseIdentity() {
  const client = createClient(urls.queue, "refunddesk-database-target-queue-postflight");
  try {
    await client.connect();
    await verifyRuntimeSessionSafety(client);
    const base = await readBaseIdentity(client, databasePrincipal(urls.queue));
    return base;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runPostflight() {
  const owner = await rotateOwnerReleaseNonce();
  const [runtimes, queueBase] = await Promise.all([
    Promise.all([
      readPostflightRuntimeIdentity("web", urls.web),
      readPostflightRuntimeIdentity("worker", urls.worker),
    ]),
    readPostflightQueueBaseIdentity(),
  ]);
  if (
    !runtimes.every(
      (runtime) =>
        runtime.application !== null &&
        sameBaseIdentity(runtime.base, owner.base) &&
        sameApplicationIdentity(runtime.application, owner.application),
    ) ||
    !sameBaseIdentity(queueBase, owner.base)
  ) {
    throw new Error("DATABASE_TARGETS_DIVERGED");
  }
}

try {
  if (mode === "preflight") {
    await runPreflight();
  } else {
    await runPostflight();
  }
  process.stdout.write(
    `${JSON.stringify({ component: "database-targets", status: "identical", phase: mode })}\n`,
  );
} catch (error) {
  const knownCode =
    error instanceof Error && error.message.startsWith("DATABASE_")
      ? error.message
      : "DATABASE_TARGET_CHECK_FAILED";
  process.stderr.write(
    `${JSON.stringify({ component: "database-targets", code: knownCode, phase: mode })}\n`,
  );
  process.exitCode = 1;
}
