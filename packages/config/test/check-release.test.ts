import { afterEach, describe, expect, it } from "vitest";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkReleaseConfiguration } from "../src/check-release.js";

const temporaryDirectories: string[] = [];

function serializeEnvironment(environment: NodeJS.ProcessEnv): string {
  return `${Object.entries(environment)
    .map(([name, value]) => {
      if (value === undefined) {
        throw new Error("TEST_ENVIRONMENT_VALUE_UNDEFINED");
      }
      return `${name}=${value}`;
    })
    .join("\n")}\n`;
}

function platformEnvironment(appBaseUrl: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    APP_BASE_URL: appBaseUrl,
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
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
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

interface ReleaseFileOverrides {
  readonly appBaseUrl?: string;
  readonly publicHost?: string;
  readonly publicOriginFile?: string;
}

async function createReleaseFiles(overrides: ReleaseFileOverrides = {}): Promise<{
  readonly directory: string;
  readonly legacyPaths: readonly string[];
  readonly hostedPaths: readonly string[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "refunddesk-release-config-"));
  temporaryDirectories.push(directory);
  const appBaseUrl = overrides.appBaseUrl ?? "https://sandbox.refunddesk.example";
  const publicHost = overrides.publicHost ?? "sandbox.refunddesk.example";
  const publicOriginFile = overrides.publicOriginFile ?? `${appBaseUrl}\n`;
  const platformPath = "platform.env";
  const workerPath = "worker.env";
  const migrationPath = "migration.env";
  const caddyPath = "caddy.env";
  const publicOriginPath = "public-origin";

  await Promise.all([
    writeFile(join(directory, platformPath), serializeEnvironment(platformEnvironment(appBaseUrl))),
    writeFile(join(directory, workerPath), serializeEnvironment(workerEnvironment())),
    writeFile(join(directory, migrationPath), serializeEnvironment(migrationEnvironment())),
    writeFile(
      join(directory, caddyPath),
      serializeEnvironment({
        REFUNDDESK_PUBLIC_HOST: publicHost,
        REFUNDDESK_ACME_EMAIL: "operator@example.invalid",
      }),
    ),
    writeFile(join(directory, publicOriginPath), publicOriginFile),
  ]);

  return {
    directory,
    legacyPaths: [platformPath, workerPath, migrationPath],
    hostedPaths: [platformPath, workerPath, migrationPath, caddyPath, publicOriginPath],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("release configuration file check", () => {
  it("keeps the historical three-file mode compatible", async () => {
    const files = await createReleaseFiles({
      appBaseUrl: "https://legacy.refunddesk.example",
      publicHost: "intentionally-unrelated.example",
      publicOriginFile: "not-an-origin\n",
    });

    await expect(
      checkReleaseConfiguration(files.legacyPaths, files.directory),
    ).resolves.toBeUndefined();
  });

  it("accepts a canonical hosted origin matching the platform and Caddy host", async () => {
    const files = await createReleaseFiles();

    await expect(
      checkReleaseConfiguration(files.hostedPaths, files.directory),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      name: "the platform URL differs",
      overrides: {
        appBaseUrl: "https://other.refunddesk.example",
        publicHost: "sandbox.refunddesk.example",
        publicOriginFile: "https://sandbox.refunddesk.example\n",
      },
    },
    {
      name: "the Caddy host differs",
      overrides: {
        publicHost: "other.refunddesk.example",
      },
    },
    {
      name: "the origin uses HTTP",
      overrides: {
        appBaseUrl: "https://sandbox.refunddesk.example",
        publicOriginFile: "http://sandbox.refunddesk.example\n",
      },
    },
    {
      name: "the origin has a path",
      overrides: {
        publicOriginFile: "https://sandbox.refunddesk.example/base\n",
      },
    },
    {
      name: "the origin exposes a nonstandard port",
      overrides: {
        appBaseUrl: "https://sandbox.refunddesk.example:8443",
        publicOriginFile: "https://sandbox.refunddesk.example:8443\n",
      },
    },
    {
      name: "the origin is not in canonical default-port form",
      overrides: {
        appBaseUrl: "https://sandbox.refunddesk.example:443",
        publicOriginFile: "https://sandbox.refunddesk.example:443\n",
      },
    },
    {
      name: "the origin file contains another line",
      overrides: {
        publicOriginFile: "https://sandbox.refunddesk.example\nsensitive.example\n",
      },
    },
  ])("fails closed when $name", async ({ overrides }) => {
    const files = await createReleaseFiles(overrides);

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).rejects.toThrow(
      "HOSTED_PUBLIC_ORIGIN_INVALID",
    );
  });

  it("accepts exactly three or five inputs and keeps errors value-free", async () => {
    const files = await createReleaseFiles({
      publicHost: "sensitive-host.example",
    });

    for (const paths of [
      files.legacyPaths.slice(0, 2),
      [...files.legacyPaths, "unexpected-fourth"],
      [...files.hostedPaths, "unexpected-sixth"],
    ]) {
      await expect(checkReleaseConfiguration(paths, files.directory)).rejects.toThrow(
        "THREE_OR_FIVE_RELEASE_INPUTS_REQUIRED",
      );
    }

    let error: unknown;
    try {
      await checkReleaseConfiguration(files.hostedPaths, files.directory);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("HOSTED_PUBLIC_ORIGIN_INVALID");
    expect((error as Error).message).not.toContain("sensitive-host.example");
  });
});
