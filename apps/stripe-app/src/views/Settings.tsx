import { useEffect, useState } from "react";

import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { Banner, Box, Checkbox, SettingsView, TextField } from "@stripe/ui-extension-sdk/ui";

import { refundDeskApi, type ObservedUser, type SettingsResponse } from "../api/client";
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
import { SectionHeading } from "../components/SectionHeading";
import { formatTimestamp } from "../presentation";
import { viewContextKey } from "../view-context";

/**
 * The status message carries the reason: it is the only text the settings shell
 * re-announces after a save, and the toolkit exposes no way to move focus to the field.
 */
const NOT_SAVED_INVALID_APPROVERS = "Not saved — choose at least one approver";

/**
 * Stripe supplies a display name only for people who have opened RefundDesk since this
 * version shipped, so the identifier stays as the fallback label rather than showing an
 * anonymous row.
 */
function observedUserLabel(user: ObservedUser, currentUserId: string | undefined): string {
  const name = user.display_name === null ? user.stripe_user_id : user.display_name;
  return user.stripe_user_id === currentUserId ? `${name} (you)` : name;
}

function SettingsViewContent({ context }: { readonly context: ExtensionContextValue }) {
  const liveMode = context.environment.mode === "live";
  const administrator = isAdministrator(context);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(!liveMode);
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [approverFieldError, setApproverFieldError] = useState<string | undefined>(undefined);
  const [selectedApprovers, setSelectedApprovers] = useState<ReadonlySet<string>>(new Set());
  const currentUserId = context.userContext.id;
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
          setSelectedApprovers(new Set(response.approver_user_ids));
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

  const save = async () => {
    const approverUserIds = [...selectedApprovers];
    if (approverUserIds.length === 0) {
      setApproverFieldError("Keep at least one person as an approver.");
      setError(null);
      setStatusMessage(NOT_SAVED_INVALID_APPROVERS);
      return;
    }
    setApproverFieldError(undefined);

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
      setSelectedApprovers(new Set(response.approver_user_ids));
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
          ? () => {
              void save();
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
            <Box css={{ stack: "y", gap: "small" }}>
              <SectionHeading>Who can approve refunds</SectionHeading>
              <Box>
                Tick each person allowed to approve. Being a Stripe Administrator is not enough —
                every approver is chosen here. A requester can never approve their own refund, so
                keep at least two people.
              </Box>
              {settings.observed_users.length === 0 ? (
                <Banner
                  type="caution"
                  title="Nobody to choose yet"
                  description="Ask your colleagues to open RefundDesk once from the Stripe Dashboard. They appear here as soon as they do."
                />
              ) : (
                settings.observed_users.map((user) => (
                  <Checkbox
                    key={user.stripe_user_id}
                    label={observedUserLabel(user, currentUserId)}
                    description={`Last opened RefundDesk ${formatTimestamp(user.last_seen_at)}`}
                    checked={selectedApprovers.has(user.stripe_user_id)}
                    disabled={!canSave}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setApproverFieldError(undefined);
                      setSelectedApprovers((current) => {
                        const next = new Set(current);
                        if (checked) {
                          next.add(user.stripe_user_id);
                        } else {
                          next.delete(user.stripe_user_id);
                        }
                        return next;
                      });
                    }}
                  />
                ))
              )}
              {approverFieldError === undefined ? null : (
                <Banner type="critical" title="Not saved" description={approverFieldError} />
              )}
            </Box>
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
