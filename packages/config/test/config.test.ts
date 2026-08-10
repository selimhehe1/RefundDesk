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
    expect(config.runtimeMode).toBe("normal");
    expect(config).not.toHaveProperty("databaseUrl");
    expect(config.stripe).not.toHaveProperty("accountTestWebhookSecret");
    expect(config.keys).not.toHaveProperty("fieldV1");
    expect(config.keys).not.toHaveProperty("exportV1");
  });

  it("accepts only the explicit bounded incident-admission worker runtime mode", () => {
    expect(
      loadWorkerConfig({
        ...workerEnvironment(),
        REFUNDDESK_WORKER_RUNTIME_MODE: "incident_admission",
      }).runtimeMode,
    ).toBe("incident_admission");
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        REFUNDDESK_WORKER_RUNTIME_MODE: "incident-admission",
      }),
    ).toThrow();
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
      loadPlatformConfig({
        ...platformEnvironment(),
        NODE_ENV: "production",
        APP_BASE_URL: "https://sandbox.refunddesk.example",
        REFUNDDESK_PROOF_HMAC_KEY_V2: Buffer.alloc(32, 9).toString("base64"),
      }),
    ).toThrow("FOREIGN_RUNTIME_SECRET_FORBIDDEN");
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        NODE_ENV: "production",
        REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: Buffer.alloc(32, 9).toString("base64"),
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

  it("allows distinct V2 application keys to be staged while V1 remains active", () => {
    const platform = loadPlatformConfig({
      ...platformEnvironment(),
      REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: Buffer.alloc(32, 6).toString("base64"),
      REFUNDDESK_FIELD_KEY_ROTATION_STATE: "staged",
    });
    const worker = loadWorkerConfig({
      ...workerEnvironment(),
      REFUNDDESK_PROOF_HMAC_KEY_V2: Buffer.alloc(32, 7).toString("base64"),
      REFUNDDESK_PROOF_KEY_ROTATION_STATE: "staged",
      REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2: Buffer.alloc(32, 8).toString("base64"),
      REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE: "staged",
    });

    expect(platform.keys.activeFieldVersion).toBe("v1");
    expect(platform.keys.fieldV2).toEqual(Buffer.alloc(32, 6));
    expect(worker.keys.activeProofVersion).toBe("v1");
    expect(worker.keys.proofV2).toEqual(Buffer.alloc(32, 7));
    expect(worker.keys.activeApprovalAttestationVersion).toBe("v1");
    expect(worker.keys.approvalAttestationV2).toEqual(Buffer.alloc(32, 8));
  });

  it("requires each V2 key before its selector can activate V2", () => {
    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: "v2",
        REFUNDDESK_FIELD_KEY_ROTATION_STATE: "active",
      }),
    ).toThrow();
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        REFUNDDESK_ACTIVE_PROOF_KEY_VERSION: "v2",
        REFUNDDESK_PROOF_KEY_ROTATION_STATE: "active",
      }),
    ).toThrow();
    expect(() =>
      loadWorkerConfig({
        ...workerEnvironment(),
        REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION: "v2",
        REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE: "active",
      }),
    ).toThrow();
  });

  it("loads active V2 keys while retaining every required V1 key", () => {
    const platform = loadPlatformConfig({
      ...platformEnvironment(),
      NODE_ENV: "production",
      APP_BASE_URL: "https://sandbox.refunddesk.example",
      REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: Buffer.alloc(32, 6).toString("base64"),
      REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: "v2",
      REFUNDDESK_FIELD_KEY_ROTATION_STATE: "active",
    });
    const worker = loadWorkerConfig({
      ...workerEnvironment(),
      NODE_ENV: "production",
      REFUNDDESK_PROOF_HMAC_KEY_V2: Buffer.alloc(32, 7).toString("base64"),
      REFUNDDESK_ACTIVE_PROOF_KEY_VERSION: "v2",
      REFUNDDESK_PROOF_KEY_ROTATION_STATE: "active",
      REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2: Buffer.alloc(32, 8).toString("base64"),
      REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION: "v2",
      REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE: "active",
    });

    expect(platform.keys).toMatchObject({
      activeFieldVersion: "v2",
      fieldRotationState: "active",
      fieldV1: Buffer.alloc(32, 1),
      fieldV2: Buffer.alloc(32, 6),
    });
    expect(worker.keys).toMatchObject({
      activeProofVersion: "v2",
      proofRotationState: "active",
      proofV1: Buffer.alloc(32, 2),
      proofV2: Buffer.alloc(32, 7),
      activeApprovalAttestationVersion: "v2",
      approvalAttestationRotationState: "active",
      approvalAttestationV1: Buffer.alloc(32, 3),
      approvalAttestationV2: Buffer.alloc(32, 8),
    });
  });

  it("loads a retired V1 state only when V1 is absent and V2 is active", () => {
    const platformEnvironmentWithoutV1 = { ...platformEnvironment() };
    delete platformEnvironmentWithoutV1["REFUNDDESK_FIELD_ENCRYPTION_KEY_V1"];
    const workerEnvironmentWithoutV1 = { ...workerEnvironment() };
    delete workerEnvironmentWithoutV1["REFUNDDESK_PROOF_HMAC_KEY_V1"];
    delete workerEnvironmentWithoutV1["REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1"];

    const platform = loadPlatformConfig({
      ...platformEnvironmentWithoutV1,
      REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: Buffer.alloc(32, 6).toString("base64"),
      REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: "v2",
      REFUNDDESK_FIELD_KEY_ROTATION_STATE: "retired",
    });
    const worker = loadWorkerConfig({
      ...workerEnvironmentWithoutV1,
      REFUNDDESK_PROOF_HMAC_KEY_V2: Buffer.alloc(32, 7).toString("base64"),
      REFUNDDESK_ACTIVE_PROOF_KEY_VERSION: "v2",
      REFUNDDESK_PROOF_KEY_ROTATION_STATE: "retired",
      REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2: Buffer.alloc(32, 8).toString("base64"),
      REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION: "v2",
      REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE: "retired",
    });

    expect(platform.keys.fieldRotationState).toBe("retired");
    expect(platform.keys).not.toHaveProperty("fieldV1");
    expect(worker.keys.proofRotationState).toBe("retired");
    expect(worker.keys).not.toHaveProperty("proofV1");
    expect(worker.keys.approvalAttestationRotationState).toBe("retired");
    expect(worker.keys).not.toHaveProperty("approvalAttestationV1");
    expect(() =>
      assertReleaseConfigSeparation({
        migration: loadMigrationConfig(migrationEnvironment()),
        platform,
        worker,
      }),
    ).not.toThrow();

    expect(() =>
      loadPlatformConfig({
        ...platformEnvironment(),
        REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: Buffer.alloc(32, 6).toString("base64"),
        REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: "v2",
        REFUNDDESK_FIELD_KEY_ROTATION_STATE: "retired",
      }),
    ).toThrow();
  });

  it("rejects duplicated application keys within and across V1/V2 families", () => {
    const platform = platformEnvironment();
    expect(() =>
      loadPlatformConfig({
        ...platform,
        REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: platform["REFUNDDESK_FIELD_ENCRYPTION_KEY_V1"],
        REFUNDDESK_FIELD_KEY_ROTATION_STATE: "staged",
      }),
    ).toThrow();

    const worker = workerEnvironment();
    expect(() =>
      loadWorkerConfig({
        ...worker,
        REFUNDDESK_PROOF_HMAC_KEY_V2: worker["REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1"],
        REFUNDDESK_PROOF_KEY_ROTATION_STATE: "staged",
      }),
    ).toThrow();

    const sharedAcrossRuntimes = Buffer.alloc(32, 9).toString("base64");
    expect(() =>
      loadWorkerConfig({
        ...platform,
        ...worker,
        REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: sharedAcrossRuntimes,
        REFUNDDESK_FIELD_KEY_ROTATION_STATE: "staged",
        REFUNDDESK_PROOF_HMAC_KEY_V2: sharedAcrossRuntimes,
        REFUNDDESK_PROOF_KEY_ROTATION_STATE: "staged",
      }),
    ).toThrow("APPLICATION_KEYS_NOT_SEPARATED");
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

    // A previous webhook secret is only meaningful while it differs from every other secret
    // in play: equal to its own current one the roll is a no-op that reads as if it happened,
    // and shared across endpoints an event delivered for one environment verifies on the other.
    expect(() =>
      loadPlatformConfig({
        ...platform,
        STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS: platform.STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET,
      }),
    ).toThrow();
    expect(() =>
      loadPlatformConfig({
        ...platform,
        STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS: platform.STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET,
      }),
    ).toThrow();
    expect(() =>
      loadPlatformConfig({
        ...platform,
        STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS: "whsec_rolled_shared",
        STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET_PREVIOUS: "whsec_rolled_shared",
      }),
    ).toThrow();

    const rolling = loadPlatformConfig({
      ...platform,
      STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS: "whsec_synthetic_test_previous",
    });
    expect(rolling.stripe.accountTestWebhookSecretPrevious).toBe("whsec_synthetic_test_previous");
    expect(rolling.stripe).not.toHaveProperty("accountSandboxWebhookSecretPrevious");
    expect(loadPlatformConfig(platform).stripe).not.toHaveProperty(
      "accountTestWebhookSecretPrevious",
    );

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

    // A previous App signing secret equal to its own current one makes a roll a no-op that
    // reads as if it had happened.
    expect(() =>
      loadWorkerConfig({
        ...worker,
        STRIPE_APP_SIGNING_SECRET_PREVIOUS: worker.STRIPE_APP_SIGNING_SECRET,
      }),
    ).toThrow();

    const rollingWorker = loadWorkerConfig({
      ...worker,
      STRIPE_APP_SIGNING_SECRET_PREVIOUS: "absec_synthetic_previous",
    });
    expect(rollingWorker.stripe.appSigningSecretPrevious).toBe("absec_synthetic_previous");
    expect(loadWorkerConfig(worker).stripe).not.toHaveProperty("appSigningSecretPrevious");
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

    const platformV2 = loadPlatformConfig({
      ...platformEnvironment(),
      NODE_ENV: "production",
      APP_BASE_URL: "https://sandbox.refunddesk.example",
      REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: Buffer.alloc(32, 6).toString("base64"),
      REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: "v2",
      REFUNDDESK_FIELD_KEY_ROTATION_STATE: "active",
    });
    const workerV2 = loadWorkerConfig({
      ...workerEnvironment(),
      NODE_ENV: "production",
      REFUNDDESK_PROOF_HMAC_KEY_V2: Buffer.alloc(32, 7).toString("base64"),
      REFUNDDESK_ACTIVE_PROOF_KEY_VERSION: "v2",
      REFUNDDESK_PROOF_KEY_ROTATION_STATE: "active",
      REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2: Buffer.alloc(32, 8).toString("base64"),
      REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION: "v2",
      REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE: "active",
    });
    expect(() =>
      assertReleaseConfigSeparation({ platform: platformV2, worker: workerV2, migration }),
    ).not.toThrow();
    expect(() =>
      assertReleaseConfigSeparation({
        platform: platformV2,
        worker: {
          ...workerV2,
          keys: {
            ...workerV2.keys,
            proofV2: platformV2.keys.fieldV2,
          },
        },
        migration,
      }),
    ).toThrow("APPLICATION_KEYS_NOT_SEPARATED");
    expect(() =>
      assertReleaseConfigSeparation({
        platform: {
          ...platformV2,
          keys: {
            activeFieldVersion: "v2",
            fieldRotationState: "active",
            fieldV1: platformV2.keys.fieldV1,
            exportV1: platformV2.keys.exportV1,
          },
        },
        worker: workerV2,
        migration,
      }),
    ).toThrow("APPLICATION_KEY_ROTATION_STATE_INVALID");
  });
});
