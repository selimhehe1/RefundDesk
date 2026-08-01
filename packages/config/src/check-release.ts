import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import {
  assertReleaseConfigSeparation,
  loadMigrationConfig,
  loadPlatformConfig,
  loadWorkerConfig,
} from "./index.js";
import type { ApplicationKeyRotationSet } from "./key-rotation.js";

export interface ReleaseConfigurationSummary {
  readonly keyRotation: ApplicationKeyRotationSet;
}

interface MaintenanceReleaseConfiguration {
  readonly databasePrincipal: string;
  readonly pseudonymKey: Buffer;
}

const HOSTED_PUBLIC_VIEWER_HOST = "d2xv7szimbgban.cloudfront.net";
const HOSTED_CADDY_ENVIRONMENT_NAMES = new Set([
  "REFUNDDESK_ACME_EMAIL",
  "REFUNDDESK_EDGE_ORIGIN_TOKEN",
  "REFUNDDESK_PUBLIC_HOST",
]);
const KNOWN_NON_SECRET_EDGE_ORIGIN_TOKENS = new Set([
  "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
]);

function resolveInputPath(path: string, invocationDirectory: string): string {
  return isAbsolute(path) ? path : resolve(invocationDirectory, path);
}

async function loadEnvironment(
  path: string,
  invocationDirectory: string,
): Promise<NodeJS.ProcessEnv> {
  const resolvedPath = isAbsolute(path) ? path : resolve(invocationDirectory, path);
  return parseEnv(await readFile(resolvedPath, "utf8"));
}

async function loadStrictEnvironment(
  path: string,
  invocationDirectory: string,
  invalidCode: "HOSTED_CADDY_CONFIGURATION_INVALID" | "MAINTENANCE_CONFIGURATION_INVALID",
): Promise<NodeJS.ProcessEnv> {
  const resolvedPath = isAbsolute(path) ? path : resolve(invocationDirectory, path);
  const contents = await readFile(resolvedPath, "utf8");
  if (contents.includes("\r")) {
    throw new Error(invalidCode);
  }
  const lines = contents.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const line of lines) {
    const match = /^([A-Z][A-Z0-9_]*)=(.+)$/u.exec(line);
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined || environment[name] !== undefined) {
      throw new Error(invalidCode);
    }
    environment[name] = value;
  }
  return environment;
}

async function loadMaintenanceEnvironment(
  path: string,
  invocationDirectory: string,
): Promise<NodeJS.ProcessEnv> {
  return loadStrictEnvironment(path, invocationDirectory, "MAINTENANCE_CONFIGURATION_INVALID");
}

function loadMaintenanceReleaseConfiguration(
  environment: NodeJS.ProcessEnv,
): MaintenanceReleaseConfiguration {
  const expectedNames = new Set([
    "NODE_ENV",
    "REFUNDDESK_MAINTENANCE_DATABASE_URL",
    "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1",
    "REFUNDDESK_RETENTION_BATCH_SIZE",
    "REFUNDDESK_RETENTION_SCOPE",
  ]);
  const actualNames = Object.keys(environment);
  if (
    actualNames.length !== expectedNames.size ||
    actualNames.some((name) => !expectedNames.has(name))
  ) {
    throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
  }
  if (
    environment["NODE_ENV"] !== "production" ||
    environment["REFUNDDESK_RETENTION_SCOPE"] !== "test_sandbox" ||
    !/^(?:[1-9]|[1-9]\d|100)$/u.test(environment["REFUNDDESK_RETENTION_BATCH_SIZE"] ?? "")
  ) {
    throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
  }

  const encodedKey = environment["REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1"] ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(encodedKey)) {
    throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
  }
  const pseudonymKey = Buffer.from(encodedKey, "base64");
  if (pseudonymKey.length !== 32 || pseudonymKey.toString("base64") !== encodedKey) {
    throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
  }

  const databaseUrlValue = environment["REFUNDDESK_MAINTENANCE_DATABASE_URL"];
  if (databaseUrlValue === undefined) {
    throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
  }
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(databaseUrlValue);
  } catch {
    throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
  }
  let databasePrincipal: string;
  try {
    databasePrincipal = decodeURIComponent(databaseUrl.username);
  } catch {
    throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
  }
  if (
    (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") ||
    databasePrincipal !== "refunddesk_maintenance_login" ||
    databaseUrl.password.length === 0 ||
    databaseUrl.hostname !== "postgres.refunddesk.internal" ||
    databaseUrl.port !== "5432" ||
    databaseUrl.pathname !== "/refunddesk" ||
    databaseUrl.search !== "?sslmode=verify-full" ||
    databaseUrl.hash !== ""
  ) {
    throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
  }
  return { databasePrincipal, pseudonymKey };
}

function releaseDatabasePrincipal(connectionString: string): string {
  try {
    return decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
  }
}

function assertMaintenanceReleaseSeparation(
  maintenance: MaintenanceReleaseConfiguration,
  platform: ReturnType<typeof loadPlatformConfig>,
  worker: ReturnType<typeof loadWorkerConfig>,
  migration: ReturnType<typeof loadMigrationConfig>,
): void {
  const otherDatabasePrincipals = [
    releaseDatabasePrincipal(platform.databaseUrl),
    releaseDatabasePrincipal(worker.workerDatabaseUrl),
    releaseDatabasePrincipal(worker.pgBossDatabaseUrl),
    releaseDatabasePrincipal(migration.migrationDatabaseUrl),
  ];
  if (otherDatabasePrincipals.includes(maintenance.databasePrincipal)) {
    throw new Error("MAINTENANCE_DATABASE_PRINCIPAL_NOT_SEPARATED");
  }

  const applicationKeys = [
    platform.keys.fieldV1,
    platform.keys.fieldV2,
    platform.keys.exportV1,
    worker.keys.proofV1,
    worker.keys.proofV2,
    worker.keys.approvalAttestationV1,
    worker.keys.approvalAttestationV2,
    Buffer.from(platform.signedRequestVerifierToken, "base64"),
  ].filter((key): key is Buffer => key !== undefined);
  if (applicationKeys.some((key) => key.equals(maintenance.pseudonymKey))) {
    throw new Error("MAINTENANCE_PSEUDONYM_KEY_NOT_SEPARATED");
  }
}

function parsePublicOriginFile(contents: string): string {
  const withoutFinalLineEnding = contents.endsWith("\r\n")
    ? contents.slice(0, -2)
    : contents.endsWith("\n")
      ? contents.slice(0, -1)
      : contents;
  if (
    withoutFinalLineEnding.length === 0 ||
    withoutFinalLineEnding.trim() !== withoutFinalLineEnding ||
    withoutFinalLineEnding.includes("\r") ||
    withoutFinalLineEnding.includes("\n")
  ) {
    throw new Error("HOSTED_PUBLIC_ORIGIN_INVALID");
  }
  return withoutFinalLineEnding;
}

function assertHostedPublicOrigin(
  appBaseUrl: string,
  caddyEnvironment: NodeJS.ProcessEnv,
  publicOriginContents: string,
): void {
  const publicOrigin = parsePublicOriginFile(publicOriginContents);
  const publicHost = caddyEnvironment["REFUNDDESK_PUBLIC_HOST"];
  let origin: URL;
  let caddyOrigin: URL;
  try {
    origin = new URL(publicOrigin);
    caddyOrigin = new URL(`https://${publicHost ?? ""}`);
  } catch {
    throw new Error("HOSTED_PUBLIC_ORIGIN_INVALID");
  }
  if (
    origin.protocol !== "https:" ||
    origin.port !== "" ||
    publicOrigin !== origin.origin ||
    appBaseUrl !== publicOrigin ||
    publicHost === undefined ||
    publicHost !== caddyOrigin.hostname ||
    caddyOrigin.protocol !== "https:" ||
    caddyOrigin.port !== "" ||
    caddyOrigin.username !== "" ||
    caddyOrigin.password !== "" ||
    caddyOrigin.pathname !== "/" ||
    caddyOrigin.search !== "" ||
    caddyOrigin.hash !== "" ||
    origin.hostname !== HOSTED_PUBLIC_VIEWER_HOST ||
    origin.hostname === publicHost ||
    publicHost.endsWith(".cloudfront.net")
  ) {
    throw new Error("HOSTED_PUBLIC_ORIGIN_INVALID");
  }
}

function assertHostedCaddyConfiguration(caddyEnvironment: NodeJS.ProcessEnv): void {
  const actualNames = Object.keys(caddyEnvironment);
  const edgeOriginToken = caddyEnvironment["REFUNDDESK_EDGE_ORIGIN_TOKEN"] ?? "";
  let decodedToken: Buffer;
  try {
    decodedToken = Buffer.from(edgeOriginToken, "base64url");
  } catch {
    throw new Error("HOSTED_CADDY_CONFIGURATION_INVALID");
  }
  if (
    actualNames.length !== HOSTED_CADDY_ENVIRONMENT_NAMES.size ||
    actualNames.some((name) => !HOSTED_CADDY_ENVIRONMENT_NAMES.has(name)) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(edgeOriginToken) ||
    decodedToken.length !== 32 ||
    decodedToken.toString("base64url") !== edgeOriginToken ||
    KNOWN_NON_SECRET_EDGE_ORIGIN_TOKENS.has(edgeOriginToken)
  ) {
    throw new Error("HOSTED_CADDY_CONFIGURATION_INVALID");
  }
}

export async function checkReleaseConfiguration(
  paths: readonly string[],
  invocationDirectory = process.env["INIT_CWD"] ?? process.cwd(),
): Promise<ReleaseConfigurationSummary> {
  const [
    platformPath,
    workerPath,
    migrationPath,
    maintenancePath,
    caddyPath,
    publicOriginPath,
    ...extra
  ] = paths;
  const hostedMode = paths.length === 6;
  if (
    platformPath === undefined ||
    workerPath === undefined ||
    migrationPath === undefined ||
    (paths.length !== 3 && !hostedMode) ||
    extra.length > 0
  ) {
    throw new Error("THREE_OR_SIX_RELEASE_INPUTS_REQUIRED");
  }

  const [platformEnvironment, workerEnvironment, migrationEnvironment] = await Promise.all([
    loadEnvironment(platformPath, invocationDirectory),
    loadEnvironment(workerPath, invocationDirectory),
    loadEnvironment(migrationPath, invocationDirectory),
  ]);
  const platform = loadPlatformConfig(platformEnvironment);
  const worker = loadWorkerConfig(workerEnvironment);
  const migration = loadMigrationConfig(migrationEnvironment);
  if (
    platform.nodeEnv !== "production" ||
    worker.nodeEnv !== "production" ||
    migration.nodeEnv !== "production"
  ) {
    throw new Error("PRODUCTION_CONFIGURATION_REQUIRED");
  }
  assertReleaseConfigSeparation({ platform, worker, migration });

  if (hostedMode) {
    if (
      maintenancePath === undefined ||
      caddyPath === undefined ||
      publicOriginPath === undefined
    ) {
      throw new Error("THREE_OR_SIX_RELEASE_INPUTS_REQUIRED");
    }
    const [maintenanceEnvironment, caddyEnvironment, publicOriginContents] = await Promise.all([
      loadMaintenanceEnvironment(maintenancePath, invocationDirectory),
      loadStrictEnvironment(caddyPath, invocationDirectory, "HOSTED_CADDY_CONFIGURATION_INVALID"),
      readFile(resolveInputPath(publicOriginPath, invocationDirectory), "utf8"),
    ]);
    assertMaintenanceReleaseSeparation(
      loadMaintenanceReleaseConfiguration(maintenanceEnvironment),
      platform,
      worker,
      migration,
    );
    assertHostedCaddyConfiguration(caddyEnvironment);
    assertHostedPublicOrigin(platform.appBaseUrl, caddyEnvironment, publicOriginContents);
  }
  return {
    keyRotation: {
      approvalAttestation: worker.keys.approvalAttestationRotationState,
      field: platform.keys.fieldRotationState,
      proof: worker.keys.proofRotationState,
    },
  };
}

async function main(): Promise<void> {
  const summary = await checkReleaseConfiguration(process.argv.slice(2));
  process.stdout.write(
    `${JSON.stringify({
      component: "release-config",
      keyRotation: summary.keyRotation,
      status: "separated",
    })}\n`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  void main().catch(() => {
    process.stderr.write(
      `${JSON.stringify({ component: "release-config", code: "RELEASE_CONFIG_INVALID" })}\n`,
    );
    process.exitCode = 1;
  });
}
