import { Client } from "pg";

import {
  assertRuntimePrincipalsAreSeparated,
  databasePrincipal,
  loadLocalEnvironment,
  requirePostgresUrl,
} from "../../../scripts/local-environment.mjs";
import { assertExecutableApprovalAttestationCoverage } from "./approval-attestation-checkpoint.ts";
import { assertExactRuntimeMembership } from "./runtime-membership.mjs";

loadLocalEnvironment();
assertRuntimePrincipalsAreSeparated();

const webUrl = requirePostgresUrl("DATABASE_URL");
const workerUrl = requirePostgresUrl("WORKER_DATABASE_URL");
const queueUrl = requirePostgresUrl("PGBOSS_DATABASE_URL");
const migrationUrl = requirePostgresUrl("DATABASE_MIGRATION_URL");
const webPrincipal = databasePrincipal(webUrl);
const workerPrincipal = databasePrincipal(workerUrl);
const queuePrincipal = databasePrincipal(queueUrl);
const migrationPrincipal = databasePrincipal(migrationUrl);
const maintenancePrincipal = "refunddesk_maintenance_login";
const collectiveRoleNames = [
  "refunddesk_attestation_writer",
  "refunddesk_maintenance",
  "refunddesk_queue",
  "refunddesk_runtime",
  "refunddesk_worker",
];
const runtimeLoginPrincipals = [
  ...new Set([webPrincipal, workerPrincipal, queuePrincipal, maintenancePrincipal]),
];
if (runtimeLoginPrincipals.length !== 4 || migrationPrincipal === maintenancePrincipal) {
  throw new Error("DATABASE_RUNTIME_PRINCIPALS_MUST_BE_DISTINCT");
}

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

  const membershipResult = await client.query(
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
    ["refunddesk_runtime", new Set([webPrincipal])],
    ["refunddesk_worker", new Set([workerPrincipal])],
    ["refunddesk_queue", new Set([queuePrincipal])],
    ["refunddesk_maintenance", new Set([maintenancePrincipal])],
    ["refunddesk_attestation_writer", new Set([workerPrincipal])],
  ]);
  for (const membership of membershipResult.rows) {
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

  const loginMembers = await client.query(
    `SELECT 1
       FROM pg_auth_members AS membership
       INNER JOIN pg_roles AS parent ON parent.oid = membership.roleid
      WHERE parent.rolname = ANY($1::text[])
      LIMIT 1`,
    [runtimeLoginPrincipals],
  );
  if (loginMembers.rowCount !== 0) {
    throw new Error("DATABASE_RUNTIME_LOGIN_HAS_MEMBERS");
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
               OR has_any_column_privilege(
                 'refunddesk_maintenance',
                 relation.oid,
                 'SELECT,INSERT,UPDATE,REFERENCES'
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
       has_schema_privilege(
         'refunddesk_maintenance',
         'pgboss',
         'USAGE'
       ) AS has_pgboss_schema_usage,
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
           AND routine.oid NOT IN (
             to_regprocedure(
               'public.refunddesk_list_due_tenant_purges(integer)'
             ),
             to_regprocedure(
               'public.refunddesk_purge_test_sandbox_tenant(uuid,character varying)'
             )
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
         'public.refunddesk_list_due_tenant_purges(integer)',
         'EXECUTE'
       ) AS maintenance_can_list_due_purges,
       has_function_privilege(
         'refunddesk_runtime',
         'public.refunddesk_list_due_tenant_purges(integer)',
         'EXECUTE'
       ) AS web_can_list_due_purges,
       has_function_privilege(
         'refunddesk_worker',
         'public.refunddesk_list_due_tenant_purges(integer)',
         'EXECUTE'
       ) AS worker_can_list_due_purges,
       has_function_privilege(
         'refunddesk_queue',
         'public.refunddesk_list_due_tenant_purges(integer)',
         'EXECUTE'
       ) AS queue_can_list_due_purges,
       has_function_privilege(
         'refunddesk_maintenance',
         'public.refunddesk_purge_test_sandbox_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS maintenance_can_guarded_purge,
       has_function_privilege(
         'refunddesk_runtime',
         'public.refunddesk_purge_test_sandbox_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS web_can_guarded_purge,
       has_function_privilege(
         'refunddesk_worker',
         'public.refunddesk_purge_test_sandbox_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS worker_can_guarded_purge,
       has_function_privilege(
         'refunddesk_queue',
         'public.refunddesk_purge_test_sandbox_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS queue_can_guarded_purge,
       has_function_privilege(
         'refunddesk_maintenance',
         'public.refunddesk_purge_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS maintenance_can_raw_purge,
       has_function_privilege(
         'refunddesk_runtime',
         'public.refunddesk_purge_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS web_can_raw_purge,
       has_function_privilege(
         'refunddesk_worker',
         'public.refunddesk_purge_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS worker_can_raw_purge,
       has_function_privilege(
         'refunddesk_queue',
         'public.refunddesk_purge_tenant(uuid,character varying)',
         'EXECUTE'
       ) AS queue_can_raw_purge`,
  );
  const capability = result.rows[0];
  if (
    capability?.has_direct_table_access !== false ||
    capability.has_relation_maintain !== false ||
    capability.has_schema_create !== false ||
    capability.has_pgboss_schema_usage !== false ||
    capability.has_sequence_access !== false ||
    capability.has_other_function_execute !== false ||
    capability.has_other_procedure_execute !== false ||
    capability.maintenance_can_list_due_purges !== true ||
    capability.web_can_list_due_purges !== false ||
    capability.worker_can_list_due_purges !== false ||
    capability.queue_can_list_due_purges !== false ||
    capability.maintenance_can_guarded_purge !== true ||
    capability.web_can_guarded_purge !== false ||
    capability.worker_can_guarded_purge !== false ||
    capability.queue_can_guarded_purge !== false ||
    capability.maintenance_can_raw_purge !== false ||
    capability.web_can_raw_purge !== false ||
    capability.worker_can_raw_purge !== false ||
    capability.queue_can_raw_purge !== false
  ) {
    throw new Error("DATABASE_MAINTENANCE_CAPABILITY_CHECK_FAILED");
  }
}

async function verifyGlobalDatabaseAuthority(client) {
  const result = await client.query(
    `WITH migration_role AS (
       SELECT oid
       FROM pg_roles
       WHERE rolname = $1
     ),
     allowed_grantee AS (
       SELECT oid
       FROM pg_roles
       WHERE rolname = ANY($2::text[])
       UNION
       SELECT oid FROM migration_role
     ),
     application_relation AS (
       SELECT relation.oid, relation.relowner AS owner_oid
       FROM pg_class AS relation
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname IN ('public', 'pgboss')
         AND NOT EXISTS (
           SELECT 1
           FROM pg_depend AS dependency
           WHERE dependency.classid = 'pg_class'::regclass
             AND dependency.objid = relation.oid
             AND dependency.deptype = 'e'
         )
     ),
     application_routine AS (
       SELECT routine.oid, routine.proowner AS owner_oid
       FROM pg_proc AS routine
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = routine.pronamespace
       WHERE namespace.nspname IN ('public', 'pgboss')
         AND NOT EXISTS (
           SELECT 1
           FROM pg_depend AS dependency
           WHERE dependency.classid = 'pg_proc'::regclass
             AND dependency.objid = routine.oid
             AND dependency.deptype = 'e'
         )
     ),
     application_type AS (
       SELECT type.oid, type.typowner AS owner_oid
       FROM pg_type AS type
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = type.typnamespace
       WHERE namespace.nspname IN ('public', 'pgboss')
         AND NOT EXISTS (
           SELECT 1
           FROM pg_depend AS dependency
           WHERE dependency.classid = 'pg_type'::regclass
             AND dependency.objid = type.oid
             AND dependency.deptype = 'e'
         )
     ),
     explicit_grant(owner_oid, grantee, grantor) AS (
       SELECT namespace.nspowner, privilege.grantee, privilege.grantor
       FROM pg_namespace AS namespace
       CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
       WHERE namespace.nspname IN ('public', 'pgboss')
       UNION ALL
       SELECT relation.owner_oid, privilege.grantee, privilege.grantor
       FROM application_relation AS relation
       INNER JOIN pg_class AS catalog_relation ON catalog_relation.oid = relation.oid
       CROSS JOIN LATERAL aclexplode(catalog_relation.relacl) AS privilege
       UNION ALL
       SELECT relation.owner_oid, privilege.grantee, privilege.grantor
       FROM application_relation AS relation
       INNER JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
       CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
       WHERE attribute.attnum > 0
         AND NOT attribute.attisdropped
       UNION ALL
       SELECT routine.owner_oid, privilege.grantee, privilege.grantor
       FROM application_routine AS routine
       INNER JOIN pg_proc AS catalog_routine ON catalog_routine.oid = routine.oid
       CROSS JOIN LATERAL aclexplode(catalog_routine.proacl) AS privilege
       UNION ALL
       SELECT type.owner_oid, privilege.grantee, privilege.grantor
       FROM application_type AS type
       INNER JOIN pg_type AS catalog_type ON catalog_type.oid = type.oid
       CROSS JOIN LATERAL aclexplode(catalog_type.typacl) AS privilege
       UNION ALL
       SELECT
         default_acl.defaclrole,
         privilege.grantee,
         privilege.grantor
       FROM pg_default_acl AS default_acl
       LEFT JOIN pg_namespace AS namespace
         ON namespace.oid = default_acl.defaclnamespace
       CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS privilege
       WHERE default_acl.defaclrole = (SELECT oid FROM migration_role)
         AND (
           default_acl.defaclnamespace = 0
           OR namespace.nspname IN ('public', 'pgboss')
         )
     )
     SELECT
       (
         SELECT owner.rolname <> $1
         FROM pg_database AS database
         INNER JOIN pg_roles AS owner ON owner.oid = database.datdba
         WHERE database.datname = current_database()
       )
       OR EXISTS (
         SELECT 1
         FROM application_relation
         WHERE owner_oid <> (SELECT oid FROM migration_role)
       )
       OR EXISTS (
         SELECT 1
         FROM application_routine
         WHERE owner_oid <> (SELECT oid FROM migration_role)
       )
       OR EXISTS (
         SELECT 1
         FROM application_type
         WHERE owner_oid <> (SELECT oid FROM migration_role)
       )
       OR EXISTS (
         SELECT 1
         FROM pg_extension
         WHERE extnamespace IN (
           SELECT oid FROM pg_namespace WHERE nspname IN ('public', 'pgboss')
         )
           AND extowner <> (SELECT oid FROM migration_role)
       ) AS ownership_invalid,
       EXISTS (
         SELECT 1
         FROM explicit_grant
         WHERE NOT (
           grantee = owner_oid
           AND grantor = owner_oid
         )
           AND (
             grantee = 0
             OR grantee NOT IN (SELECT oid FROM allowed_grantee)
             OR grantor NOT IN (
               owner_oid,
               (SELECT oid FROM migration_role)
             )
           )
       ) AS acl_invalid`,
    [migrationPrincipal, collectiveRoleNames],
  );
  const authority = result.rows[0];
  if (authority?.ownership_invalid !== false || authority.acl_invalid !== false) {
    throw new Error("DATABASE_GLOBAL_AUTHORITY_INVALID");
  }
}

async function verifyNoPgBossCapability(client) {
  const result = await client.query(
    `SELECT
       has_schema_privilege(current_user, 'pgboss', 'USAGE')
         OR has_schema_privilege(current_user, 'pgboss', 'CREATE')
         AS has_schema_access,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'pgboss'
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_table_privilege(
             current_user,
             relation.oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
           )
       ) AS has_relation_access,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS sequence
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = sequence.relnamespace
         WHERE namespace.nspname = 'pgboss'
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
         WHERE namespace.nspname = 'pgboss'
           AND routine.prokind IN ('f', 'a', 'w')
           AND has_function_privilege(
             current_user,
             routine.oid,
             'EXECUTE'
           )
       ) AS has_function_execute`,
  );
  const capability = result.rows[0];
  if (
    capability?.has_schema_access !== false ||
    capability.has_relation_access !== false ||
    capability.has_sequence_access !== false ||
    capability.has_function_execute !== false
  ) {
    throw new Error("DATABASE_NON_QUEUE_PGBOSS_CAPABILITY");
  }
}

async function verifyLogin(client, expectedPrincipal, expectedMemberships) {
  const result = await client.query(
    `WITH RECURSIVE parent_membership(roleid) AS (
       SELECT membership.roleid
       FROM pg_auth_members AS membership
       WHERE membership.member = (
         SELECT oid FROM pg_roles WHERE rolname = current_user
       )
       UNION
       SELECT membership.roleid
       FROM pg_auth_members AS membership
       INNER JOIN parent_membership
         ON parent_membership.roleid = membership.member
     )
     SELECT
       current_user,
       role.rolcanlogin,
       role.rolsuper,
       role.rolcreatedb,
       role.rolcreaterole,
       role.rolbypassrls,
       role.rolinherit,
       role.rolreplication,
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
         FROM unnest($1::text[]) AS expected_membership(role_name)
         WHERE NOT pg_has_role(current_user, expected_membership.role_name, 'USAGE')
       ) AS expected_membership,
       NOT EXISTS (
         SELECT 1
         FROM pg_auth_members AS direct_membership
         WHERE direct_membership.member = role.oid
           AND direct_membership.admin_option
       ) AS expected_admin_option_absent,
       ARRAY(
         SELECT parent.rolname::text
         FROM parent_membership
         INNER JOIN pg_roles AS parent ON parent.oid = parent_membership.roleid
         ORDER BY parent.rolname
       ) AS parent_roles
     FROM pg_roles role
     WHERE role.rolname = current_user`,
    [expectedMemberships],
  );
  const role = result.rows[0];
  assertExactRuntimeMembership(role?.parent_roles, expectedMemberships);
  if (
    role?.current_user !== expectedPrincipal ||
    role.rolcanlogin !== true ||
    role.rolsuper !== false ||
    role.rolcreatedb !== false ||
    role.rolcreaterole !== false ||
    role.rolbypassrls !== false ||
    role.rolinherit !== true ||
    role.rolreplication !== false ||
    role.replication_role_is_origin !== true ||
    role.can_set_replication_role !== false ||
    role.can_alter_system_replication_role !== false ||
    role.expected_membership !== true ||
    role.expected_admin_option_absent !== true
  ) {
    throw new Error("DATABASE_RUNTIME_IDENTITY_CHECK_FAILED");
  }
}

async function verifyNoDirectRuntimeAuthority(client) {
  const result = await client.query(
    `WITH login_role AS (
       SELECT oid
       FROM pg_roles
       WHERE rolname = current_user
     ),
     direct_grant AS (
       SELECT privilege.grantee
       FROM pg_namespace AS namespace
       CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
       WHERE namespace.nspname IN ('public', 'pgboss')
       UNION ALL
       SELECT privilege.grantee
       FROM pg_class AS relation
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(relation.relacl) AS privilege
       WHERE namespace.nspname IN ('public', 'pgboss')
       UNION ALL
       SELECT privilege.grantee
       FROM pg_attribute AS attribute
       INNER JOIN pg_class AS relation
         ON relation.oid = attribute.attrelid
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
       WHERE namespace.nspname IN ('public', 'pgboss')
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       UNION ALL
       SELECT privilege.grantee
       FROM pg_proc AS routine
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = routine.pronamespace
       CROSS JOIN LATERAL aclexplode(routine.proacl) AS privilege
       WHERE namespace.nspname IN ('public', 'pgboss')
       UNION ALL
       SELECT privilege.grantee
       FROM pg_type AS type
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = type.typnamespace
       CROSS JOIN LATERAL aclexplode(type.typacl) AS privilege
       WHERE namespace.nspname IN ('public', 'pgboss')
       UNION ALL
       SELECT privilege.grantee
       FROM pg_database AS database
       CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
       WHERE database.datname = current_database()
       UNION ALL
       SELECT privilege.grantee
       FROM pg_default_acl AS default_acl
       CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS privilege
       UNION ALL
       SELECT privilege.grantee
       FROM pg_parameter_acl AS parameter_acl
       CROSS JOIN LATERAL aclexplode(parameter_acl.paracl) AS privilege
     ),
     purge_routine AS (
       SELECT routine.oid
       FROM pg_proc AS routine
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = routine.pronamespace
       WHERE namespace.nspname = 'public'
         AND routine.proname = 'refunddesk_purge_tenant'
         AND routine.pronargs = 2
     ),
     audit_relation AS (
       SELECT relation.oid
       FROM pg_class AS relation
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'audit_events'
     )
     SELECT
       EXISTS (
         SELECT 1
         FROM direct_grant
         WHERE grantee = (SELECT oid FROM login_role)
       ) AS has_direct_grant,
       EXISTS (
         SELECT 1
         FROM pg_database
         WHERE datname = current_database()
           AND datdba = (SELECT oid FROM login_role)
       )
       OR EXISTS (
         SELECT 1
         FROM pg_namespace
         WHERE nspowner = (SELECT oid FROM login_role)
           AND nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
           AND nspname !~ '^pg_(?:temp|toast_temp)_'
       )
       OR EXISTS (
         SELECT 1
         FROM pg_class
         INNER JOIN pg_namespace
           ON pg_namespace.oid = pg_class.relnamespace
         WHERE pg_class.relowner = (SELECT oid FROM login_role)
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
         WHERE pg_proc.proowner = (SELECT oid FROM login_role)
           AND pg_namespace.nspname NOT IN (
             'pg_catalog',
             'information_schema',
             'pg_toast'
           )
           AND pg_namespace.nspname !~ '^pg_(?:temp|toast_temp)_'
       ) AS owns_database_objects,
       COALESCE(
         (
           SELECT has_function_privilege(
             current_user,
             purge_routine.oid,
             'EXECUTE'
           )
           FROM purge_routine
         ),
         false
       ) AS can_purge,
       COALESCE(
         (
           SELECT
             has_table_privilege(current_user, audit_relation.oid, 'UPDATE')
             OR has_any_column_privilege(
               current_user,
               audit_relation.oid,
               'UPDATE'
             )
             OR has_table_privilege(current_user, audit_relation.oid, 'DELETE')
             OR has_table_privilege(current_user, audit_relation.oid, 'TRUNCATE')
           FROM audit_relation
         ),
         false
       ) AS can_mutate_audit`,
  );
  const authority = result.rows[0];
  if (
    authority?.has_direct_grant !== false ||
    authority.owns_database_objects !== false ||
    authority.can_purge !== false ||
    authority.can_mutate_audit !== false
  ) {
    throw new Error("DATABASE_RUNTIME_LOGIN_HAS_DIRECT_AUTHORITY");
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
       has_table_privilege(current_user, 'refund_requests', 'DELETE')
         OR has_table_privilege(current_user, 'refund_requests', 'TRUNCATE')
         AS request_destructive,
       has_table_privilege(current_user, 'approval_decisions', 'INSERT') AS decision_insert,
       NOT (
         has_table_privilege(current_user, 'approval_attestations', 'SELECT')
         OR has_any_column_privilege(current_user, 'approval_attestations', 'SELECT')
         OR has_table_privilege(current_user, 'approval_attestations', 'INSERT')
         OR has_any_column_privilege(current_user, 'approval_attestations', 'INSERT')
         OR has_table_privilege(current_user, 'approval_attestations', 'UPDATE')
         OR has_any_column_privilege(current_user, 'approval_attestations', 'UPDATE')
         OR has_table_privilege(current_user, 'approval_attestations', 'DELETE')
         OR has_table_privilege(current_user, 'approval_attestations', 'TRUNCATE')
       ) AS no_attestation_access,
       NOT has_table_privilege(current_user, 'tenant_users', 'UPDATE')
         AND has_column_privilege(
           current_user,
           'tenant_users',
           'display_name',
           'UPDATE'
         )
         AND has_column_privilege(
           current_user,
           'tenant_users',
           'stripe_roles',
           'UPDATE'
         )
         AND has_column_privilege(
           current_user,
           'tenant_users',
           'approver_enabled',
           'UPDATE'
         )
         AND has_column_privilege(
           current_user,
           'tenant_users',
           'last_verified_at',
           'UPDATE'
         )
         AND has_column_privilege(
           current_user,
           'tenant_users',
           'updated_at',
           'UPDATE'
         )
         AND NOT has_column_privilege(
           current_user,
           'tenant_users',
           'tenant_id',
           'UPDATE'
         )
         AND NOT has_column_privilege(
           current_user,
           'tenant_users',
           'stripe_user_id',
           'UPDATE'
         )
         AND NOT has_column_privilege(
           current_user,
           'tenant_users',
           'created_at',
           'UPDATE'
         ) AS tenant_user_update_is_narrow,
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
        NOT (
          has_table_privilege(
            current_user,
            'signed_request_rate_limit_buckets',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          OR has_any_column_privilege(
            current_user,
            'signed_request_rate_limit_buckets',
            'SELECT,INSERT,UPDATE'
          )
        ) AS no_rate_limit_table_access,
        has_function_privilege(
          current_user,
          'public.refunddesk_consume_signed_request_rate_limit(character varying,public.stripe_environment,character varying)',
          'EXECUTE'
        ) AS rate_limit_execute,
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
    capabilities.request_destructive !== false ||
    capabilities.decision_insert !== true ||
    capabilities.no_attestation_access !== true ||
    capabilities.tenant_user_update_is_narrow !== true ||
    capabilities.execution_read !== true ||
    capabilities.attempt_read !== true ||
    capabilities.candidate_read !== false ||
    capabilities.no_rate_limit_table_access !== true ||
    capabilities.rate_limit_execute !== true ||
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
       has_table_privilege(current_user, 'refund_requests', 'DELETE')
         OR has_table_privilege(current_user, 'refund_requests', 'TRUNCATE')
         AS request_destructive,
       (
         has_table_privilege(current_user, 'approval_decisions', 'INSERT')
         OR has_any_column_privilege(current_user, 'approval_decisions', 'INSERT')
       ) AS decision_insert,
       has_table_privilege(current_user, 'approval_attestations', 'SELECT')
         AS attestation_select,
       has_table_privilege(current_user, 'approval_attestations', 'INSERT')
         AS attestation_insert,
       has_table_privilege(current_user, 'approval_attestations', 'UPDATE')
         OR has_any_column_privilege(current_user, 'approval_attestations', 'UPDATE')
         OR has_table_privilege(current_user, 'approval_attestations', 'DELETE')
         OR has_table_privilege(current_user, 'approval_attestations', 'TRUNCATE')
         AS attestation_mutation,
       NOT (
         has_table_privilege(
           current_user,
           'signed_request_rate_limit_buckets',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
         )
         OR has_any_column_privilege(
           current_user,
           'signed_request_rate_limit_buckets',
           'SELECT,INSERT,UPDATE'
         )
       ) AS no_rate_limit_table_access,
       has_function_privilege(
         current_user,
         'public.refunddesk_consume_signed_request_rate_limit(character varying,public.stripe_environment,character varying)',
         'EXECUTE'
       ) AS rate_limit_execute`,
  );
  const capabilities = result.rows[0];
  if (
    capabilities?.worker_owned_read_write !== true ||
    capabilities.request_update !== true ||
    capabilities.request_insert !== false ||
    capabilities.request_destructive !== false ||
    capabilities.decision_insert !== false ||
    capabilities.attestation_select !== true ||
    capabilities.attestation_insert !== true ||
    capabilities.attestation_mutation !== false ||
    capabilities.no_rate_limit_table_access !== true ||
    capabilities.rate_limit_execute !== false
  ) {
    throw new Error("DATABASE_WORKER_DATA_CAPABILITY_CHECK_FAILED");
  }
}

async function checkWeb() {
  const client = new Client({
    connectionString: webUrl.toString(),
    application_name: "refunddesk-web-access-check",
    options: "-c search_path=pg_catalog,public",
  });
  try {
    await client.connect();
    await verifyCollectiveRoleAttributes(client);
    await verifyGlobalDatabaseAuthority(client);
    await verifyMaintenanceCapability(client);
    await verifyLogin(client, webPrincipal, ["refunddesk_runtime"]);
    await verifyNoDirectRuntimeAuthority(client);
    await verifyNoPgBossCapability(client);
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

async function checkApprovalAttestationMigrationCheckpoint() {
  const client = new Client({
    connectionString: migrationUrl.toString(),
    application_name: "refunddesk-approval-attestation-migration-checkpoint",
    options: "-c search_path=pg_catalog,public",
  });
  try {
    await client.connect();
    await assertExecutableApprovalAttestationCoverage(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkWorkerDataAccess() {
  const client = new Client({
    connectionString: workerUrl.toString(),
    application_name: "refunddesk-worker-data-access-check",
    options: "-c search_path=pg_catalog,public",
  });
  try {
    await client.connect();
    await verifyLogin(client, workerPrincipal, [
      "refunddesk_attestation_writer",
      "refunddesk_worker",
    ]);
    await verifyNoDirectRuntimeAuthority(client);
    await verifyNoPgBossCapability(client);
    await expectFailClosed(client);
    await verifyWorkerDataCapabilities(client);
    const privileges = await client.query(
      `SELECT
         has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
         has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
         has_schema_privilege(current_user, 'pgboss', 'USAGE') AS pgboss_usage`,
    );
    const value = privileges.rows[0];
    if (
      value?.public_usage !== true ||
      value.public_create !== false ||
      value.pgboss_usage !== false
    ) {
      throw new Error("DATABASE_WORKER_PRIVILEGE_CHECK_FAILED");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkQueueAccess() {
  const client = new Client({
    connectionString: queueUrl.toString(),
    application_name: "refunddesk-worker-queue-access-check",
    options: "-c search_path=pg_catalog,public",
  });
  const probeQueue = "__refunddesk_access_probe__";
  try {
    await client.connect();
    await verifyLogin(client, queuePrincipal, ["refunddesk_queue"]);
    await verifyNoDirectRuntimeAuthority(client);
    const privileges = await client.query(
      `WITH rate_limit_routine AS (
         SELECT routine.oid
         FROM pg_catalog.pg_proc AS routine
         INNER JOIN pg_catalog.pg_namespace AS routine_namespace
           ON routine_namespace.oid = routine.pronamespace
         INNER JOIN pg_catalog.pg_type AS environment_type
           ON environment_type.oid = routine.proargtypes[1]
         INNER JOIN pg_catalog.pg_namespace AS environment_namespace
           ON environment_namespace.oid = environment_type.typnamespace
         WHERE routine_namespace.nspname = 'public'
           AND routine.proname = 'refunddesk_consume_signed_request_rate_limit'
           AND routine.pronargs = 3
           AND routine.proargtypes[0] = 'pg_catalog.varchar'::pg_catalog.regtype
           AND environment_namespace.nspname = 'public'
           AND environment_type.typname = 'stripe_environment'
           AND routine.proargtypes[2] = 'pg_catalog.varchar'::pg_catalog.regtype
       )
       SELECT
         has_schema_privilege(current_user, 'pgboss', 'USAGE') AS schema_usage,
         has_schema_privilege(current_user, 'pgboss', 'CREATE') AS schema_create,
         has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
         has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
         EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS relation
           INNER JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = 'public'
             AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND has_table_privilege(
               current_user,
               relation.oid,
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
             )
         ) AS public_relation_access,
         EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS sequence
           INNER JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = sequence.relnamespace
           WHERE namespace.nspname = 'public'
             AND sequence.relkind = 'S'
             AND has_sequence_privilege(
               current_user,
               sequence.oid,
               'USAGE,SELECT,UPDATE'
             )
         ) AS public_sequence_access,
         has_table_privilege(
           current_user,
           'pgboss.job',
           'SELECT,INSERT,UPDATE,DELETE'
         ) AS job_dml,
         has_table_privilege(
           current_user,
           'pgboss.job',
           'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
         ) AS job_excess_authority,
         has_function_privilege(
           current_user,
           'pgboss.create_queue(text,jsonb)',
           'EXECUTE'
         ) AS create_queue_execute,
         COALESCE(
           (
             SELECT has_function_privilege(
               current_user,
               rate_limit_routine.oid,
               'EXECUTE'
             )
             FROM rate_limit_routine
           ),
           false
         ) AS rate_limit_execute`,
    );
    const value = privileges.rows[0];
    if (
      value?.schema_usage !== true ||
      value.schema_create !== false ||
      value.public_usage !== false ||
      value.public_create !== false ||
      value.public_relation_access !== false ||
      value.public_sequence_access !== false ||
      value.job_dml !== true ||
      value.job_excess_authority !== false ||
      value.create_queue_execute !== true ||
      value.rate_limit_execute !== false
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
  await checkApprovalAttestationMigrationCheckpoint();
  await checkWeb();
  await checkWorkerDataAccess();
  await checkQueueAccess();
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      web_principal: webPrincipal,
      worker_principal: workerPrincipal,
      queue_principal: queuePrincipal,
      maintenance_principal: maintenancePrincipal,
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
