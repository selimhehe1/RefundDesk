import { z } from "zod";

import {
  APPLICATION_KEY_ROTATION_STATES,
  applicationKeyMaterialStateIsValid,
  type ApplicationKeyRotationState,
  type ApplicationKeyVersion,
} from "./key-rotation.js";

export {
  APPLICATION_KEY_ROTATION_STATES,
  applicationKeyMaterialStateIsValid,
  assertApplicationKeyRotationTransition,
  isApplicationKeyRotationState,
} from "./key-rotation.js";
export type {
  ApplicationKeyMaterialState,
  ApplicationKeyRotationSet,
  ApplicationKeyRotationState,
  ApplicationKeyVersion,
} from "./key-rotation.js";

const nodeEnvironment = z.enum(["development", "test", "production"]).default("development");
const logLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info");
const stripeApiVersion = z.literal("2026-06-24.dahlia");
const globalLiveEnabled = z.literal("false").default("false");
const appSigningSecret = z.string().regex(/^absec_[A-Za-z0-9_]+$/u);
const stripeAppId = z
  .string()
  .regex(/^ca_[A-Za-z0-9]+$/u)
  .max(255);
const stripeAccountId = z
  .string()
  .regex(/^acct_[A-Za-z0-9]+$/u)
  .max(255);
const legacyTestApiKey = z.string().regex(/^(?:sk|rk)_test_[A-Za-z0-9_]+$/u);
const optionalLegacyTestApiKey = legacyTestApiKey.optional();
const restrictedTestApiKey = z.string().regex(/^rk_test_[A-Za-z0-9_]+$/u);
const optionalRestrictedTestApiKey = restrictedTestApiKey.optional();
const webhookSecret = z.string().regex(/^whsec_[A-Za-z0-9_]+$/u);
const postgresUrl = z.string().min(1);
const workerHealthHost = z.enum(["127.0.0.1", "0.0.0.0", "::1", "::"]).default("127.0.0.1");
const workerHealthPort = z.coerce.number().int().min(1).max(65_535).default(3101);
const workerRuntimeMode = z.enum(["normal", "incident_admission"]).default("normal");
const signedRequestVerifierUrl = z
  .url()
  .default("http://127.0.0.1:3101/internal/v1/signed-requests/verify");
const base64Key = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const decoded = Buffer.from(value, "base64");
      return decoded.byteLength === 32 && decoded.toString("base64") === value;
    } catch {
      return false;
    }
  }, "Expected a base64-encoded 32-byte key");
const applicationKeyVersion = z.enum(["v1", "v2"]);
const applicationKeyRotationState = z.enum(APPLICATION_KEY_ROTATION_STATES).default("legacy");

function validateApplicationKeyMaterialState(
  activeVersion: ApplicationKeyVersion,
  rotationState: ApplicationKeyRotationState,
  v1Key: string | undefined,
  v2Key: string | undefined,
  stateField: string,
  context: z.RefinementCtx,
): void {
  if (
    !applicationKeyMaterialStateIsValid({
      activeVersion,
      rotationState,
      v1Present: v1Key !== undefined,
      v2Present: v2Key !== undefined,
    })
  ) {
    context.addIssue({
      code: "custom",
      path: [stateField],
      message: "Application key material does not match its declared rotation state",
    });
  }
}

function validateDistinctApplicationKeys(
  keys: readonly (readonly [field: string, value: string | undefined])[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [field, value] of keys) {
    if (value === undefined) {
      continue;
    }
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Application keys must be distinct across families and versions",
      });
    }
    seen.add(value);
  }
}

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
  "PGDATABASE",
  "PGCLIENT_ENCODING",
  "PGCONNECT_TIMEOUT",
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

function databasePrincipal(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      url.username.length === 0 ||
      url.hostname.length === 0 ||
      url.pathname.length <= 1 ||
      url.hash.length > 0 ||
      [...url.searchParams.keys()].some((name) =>
        FORBIDDEN_POSTGRES_QUERY_PARAMETERS.has(name.toLowerCase()),
      )
    ) {
      return null;
    }
    const principal = decodeURIComponent(url.username);
    return principal.length === 0 ? null : principal;
  } catch {
    return null;
  }
}

function validateDatabasePrincipal(
  connectionString: string,
  field: string,
  context: z.RefinementCtx,
): string | null {
  const principal = databasePrincipal(connectionString);
  if (principal === null) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: "Expected a PostgreSQL URL with an explicit database principal",
    });
  }
  return principal;
}

function validateDatabaseTransport(
  connectionString: string,
  nodeEnv: NodeEnvironment,
  field: string,
  context: z.RefinementCtx,
): void {
  if (nodeEnv !== "production") {
    return;
  }
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return;
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const sslModes = url.searchParams.getAll("sslmode");
  if (!loopback && (sslModes.length !== 1 || sslModes[0] !== "verify-full")) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: "Hosted PostgreSQL URLs must use sslmode=verify-full with the provider CA",
    });
  }
}

interface DatabasePrincipals {
  readonly web: string | null;
  readonly worker: string | null;
  readonly queue: string | null;
  readonly owner: string | null;
}

function validateDatabasePrincipalSeparation(
  principals: DatabasePrincipals,
  context: z.RefinementCtx,
): void {
  if (
    principals.web !== null &&
    principals.worker !== null &&
    principals.web === principals.worker
  ) {
    context.addIssue({
      code: "custom",
      path: ["WORKER_DATABASE_URL"],
      message: "Web and worker database credentials must be distinct",
    });
  }
  if (principals.web !== null && principals.queue !== null && principals.web === principals.queue) {
    context.addIssue({
      code: "custom",
      path: ["PGBOSS_DATABASE_URL"],
      message: "Web and queue database credentials must be distinct",
    });
  }
  if (
    principals.owner !== null &&
    [principals.web, principals.worker, principals.queue].some(
      (runtime) => runtime !== null && runtime === principals.owner,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["DATABASE_MIGRATION_URL"],
      message: "Migration credentials must be distinct from runtime credentials",
    });
  }
  if (
    principals.worker !== null &&
    principals.queue !== null &&
    principals.worker === principals.queue
  ) {
    context.addIssue({
      code: "custom",
      path: ["PGBOSS_DATABASE_URL"],
      message: "Worker and queue credentials must be distinct",
    });
  }
}

function validateAppBaseUrl(
  value: { readonly APP_BASE_URL: string; readonly NODE_ENV: string },
  context: z.RefinementCtx,
): void {
  const appUrl = new URL(value.APP_BASE_URL);
  if (
    appUrl.username.length > 0 ||
    appUrl.password.length > 0 ||
    appUrl.search.length > 0 ||
    appUrl.hash.length > 0 ||
    appUrl.pathname !== "/"
  ) {
    context.addIssue({
      code: "custom",
      path: ["APP_BASE_URL"],
      message: "APP_BASE_URL must be an origin without credentials, path, query, or fragment",
    });
  }
  const localHttp =
    appUrl.protocol === "http:" &&
    (appUrl.hostname === "localhost" ||
      appUrl.hostname === "127.0.0.1" ||
      appUrl.hostname === "[::1]");
  if (appUrl.protocol !== "https:" && !localHttp) {
    context.addIssue({
      code: "custom",
      path: ["APP_BASE_URL"],
      message: "APP_BASE_URL must use HTTPS except on a loopback development host",
    });
  }
  if (value.NODE_ENV === "production" && appUrl.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      path: ["APP_BASE_URL"],
      message: "Production APP_BASE_URL must use HTTPS",
    });
  }
}

function validateSignedRequestVerifierUrl(
  value: { readonly REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL: string; readonly NODE_ENV: string },
  context: z.RefinementCtx,
): void {
  const verifierUrl = new URL(value.REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL);
  if (
    verifierUrl.username.length > 0 ||
    verifierUrl.password.length > 0 ||
    verifierUrl.search.length > 0 ||
    verifierUrl.hash.length > 0 ||
    verifierUrl.pathname !== "/internal/v1/signed-requests/verify"
  ) {
    context.addIssue({
      code: "custom",
      path: ["REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL"],
      message: "The signed-request verifier URL must be the exact verifier endpoint",
    });
  }
  const localHttp =
    verifierUrl.protocol === "http:" &&
    (verifierUrl.hostname === "localhost" ||
      verifierUrl.hostname === "127.0.0.1" ||
      verifierUrl.hostname === "[::1]");
  if (verifierUrl.protocol !== "https:" && !localHttp) {
    context.addIssue({
      code: "custom",
      path: ["REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL"],
      message: "The signed-request verifier must use HTTPS except on a loopback development host",
    });
  }
  if (value.NODE_ENV === "production" && verifierUrl.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      path: ["REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL"],
      message: "Production signed-request verification must use HTTPS",
    });
  }
}

const platformEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironment,
    LOG_LEVEL: logLevel,
    APP_BASE_URL: z.url().default("http://localhost:3000"),
    DATABASE_URL: postgresUrl,
    STRIPE_API_VERSION: stripeApiVersion,
    STRIPE_APP_ID: stripeAppId,
    STRIPE_PLATFORM_TEST_READ_KEY: optionalRestrictedTestApiKey,
    STRIPE_MANAGED_SANDBOX_READ_KEY: optionalRestrictedTestApiKey,
    STRIPE_PLATFORM_TEST_KEY: optionalLegacyTestApiKey,
    STRIPE_MANAGED_SANDBOX_KEY: optionalLegacyTestApiKey,
    STRIPE_PLATFORM_TEST_ACCOUNT_ID: stripeAccountId,
    STRIPE_MANAGED_SANDBOX_ACCOUNT_ID: stripeAccountId,
    STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET: webhookSecret,
    STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET: webhookSecret,
    // Optional, and set only while a webhook secret is being rolled. Stripe signs a delivery
    // with the secret current at send time and then retries that same signature for days, so
    // a bare cutover silently drops every event already in flight -- including a
    // `refund.failed` that would otherwise correct a refund we believe succeeded.
    STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS: webhookSecret.optional(),
    STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET_PREVIOUS: webhookSecret.optional(),
    STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET: z.literal("disabled").default("disabled"),
    REFUNDDESK_GLOBAL_LIVE_ENABLED: globalLiveEnabled,
    REFUNDDESK_FIELD_ENCRYPTION_KEY_V1: base64Key.optional(),
    REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: base64Key.optional(),
    REFUNDDESK_EXPORT_SIGNING_KEY_V1: base64Key,
    REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: applicationKeyVersion,
    REFUNDDESK_FIELD_KEY_ROTATION_STATE: applicationKeyRotationState,
    REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL: signedRequestVerifierUrl,
    REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN: base64Key,
  })
  .superRefine((value, context) => {
    validateAppBaseUrl(value, context);
    validateSignedRequestVerifierUrl(value, context);
    validateDatabasePrincipal(value.DATABASE_URL, "DATABASE_URL", context);
    validateDatabaseTransport(value.DATABASE_URL, value.NODE_ENV, "DATABASE_URL", context);
    validateScopedStripeKeys(
      value.NODE_ENV,
      value.STRIPE_PLATFORM_TEST_READ_KEY,
      value.STRIPE_MANAGED_SANDBOX_READ_KEY,
      value.STRIPE_PLATFORM_TEST_KEY,
      value.STRIPE_MANAGED_SANDBOX_KEY,
      "READ",
      context,
    );
    if (
      resolveScopedKey(value.STRIPE_PLATFORM_TEST_READ_KEY, value.STRIPE_PLATFORM_TEST_KEY) ===
      resolveScopedKey(value.STRIPE_MANAGED_SANDBOX_READ_KEY, value.STRIPE_MANAGED_SANDBOX_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_MANAGED_SANDBOX_READ_KEY"],
        message: "Test-mode and managed-sandbox API keys must be distinct",
      });
    }
    if (value.STRIPE_PLATFORM_TEST_ACCOUNT_ID === value.STRIPE_MANAGED_SANDBOX_ACCOUNT_ID) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_MANAGED_SANDBOX_ACCOUNT_ID"],
        message: "Test-mode and managed-sandbox account IDs must be distinct",
      });
    }
    if (value.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET === value.STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET"],
        message: "Test-mode and managed-sandbox webhook secrets must be distinct",
      });
    }
    // Every webhook secret in play must be distinct, not just the two current ones. A value
    // shared across endpoints would let an event delivered for one environment verify on the
    // other, and a previous secret equal to its own current one would make a roll a no-op
    // that reads as if it had happened.
    for (const [path, secret] of [
      [
        "STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS",
        value.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS,
      ],
      [
        "STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET_PREVIOUS",
        value.STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET_PREVIOUS,
      ],
    ] as const) {
      if (secret === undefined) {
        continue;
      }
      const others = [
        value.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET,
        value.STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET,
        path === "STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS"
          ? value.STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET_PREVIOUS
          : value.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS,
      ];
      if (others.includes(secret)) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: "Every webhook secret must be distinct from every other",
        });
      }
    }
    validateApplicationKeyMaterialState(
      value.REFUNDDESK_ACTIVE_FIELD_KEY_VERSION,
      value.REFUNDDESK_FIELD_KEY_ROTATION_STATE,
      value.REFUNDDESK_FIELD_ENCRYPTION_KEY_V1,
      value.REFUNDDESK_FIELD_ENCRYPTION_KEY_V2,
      "REFUNDDESK_FIELD_KEY_ROTATION_STATE",
      context,
    );
    validateDistinctApplicationKeys(
      [
        ["REFUNDDESK_FIELD_ENCRYPTION_KEY_V1", value.REFUNDDESK_FIELD_ENCRYPTION_KEY_V1],
        ["REFUNDDESK_FIELD_ENCRYPTION_KEY_V2", value.REFUNDDESK_FIELD_ENCRYPTION_KEY_V2],
        ["REFUNDDESK_EXPORT_SIGNING_KEY_V1", value.REFUNDDESK_EXPORT_SIGNING_KEY_V1],
      ],
      context,
    );
  });

const workerEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironment,
    LOG_LEVEL: logLevel,
    WORKER_DATABASE_URL: postgresUrl,
    PGBOSS_DATABASE_URL: postgresUrl,
    STRIPE_API_VERSION: stripeApiVersion,
    STRIPE_APP_SIGNING_SECRET: appSigningSecret,
    // Optional, and set only while the App signing secret is being rolled. Stripe keeps the
    // retired secret valid for an overlap window and may sign an extension request with
    // either, so holding one refuses whichever half we do not have.
    STRIPE_APP_SIGNING_SECRET_PREVIOUS: appSigningSecret.optional(),
    STRIPE_PLATFORM_TEST_EFFECT_KEY: optionalRestrictedTestApiKey,
    STRIPE_MANAGED_SANDBOX_EFFECT_KEY: optionalRestrictedTestApiKey,
    STRIPE_PLATFORM_TEST_KEY: optionalLegacyTestApiKey,
    STRIPE_MANAGED_SANDBOX_KEY: optionalLegacyTestApiKey,
    STRIPE_PLATFORM_TEST_ACCOUNT_ID: stripeAccountId,
    STRIPE_MANAGED_SANDBOX_ACCOUNT_ID: stripeAccountId,
    REFUNDDESK_GLOBAL_LIVE_ENABLED: globalLiveEnabled,
    REFUNDDESK_PROOF_HMAC_KEY_V1: base64Key.optional(),
    REFUNDDESK_PROOF_HMAC_KEY_V2: base64Key.optional(),
    REFUNDDESK_ACTIVE_PROOF_KEY_VERSION: applicationKeyVersion,
    REFUNDDESK_PROOF_KEY_ROTATION_STATE: applicationKeyRotationState,
    REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1: base64Key.optional(),
    REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2: base64Key.optional(),
    REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION: applicationKeyVersion,
    REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE: applicationKeyRotationState,
    REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN: base64Key,
    WORKER_HEALTH_HOST: workerHealthHost,
    WORKER_HEALTH_PORT: workerHealthPort,
    REFUNDDESK_WORKER_RUNTIME_MODE: workerRuntimeMode,
  })
  .superRefine((value, context) => {
    // A previous App signing secret equal to its own current one makes a roll a no-op that
    // reads as if it had happened.
    if (value.STRIPE_APP_SIGNING_SECRET_PREVIOUS === value.STRIPE_APP_SIGNING_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_APP_SIGNING_SECRET_PREVIOUS"],
        message: "The previous App signing secret must differ from the current one",
      });
    }
    validateDatabasePrincipal(value.WORKER_DATABASE_URL, "WORKER_DATABASE_URL", context);
    validateDatabasePrincipal(value.PGBOSS_DATABASE_URL, "PGBOSS_DATABASE_URL", context);
    validateDatabaseTransport(
      value.WORKER_DATABASE_URL,
      value.NODE_ENV,
      "WORKER_DATABASE_URL",
      context,
    );
    validateDatabaseTransport(
      value.PGBOSS_DATABASE_URL,
      value.NODE_ENV,
      "PGBOSS_DATABASE_URL",
      context,
    );
    validateScopedStripeKeys(
      value.NODE_ENV,
      value.STRIPE_PLATFORM_TEST_EFFECT_KEY,
      value.STRIPE_MANAGED_SANDBOX_EFFECT_KEY,
      value.STRIPE_PLATFORM_TEST_KEY,
      value.STRIPE_MANAGED_SANDBOX_KEY,
      "EFFECT",
      context,
    );
    if (
      resolveScopedKey(value.STRIPE_PLATFORM_TEST_EFFECT_KEY, value.STRIPE_PLATFORM_TEST_KEY) ===
      resolveScopedKey(value.STRIPE_MANAGED_SANDBOX_EFFECT_KEY, value.STRIPE_MANAGED_SANDBOX_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_MANAGED_SANDBOX_EFFECT_KEY"],
        message: "Test-mode and managed-sandbox API keys must be distinct",
      });
    }
    if (value.STRIPE_PLATFORM_TEST_ACCOUNT_ID === value.STRIPE_MANAGED_SANDBOX_ACCOUNT_ID) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_MANAGED_SANDBOX_ACCOUNT_ID"],
        message: "Test-mode and managed-sandbox account IDs must be distinct",
      });
    }
    validateApplicationKeyMaterialState(
      value.REFUNDDESK_ACTIVE_PROOF_KEY_VERSION,
      value.REFUNDDESK_PROOF_KEY_ROTATION_STATE,
      value.REFUNDDESK_PROOF_HMAC_KEY_V1,
      value.REFUNDDESK_PROOF_HMAC_KEY_V2,
      "REFUNDDESK_PROOF_KEY_ROTATION_STATE",
      context,
    );
    validateApplicationKeyMaterialState(
      value.REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION,
      value.REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE,
      value.REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1,
      value.REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2,
      "REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE",
      context,
    );
    validateDistinctApplicationKeys(
      [
        ["REFUNDDESK_PROOF_HMAC_KEY_V1", value.REFUNDDESK_PROOF_HMAC_KEY_V1],
        ["REFUNDDESK_PROOF_HMAC_KEY_V2", value.REFUNDDESK_PROOF_HMAC_KEY_V2],
        [
          "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1",
          value.REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1,
        ],
        [
          "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2",
          value.REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2,
        ],
      ],
      context,
    );
  });

const migrationEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironment,
    LOG_LEVEL: logLevel,
    DATABASE_URL: postgresUrl,
    WORKER_DATABASE_URL: postgresUrl,
    PGBOSS_DATABASE_URL: postgresUrl,
    DATABASE_MIGRATION_URL: postgresUrl,
  })
  .superRefine((value, context) => {
    const web = validateDatabasePrincipal(value.DATABASE_URL, "DATABASE_URL", context);
    const worker = validateDatabasePrincipal(
      value.WORKER_DATABASE_URL,
      "WORKER_DATABASE_URL",
      context,
    );
    const queue = validateDatabasePrincipal(
      value.PGBOSS_DATABASE_URL,
      "PGBOSS_DATABASE_URL",
      context,
    );
    const owner = validateDatabasePrincipal(
      value.DATABASE_MIGRATION_URL,
      "DATABASE_MIGRATION_URL",
      context,
    );
    for (const [field, connectionString] of [
      ["DATABASE_URL", value.DATABASE_URL],
      ["WORKER_DATABASE_URL", value.WORKER_DATABASE_URL],
      ["PGBOSS_DATABASE_URL", value.PGBOSS_DATABASE_URL],
      ["DATABASE_MIGRATION_URL", value.DATABASE_MIGRATION_URL],
    ] as const) {
      validateDatabaseTransport(connectionString, value.NODE_ENV, field, context);
    }
    validateDatabasePrincipalSeparation({ web, worker, queue, owner }, context);
  });

export type NodeEnvironment = "development" | "test" | "production";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
interface RuntimeConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly liveEnabled: false;
}

export interface PlatformConfig extends RuntimeConfig {
  readonly appBaseUrl: string;
  readonly databaseUrl: string;
  readonly signedRequestVerifierUrl: string;
  readonly signedRequestVerifierToken: string;
  readonly stripe: {
    readonly apiVersion: "2026-06-24.dahlia";
    readonly appId: string;
    readonly platformTestAccountId: string;
    readonly managedSandboxAccountId: string;
    readonly platformTestReadKey: string;
    readonly managedSandboxReadKey: string;
    readonly accountTestWebhookSecret: string;
    readonly accountSandboxWebhookSecret: string;
    /** Present only during a roll; accepted for verification, never used to sign. */
    readonly accountTestWebhookSecretPrevious?: string;
    readonly accountSandboxWebhookSecretPrevious?: string;
    readonly accountLiveWebhookSecret: "disabled";
  };
  readonly keys: {
    readonly activeFieldVersion: ApplicationKeyVersion;
    readonly fieldRotationState: ApplicationKeyRotationState;
    readonly fieldV1?: Buffer;
    readonly fieldV2?: Buffer;
    readonly exportV1: Buffer;
  };
}

export interface WorkerConfig extends RuntimeConfig {
  readonly runtimeMode: "normal" | "incident_admission";
  readonly workerDatabaseUrl: string;
  readonly pgBossDatabaseUrl: string;
  readonly signedRequestVerifierToken: string;
  readonly stripe: {
    readonly apiVersion: "2026-06-24.dahlia";
    readonly appSigningSecret: string;
    /** Present only during a roll; accepted for verification, never used to sign. */
    readonly appSigningSecretPrevious?: string;
    readonly platformTestAccountId: string;
    readonly managedSandboxAccountId: string;
    readonly platformTestEffectKey: string;
    readonly managedSandboxEffectKey: string;
  };
  readonly keys: {
    readonly activeProofVersion: ApplicationKeyVersion;
    readonly proofRotationState: ApplicationKeyRotationState;
    readonly proofV1?: Buffer;
    readonly proofV2?: Buffer;
    readonly activeApprovalAttestationVersion: ApplicationKeyVersion;
    readonly approvalAttestationRotationState: ApplicationKeyRotationState;
    readonly approvalAttestationV1?: Buffer;
    readonly approvalAttestationV2?: Buffer;
  };
  readonly health: {
    readonly host: "127.0.0.1" | "0.0.0.0" | "::1" | "::";
    readonly port: number;
  };
}

export interface MigrationConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly workerDatabaseUrl: string;
  readonly pgBossDatabaseUrl: string;
  readonly migrationDatabaseUrl: string;
}

export interface ReleaseConfigSet {
  readonly platform: PlatformConfig;
  readonly worker: WorkerConfig;
  readonly migration: MigrationConfig;
}

export function loadPlatformConfig(source: NodeJS.ProcessEnv = process.env): PlatformConfig {
  validateOptionalCombinedEnvironment(source);
  rejectProductionPostgresEnvironmentOverrides(source);
  rejectForeignProductionSecrets(source, [
    "WORKER_DATABASE_URL",
    "PGBOSS_DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "STRIPE_PLATFORM_TEST_EFFECT_KEY",
    "STRIPE_MANAGED_SANDBOX_EFFECT_KEY",
    "REFUNDDESK_PROOF_HMAC_KEY_V1",
    "REFUNDDESK_PROOF_HMAC_KEY_V2",
    "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1",
    "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2",
  ]);
  rejectUnexpectedProductionNamespaceVariables(
    source,
    [
      "STRIPE_API_VERSION",
      "STRIPE_APP_ID",
      "STRIPE_PLATFORM_TEST_ACCOUNT_ID",
      "STRIPE_MANAGED_SANDBOX_ACCOUNT_ID",
      "STRIPE_PLATFORM_TEST_READ_KEY",
      "STRIPE_MANAGED_SANDBOX_READ_KEY",
      "STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET",
      "STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET",
      "STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS",
      "STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET_PREVIOUS",
      "STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET",
    ],
    [
      "REFUNDDESK_GLOBAL_LIVE_ENABLED",
      "REFUNDDESK_FIELD_ENCRYPTION_KEY_V1",
      "REFUNDDESK_FIELD_ENCRYPTION_KEY_V2",
      "REFUNDDESK_EXPORT_SIGNING_KEY_V1",
      "REFUNDDESK_ACTIVE_FIELD_KEY_VERSION",
      "REFUNDDESK_FIELD_KEY_ROTATION_STATE",
      "REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL",
      "REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN",
    ],
  );
  const env = platformEnvironmentSchema.parse(source);
  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    appBaseUrl: env.APP_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    signedRequestVerifierUrl: env.REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL,
    signedRequestVerifierToken: env.REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN,
    liveEnabled: false,
    stripe: {
      apiVersion: env.STRIPE_API_VERSION,
      appId: env.STRIPE_APP_ID,
      platformTestAccountId: env.STRIPE_PLATFORM_TEST_ACCOUNT_ID,
      managedSandboxAccountId: env.STRIPE_MANAGED_SANDBOX_ACCOUNT_ID,
      platformTestReadKey: requireScopedKey(
        env.STRIPE_PLATFORM_TEST_READ_KEY,
        env.STRIPE_PLATFORM_TEST_KEY,
      ),
      managedSandboxReadKey: requireScopedKey(
        env.STRIPE_MANAGED_SANDBOX_READ_KEY,
        env.STRIPE_MANAGED_SANDBOX_KEY,
      ),
      accountTestWebhookSecret: env.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET,
      accountSandboxWebhookSecret: env.STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET,
      ...(env.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS === undefined
        ? {}
        : { accountTestWebhookSecretPrevious: env.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS }),
      ...(env.STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET_PREVIOUS === undefined
        ? {}
        : {
            accountSandboxWebhookSecretPrevious: env.STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET_PREVIOUS,
          }),
      accountLiveWebhookSecret: env.STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET,
    },
    keys: {
      activeFieldVersion: env.REFUNDDESK_ACTIVE_FIELD_KEY_VERSION,
      fieldRotationState: env.REFUNDDESK_FIELD_KEY_ROTATION_STATE,
      ...(env.REFUNDDESK_FIELD_ENCRYPTION_KEY_V1 === undefined
        ? {}
        : { fieldV1: Buffer.from(env.REFUNDDESK_FIELD_ENCRYPTION_KEY_V1, "base64") }),
      ...(env.REFUNDDESK_FIELD_ENCRYPTION_KEY_V2 === undefined
        ? {}
        : { fieldV2: Buffer.from(env.REFUNDDESK_FIELD_ENCRYPTION_KEY_V2, "base64") }),
      exportV1: Buffer.from(env.REFUNDDESK_EXPORT_SIGNING_KEY_V1, "base64"),
    },
  };
}

export function loadWorkerConfig(source: NodeJS.ProcessEnv = process.env): WorkerConfig {
  validateOptionalCombinedEnvironment(source);
  rejectProductionPostgresEnvironmentOverrides(source);
  rejectForeignProductionSecrets(source, [
    "APP_BASE_URL",
    "DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "STRIPE_APP_ID",
    "STRIPE_PLATFORM_TEST_READ_KEY",
    "STRIPE_MANAGED_SANDBOX_READ_KEY",
    "STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET",
    "STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET",
    "STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS",
    "STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET_PREVIOUS",
    "STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET",
    "REFUNDDESK_FIELD_ENCRYPTION_KEY_V1",
    "REFUNDDESK_FIELD_ENCRYPTION_KEY_V2",
    "REFUNDDESK_EXPORT_SIGNING_KEY_V1",
  ]);
  rejectUnexpectedProductionNamespaceVariables(
    source,
    [
      "STRIPE_API_VERSION",
      "STRIPE_APP_SIGNING_SECRET",
      "STRIPE_APP_SIGNING_SECRET_PREVIOUS",
      "STRIPE_PLATFORM_TEST_ACCOUNT_ID",
      "STRIPE_MANAGED_SANDBOX_ACCOUNT_ID",
      "STRIPE_PLATFORM_TEST_EFFECT_KEY",
      "STRIPE_MANAGED_SANDBOX_EFFECT_KEY",
    ],
    [
      "REFUNDDESK_GLOBAL_LIVE_ENABLED",
      "REFUNDDESK_PROOF_HMAC_KEY_V1",
      "REFUNDDESK_PROOF_HMAC_KEY_V2",
      "REFUNDDESK_ACTIVE_PROOF_KEY_VERSION",
      "REFUNDDESK_PROOF_KEY_ROTATION_STATE",
      "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1",
      "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2",
      "REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION",
      "REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE",
      "REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN",
      "REFUNDDESK_WORKER_RUNTIME_MODE",
    ],
  );
  const env = workerEnvironmentSchema.parse(source);
  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    workerDatabaseUrl: env.WORKER_DATABASE_URL,
    pgBossDatabaseUrl: env.PGBOSS_DATABASE_URL,
    signedRequestVerifierToken: env.REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN,
    runtimeMode: env.REFUNDDESK_WORKER_RUNTIME_MODE,
    liveEnabled: false,
    stripe: {
      apiVersion: env.STRIPE_API_VERSION,
      appSigningSecret: env.STRIPE_APP_SIGNING_SECRET,
      ...(env.STRIPE_APP_SIGNING_SECRET_PREVIOUS === undefined
        ? {}
        : { appSigningSecretPrevious: env.STRIPE_APP_SIGNING_SECRET_PREVIOUS }),
      platformTestAccountId: env.STRIPE_PLATFORM_TEST_ACCOUNT_ID,
      managedSandboxAccountId: env.STRIPE_MANAGED_SANDBOX_ACCOUNT_ID,
      platformTestEffectKey: requireScopedKey(
        env.STRIPE_PLATFORM_TEST_EFFECT_KEY,
        env.STRIPE_PLATFORM_TEST_KEY,
      ),
      managedSandboxEffectKey: requireScopedKey(
        env.STRIPE_MANAGED_SANDBOX_EFFECT_KEY,
        env.STRIPE_MANAGED_SANDBOX_KEY,
      ),
    },
    keys: {
      activeProofVersion: env.REFUNDDESK_ACTIVE_PROOF_KEY_VERSION,
      proofRotationState: env.REFUNDDESK_PROOF_KEY_ROTATION_STATE,
      ...(env.REFUNDDESK_PROOF_HMAC_KEY_V1 === undefined
        ? {}
        : { proofV1: Buffer.from(env.REFUNDDESK_PROOF_HMAC_KEY_V1, "base64") }),
      ...(env.REFUNDDESK_PROOF_HMAC_KEY_V2 === undefined
        ? {}
        : { proofV2: Buffer.from(env.REFUNDDESK_PROOF_HMAC_KEY_V2, "base64") }),
      activeApprovalAttestationVersion: env.REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION,
      approvalAttestationRotationState: env.REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE,
      ...(env.REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1 === undefined
        ? {}
        : {
            approvalAttestationV1: Buffer.from(
              env.REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1,
              "base64",
            ),
          }),
      ...(env.REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2 === undefined
        ? {}
        : {
            approvalAttestationV2: Buffer.from(
              env.REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2,
              "base64",
            ),
          }),
    },
    health: {
      host: env.WORKER_HEALTH_HOST,
      port: env.WORKER_HEALTH_PORT,
    },
  };
}

export function loadMigrationConfig(source: NodeJS.ProcessEnv = process.env): MigrationConfig {
  validateOptionalCombinedEnvironment(source);
  rejectProductionPostgresEnvironmentOverrides(source);
  rejectUnexpectedProductionNamespaceVariables(source, [], []);
  const env = migrationEnvironmentSchema.parse(source);
  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    workerDatabaseUrl: env.WORKER_DATABASE_URL,
    pgBossDatabaseUrl: env.PGBOSS_DATABASE_URL,
    migrationDatabaseUrl: env.DATABASE_MIGRATION_URL,
  };
}

function rejectForeignProductionSecrets(
  source: NodeJS.ProcessEnv,
  forbiddenNames: readonly string[],
): void {
  if (source["NODE_ENV"] !== "production") {
    return;
  }
  if (forbiddenNames.some((name) => source[name] !== undefined)) {
    throw new Error("FOREIGN_RUNTIME_SECRET_FORBIDDEN");
  }
}

function rejectProductionPostgresEnvironmentOverrides(source: NodeJS.ProcessEnv): void {
  if (
    source["NODE_ENV"] === "production" &&
    [...FORBIDDEN_POSTGRES_PROCESS_VARIABLES].some((name) => source[name] !== undefined)
  ) {
    throw new Error("POSTGRES_ENVIRONMENT_OVERRIDE_FORBIDDEN");
  }
}

function rejectUnexpectedProductionNamespaceVariables(
  source: NodeJS.ProcessEnv,
  allowedStripeNames: readonly string[],
  allowedRefundDeskNames: readonly string[],
): void {
  if (source["NODE_ENV"] !== "production") {
    return;
  }
  const allowedStripe = new Set(allowedStripeNames);
  const allowedRefundDesk = new Set(allowedRefundDeskNames);
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (/^(?:pk|rk|sk)_live_/u.test(value)) {
      throw new Error("LIVE_STRIPE_CREDENTIAL_FORBIDDEN");
    }
    if (
      (name.startsWith("STRIPE_") && !allowedStripe.has(name)) ||
      (name.startsWith("REFUNDDESK_") && !allowedRefundDesk.has(name))
    ) {
      throw new Error("FOREIGN_RUNTIME_SECRET_FORBIDDEN");
    }
  }
}

function validateOptionalCombinedEnvironment(source: NodeJS.ProcessEnv): void {
  if (source["NODE_ENV"] === "production") {
    return;
  }

  const principals = {
    web: optionalDatabasePrincipal(source["DATABASE_URL"]),
    worker: optionalDatabasePrincipal(source["WORKER_DATABASE_URL"]),
    queue: optionalDatabasePrincipal(source["PGBOSS_DATABASE_URL"]),
    owner: optionalDatabasePrincipal(source["DATABASE_MIGRATION_URL"]),
  };
  if (
    (principals.web !== undefined &&
      principals.worker !== undefined &&
      principals.web === principals.worker) ||
    (principals.web !== undefined &&
      principals.queue !== undefined &&
      principals.web === principals.queue) ||
    (principals.worker !== undefined &&
      principals.queue !== undefined &&
      principals.worker === principals.queue) ||
    (principals.owner !== undefined &&
      [principals.web, principals.worker, principals.queue].some(
        (runtime) => runtime !== undefined && runtime === principals.owner,
      ))
  ) {
    throw new Error("RUNTIME_DATABASE_PRINCIPALS_NOT_SEPARATED");
  }

  assertOptionalValuesAreDistinct(
    [
      source["REFUNDDESK_FIELD_ENCRYPTION_KEY_V1"],
      source["REFUNDDESK_FIELD_ENCRYPTION_KEY_V2"],
      source["REFUNDDESK_PROOF_HMAC_KEY_V1"],
      source["REFUNDDESK_PROOF_HMAC_KEY_V2"],
      source["REFUNDDESK_EXPORT_SIGNING_KEY_V1"],
      source["REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1"],
      source["REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2"],
    ],
    "APPLICATION_KEYS_NOT_SEPARATED",
  );
  assertOptionalValuesAreDistinct(
    [
      source["STRIPE_PLATFORM_TEST_READ_KEY"],
      source["STRIPE_MANAGED_SANDBOX_READ_KEY"],
      source["STRIPE_PLATFORM_TEST_EFFECT_KEY"],
      source["STRIPE_MANAGED_SANDBOX_EFFECT_KEY"],
    ],
    "STRIPE_RUNTIME_CREDENTIALS_NOT_SEPARATED",
  );
}

function optionalDatabasePrincipal(connectionString: string | undefined): string | undefined {
  if (connectionString === undefined) {
    return undefined;
  }
  const principal = databasePrincipal(connectionString);
  if (principal === null) {
    throw new Error("POSTGRESQL_URL_AUTHORITY_OVERRIDE_FORBIDDEN");
  }
  return principal;
}

function assertOptionalValuesAreDistinct(
  values: readonly (string | undefined)[],
  code: string,
): void {
  const present = values.filter((value): value is string => value !== undefined);
  if (new Set(present).size !== present.length) {
    throw new Error(code);
  }
}

export function assertReleaseConfigSeparation(config: ReleaseConfigSet): void {
  const webPrincipal = databasePrincipal(config.platform.databaseUrl);
  const workerPrincipal = databasePrincipal(config.worker.workerDatabaseUrl);
  const queuePrincipal = databasePrincipal(config.worker.pgBossDatabaseUrl);
  const migrationPrincipal = databasePrincipal(config.migration.migrationDatabaseUrl);
  if (
    webPrincipal === null ||
    workerPrincipal === null ||
    queuePrincipal === null ||
    migrationPrincipal === null ||
    webPrincipal === workerPrincipal ||
    webPrincipal === queuePrincipal ||
    webPrincipal === migrationPrincipal ||
    workerPrincipal === migrationPrincipal ||
    queuePrincipal === migrationPrincipal ||
    workerPrincipal === queuePrincipal
  ) {
    throw new Error("RUNTIME_DATABASE_PRINCIPALS_NOT_SEPARATED");
  }
  if (
    config.migration.databaseUrl !== config.platform.databaseUrl ||
    config.migration.workerDatabaseUrl !== config.worker.workerDatabaseUrl ||
    config.migration.pgBossDatabaseUrl !== config.worker.pgBossDatabaseUrl
  ) {
    throw new Error("MIGRATION_RUNTIME_DATABASE_URLS_DIVERGE");
  }
  if (
    !applicationKeyMaterialStateIsValid({
      activeVersion: config.platform.keys.activeFieldVersion,
      rotationState: config.platform.keys.fieldRotationState,
      v1Present: config.platform.keys.fieldV1 !== undefined,
      v2Present: config.platform.keys.fieldV2 !== undefined,
    }) ||
    !applicationKeyMaterialStateIsValid({
      activeVersion: config.worker.keys.activeProofVersion,
      rotationState: config.worker.keys.proofRotationState,
      v1Present: config.worker.keys.proofV1 !== undefined,
      v2Present: config.worker.keys.proofV2 !== undefined,
    }) ||
    !applicationKeyMaterialStateIsValid({
      activeVersion: config.worker.keys.activeApprovalAttestationVersion,
      rotationState: config.worker.keys.approvalAttestationRotationState,
      v1Present: config.worker.keys.approvalAttestationV1 !== undefined,
      v2Present: config.worker.keys.approvalAttestationV2 !== undefined,
    })
  ) {
    throw new Error("APPLICATION_KEY_ROTATION_STATE_INVALID");
  }

  const applicationKeys = [
    config.platform.keys.fieldV1,
    config.platform.keys.fieldV2,
    config.platform.keys.exportV1,
    config.worker.keys.proofV1,
    config.worker.keys.proofV2,
    config.worker.keys.approvalAttestationV1,
    config.worker.keys.approvalAttestationV2,
  ].filter((key): key is Buffer => key !== undefined);
  for (let leftIndex = 0; leftIndex < applicationKeys.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < applicationKeys.length; rightIndex += 1) {
      if (applicationKeys[leftIndex]?.equals(applicationKeys[rightIndex] ?? Buffer.alloc(0))) {
        throw new Error("APPLICATION_KEYS_NOT_SEPARATED");
      }
    }
  }
  if (config.platform.signedRequestVerifierToken !== config.worker.signedRequestVerifierToken) {
    throw new Error("SIGNED_REQUEST_VERIFIER_TOKEN_MISMATCH");
  }
  if (
    config.platform.stripe.platformTestAccountId !== config.worker.stripe.platformTestAccountId ||
    config.platform.stripe.managedSandboxAccountId !== config.worker.stripe.managedSandboxAccountId
  ) {
    throw new Error("STRIPE_ACCOUNT_BINDING_MISMATCH");
  }
  if (
    config.platform.stripe.platformTestAccountId ===
      config.platform.stripe.managedSandboxAccountId ||
    config.worker.stripe.platformTestAccountId === config.worker.stripe.managedSandboxAccountId
  ) {
    throw new Error("STRIPE_ACCOUNT_BINDINGS_NOT_DISTINCT");
  }
  const verifierToken = Buffer.from(config.platform.signedRequestVerifierToken, "base64");
  if (applicationKeys.some((key) => key.equals(verifierToken))) {
    throw new Error("APPLICATION_KEYS_NOT_SEPARATED");
  }

  const stripeCredentials = [
    config.platform.stripe.platformTestReadKey,
    config.platform.stripe.managedSandboxReadKey,
    config.worker.stripe.platformTestEffectKey,
    config.worker.stripe.managedSandboxEffectKey,
  ];
  if (new Set(stripeCredentials).size !== stripeCredentials.length) {
    throw new Error("STRIPE_RUNTIME_CREDENTIALS_NOT_SEPARATED");
  }
}

function resolveScopedKey(
  scoped: string | undefined,
  legacy: string | undefined,
): string | undefined {
  return scoped ?? legacy;
}

function requireScopedKey(scoped: string | undefined, legacy: string | undefined): string {
  const value = resolveScopedKey(scoped, legacy);
  if (value === undefined) {
    throw new Error("SCOPED_STRIPE_KEY_REQUIRED");
  }
  return value;
}

function validateScopedStripeKeys(
  nodeEnv: NodeEnvironment,
  platformScoped: string | undefined,
  sandboxScoped: string | undefined,
  platformLegacy: string | undefined,
  sandboxLegacy: string | undefined,
  scope: "READ" | "EFFECT",
  context: z.RefinementCtx,
): void {
  if (nodeEnv === "production" && (platformLegacy !== undefined || sandboxLegacy !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["STRIPE_PLATFORM_TEST_KEY"],
      message: "Generic Stripe runtime keys are forbidden in production",
    });
  }
  if (platformScoped === undefined && (nodeEnv === "production" || platformLegacy === undefined)) {
    context.addIssue({
      code: "custom",
      path: [`STRIPE_PLATFORM_TEST_${scope}_KEY`],
      message: `STRIPE_PLATFORM_TEST_${scope}_KEY is required`,
    });
  }
  if (sandboxScoped === undefined && (nodeEnv === "production" || sandboxLegacy === undefined)) {
    context.addIssue({
      code: "custom",
      path: [`STRIPE_MANAGED_SANDBOX_${scope}_KEY`],
      message: `STRIPE_MANAGED_SANDBOX_${scope}_KEY is required`,
    });
  }
}
