import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/index.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://runtime:local@localhost:5432/refunddesk",
    WORKER_DATABASE_URL: "postgresql://worker:local@localhost:5432/refunddesk",
    PGBOSS_DATABASE_URL: "postgresql://worker:local@localhost:5432/refunddesk",
    STRIPE_API_VERSION: "2026-06-24.dahlia",
    STRIPE_APP_SIGNING_SECRET: "absec_synthetic",
    STRIPE_PLATFORM_TEST_KEY: "sk_test_synthetic",
    STRIPE_MANAGED_SANDBOX_KEY: "rk_test_synthetic",
    STRIPE_CONNECTED_TEST_WEBHOOK_SECRET: "whsec_synthetic_test",
    STRIPE_CONNECTED_SANDBOX_WEBHOOK_SECRET: "whsec_synthetic_sandbox",
    STRIPE_CONNECTED_LIVE_WEBHOOK_SECRET: "disabled",
    REFUNDDESK_GLOBAL_LIVE_ENABLED: "false",
    REFUNDDESK_FIELD_ENCRYPTION_KEY_V1: Buffer.alloc(32, 1).toString("base64"),
    REFUNDDESK_PROOF_HMAC_KEY_V1: Buffer.alloc(32, 2).toString("base64"),
    REFUNDDESK_EXPORT_SIGNING_KEY_V1: Buffer.alloc(32, 4).toString("base64"),
    REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: "v1",
    REFUNDDESK_ACTIVE_PROOF_KEY_VERSION: "v1",
  };
}

describe("loadConfig", () => {
  it("keeps live execution structurally disabled for the pilot", () => {
    expect(loadConfig(validEnvironment()).liveEnabled).toBe(false);
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        REFUNDDESK_GLOBAL_LIVE_ENABLED: "true",
      }),
    ).toThrow();
  });

  it("rejects placeholders instead of starting with unusable credentials", () => {
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        STRIPE_PLATFORM_TEST_KEY: "replace_me",
      }),
    ).toThrow();
  });

  it("requires independent encryption and proof keys", () => {
    const sharedKey = Buffer.alloc(32, 3).toString("base64");
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        REFUNDDESK_FIELD_ENCRYPTION_KEY_V1: sharedKey,
        REFUNDDESK_PROOF_HMAC_KEY_V1: sharedKey,
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        REFUNDDESK_EXPORT_SIGNING_KEY_V1: sharedKey,
        REFUNDDESK_PROOF_HMAC_KEY_V1: sharedKey,
      }),
    ).toThrow();
  });

  it("requires canonical base64 for application keys", () => {
    const canonical = Buffer.alloc(32, 5).toString("base64");
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        REFUNDDESK_FIELD_ENCRYPTION_KEY_V1: ` ${canonical}`,
      }),
    ).toThrow();
  });

  it("requires separate test-mode and sandbox credentials", () => {
    const environment = validEnvironment();
    expect(() =>
      loadConfig({
        ...environment,
        STRIPE_MANAGED_SANDBOX_KEY: environment.STRIPE_PLATFORM_TEST_KEY,
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...environment,
        STRIPE_CONNECTED_SANDBOX_WEBHOOK_SECRET: environment.STRIPE_CONNECTED_TEST_WEBHOOK_SECRET,
      }),
    ).toThrow();
  });

  it("requires distinct web, worker, and migration database credentials", () => {
    const environment = validEnvironment();
    expect(() =>
      loadConfig({
        ...environment,
        WORKER_DATABASE_URL: environment.DATABASE_URL,
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...environment,
        DATABASE_MIGRATION_URL: "postgresql://runtime:different-password@localhost:5432/refunddesk",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...environment,
        WORKER_DATABASE_URL: "postgresql://runtime:different-password@localhost:5432/refunddesk",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...environment,
        DATABASE_URL: "not-a-postgresql-url",
      }),
    ).toThrow();
  });

  it("allows the technical probe only outside production with an explicit PaymentIntent allowlist", () => {
    expect(
      loadConfig({
        ...validEnvironment(),
        REFUNDDESK_PHASE0_PROBE_ENABLED: "true",
        STRIPE_PHASE0_ALLOWED_PAYMENT_INTENTS: "pi_synthetic",
      }).phase0ProbeEnabled,
    ).toBe(true);
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        REFUNDDESK_PHASE0_PROBE_ENABLED: "true",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        REFUNDDESK_PHASE0_PROBE_ENABLED: "true",
        STRIPE_PHASE0_ALLOWED_PAYMENT_INTENTS: "ch_not_a_payment_intent",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        APP_BASE_URL: "https://refunddesk.example",
        NODE_ENV: "production",
        REFUNDDESK_PHASE0_PROBE_ENABLED: "true",
        STRIPE_PHASE0_ALLOWED_PAYMENT_INTENTS: "pi_synthetic",
      }),
    ).toThrow();
  });

  it("requires an HTTPS origin for production links", () => {
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        APP_BASE_URL: "http://refunddesk.example",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        APP_BASE_URL: "http://refunddesk.example",
        NODE_ENV: "production",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment(),
        APP_BASE_URL: "https://refunddesk.example/base",
      }),
    ).toThrow();
  });
});
