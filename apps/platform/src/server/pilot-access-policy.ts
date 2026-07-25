import {
  PilotAccessPolicy as DomainPilotAccessPolicy,
  type AccessAction,
} from "@refunddesk/domain";

import { PilotApiError } from "./pilot-errors";
import type { PilotAccessPolicy, PilotTenantContext } from "./pilot-ports";

function actionForOperation(
  operation: Parameters<PilotAccessPolicy["assertAllowed"]>[1]["operation"],
): AccessAction {
  switch (operation) {
    case "refund_request.create":
      return "create_refund_request";
    case "refund_request.decide":
      return "decide_refund_request";
    case "refund_request.cancel":
      return "cancel_refund_request";
    case "settings.update":
      return "settings";
    case "audit.export":
      return "audit_export";
    case "context.sync":
    case "external_alert.acknowledge":
    case "external_alert.list":
    case "payment.eligibility":
    case "refund_request.get":
    case "refund_request.list":
    case "settings.get":
      return "read";
  }
}

function throwAccessDenial(code: string): never {
  switch (code) {
    case "ADMIN_REQUIRED":
      throw new PilotApiError(
        "ADMIN_REQUIRED",
        403,
        "A signed Stripe Administrator role is required.",
      );
    case "EXPLICIT_APPROVER_REQUIRED":
      throw new PilotApiError(
        "APPROVER_REQUIRED",
        403,
        "This action requires an explicitly enabled approver.",
      );
    case "INSTALLATION_INACTIVE":
      throw new PilotApiError(
        "INSTALLATION_INACTIVE",
        403,
        "The Stripe installation is not active.",
      );
    case "PILOT_LIVE_DISABLED":
      throw new PilotApiError(
        "LIVE_MODE_DISABLED",
        403,
        "RefundDesk pilot operations are disabled in live mode.",
      );
    case "TENANT_INACTIVE":
    default:
      throw new PilotApiError("INSTALLATION_INACTIVE", 403, "The RefundDesk tenant is not active.");
  }
}

export class TestAndSandboxAccessPolicy implements PilotAccessPolicy {
  private readonly domainPolicy = new DomainPilotAccessPolicy();

  assertAllowed(
    context: PilotTenantContext,
    input: Parameters<PilotAccessPolicy["assertAllowed"]>[1],
  ): void {
    const decision = this.domainPolicy.authorize({
      action: actionForOperation(input.operation),
      environment: context.environment,
      tenantStatus: context.tenantStatus,
      installationStatus: context.installationStatus,
      globalLiveEnabled: false,
      tenantLiveEnabled: false,
      signedStripeRoles: input.roles,
      explicitApprover: context.actor.approverEnabled,
    });
    if (!decision.allowed) {
      throwAccessDenial(decision.code);
    }
  }
}
