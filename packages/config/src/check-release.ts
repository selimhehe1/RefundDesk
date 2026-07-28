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
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error("HOSTED_PUBLIC_ORIGIN_INVALID");
  }
  if (
    origin.protocol !== "https:" ||
    origin.port !== "" ||
    publicOrigin !== origin.origin ||
    appBaseUrl !== publicOrigin ||
    publicHost === undefined ||
    publicHost !== origin.hostname
  ) {
    throw new Error("HOSTED_PUBLIC_ORIGIN_INVALID");
  }
}

export async function checkReleaseConfiguration(
  paths: readonly string[],
  invocationDirectory = process.env["INIT_CWD"] ?? process.cwd(),
): Promise<void> {
  const [platformPath, workerPath, migrationPath, caddyPath, publicOriginPath, ...extra] = paths;
  const hostedMode = paths.length === 5;
  if (
    platformPath === undefined ||
    workerPath === undefined ||
    migrationPath === undefined ||
    (paths.length !== 3 && !hostedMode) ||
    extra.length > 0
  ) {
    throw new Error("THREE_OR_FIVE_RELEASE_INPUTS_REQUIRED");
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
    if (caddyPath === undefined || publicOriginPath === undefined) {
      throw new Error("THREE_OR_FIVE_RELEASE_INPUTS_REQUIRED");
    }
    const [caddyEnvironment, publicOriginContents] = await Promise.all([
      loadEnvironment(caddyPath, invocationDirectory),
      readFile(resolveInputPath(publicOriginPath, invocationDirectory), "utf8"),
    ]);
    assertHostedPublicOrigin(platform.appBaseUrl, caddyEnvironment, publicOriginContents);
  }
}

async function main(): Promise<void> {
  await checkReleaseConfiguration(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify({ component: "release-config", status: "separated" })}\n`);
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
