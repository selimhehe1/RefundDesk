export interface StripeRoleIdentity {
  readonly id?: string | undefined;
  readonly name: string;
  readonly type: "builtIn" | "custom";
}

const LEGACY_BUILT_IN_ADMIN_NAMES = new Set(["Administrator", "Super Administrator"]);
const BUILT_IN_ADMIN_IDS = new Set(["admin", "super_admin"]);

export function isStripeAdministratorRole(role: StripeRoleIdentity): boolean {
  if (role.type !== "builtIn") {
    return false;
  }
  if (role.id !== undefined) {
    return BUILT_IN_ADMIN_IDS.has(role.id);
  }
  return LEGACY_BUILT_IN_ADMIN_NAMES.has(role.name);
}

export function hasStripeAdministratorRole(roles: readonly StripeRoleIdentity[]): boolean {
  return roles.some((role) => isStripeAdministratorRole(role));
}
