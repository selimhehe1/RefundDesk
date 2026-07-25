import type { StripeEnvironment } from "./types.js";
import { hasStripeAdministratorRole } from "./stripe-roles.js";

export type AccessAction =
  | "onboarding"
  | "settings"
  | "create_refund_request"
  | "decide_refund_request"
  | "cancel_refund_request"
  | "execute_refund"
  | "read"
  | "audit_export"
  | "reconcile"
  | "receive_webhook";

export type AccessDenialCode =
  | "TENANT_INACTIVE"
  | "INSTALLATION_INACTIVE"
  | "PILOT_LIVE_DISABLED"
  | "ADMIN_REQUIRED"
  | "EXPLICIT_APPROVER_REQUIRED";

export interface AccessContext {
  readonly action: AccessAction;
  readonly environment: StripeEnvironment;
  readonly tenantStatus: "active" | "suspended" | "deauthorized" | "pending_deletion";
  readonly installationStatus: "active" | "suspended" | "deauthorized";
  readonly globalLiveEnabled: boolean;
  readonly tenantLiveEnabled: boolean;
  readonly signedStripeRoles: readonly {
    readonly id?: string | undefined;
    readonly name: string;
    readonly type: "builtIn" | "custom";
  }[];
  readonly explicitApprover: boolean;
}

export type AccessDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly code: AccessDenialCode };

export interface AccessPolicy {
  authorize(context: AccessContext): AccessDecision;
}

const ADMIN_ACTIONS = new Set<AccessAction>(["onboarding", "settings"]);

export class PilotAccessPolicy implements AccessPolicy {
  authorize(context: AccessContext): AccessDecision {
    if (context.tenantStatus !== "active") {
      return { allowed: false, code: "TENANT_INACTIVE" };
    }
    if (context.installationStatus !== "active") {
      return { allowed: false, code: "INSTALLATION_INACTIVE" };
    }
    if (context.environment === "live") {
      // Both switches are intentionally represented in the contract so a future
      // live policy cannot accidentally omit either. The pilot still denies live
      // even when both are true.
      void context.globalLiveEnabled;
      void context.tenantLiveEnabled;
      return { allowed: false, code: "PILOT_LIVE_DISABLED" };
    }
    if (
      ADMIN_ACTIONS.has(context.action) &&
      !hasStripeAdministratorRole(context.signedStripeRoles)
    ) {
      return { allowed: false, code: "ADMIN_REQUIRED" };
    }
    if (context.action === "decide_refund_request" && !context.explicitApprover) {
      return { allowed: false, code: "EXPLICIT_APPROVER_REQUIRED" };
    }
    return { allowed: true };
  }
}
