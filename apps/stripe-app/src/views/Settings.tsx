import { useEffect, useState } from "react";

import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { Banner, Box, SettingsView, TextArea, TextField } from "@stripe/ui-extension-sdk/ui";

import { refundDeskApi, type SettingsResponse } from "../api/client";
import { MutationIntentRegistry } from "../api/mutation-intent";
import {
  createRequestNonce,
  isAdministrator,
  isDefinitiveMutationRejection,
  publicRequestError,
} from "../api/signed-fetch";
import { LoadingState } from "../components/AsyncState";
import {
  PilotLimitationNotice,
  PilotModeBanner,
  PilotModeLabel,
} from "../components/PilotModeBanner";
import { parseApproverUserIdsStrict } from "../validation";
import { viewContextKey } from "../view-context";

function SettingsViewContent({ context }: { readonly context: ExtensionContextValue }) {
  const liveMode = context.environment.mode === "live";
  const administrator = isAdministrator(context);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(!liveMode);
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mutationIntents] = useState(() => new MutationIntentRegistry(createRequestNonce));

  useEffect(() => {
    if (liveMode) {
      setLoading(false);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const response = await refundDeskApi.getSettings(context);
        if (active) {
          setSettings(response);
        }
      } catch (settingsError) {
        if (active) {
          setError(publicRequestError(settingsError));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [context, liveMode]);

  const save = async (values: { readonly [key: string]: string }) => {
    const rawApprovers = values["approver_user_ids"] ?? "";
    const { approverUserIds, invalidValues } = parseApproverUserIdsStrict(rawApprovers);
    if (invalidValues.length > 0) {
      setError(
        "Every approver must be a Stripe user ID beginning with usr_. Remove names or e-mail addresses.",
      );
      setStatusMessage("Not saved");
      return;
    }
    if (approverUserIds.length === 0) {
      setError("Keep at least one eligible Stripe user ID as an approver.");
      setStatusMessage("Not saved");
      return;
    }

    const onboardingCompleted = settings?.onboarding_completed ?? true;
    const intentKey = `settings:update:${onboardingCompleted ? "complete" : "incomplete"}:${approverUserIds.join(",")}`;
    const intentStart = mutationIntents.begin(intentKey);
    if (intentStart.status === "failed") {
      setError(publicRequestError(intentStart.error));
      setStatusMessage("Not saved");
      return;
    }
    if (intentStart.status === "busy") {
      return;
    }
    const { requestNonce } = intentStart;
    setStatusMessage("Saving…");
    setError(null);
    try {
      const response = await refundDeskApi.updateSettings(
        context,
        {
          approver_user_ids: approverUserIds,
          expiration_days: 7,
          onboarding_completed: onboardingCompleted,
        },
        requestNonce,
      );
      mutationIntents.complete(intentKey);
      setSettings(response);
      setStatusMessage("Saved");
    } catch (saveError) {
      if (isDefinitiveMutationRejection(saveError)) {
        mutationIntents.complete(intentKey);
      } else {
        mutationIntents.release(intentKey);
      }
      setStatusMessage("Not saved");
      setError(publicRequestError(saveError));
    }
  };

  const canSave = !liveMode && administrator && settings !== null;

  return (
    <SettingsView
      statusMessage={statusMessage}
      onSave={
        canSave
          ? (values) => {
              void save(values);
            }
          : undefined
      }
    >
      <Box css={{ stack: "y", gap: "large" }}>
        <PilotModeBanner context={context} />
        <Box css={{ stack: "x", gap: "small", alignY: "center" }}>
          <PilotModeLabel context={context} />
          <Box>Live execution remains disabled by the pilot policy.</Box>
        </Box>
        <PilotLimitationNotice />

        {!administrator ? (
          <Banner
            type="caution"
            title="Read-only settings"
            description="Only a Stripe Administrator can update settings. The backend requires an explicit Stripe-signed Administrator role assertion."
          />
        ) : null}
        {error === null ? null : (
          <Banner type="critical" title="Settings unavailable" description={error} />
        )}
        {loading ? <LoadingState label="Loading settings…" /> : null}

        {settings === null ? null : (
          <>
            <TextArea
              name="approver_user_ids"
              label="Explicit approver Stripe user IDs"
              description="One usr_… ID per line. Administrators are not approvers automatically; every approver is explicitly saved."
              defaultValue={settings.approver_user_ids.join("\n")}
              rows={6}
              disabled={!canSave}
              required
            />
            <TextField
              name="approval_policy"
              label="Approval policy"
              defaultValue="1 approval; requester excluded"
              readOnly
            />
            <TextField
              name="expiration_days"
              label="Request expiration"
              defaultValue="7 days"
              readOnly
            />
            <TextField
              name="retention_days"
              label="Pilot audit retention"
              defaultValue="365 days"
              readOnly
            />
            <Banner
              title="Pilot services"
              description="Notifications are intentionally disabled. There is no Billing, trial, quota, or e-mail setting in this version."
            />
          </>
        )}
      </Box>
    </SettingsView>
  );
}

export default function Settings(context: ExtensionContextValue) {
  return <SettingsViewContent key={viewContextKey(context, false)} context={context} />;
}
