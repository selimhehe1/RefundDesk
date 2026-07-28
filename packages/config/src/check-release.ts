import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";

import {
  assertReleaseConfigSeparation,
  loadMigrationConfig,
  loadPlatformConfig,
  loadWorkerConfig,
} from "./index.js";

async function loadEnvironment(path: string): Promise<NodeJS.ProcessEnv> {
  const invocationDirectory = process.env["INIT_CWD"] ?? process.cwd();
  const resolvedPath = isAbsolute(path) ? path : resolve(invocationDirectory, path);
  return parseEnv(await readFile(resolvedPath, "utf8"));
}

async function main(): Promise<void> {
  const [platformPath, workerPath, migrationPath, ...extra] = process.argv.slice(2);
  if (
    platformPath === undefined ||
    workerPath === undefined ||
    migrationPath === undefined ||
    extra.length > 0
  ) {
    throw new Error("THREE_ENVIRONMENT_FILES_REQUIRED");
  }

  const [platformEnvironment, workerEnvironment, migrationEnvironment] = await Promise.all([
    loadEnvironment(platformPath),
    loadEnvironment(workerPath),
    loadEnvironment(migrationPath),
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
  process.stdout.write(`${JSON.stringify({ component: "release-config", status: "separated" })}\n`);
}

main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({ component: "release-config", code: "RELEASE_CONFIG_INVALID" })}\n`,
  );
  process.exitCode = 1;
});
