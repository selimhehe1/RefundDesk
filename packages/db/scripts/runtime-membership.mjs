export function assertExclusiveRuntimeMembership(parentRoles, expectedMembership) {
  assertExactRuntimeMembership(parentRoles, [expectedMembership]);
}

export function assertExactRuntimeMembership(parentRoles, expectedMemberships) {
  if (
    !Array.isArray(parentRoles) ||
    !Array.isArray(expectedMemberships) ||
    parentRoles.length !== expectedMemberships.length ||
    parentRoles.some((parentRole, index) => parentRole !== expectedMemberships[index])
  ) {
    throw new Error("DATABASE_RUNTIME_LOGIN_HAS_FOREIGN_MEMBERSHIP");
  }
}

export function classifyPreflightCollectiveRoleSet(roleNames) {
  if (!Array.isArray(roleNames)) {
    throw new Error("DATABASE_COLLECTIVE_ROLE_SET_INCOMPLETE");
  }

  const exactRoleSets = new Map([
    ["absent", []],
    ["legacy", ["refunddesk_maintenance", "refunddesk_runtime", "refunddesk_worker"]],
    [
      "attestation",
      [
        "refunddesk_attestation_writer",
        "refunddesk_maintenance",
        "refunddesk_runtime",
        "refunddesk_worker",
      ],
    ],
    [
      "current",
      [
        "refunddesk_attestation_writer",
        "refunddesk_maintenance",
        "refunddesk_queue",
        "refunddesk_runtime",
        "refunddesk_worker",
      ],
    ],
  ]);
  for (const [kind, expectedRoleNames] of exactRoleSets) {
    if (
      roleNames.length === expectedRoleNames.length &&
      roleNames.every((roleName, index) => roleName === expectedRoleNames[index])
    ) {
      return kind;
    }
  }

  throw new Error("DATABASE_COLLECTIVE_ROLE_SET_INCOMPLETE");
}
