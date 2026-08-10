import { afterEach, describe, expect, it } from "vitest";

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkReleaseConfiguration } from "../src/check-release.js";

const temporaryDirectories: string[] = [];
const syntheticEdgeOriginToken = randomBytes(32).toString("base64url");

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
  readonly caddyEnvironment?: NodeJS.ProcessEnv;
  readonly caddyFile?: string;
  readonly maintenanceEnvironment?: NodeJS.ProcessEnv;
  readonly maintenanceFile?: string;
  readonly migrationEnvironment?: NodeJS.ProcessEnv;
  readonly platformEnvironment?: NodeJS.ProcessEnv;
  readonly publicHost?: string;
  readonly publicOriginFile?: string;
  readonly workerEnvironment?: NodeJS.ProcessEnv;
}

async function createReleaseFiles(overrides: ReleaseFileOverrides = {}): Promise<{
  readonly directory: string;
  readonly legacyPaths: readonly string[];
  readonly hostedPaths: readonly string[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "refunddesk-release-config-"));
  temporaryDirectories.push(directory);
  const appBaseUrl = overrides.appBaseUrl ?? "https://d2xv7szimbgban.cloudfront.net";
  const publicHost = overrides.publicHost ?? "origin.refunddesk.example";
  const publicOriginFile = overrides.publicOriginFile ?? `${appBaseUrl}\n`;
  const platformPath = "platform.env";
  const workerPath = "worker.env";
  const migrationPath = "migration.env";
  const maintenancePath = "maintenance.env";
  const caddyPath = "caddy.env";
  const publicOriginPath = "public-origin";

  await Promise.all([
    writeFile(
      join(directory, platformPath),
      serializeEnvironment({
        ...platformEnvironment(appBaseUrl),
        ...overrides.platformEnvironment,
      }),
    ),
    writeFile(
      join(directory, workerPath),
      serializeEnvironment({
        ...workerEnvironment(),
        ...overrides.workerEnvironment,
      }),
    ),
    writeFile(
      join(directory, migrationPath),
      serializeEnvironment({
        ...migrationEnvironment(),
        ...overrides.migrationEnvironment,
      }),
    ),
    writeFile(
      join(directory, maintenancePath),
      overrides.maintenanceFile ??
        serializeEnvironment({
          NODE_ENV: "production",
          REFUNDDESK_MAINTENANCE_DATABASE_URL:
            "postgresql://refunddesk_maintenance_login:maintenance@postgres.refunddesk.internal:5432/refunddesk?sslmode=verify-full",
          REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1: Buffer.alloc(32, 9).toString("base64"),
          REFUNDDESK_RETENTION_BATCH_SIZE: "25",
          REFUNDDESK_RETENTION_SCOPE: "test_sandbox",
          ...overrides.maintenanceEnvironment,
        }),
    ),
    writeFile(
      join(directory, caddyPath),
      overrides.caddyFile ??
        serializeEnvironment({
          REFUNDDESK_PUBLIC_HOST: publicHost,
          REFUNDDESK_ACME_EMAIL: "operator@example.invalid",
          REFUNDDESK_EDGE_ORIGIN_TOKEN: syntheticEdgeOriginToken,
          ...overrides.caddyEnvironment,
        }),
    ),
    writeFile(join(directory, publicOriginPath), publicOriginFile),
  ]);

  return {
    directory,
    legacyPaths: [platformPath, workerPath, migrationPath],
    hostedPaths: [
      platformPath,
      workerPath,
      migrationPath,
      maintenancePath,
      caddyPath,
      publicOriginPath,
    ],
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

    await expect(checkReleaseConfiguration(files.legacyPaths, files.directory)).resolves.toEqual({
      keyRotation: {
        approvalAttestation: "legacy",
        field: "legacy",
        proof: "legacy",
      },
    });
  });

  it("reserves incident-admission mode for the isolated promotion runner", async () => {
    const files = await createReleaseFiles({
      workerEnvironment: { REFUNDDESK_WORKER_RUNTIME_MODE: "incident_admission" },
    });

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).rejects.toThrow(
      "STANDARD_RELEASE_WORKER_RUNTIME_MODE_REQUIRED",
    );
  });

  it("accepts a canonical viewer origin distinct from the Caddy origin host", async () => {
    const files = await createReleaseFiles();

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).resolves.toEqual({
      keyRotation: {
        approvalAttestation: "legacy",
        field: "legacy",
        proof: "legacy",
      },
    });
  });

  it.each([
    ["missing", undefined],
    ["too short", "A".repeat(42)],
    ["padded", `${syntheticEdgeOriginToken}=`],
    ["outside base64url", `${syntheticEdgeOriginToken.slice(0, -1)}+`],
    ["non-canonical trailing bits", `${syntheticEdgeOriginToken.slice(0, -1)}z`],
  ])("rejects a %s edge-origin token without exposing it", async (_name, token) => {
    const caddyEnvironment: NodeJS.ProcessEnv = {
      REFUNDDESK_PUBLIC_HOST: "origin.refunddesk.example",
      REFUNDDESK_ACME_EMAIL: "operator@example.invalid",
      ...(token === undefined ? {} : { REFUNDDESK_EDGE_ORIGIN_TOKEN: token }),
    };
    const files = await createReleaseFiles({
      caddyFile: serializeEnvironment(caddyEnvironment),
    });

    let error: unknown;
    try {
      await checkReleaseConfiguration(files.hostedPaths, files.directory);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("HOSTED_CADDY_CONFIGURATION_INVALID");
    if (token !== undefined) {
      expect((error as Error).message).not.toContain(token);
    }
  });

  it("rejects an unexpected Caddy binding", async () => {
    const files = await createReleaseFiles({
      caddyEnvironment: { REFUNDDESK_UNREVIEWED_EDGE_BYPASS: "enabled" },
    });

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).rejects.toThrow(
      "HOSTED_CADDY_CONFIGURATION_INVALID",
    );
  });

  it("rejects the public non-secret CI edge-origin token", async () => {
    const files = await createReleaseFiles({
      caddyEnvironment: {
        REFUNDDESK_EDGE_ORIGIN_TOKEN: "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
      },
    });

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).rejects.toThrow(
      "HOSTED_CADDY_CONFIGURATION_INVALID",
    );
  });

  it.each([
    ["comment", "# copied operator note\n"],
    ["blank line", "\n"],
    ["duplicate", `REFUNDDESK_EDGE_ORIGIN_TOKEN=${syntheticEdgeOriginToken}\n`],
  ])("rejects a Caddy environment containing a %s", async (_name, extraLine) => {
    const valid = serializeEnvironment({
      REFUNDDESK_PUBLIC_HOST: "origin.refunddesk.example",
      REFUNDDESK_ACME_EMAIL: "operator@example.invalid",
      REFUNDDESK_EDGE_ORIGIN_TOKEN: syntheticEdgeOriginToken,
    });
    const files = await createReleaseFiles({ caddyFile: `${valid}${extraLine}` });

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).rejects.toThrow(
      "HOSTED_CADDY_CONFIGURATION_INVALID",
    );
  });

  it("rejects CRLF in the Caddy environment before release mutation", async () => {
    const caddyFile = serializeEnvironment({
      REFUNDDESK_PUBLIC_HOST: "origin.refunddesk.example",
      REFUNDDESK_ACME_EMAIL: "operator@example.invalid",
      REFUNDDESK_EDGE_ORIGIN_TOKEN: syntheticEdgeOriginToken,
    }).replaceAll("\n", "\r\n");
    const files = await createReleaseFiles({ caddyFile });

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).rejects.toThrow(
      "HOSTED_CADDY_CONFIGURATION_INVALID",
    );
  });

  it("returns only non-secret active V2 lifecycle metadata for the release guard", async () => {
    const files = await createReleaseFiles({
      platformEnvironment: {
        REFUNDDESK_FIELD_ENCRYPTION_KEY_V2: Buffer.alloc(32, 6).toString("base64"),
        REFUNDDESK_ACTIVE_FIELD_KEY_VERSION: "v2",
        REFUNDDESK_FIELD_KEY_ROTATION_STATE: "active",
      },
      workerEnvironment: {
        REFUNDDESK_PROOF_HMAC_KEY_V2: Buffer.alloc(32, 7).toString("base64"),
        REFUNDDESK_ACTIVE_PROOF_KEY_VERSION: "v2",
        REFUNDDESK_PROOF_KEY_ROTATION_STATE: "active",
        REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2: Buffer.alloc(32, 8).toString("base64"),
        REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION: "v2",
        REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE: "active",
      },
    });

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).resolves.toEqual({
      keyRotation: {
        approvalAttestation: "active",
        field: "active",
        proof: "active",
      },
    });
  });

  it.each([
    {
      name: "the field encryption key",
      key: Buffer.alloc(32, 1).toString("base64"),
    },
    {
      name: "the proof key",
      key: Buffer.alloc(32, 2).toString("base64"),
    },
    {
      name: "the approval-attestation key",
      key: Buffer.alloc(32, 3).toString("base64"),
    },
    {
      name: "the export key",
      key: Buffer.alloc(32, 4).toString("base64"),
    },
    {
      name: "the private verifier token",
      key: Buffer.alloc(32, 5).toString("base64"),
    },
  ])("rejects a purge pseudonym key reused as $name", async ({ key }) => {
    const files = await createReleaseFiles({
      maintenanceEnvironment: {
        REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1: key,
      },
    });

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).rejects.toThrow(
      "MAINTENANCE_PSEUDONYM_KEY_NOT_SEPARATED",
    );
  });

  it("rejects a maintenance login reused by another release authority", async () => {
    const reusedUrl =
      "postgresql://refunddesk_maintenance_login:maintenance@postgres.refunddesk.internal:5432/refunddesk?sslmode=verify-full";
    const files = await createReleaseFiles({
      platformEnvironment: {
        DATABASE_URL: reusedUrl,
      },
      migrationEnvironment: {
        DATABASE_URL: reusedUrl,
      },
    });

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).rejects.toThrow(
      "MAINTENANCE_DATABASE_PRINCIPAL_NOT_SEPARATED",
    );
  });

  it("rejects duplicate maintenance variables before release", async () => {
    const files = await createReleaseFiles({
      maintenanceFile: `${serializeEnvironment({
        NODE_ENV: "production",
        REFUNDDESK_MAINTENANCE_DATABASE_URL:
          "postgresql://refunddesk_maintenance_login:maintenance@postgres.refunddesk.internal:5432/refunddesk?sslmode=verify-full",
        REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1: Buffer.alloc(32, 9).toString("base64"),
        REFUNDDESK_RETENTION_BATCH_SIZE: "25",
        REFUNDDESK_RETENTION_SCOPE: "test_sandbox",
      })}REFUNDDESK_RETENTION_SCOPE=test_sandbox\n`,
    });

    await expect(checkReleaseConfiguration(files.hostedPaths, files.directory)).rejects.toThrow(
      "MAINTENANCE_CONFIGURATION_INVALID",
    );
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
      name: "the Caddy host contains a scheme",
      overrides: {
        publicHost: "https://origin.refunddesk.example",
      },
    },
    {
      name: "the Caddy host tries to claim a CloudFront certificate",
      overrides: {
        publicHost: "d2xv7szimbgban.cloudfront.net",
      },
    },
    {
      name: "the viewer is not the deployed CloudFront distribution",
      overrides: {
        appBaseUrl: "https://different.cloudfront.net",
        publicOriginFile: "https://different.cloudfront.net\n",
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

  it("accepts exactly three or six inputs and keeps errors value-free", async () => {
    const files = await createReleaseFiles({
      publicHost: "sensitive-host.example/path",
    });

    for (const paths of [
      files.legacyPaths.slice(0, 2),
      [...files.legacyPaths, "unexpected-fourth"],
      [...files.hostedPaths, "unexpected-seventh"],
    ]) {
      await expect(checkReleaseConfiguration(paths, files.directory)).rejects.toThrow(
        "THREE_OR_SIX_RELEASE_INPUTS_REQUIRED",
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
