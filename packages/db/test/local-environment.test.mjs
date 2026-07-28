import { afterEach, describe, expect, it } from "vitest";

import {
  assertRuntimePrincipalsAreSeparated,
  databasePrincipal,
  requirePostgresUrl,
} from "../../../scripts/local-environment.mjs";

const variableName = "REFUNDDESK_POSTGRES_URL_TEST";
const originalValue = process.env[variableName];
const runtimeVariableNames = [
  "DATABASE_URL",
  "WORKER_DATABASE_URL",
  "PGBOSS_DATABASE_URL",
  "DATABASE_MIGRATION_URL",
];
const originalRuntimeValues = new Map(
  runtimeVariableNames.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[variableName];
  } else {
    process.env[variableName] = originalValue;
  }
  for (const [name, value] of originalRuntimeValues) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("PostgreSQL URL authority parsing", () => {
  it.each([
    "postgresql://web:local@localhost:5432/refunddesk?user=worker",
    "postgresql://web:local@localhost:5432/refunddesk?host=other.internal",
    "postgresql://web:local@localhost:5432/refunddesk?database=other",
    "postgresql://web:local@localhost:5432/refunddesk?options=-c%20role%3Dworker",
  ])("rejects authority override %s", (value) => {
    process.env[variableName] = value;
    expect(() => requirePostgresUrl(variableName)).toThrow(`${variableName}_INVALID`);
  });

  it("allows non-authority TLS and timeout parameters", () => {
    process.env[variableName] =
      "postgresql://web:local@localhost:5432/refunddesk?sslmode=require&connect_timeout=5";
    const url = requirePostgresUrl(variableName);

    expect(databasePrincipal(url)).toBe("web");
  });

  it("rejects a queue login that reuses the worker principal", () => {
    process.env["DATABASE_URL"] = "postgresql://web:local@localhost:5432/refunddesk";
    process.env["WORKER_DATABASE_URL"] = "postgresql://worker:local@localhost:5432/refunddesk";
    process.env["PGBOSS_DATABASE_URL"] = "postgresql://worker:other@localhost:5432/refunddesk";
    process.env["DATABASE_MIGRATION_URL"] = "postgresql://owner:local@localhost:5432/refunddesk";

    expect(() => assertRuntimePrincipalsAreSeparated()).toThrow(
      "DATABASE_RUNTIME_PRINCIPALS_MUST_BE_DISTINCT",
    );
  });

  it("accepts four distinct database principals", () => {
    process.env["DATABASE_URL"] = "postgresql://web:local@localhost:5432/refunddesk";
    process.env["WORKER_DATABASE_URL"] = "postgresql://worker:local@localhost:5432/refunddesk";
    process.env["PGBOSS_DATABASE_URL"] = "postgresql://queue:local@localhost:5432/refunddesk";
    process.env["DATABASE_MIGRATION_URL"] = "postgresql://owner:local@localhost:5432/refunddesk";

    expect(() => assertRuntimePrincipalsAreSeparated()).not.toThrow();
  });
});
