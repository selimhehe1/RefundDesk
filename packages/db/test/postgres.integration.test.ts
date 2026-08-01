import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertExecutableApprovalAttestationCoverage } from "../scripts/approval-attestation-checkpoint.js";
import { readOrderedMigrationSql } from "./postgres-test-support.js";

const testDatabaseUrl = process.env["REFUNDDESK_TEST_DATABASE_URL"] ?? "";
const databaseDescribe = testDatabaseUrl.length === 0 ? describe.skip : describe.sequential;
const databaseName = `refunddesk_security_${randomBytes(8).toString("hex")}`;
const SAFE_DATABASE_NAME = /^refunddesk_security_[0-9a-f]{16}$/u;

function quotedGeneratedDatabaseName(): string {
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error("Generated security database name is unsafe");
  }
  return `"${databaseName}"`;
}

function connectionStringForDatabase(connectionString: string, targetDatabase: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${targetDatabase}`;
  return url.toString();
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.end();
  } catch {
    // Cleanup continues so the exact generated database can still be dropped.
  }
}

async function installPinnedPgBossRetentionFixture(client: Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA pgboss;
    CREATE TYPE pgboss.job_state AS ENUM (
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed'
    );
    CREATE TABLE pgboss.version (
      version INTEGER PRIMARY KEY
    );
    INSERT INTO pgboss.version (version) VALUES (37);
    CREATE TABLE pgboss.job (
      id UUID NOT NULL,
      name TEXT NOT NULL,
      data JSONB,
      state pgboss.job_state NOT NULL DEFAULT 'created',
      blocking BOOLEAN NOT NULL DEFAULT false,
      pending_dependencies INTEGER NOT NULL DEFAULT 0,
      source_name TEXT,
      source_id UUID
    ) PARTITION BY LIST (name);
    CREATE TABLE pgboss.job_common
      PARTITION OF pgboss.job DEFAULT;
    CREATE TABLE pgboss.job_dependency (
      child_name TEXT NOT NULL,
      child_id UUID NOT NULL,
      parent_name TEXT NOT NULL,
      parent_id UUID NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    );
  `);
}

databaseDescribe("PostgreSQL security invariants", () => {
  const ephemeralDatabaseUrl =
    testDatabaseUrl.length === 0 ? "" : connectionStringForDatabase(testDatabaseUrl, databaseName);
  const controlClient = new Client({
    connectionString: testDatabaseUrl,
    application_name: "refunddesk-postgres-security-control",
  });
  const client = new Client({
    connectionString: ephemeralDatabaseUrl,
    application_name: "refunddesk-postgres-security-test",
  });
  let controlConnected = false;
  let clientConnected = false;
  let databaseCreated = false;
  let tenantA = "";
  let tenantB = "";
  let installationA = "";
  let installationB = "";
  let runtimeRolesSql = "";

  const cleanupEphemeralDatabase = async (): Promise<void> => {
    if (clientConnected) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Cleanup continues even if PostgreSQL already ended the fixture transaction.
      }
      try {
        await client.query("RESET SESSION AUTHORIZATION");
        await client.query("RESET ROLE");
      } catch {
        // Closing the generated-database connection is the remaining safe fallback.
      }
      await closeQuietly(client);
      clientConnected = false;
    }

    if (databaseCreated) {
      if (!controlConnected) {
        await controlClient.connect();
        controlConnected = true;
      }
      await controlClient.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1
           AND pid <> pg_backend_pid()`,
        [databaseName],
      );
      await controlClient.query(`DROP DATABASE IF EXISTS ${quotedGeneratedDatabaseName()}`);
      databaseCreated = false;
    }

    if (controlConnected) {
      await closeQuietly(controlClient);
      controlConnected = false;
    }
  };

  beforeAll(async () => {
    try {
      await controlClient.connect();
      controlConnected = true;
      const version = await controlClient.query<{ server_version_num: string }>(
        "SELECT current_setting('server_version_num') AS server_version_num",
      );
      const serverVersionNumber = Number.parseInt(version.rows[0]?.server_version_num ?? "", 10);
      expect(Math.trunc(serverVersionNumber / 10_000)).toBe(18);

      await controlClient.query(
        `CREATE DATABASE ${quotedGeneratedDatabaseName()} TEMPLATE template0`,
      );
      databaseCreated = true;
      await client.connect();
      clientConnected = true;

      const migrations = await readOrderedMigrationSql();
      runtimeRolesSql = await readFile(
        new URL("../prisma/runtime-roles.sql", import.meta.url),
        "utf8",
      );
      for (const migration of migrations) {
        await client.query(migration);
      }
      await installPinnedPgBossRetentionFixture(client);

      await client.query("BEGIN");
      await client.query("SAVEPOINT refunddesk_security_fixture_transaction");
      await client.query("RELEASE SAVEPOINT refunddesk_security_fixture_transaction");
      await client.query(runtimeRolesSql);
      await client.query(
        `DO $$
         BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_web_login') THEN
             CREATE ROLE refunddesk_web_login
               LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
           END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_worker_login') THEN
             CREATE ROLE refunddesk_worker_login
               LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
           END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_queue_login') THEN
             CREATE ROLE refunddesk_queue_login
               LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
           END IF;
           IF NOT EXISTS (
             SELECT 1 FROM pg_roles WHERE rolname = 'refunddesk_maintenance_login'
           ) THEN
             CREATE ROLE refunddesk_maintenance_login
               LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
           END IF;
         END
         $$`,
      );
      await client.query("GRANT refunddesk_runtime TO refunddesk_web_login");
      await client.query(
        "REVOKE refunddesk_worker, refunddesk_queue, refunddesk_maintenance, refunddesk_attestation_writer FROM refunddesk_web_login",
      );
      await client.query("GRANT refunddesk_worker TO refunddesk_worker_login");
      await client.query("GRANT refunddesk_attestation_writer TO refunddesk_worker_login");
      await client.query(
        "REVOKE refunddesk_runtime, refunddesk_queue, refunddesk_maintenance FROM refunddesk_worker_login",
      );
      await client.query("GRANT refunddesk_queue TO refunddesk_queue_login");
      await client.query(
        "REVOKE refunddesk_runtime, refunddesk_worker, refunddesk_maintenance, refunddesk_attestation_writer FROM refunddesk_queue_login",
      );
      await client.query("GRANT refunddesk_maintenance TO refunddesk_maintenance_login");
      await client.query(
        "REVOKE refunddesk_runtime, refunddesk_worker, refunddesk_queue, refunddesk_attestation_writer FROM refunddesk_maintenance_login",
      );
      await client.query("SET ROLE refunddesk_runtime");
      const provisionA = await client.query<{ tenant_id: string; installation_id: string }>(
        "SELECT tenant_id, installation_id FROM refunddesk_provision_installation($1, 'test')",
        ["acct_IntegrationA"],
      );
      const provisionB = await client.query<{ tenant_id: string; installation_id: string }>(
        "SELECT tenant_id, installation_id FROM refunddesk_provision_installation($1, 'sandbox')",
        ["acct_IntegrationB"],
      );
      tenantA = provisionA.rows[0]?.tenant_id ?? "";
      tenantB = provisionB.rows[0]?.tenant_id ?? "";
      installationA = provisionA.rows[0]?.installation_id ?? "";
      installationB = provisionB.rows[0]?.installation_id ?? "";
    } catch (error) {
      await cleanupEphemeralDatabase();
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupEphemeralDatabase();
  });

  it("keeps one readable but immutable hosted database identity marker", async () => {
    const identity = await client.query<{
      identity_id: string;
      release_nonce: string;
      schema_contract_version: number;
    }>(
      `SELECT identity_id::text, release_nonce::text, schema_contract_version
         FROM refunddesk_database_identity
        WHERE singleton`,
    );
    const privileges = await client.query<{
      web_select: boolean;
      web_update: boolean;
      worker_select: boolean;
      worker_update: boolean;
    }>(
      `SELECT
         has_table_privilege(
           'refunddesk_web_login',
           'refunddesk_database_identity',
           'SELECT'
         ) AS web_select,
         has_table_privilege(
           'refunddesk_web_login',
           'refunddesk_database_identity',
           'UPDATE'
         ) AS web_update,
         has_table_privilege(
           'refunddesk_worker_login',
           'refunddesk_database_identity',
           'SELECT'
         ) AS worker_select,
         has_table_privilege(
           'refunddesk_worker_login',
           'refunddesk_database_identity',
           'UPDATE'
         ) AS worker_update`,
    );

    expect(identity.rows).toHaveLength(1);
    expect(identity.rows[0]?.identity_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(identity.rows[0]?.release_nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(identity.rows[0]?.schema_contract_version).toBe(1);
    expect(privileges.rows[0]).toEqual({
      web_select: true,
      web_update: false,
      worker_select: true,
      worker_update: false,
    });
  });

  it("repairs collective role attributes and stale application ACLs", async () => {
    await client.query("RESET ROLE");
    await client.query("CREATE ROLE refunddesk_integration_parent_probe NOLOGIN");
    await client.query("CREATE ROLE refunddesk_integration_member_probe NOLOGIN");
    await client.query("GRANT refunddesk_integration_parent_probe TO refunddesk_runtime");
    await client.query("GRANT CREATE ON SCHEMA public TO refunddesk_maintenance");
    await client.query("GRANT DELETE ON refund_requests TO refunddesk_runtime");
    await client.query(
      "GRANT UPDATE (workflow_status) ON refund_requests TO refunddesk_integration_member_probe",
    );
    await client.query("CREATE SEQUENCE public.refunddesk_maintenance_privilege_probe");
    await client.query(
      "CREATE FUNCTION public.refunddesk_maintenance_function_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
    );
    await client.query(
      "GRANT ALL PRIVILEGES ON SEQUENCE public.refunddesk_maintenance_privilege_probe TO refunddesk_maintenance",
    );
    await client.query(
      "GRANT EXECUTE ON FUNCTION public.refunddesk_maintenance_function_probe() TO refunddesk_maintenance",
    );
    await client.query(runtimeRolesSql);
    const repairedAuthority = await client.query<{
      runtime_can_delete_requests: boolean;
      stale_member_can_update_requests: boolean;
    }>(
      `SELECT
         has_table_privilege(
           'refunddesk_runtime',
           'refund_requests',
           'DELETE'
         ) AS runtime_can_delete_requests,
         has_any_column_privilege(
           'refunddesk_integration_member_probe',
           'refund_requests',
           'UPDATE'
         ) AS stale_member_can_update_requests`,
    );
    await client.query("GRANT refunddesk_runtime TO refunddesk_web_login");
    await client.query("GRANT refunddesk_worker TO refunddesk_worker_login");
    await client.query("SET ROLE refunddesk_runtime");

    const result = await client.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      has_parent_membership: boolean;
    }>(
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
           FROM pg_auth_members AS membership
           WHERE membership.member = role.oid
         ) AS has_parent_membership
       FROM pg_roles AS role
       WHERE rolname = ANY($1::text[])
       ORDER BY rolname`,
      [
        [
          "refunddesk_attestation_writer",
          "refunddesk_queue",
          "refunddesk_runtime",
          "refunddesk_worker",
          "refunddesk_maintenance",
        ],
      ],
    );
    const maintenancePrivileges = await client.query<{
      has_schema_create: boolean;
      has_sequence_access: boolean;
      has_other_function_execute: boolean;
    }>(
      `SELECT
         has_schema_privilege(
           'refunddesk_maintenance',
           'public',
           'CREATE'
         ) AS has_schema_create,
         has_sequence_privilege(
           'refunddesk_maintenance',
           'public.refunddesk_maintenance_privilege_probe',
           'USAGE,SELECT,UPDATE'
         ) AS has_sequence_access,
         has_function_privilege(
           'refunddesk_maintenance',
           'public.refunddesk_maintenance_function_probe()',
           'EXECUTE'
         ) AS has_other_function_execute`,
    );

    expect(result.rows).toEqual([
      {
        rolname: "refunddesk_attestation_writer",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        has_parent_membership: false,
      },
      {
        rolname: "refunddesk_maintenance",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        has_parent_membership: false,
      },
      {
        rolname: "refunddesk_queue",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        has_parent_membership: false,
      },
      {
        rolname: "refunddesk_runtime",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        has_parent_membership: false,
      },
      {
        rolname: "refunddesk_worker",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        has_parent_membership: false,
      },
    ]);
    expect(maintenancePrivileges.rows[0]).toEqual({
      has_schema_create: false,
      has_sequence_access: false,
      has_other_function_execute: false,
    });
    expect(repairedAuthority.rows[0]).toEqual({
      runtime_can_delete_requests: false,
      stale_member_can_update_requests: false,
    });
  });

  it("provisions idempotently and refuses live bootstrap", async () => {
    const replay = await client.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM refunddesk_provision_installation($1, 'test')",
      ["acct_IntegrationA"],
    );
    expect(replay.rows[0]?.tenant_id).toBe(tenantA);

    await client.query("SAVEPOINT before_live");
    await expect(
      client.query("SELECT tenant_id FROM refunddesk_provision_installation($1, 'live')", [
        "acct_IntegrationLive",
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_live");
  });

  it("enforces the web/worker lifecycle boundary against the authenticated login", async () => {
    await client.query("RESET ROLE");
    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SAVEPOINT before_runtime_role_boundary");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const users = await client.query<{ id: string; stripe_user_id: string }>(
      `INSERT INTO tenant_users (
        tenant_id, stripe_user_id, approver_enabled, last_verified_at
      ) VALUES
        ($1, 'usr_RoleRequester', false, statement_timestamp()),
        ($1, 'usr_RoleApprover', true, statement_timestamp()),
        ($1, 'usr_RoleDisabled', false, statement_timestamp())
      RETURNING id, stripe_user_id`,
      [tenantA],
    );
    const requesterId =
      users.rows.find((user) => user.stripe_user_id === "usr_RoleRequester")?.id ?? "";
    const approverId =
      users.rows.find((user) => user.stripe_user_id === "usr_RoleApprover")?.id ?? "";
    const disabledApproverId =
      users.rows.find((user) => user.stripe_user_id === "usr_RoleDisabled")?.id ?? "";
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
    const crossTenantApprover = await client.query<{ id: string }>(
      `INSERT INTO tenant_users (
        tenant_id, stripe_user_id, approver_enabled, last_verified_at
      ) VALUES ($1, 'usr_RoleCrossTenant', true, statement_timestamp())
      RETURNING id`,
      [tenantB],
    );
    const crossTenantApproverId = crossTenantApprover.rows[0]?.id ?? "";
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);

    const insertRequest = async (paymentIntentId: string): Promise<string> => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO refund_requests (
          tenant_id,
          installation_id,
          environment,
          payment_key,
          payment_intent_id,
          amount_minor,
          currency,
          reason,
          justification_ciphertext,
          justification_nonce,
          justification_auth_tag,
          justification_key_version,
          requester_user_id,
          policy_version,
          expires_at
        ) VALUES (
          $1, $2, 'test', $3, $3, 100, 'eur', 'requested_by_customer',
          $4, $5, $6, 'v1', $7, 1, statement_timestamp() + INTERVAL '7 days'
        )
        RETURNING id`,
        [
          tenantA,
          installationA,
          paymentIntentId,
          Buffer.from([1]),
          Buffer.alloc(12),
          Buffer.alloc(16),
          requesterId,
        ],
      );
      return result.rows[0]?.id ?? "";
    };

    const persistApprovalAttestation = async (
      requestId: string,
      approverUserId: string,
      options: {
        readonly requestVersion?: number;
        readonly resourceId?: string;
      } = {},
    ): Promise<string> => {
      await client.query("RESET SESSION AUTHORIZATION");
      await client.query("SET SESSION AUTHORIZATION refunddesk_worker_login");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      const attestation = await client.query<{ id: string }>(
        `INSERT INTO approval_attestations (
          tenant_id,
          installation_id,
          request_id,
          approver_user_id,
          request_nonce,
          stripe_account_id,
          environment,
          resource_type,
          resource_id,
          request_version,
          signed_envelope_hash,
          authorization_snapshot_hash,
          verified_at,
          consume_before,
          hmac_key_version,
          hmac,
          created_at
        )
        SELECT
          request.tenant_id,
          request.installation_id,
          request.id,
          $2::UUID,
          $3::UUID,
          installation.stripe_account_id,
          request.environment,
          'payment_intent',
          COALESCE($4::VARCHAR, request.payment_intent_id),
          COALESCE($5::INTEGER, request.version),
          $6::BYTEA,
          $7::BYTEA,
          statement_timestamp(),
          LEAST(
            statement_timestamp() + INTERVAL '5 minutes',
            request.expires_at
          ),
          'v1',
          $8::BYTEA,
          statement_timestamp()
        FROM refund_requests AS request
        INNER JOIN stripe_installations AS installation
          ON installation.id = request.installation_id
         AND installation.tenant_id = request.tenant_id
         AND installation.environment = request.environment
        WHERE request.id = $1::UUID
          AND request.tenant_id = $9::UUID
        RETURNING id`,
        [
          requestId,
          approverUserId,
          randomUUID(),
          options.resourceId ?? null,
          options.requestVersion ?? null,
          Buffer.alloc(32, 1),
          Buffer.alloc(32, 2),
          Buffer.alloc(32, 3),
          tenantA,
        ],
      );
      await client.query("RESET SESSION AUTHORIZATION");
      await client.query("SET SESSION AUTHORIZATION refunddesk_web_login");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      return attestation.rows[0]?.id ?? "";
    };

    await client.query("SET SESSION AUTHORIZATION refunddesk_web_login");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const privilegeBoundary = await client.query<{
      attestation_read: boolean;
      attestation_write: boolean;
      attempt_read: boolean;
      candidate_read: boolean;
      execution_read: boolean;
      execution_write: boolean;
    }>(
      `SELECT
        has_table_privilege(current_user, 'refund_executions', 'SELECT') AS execution_read,
        has_table_privilege(current_user, 'refund_execution_attempts', 'SELECT') AS attempt_read,
        has_table_privilege(
          current_user,
          'refund_correlation_candidates',
          'SELECT'
        ) AS candidate_read,
        (
          has_table_privilege(current_user, 'refund_executions', 'INSERT')
          OR has_table_privilege(current_user, 'refund_executions', 'UPDATE')
        ) AS execution_write,
        has_table_privilege(
          current_user,
          'approval_attestations',
          'SELECT'
        ) AS attestation_read,
        has_table_privilege(
          current_user,
          'approval_attestations',
          'INSERT'
        ) AS attestation_write`,
    );
    expect(privilegeBoundary.rows[0]).toEqual({
      execution_read: true,
      attempt_read: true,
      candidate_read: false,
      execution_write: false,
      attestation_read: false,
      attestation_write: false,
    });
    const tenantUserUpdatePrivileges = await client.query<{
      allowed_profile_update: boolean;
      created_at_update: boolean;
      stripe_user_id_update: boolean;
      table_update: boolean;
      tenant_id_update: boolean;
    }>(
      `SELECT
         has_table_privilege(current_user, 'tenant_users', 'UPDATE')
           AS table_update,
         has_column_privilege(
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
         ) AS allowed_profile_update,
         has_column_privilege(
           current_user,
           'tenant_users',
           'tenant_id',
           'UPDATE'
         ) AS tenant_id_update,
         has_column_privilege(
           current_user,
           'tenant_users',
           'stripe_user_id',
           'UPDATE'
         ) AS stripe_user_id_update,
         has_column_privilege(
           current_user,
           'tenant_users',
           'created_at',
           'UPDATE'
         ) AS created_at_update`,
    );
    expect(tenantUserUpdatePrivileges.rows[0]).toEqual({
      allowed_profile_update: true,
      created_at_update: false,
      stripe_user_id_update: false,
      table_update: false,
      tenant_id_update: false,
    });
    await client.query("SAVEPOINT before_web_identity_update");
    await expect(
      client.query(
        `UPDATE tenant_users
         SET stripe_user_id = 'usr_Forged'
         WHERE id = $1`,
        [approverId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_web_identity_update");
    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await client.query("SAVEPOINT before_owner_identity_update");
    await expect(
      client.query(
        `UPDATE tenant_users
         SET created_at = created_at - INTERVAL '1 second'
         WHERE id = $1`,
        [approverId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_owner_identity_update");
    await client.query("SET SESSION AUTHORIZATION refunddesk_web_login");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);

    const approvedRequestId = await insertRequest("pi_RoleApproved");
    await client.query("SAVEPOINT before_missing_decision");
    await expect(
      client.query(
        `UPDATE refund_requests
         SET workflow_status = 'approved',
             approved_at = statement_timestamp(),
             version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [approvedRequestId, tenantA],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT before_missing_decision");

    await client.query("SAVEPOINT before_self_decision");
    await expect(
      client.query(
        `INSERT INTO approval_decisions (
          tenant_id, request_id, approver_user_id, decision, stripe_roles_snapshot
        ) VALUES ($1, $2, $3, 'approve', '[]'::JSONB)`,
        [tenantA, approvedRequestId, requesterId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT before_self_decision");

    await client.query("SAVEPOINT before_disabled_decision");
    await expect(
      client.query(
        `INSERT INTO approval_decisions (
          tenant_id, request_id, approver_user_id, decision, stripe_roles_snapshot
        ) VALUES ($1, $2, $3, 'approve', '[]'::JSONB)`,
        [tenantA, approvedRequestId, disabledApproverId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_disabled_decision");

    await client.query("SAVEPOINT before_cross_tenant_decision");
    await expect(
      client.query(
        `INSERT INTO approval_decisions (
          tenant_id, request_id, approver_user_id, decision, stripe_roles_snapshot
        ) VALUES ($1, $2, $3, 'approve', '[]'::JSONB)`,
        [tenantA, approvedRequestId, crossTenantApproverId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_cross_tenant_decision");

    await client.query("SAVEPOINT before_future_decision");
    await expect(
      client.query(
        `INSERT INTO approval_decisions (
          tenant_id,
          request_id,
          approver_user_id,
          decision,
          stripe_roles_snapshot,
          decided_at
        ) VALUES (
          $1, $2, $3, 'approve', '[]'::JSONB, statement_timestamp() + INTERVAL '1 day'
        )`,
        [tenantA, approvedRequestId, approverId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT before_future_decision");

    await client.query("SAVEPOINT before_missing_attestation");
    await expect(
      client.query(
        `INSERT INTO approval_decisions (
          tenant_id, request_id, approver_user_id, decision, stripe_roles_snapshot
        ) VALUES ($1, $2, $3, 'approve', '[]'::JSONB)`,
        [tenantA, approvedRequestId, approverId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT before_missing_attestation");

    const mismatchedAttestationId = await persistApprovalAttestation(
      approvedRequestId,
      approverId,
      { requestVersion: 1 },
    );
    await client.query("SAVEPOINT before_mismatched_attestation");
    await expect(
      client.query(
        `INSERT INTO approval_decisions (
          tenant_id,
          request_id,
          approver_user_id,
          approval_attestation_id,
          decision,
          stripe_roles_snapshot
        ) VALUES ($1, $2, $3, $4, 'approve', '[]'::JSONB)`,
        [tenantA, approvedRequestId, approverId, mismatchedAttestationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT before_mismatched_attestation");

    const approvalAttestationId = await persistApprovalAttestation(approvedRequestId, approverId);
    await client.query(
      `INSERT INTO approval_decisions (
        tenant_id,
        request_id,
        approver_user_id,
        approval_attestation_id,
        decision,
        stripe_roles_snapshot,
        decided_at
      ) VALUES (
        $1, $2, $3, $4, 'approve', '[]'::JSONB, statement_timestamp()
      )`,
      [tenantA, approvedRequestId, approverId, approvalAttestationId],
    );
    await expect(
      client.query(
        `UPDATE refund_requests
         SET workflow_status = 'approved',
             approved_at = statement_timestamp(),
             version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [approvedRequestId, tenantA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await expect(assertExecutableApprovalAttestationCoverage(client)).resolves.toBeUndefined();
    await client.query("SAVEPOINT before_unattested_executable_approval");
    await client.query("ALTER TABLE approval_decisions DISABLE TRIGGER USER");
    await client.query(
      `UPDATE approval_decisions
          SET approval_attestation_id = NULL
        WHERE tenant_id = $1
          AND request_id = $2
          AND decision = 'approve'`,
      [tenantA, approvedRequestId],
    );
    await expect(assertExecutableApprovalAttestationCoverage(client)).rejects.toThrow(
      "DATABASE_EXECUTABLE_APPROVAL_ATTESTATION_MISSING",
    );
    await client.query("ROLLBACK TO SAVEPOINT before_unattested_executable_approval");
    await expect(assertExecutableApprovalAttestationCoverage(client)).resolves.toBeUndefined();
    await client.query("SAVEPOINT before_attestation_mutation");
    await expect(
      client.query(
        `UPDATE approval_attestations
         SET consume_before = consume_before + INTERVAL '1 second'
         WHERE id = $1`,
        [approvalAttestationId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_attestation_mutation");
    await client.query("SET SESSION AUTHORIZATION refunddesk_web_login");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);

    await client.query("SAVEPOINT before_web_execution_transition");
    await expect(
      client.query(
        `UPDATE refund_requests
         SET workflow_status = 'executing',
             execution_started_at = statement_timestamp(),
             version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [approvedRequestId, tenantA],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_web_execution_transition");

    await client.query("SAVEPOINT before_web_execution_insert");
    await expect(
      client.query("INSERT INTO refund_executions DEFAULT VALUES"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await client.query("ROLLBACK TO SAVEPOINT before_web_execution_insert");

    const rejectedRequestId = await insertRequest("pi_RoleRejected");
    await client.query(
      `INSERT INTO approval_decisions (
        tenant_id,
        request_id,
        approver_user_id,
        decision,
        rejection_ciphertext,
        rejection_nonce,
        rejection_auth_tag,
        rejection_key_version,
        stripe_roles_snapshot
      ) VALUES ($1, $2, $3, 'reject', $4, $5, $6, 'v1', '[]'::JSONB)`,
      [
        tenantA,
        rejectedRequestId,
        approverId,
        Buffer.from([1]),
        Buffer.alloc(12),
        Buffer.alloc(16),
      ],
    );
    await expect(
      client.query(
        `UPDATE refund_requests
         SET workflow_status = 'rejected',
             terminal_at = statement_timestamp(),
             payment_guard_released_at = statement_timestamp(),
             version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [rejectedRequestId, tenantA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    const canceledRequestId = await insertRequest("pi_RoleCanceled");
    await expect(
      client.query(
        `UPDATE refund_requests
         SET workflow_status = 'canceled',
             terminal_at = statement_timestamp(),
             payment_guard_released_at = statement_timestamp(),
             version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [canceledRequestId, tenantA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SET SESSION AUTHORIZATION refunddesk_worker_login");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const workerAttestationPrivileges = await client.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
    }>(
      `SELECT
         has_table_privilege(
           current_user,
           'approval_attestations',
           'SELECT'
         ) AS can_select,
         has_table_privilege(
           current_user,
           'approval_attestations',
           'INSERT'
         ) AS can_insert,
         has_table_privilege(
           current_user,
           'approval_attestations',
           'UPDATE'
         ) AS can_update,
         has_table_privilege(
           current_user,
           'approval_attestations',
           'DELETE'
         ) AS can_delete`,
    );
    expect(workerAttestationPrivileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
    });
    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SET SESSION AUTHORIZATION refunddesk_queue_login");
    const queuePublicPrivileges = await client.query<{
      parent_roles: string[];
      public_relation_access: boolean;
      public_usage: boolean;
    }>(
      `SELECT
         ARRAY(
           SELECT parent.rolname::text
           FROM pg_auth_members AS membership
           INNER JOIN pg_roles AS parent ON parent.oid = membership.roleid
           WHERE membership.member = (
             SELECT oid FROM pg_roles WHERE rolname = current_user
           )
           ORDER BY parent.rolname
         ) AS parent_roles,
         has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
         EXISTS (
           SELECT 1
           FROM pg_class AS relation
           INNER JOIN pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = 'public'
             AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND has_table_privilege(
               current_user,
               relation.oid,
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
             )
         ) AS public_relation_access`,
    );
    expect(queuePublicPrivileges.rows[0]).toEqual({
      parent_roles: ["refunddesk_queue"],
      public_relation_access: false,
      public_usage: false,
    });
    await client.query("SAVEPOINT before_queue_financial_read");
    await expect(
      client.query("SELECT id FROM public.refund_requests LIMIT 1"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await client.query("ROLLBACK TO SAVEPOINT before_queue_financial_read");
    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SET SESSION AUTHORIZATION refunddesk_maintenance_login");
    const maintenanceLogin = await client.query<{
      parent_roles: string[];
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
      can_list_due_purges: boolean;
      can_guarded_purge: boolean;
      can_raw_purge: boolean;
      pgboss_create: boolean;
      pgboss_usage: boolean;
    }>(
      `SELECT
         ARRAY(
           SELECT parent.rolname::text
           FROM pg_auth_members AS membership
           INNER JOIN pg_roles AS parent ON parent.oid = membership.roleid
           WHERE membership.member = (
             SELECT oid FROM pg_roles WHERE rolname = current_user
           )
           ORDER BY parent.rolname
         ) AS parent_roles,
         role.rolsuper,
         role.rolcreatedb,
         role.rolcreaterole,
         role.rolreplication,
         role.rolbypassrls,
         has_schema_privilege(current_user, 'pgboss', 'USAGE')
           AS pgboss_usage,
         has_schema_privilege(current_user, 'pgboss', 'CREATE')
           AS pgboss_create,
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
         ) AS can_raw_purge
       FROM pg_roles AS role
       WHERE role.rolname = current_user`,
    );
    expect(maintenanceLogin.rows[0]).toEqual({
      parent_roles: ["refunddesk_maintenance"],
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      pgboss_usage: false,
      pgboss_create: false,
      can_list_due_purges: true,
      can_guarded_purge: true,
      can_raw_purge: false,
    });
    await client.query("SAVEPOINT before_maintenance_financial_read");
    await expect(
      client.query("SELECT id FROM public.refund_requests LIMIT 1"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await client.query("ROLLBACK TO SAVEPOINT before_maintenance_financial_read");
    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SET SESSION AUTHORIZATION refunddesk_worker_login");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await client.query(
      `UPDATE refund_requests
       SET workflow_status = 'executing',
           execution_started_at = statement_timestamp(),
           version = version + 1
       WHERE id = $1 AND tenant_id = $2`,
      [approvedRequestId, tenantA],
    );
    const execution = await client.query<{ id: string }>(
      `INSERT INTO refund_executions (
        tenant_id,
        request_id,
        idempotency_key,
        canonical_parameters_hash,
        amount_minor,
        currency
      ) VALUES (
        $1::UUID,
        $2::UUID,
        'refunddesk:refund-request:' || $2::UUID::TEXT || ':v1',
        $3,
        100,
        'eur'
      )
      RETURNING id`,
      [tenantA, approvedRequestId, Buffer.alloc(32, 7)],
    );
    const executionId = execution.rows[0]?.id ?? "";
    await client.query(
      `INSERT INTO refund_execution_attempts (
        tenant_id, execution_id, attempt_number, state
      ) VALUES ($1, $2, 1, 'started')`,
      [tenantA, executionId],
    );

    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SET SESSION AUTHORIZATION refunddesk_web_login");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    expect(
      (
        await client.query(
          `SELECT execution.id, attempt.id AS attempt_id
           FROM refund_executions AS execution
           INNER JOIN refund_execution_attempts AS attempt
             ON attempt.execution_id = execution.id
            AND attempt.tenant_id = execution.tenant_id
           WHERE execution.id = $1`,
          [executionId],
        )
      ).rowCount,
    ).toBe(1);

    await client.query("SAVEPOINT before_candidate_read");
    await expect(
      client.query("SELECT id FROM refund_correlation_candidates"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await client.query("ROLLBACK TO SAVEPOINT before_candidate_read");
    await client.query("SAVEPOINT before_execution_update");
    await expect(
      client.query(
        "UPDATE refund_executions SET updated_at = statement_timestamp() WHERE id = $1",
        [executionId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_execution_update");
    await client.query("SAVEPOINT before_attempt_insert");
    await expect(
      client.query("INSERT INTO refund_execution_attempts DEFAULT VALUES"),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_attempt_insert");
    await client.query("SAVEPOINT before_candidate_insert");
    await expect(
      client.query("INSERT INTO refund_correlation_candidates DEFAULT VALUES"),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_candidate_insert");

    await client.query("RESET SESSION AUTHORIZATION");
    await client.query(
      `UPDATE stripe_installations
       SET status = 'deauthorized', deauthorized_at = statement_timestamp()
       WHERE id = $1`,
      [installationA],
    );
    await client.query("SET SESSION AUTHORIZATION refunddesk_web_login");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await expect(
      client.query(
        `UPDATE refund_requests
         SET workflow_status = 'failed_terminal',
             effect_state = 'absence_proven',
             terminal_at = statement_timestamp(),
             payment_guard_released_at = statement_timestamp(),
             version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [approvedRequestId, tenantA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("ROLLBACK TO SAVEPOINT before_runtime_role_boundary");
    await client.query("SET ROLE refunddesk_runtime");
  });

  it("fails closed without a tenant and isolates tenant A from B", async () => {
    await client.query("SELECT set_config('app.tenant_id', '', true)");
    const withoutContext = await client.query("SELECT id FROM tenants");
    expect(withoutContext.rowCount).toBe(0);

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const tenantRows = await client.query<{ id: string }>("SELECT id FROM tenants");
    expect(tenantRows.rows).toEqual([{ id: tenantA }]);
    expect(tenantRows.rows.some((row) => row.id === tenantB)).toBe(false);
  });

  it("denies direct runtime and maintenance table access", async () => {
    const insertAudit = async (tenantId: string, entityId: string): Promise<void> => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO audit_events (
          tenant_id, actor_type, action, entity_type, entity_id, correlation_request_id
        ) VALUES ($1, 'system', 'integration.test', 'tenant', $2, $3)`,
        [tenantId, entityId, "ca3872bc-01b8-4df3-b649-e81a22c31c5e"],
      );
    };
    await insertAudit(tenantA, "tenant-a");
    await insertAudit(tenantB, "tenant-b");

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await client.query("SAVEPOINT before_runtime_delete");
    await expect(client.query("DELETE FROM audit_events")).rejects.toMatchObject({
      code: "42501",
    });
    await client.query("ROLLBACK TO SAVEPOINT before_runtime_delete");

    await client.query("SET ROLE refunddesk_maintenance");
    await client.query("SAVEPOINT before_maintenance_read");
    await expect(client.query("SELECT id FROM audit_events")).rejects.toMatchObject({
      code: "42501",
    });
    await client.query("ROLLBACK TO SAVEPOINT before_maintenance_read");
    await client.query("SAVEPOINT before_maintenance_delete");
    await expect(client.query("DELETE FROM audit_events")).rejects.toMatchObject({
      code: "42501",
    });
    await client.query("ROLLBACK TO SAVEPOINT before_maintenance_delete");

    await client.query("SET ROLE refunddesk_runtime");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
    const tenantBEvents = await client.query("SELECT id FROM audit_events");
    expect(tenantBEvents.rowCount).toBe(1);
  });

  it("exposes only the durable signed-request capacity function to the web runtime", async () => {
    await client.query("RESET ROLE");
    const privileges = await client.query<{
      maintenance_execute: boolean;
      public_execute: boolean;
      queue_execute: boolean;
      web_direct_table_access: boolean;
      web_execute: boolean;
      worker_direct_table_access: boolean;
      worker_execute: boolean;
    }>(
      `SELECT
         has_function_privilege(
           'refunddesk_web_login',
           'public.refunddesk_consume_signed_request_rate_limit(character varying,public.stripe_environment,character varying)',
           'EXECUTE'
         ) AS web_execute,
         has_function_privilege(
           'refunddesk_worker_login',
           'public.refunddesk_consume_signed_request_rate_limit(character varying,public.stripe_environment,character varying)',
           'EXECUTE'
         ) AS worker_execute,
         has_function_privilege(
           'refunddesk_queue_login',
           'public.refunddesk_consume_signed_request_rate_limit(character varying,public.stripe_environment,character varying)',
           'EXECUTE'
         ) AS queue_execute,
         has_function_privilege(
           'refunddesk_maintenance_login',
           'public.refunddesk_consume_signed_request_rate_limit(character varying,public.stripe_environment,character varying)',
           'EXECUTE'
         ) AS maintenance_execute,
         EXISTS (
           SELECT 1
           FROM pg_catalog.pg_proc AS routine
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
           ) AS privilege
           WHERE routine.oid =
             'public.refunddesk_consume_signed_request_rate_limit(character varying,public.stripe_environment,character varying)'::REGPROCEDURE
             AND privilege.grantee = 0
             AND privilege.privilege_type = 'EXECUTE'
         ) AS public_execute,
         has_table_privilege(
           'refunddesk_web_login',
           'signed_request_rate_limit_buckets',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
         ) AS web_direct_table_access,
         has_table_privilege(
           'refunddesk_worker_login',
           'signed_request_rate_limit_buckets',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
         ) AS worker_direct_table_access`,
    );
    expect(privileges.rows[0]).toEqual({
      maintenance_execute: false,
      public_execute: false,
      queue_execute: false,
      web_direct_table_access: false,
      web_execute: true,
      worker_direct_table_access: false,
      worker_execute: false,
    });

    await client.query("SET ROLE refunddesk_runtime");
    const consumeBurst = (attempts: number, accountId: string, requestClass: "mutation" | "read") =>
      client.query<{ allowed: boolean; retry_after_seconds: number | null }>(
        `SELECT decision.allowed, decision.retry_after_seconds
         FROM generate_series(1, $1::INTEGER) AS attempt(sequence)
         CROSS JOIN LATERAL refunddesk_consume_signed_request_rate_limit(
           ($2::TEXT || pg_catalog.repeat('', attempt.sequence))::VARCHAR,
           'test',
           $3::VARCHAR
         ) AS decision`,
        [attempts, accountId, requestClass],
      );
    const mutationDecisions = await consumeBurst(31, "acct_SecurityLimiterMutation", "mutation");
    const readDecisions = await consumeBurst(61, "acct_SecurityLimiterRead", "read");
    for (const [decisions, capacity] of [
      [mutationDecisions.rows, 30],
      [readDecisions.rows, 60],
    ] as const) {
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(capacity);
      const denied = decisions.filter((decision) => !decision.allowed);
      expect(denied).toHaveLength(1);
      expect(denied[0]?.retry_after_seconds).toBeGreaterThanOrEqual(1);
    }

    await client.query("RESET ROLE");
    const refillBoundary = await client.query(
      `WITH observed AS (
         SELECT pg_catalog.clock_timestamp() AS at
       ), scope(account_id, request_class, tolerated_debt) AS (
         VALUES
           ('acct_SecurityLimiterMutation', 'mutation', INTERVAL '58 seconds'),
           ('acct_SecurityLimiterRead', 'read', INTERVAL '59 seconds')
       )
       UPDATE signed_request_rate_limit_buckets AS bucket
       SET
         theoretical_arrival_at = observed.at + scope.tolerated_debt,
         last_seen_at = observed.at
       FROM observed, scope
       WHERE bucket.scope_key = public.digest(
         pg_catalog.convert_to(
           scope.account_id || ':test:' || scope.request_class,
           'UTF8'
         ),
         'sha256'
       )`,
    );
    expect(refillBoundary.rowCount).toBe(2);

    await client.query("SET ROLE refunddesk_runtime");
    await expect(
      client.query(
        `SELECT allowed, retry_after_seconds
         FROM refunddesk_consume_signed_request_rate_limit(
           'acct_SecurityLimiterMutation',
           'test',
           'mutation'
         )`,
      ),
    ).resolves.toMatchObject({ rows: [{ allowed: true, retry_after_seconds: null }] });
    await expect(
      client.query(
        `SELECT allowed, retry_after_seconds
         FROM refunddesk_consume_signed_request_rate_limit(
           'acct_SecurityLimiterRead',
           'test',
           'read'
         )`,
      ),
    ).resolves.toMatchObject({ rows: [{ allowed: true, retry_after_seconds: null }] });

    await client.query("SAVEPOINT before_invalid_rate_limit_scope");
    await expect(
      client.query(
        `SELECT allowed
         FROM refunddesk_consume_signed_request_rate_limit(
           'invalid_account',
           'test',
           'mutation'
         )`,
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await client.query("ROLLBACK TO SAVEPOINT before_invalid_rate_limit_scope");

    await client.query("SAVEPOINT before_rate_limit_table_read");
    await expect(
      client.query("SELECT scope_key FROM signed_request_rate_limit_buckets"),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_rate_limit_table_read");
  });

  it("selects due tenants with explicit blockers and keeps eligible tenants first", async () => {
    const deauthorizedAt = new Date("2020-03-01T12:00:00.000Z");
    const pendingDeleteAt = new Date(deauthorizedAt.getTime() + 30 * 24 * 60 * 60 * 1_000);
    const eligibleTenantId = randomUUID();
    const heldTenantId = randomUUID();
    const unresolvedTenantId = randomUUID();
    const liveTenantId = randomUUID();
    const eligibleInstallationId = randomUUID();
    const heldInstallationId = randomUUID();
    const unresolvedInstallationId = randomUUID();
    const liveInstallationId = randomUUID();

    await client.query("RESET ROLE");
    await client.query(
      `INSERT INTO tenants (id, status, pending_delete_at, legal_hold_at)
       VALUES
         ($1, 'pending_deletion', $5, NULL),
         ($2, 'pending_deletion', $5, statement_timestamp()),
         ($3, 'pending_deletion', $5, NULL),
         ($4, 'pending_deletion', $5, NULL)`,
      [eligibleTenantId, heldTenantId, unresolvedTenantId, liveTenantId, pendingDeleteAt],
    );
    await client.query(
      `INSERT INTO stripe_installations (
         id,
         tenant_id,
         stripe_account_id,
         environment,
         status,
         deauthorized_at
       )
       VALUES
         ($1, $5, 'acct_RetentionEligible', 'test', 'deauthorized', $9),
         ($2, $6, 'acct_RetentionHeld', 'sandbox', 'deauthorized', $9),
         ($3, $7, 'acct_RetentionUnresolved', 'test', 'deauthorized', $9),
         ($4, $8, 'acct_RetentionLive', 'live', 'deauthorized', $9)`,
      [
        eligibleInstallationId,
        heldInstallationId,
        unresolvedInstallationId,
        liveInstallationId,
        eligibleTenantId,
        heldTenantId,
        unresolvedTenantId,
        liveTenantId,
        deauthorizedAt,
      ],
    );
    await client.query(
      `INSERT INTO reconciliation_checkpoints (
         tenant_id,
         installation_id,
         committed_through,
         scan_window_end,
         page_in_progress
       )
       VALUES ($1, $2, $3, $4, true)`,
      [
        unresolvedTenantId,
        unresolvedInstallationId,
        new Date("2020-02-27T12:00:00.000Z"),
        new Date("2020-02-28T12:00:00.000Z"),
      ],
    );

    await client.query("SET ROLE refunddesk_runtime");
    await client.query("SAVEPOINT before_runtime_retention_list");
    await expect(
      client.query("SELECT tenant_id FROM refunddesk_list_due_tenant_purges(100)"),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_runtime_retention_list");

    await client.query("SET ROLE refunddesk_maintenance");
    await client.query("SAVEPOINT before_invalid_retention_limit");
    await expect(
      client.query("SELECT tenant_id FROM refunddesk_list_due_tenant_purges(0)"),
    ).rejects.toMatchObject({ code: "22023" });
    await client.query("ROLLBACK TO SAVEPOINT before_invalid_retention_limit");

    const candidates = await client.query<{
      blocker_reason: string | null;
      overdue_seconds: string;
      tenant_id: string;
    }>(
      `SELECT tenant_id::text, blocker_reason::text, overdue_seconds::text
       FROM refunddesk_list_due_tenant_purges(100)`,
    );
    const candidatesById = new Map(candidates.rows.map((row) => [row.tenant_id, row]));
    expect(candidates.rows[0]?.tenant_id).toBe(eligibleTenantId);
    expect(candidatesById.get(eligibleTenantId)?.blocker_reason).toBeNull();
    expect(candidatesById.get(heldTenantId)?.blocker_reason).toBe("legal_hold");
    expect(candidatesById.get(unresolvedTenantId)?.blocker_reason).toBe("checkpoint_state");
    expect(candidatesById.get(liveTenantId)?.blocker_reason).toBe("installation_state");
    expect(candidates.rows.every((row) => Number.parseInt(row.overdue_seconds, 10) >= 0)).toBe(
      true,
    );

    await client.query("SAVEPOINT before_raw_maintenance_purge");
    await expect(
      client.query("SELECT result FROM refunddesk_purge_tenant($1, $2)", [
        liveTenantId,
        "v1.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_raw_maintenance_purge");

    await client.query("SAVEPOINT before_live_automatic_purge");
    await expect(
      client.query("SELECT result FROM refunddesk_purge_test_sandbox_tenant($1, $2)", [
        liveTenantId,
        "v1.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT before_live_automatic_purge");

    const purged = await client.query<{ result: string }>(
      "SELECT result FROM refunddesk_purge_test_sandbox_tenant($1, $2)",
      [eligibleTenantId, "v1.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"],
    );
    expect(purged.rows).toEqual([{ result: "completed" }]);

    await client.query("RESET ROLE");
    const preserved = await client.query<{ id: string }>(
      "SELECT id::text FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[heldTenantId, unresolvedTenantId, liveTenantId]],
    );
    expect(new Set(preserved.rows.map((row) => row.id))).toEqual(
      new Set([heldTenantId, unresolvedTenantId, liveTenantId]),
    );
    await client.query("SET ROLE refunddesk_runtime");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
  });

  it("purges only a due, hold-free tenant and returns an idempotent non-personal certificate", async () => {
    const pseudonym = "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const deauthorizedAt = new Date("2020-01-01T12:00:00.000Z");
    await client.query("SET ROLE refunddesk_runtime");
    const provision = await client.query<{ tenant_id: string; installation_id: string }>(
      "SELECT tenant_id, installation_id FROM refunddesk_provision_installation($1, 'test')",
      ["acct_PurgeIntegration"],
    );
    const purgeTenantId = provision.rows[0]?.tenant_id ?? "";
    const purgeInstallationId = provision.rows[0]?.installation_id ?? "";
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [purgeTenantId]);
    const purgeUsers = await client.query<{ id: string; stripe_user_id: string }>(
      `INSERT INTO tenant_users (
        tenant_id,
        stripe_user_id,
        approver_enabled,
        last_verified_at
      ) VALUES
        ($1, 'usr_PurgeRequester', false, statement_timestamp()),
        ($1, 'usr_PurgeApprover', true, statement_timestamp())
      RETURNING id, stripe_user_id`,
      [purgeTenantId],
    );
    const purgeRequesterId =
      purgeUsers.rows.find((user) => user.stripe_user_id === "usr_PurgeRequester")?.id ?? "";
    const purgeApproverId =
      purgeUsers.rows.find((user) => user.stripe_user_id === "usr_PurgeApprover")?.id ?? "";
    const purgeRequest = await client.query<{ id: string }>(
      `INSERT INTO refund_requests (
        tenant_id,
        installation_id,
        environment,
        payment_key,
        payment_intent_id,
        amount_minor,
        currency,
        reason,
        justification_ciphertext,
        justification_nonce,
        justification_auth_tag,
        justification_key_version,
        requester_user_id,
        policy_version,
        expires_at
      ) VALUES (
        $1, $2, 'test', 'pi_PurgeCertificate', 'pi_PurgeCertificate',
        100, 'eur', 'requested_by_customer', $3, $4, $5, 'v1', $6, 1,
        statement_timestamp() + INTERVAL '7 days'
      )
      RETURNING id`,
      [
        purgeTenantId,
        purgeInstallationId,
        Buffer.from([1]),
        Buffer.alloc(12),
        Buffer.alloc(16),
        purgeRequesterId,
      ],
    );
    const purgeRequestId = purgeRequest.rows[0]?.id ?? "";
    await client.query("RESET ROLE");
    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SET SESSION AUTHORIZATION refunddesk_worker_login");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [purgeTenantId]);
    await client.query(
      `INSERT INTO approval_attestations (
        tenant_id,
        installation_id,
        request_id,
        approver_user_id,
        request_nonce,
        stripe_account_id,
        environment,
        resource_type,
        resource_id,
        request_version,
        signed_envelope_hash,
        authorization_snapshot_hash,
        verified_at,
        consume_before,
        hmac_key_version,
        hmac,
        created_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'acct_PurgeIntegration', 'test',
        'payment_intent', 'pi_PurgeCertificate', 0, $6, $7,
        statement_timestamp(), statement_timestamp() + INTERVAL '5 minutes',
        'v1', $8, statement_timestamp()
      )`,
      [
        purgeTenantId,
        purgeInstallationId,
        purgeRequestId,
        purgeApproverId,
        randomUUID(),
        Buffer.alloc(32, 1),
        Buffer.alloc(32, 2),
        Buffer.alloc(32, 3),
      ],
    );
    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("SET ROLE refunddesk_runtime");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [purgeTenantId]);
    await client.query(
      `UPDATE refund_requests
       SET workflow_status = 'canceled',
           terminal_at = statement_timestamp(),
           payment_guard_released_at = statement_timestamp(),
           version = version + 1
       WHERE id = $1`,
      [purgeRequestId],
    );
    await client.query(
      `INSERT INTO audit_events (
        tenant_id, actor_type, action, entity_type, entity_id, correlation_request_id
      ) VALUES ($1, 'system', 'purge.fixture', 'tenant', 'internal-fixture', $2)`,
      [purgeTenantId, "70d9f9b8-1e75-4314-97f5-271ca5ca5a2b"],
    );
    await client.query(
      `INSERT INTO external_refund_alerts (
         tenant_id,
         installation_id,
         environment,
         stripe_refund_id,
         stripe_refund_created_at,
         payment_key,
         amount_minor,
         currency,
         classification,
         detected_at
       )
       VALUES (
         $1,
         $2,
         'test',
         're_PurgeExternalAlert',
         statement_timestamp() - INTERVAL '1 minute',
         'pi_PurgeCertificate',
         100,
         'eur',
         'external',
         statement_timestamp()
       )`,
      [purgeTenantId, purgeInstallationId],
    );

    await client.query("SET ROLE refunddesk_worker");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [purgeTenantId]);
    await client.query(
      `UPDATE stripe_installations
       SET status = 'deauthorized', deauthorized_at = $2
       WHERE id = $1`,
      [purgeInstallationId, deauthorizedAt],
    );
    await client.query(
      `UPDATE tenants
       SET status = 'pending_deletion', pending_delete_at = $2
       WHERE id = $1`,
      [purgeTenantId, new Date(deauthorizedAt.getTime() + 30 * 24 * 60 * 60 * 1_000)],
    );

    await client.query("RESET ROLE");
    const activeTenantJobId = randomUUID();
    const tenantWebhookJobId = randomUUID();
    const foreignTenantJobId = randomUUID();
    const globalRecoveryJobId = randomUUID();
    const purgeWebhookReceipt = await client.query<{ id: string }>(
      `INSERT INTO webhook_receipts (
         tenant_id,
         installation_id,
         endpoint,
         stripe_event_id,
         stripe_account_id,
         event_type,
         object_id,
         normalized_payload,
         stripe_created_at,
         status,
         processed_at
       ) VALUES (
         $1,
         $2,
         'account_test',
         'evt_PurgeQueueReceipt',
         'acct_PurgeIntegration',
         'account.application.deauthorized',
         'ca_PurgeQueueReceipt',
         '{}'::JSONB,
         statement_timestamp(),
         'processed',
         statement_timestamp()
       )
       RETURNING id::TEXT`,
      [purgeTenantId, purgeInstallationId],
    );
    const purgeWebhookReceiptId = purgeWebhookReceipt.rows[0]?.id ?? "";
    await client.query(
      `INSERT INTO pgboss.job (id, name, data, state)
       VALUES
         (
           $1,
           'refunddesk_refund_execute',
           jsonb_build_object('tenant_id', $4::TEXT, 'request_id', $5::TEXT),
           'active'
         ),
         (
           $2,
           'refunddesk_webhook_process',
           jsonb_build_object(
             'tenant_id',
             $4::TEXT,
             'installation_id',
             $6::TEXT,
             'receipt_id',
             $7::TEXT
           ),
           'completed'
         ),
         (
           $3,
           'refunddesk_refund_execute',
           jsonb_build_object(
             'tenant_id',
             $8::TEXT,
             'request_id',
             $9::TEXT
           ),
           'completed'
         ),
         (
           $10,
           'refunddesk_approved_recovery',
           jsonb_build_object('scope', 'approved'),
           'created'
         )`,
      [
        activeTenantJobId,
        tenantWebhookJobId,
        foreignTenantJobId,
        purgeTenantId,
        purgeRequestId,
        purgeInstallationId,
        purgeWebhookReceiptId,
        tenantB,
        randomUUID(),
        globalRecoveryJobId,
      ],
    );
    await client.query("UPDATE tenants SET legal_hold_at = statement_timestamp() WHERE id = $1", [
      purgeTenantId,
    ]);
    await client.query("SET ROLE refunddesk_maintenance");
    await client.query("SAVEPOINT before_held_purge");
    await expect(
      client.query("SELECT * FROM refunddesk_purge_test_sandbox_tenant($1, $2)", [
        purgeTenantId,
        pseudonym,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT before_held_purge");

    await client.query("RESET ROLE");
    await client.query("UPDATE tenants SET legal_hold_at = NULL WHERE id = $1", [purgeTenantId]);
    await client.query("SET ROLE refunddesk_runtime");
    await client.query("SAVEPOINT before_runtime_purge");
    await expect(
      client.query("SELECT * FROM refunddesk_purge_test_sandbox_tenant($1, $2)", [
        purgeTenantId,
        pseudonym,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_runtime_purge");

    await client.query("RESET ROLE");
    await client.query("UPDATE pgboss.version SET version = 36");
    await client.query("SET ROLE refunddesk_maintenance");
    await client.query("SAVEPOINT before_unsupported_queue_schema");
    await expect(
      client.query("SELECT * FROM refunddesk_purge_test_sandbox_tenant($1, $2)", [
        purgeTenantId,
        pseudonym,
      ]),
    ).rejects.toMatchObject({ code: "RDQ01" });
    await client.query("ROLLBACK TO SAVEPOINT before_unsupported_queue_schema");

    await client.query("RESET ROLE");
    await client.query("UPDATE pgboss.version SET version = 37");
    await client.query("SET ROLE refunddesk_maintenance");
    await client.query("SAVEPOINT before_active_queue_purge");
    await expect(
      client.query("SELECT * FROM refunddesk_purge_test_sandbox_tenant($1, $2)", [
        purgeTenantId,
        pseudonym,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT before_active_queue_purge");

    await client.query("RESET ROLE");
    await client.query("UPDATE pgboss.job SET state = 'completed' WHERE id = $1", [
      activeTenantJobId,
    ]);
    await client.query(
      `INSERT INTO pgboss.job_dependency (
         child_name,
         child_id,
         parent_name,
         parent_id
       ) VALUES (
         'refunddesk_refund_execute',
         $1,
         'refunddesk_approved_recovery',
         $2
       )`,
      [activeTenantJobId, globalRecoveryJobId],
    );
    await client.query("SET ROLE refunddesk_maintenance");
    await client.query("SAVEPOINT before_dependent_queue_purge");
    await expect(
      client.query("SELECT * FROM refunddesk_purge_test_sandbox_tenant($1, $2)", [
        purgeTenantId,
        pseudonym,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT before_dependent_queue_purge");

    await client.query("RESET ROLE");
    await client.query(
      `DELETE FROM pgboss.job_dependency
       WHERE child_name = 'refunddesk_refund_execute'
         AND child_id = $1`,
      [activeTenantJobId],
    );
    const crossedTenantJobId = randomUUID();
    await client.query(
      `INSERT INTO pgboss.job (id, name, data, state)
       VALUES (
         $1,
         'refunddesk_refund_execute',
         jsonb_build_object('tenant_id', $2::TEXT, 'request_id', $3::TEXT),
         'completed'
       )`,
      [crossedTenantJobId, tenantB, purgeRequestId],
    );
    await client.query("SET ROLE refunddesk_maintenance");
    await client.query("SAVEPOINT before_crossed_queue_purge");
    await expect(
      client.query("SELECT * FROM refunddesk_purge_test_sandbox_tenant($1, $2)", [
        purgeTenantId,
        pseudonym,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT before_crossed_queue_purge");

    await client.query("RESET ROLE");
    const crossedJobs = await client.query<{ count: number }>(
      "SELECT count(*)::INTEGER AS count FROM pgboss.job WHERE id = $1",
      [crossedTenantJobId],
    );
    expect(crossedJobs.rows).toEqual([{ count: 1 }]);
    await client.query("DELETE FROM pgboss.job WHERE id = $1", [crossedTenantJobId]);

    await client.query("SET ROLE refunddesk_maintenance");
    const purged = await client.query<{
      certificate_id: string;
      deleted_counts: Readonly<Record<string, number>>;
      process_version: string;
      result: string;
      tenant_pseudonym: string;
    }>("SELECT * FROM refunddesk_purge_test_sandbox_tenant($1, $2)", [purgeTenantId, pseudonym]);
    expect(purged.rows[0]).toMatchObject({
      tenant_pseudonym: pseudonym,
      process_version: "db-purge-v3",
      result: "completed",
      deleted_counts: {
        approval_attestations: 1,
        audit_events: 1,
        external_alerts: 1,
        installations: 1,
        queued_jobs: 2,
        requests: 1,
        tenants: 1,
        users: 2,
      },
    });
    const automaticReplay = await client.query<{ certificate_id: string }>(
      "SELECT certificate_id FROM refunddesk_purge_test_sandbox_tenant($1, $2)",
      [purgeTenantId, pseudonym],
    );
    expect(automaticReplay.rows).toEqual([{ certificate_id: purged.rows[0]?.certificate_id }]);

    await client.query("RESET ROLE");
    const queueRowsAfterPurge = await client.query<{ id: string }>(
      `SELECT id::TEXT
       FROM pgboss.job
       WHERE id = ANY($1::UUID[])
       ORDER BY id`,
      [[activeTenantJobId, tenantWebhookJobId, foreignTenantJobId, globalRecoveryJobId]],
    );
    expect(new Set(queueRowsAfterPurge.rows.map((row) => row.id))).toEqual(
      new Set([foreignTenantJobId, globalRecoveryJobId]),
    );
    const replay = await client.query<{ certificate_id: string }>(
      "SELECT certificate_id FROM refunddesk_purge_tenant($1, $2)",
      [purgeTenantId, pseudonym],
    );
    expect(replay.rows[0]?.certificate_id).toBe(purged.rows[0]?.certificate_id);

    const certificate = await client.query(
      `SELECT tenant_pseudonym, process_version, deleted_counts, result
       FROM purge_certificates
       WHERE id = $1`,
      [purged.rows[0]?.certificate_id],
    );
    expect(certificate.rows[0]).toMatchObject({
      process_version: "db-purge-v3",
      deleted_counts: {
        approval_attestations: 1,
        external_alerts: 1,
        queued_jobs: 2,
      },
    });
    expect(JSON.stringify(certificate.rows[0])).not.toMatch(/acct_|usr_|pi_|ch_|re_|evt_/u);
    await client.query("SET ROLE refunddesk_runtime");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
    const unaffected = await client.query("SELECT id FROM tenants");
    expect(unaffected.rows).toEqual([{ id: tenantB }]);
  });

  it("refuses purge while any payment guard remains active", async () => {
    const pseudonym = "v1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const deauthorizedAt = new Date("2020-02-01T12:00:00.000Z");
    await client.query("SET ROLE refunddesk_runtime");
    const provision = await client.query<{ tenant_id: string; installation_id: string }>(
      "SELECT tenant_id, installation_id FROM refunddesk_provision_installation($1, 'sandbox')",
      ["acct_GuardedPurge"],
    );
    const guardedTenantId = provision.rows[0]?.tenant_id ?? "";
    const guardedInstallationId = provision.rows[0]?.installation_id ?? "";
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [guardedTenantId]);
    const users = await client.query<{ id: string; stripe_user_id: string }>(
      `INSERT INTO tenant_users (
        tenant_id, stripe_user_id, approver_enabled, last_verified_at
      ) VALUES
        ($1, 'usr_PurgeRequester', false, statement_timestamp()),
        ($1, 'usr_PurgeApprover', true, statement_timestamp())
      RETURNING id, stripe_user_id`,
      [guardedTenantId],
    );
    const requesterId = users.rows.find((user) => user.stripe_user_id === "usr_PurgeRequester")?.id;
    if (requesterId === undefined) {
      throw new Error("Guarded purge requester fixture was not created");
    }
    await client.query(
      `INSERT INTO refund_requests (
        tenant_id,
        installation_id,
        environment,
        payment_key,
        payment_intent_id,
        charge_id,
        amount_minor,
        currency,
        reason,
        justification_ciphertext,
        justification_nonce,
        justification_auth_tag,
        justification_key_version,
        requester_user_id,
        policy_version,
        expires_at
      ) VALUES (
        $1, $2, 'sandbox', 'pi_GuardedPurge', 'pi_GuardedPurge', 'ch_GuardedPurge',
        500, 'eur', 'requested_by_customer',
        decode('01', 'hex'),
        decode('000000000000000000000000', 'hex'),
        decode('00000000000000000000000000000000', 'hex'),
        'v1', $3, 1, statement_timestamp() + INTERVAL '7 days'
      )`,
      [guardedTenantId, guardedInstallationId, requesterId],
    );

    await client.query("SET ROLE refunddesk_worker");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [guardedTenantId]);
    await client.query(
      `UPDATE stripe_installations
       SET status = 'deauthorized', deauthorized_at = $2
       WHERE id = $1`,
      [guardedInstallationId, deauthorizedAt],
    );
    await client.query(
      `UPDATE tenants
       SET status = 'pending_deletion', pending_delete_at = $2
       WHERE id = $1`,
      [guardedTenantId, new Date(deauthorizedAt.getTime() + 30 * 24 * 60 * 60 * 1_000)],
    );

    await client.query("SET ROLE refunddesk_maintenance");
    await client.query("SAVEPOINT before_guarded_purge");
    await expect(
      client.query("SELECT * FROM refunddesk_purge_test_sandbox_tenant($1, $2)", [
        guardedTenantId,
        pseudonym,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT before_guarded_purge");
  });

  it("deduplicates normalized receipts and recovers lifecycle work after deauthorization", async () => {
    const eventCreated = new Date("2030-01-01T12:00:00.000Z");
    const payload = {
      schema_version: 1,
      environment: "test",
      event_type: "account.application.deauthorized",
      event_created: Math.floor(eventCreated.getTime() / 1_000),
      event_idempotency_key: null,
      application_id: "ca_Integration",
    };
    await client.query("RESET ROLE");
    await client.query("SET ROLE refunddesk_runtime");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const insert = async (endpoint: "account_test" | "connected_test"): Promise<number | null> => {
      const result = await client.query(
        `INSERT INTO webhook_receipts (
          tenant_id,
          installation_id,
          endpoint,
          stripe_event_id,
          stripe_account_id,
          event_type,
          object_id,
          normalized_payload,
          stripe_created_at
        ) VALUES (
          $1, $2, $3, 'evt_DeauthIntegration',
          'acct_IntegrationA', 'account.application.deauthorized',
          'ca_Integration', $4::JSONB, $5
        )
        ON CONFLICT (stripe_account_id, stripe_event_id) DO NOTHING`,
        [tenantA, installationA, endpoint, JSON.stringify(payload), eventCreated],
      );
      return result.rowCount;
    };
    expect(await insert("account_test")).toBe(1);
    expect(await insert("account_test")).toBe(0);
    expect(await insert("connected_test")).toBe(0);

    await client.query("SET ROLE refunddesk_worker");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await client.query(
      `UPDATE stripe_installations
       SET
         status = 'deauthorized',
         deauthorized_at = $2,
         last_lifecycle_event_id = 'evt_DeauthIntegration',
         last_lifecycle_event_type = 'account.application.deauthorized',
         last_lifecycle_event_created_at = $2
       WHERE id = $1`,
      [installationA, eventCreated],
    );
    await client.query(
      `UPDATE tenants
       SET status = 'pending_deletion', pending_delete_at = $2
       WHERE id = $1`,
      [tenantA, new Date(eventCreated.getTime() + 30 * 24 * 60 * 60 * 1_000)],
    );
    const recoverable = await client.query<{ receipt_id: string }>(
      "SELECT receipt_id FROM refunddesk_list_recoverable_webhook_receipts_v2(100)",
    );
    expect(recoverable.rowCount).toBe(1);
    const legacyRecoverable = await client.query<{ receipt_id: string }>(
      "SELECT receipt_id FROM refunddesk_list_recoverable_webhook_receipts(100)",
    );
    expect(legacyRecoverable.rowCount).toBe(0);

    await client.query("SET ROLE refunddesk_runtime");
    const duplicate = await client.query<{ receipt_id: string }>(
      `SELECT receipt_id
       FROM refunddesk_find_webhook_receipt_v2(
         'account_test',
         'evt_DeauthIntegration',
         'acct_IntegrationA'
       )`,
    );
    expect(duplicate.rowCount).toBe(1);
    const legacyDuplicate = await client.query<{ receipt_id: string }>(
      `SELECT receipt_id
       FROM refunddesk_find_webhook_receipt(
         'connected_test',
         'evt_DeauthIntegration',
         'acct_IntegrationA'
       )`,
    );
    expect(legacyDuplicate.rowCount).toBe(0);
  });

  it("does not let a delayed authorization reactivate a newer deauthorization", async () => {
    const deauthorizedAt = new Date("2030-02-01T12:00:00.000Z");
    await client.query("SET ROLE refunddesk_worker");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
    await client.query(
      `UPDATE stripe_installations
       SET
         status = 'deauthorized',
         deauthorized_at = $2,
         last_lifecycle_event_id = 'evt_DeauthNewer',
         last_lifecycle_event_type = 'account.application.deauthorized',
         last_lifecycle_event_created_at = $2
       WHERE id = $1`,
      [installationB, deauthorizedAt],
    );
    await client.query(
      `UPDATE tenants
       SET status = 'pending_deletion', pending_delete_at = $2
       WHERE id = $1`,
      [tenantB, new Date(deauthorizedAt.getTime() + 30 * 24 * 60 * 60 * 1_000)],
    );

    await client.query("SET ROLE refunddesk_runtime");
    const stale = await client.query<{ applied: boolean; status: string }>(
      `SELECT applied, status
       FROM refunddesk_provision_webhook_installation(
         'acct_IntegrationB',
         'sandbox',
         'evt_AuthOlder',
         $1
       )`,
      [new Date(deauthorizedAt.getTime() - 1_000)],
    );
    expect(stale.rows[0]).toMatchObject({ applied: false, status: "deauthorized" });
    const genericProvision = await client.query<{ status: string }>(
      `SELECT status
       FROM refunddesk_provision_installation('acct_IntegrationB', 'sandbox')`,
    );
    expect(genericProvision.rows[0]?.status).toBe("deauthorized");

    const current = await client.query<{ applied: boolean; status: string }>(
      `SELECT applied, status
       FROM refunddesk_provision_webhook_installation(
         'acct_IntegrationB',
         'sandbox',
         'evt_AuthNewer',
         $1
       )`,
      [new Date(deauthorizedAt.getTime() + 1_000)],
    );
    expect(current.rows[0]).toMatchObject({ applied: true, status: "active" });
  });

  it("bounds limiter cardinality and replaces only an inactive debt-free scope", async () => {
    await client.query("RESET ROLE");
    await client.query("TRUNCATE signed_request_rate_limit_buckets");
    const seeded = await client.query<{ scope_key: Buffer }>(
      `WITH observed AS (
         SELECT pg_catalog.clock_timestamp() AS at
       )
       INSERT INTO signed_request_rate_limit_buckets (
         scope_key,
         theoretical_arrival_at,
         last_seen_at
       )
       SELECT
         public.digest(
           pg_catalog.convert_to('rate-limit-fixture:' || scope.ordinality::TEXT, 'UTF8'),
           'sha256'
         ),
         observed.at + INTERVAL '5 minutes',
         observed.at
       FROM generate_series(1, 256) AS scope(ordinality)
       CROSS JOIN observed
       RETURNING scope_key`,
    );
    expect(seeded.rowCount).toBe(256);
    const staleScopeKey = seeded.rows[0]?.scope_key;
    if (staleScopeKey === undefined) {
      throw new Error("Rate-limit cardinality fixture was not created");
    }

    await client.query("SET ROLE refunddesk_runtime");
    await client.query("SAVEPOINT before_rate_limit_capacity_failure");
    await expect(
      client.query(
        `SELECT allowed
         FROM refunddesk_consume_signed_request_rate_limit(
           'acct_CardinalityAdmission',
           'test',
           'mutation'
         )`,
      ),
    ).rejects.toMatchObject({ code: "54000" });
    await client.query("ROLLBACK TO SAVEPOINT before_rate_limit_capacity_failure");

    await client.query("RESET ROLE");
    await client.query(
      `UPDATE signed_request_rate_limit_buckets AS bucket
       SET
         theoretical_arrival_at = observed.at - INTERVAL '10 minutes',
         last_seen_at = observed.at - INTERVAL '11 minutes'
       FROM (SELECT pg_catalog.clock_timestamp() AS at) AS observed
       WHERE bucket.scope_key = $1::BYTEA`,
      [staleScopeKey],
    );

    await client.query("SET ROLE refunddesk_runtime");
    const admitted = await client.query<{ allowed: boolean; retry_after_seconds: number | null }>(
      `SELECT allowed, retry_after_seconds
       FROM refunddesk_consume_signed_request_rate_limit(
         'acct_CardinalityAdmission',
         'test',
         'mutation'
       )`,
    );
    expect(admitted.rows).toEqual([{ allowed: true, retry_after_seconds: null }]);

    await client.query("RESET ROLE");
    const persisted = await client.query<{
      admitted_count: string;
      bucket_count: string;
      stale_count: string;
    }>(
      `SELECT
         COUNT(*)::TEXT AS bucket_count,
         COUNT(*) FILTER (WHERE scope_key = $1::BYTEA)::TEXT AS stale_count,
         COUNT(*) FILTER (
           WHERE scope_key = public.digest(
             pg_catalog.convert_to('acct_CardinalityAdmission:test:mutation', 'UTF8'),
             'sha256'
           )
         )::TEXT AS admitted_count
       FROM signed_request_rate_limit_buckets`,
      [staleScopeKey],
    );
    expect(persisted.rows).toEqual([
      { admitted_count: "1", bucket_count: "256", stale_count: "0" },
    ]);
    await client.query("SET ROLE refunddesk_runtime");
  });
});
