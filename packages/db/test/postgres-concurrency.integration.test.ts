import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/client.js";
import { provisionInstallation } from "../src/installations.js";
import { withTenantTransaction } from "../src/tenant-transaction.js";
import { findWebhookReceipt } from "../src/webhooks.js";
import { readOrderedMigrationSql } from "./postgres-test-support.js";

const testDatabaseUrl = process.env["REFUNDDESK_TEST_DATABASE_URL"] ?? "";
const databaseDescribe = testDatabaseUrl.length === 0 ? describe.skip : describe.sequential;
const databaseName = `refunddesk_concurrency_${randomBytes(8).toString("hex")}`;
const SAFE_DATABASE_NAME = /^refunddesk_concurrency_[0-9a-f]{16}$/u;
const BARRIER_TIMEOUT_MILLISECONDS = 5_000;

interface SqlOutcome {
  readonly committed: boolean;
  readonly code?: string | undefined;
  readonly constraint?: string | undefined;
}

interface Barrier {
  arrive(): Promise<void>;
}

interface DatabaseRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number | null;
}

interface DatabaseRateLimitScope {
  readonly accountId: string;
  readonly environment: "sandbox" | "test";
  readonly requestClass: "mutation" | "read";
}

interface SucceededRefundFixture {
  readonly requestId: string;
  readonly executionStartedAt: Date;
  readonly terminalAt: Date;
  readonly stripeEventCreatedAt: Date;
}

function quotedGeneratedDatabaseName(): string {
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error("Generated concurrency database name is unsafe");
  }
  return `"${databaseName}"`;
}

function connectionStringForDatabase(connectionString: string, targetDatabase: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${targetDatabase}`;
  return url.toString();
}

function postgresField(error: unknown, field: "code" | "constraint"): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as Readonly<Record<string, unknown>>;
  const value = record[field];
  if (typeof value === "string") {
    return value;
  }
  return postgresField(record["cause"], field);
}

function hasErrorMarker(
  value: unknown,
  expectedMarker: string,
  seen = new WeakSet<object>(),
  depth = 0,
): boolean {
  if (typeof value === "string") {
    return value === expectedMarker;
  }
  if (typeof value !== "object" || value === null || depth > 8 || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.values(value as Readonly<Record<string, unknown>>).some((nested) =>
    hasErrorMarker(nested, expectedMarker, seen, depth + 1),
  );
}

function createBarrier(participants: number): Barrier {
  let arrived = 0;
  let resolveBarrier: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve;
    timeout = setTimeout(() => {
      reject(new Error(`Concurrency barrier timed out after ${BARRIER_TIMEOUT_MILLISECONDS}ms`));
    }, BARRIER_TIMEOUT_MILLISECONDS);
  });

  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived > participants) {
        throw new Error("Concurrency barrier received too many participants");
      }
      if (arrived === participants) {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        resolveBarrier?.();
        resolveBarrier = undefined;
      }
      await waiting;
    },
  };
}

async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The connection may already be closed or PostgreSQL may already have ended the transaction.
  }
}

async function closeQuietly(client: Client | undefined): Promise<void> {
  if (client === undefined) {
    return;
  }
  try {
    await client.end();
  } catch {
    // Cleanup continues so the exact ephemeral database can still be dropped.
  }
}

function rateLimitScopeKey(scope: DatabaseRateLimitScope): Buffer {
  return createHash("sha256")
    .update(`${scope.accountId}:${scope.environment}:${scope.requestClass}`, "utf8")
    .digest();
}

async function consumeDatabaseRateLimit(
  client: Client,
  scope: DatabaseRateLimitScope,
): Promise<DatabaseRateLimitDecision> {
  const result = await client.query<{
    allowed: boolean;
    retry_after_seconds: number | null;
  }>(
    `SELECT allowed, retry_after_seconds
     FROM refunddesk_consume_signed_request_rate_limit(
       $1::VARCHAR,
       $2::stripe_environment,
       $3::VARCHAR
     )`,
    [scope.accountId, scope.environment, scope.requestClass],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error("PostgreSQL rate limiter returned an invalid row count");
  }
  return {
    allowed: row.allowed,
    retryAfterSeconds: row.retry_after_seconds,
  };
}

async function forceExhaustedDatabaseRateLimit(
  ownerClient: Client,
  scope: DatabaseRateLimitScope,
): Promise<void> {
  const result = await ownerClient.query(
    `UPDATE signed_request_rate_limit_buckets AS bucket
     SET
       theoretical_arrival_at = observed.at + INTERVAL '5 minutes',
       last_seen_at = observed.at
     FROM (SELECT clock_timestamp() AS at) AS observed
     WHERE bucket.scope_key = $1::BYTEA`,
    [rateLimitScopeKey(scope)],
  );
  if (result.rowCount !== 1) {
    throw new Error("PostgreSQL rate-limit fixture was not found");
  }
}

databaseDescribe("PostgreSQL 18 concurrency matrix", () => {
  let controlClient: Client | undefined;
  let fixtureClient: Client | undefined;
  let ephemeralDatabaseUrl = "";
  let databaseCreated = false;
  let tenantId = "";
  let installationId = "";
  let requesterUserId = "";
  let approverAUserId = "";
  let approverBUserId = "";
  let prismaClient: ReturnType<typeof createPrismaClient> | undefined;

  const newEphemeralClient = (): Client =>
    new Client({
      connectionString: ephemeralDatabaseUrl,
      application_name: "refunddesk-postgres-concurrency-test",
    });

  const newRuntimeClient = async (): Promise<Client> => {
    const client = newEphemeralClient();
    await client.connect();
    try {
      await client.query("SET SESSION AUTHORIZATION refunddesk_runtime");
      return client;
    } catch (error) {
      await closeQuietly(client);
      throw error;
    }
  };

  const setTenantContext = async (client: Client): Promise<void> => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  };

  const inTenantTransaction = async <T>(
    client: Client,
    operation: () => Promise<T>,
  ): Promise<T> => {
    await client.query("BEGIN");
    await setTenantContext(client);
    try {
      const result = await operation();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  };

  const createRefundRequest = async (paymentKey: string): Promise<string> => {
    const client = fixtureClient;
    if (client === undefined) {
      throw new Error("PostgreSQL fixture client is not initialized");
    }
    return inTenantTransaction(client, async () => {
      const inserted = await client.query<{ id: string }>(
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
          tenantId,
          installationId,
          paymentKey,
          Buffer.from([1]),
          Buffer.alloc(12),
          Buffer.alloc(16),
          requesterUserId,
        ],
      );
      const requestId = inserted.rows[0]?.id;
      if (requestId === undefined) {
        throw new Error("Refund request fixture was not created");
      }
      return requestId;
    });
  };

  const persistApprovalAttestation = async (
    client: Client,
    requestId: string,
    approverUserId: string,
  ): Promise<string> => {
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
        request.payment_intent_id,
        request.version,
        $4::BYTEA,
        $5::BYTEA,
        statement_timestamp(),
        LEAST(
          statement_timestamp() + INTERVAL '5 minutes',
          request.expires_at
        ),
        'v1',
        $6::BYTEA,
        statement_timestamp()
      FROM refund_requests AS request
      INNER JOIN stripe_installations AS installation
        ON installation.id = request.installation_id
       AND installation.tenant_id = request.tenant_id
       AND installation.environment = request.environment
      WHERE request.id = $1::UUID
        AND request.tenant_id = $7::UUID
      RETURNING id`,
      [
        requestId,
        approverUserId,
        randomUUID(),
        Buffer.alloc(32, 1),
        Buffer.alloc(32, 2),
        Buffer.alloc(32, 3),
        tenantId,
      ],
    );
    const attestationId = attestation.rows[0]?.id;
    if (attestationId === undefined) {
      throw new Error("Approval attestation fixture was not created");
    }
    return attestationId;
  };

  const approveRefundRequest = async (client: Client, requestId: string): Promise<void> => {
    const approvalAttestationId = await persistApprovalAttestation(
      client,
      requestId,
      approverAUserId,
    );
    await client.query(
      `INSERT INTO approval_decisions (
        tenant_id,
        request_id,
        approver_user_id,
        approval_attestation_id,
        decision,
        stripe_roles_snapshot,
        decided_at
      ) VALUES ($1, $2, $3, $4, 'approve', '[]'::JSONB, clock_timestamp())`,
      [tenantId, requestId, approverAUserId, approvalAttestationId],
    );
    await client.query(
      `UPDATE refund_requests
       SET
         workflow_status = 'approved',
         approved_at = clock_timestamp(),
         version = version + 1
       WHERE id = $1 AND tenant_id = $2`,
      [requestId, tenantId],
    );
  };

  const createSucceededRefund = async (
    paymentKey: string,
    stripeRefundId: string,
  ): Promise<SucceededRefundFixture> => {
    const client = fixtureClient;
    if (client === undefined) {
      throw new Error("PostgreSQL fixture client is not initialized");
    }
    const requestId = await createRefundRequest(paymentKey);
    const approvedAt = new Date();
    const executionStartedAt = new Date(approvedAt.getTime() + 1_000);
    const terminalAt = new Date(executionStartedAt.getTime() + 1_000);
    const stripeEventCreatedAt = new Date(executionStartedAt.getTime() + 500);

    await inTenantTransaction(client, async () => {
      await approveRefundRequest(client, requestId);
      await client.query(
        `UPDATE refund_requests
         SET workflow_status = 'executing', execution_started_at = $3, version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [requestId, tenantId, executionStartedAt],
      );
      await client.query(
        `UPDATE refund_requests
         SET effect_state = 'possible', version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [requestId, tenantId],
      );
      await client.query(
        `INSERT INTO refund_executions (
          tenant_id,
          request_id,
          idempotency_key,
          canonical_parameters_hash,
          amount_minor,
          currency
        ) VALUES ($1, $2, $3, $4, 100, 'eur')`,
        [tenantId, requestId, `refunddesk:refund-request:${requestId}:v1`, Buffer.alloc(32, 7)],
      );
      await client.query(
        `UPDATE refund_executions
         SET
           stripe_refund_id = $3,
           stripe_refund_status = 'succeeded',
           last_stripe_event_id = 'evt_InitialSuccess',
           last_stripe_event_created_at = $4,
           reconciled_at = $5
         WHERE request_id = $1 AND tenant_id = $2`,
        [requestId, tenantId, stripeRefundId, stripeEventCreatedAt, terminalAt],
      );
      await client.query(
        `UPDATE refund_requests
         SET
           effect_state = 'identified',
           workflow_status = 'succeeded',
           terminal_at = $3,
           payment_guard_released_at = $3,
           version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [requestId, tenantId, terminalAt],
      );
    });

    return { requestId, executionStartedAt, terminalAt, stripeEventCreatedAt };
  };

  const cleanupEphemeralDatabase = async (): Promise<void> => {
    if (prismaClient !== undefined) {
      try {
        await prismaClient.$disconnect();
      } catch {
        // Continue with connection termination scoped to the generated database.
      }
      prismaClient = undefined;
    }
    await closeQuietly(fixtureClient);
    fixtureClient = undefined;

    if (databaseCreated) {
      if (controlClient === undefined) {
        controlClient = new Client({
          connectionString: testDatabaseUrl,
          application_name: "refunddesk-postgres-concurrency-cleanup",
        });
        await controlClient.connect();
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
    await closeQuietly(controlClient);
    controlClient = undefined;
  };

  beforeAll(async () => {
    try {
      controlClient = new Client({
        connectionString: testDatabaseUrl,
        application_name: "refunddesk-postgres-concurrency-control",
      });
      await controlClient.connect();
      const version = await controlClient.query<{ server_version_num: string }>(
        "SELECT current_setting('server_version_num') AS server_version_num",
      );
      const serverVersionNumber = Number.parseInt(version.rows[0]?.server_version_num ?? "", 10);
      expect(Math.trunc(serverVersionNumber / 10_000)).toBe(18);

      await controlClient.query(
        `CREATE DATABASE ${quotedGeneratedDatabaseName()} TEMPLATE template0`,
      );
      databaseCreated = true;
      ephemeralDatabaseUrl = connectionStringForDatabase(testDatabaseUrl, databaseName);
      fixtureClient = newEphemeralClient();
      await fixtureClient.connect();

      const [migrationSql, runtimeRolesSql] = await Promise.all([
        readOrderedMigrationSql(),
        readFile(new URL("../prisma/runtime-roles.sql", import.meta.url), "utf8"),
      ]);
      for (const migration of migrationSql) {
        await fixtureClient.query(migration);
      }
      await fixtureClient.query(runtimeRolesSql);
      await fixtureClient.query(
        `CREATE TABLE refunddesk_concurrency_retry_probe (
          id INTEGER PRIMARY KEY,
          value INTEGER NOT NULL
        )`,
      );
      await fixtureClient.query(
        "INSERT INTO refunddesk_concurrency_retry_probe (id, value) VALUES (1, 0), (2, 0)",
      );

      const accountId = `acct_Concurrency${randomBytes(6).toString("hex")}`;
      const tenant = await fixtureClient.query<{ id: string }>(
        "INSERT INTO tenants DEFAULT VALUES RETURNING id",
      );
      tenantId = tenant.rows[0]?.id ?? "";
      const installation = await fixtureClient.query<{ id: string }>(
        `INSERT INTO stripe_installations (
          tenant_id,
          stripe_account_id,
          environment
        ) VALUES ($1, $2, 'test')
        RETURNING id`,
        [tenantId, accountId],
      );
      installationId = installation.rows[0]?.id ?? "";
      if (tenantId.length === 0 || installationId.length === 0) {
        throw new Error("Concurrency tenant fixture was not provisioned");
      }

      await inTenantTransaction(fixtureClient, async () => {
        const users = await fixtureClient?.query<{ id: string; stripe_user_id: string }>(
          `INSERT INTO tenant_users (
            tenant_id,
            stripe_user_id,
            approver_enabled,
            last_verified_at
          ) VALUES
            ($1, 'usr_ConcurrencyRequester', false, statement_timestamp()),
            ($1, 'usr_ConcurrencyApproverA', true, statement_timestamp()),
            ($1, 'usr_ConcurrencyApproverB', true, statement_timestamp())
          RETURNING id, stripe_user_id`,
          [tenantId],
        );
        requesterUserId =
          users?.rows.find((user) => user.stripe_user_id === "usr_ConcurrencyRequester")?.id ?? "";
        approverAUserId =
          users?.rows.find((user) => user.stripe_user_id === "usr_ConcurrencyApproverA")?.id ?? "";
        approverBUserId =
          users?.rows.find((user) => user.stripe_user_id === "usr_ConcurrencyApproverB")?.id ?? "";
        if (
          requesterUserId.length === 0 ||
          approverAUserId.length === 0 ||
          approverBUserId.length === 0
        ) {
          throw new Error("Concurrency user fixtures were not created");
        }
      });

      prismaClient = createPrismaClient({
        connectionString: ephemeralDatabaseUrl,
        maxConnections: 4,
      });
    } catch (error) {
      await cleanupEphemeralDatabase();
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupEphemeralDatabase();
  });

  it("loads an execution work item without overlapping transaction client queries", async () => {
    const database = prismaClient;
    if (database === undefined) {
      throw new Error("PostgreSQL concurrency client is not initialized");
    }
    const requestId = await createRefundRequest("pi_SequentialExecutionWorkItem");

    const workItem = await withTenantTransaction(database, tenantId, ({ repositories }) =>
      repositories.getExecutionWorkItem(requestId),
    );

    expect(workItem).not.toBeNull();
    expect(workItem).toMatchObject({
      id: requestId,
      tenantId,
      installationId,
      tenant: { id: tenantId },
      installation: { id: installationId, tenantId },
      execution: null,
    });
  });

  it("serializes a signed-request burst across PostgreSQL clients without exceeding capacity", async () => {
    const scope = {
      accountId: `acct_RateLimitRace${randomBytes(6).toString("hex")}`,
      environment: "test",
      requestClass: "mutation",
    } as const;
    const clients = await Promise.all(Array.from({ length: 8 }, () => newRuntimeClient()));

    try {
      const startedAt = performance.now();
      const decisions = (
        await Promise.all(
          clients.map(async (client, clientIndex) => {
            const clientDecisions: DatabaseRateLimitDecision[] = [];
            for (
              let requestIndex = clientIndex;
              requestIndex < 40;
              requestIndex += clients.length
            ) {
              clientDecisions.push(await consumeDatabaseRateLimit(client, scope));
            }
            return clientDecisions;
          }),
        )
      ).flat();
      const elapsedMilliseconds = performance.now() - startedAt;
      const allowedCount = decisions.filter((decision) => decision.allowed).length;
      const maximumAllowedForElapsedWindow = 30 + Math.floor(elapsedMilliseconds / 2_000);

      expect(allowedCount).toBeLessThanOrEqual(maximumAllowedForElapsedWindow);
      expect(decisions.some((decision) => !decision.allowed)).toBe(true);
      expect(
        decisions
          .filter((decision) => !decision.allowed)
          .every(
            (decision) =>
              Number.isSafeInteger(decision.retryAfterSeconds) &&
              (decision.retryAfterSeconds ?? 0) > 0,
          ),
      ).toBe(true);

      const owner = fixtureClient;
      if (owner === undefined) {
        throw new Error("PostgreSQL fixture client is not initialized");
      }
      const bucket = await owner.query<{ bucket_count: string }>(
        `SELECT COUNT(*)::TEXT AS bucket_count
         FROM signed_request_rate_limit_buckets
         WHERE scope_key = $1::BYTEA`,
        [rateLimitScopeKey(scope)],
      );
      expect(bucket.rows).toEqual([{ bucket_count: "1" }]);
    } finally {
      await Promise.all(clients.map((client) => closeQuietly(client)));
    }
  });

  it("keeps an exhausted signed-request bucket authoritative for a second client", async () => {
    const owner = fixtureClient;
    if (owner === undefined) {
      throw new Error("PostgreSQL fixture client is not initialized");
    }
    const scope = {
      accountId: `acct_RateLimitRestart${randomBytes(6).toString("hex")}`,
      environment: "test",
      requestClass: "mutation",
    } as const;
    const firstClient = await newRuntimeClient();
    const secondClient = await newRuntimeClient();

    try {
      await expect(consumeDatabaseRateLimit(firstClient, scope)).resolves.toEqual({
        allowed: true,
        retryAfterSeconds: null,
      });
      await forceExhaustedDatabaseRateLimit(owner, scope);
      await closeQuietly(firstClient);

      const persistedDecision = await consumeDatabaseRateLimit(secondClient, scope);
      expect(persistedDecision.allowed).toBe(false);
      expect(persistedDecision.retryAfterSeconds).toEqual(expect.any(Number));
      expect(persistedDecision.retryAfterSeconds ?? 0).toBeGreaterThan(0);
    } finally {
      await closeQuietly(firstClient);
      await closeQuietly(secondClient);
    }
  });

  it("fails closed after the bounded wait when another transaction locks the scope", async () => {
    const owner = fixtureClient;
    if (owner === undefined) {
      throw new Error("PostgreSQL fixture client is not initialized");
    }
    const scope = {
      accountId: `acct_RateLimitLock${randomBytes(6).toString("hex")}`,
      environment: "test",
      requestClass: "mutation",
    } as const;
    const runtimeClient = await newRuntimeClient();
    let ownerTransactionOpen = false;

    try {
      await expect(consumeDatabaseRateLimit(runtimeClient, scope)).resolves.toEqual({
        allowed: true,
        retryAfterSeconds: null,
      });
      await owner.query("BEGIN");
      ownerTransactionOpen = true;
      const locked = await owner.query(
        `SELECT scope_key
         FROM signed_request_rate_limit_buckets
         WHERE scope_key = $1::BYTEA
         FOR UPDATE`,
        [rateLimitScopeKey(scope)],
      );
      expect(locked.rowCount).toBe(1);

      await expect(consumeDatabaseRateLimit(runtimeClient, scope)).rejects.toMatchObject({
        code: "55P03",
      });

      await owner.query("ROLLBACK");
      ownerTransactionOpen = false;
      await expect(consumeDatabaseRateLimit(runtimeClient, scope)).resolves.toEqual({
        allowed: true,
        retryAfterSeconds: null,
      });
    } finally {
      if (ownerTransactionOpen) {
        await rollbackQuietly(owner);
      }
      await closeQuietly(runtimeClient);
    }
  });

  it("isolates durable capacity by request class, environment and account", async () => {
    const owner = fixtureClient;
    if (owner === undefined) {
      throw new Error("PostgreSQL fixture client is not initialized");
    }
    const accountId = `acct_RateLimitScope${randomBytes(6).toString("hex")}`;
    const exhaustedScope = {
      accountId,
      environment: "test",
      requestClass: "mutation",
    } as const;
    const runtimeClient = await newRuntimeClient();

    try {
      expect(await consumeDatabaseRateLimit(runtimeClient, exhaustedScope)).toEqual({
        allowed: true,
        retryAfterSeconds: null,
      });
      await forceExhaustedDatabaseRateLimit(owner, exhaustedScope);

      expect((await consumeDatabaseRateLimit(runtimeClient, exhaustedScope)).allowed).toBe(false);
      await expect(
        consumeDatabaseRateLimit(runtimeClient, {
          ...exhaustedScope,
          requestClass: "read",
        }),
      ).resolves.toEqual({ allowed: true, retryAfterSeconds: null });
      await expect(
        consumeDatabaseRateLimit(runtimeClient, {
          ...exhaustedScope,
          environment: "sandbox",
        }),
      ).resolves.toEqual({ allowed: true, retryAfterSeconds: null });
      await expect(
        consumeDatabaseRateLimit(runtimeClient, {
          ...exhaustedScope,
          accountId: `acct_RateLimitOther${randomBytes(6).toString("hex")}`,
        }),
      ).resolves.toEqual({ allowed: true, retryAfterSeconds: null });
    } finally {
      await closeQuietly(runtimeClient);
    }
  });

  it("persists runtime deauthorization atomically through the adapter advisory lock", async () => {
    const runtimeDatabase = createPrismaClient({
      connectionString: ephemeralDatabaseUrl,
      maxConnections: 1,
    });
    await runtimeDatabase.$executeRawUnsafe("SET SESSION AUTHORIZATION refunddesk_runtime");
    try {
      const stripeAccountId = `acct_DeauthRuntime${randomBytes(6).toString("hex")}`;
      const provisioned = await provisionInstallation(runtimeDatabase, stripeAccountId, "test");
      const stripeEventId = `evt_DeauthRuntime${randomBytes(6).toString("hex")}`;
      const stripeEventCreatedAt = new Date("2030-01-01T12:00:00.000Z");
      const purgeAt = new Date("2030-01-30T12:00:00.000Z");
      const receiptInput = {
        installationId: provisioned.installationId,
        endpoint: "account_test" as const,
        stripeEventId,
        stripeAccountId,
        eventType: "account.application.deauthorized" as const,
        objectId: "ca_RefundDesk",
        stripeCreatedAt: stripeEventCreatedAt,
        receivedAt: new Date("2030-01-01T12:00:01.000Z"),
        normalizedPayload: {
          schema_version: 1 as const,
          environment: "test" as const,
          event_type: "account.application.deauthorized" as const,
          event_created: Math.floor(stripeEventCreatedAt.getTime() / 1_000),
          event_idempotency_key: null,
          application_id: "ca_RefundDesk",
        },
      };
      const deauthorizationInput = {
        installationId: provisioned.installationId,
        stripeEventId,
        stripeEventCreatedAt,
        purgeAt,
      };

      const first = await withTenantTransaction(
        runtimeDatabase,
        provisioned.tenantId,
        async ({ repositories }) => {
          const applied = await repositories.applyWebhookDeauthorization(deauthorizationInput);
          const receipt = await repositories.insertWebhookReceipt(receiptInput);
          return { receipt, applied };
        },
        { maxAttempts: 1 },
      );
      expect(first).toMatchObject({
        receipt: { inserted: true },
        applied: true,
      });

      const replay = await withTenantTransaction(
        runtimeDatabase,
        provisioned.tenantId,
        async ({ repositories }) => {
          const applied = await repositories.applyWebhookDeauthorization(deauthorizationInput);
          const receipt = await repositories.insertWebhookReceipt(receiptInput);
          return { receipt, applied };
        },
        { maxAttempts: 1 },
      );
      expect(replay).toMatchObject({
        receipt: {
          inserted: false,
          receipt: { id: first.receipt.receipt.id },
        },
        applied: true,
      });

      const durableState = await withTenantTransaction(
        runtimeDatabase,
        provisioned.tenantId,
        ({ repositories }) => repositories.getInstallationContext(provisioned.installationId),
        { maxAttempts: 1 },
      );
      expect(durableState).toMatchObject({
        status: "deauthorized",
        deauthorizedAt: stripeEventCreatedAt,
        lastLifecycleEventId: stripeEventId,
        lastLifecycleEventType: "account.application.deauthorized",
        lastLifecycleEventCreatedAt: stripeEventCreatedAt,
        tenant: {
          status: "pending_deletion",
          pendingDeleteAt: purgeAt,
          liveEnabled: false,
        },
      });

      const rollbackAccountId = `acct_DeauthRollback${randomBytes(6).toString("hex")}`;
      const rollbackProvisioned = await provisionInstallation(
        runtimeDatabase,
        rollbackAccountId,
        "test",
      );
      const rollbackEventId = `evt_DeauthRollback${randomBytes(6).toString("hex")}`;
      const rollbackReceiptInput = {
        ...receiptInput,
        installationId: rollbackProvisioned.installationId,
        stripeEventId: rollbackEventId,
        stripeAccountId: rollbackAccountId,
      };
      const rollbackDeauthorizationInput = {
        installationId: rollbackProvisioned.installationId,
        stripeEventId: rollbackEventId,
        stripeEventCreatedAt,
        purgeAt,
      };

      await expect(
        withTenantTransaction(
          runtimeDatabase,
          rollbackProvisioned.tenantId,
          async ({ repositories }) => {
            await repositories.applyWebhookDeauthorization(rollbackDeauthorizationInput);
            await repositories.insertWebhookReceipt({
              ...rollbackReceiptInput,
              objectId: "ca_Different",
            });
          },
          { maxAttempts: 1 },
        ),
      ).rejects.toThrow();
      const rolledBackState = await withTenantTransaction(
        runtimeDatabase,
        rollbackProvisioned.tenantId,
        ({ repositories }) =>
          repositories.getInstallationContext(rollbackProvisioned.installationId),
        { maxAttempts: 1 },
      );
      expect(rolledBackState).toMatchObject({
        status: "active",
        deauthorizedAt: null,
        lastLifecycleEventId: null,
        lastLifecycleEventType: null,
        lastLifecycleEventCreatedAt: null,
        tenant: {
          status: "active",
          pendingDeleteAt: null,
          liveEnabled: false,
        },
      });
      await expect(
        findWebhookReceipt(runtimeDatabase, "account_test", rollbackEventId, rollbackAccountId),
      ).resolves.toBeNull();

      const afterRollback = await withTenantTransaction(
        runtimeDatabase,
        rollbackProvisioned.tenantId,
        async ({ repositories }) => {
          const applied = await repositories.applyWebhookDeauthorization(
            rollbackDeauthorizationInput,
          );
          const receipt = await repositories.insertWebhookReceipt(rollbackReceiptInput);
          return { receipt, applied };
        },
        { maxAttempts: 1 },
      );
      expect(afterRollback).toMatchObject({
        receipt: { inserted: true },
        applied: true,
      });
    } finally {
      await runtimeDatabase.$executeRawUnsafe("RESET SESSION AUTHORIZATION");
      await runtimeDatabase.$disconnect();
    }
  });

  it("allows only one active financial guard for concurrent request creation", async () => {
    const barrier = createBarrier(2);
    const paymentKey = "pi_ConcurrentGuard";

    const attempt = async (): Promise<SqlOutcome> => {
      const client = newEphemeralClient();
      await client.connect();
      try {
        await client.query("BEGIN");
        await setTenantContext(client);
        await barrier.arrive();
        await client.query(
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
          )`,
          [
            tenantId,
            installationId,
            paymentKey,
            Buffer.from([1]),
            Buffer.alloc(12),
            Buffer.alloc(16),
            requesterUserId,
          ],
        );
        await client.query("COMMIT");
        return { committed: true };
      } catch (error) {
        await rollbackQuietly(client);
        return {
          committed: false,
          code: postgresField(error, "code"),
          constraint: postgresField(error, "constraint"),
        };
      } finally {
        await closeQuietly(client);
      }
    };

    const outcomes = await Promise.all([attempt(), attempt()]);
    expect(outcomes.filter((outcome) => outcome.committed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.committed)).toEqual([
      {
        committed: false,
        code: "23505",
        constraint: "refund_requests_active_payment_guard_key",
      },
    ]);

    const client = fixtureClient;
    if (client === undefined) {
      throw new Error("PostgreSQL fixture client is not initialized");
    }
    const activeGuards = await inTenantTransaction(client, () =>
      client.query<{ active_guards: string }>(
        `SELECT COUNT(*)::TEXT AS active_guards
         FROM refund_requests
         WHERE tenant_id = $1
           AND environment = 'test'
           AND payment_key = $2
           AND payment_guard_released_at IS NULL`,
        [tenantId, paymentKey],
      ),
    );
    expect(activeGuards.rows[0]?.active_guards).toBe("1");
  });

  it("commits only one concurrent decision and one workflow transition", async () => {
    const requestId = await createRefundRequest("pi_ConcurrentDecision");
    const client = fixtureClient;
    if (client === undefined) {
      throw new Error("PostgreSQL fixture client is not initialized");
    }
    const approvalAttestationId = await inTenantTransaction(client, () =>
      persistApprovalAttestation(client, requestId, approverAUserId),
    );
    const barrier = createBarrier(2);

    const attempt = async (
      approverUserId: string,
      decision: "approve" | "reject",
    ): Promise<SqlOutcome> => {
      const client = newEphemeralClient();
      await client.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await setTenantContext(client);
        await barrier.arrive();
        const inserted = await client.query<{ decided_at: Date }>(
          `INSERT INTO approval_decisions (
            tenant_id,
            request_id,
            approver_user_id,
            approval_attestation_id,
            decision,
            rejection_ciphertext,
            rejection_nonce,
            rejection_auth_tag,
            rejection_key_version,
            stripe_roles_snapshot,
            decided_at
          ) VALUES (
            $1, $2, $3,
            CASE WHEN $4::decision_kind = 'approve' THEN $8::UUID ELSE NULL END,
            $4::decision_kind,
            CASE WHEN $4::decision_kind = 'reject' THEN $5::BYTEA ELSE NULL END,
            CASE WHEN $4::decision_kind = 'reject' THEN $6::BYTEA ELSE NULL END,
            CASE WHEN $4::decision_kind = 'reject' THEN $7::BYTEA ELSE NULL END,
            CASE WHEN $4::decision_kind = 'reject' THEN 'v1' ELSE NULL END,
            '["administrator"]'::JSONB,
            clock_timestamp()
          )
          RETURNING decided_at`,
          [
            tenantId,
            requestId,
            approverUserId,
            decision,
            Buffer.from([1]),
            Buffer.alloc(12),
            Buffer.alloc(16),
            approvalAttestationId,
          ],
        );
        const decidedAt = inserted.rows[0]?.decided_at;
        if (decidedAt === undefined) {
          throw new Error("Decision timestamp was not returned");
        }
        const transitioned =
          decision === "approve"
            ? await client.query(
                `UPDATE refund_requests
                 SET
                   workflow_status = 'approved',
                   approved_at = $3,
                   version = version + 1
                 WHERE id = $1
                   AND tenant_id = $2
                   AND workflow_status = 'pending_approval'`,
                [requestId, tenantId, decidedAt],
              )
            : await client.query(
                `UPDATE refund_requests
                 SET
                   workflow_status = 'rejected',
                   terminal_at = $3,
                   payment_guard_released_at = $3,
                   version = version + 1
                 WHERE id = $1
                   AND tenant_id = $2
                   AND workflow_status = 'pending_approval'
                   AND effect_state = 'not_started'`,
                [requestId, tenantId, decidedAt],
              );
        if (transitioned.rowCount !== 1) {
          throw new Error("Decision did not win the workflow compare-and-set");
        }
        await client.query("COMMIT");
        return { committed: true };
      } catch (error) {
        await rollbackQuietly(client);
        return { committed: false, code: postgresField(error, "code") };
      } finally {
        await closeQuietly(client);
      }
    };

    const outcomes = await Promise.all([
      attempt(approverAUserId, "approve"),
      attempt(approverBUserId, "reject"),
    ]);
    expect(outcomes.filter((outcome) => outcome.committed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.committed)).toEqual([
      { committed: false, code: "23514" },
    ]);

    const committed = await inTenantTransaction(client, async () => {
      const request = await client.query<{
        version: number;
        workflow_status: "approved" | "rejected";
      }>(
        `SELECT workflow_status, version
         FROM refund_requests
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requestId],
      );
      const decisions = await client.query<{ decision: "approve" | "reject" }>(
        `SELECT decision
         FROM approval_decisions
         WHERE tenant_id = $1 AND request_id = $2`,
        [tenantId, requestId],
      );
      return { request: request.rows[0], decisions: decisions.rows };
    });
    expect(committed.decisions).toHaveLength(1);
    expect(committed.request?.version).toBe(1);
    expect(committed.request?.workflow_status).toBe(
      committed.decisions[0]?.decision === "approve" ? "approved" : "rejected",
    );
  });

  it("keeps one authoritative mutation receipt and makes a nonce conflict detectable", async () => {
    const requestNonce = randomUUID();
    const barrier = createBarrier(2);
    const hashes = ["11".repeat(32), "22".repeat(32)] as const;

    const attempt = async (
      candidate: "first" | "second",
      attemptedHash: string,
    ): Promise<{
      readonly authoritativeHash: string;
      readonly authoritativeCandidate: string;
      readonly attemptedHash: string;
      readonly inserted: boolean;
    }> => {
      const client = newEphemeralClient();
      await client.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await setTenantContext(client);
        await barrier.arrive();
        const inserted = await client.query(
          `INSERT INTO api_mutation_receipts (
            tenant_id,
            request_nonce,
            actor_id,
            operation,
            canonical_request_hash,
            response_status,
            response_body,
            expires_at
          ) VALUES (
            $1, $2, 'usr_MutationActor', 'refund-requests/create',
            decode($3, 'hex'), 201, $4::JSONB,
            statement_timestamp() + INTERVAL '365 days'
          )
          ON CONFLICT (tenant_id, request_nonce) DO NOTHING
          RETURNING id`,
          [tenantId, requestNonce, attemptedHash, JSON.stringify({ candidate })],
        );
        const authoritative = await client.query<{
          candidate: string;
          canonical_hash: string;
        }>(
          `SELECT
             encode(canonical_request_hash, 'hex') AS canonical_hash,
             response_body ->> 'candidate' AS candidate
           FROM api_mutation_receipts
           WHERE tenant_id = $1 AND request_nonce = $2`,
          [tenantId, requestNonce],
        );
        await client.query("COMMIT");
        const row = authoritative.rows[0];
        if (row === undefined) {
          throw new Error("Authoritative mutation receipt was not visible");
        }
        return {
          attemptedHash,
          inserted: inserted.rowCount === 1,
          authoritativeHash: row.canonical_hash,
          authoritativeCandidate: row.candidate,
        };
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        await closeQuietly(client);
      }
    };

    const outcomes = await Promise.all([attempt("first", hashes[0]), attempt("second", hashes[1])]);
    expect(outcomes.filter((outcome) => outcome.inserted)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.authoritativeHash)).size).toBe(1);
    expect(new Set(outcomes.map((outcome) => outcome.authoritativeCandidate)).size).toBe(1);
    expect(
      outcomes
        .map((outcome) =>
          outcome.attemptedHash === outcome.authoritativeHash ? "replay" : "conflict",
        )
        .sort(),
    ).toEqual(["conflict", "replay"]);

    const client = fixtureClient;
    if (client === undefined) {
      throw new Error("PostgreSQL fixture client is not initialized");
    }
    const count = await inTenantTransaction(client, () =>
      client.query<{ receipt_count: string }>(
        `SELECT COUNT(*)::TEXT AS receipt_count
         FROM api_mutation_receipts
         WHERE tenant_id = $1 AND request_nonce = $2`,
        [tenantId, requestNonce],
      ),
    );
    expect(count.rows[0]?.receipt_count).toBe("1");
  });

  it("keeps an acknowledged reverse-order external Refund as a payment-scoped guard", async () => {
    const database = prismaClient;
    const client = fixtureClient;
    if (database === undefined || client === undefined) {
      throw new Error("PostgreSQL concurrency clients are not initialized");
    }
    const paymentKey = "pi_ExternalReverseRace";
    const internal = await createSucceededRefund(paymentKey, "re_InternalRace");
    const newerRequestId = await createRefundRequest(paymentKey);
    const externalCreatedAt = new Date(
      internal.executionStartedAt.getTime() +
        Math.trunc((internal.terminalAt.getTime() - internal.executionStartedAt.getTime()) / 2),
    );
    const observedAt = new Date(internal.terminalAt.getTime() + 1_000);

    const windowRows = await inTenantTransaction(client, () =>
      client.query<{
        id: string;
        overlaps: boolean;
        workflow_status: string;
      }>(
        `SELECT
           id,
           workflow_status,
           (
             execution_started_at <= $3
             AND $3 <= terminal_at
           ) AS overlaps
         FROM refund_requests
         WHERE tenant_id = $1 AND payment_key = $2
         ORDER BY created_at, id`,
        [tenantId, paymentKey, externalCreatedAt],
      ),
    );
    expect(windowRows.rows.find((request) => request.id === internal.requestId)).toEqual({
      id: internal.requestId,
      workflow_status: "succeeded",
      overlaps: true,
    });

    const observation = await withTenantTransaction(database, tenantId, ({ repositories }) =>
      repositories.observeExternalRefund({
        installationId,
        stripeRefundId: "re_ExternalRace",
        stripeRefundCreatedAt: externalCreatedAt,
        paymentKey,
        amountMinor: 100n,
        currency: "eur",
        classification: "external",
        observedAt,
      }),
    );
    expect(observation.requestTransition).toBe("stale");
    expect(observation.alert.overlappedRequestId).toBe(internal.requestId);
    expect(observation.alert.reconciledAt).toBeNull();

    const protectedRequests = await inTenantTransaction(client, () =>
      client.query<{
        id: string;
        workflow_status: string;
        payment_guard_released_at: Date | null;
      }>(
        `SELECT id, workflow_status, payment_guard_released_at
         FROM refund_requests
         WHERE tenant_id = $1 AND payment_key = $2
         ORDER BY created_at, id`,
        [tenantId, paymentKey],
      ),
    );
    expect(protectedRequests.rows).toHaveLength(2);
    expect(
      protectedRequests.rows.find((request) => request.id === internal.requestId)?.workflow_status,
    ).toBe("succeeded");
    expect(
      protectedRequests.rows.find((request) => request.id === newerRequestId)?.workflow_status,
    ).toBe("stale");

    await expect(createRefundRequest(paymentKey)).rejects.toMatchObject({ code: "55000" });
    await inTenantTransaction(client, () =>
      client.query(
        `UPDATE external_refund_alerts
         SET
           status = 'acknowledged',
           acknowledged_at = $3,
           acknowledged_by_user_id = $4
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, observation.alert.id, new Date(observedAt.getTime() + 1_000), approverAUserId],
      ),
    );
    await expect(createRefundRequest(paymentKey)).rejects.toMatchObject({ code: "55000" });

    const alert = await inTenantTransaction(client, () =>
      client.query<{ reconciled_at: Date | null; status: string }>(
        `SELECT status, reconciled_at
         FROM external_refund_alerts
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, observation.alert.id],
      ),
    );
    expect(alert.rows[0]).toEqual({ status: "acknowledged", reconciled_at: null });
  });

  it("observes external Refunds idempotently under the worker column grants", async () => {
    const workerDatabase = createPrismaClient({
      connectionString: ephemeralDatabaseUrl,
      maxConnections: 1,
    });
    const observedAt = new Date("2030-01-01T12:01:00.000Z");
    const stripeRefundCreatedAt = new Date("2030-01-01T12:00:00.000Z");
    const observation = {
      installationId,
      stripeRefundId: "re_WorkerColumnGrant",
      stripeRefundCreatedAt,
      paymentKey: "pi_WorkerColumnGrant",
      amountMinor: 500n,
      currency: "eur",
      classification: "external" as const,
      observedAt,
    };

    await workerDatabase.$executeRawUnsafe("SET SESSION AUTHORIZATION refunddesk_worker");
    try {
      const identity = await workerDatabase.$queryRaw<
        readonly { current_role: string; session_role: string; table_insert: boolean }[]
      >`
        SELECT
          current_user::TEXT AS current_role,
          session_user::TEXT AS session_role,
          has_table_privilege(
            current_user,
            'public.external_refund_alerts',
            'INSERT'
          ) AS table_insert
      `;
      expect(identity).toEqual([
        {
          current_role: "refunddesk_worker",
          session_role: "refunddesk_worker",
          table_insert: false,
        },
      ]);

      const insertableColumns = await workerDatabase.$queryRaw<readonly { column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'external_refund_alerts'
          AND has_column_privilege(
            current_user,
            'public.external_refund_alerts',
            column_name,
            'INSERT'
          )
        ORDER BY ordinal_position
      `;
      expect(insertableColumns.map((column) => column.column_name)).toEqual([
        "tenant_id",
        "installation_id",
        "environment",
        "stripe_refund_id",
        "stripe_refund_created_at",
        "payment_key",
        "amount_minor",
        "currency",
        "classification",
        "detected_at",
        "overlapped_request_id",
      ]);

      const first = await withTenantTransaction(
        workerDatabase,
        tenantId,
        ({ repositories }) => repositories.observeExternalRefund(observation),
        { maxAttempts: 1 },
      );
      const replay = await withTenantTransaction(
        workerDatabase,
        tenantId,
        ({ repositories }) => repositories.observeExternalRefund(observation),
        { maxAttempts: 1 },
      );
      expect(replay.alert.id).toBe(first.alert.id);
      expect(first.requestTransition).toBe("none");
      expect(first.alert).toMatchObject({
        status: "open",
        acknowledgedAt: null,
        acknowledgedByUserId: null,
        reconciledAt: null,
      });

      const storedCount = await withTenantTransaction(
        workerDatabase,
        tenantId,
        ({ tx }) =>
          tx.$queryRaw<readonly { alert_count: number }[]>`
            SELECT COUNT(*)::INTEGER AS alert_count
            FROM external_refund_alerts
            WHERE tenant_id = ${tenantId}::UUID
              AND installation_id = ${installationId}::UUID
              AND stripe_refund_id = ${observation.stripeRefundId}
          `,
        { maxAttempts: 1 },
      );
      expect(storedCount).toEqual([{ alert_count: 1 }]);

      const forbiddenWrites = [
        () =>
          withTenantTransaction(
            workerDatabase,
            tenantId,
            ({ tx }) =>
              tx.$executeRaw`
                INSERT INTO external_refund_alerts (status)
                VALUES ('open')
              `,
            { maxAttempts: 1 },
          ),
        () =>
          withTenantTransaction(
            workerDatabase,
            tenantId,
            ({ tx }) =>
              tx.$executeRaw`
                INSERT INTO external_refund_alerts (reconciled_at)
                VALUES (${observedAt.toISOString()}::TIMESTAMPTZ)
              `,
            { maxAttempts: 1 },
          ),
      ];
      for (const forbiddenWrite of forbiddenWrites) {
        try {
          await forbiddenWrite();
          expect.fail("Worker unexpectedly inserted a protected alert lifecycle column");
        } catch (error) {
          expect(hasErrorMarker(error, "42501")).toBe(true);
        }
      }
    } finally {
      await workerDatabase.$executeRawUnsafe("RESET SESSION AUTHORIZATION");
      await workerDatabase.$disconnect();
    }
  });

  it("proves absence after a complete empty scan and resumes with the original key", async () => {
    const database = prismaClient;
    const client = fixtureClient;
    if (database === undefined || client === undefined) {
      throw new Error("PostgreSQL concurrency clients are not initialized");
    }
    const requestId = await createRefundRequest("pi_EmptyReconciliationScan");
    const approvedAt = new Date();
    const executionStartedAt = new Date(approvedAt.getTime() + 1_000);
    const scanWindowStart = new Date(executionStartedAt.getTime() - 60_000);
    const idempotencyKey = `refunddesk:refund-request:${requestId}:v1`;

    await inTenantTransaction(client, async () => {
      await approveRefundRequest(client, requestId);
      await client.query(
        `UPDATE refund_requests
         SET
           workflow_status = 'executing',
           execution_started_at = $3,
           version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [requestId, tenantId, executionStartedAt],
      );
      await client.query(
        `UPDATE refund_requests
         SET effect_state = 'possible', version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [requestId, tenantId],
      );
      await client.query(
        `INSERT INTO refund_executions (
          tenant_id,
          request_id,
          idempotency_key,
          canonical_parameters_hash,
          amount_minor,
          currency
        ) VALUES ($1, $2, $3, $4, 100, 'eur')`,
        [tenantId, requestId, idempotencyKey, Buffer.alloc(32, 9)],
      );
      await client.query(
        `UPDATE refund_requests
         SET workflow_status = 'reconciliation_required', version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [requestId, tenantId],
      );
    });

    const beforeResolution = await inTenantTransaction(client, () =>
      client.query<{
        effect_state: string;
        execution_started_at: Date;
        reconciliation_safe_after_at: Date;
        workflow_status: string;
      }>(
        `SELECT
           workflow_status,
           effect_state,
           execution_started_at,
           reconciliation_safe_after_at
         FROM refund_requests
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requestId],
      ),
    );
    const reconciliationSafeAfterAt = beforeResolution.rows[0]?.reconciliation_safe_after_at;
    if (reconciliationSafeAfterAt === undefined) {
      throw new Error("Reconciliation safe boundary was not stamped");
    }
    expect(reconciliationSafeAfterAt).toBeInstanceOf(Date);
    expect(beforeResolution.rows[0]).toEqual({
      workflow_status: "reconciliation_required",
      effect_state: "possible",
      execution_started_at: executionStartedAt,
      reconciliation_safe_after_at: reconciliationSafeAfterAt,
    });
    expect(reconciliationSafeAfterAt.getTime()).toBeGreaterThanOrEqual(
      executionStartedAt.getTime(),
    );
    await inTenantTransaction(client, async () => {
      await client.query("SAVEPOINT before_boundary_rewrite");
      await expect(
        client.query(
          `UPDATE refund_requests
           SET
             reconciliation_safe_after_at = $3,
             version = version + 1
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, requestId, new Date(reconciliationSafeAfterAt.getTime() + 1_000)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT before_boundary_rewrite");
    });
    const prematureWindowEnd = new Date(reconciliationSafeAfterAt.getTime() - 1);
    const prematureResolution = await withTenantTransaction(
      database,
      tenantId,
      ({ repositories }) =>
        repositories.resolveUniqueRefundCandidates(
          installationId,
          scanWindowStart,
          prematureWindowEnd,
          prematureWindowEnd,
        ),
    );
    expect(prematureResolution).toEqual({ resolved: 0, conflicts: 0 });
    const scanWindowEnd = new Date(reconciliationSafeAfterAt.getTime() + 1_000);
    const coveredByScan = await withTenantTransaction(
      database,
      tenantId,
      ({ tx }) =>
        tx.$queryRaw<readonly { id: string }[]>`
        SELECT id
        FROM refund_requests
        WHERE tenant_id = ${tenantId}::UUID
          AND installation_id = ${installationId}::UUID
          AND workflow_status = 'reconciliation_required'
          AND effect_state = 'possible'
          AND payment_guard_released_at IS NULL
          AND execution_started_at >= ${scanWindowStart.toISOString()}::TIMESTAMPTZ
          AND reconciliation_safe_after_at IS NOT NULL
          AND reconciliation_safe_after_at >= execution_started_at
          AND reconciliation_safe_after_at <= ${scanWindowEnd.toISOString()}::TIMESTAMPTZ
      `,
    );
    expect(coveredByScan).toEqual([{ id: requestId }]);
    const repositoryDetail = await withTenantTransaction(database, tenantId, ({ repositories }) =>
      repositories.getRefundRequestDetail(requestId),
    );
    expect(repositoryDetail).toMatchObject({
      id: requestId,
      workflowStatus: "reconciliation_required",
      effectState: "possible",
      executionStartedAt,
      execution: {
        idempotencyKey,
        stripeRefundId: null,
      },
    });

    const resolution = await withTenantTransaction(database, tenantId, ({ repositories }) =>
      repositories.resolveUniqueRefundCandidates(
        installationId,
        scanWindowStart,
        scanWindowEnd,
        scanWindowEnd,
      ),
    );
    expect(resolution).toEqual({ resolved: 1, conflicts: 0 });

    const state = await inTenantTransaction(client, async () => {
      const request = await client.query<{
        effect_state: string;
        payment_guard_released_at: Date | null;
        workflow_status: string;
      }>(
        `SELECT workflow_status, effect_state, payment_guard_released_at
         FROM refund_requests
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requestId],
      );
      const execution = await client.query<{ idempotency_key: string }>(
        `SELECT idempotency_key
         FROM refund_executions
         WHERE tenant_id = $1 AND request_id = $2`,
        [tenantId, requestId],
      );
      return { request: request.rows[0], execution: execution.rows[0] };
    });
    expect(state).toEqual({
      request: {
        workflow_status: "executing",
        effect_state: "absence_proven",
        payment_guard_released_at: null,
      },
      execution: { idempotency_key: idempotencyKey },
    });
  });

  it("recovers safe work and stamps a possible orphan before reconciliation can resume", async () => {
    const database = prismaClient;
    const client = fixtureClient;
    if (database === undefined || client === undefined) {
      throw new Error("PostgreSQL concurrency clients are not initialized");
    }
    const notStartedId = await createRefundRequest("pi_RecoveryNotStarted");
    const possibleId = await createRefundRequest("pi_RecoveryPossible");
    const absenceProvenId = await createRefundRequest("pi_RecoveryAbsence");
    const approvedAt = new Date();
    const executionStartedAt = new Date(approvedAt.getTime() + 1_000);

    const moveToExecuting = async (requestId: string): Promise<void> => {
      await approveRefundRequest(client, requestId);
      await client.query(
        `UPDATE refund_requests
         SET
           workflow_status = 'executing',
           execution_started_at = $3,
           version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [requestId, tenantId, executionStartedAt],
      );
    };
    const addExecution = async (requestId: string, marker: number): Promise<void> => {
      await client.query(
        `INSERT INTO refund_executions (
          tenant_id,
          request_id,
          idempotency_key,
          canonical_parameters_hash,
          amount_minor,
          currency
        ) VALUES ($1, $2, $3, $4, 100, 'eur')`,
        [
          tenantId,
          requestId,
          `refunddesk:refund-request:${requestId}:v1`,
          Buffer.alloc(32, marker),
        ],
      );
    };

    await inTenantTransaction(client, async () => {
      await moveToExecuting(notStartedId);

      await moveToExecuting(possibleId);
      await addExecution(possibleId, 10);
      const possibleExecution = await client.query<{ id: string }>(
        `SELECT id
         FROM refund_executions
         WHERE request_id = $1 AND tenant_id = $2`,
        [possibleId, tenantId],
      );
      const possibleExecutionId = possibleExecution.rows[0]?.id;
      if (possibleExecutionId === undefined) {
        throw new Error("Possible execution fixture was not created");
      }
      await client.query(
        `INSERT INTO refund_execution_attempts (
          tenant_id,
          execution_id,
          attempt_number,
          state,
          started_at
        ) VALUES ($1, $2, 1, 'started', $3)`,
        [tenantId, possibleExecutionId, executionStartedAt],
      );
      await client.query(
        `UPDATE refund_requests
         SET effect_state = 'possible', version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [possibleId, tenantId],
      );

      await moveToExecuting(absenceProvenId);
      await addExecution(absenceProvenId, 11);
      await client.query(
        `UPDATE refund_requests
         SET effect_state = 'possible', version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [absenceProvenId, tenantId],
      );
      await client.query(
        `UPDATE refund_requests
         SET effect_state = 'absence_proven', version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [absenceProvenId, tenantId],
      );
    });

    const recoverable = await withTenantTransaction(database, tenantId, ({ repositories }) =>
      repositories.prepareExecutionRecoveryWork(100),
    );
    const recoveredIds = new Set(recoverable.map((item) => item.id));
    expect(recoveredIds.has(notStartedId)).toBe(true);
    expect(recoveredIds.has(absenceProvenId)).toBe(true);
    expect(recoveredIds.has(possibleId)).toBe(false);

    const possibleState = await inTenantTransaction(client, () =>
      client.query<{
        effect_state: string;
        idempotency_key: string;
        reconciliation_safe_after_at: Date;
        workflow_status: string;
      }>(
        `SELECT
           request.workflow_status,
           request.effect_state,
           request.reconciliation_safe_after_at,
           execution.idempotency_key
         FROM refund_requests AS request
         INNER JOIN refund_executions AS execution
           ON execution.request_id = request.id
          AND execution.tenant_id = request.tenant_id
         WHERE request.tenant_id = $1 AND request.id = $2`,
        [tenantId, possibleId],
      ),
    );
    const orphanSafeAfterAt = possibleState.rows[0]?.reconciliation_safe_after_at;
    if (orphanSafeAfterAt === undefined) {
      throw new Error("Orphan reconciliation safe boundary was not stamped");
    }
    expect(orphanSafeAfterAt).toBeInstanceOf(Date);
    expect(possibleState.rows[0]).toEqual({
      workflow_status: "reconciliation_required",
      effect_state: "possible",
      idempotency_key: `refunddesk:refund-request:${possibleId}:v1`,
      reconciliation_safe_after_at: orphanSafeAfterAt,
    });
    const prematureResolution = await withTenantTransaction(
      database,
      tenantId,
      ({ repositories }) =>
        repositories.resolveUniqueRefundCandidates(
          installationId,
          new Date(executionStartedAt.getTime() - 60_000),
          new Date(orphanSafeAfterAt.getTime() - 1),
          orphanSafeAfterAt,
        ),
    );
    expect(prematureResolution).toEqual({ resolved: 0, conflicts: 0 });
    const stillGuarded = await inTenantTransaction(client, () =>
      client.query<{ effect_state: string; workflow_status: string }>(
        `SELECT workflow_status, effect_state
         FROM refund_requests
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, possibleId],
      ),
    );
    expect(stillGuarded.rows[0]).toEqual({
      workflow_status: "reconciliation_required",
      effect_state: "possible",
    });

    const coveredResolution = await withTenantTransaction(database, tenantId, ({ repositories }) =>
      repositories.resolveUniqueRefundCandidates(
        installationId,
        new Date(executionStartedAt.getTime() - 60_000),
        new Date(orphanSafeAfterAt.getTime() + 1_000),
        new Date(orphanSafeAfterAt.getTime() + 1_000),
      ),
    );
    expect(coveredResolution).toEqual({ resolved: 1, conflicts: 0 });
  });

  it("corrects only the same linked Refund from succeeded to an equal-time failure", async () => {
    const database = prismaClient;
    const client = fixtureClient;
    if (database === undefined || client === undefined) {
      throw new Error("PostgreSQL concurrency clients are not initialized");
    }
    const fixture = await createSucceededRefund("pi_LateFailure", "re_LateFailure");
    const linkedTargets = await withTenantTransaction(database, tenantId, ({ repositories }) =>
      repositories.listLinkedRefundReconciliationTargets(installationId, null, 100),
    );
    expect(linkedTargets).toContainEqual({
      requestId: fixture.requestId,
      refundId: "re_LateFailure",
    });

    await inTenantTransaction(client, async () => {
      await client.query(
        `UPDATE refund_executions
         SET
           stripe_refund_status = 'failed',
           last_stripe_event_id = 'evt_LateFailure',
           last_stripe_event_created_at = $3,
           reconciled_at = $4
         WHERE request_id = $1 AND tenant_id = $2`,
        [
          fixture.requestId,
          tenantId,
          fixture.stripeEventCreatedAt,
          new Date(fixture.terminalAt.getTime() + 1_000),
        ],
      );
      await client.query(
        `UPDATE refund_requests
         SET
           effect_state = 'absence_proven',
           workflow_status = 'failed_terminal',
           version = version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [fixture.requestId, tenantId],
      );
    });

    const corrected = await inTenantTransaction(client, async () => {
      const request = await client.query<{
        effect_state: string;
        payment_guard_released_at: Date;
        terminal_at: Date;
        workflow_status: string;
      }>(
        `SELECT workflow_status, effect_state, terminal_at, payment_guard_released_at
         FROM refund_requests
         WHERE id = $1 AND tenant_id = $2`,
        [fixture.requestId, tenantId],
      );
      const execution = await client.query<{ stripe_refund_status: string }>(
        `SELECT stripe_refund_status
         FROM refund_executions
         WHERE request_id = $1 AND tenant_id = $2`,
        [fixture.requestId, tenantId],
      );
      return { request: request.rows[0], execution: execution.rows[0] };
    });
    expect(corrected).toEqual({
      request: {
        workflow_status: "failed_terminal",
        effect_state: "absence_proven",
        terminal_at: fixture.terminalAt,
        payment_guard_released_at: fixture.terminalAt,
      },
      execution: { stripe_refund_status: "failed" },
    });

    await inTenantTransaction(client, async () => {
      await client.query("SAVEPOINT before_terminal_regression");
      await expect(
        client.query(
          `UPDATE refund_executions
           SET
             stripe_refund_status = 'succeeded',
             last_stripe_event_created_at = $3
           WHERE request_id = $1 AND tenant_id = $2`,
          [fixture.requestId, tenantId, new Date(fixture.stripeEventCreatedAt.getTime() + 1_000)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT before_terminal_regression");
    });
  });

  it("produces real 40001 and 40P01 SQLSTATEs from concurrent transactions", async () => {
    const client = fixtureClient;
    if (client === undefined) {
      throw new Error("PostgreSQL fixture client is not initialized");
    }
    await client.query("UPDATE refunddesk_concurrency_retry_probe SET value = 0");

    const serializationBarrier = createBarrier(2);
    const serializableAttempt = async (rowId: number): Promise<SqlOutcome> => {
      const concurrentClient = newEphemeralClient();
      await concurrentClient.connect();
      try {
        await concurrentClient.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await concurrentClient.query(
          "SELECT id, value FROM refunddesk_concurrency_retry_probe ORDER BY id",
        );
        await serializationBarrier.arrive();
        await concurrentClient.query(
          "UPDATE refunddesk_concurrency_retry_probe SET value = value + 1 WHERE id = $1",
          [rowId],
        );
        await concurrentClient.query("COMMIT");
        return { committed: true };
      } catch (error) {
        await rollbackQuietly(concurrentClient);
        return { committed: false, code: postgresField(error, "code") };
      } finally {
        await closeQuietly(concurrentClient);
      }
    };
    const serializationOutcomes = await Promise.all([
      serializableAttempt(1),
      serializableAttempt(2),
    ]);
    expect(serializationOutcomes.filter((outcome) => outcome.committed)).toHaveLength(1);
    expect(serializationOutcomes.filter((outcome) => !outcome.committed)).toEqual([
      { committed: false, code: "40001" },
    ]);

    await client.query("UPDATE refunddesk_concurrency_retry_probe SET value = 0");
    const deadlockBarrier = createBarrier(2);
    const deadlockAttempt = async (
      firstRowId: number,
      secondRowId: number,
    ): Promise<SqlOutcome> => {
      const concurrentClient = newEphemeralClient();
      await concurrentClient.connect();
      try {
        await concurrentClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await concurrentClient.query(
          "UPDATE refunddesk_concurrency_retry_probe SET value = value + 1 WHERE id = $1",
          [firstRowId],
        );
        await deadlockBarrier.arrive();
        await concurrentClient.query(
          "UPDATE refunddesk_concurrency_retry_probe SET value = value + 1 WHERE id = $1",
          [secondRowId],
        );
        await concurrentClient.query("COMMIT");
        return { committed: true };
      } catch (error) {
        await rollbackQuietly(concurrentClient);
        return { committed: false, code: postgresField(error, "code") };
      } finally {
        await closeQuietly(concurrentClient);
      }
    };
    const deadlockOutcomes = await Promise.all([deadlockAttempt(1, 2), deadlockAttempt(2, 1)]);
    expect(deadlockOutcomes.filter((outcome) => outcome.committed)).toHaveLength(1);
    expect(deadlockOutcomes.filter((outcome) => !outcome.committed)).toEqual([
      { committed: false, code: "40P01" },
    ]);
  });

  it("retries an actual serialization failure through withTenantTransaction", async () => {
    const database = prismaClient;
    const client = fixtureClient;
    if (database === undefined || client === undefined) {
      throw new Error("PostgreSQL concurrency clients are not initialized");
    }
    await client.query("UPDATE refunddesk_concurrency_retry_probe SET value = 0");
    const barrier = createBarrier(2);
    const attempts: Record<0 | 1, number> = { 0: 0, 1: 0 };

    const operation = async (operationIndex: 0 | 1, rowId: number): Promise<void> => {
      await withTenantTransaction(
        database,
        tenantId,
        async ({ tx }) => {
          attempts[operationIndex] += 1;
          await tx.$queryRawUnsafe(
            "SELECT id, value FROM refunddesk_concurrency_retry_probe ORDER BY id",
          );
          if (attempts[operationIndex] === 1) {
            await barrier.arrive();
          }
          await tx.$executeRawUnsafe(
            "UPDATE refunddesk_concurrency_retry_probe SET value = value + 1 WHERE id = $1",
            rowId,
          );
        },
        {
          maxAttempts: 3,
          maxWaitMilliseconds: 5_000,
          timeoutMilliseconds: 10_000,
        },
      );
    };

    await Promise.all([operation(0, 1), operation(1, 2)]);
    const orderedAttempts = [attempts[0], attempts[1]].sort((left, right) => left - right);
    expect(orderedAttempts[0]).toBe(1);
    // PostgreSQL may reject the loser's immediate retry once more while the
    // winning transaction is still committing. Both two and three attempts
    // exercise the intended bounded retry path.
    expect(orderedAttempts[1]).toBeGreaterThanOrEqual(2);
    expect(orderedAttempts[1]).toBeLessThanOrEqual(3);
    const rows = await client.query<{ id: number; value: number }>(
      "SELECT id, value FROM refunddesk_concurrency_retry_probe ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: 1, value: 1 },
      { id: 2, value: 1 },
    ]);
  });
});
