import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { describe, expect, it } from "vitest";

import { getPhase0ControlAvailability } from "../src/phase0-controls";

function createContext(
  overrides: {
    readonly mode?: "live" | "test";
    readonly probeEnabled?: boolean;
    readonly roles?: ExtensionContextValue["userContext"]["roles"];
  } = {},
): ExtensionContextValue {
  return {
    userContext: {
      id: "usr_123",
      account: {
        country: "FR",
        id: "acct_123",
        isSandbox: true,
      },
      locale: "en",
      roles: overrides.roles ?? [{ name: "Administrator", type: "builtIn" }],
    },
    environment: {
      constants: {
        API_BASE: "http://localhost:3000/api",
        PHASE0_PROBE_ENABLED: overrides.probeEnabled ?? true,
        PILOT_LIVE_ENABLED: false,
      },
      mode: overrides.mode ?? "test",
      viewportID: "stripe.dashboard.payment.detail",
      objectContext: {
        id: "pi_123",
        object: "payment_intent",
      },
    },
    appContext: {
      authorizedPermissions: ["charge_read", "charge_write", "event_read", "payment_intent_read"],
    },
  };
}

describe("Phase-0 payment controls", () => {
  it("keeps non-mutating evidence refresh available when eligibility did not load", () => {
    expect(
      getPhase0ControlAvailability(createContext(), "payment_intent", "pi_123", false),
    ).toEqual({
      initializeTenant: true,
      refreshEvidence: true,
      runRefundProbe: false,
    });
  });

  it("enables the Refund probe only after eligibility loads", () => {
    expect(getPhase0ControlAvailability(createContext(), "payment_intent", "pi_123", true)).toEqual(
      {
        initializeTenant: false,
        refreshEvidence: true,
        runRefundProbe: true,
      },
    );
  });

  it.each([
    {
      name: "the uploaded manifest disables Phase 0",
      context: createContext({ probeEnabled: false }),
      resourceType: "payment_intent" as const,
      resourceId: "pi_123",
    },
    {
      name: "the signed role is not a built-in Administrator",
      context: createContext({
        roles: [{ name: "Administrator", type: "custom" }],
      }),
      resourceType: "payment_intent" as const,
      resourceId: "pi_123",
    },
    {
      name: "the Dashboard object is not a PaymentIntent",
      context: createContext(),
      resourceType: "charge" as const,
      resourceId: "ch_123",
    },
    {
      name: "the PaymentIntent ID is unavailable",
      context: createContext(),
      resourceType: "payment_intent" as const,
      resourceId: undefined,
    },
    {
      name: "the Dashboard is in live mode",
      context: createContext({ mode: "live" }),
      resourceType: "payment_intent" as const,
      resourceId: "pi_123",
    },
  ])("hides every Phase-0 control when $name", ({ context, resourceId, resourceType }) => {
    expect(getPhase0ControlAvailability(context, resourceType, resourceId, true)).toEqual({
      initializeTenant: false,
      refreshEvidence: false,
      runRefundProbe: false,
    });
  });
});
