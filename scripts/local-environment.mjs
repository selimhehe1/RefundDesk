import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const localEnvironmentPath = fileURLToPath(new URL("../.env.local", import.meta.url));

export function loadLocalEnvironment() {
  if (!existsSync(localEnvironmentPath)) {
    return;
  }

  // Explicit shell/CI variables take precedence over the optional local file.
  const inherited = { ...process.env };
  loadEnvFile(localEnvironmentPath);
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined) {
      process.env[name] = value;
    }
  }
}

export function requirePostgresUrl(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name}_REQUIRED`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name}_INVALID`);
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.username.length === 0 ||
    url.hostname.length === 0 ||
    url.pathname.length <= 1
  ) {
    throw new Error(`${name}_INVALID`);
  }
  return url;
}

export function databasePrincipal(url) {
  return decodeURIComponent(url.username);
}

export function assertRuntimePrincipalsAreSeparated() {
  const web = databasePrincipal(requirePostgresUrl("DATABASE_URL"));
  const worker = databasePrincipal(requirePostgresUrl("WORKER_DATABASE_URL"));
  const queue = databasePrincipal(requirePostgresUrl("PGBOSS_DATABASE_URL"));
  const owner = databasePrincipal(requirePostgresUrl("DATABASE_MIGRATION_URL"));

  if (web === worker || web === queue) {
    throw new Error("DATABASE_RUNTIME_PRINCIPALS_MUST_BE_DISTINCT");
  }
  if (owner === web || owner === worker || owner === queue) {
    throw new Error("DATABASE_OWNER_MUST_NOT_BE_A_RUNTIME_PRINCIPAL");
  }
}

export { repositoryRoot };
