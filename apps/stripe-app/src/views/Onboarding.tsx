import { useEffect, useState } from "react";

import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { Banner, Box, Button, Checkbox, OnboardingView } from "@stripe/ui-extension-sdk/ui";
import type { OnboardingViewProps } from "@stripe/ui-extension-sdk/ui";

import { refundDeskApi } from "../api/client";
import { isAdministrator, publicRequestError } from "../api/signed-fetch";
import {
  PilotLimitationNotice,
  PilotModeBanner,
  PilotModeLabel,
} from "../components/PilotModeBanner";

export default function Onboarding(context: ExtensionContextValue) {
  const liveMode = context.environment.mode === "live";
  const administrator = isAdministrator(context);
  const userId = context.userContext.id;
  const [limitationAccepted, setLimitationAccepted] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (liveMode) {
      return;
    }
    let active = true;
    const synchronize = async () => {
      try {
        const response = await refundDeskApi.syncContext(context);
        if (active && response.onboarding_completed) {
          setCompleted(true);
        }
      } catch (syncError) {
        if (active) {
          setError(publicRequestError(syncError));
        }
      }
    };
    void synchronize();
    return () => {
      active = false;
    };
  }, [context, liveMode]);

  const finishOnboarding = async () => {
    if (liveMode || !administrator || !limitationAccepted || userId === undefined) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await refundDeskApi.updateSettings(context, {
        approver_user_ids: [userId],
        expiration_days: 7,
        onboarding_completed: true,
      });
      setCompleted(true);
    } catch (onboardingError) {
      setError(publicRequestError(onboardingError));
    } finally {
      setPending(false);
    }
  };

  const canComplete = !liveMode && administrator && limitationAccepted && userId !== undefined;
  const tasks: OnboardingViewProps["tasks"] = [
    {
      title: "Use a test or managed sandbox environment",
      status: liveMode ? "blocked" : "complete",
    },
    {
      title: "Understand the external-refund limitation",
      status: limitationAccepted ? "complete" : "in-progress",
    },
    {
      title: "Activate the current Administrator as first approver",
      status: administrator ? (completed ? "complete" : "in-progress") : "blocked",
    },
    {
      title: "Run the guided synthetic-payment probe",
      status: "not-started",
    },
  ];

  return (
    <OnboardingView
      title="Set up the RefundDesk pilot"
      description="Use Stripe identity—no separate RefundDesk password is required."
      completed={completed}
      pending={pending}
      tasks={tasks}
      error={
        error === null ? undefined : (
          <Banner type="critical" title="Setup unavailable" description={error} />
        )
      }
    >
      <Box css={{ stack: "y", gap: "large" }}>
        <PilotModeBanner context={context} />
        <Box css={{ stack: "x", gap: "small", alignY: "center" }}>
          <PilotModeLabel context={context} />
          <Box>One distinct approver is required for every request.</Box>
        </Box>
        <PilotLimitationNotice />

        <Checkbox
          label="I understand that RefundDesk cannot block refunds created directly elsewhere in Stripe."
          checked={limitationAccepted}
          onChange={(event) => {
            setLimitationAccepted(event.target.checked);
          }}
          disabled={liveMode || completed}
        />

        {!administrator ? (
          <Banner
            type="caution"
            title="Administrator role required"
            description="A Stripe Administrator must finish setup and explicitly activate the first approver. The backend verifies the signed role."
          />
        ) : null}

        <Box css={{ stack: "y", gap: "small" }}>
          <Box>Initial pilot policy</Box>
          <Box>• one approver, always different from the requester</Box>
          <Box>• requests expire after seven days</Box>
          <Box>• audit and justifications retained for 365 days</Box>
          <Box>• no e-mail notifications, Billing, quota, or live execution</Box>
        </Box>

        <Banner
          title="Guided sandbox test"
          description="After setup, open an allowlisted synthetic PaymentIntent. The payment view can run the development-only phase-0 probe, then the normal approval workflow."
        />

        <Button
          type="primary"
          pending={pending}
          disabled={!canComplete || completed}
          onPress={() => {
            void finishOnboarding();
          }}
        >
          Activate me as approver and finish setup
        </Button>
      </Box>
    </OnboardingView>
  );
}
