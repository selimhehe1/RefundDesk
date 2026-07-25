import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";

import { isAdministrator, isPhase0ProbeEnabled, type PilotResourceType } from "./api/signed-fetch";

export interface Phase0ControlAvailability {
  readonly initializeTenant: boolean;
  readonly refreshEvidence: boolean;
  readonly runRefundProbe: boolean;
}

export function getPhase0ControlAvailability(
  context: ExtensionContextValue,
  resourceType: PilotResourceType | undefined,
  resourceId: string | undefined,
  eligibilityLoaded: boolean,
): Phase0ControlAvailability {
  const phase0PaymentIntent =
    context.environment.mode === "test" &&
    isPhase0ProbeEnabled(context) &&
    isAdministrator(context) &&
    resourceType === "payment_intent" &&
    resourceId !== undefined &&
    resourceId.length > 0;

  return {
    initializeTenant: phase0PaymentIntent && !eligibilityLoaded,
    refreshEvidence: phase0PaymentIntent,
    runRefundProbe: phase0PaymentIntent && eligibilityLoaded,
  };
}
