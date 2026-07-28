import { describe, expect, it } from "vitest";

import {
  assertReleaseConfigSeparation,
  loadMigrationConfig,
  loadPlatformConfig,
  loadWorkerConfig,
} from "../src/index.js";

function platformEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://runtime:local@localhost:5432/refunddesk",
    STRIPE_API_VERSION: "2026-06-24.dahlia",
    STRIPE_APP_ID: "ca_synthetic",
    STRIPE_PLATFORM_TEST_ACCOUNT_ID: "acct_PlatformTest123",
    STRIPE_MANAGED_SANDBOX_ACCOUNT_ID: "acct_ManagedSandbox456",
    STRIPE_PLATFORM_TEST_READ_KEY: "rk_test_platform_read",
    STRIPE_MANAGED_SANDBOX_READ_KEY: "rk_test_sandbox_read",
    STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET: "whsec_synthetic_test",
    STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET: "whsec_synthetic_sandbox",
    STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET: "disabled",
    REFUNDDESK_GLOBAL_LIVE_ENABLED: "false",
    REFUNDDESK_FIELD_ENCRYPTION_KEY_V1: Buffer.alloc(32, 1).toString("base64"),
    REFUNDDESK_EXPORT_SIGNING_KEY_V1: Buffer.alloc(32, 4).toString("base64"),
    REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: "v1",
    REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL:
      "https://worker.example/internal/v1/signed-requests/verify",
    REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN: Buffer.alloc(32, 5).toString("base64"),
  };
}

function workerEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    WORKER_DATABASE_URL: "postgresql://worker:local@localhost:5432/refunddesk",
    PGBOSS_DATABASE_URL: "postgresql://queue:queue@localhost:5432/refunddesk",
    STRIPE_API_VERSION: "2026-06-24.dahlia",
    STRIPE_APP_SIGNING_SECRET: "absec_synthetic",
    STRIPE_PLATFORM_TEST_ACCOUNT_ID: "acct_PlatformTest123",
    STRIPE_MANAGED_SANDBOX_ACCOUNT_ID: "acct_ManagedSandbox456",
    STRIPE_PLATFORM_TEST_EFFECT_KEY: "rk_test_platform_effect",
    STRIPE_MANAGED_SANDBOX_EFFECT_KEY: "rk_test_sandbox_effect",
    REFUNDDESK_GLOBAL_LIVE_ENABLED: "false",
    REFUNDDESK_PROOF_HMAC_KEY_V1: Buffer.alloc(32, 2).toString("base64"),
    REFUNDDESK_ACTIVE_PROOF_KEY_VERSION: "v1",
    REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1: Buffer.alloc(32, 3).toString("base64"),
    REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION: "v1",
    REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN: Buffer.alloc(32, 5).toString("base64"),
  };
}

function migrationEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    DATABASE_URL: "postgresql://runtime:local@localhost:5432/refunddesk",
    WORKER_DATABASE_URL: "postgresql://worker:local@localhost:5432/refunddesk",
    PGBOSS_DATABASE_URL: "postgresql://queue:queue@localhost:5432/refunddesk",
    DATABASE_MIGRATION_URL:
      "postgresql://refunddesk_owner:synthetic@db.internal:5432/refunddesk?sslmode=verify-full",
  };
}

describe("runtime-scoped configuration", () => {
  it("keeps live execution structurally disabled in every long-lived runtime", () => {
    expect(loadPlatformConfig(platformEnvironment()).liveEnabled).toBe(false);
    expect(loadWorkerConfig(workerEnvironment()).liveEnabled).toBe(false);

    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        REFUNDDESK_GLOBAL_LIVE_ENABLED: "true",
      }),
    ).toThrow();
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        REFUNDDESK_GLOBAL_LIVE_ENABLED: "true",
      }),
    ).toThrow();
  });

  it("loads the platform without worker, queue, migration, or proof credentials", () => {
    const config = loadPlatformConfig(platformEnvironment());

    expect(config.databaseUrl).toContain("runtime");
    expect(config.stripe.appId).toBe("ca_synthetic");
    expect(config.stripe.platformTestAccountId).toBe("acct_PlatformTest123");
    expect(config.stripe.platformTestReadKey).toBe("rk_test_platform_read");
    expect(config.signedRequestVerifierUrl).toBe(
      "https://worker.example/internal/v1/signed-requests/verify",
    );
    expect(config.keys.fieldV1).toHaveLength(32);
    expect(config).not.toHaveProperty("workerDatabaseUrl");
    expect(config).not.toHaveProperty("pgBossDatabaseUrl");
    expect(config.keys).not.toHaveProperty("proofV1");
  });

  it("loads the worker authority without web, migration, webhook, field, or export secrets", () => {
    const config = loadWorkerConfig(workerEnvironment());

    expect(config.workerDatabaseUrl).toContain("worker");
    expect(config.keys.proofV1).toHaveLength(32);
    expect(config.keys.approvalAttestationV1).toHaveLength(32);
    expect(config.signedRequestVerifierToken).toBe(Buffer.alloc(32, 5).toString("base64"));
    expect(config.stripe.appSigningSecret).toBe("absec_synthetic");
    expect(config.stripe.managedSandboxAccountId).toBe("acct_ManagedSandbox456");
    expect(config.stripe.platformTestEffectKey).toBe("rk_test_platform_effect");
    expect(config.health).toEqual({ host: "127.0.0.1", port: 3101 });
    expect(config).not.toHaveProperty("databaseUrl");
    expect(config.stripe).not.toHaveProperty("accountTestWebhookSecret");
    expect(config.keys).not.toHaveProperty("fieldV1");
    expect(config.keys).not.toHaveProperty("exportV1");
  });

  it("fails closed when production runtimes receive another service's known secrets", () => {
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        NODE_ENV: "production",
        APP_BASE_URL: "https://sandbox.refunddesk.example",
        STRIPE_APP_SIGNING_SECRET: "absec_foreign",
      }),
    ).toThrow("FOREIGN_RUNTIME_SECRET_FORBIDDEN");
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        NODE_ENV: "production",
        REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL:
          "https://worker.example/internal/v1/signed-requests/verify",
      }),
    ).toThrow("FOREIGN_RUNTIME_SECRET_FORBIDDEN");
    expect(() =>
      loadMigrationConfig({
        NODE_ENV: "production",
        DATABASE_MIGRATION_URL: "postgresql://owner:synthetic@db.internal:5432/refunddesk",
        REFUNDDESK_PROOF_HMAC_KEY_V1: Buffer.alloc(32, 9).toString("base64"),
      }),
    ).toThrow("FOREIGN_RUNTIME_SECRET_FORBIDDEN");
  });

  it("loads the migrator with only its owner credential and log settings", () => {
    expect(loadMigrationConfig(migrationEnvironment())).toEqual({
      nodeEnv: "production",
      logLevel: "warn",
      databaseUrl: "postgresql://runtime:local@localhost:5432/refunddesk",
      workerDatabaseUrl: "postgresql://worker:local@localhost:5432/refunddesk",
      pgBossDatabaseUrl: "postgresql://queue:queue@localhost:5432/refunddesk",
      migrationDatabaseUrl:
        "postgresql://refunddesk_owner:synthetic@db.internal:5432/refunddesk?sslmode=verify-full",
    });
  });

  it("rejects placeholders and invalid Stripe identities", () => {
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        STRIPE_PLATFORM_TEST_READ_KEY: "replace_me",
      }),
    ).toThrow();
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        STRIPE_APP_ID: "com.refunddesk.workflow",
      }),
    ).toThrow();
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        STRIPE_PLATFORM_TEST_ACCOUNT_ID: "ca_not_an_account",
      }),
    ).toThrow();
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        STRIPE_PLATFORM_TEST_READ_KEY: "sk_test_full_web_authority",
      }),
    ).toThrow();
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        STRIPE_PLATFORM_TEST_EFFECT_KEY: "sk_test_full_worker_authority",
      }),
    ).toThrow();
  });

  it("requires independent platform encryption and export keys", () => {
    const sharedKey = Buffer.alloc(32, 3).toString("base64");
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        REFUNDDESK_FIELD_ENCRYPTION_KEY_V1: sharedKey,
        REFUNDDESK_EXPORT_SIGNING_KEY_V1: sharedKey,
      }),
    ).toThrow();
  });

  it("requires independent Refund-proof and approval-attestation keys", () => {
    const worker = workerEnvironment();
    expect(() =>
      loadWorkerConfig({
        ...worker,
        REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1: worker.REFUNDDESK_PROOF_HMAC_KEY_V1,
      }),
    ).toThrow();
  });

  it("requires canonical base64 application keys", () => {
    const canonical = Buffer.alloc(32, 5).toString("base64");
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        REFUNDDESK_PROOF_HMAC_KEY_V1: ` ${canonical}`,
      }),
    ).toThrow();
  });

  it("requires separate test-mode and sandbox Stripe credentials", () => {
    const platform = platformEnvironment();
    expect(() =>
      loadPlatformConfig({
        ...platform,
        STRIPE_MANAGED_SANDBOX_READ_KEY: platform.STRIPE_PLATFORM_TEST_READ_KEY,
      }),
    ).toThrow();
    expect(() =>
      loadPlatformConfig({
        ...platform,
        STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET: platform.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET,
      }),
    ).toThrow();
    expect(() =>
      loadPlatformConfig({
        ...platform,
        STRIPE_MANAGED_SANDBOX_ACCOUNT_ID: platform.STRIPE_PLATFORM_TEST_ACCOUNT_ID,
      }),
    ).toThrow();

    const worker = workerEnvironment();
    expect(() =>
      loadWorkerConfig({
        ...worker,
        STRIPE_MANAGED_SANDBOX_EFFECT_KEY: worker.STRIPE_PLATFORM_TEST_EFFECT_KEY,
      }),
    ).toThrow();
    expect(() =>
      loadWorkerConfig({
        ...worker,
        STRIPE_MANAGED_SANDBOX_ACCOUNT_ID: worker.STRIPE_PLATFORM_TEST_ACCOUNT_ID,
      }),
    ).toThrow();
  });

  it("requires independent worker and queue database principals", () => {
    const worker = workerEnvironment();
    expect(() =>
      loadWorkerConfig({
        ...worker,
        PGBOSS_DATABASE_URL: "postgresql://worker:other@localhost:5432/refunddesk",
      }),
    ).toThrow();
  });

  it("allows generic Stripe key names only as a non-production compatibility bridge", () => {
    const worker = workerEnvironment();
    delete worker["STRIPE_PLATFORM_TEST_EFFECT_KEY"];
    delete worker["STRIPE_MANAGED_SANDBOX_EFFECT_KEY"];
    worker["STRIPE_PLATFORM_TEST_KEY"] = "sk_test_legacy_platform";
    worker["STRIPE_MANAGED_SANDBOX_KEY"] = "rk_test_legacy_sandbox";

    expect(loadWorkerConfig(worker).stripe.platformTestEffectKey).toBe("sk_test_legacy_platform");
    expect(() => loadWorkerConfig({ ...worker, NODE_ENV: "production" })).toThrow();
  });

  it("rejects unknown or live Stripe authority in every production boundary", () => {
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        NODE_ENV: "production",
        APP_BASE_URL: "https://sandbox.refunddesk.example",
        STRIPE_SECRET_KEY: "sk_live_forbidden",
      }),
    ).toThrow("LIVE_STRIPE_CREDENTIAL_FORBIDDEN");
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        NODE_ENV: "production",
        STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET: "disabled",
      }),
    ).toThrow("FOREIGN_RUNTIME_SECRET_FORBIDDEN");
    expect(() =>
      loadMigrationConfig({
        ...migrationEnvironment(),
        STRIPE_PLATFORM_TEST_KEY: "rk_test_foreign",
      }),
    ).toThrow("FOREIGN_RUNTIME_SECRET_FORBIDDEN");
    expect(() =>
      loadMigrationConfig({
        ...migrationEnvironment(),
        REFUNDDESK_PROOF_HMAC_KEY_V1: Buffer.alloc(32, 8).toString("base64"),
      }),
    ).toThrow("FOREIGN_RUNTIME_SECRET_FORBIDDEN");
  });

  it("requires explicit PostgreSQL principals for every scoped database URL", () => {
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        DATABASE_URL: "not-a-postgresql-url",
      }),
    ).toThrow();
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        PGBOSS_DATABASE_URL: "postgresql://localhost/refunddesk",
      }),
    ).toThrow();
    expect(() =>
      loadMigrationConfig({
        ...migrationEnvironment(),
        DATABASE_MIGRATION_URL: "postgresql://localhost/refunddesk",
      }),
    ).toThrow();
  });

  it("rejects PostgreSQL query parameters that can override connection authority", () => {
    for (const unsafeUrl of [
      "postgresql://runtime:local@localhost:5432/refunddesk?user=worker",
      "postgresql://runtime:local@localhost:5432/refunddesk?host=other.internal",
      "postgresql://runtime:local@localhost:5432/refunddesk?options=-c%20role%3Dworker",
      "postgresql://runtime:local@localhost:5432/refunddesk?dbname=other",
    ]) {
      expect(() =>
        loadPlatformConfig({
          ...platformEnvironment(),
          DATABASE_URL: unsafeUrl,
        }),
      ).toThrow();
    }
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        DATABASE_URL:
          "postgresql://runtime:local@localhost:5432/refunddesk?sslmode=require&connect_timeout=5",
      }),
    ).not.toThrow();
  });

  it("rejects libpq environment overrides in production runtimes and migrations", () => {
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        NODE_ENV: "production",
        APP_BASE_URL: "https://sandbox.refunddesk.example",
        PGOPTIONS: "-c search_path=shadow,public",
      }),
    ).toThrow("POSTGRES_ENVIRONMENT_OVERRIDE_FORBIDDEN");
    expect(() =>
      loadMigrationConfig({
        ...migrationEnvironment(),
        PGSERVICE: "foreign-service",
      }),
    ).toThrow("POSTGRES_ENVIRONMENT_OVERRIDE_FORBIDDEN");
  });

  it("preserves DB and application-key separation in combined non-production environments", () => {
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        ...workerEnvironment(),
        DATABASE_URL: "postgresql://shared:local@localhost:5432/refunddesk",
        WORKER_DATABASE_URL: "postgresql://shared:other@localhost:5432/refunddesk",
      }),
    ).toThrow("RUNTIME_DATABASE_PRINCIPALS_NOT_SEPARATED");
    const sharedKey = Buffer.alloc(32, 7).toString("base64");
    expect(() =>
      loadWorkerConfig({
        ...platformEnvironment(),
        ...workerEnvironment(),
        REFUNDDESK_FIELD_ENCRYPTION_KEY_V1: sharedKey,
        REFUNDDESK_PROOF_HMAC_KEY_V1: sharedKey,
      }),
    ).toThrow("APPLICATION_KEYS_NOT_SEPARATED");
  });

  it("requires an HTTPS origin for production links", () => {
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        APP_BASE_URL: "http://refunddesk.example",
      }),
    ).toThrow();
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        APP_BASE_URL: "http://127.0.0.1:3000",
        NODE_ENV: "production",
      }),
    ).toThrow();
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        APP_BASE_URL: "https://refunddesk.example/base",
      }),
    ).toThrow();
  });

  it("requires certificate-verifying PostgreSQL TLS for every non-loopback production URL", () => {
    for (const databaseUrl of [
      "postgresql://runtime:local@db.internal:5432/refunddesk",
      "postgresql://runtime:local@db.internal:5432/refunddesk?sslmode=disable",
      "postgresql://runtime:local@db.internal:5432/refunddesk?sslmode=require",
      "postgresql://runtime:local@db.internal:5432/refunddesk?sslmode=verify-full&sslmode=disable",
    ]) {
      expect(() =>
        loadPlatformConfig({
          ...platformEnvironment(),
          NODE_ENV: "production",
          APP_BASE_URL: "https://sandbox.refunddesk.example",
          DATABASE_URL: databaseUrl,
        }),
      ).toThrow();
    }
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        NODE_ENV: "production",
        APP_BASE_URL: "https://sandbox.refunddesk.example",
        DATABASE_URL: "postgresql://runtime:local@db.internal:5432/refunddesk?sslmode=verify-full",
      }),
    ).not.toThrow();
  });

  it("validates the worker health listener boundary", () => {
    expect(
      loadWorkerConfig({
        ...workerEnvironment(),
        WORKER_HEALTH_HOST: "0.0.0.0",
        WORKER_HEALTH_PORT: "8081",
      }).health,
    ).toEqual({ host: "0.0.0.0", port: 8081 });
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        WORKER_HEALTH_HOST: "public.example",
      }),
    ).toThrow();
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        WORKER_HEALTH_PORT: "0",
      }),
    ).toThrow();
  });

  it("validates the private signed-request verifier boundary", () => {
    expect(
      loadPlatformConfig({
        ...platformEnvironment(),
        REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL:
          "https://worker.example/internal/v1/signed-requests/verify",
      }).signedRequestVerifierUrl,
    ).toBe("https://worker.example/internal/v1/signed-requests/verify");
    for (const verifierUrl of [
      "http://worker.internal/internal/v1/signed-requests/verify",
      "https://user:password@worker.example/internal/v1/signed-requests/verify",
      "https://worker.example/internal/v1/signed-requests/verify?debug=true",
      "https://worker.example/ready",
    ]) {
      expect(() =>
        loadPlatformConfig({
          ...platformEnvironment(),
          REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL: verifierUrl,
        }),
      ).toThrow();
    }
    const localPlatform = platformEnvironment();
    delete localPlatform["REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL"];
    expect(loadPlatformConfig(localPlatform).signedRequestVerifierUrl).toBe(
      "http://127.0.0.1:3101/internal/v1/signed-requests/verify",
    );
    expect(() =>
      loadPlatformConfig({
        ...localPlatform,
        NODE_ENV: "production",
        APP_BASE_URL: "https://sandbox.refunddesk.example",
      }),
    ).toThrow();
  });

  it("validates cross-runtime authority separation in a one-shot release preflight", () => {
    const platform = loadPlatformConfig({
      ...platformEnvironment(),
      NODE_ENV: "production",
      APP_BASE_URL: "https://sandbox.refunddesk.example",
    });
    const worker = loadWorkerConfig({
      ...workerEnvironment(),
      NODE_ENV: "production",
    });
    const migration = loadMigrationConfig(migrationEnvironment());

    expect(() => assertReleaseConfigSeparation({ platform, worker, migration })).not.toThrow();
    expect(() =>
      assertReleaseConfigSeparation({
        platform,
        worker: {
          ...worker,
          stripe: {
            ...worker.stripe,
            platformTestEffectKey: platform.stripe.platformTestReadKey,
          },
        },
        migration,
      }),
    ).toThrow("STRIPE_RUNTIME_CREDENTIALS_NOT_SEPARATED");
    expect(() =>
      assertReleaseConfigSeparation({
        platform,
        worker: {
          ...worker,
          keys: { ...worker.keys, proofV1: platform.keys.fieldV1 },
        },
        migration,
      }),
    ).toThrow("APPLICATION_KEYS_NOT_SEPARATED");
    expect(() =>
      assertReleaseConfigSeparation({
        platform,
        worker: {
          ...worker,
          signedRequestVerifierToken: Buffer.alloc(32, 7).toString("base64"),
        },
        migration,
      }),
    ).toThrow("SIGNED_REQUEST_VERIFIER_TOKEN_MISMATCH");
    expect(() =>
      assertReleaseConfigSeparation({
        platform,
        worker: {
          ...worker,
          stripe: {
            ...worker.stripe,
            platformTestAccountId: "acct_WrongPlatform789",
          },
        },
        migration,
      }),
    ).toThrow("STRIPE_ACCOUNT_BINDING_MISMATCH");
    expect(() =>
      assertReleaseConfigSeparation({
        platform,
        worker: {
          ...worker,
          workerDatabaseUrl: "postgresql://runtime:other@db.internal:5432/refunddesk",
        },
        migration,
      }),
    ).toThrow("RUNTIME_DATABASE_PRINCIPALS_NOT_SEPARATED");
    expect(() =>
      assertReleaseConfigSeparation({
        platform,
        worker,
        migration: {
          ...migration,
          workerDatabaseUrl: "postgresql://worker:rotated@localhost:5432/refunddesk",
        },
      }),
    ).toThrow("MIGRATION_RUNTIME_DATABASE_URLS_DIVERGE");
  });
});
