import { spawn } from "node:child_process";

import {
  assertRuntimePrincipalsAreSeparated,
  loadLocalEnvironment,
  requirePostgresUrl,
  repositoryRoot,
} from "./local-environment.mjs";

loadLocalEnvironment();

function runPnpm(arguments_) {
  return new Promise((resolve, reject) => {
    const pnpmCli = process.env["npm_execpath"];
    const executable = pnpmCli === undefined ? "pnpm" : process.execPath;
    const args = pnpmCli === undefined ? arguments_ : [pnpmCli, ...arguments_];
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
      shell: pnpmCli === undefined && process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal === null
            ? `DATABASE_COMMAND_FAILED_${String(code)}`
            : `DATABASE_COMMAND_TERMINATED_${signal}`,
        ),
      );
    });
  });
}

async function generate() {
  await runPnpm(["--filter", "@refunddesk/db", "exec", "prisma", "generate"]);
}

async function applyRuntimeAccess() {
  assertRuntimePrincipalsAreSeparated();
  await runPnpm(["--filter", "@refunddesk/db", "exec", "node", "scripts/apply-runtime-access.mjs"]);
}

async function migratePrisma(kind) {
  assertRuntimePrincipalsAreSeparated();
  const prismaCommand = kind === "dev" ? "dev" : "deploy";
  await runPnpm(["--filter", "@refunddesk/db", "exec", "prisma", "migrate", prismaCommand]);
  await applyRuntimeAccess();
}

async function bootstrapLocalRoles() {
  requirePostgresUrl("DATABASE_MIGRATION_URL");
  await runPnpm([
    "--filter",
    "@refunddesk/db",
    "exec",
    "node",
    "scripts/bootstrap-local-logins.mjs",
  ]);
}

async function migratePgBoss() {
  assertRuntimePrincipalsAreSeparated();
  await runPnpm(["--filter", "@refunddesk/worker", "exec", "node", "scripts/migrate-pgboss.mjs"]);
  await runPnpm(["--filter", "@refunddesk/db", "exec", "node", "scripts/grant-pgboss-runtime.mjs"]);
}

async function checkAccess() {
  assertRuntimePrincipalsAreSeparated();
  await runPnpm(["--filter", "@refunddesk/db", "exec", "node", "scripts/check-runtime-access.mjs"]);
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case "generate":
      await generate();
      break;
    case "migrate-dev":
      await migratePrisma("dev");
      break;
    case "migrate-deploy":
      await migratePrisma("deploy");
      break;
    case "apply-runtime-access":
      await applyRuntimeAccess();
      break;
    case "bootstrap-local-roles":
      await bootstrapLocalRoles();
      break;
    case "migrate-pgboss":
      await migratePgBoss();
      break;
    case "check-access":
      await checkAccess();
      break;
    case "setup-local":
      await bootstrapLocalRoles();
      await generate();
      await migratePrisma("dev");
      await migratePgBoss();
      await checkAccess();
      break;
    default:
      throw new Error("UNKNOWN_DATABASE_COMMAND");
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof Error ? error.message : "DATABASE_COMMAND_FAILED";
  process.stderr.write(`${JSON.stringify({ component: "database-command", code })}\n`);
  process.exitCode = 1;
}
