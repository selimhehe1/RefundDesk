import { useEffect, useState } from "react";

import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import {
  Banner,
  Box,
  Button,
  Checkbox,
  List,
  ListItem,
  OnboardingView,
} from "@stripe/ui-extension-sdk/ui";
import type { OnboardingViewProps } from "@stripe/ui-extension-sdk/ui";

import { refundDeskApi } from "../api/client";
import { MutationIntentRegistry } from "../api/mutation-intent";
import {
  createRequestNonce,
  isAdministrator,
  isDefinitiveMutationRejection,
  publicRequestError,
} from "../api/signed-fetch";
import {
  PilotLimitationNotice,
  PilotModeBanner,
  PilotModeLabel,
} from "../components/PilotModeBanner";
import { SectionHeading } from "../components/SectionHeading";
import { viewContextKey } from "../view-context";

const COMPLETE_ONBOARDING_INTENT = "settings:onboarding";

function OnboardingViewContent({ context }: { readonly context: ExtensionContextValue }) {
  const liveMode = context.environment.mode === "live";
  const administrator = isAdministrator(context);
  const userId = context.userContext.id;
  const [limitationAccepted, setLimitationAccepted] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationIntents] = useState(() => new MutationIntentRegistry(createRequestNonce));

  useEffect(() => {
    if (liveMode) {
      return;
    }
    let active = true;
    const synchronize = async () => {
      try {
        const response = await refundDeskApi.syncContext(context);
        if (active && response.onboarding_completed) {
          setLimitationAccepted(true);
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
    const intentStart = mutationIntents.begin(COMPLETE_ONBOARDING_INTENT);
    if (intentStart.status === "failed") {
      setError(publicRequestError(intentStart.error));
      return;
    }
    if (intentStart.status === "busy") {
      return;
    }
    const { requestNonce } = intentStart;
    setPending(true);
    setError(null);
    try {
      await refundDeskApi.updateSettings(
        context,
        {
          approver_user_ids: [userId],
          expiration_days: 7,
          onboarding_completed: true,
        },
        requestNonce,
      );
      mutationIntents.complete(COMPLETE_ONBOARDING_INTENT);
      setCompleted(true);
    } catch (onboardingError) {
      if (isDefinitiveMutationRejection(onboardingError)) {
        mutationIntents.complete(COMPLETE_ONBOARDING_INTENT);
      } else {
        mutationIntents.release(COMPLETE_ONBOARDING_INTENT);
      }
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
          <SectionHeading>Initial pilot policy</SectionHeading>
          <List>
            <ListItem title="One approver, always different from the requester" />
            <ListItem title="Requests expire after seven days" />
            <ListItem title="Audit and justifications retained for 365 days" />
            <ListItem title="No e-mail notifications, Billing, quota, or live execution" />
          </List>
        </Box>

        {completed ? (
          <Banner
            type="caution"
            title="One more person is needed"
            description="You are currently the only approver, and nobody may approve their own request. Ask a colleague to open RefundDesk once from the Stripe Dashboard, then tick them in Settings."
          />
        ) : null}

        <Banner
          title="Guided sandbox test"
          description="After setup, open a synthetic card PaymentIntent, submit a request, and have a different approver decide it through the normal workflow."
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

export default function Onboarding(context: ExtensionContextValue) {
  return <OnboardingViewContent key={viewContextKey(context, false)} context={context} />;
}
