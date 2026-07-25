import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../../", import.meta.url);

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

function environmentValue(source: string, name: string): string {
  const match = new RegExp(`^${name}=(.+)$`, "mu").exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`Missing ${name} in .env.example`);
  }
  return match[1];
}

describe("local PostgreSQL tooling", () => {
  it("binds PostgreSQL to loopback and initializes unprivileged login roles", async () => {
    const [compose, bootstrap] = await Promise.all([
      readRepositoryFile("docker-compose.yml"),
      readRepositoryFile("docker/postgres/init/10-local-runtime-logins.sql"),
    ]);

    expect(compose).toContain('"127.0.0.1:5432:5432"');
    expect(compose).toContain("./docker/postgres/init:/docker-entrypoint-initdb.d:ro");
    expect(bootstrap).toContain("CREATE ROLE refunddesk_web_login LOGIN");
    expect(bootstrap).toContain("CREATE ROLE refunddesk_worker_login LOGIN");
    expect(bootstrap).toContain("GRANT refunddesk_runtime TO refunddesk_web_login");
    expect(bootstrap).toContain("GRANT refunddesk_worker TO refunddesk_worker_login");
    expect(bootstrap).toContain("NOBYPASSRLS");
    expect(bootstrap).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  });

  it("uses distinct owner, web, and worker principals in the local environment", async () => {
    const source = await readRepositoryFile(".env.example");
    const web = new URL(environmentValue(source, "DATABASE_URL")).username;
    const worker = new URL(environmentValue(source, "WORKER_DATABASE_URL")).username;
    const queue = new URL(environmentValue(source, "PGBOSS_DATABASE_URL")).username;
    const owner = new URL(environmentValue(source, "DATABASE_MIGRATION_URL")).username;

    expect(web).toBe("refunddesk_web_login");
    expect(worker).toBe("refunddesk_worker_login");
    expect(queue).toBe(worker);
    expect(new Set([owner, web, worker]).size).toBe(3);
  });

  it("runs owner migrations before applying runtime grants", async () => {
    const packageJson = JSON.parse(await readRepositoryFile("package.json")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const orchestrator = await readRepositoryFile("scripts/database-command.mjs");

    expect(packageJson.scripts["db:migrate:dev"]).toContain("migrate-dev");
    expect(packageJson.scripts["db:pgboss:migrate"]).toContain("migrate-pgboss");
    expect(packageJson.scripts["db:access:check"]).toContain("check-access");
    expect(orchestrator).toContain('await migratePrisma("dev")');
    expect(orchestrator).toContain("await applyRuntimeAccess()");
    expect(orchestrator).toMatch(
      /scripts\/migrate-pgboss\.mjs[\s\S]+scripts\/grant-pgboss-runtime\.mjs/u,
    );
  });

  it("repairs and verifies every collective runtime role as non-privileged", async () => {
    const [roles, accessCheck] = await Promise.all([
      readRepositoryFile("packages/db/prisma/runtime-roles.sql"),
      readRepositoryFile("packages/db/scripts/check-runtime-access.mjs"),
    ]);
    const requiredRoleAttributes = [
      "NOLOGIN",
      "NOSUPERUSER",
      "NOCREATEDB",
      "NOCREATEROLE",
      "NOINHERIT",
      "NOREPLICATION",
      "NOBYPASSRLS",
      "PASSWORD NULL",
    ];

    for (const role of ["refunddesk_runtime", "refunddesk_worker", "refunddesk_maintenance"]) {
      const alter = new RegExp(`ALTER ROLE ${role} WITH([\\s\\S]*?);`, "u").exec(roles)?.[1];
      expect(alter).toBeDefined();
      for (const attribute of requiredRoleAttributes) {
        expect(alter).toContain(attribute);
      }
    }

    expect(accessCheck).toContain('"refunddesk_runtime"');
    expect(accessCheck).toContain('"refunddesk_worker"');
    expect(accessCheck).toContain('"refunddesk_maintenance"');
    for (const attribute of [
      "rolcanlogin",
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolinherit",
      "rolreplication",
      "rolbypassrls",
      "has_parent_membership",
    ]) {
      expect(accessCheck).toContain(attribute);
    }
    expect(roles).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public");
    expect(roles).toContain("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public");
    expect(roles).toContain("GRANT EXECUTE ON FUNCTION refunddesk_purge_tenant(UUID, VARCHAR)");
    expect(roles).toContain("FOREACH collective_role IN ARRAY ARRAY[");
    expect(roles).toContain("]::NAME[]");
    expect(roles).toContain("EXECUTE format('REVOKE %I FROM %I', parent_role, collective_role)");
    expect(accessCheck).toContain("FROM pg_catalog.pg_class AS relation");
    expect(accessCheck).toContain("FROM pg_catalog.pg_namespace AS namespace");
    expect(accessCheck).toContain("SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER");
    expect(accessCheck).toContain("WHEN relation.relkind IN ('r', 'p', 'm') THEN");
    expect(accessCheck).toContain("has_relation_maintain");
    expect(accessCheck).toContain("WHEN sequence.relkind = 'S' THEN");
    expect(accessCheck).toContain("has_other_procedure_execute");
    expect(accessCheck).toContain("sequence.relkind = 'S'");
    expect(accessCheck).toContain("has_schema_privilege(");
    expect(accessCheck).toContain("has_sequence_privilege(");
    expect(accessCheck).toContain("FROM pg_catalog.pg_proc AS routine");
    expect(accessCheck).toContain("has_other_function_execute");
    expect(accessCheck).not.toContain("information_schema.tables");
    expect(accessCheck).toContain("DATABASE_MAINTENANCE_CAPABILITY_CHECK_FAILED");
  });

  it("keeps pg-boss DDL owner-only while granting runtime DML and function execution", async () => {
    const [grants, workerRuntime] = await Promise.all([
      readRepositoryFile("packages/db/scripts/grant-pgboss-runtime.mjs"),
      readRepositoryFile("apps/worker/src/pg-boss-runtime.ts"),
    ]);

    expect(grants).toContain("REVOKE CREATE ON SCHEMA");
    expect(grants).toContain("GRANT USAGE ON SCHEMA");
    expect(grants).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
    expect(grants).toContain("GRANT EXECUTE ON ALL FUNCTIONS");
    expect(grants).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE");
    expect(grants).toContain("REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    expect(workerRuntime).not.toContain("partition: true");
  });
});
