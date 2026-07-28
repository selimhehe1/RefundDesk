import { describe, expect, it } from "vitest";

import {
  assertExactRuntimeMembership,
  assertExclusiveRuntimeMembership,
  classifyPreflightCollectiveRoleSet,
} from "../scripts/runtime-membership.mjs";

describe("runtime database login membership", () => {
  it("accepts only the exact expected collective role", () => {
    expect(() =>
      assertExclusiveRuntimeMembership(["refunddesk_worker"], "refunddesk_worker"),
    ).not.toThrow();
  });

  it("rejects maintenance or provider authority inherited by a runtime login", () => {
    expect(() =>
      assertExclusiveRuntimeMembership(
        ["refunddesk_maintenance", "refunddesk_worker"],
        "refunddesk_worker",
      ),
    ).toThrow("DATABASE_RUNTIME_LOGIN_HAS_FOREIGN_MEMBERSHIP");
    expect(() =>
      assertExclusiveRuntimeMembership(
        ["provider_admin", "refunddesk_runtime"],
        "refunddesk_runtime",
      ),
    ).toThrow("DATABASE_RUNTIME_LOGIN_HAS_FOREIGN_MEMBERSHIP");
  });

  it("accepts only the worker's exact data and attestation capabilities", () => {
    const expected = ["refunddesk_attestation_writer", "refunddesk_worker"];

    expect(() => assertExactRuntimeMembership(expected, expected)).not.toThrow();
    expect(() => assertExactRuntimeMembership(["refunddesk_worker"], expected)).toThrow(
      "DATABASE_RUNTIME_LOGIN_HAS_FOREIGN_MEMBERSHIP",
    );
    expect(() =>
      assertExactRuntimeMembership(
        ["refunddesk_attestation_writer", "refunddesk_maintenance", "refunddesk_worker"],
        expected,
      ),
    ).toThrow("DATABASE_RUNTIME_LOGIN_HAS_FOREIGN_MEMBERSHIP");
  });

  it("keeps the queue login on its pg-boss-only capability", () => {
    expect(() =>
      assertExactRuntimeMembership(["refunddesk_queue"], ["refunddesk_queue"]),
    ).not.toThrow();
    expect(() => assertExactRuntimeMembership(["refunddesk_worker"], ["refunddesk_queue"])).toThrow(
      "DATABASE_RUNTIME_LOGIN_HAS_FOREIGN_MEMBERSHIP",
    );
    expect(() =>
      assertExactRuntimeMembership(["refunddesk_queue", "refunddesk_worker"], ["refunddesk_queue"]),
    ).toThrow("DATABASE_RUNTIME_LOGIN_HAS_FOREIGN_MEMBERSHIP");
  });

  it("accepts only exact absent, upgrade, or current preflight role sets", () => {
    expect(classifyPreflightCollectiveRoleSet([])).toBe("absent");
    expect(
      classifyPreflightCollectiveRoleSet([
        "refunddesk_maintenance",
        "refunddesk_runtime",
        "refunddesk_worker",
      ]),
    ).toBe("legacy");
    expect(
      classifyPreflightCollectiveRoleSet([
        "refunddesk_attestation_writer",
        "refunddesk_maintenance",
        "refunddesk_runtime",
        "refunddesk_worker",
      ]),
    ).toBe("attestation");
    expect(
      classifyPreflightCollectiveRoleSet([
        "refunddesk_attestation_writer",
        "refunddesk_maintenance",
        "refunddesk_queue",
        "refunddesk_runtime",
        "refunddesk_worker",
      ]),
    ).toBe("current");

    for (const invalidRoleSet of [
      ["refunddesk_runtime"],
      ["refunddesk_attestation_writer", "refunddesk_runtime", "refunddesk_worker"],
      ["refunddesk_maintenance", "refunddesk_queue", "refunddesk_runtime", "refunddesk_worker"],
      ["provider_admin", "refunddesk_maintenance", "refunddesk_runtime", "refunddesk_worker"],
    ]) {
      expect(() => classifyPreflightCollectiveRoleSet(invalidRoleSet)).toThrow(
        "DATABASE_COLLECTIVE_ROLE_SET_INCOMPLETE",
      );
    }
  });
});
