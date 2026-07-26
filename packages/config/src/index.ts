import { z } from "zod";

const appSigningSecret = z.string().regex(/^absec_[A-Za-z0-9_]+$/u);
const testApiKey = z.string().regex(/^(?:sk|rk)_test_[A-Za-z0-9_]+$/u);
const webhookSecret = z.string().regex(/^whsec_[A-Za-z0-9_]+$/u);
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

function databasePrincipal(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      url.username.length === 0
    ) {
      return null;
    }
    return decodeURIComponent(url.username);
  } catch {
    return null;
  }
}

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    APP_BASE_URL: z.url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1),
    WORKER_DATABASE_URL: z.string().min(1),
    DATABASE_MIGRATION_URL: z.string().min(1).optional(),
    PGBOSS_DATABASE_URL: z.string().min(1),
    STRIPE_API_VERSION: z.literal("2026-06-24.dahlia"),
    STRIPE_APP_SIGNING_SECRET: appSigningSecret,
    STRIPE_PLATFORM_TEST_KEY: testApiKey,
    STRIPE_MANAGED_SANDBOX_KEY: testApiKey,
    STRIPE_CONNECTED_TEST_WEBHOOK_SECRET: webhookSecret,
    STRIPE_CONNECTED_SANDBOX_WEBHOOK_SECRET: webhookSecret,
    STRIPE_CONNECTED_LIVE_WEBHOOK_SECRET: z.literal("disabled").default("disabled"),
    REFUNDDESK_GLOBAL_LIVE_ENABLED: z.literal("false").default("false"),
    REFUNDDESK_FIELD_ENCRYPTION_KEY_V1: base64Key,
    REFUNDDESK_PROOF_HMAC_KEY_V1: base64Key,
    REFUNDDESK_EXPORT_SIGNING_KEY_V1: base64Key,
    REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: z.literal("v1"),
    REFUNDDESK_ACTIVE_PROOF_KEY_VERSION: z.literal("v1"),
  })
  .superRefine((value, context) => {
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
    const webPrincipal = databasePrincipal(value.DATABASE_URL);
    const workerPrincipal = databasePrincipal(value.WORKER_DATABASE_URL);
    const pgBossPrincipal = databasePrincipal(value.PGBOSS_DATABASE_URL);
    const migrationPrincipal =
      value.DATABASE_MIGRATION_URL === undefined
        ? undefined
        : databasePrincipal(value.DATABASE_MIGRATION_URL);
    for (const [field, principal] of [
      ["DATABASE_URL", webPrincipal],
      ["WORKER_DATABASE_URL", workerPrincipal],
      ["PGBOSS_DATABASE_URL", pgBossPrincipal],
      ["DATABASE_MIGRATION_URL", migrationPrincipal],
    ] as const) {
      if (principal === null) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Expected a PostgreSQL URL with an explicit database principal",
        });
      }
    }
    if (webPrincipal !== null && workerPrincipal !== null && webPrincipal === workerPrincipal) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_DATABASE_URL"],
        message: "Web and worker database credentials must be distinct",
      });
    }
    if (webPrincipal !== null && pgBossPrincipal !== null && webPrincipal === pgBossPrincipal) {
      context.addIssue({
        code: "custom",
        path: ["PGBOSS_DATABASE_URL"],
        message: "Web and queue database credentials must be distinct",
      });
    }
    if (
      migrationPrincipal !== undefined &&
      migrationPrincipal !== null &&
      (migrationPrincipal === webPrincipal ||
        migrationPrincipal === workerPrincipal ||
        migrationPrincipal === pgBossPrincipal)
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_MIGRATION_URL"],
        message: "Migration credentials must be distinct from runtime credentials",
      });
    }
    if (value.STRIPE_PLATFORM_TEST_KEY === value.STRIPE_MANAGED_SANDBOX_KEY) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_MANAGED_SANDBOX_KEY"],
        message: "Test-mode and managed-sandbox API keys must be distinct",
      });
    }
    if (
      value.STRIPE_CONNECTED_TEST_WEBHOOK_SECRET === value.STRIPE_CONNECTED_SANDBOX_WEBHOOK_SECRET
    ) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_CONNECTED_SANDBOX_WEBHOOK_SECRET"],
        message: "Test-mode and managed-sandbox webhook secrets must be distinct",
      });
    }
    if (value.REFUNDDESK_FIELD_ENCRYPTION_KEY_V1 === value.REFUNDDESK_PROOF_HMAC_KEY_V1) {
      context.addIssue({
        code: "custom",
        path: ["REFUNDDESK_PROOF_HMAC_KEY_V1"],
        message: "Proof and field-encryption keys must be independent",
      });
    }
    if (
      value.REFUNDDESK_EXPORT_SIGNING_KEY_V1 === value.REFUNDDESK_FIELD_ENCRYPTION_KEY_V1 ||
      value.REFUNDDESK_EXPORT_SIGNING_KEY_V1 === value.REFUNDDESK_PROOF_HMAC_KEY_V1
    ) {
      context.addIssue({
        code: "custom",
        path: ["REFUNDDESK_EXPORT_SIGNING_KEY_V1"],
        message: "Audit-export signing keys must be independent",
      });
    }
  });

export interface RefundDeskConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly appBaseUrl: string;
  readonly databaseUrl: string;
  readonly workerDatabaseUrl: string;
  readonly migrationDatabaseUrl?: string;
  readonly pgBossDatabaseUrl: string;
  readonly liveEnabled: false;
  readonly stripe: {
    readonly apiVersion: "2026-06-24.dahlia";
    readonly appSigningSecret: string;
    readonly platformTestKey: string;
    readonly managedSandboxKey: string;
    readonly connectedTestWebhookSecret: string;
    readonly connectedSandboxWebhookSecret: string;
    readonly connectedLiveWebhookSecret: string;
  };
  readonly keys: {
    readonly activeFieldVersion: "v1";
    readonly activeProofVersion: "v1";
    readonly fieldV1: Buffer;
    readonly proofV1: Buffer;
    readonly exportV1: Buffer;
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RefundDeskConfig {
  const env = environmentSchema.parse(source);

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    appBaseUrl: env.APP_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    workerDatabaseUrl: env.WORKER_DATABASE_URL,
    ...(env.DATABASE_MIGRATION_URL === undefined
      ? {}
      : { migrationDatabaseUrl: env.DATABASE_MIGRATION_URL }),
    pgBossDatabaseUrl: env.PGBOSS_DATABASE_URL,
    liveEnabled: false,
    stripe: {
      apiVersion: env.STRIPE_API_VERSION,
      appSigningSecret: env.STRIPE_APP_SIGNING_SECRET,
      platformTestKey: env.STRIPE_PLATFORM_TEST_KEY,
      managedSandboxKey: env.STRIPE_MANAGED_SANDBOX_KEY,
      connectedTestWebhookSecret: env.STRIPE_CONNECTED_TEST_WEBHOOK_SECRET,
      connectedSandboxWebhookSecret: env.STRIPE_CONNECTED_SANDBOX_WEBHOOK_SECRET,
      connectedLiveWebhookSecret: env.STRIPE_CONNECTED_LIVE_WEBHOOK_SECRET,
    },
    keys: {
      activeFieldVersion: env.REFUNDDESK_ACTIVE_FIELD_KEY_VERSION,
      activeProofVersion: env.REFUNDDESK_ACTIVE_PROOF_KEY_VERSION,
      fieldV1: Buffer.from(env.REFUNDDESK_FIELD_ENCRYPTION_KEY_V1, "base64"),
      proofV1: Buffer.from(env.REFUNDDESK_PROOF_HMAC_KEY_V1, "base64"),
      exportV1: Buffer.from(env.REFUNDDESK_EXPORT_SIGNING_KEY_V1, "base64"),
    },
  };
}
