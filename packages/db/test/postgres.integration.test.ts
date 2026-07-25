import { readFile } from "node:fs/promises";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readOrderedMigrationSql } from "./postgres-test-support.js";

const testDatabaseUrl = process.env["REFUNDDESK_TEST_DATABASE_URL"] ?? "";
const databaseDescribe = testDatabaseUrl.length === 0 ? describe.skip : describe.sequential;

databaseDescribe("PostgreSQL security invariants", () => {
  const client = new Client({ connectionString: testDatabaseUrl });
  let tenantA = "";
  let tenantB = "";
  let installationA = "";
  let installationB = "";
  let runtimeRolesSql = "";

  beforeAll(async () => {
    await client.connect();
    await client.query("BEGIN");
    const migrations = await readOrderedMigrationSql();
    runtimeRolesSql = await readFile(
      new URL("../prisma/runtime-roles.sql", import.meta.url),
      "utf8",
    );
    for (const migration of migrations) {
      await client.query(migration);
    }
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
       END
       $$`,
    );
    await client.query("GRANT refunddesk_runtime TO refunddesk_web_login");
    await client.query("REVOKE refunddesk_worker FROM refunddesk_web_login");
    await client.query("GRANT refunddesk_worker TO refunddesk_worker_login");
    await client.query("REVOKE refunddesk_runtime FROM refunddesk_worker_login");
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
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.query("RESET SESSION AUTHORIZATION");
    await client.query("RESET ROLE");
    await client.end();
  });

  it("keeps every collective role non-login and non-privileged", async () => {
    await client.query("RESET ROLE");
    await client.query("CREATE ROLE refunddesk_integration_parent_probe NOLOGIN");
    await client.query("GRANT refunddesk_integration_parent_probe TO refunddesk_runtime");
    await client.query("GRANT CREATE ON SCHEMA public TO refunddesk_maintenance");
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
      [["refunddesk_runtime", "refunddesk_worker", "refunddesk_maintenance"]],
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

    await client.query("SET SESSION AUTHORIZATION refunddesk_web_login");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const privilegeBoundary = await client.query<{
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
        ) AS execution_write`,
    );
    expect(privilegeBoundary.rows[0]).toEqual({
      execution_read: true,
      attempt_read: true,
      candidate_read: false,
      execution_write: false,
    });

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

    await client.query(
      `INSERT INTO approval_decisions (
        tenant_id, request_id, approver_user_id, decision, stripe_roles_snapshot
      ) VALUES ($1, $2, $3, 'approve', '[]'::JSONB)`,
      [tenantA, approvedRequestId, approverId],
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
    await client.query(
      `INSERT INTO audit_events (
        tenant_id, actor_type, action, entity_type, entity_id, correlation_request_id
      ) VALUES ($1, 'system', 'purge.fixture', 'tenant', 'internal-fixture', $2)`,
      [purgeTenantId, "70d9f9b8-1e75-4314-97f5-271ca5ca5a2b"],
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
    await client.query("UPDATE tenants SET legal_hold_at = statement_timestamp() WHERE id = $1", [
      purgeTenantId,
    ]);
    await client.query("SET ROLE refunddesk_maintenance");
    await client.query("SAVEPOINT before_held_purge");
    await expect(
      client.query("SELECT * FROM refunddesk_purge_tenant($1, $2)", [purgeTenantId, pseudonym]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT before_held_purge");

    await client.query("RESET ROLE");
    await client.query("UPDATE tenants SET legal_hold_at = NULL WHERE id = $1", [purgeTenantId]);
    await client.query("SET ROLE refunddesk_runtime");
    await client.query("SAVEPOINT before_runtime_purge");
    await expect(
      client.query("SELECT * FROM refunddesk_purge_tenant($1, $2)", [purgeTenantId, pseudonym]),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_runtime_purge");

    await client.query("SET ROLE refunddesk_maintenance");
    const purged = await client.query<{
      certificate_id: string;
      deleted_counts: Readonly<Record<string, number>>;
      result: string;
      tenant_pseudonym: string;
    }>("SELECT * FROM refunddesk_purge_tenant($1, $2)", [purgeTenantId, pseudonym]);
    expect(purged.rows[0]).toMatchObject({
      tenant_pseudonym: pseudonym,
      result: "completed",
      deleted_counts: {
        audit_events: 1,
        installations: 1,
        tenants: 1,
      },
    });
    const replay = await client.query<{ certificate_id: string }>(
      "SELECT certificate_id FROM refunddesk_purge_tenant($1, $2)",
      [purgeTenantId, pseudonym],
    );
    expect(replay.rows[0]?.certificate_id).toBe(purged.rows[0]?.certificate_id);

    await client.query("RESET ROLE");
    const certificate = await client.query(
      "SELECT tenant_pseudonym, deleted_counts, result FROM purge_certificates WHERE id = $1",
      [purged.rows[0]?.certificate_id],
    );
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
      client.query("SELECT * FROM refunddesk_purge_tenant($1, $2)", [guardedTenantId, pseudonym]),
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
    const insert = async (): Promise<number | null> => {
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
          $1, $2, 'connected_test', 'evt_DeauthIntegration',
          'acct_IntegrationA', 'account.application.deauthorized',
          'ca_Integration', $3::JSONB, $4
        )
        ON CONFLICT (endpoint, stripe_event_id) DO NOTHING`,
        [tenantA, installationA, JSON.stringify(payload), eventCreated],
      );
      return result.rowCount;
    };
    expect(await insert()).toBe(1);
    expect(await insert()).toBe(0);

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
      "SELECT receipt_id FROM refunddesk_list_recoverable_webhook_receipts(100)",
    );
    expect(recoverable.rowCount).toBe(1);

    await client.query("SET ROLE refunddesk_runtime");
    const duplicate = await client.query<{ receipt_id: string }>(
      `SELECT receipt_id
       FROM refunddesk_find_webhook_receipt(
         'connected_test',
         'evt_DeauthIntegration',
         'acct_IntegrationA'
       )`,
    );
    expect(duplicate.rowCount).toBe(1);
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
});
