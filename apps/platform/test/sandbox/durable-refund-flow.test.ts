import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { PgBoss } from "pg-boss";
import { Client } from "pg";
import Stripe from "stripe";
import { afterAll, describe, expect, it } from "vitest";

import type { RefundDeskConfig } from "@refunddesk/config";
import { createPrismaClient } from "@refunddesk/db";
import {
  FieldEncryptionKeyring,
  RefundProofKeyring,
  refundIdempotencyKey,
} from "@refunddesk/domain";
import { ConnectedAccountStripeClient, StripeCredentialResolver } from "@refunddesk/stripe-adapter";

import {
  handleReconciliationScanJob,
  handleRefundExecutionJob,
  PrismaWorkerStore,
  QUEUES,
  startPgBossWorker,
  type RunningWorker,
  type WorkerDependencies,
  type WorkerLogger,
} from "../../../worker/src/index.js";
import { readOrderedMigrationSql } from "../../../../packages/db/test/postgres-test-support.js";
import { TestAndSandboxAccessPolicy } from "../../src/server/pilot-access-policy.js";
import { ConnectedStripePaymentReader } from "../../src/server/pilot-payment-reader.js";
import { PilotPrismaRepository } from "../../src/server/pilot-prisma-repository.js";
import type {
  PilotEnvironment,
  PilotPaymentResource,
  PilotSignedIdentity,
  PilotStoredResponse,
} from "../../src/server/pilot-ports.js";
import { PilotService, type PilotDispatchRequest } from "../../src/server/pilot-service.js";

const API_VERSION = "2026-06-24.dahlia" as const;
const CONSENT = "I_ACKNOWLEDGE_SYNTHETIC_TEST_ONLY";
const DATABASE_NAME_PATTERN = /^refunddesk_e2e_[0-9a-f]{16}$/u;
const ROLE_NAME_PATTERN = /^refunddesk_e2e_(?:web|worker)_[0-9a-f]{12}$/u;
const TEST_KEY_PATTERN = /^(?:sk|rk)_test_[A-Za-z0-9_]+$/u;
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const FIXTURE_AMOUNT_MINOR = 1_099;
const REFUND_AMOUNT_MINOR = 109;
const POLL_TIMEOUT_MILLISECONDS = 60_000;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURE_PATH = path.join(REPOSITORY_ROOT, "stripe-fixtures.local.json");
const EVIDENCE_DIRECTORY = path.join(REPOSITORY_ROOT, "sandbox-evidence.local");

interface HarnessEnvironment {
  readonly accountId: string;
  readonly adminDatabaseUrl: string;
  readonly environment: PilotEnvironment;
  readonly fixtureKey: string;
  readonly managedSandboxKey: string;
  readonly platformTestKey: string;
}

interface TerminalDatabaseState {
  readonly attempt_count: number;
  readonly attempt_state: string;
  readonly effect_state: string;
  readonly idempotency_key: string;
  readonly payment_guard_released_at: Date | null;
  readonly stripe_refund_id: string | null;
  readonly stripe_refund_status: string | null;
  readonly terminal_at: Date | null;
  readonly workflow_status: string;
}

interface InstallationIdentity {
  readonly installation_id: string;
  readonly tenant_id: string;
}

interface ExecutionQueueState {
  readonly completed_count: number;
  readonly failed_count: number;
  readonly pending_count: number;
}

const quietLogger: WorkerLogger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

let controlClient: Client | undefined;
let ownerDatabaseClient: Client | undefined;
let webDatabase: ReturnType<typeof createPrismaClient> | undefined;
let workerStore: PrismaWorkerStore | undefined;
let runningWorker: RunningWorker | undefined;
let databaseCreated = false;
let financialExecutionStarted = false;
let fullyConverged = false;
let cleanupCompleted = false;
let cleanupMustPreserve = false;
let databaseName = "";
const createdLoginRoles: string[] = [];

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`SANDBOX_E2E_MISSING_${name}`);
  }
  return value;
}

function readHarnessEnvironment(): HarnessEnvironment {
  if (requiredEnvironment("REFUNDDESK_RUN_SANDBOX_E2E") !== CONSENT) {
    throw new Error("SANDBOX_E2E_EXPLICIT_CONSENT_REQUIRED");
  }
  if (requiredEnvironment("REFUNDDESK_GLOBAL_LIVE_ENABLED") !== "false") {
    throw new Error("SANDBOX_E2E_LIVE_MODE_MUST_BE_FALSE");
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("SANDBOX_E2E_PRODUCTION_REFUSED");
  }

  const selectedEnvironment = requiredEnvironment("REFUNDDESK_SANDBOX_E2E_ENVIRONMENT");
  if (selectedEnvironment !== "test" && selectedEnvironment !== "sandbox") {
    throw new Error("SANDBOX_E2E_ENVIRONMENT_MUST_BE_TEST_OR_SANDBOX");
  }
  const environment: PilotEnvironment = selectedEnvironment;
  const accountId = requiredEnvironment("REFUNDDESK_SANDBOX_E2E_ACCOUNT_ID");
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("SANDBOX_E2E_ACCOUNT_ID_INVALID");
  }

  const platformTestKey = requiredEnvironment("STRIPE_PLATFORM_TEST_KEY");
  const managedSandboxKey = requiredEnvironment("STRIPE_MANAGED_SANDBOX_KEY");
  const fixtureKey =
    environment === "test"
      ? requiredEnvironment("STRIPE_FIXTURE_TEST_KEY")
      : requiredEnvironment("STRIPE_FIXTURE_MANAGED_SANDBOX_KEY");
  for (const [name, key] of [
    ["STRIPE_PLATFORM_TEST_KEY", platformTestKey],
    ["STRIPE_MANAGED_SANDBOX_KEY", managedSandboxKey],
    ["STRIPE_FIXTURE_KEY", fixtureKey],
  ] as const) {
    if (!TEST_KEY_PATTERN.test(key)) {
      throw new Error(`SANDBOX_E2E_NON_TEST_KEY_REJECTED_${name}`);
    }
  }
  if (platformTestKey === managedSandboxKey) {
    throw new Error("SANDBOX_E2E_STRIPE_ENVIRONMENT_KEYS_MUST_BE_DISTINCT");
  }

  const adminDatabaseUrl = requiredEnvironment("REFUNDDESK_SANDBOX_E2E_ADMIN_DATABASE_URL");
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(adminDatabaseUrl);
  } catch {
    throw new Error("SANDBOX_E2E_ADMIN_DATABASE_URL_INVALID");
  }
  if (
    (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") ||
    !LOOPBACK_HOSTS.has(databaseUrl.hostname) ||
    databaseUrl.username.length === 0 ||
    databaseUrl.password.length === 0 ||
    databaseUrl.pathname.length <= 1
  ) {
    throw new Error("SANDBOX_E2E_ADMIN_DATABASE_MUST_BE_EXPLICIT_LOOPBACK_POSTGRES");
  }

  return {
    accountId,
    adminDatabaseUrl: databaseUrl.toString(),
    environment,
    fixtureKey,
    managedSandboxKey,
    platformTestKey,
  };
}

function quoteIdentifier(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error("SANDBOX_E2E_UNSAFE_SQL_IDENTIFIER");
  }
  return `"${value}"`;
}

function quoteGeneratedPassword(value: string): string {
  if (!/^[0-9a-f]{48}$/u.test(value)) {
    throw new Error("SANDBOX_E2E_UNSAFE_GENERATED_PASSWORD");
  }
  return `'${value}'`;
}

function databaseUrlFor(
  baseConnectionString: string,
  targetDatabase: string,
  credentials?: { readonly username: string; readonly password: string },
): string {
  const url = new URL(baseConnectionString);
  url.pathname = `/${targetDatabase}`;
  if (credentials !== undefined) {
    url.username = credentials.username;
    url.password = credentials.password;
  }
  return url.toString();
}

async function migratePgBoss(ownerDatabaseUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerDatabaseUrl,
    application_name: "refunddesk-sandbox-e2e-pgboss-migration",
    createSchema: true,
    migrate: true,
    schedule: false,
    supervise: false,
  });
  boss.on("error", () => undefined);
  try {
    await boss.start();
    await boss.schemaVersion();
    await boss.stop({ graceful: true, timeout: 30_000 });
  } catch (error) {
    await boss.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
    throw error;
  }
}

async function grantPgBossRuntime(client: Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("REVOKE ALL ON SCHEMA pgboss FROM PUBLIC, refunddesk_runtime");
    await client.query("REVOKE CREATE ON SCHEMA pgboss FROM refunddesk_worker");
    await client.query("GRANT USAGE ON SCHEMA pgboss TO refunddesk_worker");
    await client.query(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM PUBLIC, refunddesk_runtime",
    );
    await client.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO refunddesk_worker",
    );
    await client.query(
      "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss FROM PUBLIC, refunddesk_runtime",
    );
    await client.query(
      "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO refunddesk_worker",
    );
    await client.query(
      "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC, refunddesk_runtime",
    );
    await client.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO refunddesk_worker");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function dispatchMutation(
  service: PilotService,
  input: {
    readonly command: Readonly<Record<string, unknown>>;
    readonly identity: PilotSignedIdentity;
    readonly operation:
      "context.sync" | "settings.update" | "refund_request.create" | "refund_request.decide";
    readonly resource: PilotPaymentResource | null;
  },
): Promise<PilotStoredResponse> {
  const requestNonce = randomUUID();
  const canonicalRequestHash = createHash("sha256")
    .update(
      JSON.stringify([
        input.operation,
        requestNonce,
        input.identity.accountId,
        input.identity.userId,
        input.command,
        input.resource,
      ]),
      "utf8",
    )
    .digest();
  return service.dispatch({
    canonicalRequestHash,
    command: input.command,
    identity: input.identity,
    mutation: true,
    operation: input.operation,
    requestNonce,
    responseRequestId: randomUUID(),
    resource: input.resource,
  } as unknown as PilotDispatchRequest);
}

function responseString(response: PilotStoredResponse, key: string): string {
  const value = response.body[key];
  if (typeof value !== "string") {
    throw new Error(`SANDBOX_E2E_RESPONSE_${key.toUpperCase()}_MISSING`);
  }
  return value;
}

async function stableStripeCall<T>(code: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(code);
  }
}

async function withTenantOwnerTransaction<T>(
  client: Client,
  tenantId: string,
  operation: (transaction: Client) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function waitForTerminalState(
  client: Client,
  tenantId: string,
  requestId: string,
): Promise<TerminalDatabaseState> {
  const deadline = Date.now() + POLL_TIMEOUT_MILLISECONDS;
  for (;;) {
    const result = await withTenantOwnerTransaction(client, tenantId, (transaction) =>
      transaction.query<TerminalDatabaseState>(
        `SELECT
           request.workflow_status,
           request.effect_state,
           request.terminal_at,
           request.payment_guard_released_at,
           execution.idempotency_key,
           execution.stripe_refund_id,
           execution.stripe_refund_status,
           COUNT(attempt.id)::INTEGER AS attempt_count,
           COALESCE(MAX(attempt.state::TEXT), '') AS attempt_state
         FROM refund_requests AS request
         LEFT JOIN refund_executions AS execution
           ON execution.request_id = request.id
          AND execution.tenant_id = request.tenant_id
         LEFT JOIN refund_execution_attempts AS attempt
           ON attempt.execution_id = execution.id
          AND attempt.tenant_id = request.tenant_id
         WHERE request.tenant_id = $1::UUID
           AND request.id = $2::UUID
         GROUP BY request.id, execution.id`,
        [tenantId, requestId],
      ),
    );
    const state = result.rows[0];
    if (
      state !== undefined &&
      (state.workflow_status === "succeeded" ||
        state.workflow_status === "failed_terminal" ||
        state.workflow_status === "reconciliation_required")
    ) {
      return state;
    }
    if (Date.now() >= deadline) {
      throw new Error("SANDBOX_E2E_TERMINAL_STATE_TIMEOUT");
    }
    await delay(250);
  }
}

async function waitForExecutionQueueIdle(
  client: Client,
  requestId: string,
  minimumCompletedCount: number,
): Promise<ExecutionQueueState> {
  const deadline = Date.now() + POLL_TIMEOUT_MILLISECONDS;
  for (;;) {
    const result = await client.query<ExecutionQueueState>(
      `SELECT
         COUNT(*) FILTER (WHERE state::TEXT IN ('created', 'retry', 'active'))::INTEGER
           AS pending_count,
         COUNT(*) FILTER (WHERE state::TEXT = 'completed')::INTEGER AS completed_count,
         COUNT(*) FILTER (WHERE state::TEXT = 'failed')::INTEGER AS failed_count
       FROM pgboss.job
       WHERE name = $1
         AND data ->> 'request_id' = $2`,
      [QUEUES.executeRefund, requestId],
    );
    const state = result.rows[0];
    if (
      state !== undefined &&
      state.pending_count === 0 &&
      state.completed_count >= minimumCompletedCount
    ) {
      if (state.failed_count !== 0) {
        throw new Error("SANDBOX_E2E_EXECUTION_QUEUE_FAILED_JOB");
      }
      return state;
    }
    if (Date.now() >= deadline) {
      throw new Error("SANDBOX_E2E_EXECUTION_QUEUE_IDLE_TIMEOUT");
    }
    await delay(250);
  }
}

async function listPaymentIntentRefunds(
  stripe: Stripe,
  paymentIntentId: string,
): Promise<readonly Stripe.Refund[]> {
  const refunds: Stripe.Refund[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stableStripeCall("SANDBOX_E2E_STRIPE_REFUND_LIST_FAILED", () =>
      stripe.refunds.list({
        limit: 100,
        payment_intent: paymentIntentId,
        ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
      }),
    );
    refunds.push(...page.data);
    if (!page.has_more) {
      return refunds;
    }
    const last = page.data.at(-1);
    if (last === undefined || last.id === startingAfter) {
      throw new Error("SANDBOX_E2E_REFUND_LIST_CURSOR_STALLED");
    }
    startingAfter = last.id;
  }
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

async function cleanupHarness(): Promise<void> {
  if (cleanupCompleted) {
    return;
  }

  let cleanupFailed = false;
  if (runningWorker !== undefined) {
    try {
      await runningWorker.stop();
      runningWorker = undefined;
    } catch {
      cleanupFailed = true;
      cleanupMustPreserve = true;
    }
  }
  if (workerStore !== undefined) {
    try {
      await workerStore.close();
      workerStore = undefined;
    } catch {
      cleanupFailed = true;
      cleanupMustPreserve = true;
    }
  }
  if (webDatabase !== undefined) {
    try {
      await webDatabase.$disconnect();
      webDatabase = undefined;
    } catch {
      cleanupFailed = true;
      cleanupMustPreserve = true;
    }
  }
  if (ownerDatabaseClient !== undefined) {
    try {
      await ownerDatabaseClient.end();
      ownerDatabaseClient = undefined;
    } catch {
      cleanupFailed = true;
      cleanupMustPreserve = true;
    }
  }

  const safeToDrop =
    !cleanupMustPreserve && !cleanupFailed && (!financialExecutionStarted || fullyConverged);
  if (databaseCreated && safeToDrop) {
    if (controlClient === undefined) {
      cleanupFailed = true;
      cleanupMustPreserve = true;
    } else {
      try {
        await controlClient.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
           WHERE datname = $1
             AND pid <> pg_backend_pid()`,
          [databaseName],
        );
        await controlClient.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName, DATABASE_NAME_PATTERN)}`,
        );
        databaseCreated = false;
        for (const role of [...createdLoginRoles].reverse()) {
          await controlClient.query(
            `DROP ROLE IF EXISTS ${quoteIdentifier(role, ROLE_NAME_PATTERN)}`,
          );
        }
        createdLoginRoles.length = 0;
      } catch {
        cleanupFailed = true;
        cleanupMustPreserve = true;
      }
    }
  }
  if (databaseCreated) {
    process.stderr.write(
      `${JSON.stringify({
        code: "SANDBOX_E2E_STATE_PRESERVED_FOR_RECONCILIATION",
        database: databaseName,
      })}\n`,
    );
  }

  if (controlClient !== undefined) {
    try {
      await controlClient.end();
      controlClient = undefined;
    } catch {
      cleanupFailed = true;
      cleanupMustPreserve = true;
    }
  }
  if (cleanupFailed) {
    throw new Error("SANDBOX_E2E_RUNTIME_SHUTDOWN_FAILED");
  }
  cleanupCompleted = true;
}

afterAll(async () => {
  await cleanupHarness();
});

describe.sequential("durable real Stripe refund flow", () => {
  it("proves approval, worker execution, idempotence, guard release, and reconciliation", async () => {
    const environment = readHarnessEnvironment();
    const runId = randomUUID();
    databaseName = `refunddesk_e2e_${randomBytes(8).toString("hex")}`;
    const webRole = `refunddesk_e2e_web_${randomBytes(6).toString("hex")}`;
    const workerRole = `refunddesk_e2e_worker_${randomBytes(6).toString("hex")}`;
    const webPassword = randomBytes(24).toString("hex");
    const workerPassword = randomBytes(24).toString("hex");
    const adminDatabaseUrl = new URL(environment.adminDatabaseUrl);
    const controlDatabaseName = decodeURIComponent(adminDatabaseUrl.pathname.slice(1));
    if (controlDatabaseName.length === 0 || controlDatabaseName === databaseName) {
      throw new Error("SANDBOX_E2E_CONTROL_DATABASE_INVALID");
    }

    controlClient = new Client({
      connectionString: environment.adminDatabaseUrl,
      application_name: "refunddesk-sandbox-e2e-control",
    });
    await controlClient.connect();
    const preflight = await controlClient.query<{
      readonly current_user: string;
      readonly rolcreatedb: boolean;
      readonly rolcreaterole: boolean;
      readonly server_version_num: string;
    }>(
      `SELECT
         current_user,
         role.rolcreatedb,
         role.rolcreaterole,
         current_setting('server_version_num') AS server_version_num
       FROM pg_roles AS role
       WHERE role.rolname = current_user`,
    );
    const databaseRole = preflight.rows[0];
    if (
      databaseRole === undefined ||
      databaseRole.current_user !== decodeURIComponent(adminDatabaseUrl.username) ||
      !databaseRole.rolcreatedb ||
      !databaseRole.rolcreaterole ||
      Math.trunc(Number.parseInt(databaseRole.server_version_num, 10) / 10_000) !== 18
    ) {
      throw new Error("SANDBOX_E2E_POSTGRES_ADMIN_PREFLIGHT_FAILED");
    }

    await controlClient.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName, DATABASE_NAME_PATTERN)} TEMPLATE template0`,
    );
    databaseCreated = true;
    const ownerEphemeralUrl = databaseUrlFor(environment.adminDatabaseUrl, databaseName);
    ownerDatabaseClient = new Client({
      connectionString: ownerEphemeralUrl,
      application_name: "refunddesk-sandbox-e2e-owner",
    });
    await ownerDatabaseClient.connect();

    const [migrations, runtimeRolesSql] = await Promise.all([
      readOrderedMigrationSql(),
      readFile(
        new URL("../../../../packages/db/prisma/runtime-roles.sql", import.meta.url),
        "utf8",
      ),
    ]);
    for (const migration of migrations) {
      await ownerDatabaseClient.query(migration);
    }
    await ownerDatabaseClient.query(runtimeRolesSql);

    for (const login of [
      { role: webRole, password: webPassword, capability: "refunddesk_runtime" },
      { role: workerRole, password: workerPassword, capability: "refunddesk_worker" },
    ] as const) {
      await controlClient.query(
        `CREATE ROLE ${quoteIdentifier(login.role, ROLE_NAME_PATTERN)}
         LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION
         PASSWORD ${quoteGeneratedPassword(login.password)}`,
      );
      createdLoginRoles.push(login.role);
      await controlClient.query(
        `GRANT ${login.capability} TO ${quoteIdentifier(login.role, ROLE_NAME_PATTERN)}`,
      );
    }

    await migratePgBoss(ownerEphemeralUrl);
    await grantPgBossRuntime(ownerDatabaseClient);

    const webDatabaseUrl = databaseUrlFor(ownerEphemeralUrl, databaseName, {
      username: webRole,
      password: webPassword,
    });
    const workerDatabaseUrl = databaseUrlFor(ownerEphemeralUrl, databaseName, {
      username: workerRole,
      password: workerPassword,
    });

    const fieldKey = randomBytes(32);
    const proofKey = randomBytes(32);
    const exportKey = randomBytes(32);
    const proofs = new RefundProofKeyring({
      active: { key: proofKey, version: "v1" },
    });
    const stripeGateway = new ConnectedAccountStripeClient(
      new StripeCredentialResolver({
        platformTestKey: environment.platformTestKey,
        managedSandboxKey: environment.managedSandboxKey,
      }),
    );

    webDatabase = createPrismaClient({
      connectionString: webDatabaseUrl,
      maxConnections: 4,
    });
    const repository = new PilotPrismaRepository({
      appBaseUrl: "http://127.0.0.1:3000",
      auditSigningKey: exportKey,
      client: webDatabase,
      fieldKeyring: new FieldEncryptionKeyring({
        active: { key: fieldKey, version: "v1" },
      }),
    });
    const service = new PilotService(
      repository,
      new ConnectedStripePaymentReader(stripeGateway),
      new TestAndSandboxAccessPolicy(),
    );

    const fixtureStripe = new Stripe(environment.fixtureKey, {
      apiVersion: API_VERSION,
      maxNetworkRetries: 0,
      telemetry: false,
    });
    const fixtureAccount = await stableStripeCall("SANDBOX_E2E_STRIPE_ACCOUNT_BIND_FAILED", () =>
      fixtureStripe.accounts.retrieve(null),
    );
    if (fixtureAccount.id !== environment.accountId) {
      throw new Error("SANDBOX_E2E_FIXTURE_KEY_ACCOUNT_MISMATCH");
    }
    const fixtureIdempotencyKey = `refunddesk:e2e:payment-intent:${runId}`;
    await writeFile(
      FIXTURE_PATH,
      `${JSON.stringify(
        {
          schema_version: 1,
          run_fingerprint: hashIdentifier(runId),
          environment: environment.environment,
          stripe_account_fingerprint: hashIdentifier(environment.accountId),
          state: "payment_intent_create_pending",
          amount_minor: FIXTURE_AMOUNT_MINOR,
          currency: "eur",
          fixture_idempotency_key_hash: hashIdentifier(fixtureIdempotencyKey),
          created_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8" },
    );
    const paymentIntent = await stableStripeCall("SANDBOX_E2E_STRIPE_FIXTURE_CREATE_FAILED", () =>
      fixtureStripe.paymentIntents.create(
        {
          amount: FIXTURE_AMOUNT_MINOR,
          automatic_payment_methods: {
            allow_redirects: "never",
            enabled: true,
          },
          confirm: true,
          currency: "eur",
          expand: ["latest_charge"],
          metadata: {
            refunddesk_e2e_run: runId,
          },
          payment_method: "pm_card_visa",
        },
        {
          idempotencyKey: fixtureIdempotencyKey,
        },
      ),
    );
    if (
      paymentIntent.livemode ||
      paymentIntent.status !== "succeeded" ||
      paymentIntent.amount_received !== FIXTURE_AMOUNT_MINOR ||
      paymentIntent.currency !== "eur" ||
      paymentIntent.latest_charge === null ||
      typeof paymentIntent.latest_charge === "string"
    ) {
      throw new Error("SANDBOX_E2E_PAYMENT_INTENT_FIXTURE_INVALID");
    }
    const charge = paymentIntent.latest_charge;
    if (
      !charge.paid ||
      !charge.captured ||
      charge.amount_captured !== FIXTURE_AMOUNT_MINOR ||
      charge.currency !== "eur" ||
      charge.payment_method_details?.type !== "card" ||
      charge.application != null ||
      charge.application_fee != null ||
      charge.on_behalf_of != null ||
      charge.source_transfer != null ||
      charge.transfer != null ||
      charge.transfer_group != null ||
      paymentIntent.application != null ||
      paymentIntent.application_fee_amount != null ||
      paymentIntent.on_behalf_of != null ||
      paymentIntent.transfer_data != null ||
      paymentIntent.transfer_group != null
    ) {
      throw new Error("SANDBOX_E2E_CARD_FIXTURE_NOT_PILOT_ELIGIBLE");
    }
    await writeFile(
      FIXTURE_PATH,
      `${JSON.stringify(
        {
          schema_version: 1,
          run_fingerprint: hashIdentifier(runId),
          environment: environment.environment,
          stripe_account_fingerprint: hashIdentifier(environment.accountId),
          state: "payment_intent_succeeded",
          payment_intent_fingerprint: hashIdentifier(paymentIntent.id),
          charge_fingerprint: hashIdentifier(charge.id),
          amount_minor: FIXTURE_AMOUNT_MINOR,
          currency: "eur",
          fixture_idempotency_key_hash: hashIdentifier(fixtureIdempotencyKey),
          created_at: new Date(paymentIntent.created * 1_000).toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8" },
    );

    const identitySuffix = randomBytes(6).toString("hex");
    const adminIdentity: PilotSignedIdentity = {
      accountId: environment.accountId,
      environment: environment.environment,
      roles: [{ id: "super_admin", name: "Super Administrator", type: "builtIn" }],
      rolesAsserted: true,
      userId: `usr_E2EAdmin${identitySuffix}`,
    };
    const requesterIdentity: PilotSignedIdentity = {
      accountId: environment.accountId,
      environment: environment.environment,
      roles: [],
      rolesAsserted: false,
      userId: `usr_E2ERequester${identitySuffix}`,
    };

    const adminContext = await dispatchMutation(service, {
      command: {},
      identity: adminIdentity,
      operation: "context.sync",
      resource: null,
    });
    expect(adminContext.status).toBe(200);
    const requesterContext = await dispatchMutation(service, {
      command: {},
      identity: requesterIdentity,
      operation: "context.sync",
      resource: null,
    });
    expect(requesterContext.status).toBe(200);
    const settings = await dispatchMutation(service, {
      command: {
        approver_user_ids: [adminIdentity.userId],
        expiration_days: 7,
        onboarding_completed: true,
      },
      identity: adminIdentity,
      operation: "settings.update",
      resource: null,
    });
    expect(settings.status).toBe(200);

    const resolvedContext = await repository.resolveContext(adminIdentity, {
      allowProvision: false,
    });
    if (
      resolvedContext === null ||
      resolvedContext.stripeAccountId !== environment.accountId ||
      resolvedContext.environment !== environment.environment
    ) {
      throw new Error("SANDBOX_E2E_INSTALLATION_NOT_PROVISIONED");
    }
    const installationIdentity: InstallationIdentity = {
      installation_id: resolvedContext.installationId,
      tenant_id: resolvedContext.tenantId,
    };

    const resource: PilotPaymentResource = {
      id: paymentIntent.id,
      type: "payment_intent",
    };
    const created = await dispatchMutation(service, {
      command: {
        amount_minor: String(REFUND_AMOUNT_MINOR),
        currency: "eur",
        justification: "Synthetic card refund for the durable Stripe safety gate.",
        reason: "requested_by_customer",
      },
      identity: requesterIdentity,
      operation: "refund_request.create",
      resource,
    });
    expect(created.status).toBe(200);
    const requestId = responseString(created, "request_id");
    expect(responseString(created, "status")).toBe("pending_approval");

    const decided = await dispatchMutation(service, {
      command: {
        decision: "approve",
        request_id: requestId,
      },
      identity: adminIdentity,
      operation: "refund_request.decide",
      resource,
    });
    expect(decided.status).toBe(200);
    expect(responseString(decided, "status")).toBe("approved");

    const beforeWorker = await withTenantOwnerTransaction(
      ownerDatabaseClient,
      installationIdentity.tenant_id,
      (transaction) =>
        transaction.query<{
          readonly decision_count: number;
          readonly distinct_actor_count: number;
          readonly effect_state: string;
          readonly execution_count: number;
          readonly payment_guard_released_at: Date | null;
          readonly workflow_status: string;
        }>(
          `SELECT
             request.workflow_status,
             request.effect_state,
             request.payment_guard_released_at,
             COUNT(DISTINCT decision.id)::INTEGER AS decision_count,
             COUNT(DISTINCT execution.id)::INTEGER AS execution_count,
             COUNT(DISTINCT CASE
               WHEN decision.approver_user_id <> request.requester_user_id
               THEN decision.approver_user_id
             END)::INTEGER AS distinct_actor_count
           FROM refund_requests AS request
           LEFT JOIN approval_decisions AS decision
             ON decision.request_id = request.id
            AND decision.tenant_id = request.tenant_id
           LEFT JOIN refund_executions AS execution
             ON execution.request_id = request.id
            AND execution.tenant_id = request.tenant_id
           WHERE request.id = $1::UUID
             AND request.tenant_id = $2::UUID
           GROUP BY request.id`,
          [requestId, installationIdentity.tenant_id],
        ),
    );
    expect(beforeWorker.rows[0]).toMatchObject({
      decision_count: 1,
      distinct_actor_count: 1,
      effect_state: "not_started",
      execution_count: 0,
      payment_guard_released_at: null,
      workflow_status: "approved",
    });

    const workerDatabase = createPrismaClient({
      connectionString: workerDatabaseUrl,
      maxConnections: 4,
    });
    workerStore = new PrismaWorkerStore(workerDatabase, proofs);
    const workerDependencies: WorkerDependencies = {
      clock: { now: () => new Date() },
      logger: quietLogger,
      proofs,
      store: workerStore,
      stripe: stripeGateway,
    };
    const workerConfig: RefundDeskConfig = {
      appBaseUrl: "http://127.0.0.1:3000",
      databaseUrl: webDatabaseUrl,
      keys: {
        activeFieldVersion: "v1",
        activeProofVersion: "v1",
        exportV1: exportKey,
        fieldV1: fieldKey,
        proofV1: proofKey,
      },
      liveEnabled: false,
      logLevel: "error",
      migrationDatabaseUrl: ownerEphemeralUrl,
      nodeEnv: "test",
      pgBossDatabaseUrl: workerDatabaseUrl,
      stripe: {
        apiVersion: API_VERSION,
        appId: "ca_RefundDeskE2E",
        appSigningSecret: "absec_refunddesk_e2e",
        connectedLiveWebhookSecret: "disabled",
        connectedSandboxWebhookSecret: "whsec_refunddesk_e2e_sandbox",
        connectedTestWebhookSecret: "whsec_refunddesk_e2e_test",
        managedSandboxKey: environment.managedSandboxKey,
        platformTestKey: environment.platformTestKey,
      },
      workerDatabaseUrl,
    };

    financialExecutionStarted = true;
    runningWorker = await startPgBossWorker(workerConfig, workerDependencies);
    const terminalState = await waitForTerminalState(
      ownerDatabaseClient,
      installationIdentity.tenant_id,
      requestId,
    );
    const expectedIdempotencyKey = refundIdempotencyKey(requestId);
    if (
      terminalState.attempt_count !== 1 ||
      terminalState.attempt_state !== "completed" ||
      terminalState.effect_state !== "identified" ||
      terminalState.idempotency_key !== expectedIdempotencyKey ||
      terminalState.stripe_refund_status !== "succeeded" ||
      terminalState.workflow_status !== "succeeded" ||
      !/^re_[A-Za-z0-9]+$/u.test(terminalState.stripe_refund_id ?? "") ||
      !(terminalState.terminal_at instanceof Date) ||
      !(terminalState.payment_guard_released_at instanceof Date) ||
      terminalState.payment_guard_released_at.getTime() !== terminalState.terminal_at.getTime()
    ) {
      throw new Error("SANDBOX_E2E_TERMINAL_STATE_INVALID");
    }
    const refundId = terminalState.stripe_refund_id;
    if (refundId === null || terminalState.terminal_at === null) {
      throw new Error("SANDBOX_E2E_REFUND_IDENTITY_NOT_DURABLE");
    }

    const initialQueueState = await waitForExecutionQueueIdle(ownerDatabaseClient, requestId, 1);
    const linkedRefund = await stableStripeCall("SANDBOX_E2E_STRIPE_REFUND_READ_FAILED", () =>
      fixtureStripe.refunds.retrieve(refundId),
    );
    if (
      linkedRefund.id !== refundId ||
      linkedRefund.payment_intent !== paymentIntent.id ||
      linkedRefund.charge !== charge.id ||
      linkedRefund.amount !== REFUND_AMOUNT_MINOR ||
      linkedRefund.currency !== "eur" ||
      linkedRefund.status !== "succeeded"
    ) {
      throw new Error("SANDBOX_E2E_LINKED_REFUND_INVALID");
    }
    const linkedRefundMetadata = linkedRefund.metadata ?? {};
    if (
      linkedRefundMetadata["refunddesk_request_id"] !== requestId ||
      !proofs.verify(
        {
          amountMinor: BigInt(REFUND_AMOUNT_MINOR),
          currency: "eur",
          environment: environment.environment,
          paymentKey: paymentIntent.id,
          requestId,
          stripeAccountId: environment.accountId,
          tenantId: installationIdentity.tenant_id,
        },
        linkedRefundMetadata["refunddesk_proof"] ?? "",
      )
    ) {
      throw new Error("SANDBOX_E2E_LINKED_REFUND_PROOF_INVALID");
    }

    const firstReplayJobId = await runningWorker.publisher.enqueueRefundExecution({
      request_id: requestId,
      tenant_id: installationIdentity.tenant_id,
    });
    const secondReplayJobId = await runningWorker.publisher.enqueueRefundExecution({
      request_id: requestId,
      tenant_id: installationIdentity.tenant_id,
    });
    const acceptedReplayCount = [firstReplayJobId, secondReplayJobId].filter(
      (jobId) => jobId !== null,
    ).length;
    if (acceptedReplayCount < 1 || acceptedReplayCount > 2) {
      throw new Error("SANDBOX_E2E_QUEUE_SINGLETON_REPLAY_INVALID");
    }
    const replayQueueState = await waitForExecutionQueueIdle(
      ownerDatabaseClient,
      requestId,
      initialQueueState.completed_count + acceptedReplayCount,
    );
    await handleRefundExecutionJob(
      {
        request_id: requestId,
        tenant_id: installationIdentity.tenant_id,
      },
      workerDependencies,
    );

    const refundsAfterReplay = await listPaymentIntentRefunds(fixtureStripe, paymentIntent.id);
    if (refundsAfterReplay.length !== 1 || refundsAfterReplay[0]?.id !== refundId) {
      throw new Error("SANDBOX_E2E_REFUND_REPLAY_CREATED_DUPLICATE");
    }
    const replayDatabaseState = await withTenantOwnerTransaction(
      ownerDatabaseClient,
      installationIdentity.tenant_id,
      (transaction) =>
        transaction.query<{
          readonly attempt_count: number;
          readonly stripe_refund_id: string;
          readonly terminal_at: Date;
          readonly payment_guard_released_at: Date;
        }>(
          `SELECT
             execution.stripe_refund_id,
             request.terminal_at,
             request.payment_guard_released_at,
             COUNT(attempt.id)::INTEGER AS attempt_count
           FROM refund_requests AS request
           INNER JOIN refund_executions AS execution
             ON execution.request_id = request.id
            AND execution.tenant_id = request.tenant_id
           LEFT JOIN refund_execution_attempts AS attempt
             ON attempt.execution_id = execution.id
            AND attempt.tenant_id = execution.tenant_id
           WHERE request.id = $1::UUID
             AND request.tenant_id = $2::UUID
           GROUP BY request.id, execution.id`,
          [requestId, installationIdentity.tenant_id],
        ),
    );
    const replayState = replayDatabaseState.rows[0];
    if (
      replayState === undefined ||
      replayState.attempt_count !== 1 ||
      replayState.stripe_refund_id !== refundId ||
      replayState.terminal_at.getTime() !== terminalState.terminal_at.getTime() ||
      replayState.payment_guard_released_at.getTime() !== terminalState.terminal_at.getTime()
    ) {
      throw new Error("SANDBOX_E2E_DURABLE_REPLAY_STATE_INVALID");
    }

    const scanStartedAt = new Date();
    await handleReconciliationScanJob({ scope: "all" }, workerDependencies);
    const scanCompletedAt = new Date();
    const reconciliation = await withTenantOwnerTransaction(
      ownerDatabaseClient,
      installationIdentity.tenant_id,
      (transaction) =>
        transaction.query<{
          readonly checkpoint_committed_through: Date | null;
          readonly checkpoint_page_in_progress: boolean | null;
          readonly checkpoint_scan_window_end: Date | null;
          readonly checkpoint_starting_after: string | null;
          readonly external_alert_count: number;
          readonly mutation_receipt_count: number;
          readonly refund_audit_actions: string[];
          readonly workflow_audit_actions: string[];
        }>(
          `SELECT
             ARRAY(
               SELECT action
               FROM audit_events
               WHERE tenant_id = $1::UUID
                 AND entity_id = $4
               ORDER BY occurred_at, id
             ) AS workflow_audit_actions,
             ARRAY(
               SELECT action
               FROM audit_events
               WHERE tenant_id = $1::UUID
                 AND entity_id = $3
               ORDER BY occurred_at, id
             ) AS refund_audit_actions,
             (
               SELECT committed_through
               FROM reconciliation_checkpoints
               WHERE tenant_id = $1::UUID
                 AND installation_id = $2::UUID
             ) AS checkpoint_committed_through,
             (
               SELECT page_in_progress
               FROM reconciliation_checkpoints
               WHERE tenant_id = $1::UUID
                 AND installation_id = $2::UUID
             ) AS checkpoint_page_in_progress,
             (
               SELECT scan_window_end
               FROM reconciliation_checkpoints
               WHERE tenant_id = $1::UUID
                 AND installation_id = $2::UUID
             ) AS checkpoint_scan_window_end,
             (
               SELECT starting_after
               FROM reconciliation_checkpoints
               WHERE tenant_id = $1::UUID
                 AND installation_id = $2::UUID
             ) AS checkpoint_starting_after,
             (
               SELECT COUNT(*)::INTEGER
               FROM external_refund_alerts
               WHERE tenant_id = $1::UUID
                 AND stripe_refund_id = $3
             ) AS external_alert_count,
             (
               SELECT COUNT(*)::INTEGER
               FROM api_mutation_receipts
               WHERE tenant_id = $1::UUID
             ) AS mutation_receipt_count`,
          [
            installationIdentity.tenant_id,
            installationIdentity.installation_id,
            refundId,
            requestId,
          ],
        ),
    );
    const reconciliationState = reconciliation.rows[0];
    if (reconciliationState === undefined) {
      throw new Error("SANDBOX_E2E_RECONCILIATION_STATE_MISSING");
    }
    const checkpointCommittedThrough = reconciliationState.checkpoint_committed_through;
    const checkpointComplete =
      checkpointCommittedThrough instanceof Date &&
      reconciliationState.checkpoint_page_in_progress === false &&
      reconciliationState.checkpoint_scan_window_end === null &&
      reconciliationState.checkpoint_starting_after === null;
    const checkpointBounded =
      checkpointCommittedThrough instanceof Date &&
      checkpointCommittedThrough.getTime() >= scanStartedAt.getTime() &&
      checkpointCommittedThrough.getTime() <= scanCompletedAt.getTime();
    const workflowAuditComplete =
      reconciliationState.workflow_audit_actions.includes("refund_request.created") &&
      reconciliationState.workflow_audit_actions.includes("refund_request.approved");
    const refundAuditComplete =
      reconciliationState.refund_audit_actions.includes("refund.linked_status_refreshed") &&
      reconciliationState.refund_audit_actions.includes("refund.observed");
    if (
      !checkpointComplete ||
      !checkpointBounded ||
      reconciliationState.external_alert_count !== 0 ||
      reconciliationState.mutation_receipt_count !== 5 ||
      !workflowAuditComplete ||
      !refundAuditComplete
    ) {
      throw new Error("SANDBOX_E2E_RECONCILIATION_STATE_INVALID");
    }

    const recentEvents = await stableStripeCall("SANDBOX_E2E_STRIPE_EVENT_READ_FAILED", () =>
      fixtureStripe.events.list({
        created: { gte: Math.max(0, paymentIntent.created - 60) },
        limit: 100,
        type: "refund.created",
      }),
    );
    const refundEvent = recentEvents.data.find((event) => {
      const object = event.data.object as { readonly id?: string };
      return object.id === refundId;
    });
    const eventIdempotencyKey = refundEvent?.request?.idempotency_key ?? null;
    expect(eventIdempotencyKey === null || eventIdempotencyKey === expectedIdempotencyKey).toBe(
      true,
    );

    const evidenceGeneratedAt = new Date().toISOString();
    const evidencePath = path.join(
      EVIDENCE_DIRECTORY,
      `durable-refund-flow-${evidenceGeneratedAt.replaceAll(/[:.]/gu, "-")}.json`,
    );
    const evidence = {
      schema_version: 1,
      gate: "durable_real_stripe_refund_flow",
      result: "PASS",
      generated_at: evidenceGeneratedAt,
      stripe: {
        livemode: false,
        environment: environment.environment,
        account_fingerprint: hashIdentifier(environment.accountId),
        payment_intent_fingerprint: hashIdentifier(paymentIntent.id),
        refund_fingerprint: hashIdentifier(refundId),
        amount_minor: REFUND_AMOUNT_MINOR,
        currency: "eur",
        status: linkedRefund.status,
        refund_count_for_payment_intent: refundsAfterReplay.length,
        event_idempotency_key_present: eventIdempotencyKey !== null,
        event_idempotency_key_matches:
          eventIdempotencyKey === null ? null : eventIdempotencyKey === expectedIdempotencyKey,
      },
      durable_state: {
        request_fingerprint: hashIdentifier(requestId),
        workflow_status: terminalState.workflow_status,
        effect_state: terminalState.effect_state,
        attempt_count: replayState.attempt_count,
        first_refund_link_immutable: replayState.stripe_refund_id === refundId,
        idempotency_key_present: terminalState.idempotency_key.length > 0,
        idempotency_key_matches: terminalState.idempotency_key === expectedIdempotencyKey,
        idempotency_key_fingerprint: hashIdentifier(expectedIdempotencyKey),
        guard_released_at_terminal:
          terminalState.payment_guard_released_at?.getTime() ===
          terminalState.terminal_at.getTime(),
        approval_decision_count: beforeWorker.rows[0]?.decision_count ?? 0,
        distinct_approver_count: beforeWorker.rows[0]?.distinct_actor_count ?? 0,
        mutation_receipt_count: reconciliationState.mutation_receipt_count,
        execution_queue_initial_completed_count: initialQueueState.completed_count,
        execution_queue_replay_accepted_count: acceptedReplayCount,
        execution_queue_final_completed_count: replayQueueState.completed_count,
      },
      reconciliation: {
        checkpoint_present: checkpointCommittedThrough instanceof Date,
        checkpoint_complete: checkpointComplete,
        checkpoint_committed_within_scan: checkpointBounded,
        linked_refresh_audited: reconciliationState.refund_audit_actions.includes(
          "refund.linked_status_refreshed",
        ),
        scan_observation_audited:
          reconciliationState.refund_audit_actions.includes("refund.observed"),
        workflow_audit_complete: workflowAuditComplete,
        workflow_refund_alert_count: reconciliationState.external_alert_count,
      },
      cleanup_policy: "drop_ephemeral_database_and_logins_before_writing_pass_evidence",
      cleanup_completed: true,
    };
    fullyConverged = true;
    await writeFile(
      FIXTURE_PATH,
      `${JSON.stringify(
        {
          schema_version: 1,
          run_fingerprint: hashIdentifier(runId),
          environment: environment.environment,
          stripe_account_fingerprint: hashIdentifier(environment.accountId),
          state: "refund_converged",
          payment_intent_fingerprint: hashIdentifier(paymentIntent.id),
          charge_fingerprint: hashIdentifier(charge.id),
          refund_fingerprint: hashIdentifier(refundId),
          amount_minor: REFUND_AMOUNT_MINOR,
          currency: "eur",
          evidence_file: path.relative(REPOSITORY_ROOT, evidencePath),
          created_at: new Date(paymentIntent.created * 1_000).toISOString(),
          converged_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8" },
    );
    await cleanupHarness();
    await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
    const temporaryEvidencePath = `${evidencePath}.tmp-${randomUUID()}`;
    await writeFile(temporaryEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryEvidencePath, evidencePath);
  });
});
