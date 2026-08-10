import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { PgBoss } from "pg-boss";
import { Client } from "pg";
import Stripe from "stripe";
import { afterAll, describe, expect, it } from "vitest";

import type { WorkerConfig } from "@refunddesk/config";
import { createPrismaClient } from "@refunddesk/db";
import {
  ApprovalAttestationKeyring,
  FieldEncryptionKeyring,
  RefundProofKeyring,
  refundIdempotencyKey,
} from "@refunddesk/domain";
import { DirectAccountStripeClient, StripeCredentialResolver } from "@refunddesk/stripe-adapter";

import {
  handleReconciliationScanJob,
  handleRefundExecutionJob,
  PrismaWorkerStore,
  QUEUES,
  startPgBossWorker,
  WorkerQueuePublisher,
  type RunningWorker,
  type WorkerDependencies,
  type WorkerLogger,
} from "../../../worker/src/index.js";
import { readOrderedMigrationSql } from "../../../../packages/db/test/postgres-test-support.js";
import { TestAndSandboxAccessPolicy } from "../../src/server/pilot-access-policy.js";
import { ConfiguredAccountAdmission } from "../../src/server/pilot-account-admission.js";
import { DirectStripePaymentReader } from "../../src/server/pilot-payment-reader.js";
import { PilotPrismaRepository } from "../../src/server/pilot-prisma-repository.js";
import type {
  PilotEnvironment,
  PilotPaymentResource,
  PilotSignedIdentity,
  PilotStoredResponse,
} from "../../src/server/pilot-ports.js";
import { PilotService, type PilotDispatchRequest } from "../../src/server/pilot-service.js";
import {
  assertDedicatedPostgresClusterPreflight,
  assertDisposablePostgresCluster,
  assertExclusiveSingletonEnqueue,
  readSandboxE2EScenario,
  SANDBOX_E2E_SCENARIO_PAYMENT_METHODS,
  type SandboxE2EScenario,
} from "../sandbox-harness-guards.js";

const API_VERSION = "2026-06-24.dahlia" as const;
const CONSENT = "I_ACKNOWLEDGE_SYNTHETIC_TEST_ONLY";
const DATABASE_NAME_PATTERN = /^refunddesk_e2e_[0-9a-f]{16}$/u;
const ROLE_NAME_PATTERN = /^refunddesk_e2e_(?:web|worker|queue)_[0-9a-f]{12}$/u;
const TEST_KEY_PATTERN = /^(?:sk|rk)_test_[A-Za-z0-9_]+$/u;
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const FIXTURE_AMOUNT_MINOR = 1_099;
const REFUND_AMOUNT_MINOR = 109;
const POLL_TIMEOUT_MILLISECONDS = 60_000;
const ASYNC_REFUND_TIMEOUT_MILLISECONDS = 90_000;
const ASYNC_REFUND_POLL_MILLISECONDS = 1_000;
const EVENT_OBSERVATION_TIMEOUT_MILLISECONDS = 30_000;
const EVENT_OBSERVATION_POLL_MILLISECONDS = 500;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const HARNESS_SOURCE_PATH = fileURLToPath(import.meta.url);
const FIXTURE_PATH = path.join(REPOSITORY_ROOT, "stripe-fixtures.local.json");
const EVIDENCE_DIRECTORY = path.join(REPOSITORY_ROOT, "sandbox-evidence.local");

interface HarnessEnvironment {
  readonly accountId: string;
  readonly adminDatabaseUrl: string;
  readonly environment: PilotEnvironment;
  readonly fixtureKey: string;
  readonly managedSandboxAccountId: string;
  readonly managedSandboxEffectKey: string;
  readonly platformTestAccountId: string;
  readonly platformTestEffectKey: string;
  readonly scenario: SandboxE2EScenario;
  readonly sourceRevision: string;
}

interface DurableDatabaseState {
  readonly attempt_count: number;
  readonly attempt_finished_at: Date | null;
  readonly attempt_state: string;
  readonly effect_state: string;
  readonly execution_reconciled_at: Date | null;
  readonly execution_started_at: Date | null;
  readonly idempotency_key: string;
  readonly last_stripe_event_created_at: Date | null;
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
let singletonProbeBoss: PgBoss | undefined;
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
  assertDisposablePostgresCluster(process.env);
  if (requiredEnvironment("REFUNDDESK_GLOBAL_LIVE_ENABLED") !== "false") {
    throw new Error("SANDBOX_E2E_LIVE_MODE_MUST_BE_FALSE");
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("SANDBOX_E2E_PRODUCTION_REFUSED");
  }
  const scenario = readSandboxE2EScenario(process.env);
  const sourceRevision = requiredEnvironment("REFUNDDESK_SANDBOX_E2E_SOURCE_REVISION");
  if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) {
    throw new Error("SANDBOX_E2E_SOURCE_REVISION_INVALID");
  }

  const selectedEnvironment = requiredEnvironment("REFUNDDESK_SANDBOX_E2E_ENVIRONMENT");
  if (selectedEnvironment !== "test" && selectedEnvironment !== "sandbox") {
    throw new Error("SANDBOX_E2E_ENVIRONMENT_MUST_BE_TEST_OR_SANDBOX");
  }
  const environment: PilotEnvironment = selectedEnvironment;
  const platformTestAccountId = requiredEnvironment("STRIPE_PLATFORM_TEST_ACCOUNT_ID");
  const managedSandboxAccountId = requiredEnvironment("STRIPE_MANAGED_SANDBOX_ACCOUNT_ID");
  const accountId = environment === "test" ? platformTestAccountId : managedSandboxAccountId;
  if (
    !ACCOUNT_ID_PATTERN.test(platformTestAccountId) ||
    !ACCOUNT_ID_PATTERN.test(managedSandboxAccountId)
  ) {
    throw new Error("SANDBOX_E2E_ACCOUNT_ID_INVALID");
  }
  if (platformTestAccountId === managedSandboxAccountId) {
    throw new Error("SANDBOX_E2E_STRIPE_ENVIRONMENT_ACCOUNTS_MUST_BE_DISTINCT");
  }

  const platformTestEffectKey = requiredEnvironment("STRIPE_PLATFORM_TEST_EFFECT_KEY");
  const managedSandboxEffectKey = requiredEnvironment("STRIPE_MANAGED_SANDBOX_EFFECT_KEY");
  const fixtureKey =
    environment === "test"
      ? requiredEnvironment("STRIPE_FIXTURE_TEST_KEY")
      : requiredEnvironment("STRIPE_FIXTURE_MANAGED_SANDBOX_KEY");
  for (const [name, key] of [
    ["STRIPE_PLATFORM_TEST_EFFECT_KEY", platformTestEffectKey],
    ["STRIPE_MANAGED_SANDBOX_EFFECT_KEY", managedSandboxEffectKey],
    ["STRIPE_FIXTURE_KEY", fixtureKey],
  ] as const) {
    if (!TEST_KEY_PATTERN.test(key)) {
      throw new Error(`SANDBOX_E2E_NON_TEST_KEY_REJECTED_${name}`);
    }
  }
  if (platformTestEffectKey === managedSandboxEffectKey) {
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
    managedSandboxAccountId,
    managedSandboxEffectKey,
    platformTestAccountId,
    platformTestEffectKey,
    scenario,
    sourceRevision,
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
    await client.query(
      "REVOKE ALL ON SCHEMA pgboss FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue",
    );
    await client.query("GRANT USAGE ON SCHEMA pgboss TO refunddesk_queue");
    await client.query(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue",
    );
    await client.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO refunddesk_queue",
    );
    await client.query(
      "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue",
    );
    await client.query(
      "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO refunddesk_queue",
    );
    await client.query(
      "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC, refunddesk_runtime, refunddesk_worker, refunddesk_queue",
    );
    await client.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO refunddesk_queue");
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
    readonly approvalAttestationId?: string | null;
    readonly canonicalRequestHash?: Uint8Array;
    readonly requestNonce?: string;
  },
): Promise<PilotStoredResponse> {
  const requestNonce = input.requestNonce ?? randomUUID();
  const canonicalRequestHash =
    input.canonicalRequestHash ??
    createHash("sha256")
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
    approvalAttestationId: input.approvalAttestationId ?? null,
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

async function readDurableState(
  client: Client,
  tenantId: string,
  requestId: string,
): Promise<DurableDatabaseState | null> {
  const result = await withTenantOwnerTransaction(client, tenantId, (transaction) =>
    transaction.query<DurableDatabaseState>(
      `SELECT
         request.workflow_status,
         request.effect_state,
         request.execution_started_at,
         request.terminal_at,
         request.payment_guard_released_at,
         execution.idempotency_key,
         execution.stripe_refund_id,
         execution.stripe_refund_status,
         execution.last_stripe_event_created_at,
         execution.reconciled_at AS execution_reconciled_at,
         COUNT(attempt.id)::INTEGER AS attempt_count,
         COALESCE(MAX(attempt.state::TEXT), '') AS attempt_state,
         MAX(attempt.finished_at) AS attempt_finished_at
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
  return result.rows[0] ?? null;
}

function assertInitialScenarioState(
  state: DurableDatabaseState,
  scenario: SandboxE2EScenario,
  expectedIdempotencyKey: string,
): void {
  const expectedInitialRefundStatus = scenario === "pending_refund" ? "pending" : "succeeded";
  const timestampOrderValid =
    state.execution_started_at instanceof Date &&
    state.attempt_finished_at instanceof Date &&
    state.execution_reconciled_at instanceof Date &&
    state.execution_started_at.getTime() <= state.attempt_finished_at.getTime() &&
    state.attempt_finished_at.getTime() <= state.execution_reconciled_at.getTime();
  const commonValid =
    state.attempt_count === 1 &&
    state.attempt_state === "completed" &&
    state.effect_state === "identified" &&
    state.idempotency_key === expectedIdempotencyKey &&
    state.last_stripe_event_created_at === null &&
    /^re_[A-Za-z0-9]+$/u.test(state.stripe_refund_id ?? "") &&
    state.stripe_refund_status === expectedInitialRefundStatus &&
    timestampOrderValid;
  const lifecycleValid =
    scenario === "pending_refund"
      ? state.workflow_status === "executing" &&
        state.terminal_at === null &&
        state.payment_guard_released_at === null
      : state.workflow_status === "succeeded" &&
        state.terminal_at instanceof Date &&
        state.payment_guard_released_at instanceof Date &&
        state.payment_guard_released_at.getTime() === state.terminal_at.getTime() &&
        state.execution_reconciled_at instanceof Date &&
        state.terminal_at.getTime() === state.execution_reconciled_at.getTime();
  if (!commonValid || !lifecycleValid) {
    throw new Error("SANDBOX_E2E_INITIAL_SCENARIO_STATE_INVALID");
  }
}

async function waitForInitialScenarioState(
  client: Client,
  tenantId: string,
  requestId: string,
  scenario: SandboxE2EScenario,
  expectedIdempotencyKey: string,
): Promise<DurableDatabaseState> {
  const deadline = Date.now() + POLL_TIMEOUT_MILLISECONDS;
  for (;;) {
    const state = await readDurableState(client, tenantId, requestId);
    if (state !== null && state.attempt_state === "completed" && state.stripe_refund_id !== null) {
      assertInitialScenarioState(state, scenario, expectedIdempotencyKey);
      return state;
    }
    if (Date.now() >= deadline) {
      throw new Error("SANDBOX_E2E_INITIAL_SCENARIO_STATE_TIMEOUT");
    }
    await delay(250);
  }
}

function assertPendingGuardState(
  state: DurableDatabaseState,
  initialState: DurableDatabaseState,
): void {
  if (
    state.workflow_status !== "executing" ||
    state.effect_state !== "identified" ||
    state.stripe_refund_status !== "pending" ||
    state.stripe_refund_id !== initialState.stripe_refund_id ||
    state.idempotency_key !== initialState.idempotency_key ||
    state.attempt_count !== initialState.attempt_count ||
    state.terminal_at !== null ||
    state.payment_guard_released_at !== null ||
    state.last_stripe_event_created_at !== null
  ) {
    throw new Error("SANDBOX_E2E_PENDING_REFUND_GUARD_INVARIANT_VIOLATION");
  }
}

function assertConvergedScenarioState(
  state: DurableDatabaseState,
  initialState: DurableDatabaseState,
  scenario: Exclude<SandboxE2EScenario, "normal">,
): void {
  const immutableIdentityValid =
    state.stripe_refund_id === initialState.stripe_refund_id &&
    state.idempotency_key === initialState.idempotency_key &&
    state.attempt_count === initialState.attempt_count &&
    state.attempt_state === initialState.attempt_state &&
    state.attempt_finished_at?.getTime() === initialState.attempt_finished_at?.getTime() &&
    state.execution_started_at?.getTime() === initialState.execution_started_at?.getTime() &&
    state.last_stripe_event_created_at === null;
  if (!immutableIdentityValid) {
    throw new Error("SANDBOX_E2E_ASYNC_REFUND_IDENTITY_CHANGED");
  }

  if (scenario === "pending_refund") {
    if (
      state.workflow_status !== "succeeded" ||
      state.effect_state !== "identified" ||
      state.stripe_refund_status !== "succeeded" ||
      !(state.terminal_at instanceof Date) ||
      !(state.payment_guard_released_at instanceof Date) ||
      state.payment_guard_released_at.getTime() !== state.terminal_at.getTime() ||
      !(state.execution_reconciled_at instanceof Date) ||
      state.terminal_at.getTime() > state.execution_reconciled_at.getTime() ||
      !(initialState.execution_reconciled_at instanceof Date) ||
      state.execution_reconciled_at.getTime() < initialState.execution_reconciled_at.getTime()
    ) {
      throw new Error("SANDBOX_E2E_PENDING_REFUND_CONVERGENCE_INVALID");
    }
    return;
  }

  if (
    state.workflow_status !== "failed_terminal" ||
    state.effect_state !== "absence_proven" ||
    state.stripe_refund_status !== "failed" ||
    !(state.terminal_at instanceof Date) ||
    !(state.payment_guard_released_at instanceof Date) ||
    state.terminal_at.getTime() !== initialState.terminal_at?.getTime() ||
    state.payment_guard_released_at.getTime() !==
      initialState.payment_guard_released_at?.getTime() ||
    !(state.execution_reconciled_at instanceof Date) ||
    !(initialState.execution_reconciled_at instanceof Date) ||
    state.execution_reconciled_at.getTime() < initialState.execution_reconciled_at.getTime()
  ) {
    throw new Error("SANDBOX_E2E_FAILED_REFUND_SCANNER_CONVERGENCE_INVALID");
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

async function findRefundEvent(
  stripe: Stripe,
  eventType: "refund.created" | "refund.failed" | "refund.updated",
  refundId: string,
  createdGte: number,
): Promise<Stripe.Event | null> {
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stableStripeCall("SANDBOX_E2E_STRIPE_EVENT_READ_FAILED", () =>
      stripe.events.list({
        created: { gte: createdGte },
        limit: 100,
        type: eventType,
        ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
      }),
    );
    const matched = page.data.find((event) => {
      const object = event.data.object as { readonly id?: string };
      return object.id === refundId;
    });
    if (matched !== undefined) {
      return matched;
    }
    if (!page.has_more) {
      return null;
    }
    const last = page.data.at(-1);
    if (last === undefined || last.id === startingAfter) {
      throw new Error("SANDBOX_E2E_STRIPE_EVENT_LIST_CURSOR_STALLED");
    }
    startingAfter = last.id;
  }
}

async function waitForRefundEvent(
  stripe: Stripe,
  eventType: "refund.created" | "refund.failed" | "refund.updated",
  refundId: string,
  createdGte: number,
): Promise<Stripe.Event> {
  const deadline = Date.now() + EVENT_OBSERVATION_TIMEOUT_MILLISECONDS;
  for (;;) {
    const event = await findRefundEvent(stripe, eventType, refundId, createdGte);
    if (event !== null) {
      return event;
    }
    if (Date.now() >= deadline) {
      throw new Error("SANDBOX_E2E_REFUND_EVENT_OBSERVATION_TIMEOUT");
    }
    await delay(EVENT_OBSERVATION_POLL_MILLISECONDS);
  }
}

async function countWebhookReceipts(
  client: Client,
  tenantId: string,
  refundId: string,
): Promise<number> {
  return withTenantOwnerTransaction(client, tenantId, async (transaction) => {
    const result = await transaction.query<{ readonly receipt_count: number }>(
      `SELECT COUNT(*)::INTEGER AS receipt_count
       FROM webhook_receipts
       WHERE tenant_id = $1::UUID
         AND object_id = $2`,
      [tenantId, refundId],
    );
    return result.rows[0]?.receipt_count ?? -1;
  });
}

function assertFailedRefundAwaitingScanner(
  state: DurableDatabaseState,
  initialState: DurableDatabaseState,
): void {
  if (
    state.workflow_status !== "succeeded" ||
    state.effect_state !== "identified" ||
    state.stripe_refund_status !== "succeeded" ||
    state.stripe_refund_id !== initialState.stripe_refund_id ||
    state.idempotency_key !== initialState.idempotency_key ||
    state.attempt_count !== initialState.attempt_count ||
    state.terminal_at?.getTime() !== initialState.terminal_at?.getTime() ||
    state.payment_guard_released_at?.getTime() !==
      initialState.payment_guard_released_at?.getTime() ||
    state.last_stripe_event_created_at !== null
  ) {
    throw new Error("SANDBOX_E2E_FAILED_REFUND_PRE_SCAN_INVARIANT_VIOLATION");
  }
}

async function convergeAsyncRefundWithScanner(input: {
  readonly client: Client;
  readonly dependencies: WorkerDependencies;
  readonly initialState: DurableDatabaseState;
  readonly requestId: string;
  readonly scenario: Exclude<SandboxE2EScenario, "normal">;
  readonly tenantId: string;
}): Promise<{
  readonly invocationCount: number;
}> {
  const deadline = Date.now() + ASYNC_REFUND_TIMEOUT_MILLISECONDS;
  let invocationCount = 0;

  for (;;) {
    await handleReconciliationScanJob({ scope: "all" }, input.dependencies);
    invocationCount += 1;
    const state = await readDurableState(input.client, input.tenantId, input.requestId);
    if (state === null) {
      throw new Error("SANDBOX_E2E_ASYNC_REFUND_STATE_MISSING");
    }
    const converged =
      input.scenario === "pending_refund"
        ? state.workflow_status === "succeeded" && state.stripe_refund_status === "succeeded"
        : state.workflow_status === "failed_terminal" && state.stripe_refund_status === "failed";
    if (converged) {
      assertConvergedScenarioState(state, input.initialState, input.scenario);
      return {
        invocationCount,
      };
    }

    if (input.scenario === "pending_refund") {
      assertPendingGuardState(state, input.initialState);
    } else {
      assertFailedRefundAwaitingScanner(state, input.initialState);
    }
    if (Date.now() >= deadline) {
      throw new Error("SANDBOX_E2E_ASYNC_REFUND_SCANNER_TIMEOUT");
    }
    await delay(ASYNC_REFUND_POLL_MILLISECONDS);
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
  if (singletonProbeBoss !== undefined) {
    const probe = singletonProbeBoss;
    try {
      await probe.stop({ graceful: true, timeout: 10_000 });
      singletonProbeBoss = undefined;
    } catch {
      cleanupFailed = true;
      cleanupMustPreserve = true;
      try {
        await probe.stop({ graceful: false, timeout: 5_000 });
        singletonProbeBoss = undefined;
      } catch {
        // Preserve the database and let the failing hook expose the leaked runtime.
      }
    }
  }
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
  const rolesExpectedRemoved = [...createdLoginRoles];
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
      } catch {
        cleanupFailed = true;
        cleanupMustPreserve = true;
      }
    }
  }
  if (!databaseCreated && safeToDrop && controlClient !== undefined) {
    for (let index = createdLoginRoles.length - 1; index >= 0; index -= 1) {
      const role = createdLoginRoles[index];
      if (role === undefined) {
        cleanupFailed = true;
        cleanupMustPreserve = true;
        break;
      }
      try {
        await controlClient.query(
          `DROP ROLE IF EXISTS ${quoteIdentifier(role, ROLE_NAME_PATTERN)}`,
        );
        createdLoginRoles.splice(index, 1);
      } catch {
        cleanupFailed = true;
        cleanupMustPreserve = true;
      }
    }
  }
  if (safeToDrop && controlClient !== undefined && !databaseCreated) {
    try {
      const verification = await controlClient.query<{
        readonly database_exists: boolean;
        readonly generated_role_count: number;
      }>(
        `SELECT
           EXISTS(
             SELECT 1
             FROM pg_database
             WHERE datname = $1
           ) AS database_exists,
           (
             SELECT COUNT(*)::INTEGER
             FROM pg_roles
             WHERE rolname = ANY($2::TEXT[])
           ) AS generated_role_count`,
        [databaseName, rolesExpectedRemoved],
      );
      const state = verification.rows[0];
      if (
        state === undefined ||
        state.database_exists ||
        state.generated_role_count !== 0 ||
        createdLoginRoles.length !== 0
      ) {
        cleanupFailed = true;
        cleanupMustPreserve = true;
      }
    } catch {
      cleanupFailed = true;
      cleanupMustPreserve = true;
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
    const harnessSourceSha256 = createHash("sha256")
      .update(await readFile(HARNESS_SOURCE_PATH))
      .digest("hex");
    const runId = randomUUID();
    databaseName = `refunddesk_e2e_${randomBytes(8).toString("hex")}`;
    const webRole = `refunddesk_e2e_web_${randomBytes(6).toString("hex")}`;
    const workerRole = `refunddesk_e2e_worker_${randomBytes(6).toString("hex")}`;
    const queueRole = `refunddesk_e2e_queue_${randomBytes(6).toString("hex")}`;
    const webPassword = randomBytes(24).toString("hex");
    const workerPassword = randomBytes(24).toString("hex");
    const queuePassword = randomBytes(24).toString("hex");
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
      readonly current_database: string;
      readonly current_user: string;
      readonly harness_lock_acquired: boolean;
      readonly other_connectable_database_count: number;
      readonly rolcreatedb: boolean;
      readonly rolcreaterole: boolean;
      readonly server_version_num: string;
    }>(
      `SELECT
         current_database(),
         current_user,
         pg_try_advisory_lock(1380336964, 1161970226) AS harness_lock_acquired,
         (
           SELECT COUNT(*)::INTEGER
           FROM pg_database
           WHERE datallowconn
             AND NOT datistemplate
             AND datname <> current_database()
         ) AS other_connectable_database_count,
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
    assertDedicatedPostgresClusterPreflight({
      connectedDatabase: databaseRole.current_database,
      expectedControlDatabase: controlDatabaseName,
      harnessLockAcquired: databaseRole.harness_lock_acquired,
      otherConnectableDatabaseCount: databaseRole.other_connectable_database_count,
    });

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
      { role: queueRole, password: queuePassword, capability: "refunddesk_queue" },
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
    await controlClient.query(
      `GRANT refunddesk_attestation_writer TO ${quoteIdentifier(workerRole, ROLE_NAME_PATTERN)}`,
    );

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
    const queueDatabaseUrl = databaseUrlFor(ownerEphemeralUrl, databaseName, {
      username: queueRole,
      password: queuePassword,
    });

    const fieldKey = randomBytes(32);
    const proofKey = randomBytes(32);
    const approvalAttestationKey = randomBytes(32);
    const exportKey = randomBytes(32);
    const proofs = new RefundProofKeyring({
      active: { key: proofKey, version: "v1" },
    });
    const approvalAttestations = new ApprovalAttestationKeyring({
      active: { key: approvalAttestationKey, version: "v1" },
    });
    const stripeGateway = new DirectAccountStripeClient(
      new StripeCredentialResolver({
        platformTest: {
          apiKey: environment.platformTestEffectKey,
          expectedAccountId: environment.platformTestAccountId,
        },
        managedSandbox: {
          apiKey: environment.managedSandboxEffectKey,
          expectedAccountId: environment.managedSandboxAccountId,
        },
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
      new DirectStripePaymentReader(stripeGateway),
      new TestAndSandboxAccessPolicy(),
      new ConfiguredAccountAdmission([
        { accountId: environment.platformTestAccountId, environment: "test" },
        { accountId: environment.managedSandboxAccountId, environment: "sandbox" },
      ]),
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
    const fixturePaymentMethod = SANDBOX_E2E_SCENARIO_PAYMENT_METHODS[environment.scenario];
    const fixtureIdempotencyKey = `refunddesk:e2e:${environment.scenario}:payment-intent:${runId}`;
    await writeFile(
      FIXTURE_PATH,
      `${JSON.stringify(
        {
          schema_version: 1,
          run_fingerprint: hashIdentifier(runId),
          environment: environment.environment,
          stripe_account_fingerprint: hashIdentifier(environment.accountId),
          state: "payment_intent_create_pending",
          scenario: environment.scenario,
          payment_method: fixturePaymentMethod,
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
            refunddesk_e2e_scenario: environment.scenario,
          },
          payment_method: fixturePaymentMethod,
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
    const refundsBeforeWorkflow = await listPaymentIntentRefunds(fixtureStripe, paymentIntent.id);
    if (refundsBeforeWorkflow.length !== 0) {
      throw new Error("SANDBOX_E2E_FIXTURE_NOT_FRESH");
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
          scenario: environment.scenario,
          payment_method: fixturePaymentMethod,
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

    const workerDatabase = createPrismaClient({
      connectionString: workerDatabaseUrl,
      maxConnections: 4,
    });
    workerStore = new PrismaWorkerStore(workerDatabase, proofs, approvalAttestations);
    const approvalCommand = {
      approval_snapshot: {
        amount_minor: String(REFUND_AMOUNT_MINOR),
        currency: "eur",
        reason: "requested_by_customer",
        requester_user_id: requesterIdentity.userId,
      },
      decision: "approve",
      expected_request_version: 0,
      request_id: requestId,
    } as const;
    const approvalNonce = randomUUID();
    const approvalRequestHash = createHash("sha256")
      .update(
        JSON.stringify([
          "refund_request.decide",
          approvalNonce,
          adminIdentity.accountId,
          adminIdentity.userId,
          approvalCommand,
          resource,
        ]),
        "utf8",
      )
      .digest();
    const approvalAttestation = await workerStore.persistApprovalAttestation({
      amountMinor: BigInt(REFUND_AMOUNT_MINOR),
      approverStripeUserId: adminIdentity.userId,
      currency: "eur",
      environment: environment.environment,
      expectedRequestVersion: 0,
      reason: "requested_by_customer",
      requestId,
      requestNonce: approvalNonce,
      requesterStripeUserId: requesterIdentity.userId,
      resourceId: resource.id,
      resourceType: resource.type,
      signedEnvelopeHash: approvalRequestHash,
      stripeAccountId: environment.accountId,
      verifiedAt: new Date(),
    });
    const decided = await dispatchMutation(service, {
      approvalAttestationId: approvalAttestation.id,
      canonicalRequestHash: approvalRequestHash,
      command: approvalCommand,
      identity: adminIdentity,
      operation: "refund_request.decide",
      requestNonce: approvalNonce,
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

    const workerDependencies: WorkerDependencies = {
      clock: { now: () => new Date() },
      logger: quietLogger,
      proofs,
      store: workerStore,
      stripe: stripeGateway,
    };
    const workerConfig: WorkerConfig = {
      health: {
        host: "127.0.0.1",
        port: 3101,
      },
      keys: {
        activeApprovalAttestationVersion: "v1",
        activeProofVersion: "v1",
        approvalAttestationRotationState: "legacy",
        approvalAttestationV1: approvalAttestationKey,
        proofRotationState: "legacy",
        proofV1: proofKey,
      },
      liveEnabled: false,
      logLevel: "error",
      nodeEnv: "test",
      pgBossDatabaseUrl: queueDatabaseUrl,
      runtimeMode: "normal",
      signedRequestVerifierToken: randomBytes(32).toString("base64"),
      stripe: {
        apiVersion: API_VERSION,
        appSigningSecret: "absec_sandbox_e2e",
        managedSandboxAccountId: environment.managedSandboxAccountId,
        managedSandboxEffectKey: environment.managedSandboxEffectKey,
        platformTestAccountId: environment.platformTestAccountId,
        platformTestEffectKey: environment.platformTestEffectKey,
      },
      workerDatabaseUrl,
    };

    financialExecutionStarted = true;
    const expectedIdempotencyKey = refundIdempotencyKey(requestId);
    runningWorker = await startPgBossWorker(workerConfig, workerDependencies);
    const initialState = await waitForInitialScenarioState(
      ownerDatabaseClient,
      installationIdentity.tenant_id,
      requestId,
      environment.scenario,
      expectedIdempotencyKey,
    );
    const refundId = initialState.stripe_refund_id;
    if (refundId === null) {
      throw new Error("SANDBOX_E2E_REFUND_IDENTITY_NOT_DURABLE");
    }

    const initialQueueState = await waitForExecutionQueueIdle(ownerDatabaseClient, requestId, 1);
    const webhookReceiptCountBeforeScanner = await countWebhookReceipts(
      ownerDatabaseClient,
      installationIdentity.tenant_id,
      refundId,
    );
    if (webhookReceiptCountBeforeScanner !== 0) {
      throw new Error("SANDBOX_E2E_UNEXPECTED_WEBHOOK_RECEIPT_BEFORE_SCANNER");
    }
    const linkedRefund = await stableStripeCall("SANDBOX_E2E_STRIPE_REFUND_READ_FAILED", () =>
      fixtureStripe.refunds.retrieve(refundId),
    );
    const currentStripeStatusAllowed =
      environment.scenario === "normal"
        ? linkedRefund.status === "succeeded"
        : environment.scenario === "pending_refund"
          ? linkedRefund.status === "pending" || linkedRefund.status === "succeeded"
          : linkedRefund.status === "succeeded" || linkedRefund.status === "failed";
    if (
      linkedRefund.id !== refundId ||
      linkedRefund.payment_intent !== paymentIntent.id ||
      linkedRefund.charge !== charge.id ||
      linkedRefund.amount !== REFUND_AMOUNT_MINOR ||
      linkedRefund.currency !== "eur" ||
      !currentStripeStatusAllowed
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

    await runningWorker.stop();
    runningWorker = undefined;

    singletonProbeBoss = new PgBoss({
      connectionString: queueDatabaseUrl,
      application_name: "refunddesk-sandbox-e2e-singleton-probe",
      createSchema: false,
      migrate: false,
      schedule: false,
      supervise: false,
      useListenNotify: false,
    });
    singletonProbeBoss.on("error", () => undefined);
    try {
      await singletonProbeBoss.start();
      const probePublisher = new WorkerQueuePublisher(singletonProbeBoss);
      const firstReplayJobId = await probePublisher.enqueueRefundExecution({
        request_id: requestId,
        tenant_id: installationIdentity.tenant_id,
      });
      const secondReplayJobId = await probePublisher.enqueueRefundExecution({
        request_id: requestId,
        tenant_id: installationIdentity.tenant_id,
      });
      assertExclusiveSingletonEnqueue(firstReplayJobId, secondReplayJobId);
    } finally {
      await singletonProbeBoss.stop({ graceful: true, timeout: 10_000 });
      singletonProbeBoss = undefined;
    }

    runningWorker = await startPgBossWorker(workerConfig, workerDependencies);
    const replayQueueState = await waitForExecutionQueueIdle(
      ownerDatabaseClient,
      requestId,
      initialQueueState.completed_count + 1,
    );
    await handleRefundExecutionJob(
      {
        request_id: requestId,
        tenant_id: installationIdentity.tenant_id,
      },
      workerDependencies,
    );
    await runningWorker.stop();
    runningWorker = undefined;

    const scanStartedAt = new Date();
    let explicitScannerInvocationCount = 0;
    await handleReconciliationScanJob({ scope: "all" }, workerDependencies);
    explicitScannerInvocationCount += 1;
    let finalState = await readDurableState(
      ownerDatabaseClient,
      installationIdentity.tenant_id,
      requestId,
    );
    if (finalState === null) {
      throw new Error("SANDBOX_E2E_POST_REPLAY_STATE_MISSING");
    }
    if (environment.scenario === "normal") {
      if (
        finalState.workflow_status !== "succeeded" ||
        finalState.effect_state !== "identified" ||
        finalState.stripe_refund_status !== "succeeded" ||
        finalState.stripe_refund_id !== refundId ||
        finalState.idempotency_key !== expectedIdempotencyKey ||
        finalState.attempt_count !== initialState.attempt_count ||
        finalState.attempt_state !== initialState.attempt_state ||
        finalState.attempt_finished_at?.getTime() !== initialState.attempt_finished_at?.getTime() ||
        finalState.execution_started_at?.getTime() !==
          initialState.execution_started_at?.getTime() ||
        finalState.terminal_at?.getTime() !== initialState.terminal_at?.getTime() ||
        finalState.payment_guard_released_at?.getTime() !==
          initialState.payment_guard_released_at?.getTime() ||
        finalState.last_stripe_event_created_at !== null
      ) {
        throw new Error("SANDBOX_E2E_NORMAL_REPLAY_STATE_INVALID");
      }
    } else {
      const alreadyConverged =
        environment.scenario === "pending_refund"
          ? finalState.workflow_status === "succeeded" &&
            finalState.stripe_refund_status === "succeeded"
          : finalState.workflow_status === "failed_terminal" &&
            finalState.stripe_refund_status === "failed";
      if (alreadyConverged) {
        assertConvergedScenarioState(finalState, initialState, environment.scenario);
      } else {
        if (environment.scenario === "pending_refund") {
          assertPendingGuardState(finalState, initialState);
        } else {
          assertFailedRefundAwaitingScanner(finalState, initialState);
        }
        const convergence = await convergeAsyncRefundWithScanner({
          client: ownerDatabaseClient,
          dependencies: workerDependencies,
          initialState,
          requestId,
          scenario: environment.scenario,
          tenantId: installationIdentity.tenant_id,
        });
        explicitScannerInvocationCount += convergence.invocationCount;
      }
      await handleReconciliationScanJob({ scope: "all" }, workerDependencies);
      explicitScannerInvocationCount += 1;
      const confirmedState = await readDurableState(
        ownerDatabaseClient,
        installationIdentity.tenant_id,
        requestId,
      );
      if (confirmedState === null) {
        throw new Error("SANDBOX_E2E_ASYNC_REFUND_CONFIRMATION_STATE_MISSING");
      }
      assertConvergedScenarioState(confirmedState, initialState, environment.scenario);
      finalState = confirmedState;
    }
    const scanCompletedAt = new Date();

    const refundsAfterReplay = await listPaymentIntentRefunds(fixtureStripe, paymentIntent.id);
    if (refundsAfterReplay.length !== 1 || refundsAfterReplay[0]?.id !== refundId) {
      throw new Error("SANDBOX_E2E_REFUND_REPLAY_CREATED_DUPLICATE");
    }
    const finalStripeRefund = await stableStripeCall(
      "SANDBOX_E2E_FINAL_STRIPE_REFUND_READ_FAILED",
      () => fixtureStripe.refunds.retrieve(refundId),
    );
    const expectedFinalStripeStatus =
      environment.scenario === "failed_refund_scanner" ? "failed" : "succeeded";
    if (
      finalStripeRefund.id !== refundId ||
      finalStripeRefund.payment_intent !== paymentIntent.id ||
      finalStripeRefund.charge !== charge.id ||
      finalStripeRefund.amount !== REFUND_AMOUNT_MINOR ||
      finalStripeRefund.currency !== "eur" ||
      finalStripeRefund.status !== expectedFinalStripeStatus
    ) {
      throw new Error("SANDBOX_E2E_FINAL_STRIPE_REFUND_INVALID");
    }
    const replayDatabaseState = await withTenantOwnerTransaction(
      ownerDatabaseClient,
      installationIdentity.tenant_id,
      (transaction) =>
        transaction.query<{
          readonly attempt_count: number;
          readonly stripe_refund_id: string;
        }>(
          `SELECT
             execution.stripe_refund_id,
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
      replayState.stripe_refund_id !== refundId
    ) {
      throw new Error("SANDBOX_E2E_DURABLE_REPLAY_STATE_INVALID");
    }
    const webhookReceiptCountAfterScanner = await countWebhookReceipts(
      ownerDatabaseClient,
      installationIdentity.tenant_id,
      refundId,
    );
    if (webhookReceiptCountAfterScanner !== 0) {
      throw new Error("SANDBOX_E2E_SCANNER_SCENARIO_INGESTED_WEBHOOK");
    }
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
          readonly linked_refresh_sources: string[];
          readonly linked_refresh_statuses: string[];
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
             ARRAY(
               SELECT payload ->> 'source'
               FROM audit_events
               WHERE tenant_id = $1::UUID
                 AND entity_id = $3
                 AND action = 'refund.linked_status_refreshed'
               ORDER BY occurred_at, id
             ) AS linked_refresh_sources,
             ARRAY(
               SELECT payload ->> 'stripe_refund_status'
               FROM audit_events
               WHERE tenant_id = $1::UUID
                 AND entity_id = $3
                 AND action = 'refund.linked_status_refreshed'
               ORDER BY occurred_at, id
             ) AS linked_refresh_statuses,
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
    const linkedRefreshProvesScanner =
      reconciliationState.linked_refresh_sources.length > 0 &&
      reconciliationState.linked_refresh_sources.every((source) => source === "linked_scan") &&
      reconciliationState.linked_refresh_statuses.includes(expectedFinalStripeStatus);
    if (
      !checkpointComplete ||
      !checkpointBounded ||
      reconciliationState.external_alert_count !== 0 ||
      reconciliationState.mutation_receipt_count !== 5 ||
      !workflowAuditComplete ||
      !refundAuditComplete ||
      !linkedRefreshProvesScanner
    ) {
      throw new Error("SANDBOX_E2E_RECONCILIATION_STATE_INVALID");
    }
    fullyConverged = true;

    const eventSearchStart = Math.max(0, paymentIntent.created - 60);
    const refundEvent = await waitForRefundEvent(
      fixtureStripe,
      "refund.created",
      refundId,
      eventSearchStart,
    );
    const eventIdempotencyKey = refundEvent?.request?.idempotency_key ?? null;
    expect(eventIdempotencyKey === null || eventIdempotencyKey === expectedIdempotencyKey).toBe(
      true,
    );
    const transitionEventType =
      environment.scenario === "pending_refund"
        ? "refund.updated"
        : environment.scenario === "failed_refund_scanner"
          ? "refund.failed"
          : null;
    let transitionEventObserved = false;
    if (transitionEventType !== null) {
      await waitForRefundEvent(fixtureStripe, transitionEventType, refundId, eventSearchStart);
      transitionEventObserved = true;
    }

    const evidenceGeneratedAt = new Date().toISOString();
    const evidencePath = path.join(
      EVIDENCE_DIRECTORY,
      `durable-refund-flow-${environment.scenario}-${evidenceGeneratedAt.replaceAll(
        /[:.]/gu,
        "-",
      )}.json`,
    );
    const initialGuardHeld =
      initialState.terminal_at === null && initialState.payment_guard_released_at === null;
    const finalGuardReleasedAtTerminal =
      finalState.terminal_at instanceof Date &&
      finalState.payment_guard_released_at instanceof Date &&
      finalState.payment_guard_released_at.getTime() === finalState.terminal_at.getTime();
    const postSuccessFailureTerminalTimestampsPreserved =
      environment.scenario === "failed_refund_scanner"
        ? finalState.terminal_at?.getTime() === initialState.terminal_at?.getTime() &&
          finalState.payment_guard_released_at?.getTime() ===
            initialState.payment_guard_released_at?.getTime()
        : null;
    if (!finalGuardReleasedAtTerminal || postSuccessFailureTerminalTimestampsPreserved === false) {
      throw new Error("SANDBOX_E2E_FINAL_TIMESTAMP_INVARIANT_INVALID");
    }
    const evidence = {
      schema_version: 2,
      gate: `durable_real_stripe_refund_flow.${environment.scenario}`,
      result: "PASS",
      generated_at: evidenceGeneratedAt,
      scenario: environment.scenario,
      provenance: {
        harness_revision: environment.sourceRevision,
        harness_source_sha256: harnessSourceSha256,
      },
      stripe: {
        livemode: false,
        environment: environment.environment,
        account_fingerprint: hashIdentifier(environment.accountId),
        payment_intent_fingerprint: hashIdentifier(paymentIntent.id),
        refund_fingerprint: hashIdentifier(refundId),
        amount_minor: REFUND_AMOUNT_MINOR,
        currency: "eur",
        payment_method: fixturePaymentMethod,
        initial_refund_status: initialState.stripe_refund_status,
        final_refund_status: finalStripeRefund.status,
        refund_count_before_workflow: refundsBeforeWorkflow.length,
        refund_count_for_payment_intent: refundsAfterReplay.length,
        refund_created_event_observed: true,
        transition_event_type: transitionEventType,
        transition_event_observed: transitionEventType === null ? null : transitionEventObserved,
        event_idempotency_key_present: eventIdempotencyKey !== null,
        event_idempotency_key_matches:
          eventIdempotencyKey === null ? null : eventIdempotencyKey === expectedIdempotencyKey,
      },
      durable_state: {
        request_fingerprint: hashIdentifier(requestId),
        initial_workflow_status: initialState.workflow_status,
        initial_effect_state: initialState.effect_state,
        initial_guard_held: environment.scenario === "pending_refund" ? initialGuardHeld : null,
        final_workflow_status: finalState.workflow_status,
        final_effect_state: finalState.effect_state,
        attempt_count: replayState.attempt_count,
        first_refund_link_immutable: replayState.stripe_refund_id === refundId,
        idempotency_key_present: finalState.idempotency_key.length > 0,
        idempotency_key_matches: finalState.idempotency_key === expectedIdempotencyKey,
        idempotency_key_fingerprint: hashIdentifier(expectedIdempotencyKey),
        guard_released_at_terminal: finalGuardReleasedAtTerminal,
        post_success_failure_terminal_timestamps_preserved:
          postSuccessFailureTerminalTimestampsPreserved,
        stripe_event_watermark_absent: finalState.last_stripe_event_created_at === null,
        approval_decision_count: beforeWorker.rows[0]?.decision_count ?? 0,
        distinct_approver_count: beforeWorker.rows[0]?.distinct_actor_count ?? 0,
        mutation_receipt_count: reconciliationState.mutation_receipt_count,
        execution_queue_initial_completed_count: initialQueueState.completed_count,
        execution_queue_replay_accepted_count: 1,
        execution_queue_singleton_duplicate_rejected: true,
        execution_queue_final_completed_count: replayQueueState.completed_count,
      },
      reconciliation: {
        checkpoint_present: checkpointCommittedThrough instanceof Date,
        checkpoint_complete: checkpointComplete,
        checkpoint_committed_within_scan: checkpointBounded,
        convergence_path: "linked_refund_direct_retrieval_and_temporal_scan",
        explicit_scanner_invocation_count: explicitScannerInvocationCount,
        webhook_signature_or_transport: "not_exercised",
        webhook_receipt_count_before_scanner: webhookReceiptCountBeforeScanner,
        webhook_receipt_count_after_scanner: webhookReceiptCountAfterScanner,
        linked_refresh_audited: reconciliationState.refund_audit_actions.includes(
          "refund.linked_status_refreshed",
        ),
        linked_refresh_proves_scanner: linkedRefreshProvesScanner,
        scan_observation_audited:
          reconciliationState.refund_audit_actions.includes("refund.observed"),
        workflow_audit_complete: workflowAuditComplete,
        workflow_refund_alert_count: reconciliationState.external_alert_count,
      },
      cleanup_policy: "drop_ephemeral_database_and_logins_before_writing_pass_evidence",
      cleanup_completed: true,
    };
    await writeFile(
      FIXTURE_PATH,
      `${JSON.stringify(
        {
          schema_version: 1,
          run_fingerprint: hashIdentifier(runId),
          environment: environment.environment,
          stripe_account_fingerprint: hashIdentifier(environment.accountId),
          state: "refund_converged",
          scenario: environment.scenario,
          payment_method: fixturePaymentMethod,
          payment_intent_fingerprint: hashIdentifier(paymentIntent.id),
          charge_fingerprint: hashIdentifier(charge.id),
          refund_fingerprint: hashIdentifier(refundId),
          amount_minor: REFUND_AMOUNT_MINOR,
          currency: "eur",
          initial_refund_status: initialState.stripe_refund_status,
          final_refund_status: finalState.stripe_refund_status,
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
