import { describe, expect, it } from "vitest";

import { assertDatabaseMutationAllowed } from "../../../scripts/database-command-policy.mjs";

describe("database command production policy", () => {
  it("refuses every direct production mutation outside release preparation", () => {
    expect(() => assertDatabaseMutationAllowed("production", false)).toThrow(
      "PRODUCTION_DATABASE_MUTATION_REQUIRES_RELEASE_PREPARE",
    );
  });

  it("allows the preflight-controlled release and non-production tooling", () => {
    expect(() => assertDatabaseMutationAllowed("production", true)).not.toThrow();
    expect(() => assertDatabaseMutationAllowed("development", false)).not.toThrow();
    expect(() => assertDatabaseMutationAllowed("test", false)).not.toThrow();
  });
});
