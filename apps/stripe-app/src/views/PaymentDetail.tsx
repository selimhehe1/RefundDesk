import { useCallback, useEffect, useState } from "react";

import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import {
  Banner,
  Box,
  Button,
  Checkbox,
  ContextView,
  Divider,
  Select,
  TextArea,
  TextField,
} from "@stripe/ui-extension-sdk/ui";

import {
  getPaymentResource,
  refundDeskApi,
  refundReasonSchema,
  type EligibilityResponse,
  type RefundReason,
} from "../api/client";
import { publicRequestError } from "../api/signed-fetch";
import { ErrorState, LoadingState } from "../components/AsyncState";
import {
  PilotLimitationNotice,
  PilotModeBanner,
  PilotModeLabel,
} from "../components/PilotModeBanner";
import { getPhase0ControlAvailability } from "../phase0-controls";
import { validateRefundForm, type RefundFormErrors } from "../validation";

function hasErrors(errors: RefundFormErrors): boolean {
  return errors.amount !== undefined || errors.justification !== undefined;
}

export default function PaymentDetail(context: ExtensionContextValue) {
  const paymentResource = getPaymentResource(context);
  const resourceType = paymentResource?.resourceType;
  const resourceId = paymentResource?.resourceId;
  const liveMode = context.environment.mode === "live";
  const [eligibility, setEligibility] = useState<EligibilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amountMinor, setAmountMinor] = useState("");
  const [reason, setReason] = useState<RefundReason>("requested_by_customer");
  const [justification, setJustification] = useState("");
  const [formErrors, setFormErrors] = useState<RefundFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [probeConfirmed, setProbeConfirmed] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [probeEvidence, setProbeEvidence] = useState<string | null>(null);
  const phase0Controls = getPhase0ControlAvailability(
    context,
    resourceType,
    resourceId,
    eligibility !== null,
  );

  const loadEligibility = useCallback(async () => {
    if (liveMode || resourceType === undefined || resourceId === undefined) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setLoadError(null);
    try {
      const response = await refundDeskApi.getEligibility(context, {
        resourceType,
        resourceId,
      });
      setEligibility(response);
      setAmountMinor(response.remaining_amount_minor);
    } catch (error) {
      setLoadError(publicRequestError(error));
    } finally {
      setLoading(false);
    }
  }, [context, liveMode, resourceId, resourceType]);

  useEffect(() => {
    void loadEligibility();
  }, [loadEligibility]);

  const submitRequest = async () => {
    if (eligibility === null || resourceType === undefined || resourceId === undefined) {
      return;
    }
    const errors = validateRefundForm(
      { amountMinor, justification, reason },
      eligibility.remaining_amount_minor,
    );
    setFormErrors(errors);
    if (hasErrors(errors)) {
      return;
    }

    setSubmitting(true);
    setSuccessMessage(null);
    try {
      const response = await refundDeskApi.createRefundRequest(
        context,
        { resourceType, resourceId },
        {
          amount_minor: amountMinor,
          currency: eligibility.currency,
          reason,
          justification: justification.trim(),
        },
      );
      setSuccessMessage(`Request ${response.request_id} is awaiting another approver.`);
      setJustification("");
      await loadEligibility();
    } catch (error) {
      setLoadError(publicRequestError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const runPhase0Probe = async () => {
    if (
      !phase0Controls.runRefundProbe ||
      eligibility === null ||
      resourceType !== "payment_intent" ||
      resourceId === undefined ||
      !probeConfirmed
    ) {
      return;
    }
    const errors = validateRefundForm(
      {
        amountMinor,
        justification: "Phase zero technical refund probe.",
        reason,
      },
      eligibility.remaining_amount_minor,
    );
    if (errors.amount !== undefined) {
      setFormErrors(errors);
      return;
    }

    setSubmitting(true);
    setProbeResult(null);
    try {
      const response = await refundDeskApi.runPhase0Probe(
        context,
        { resourceType, resourceId },
        {
          amount_minor: amountMinor,
          currency: eligibility.currency,
          reason,
        },
      );
      setProbeResult(
        `Test Refund ${response.refund_id} created; correlation: ${response.correlation}.`,
      );
      setProbeConfirmed(false);
      await loadEligibility();
    } catch (error) {
      setLoadError(publicRequestError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const refreshPhase0Evidence = async () => {
    if (
      !phase0Controls.refreshEvidence ||
      resourceType !== "payment_intent" ||
      resourceId === undefined
    ) {
      return;
    }
    setSubmitting(true);
    setProbeEvidence(null);
    try {
      const report = await refundDeskApi.getPhase0Report(context, { resourceType, resourceId });
      const latest = report.evidence.at(-1);
      setProbeEvidence(
        latest === undefined
          ? `${report.probe_count} probe(s) registered; no verified Refund webhook observed yet.`
          : `${report.evidence_count} verified observation(s); latest ${latest.refund_id} is ${latest.correlation}.`,
      );
    } catch (error) {
      setLoadError(publicRequestError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const initializePhase0Tenant = async () => {
    if (!phase0Controls.initializeTenant || loading) {
      return;
    }
    setSubmitting(true);
    setLoadError(null);
    try {
      await refundDeskApi.syncContext(context);
      await loadEligibility();
    } catch (error) {
      setLoadError(publicRequestError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const reasonChanged = (value: string) => {
    const parsed = refundReasonSchema.safeParse(value);
    if (parsed.success) {
      setReason(parsed.data);
    }
  };

  const activeRequest = eligibility?.active_request ?? null;
  const requestDisabled =
    liveMode || loading || submitting || eligibility?.eligible !== true || activeRequest !== null;

  return (
    <ContextView
      title="Refund approval"
      description="Request a partial or total card refund for another person to approve."
      banner={<PilotModeBanner context={context} />}
    >
      <Box css={{ stack: "y", gap: "medium" }}>
        <Box css={{ stack: "x", gap: "small", alignY: "center" }}>
          <PilotModeLabel context={context} />
          <Box>One approval is required.</Box>
        </Box>

        <PilotLimitationNotice />

        {liveMode ? <Box>No live request can be sent from this pilot.</Box> : null}
        {paymentResource === null ? (
          <ErrorState message="Open a Charge or PaymentIntent from the Stripe payment detail page." />
        ) : null}
        {loading ? <LoadingState label="Checking refund eligibility…" /> : null}
        {loadError === null ? null : <ErrorState message={loadError} />}
        {successMessage === null ? null : (
          <Banner title="Request submitted" description={successMessage} />
        )}
        {probeResult === null ? null : (
          <Banner title="Technical probe completed" description={probeResult} />
        )}
        {probeEvidence === null ? null : (
          <Banner title="Phase-0 evidence" description={probeEvidence} />
        )}

        {eligibility === null ? null : (
          <>
            {!eligibility.eligible ? (
              <Banner
                type="caution"
                title="Payment is not eligible"
                description={
                  eligibility.ineligible_reason ??
                  "Only captured, undisputed card payments without Connect semantics are supported."
                }
              />
            ) : null}
            {activeRequest === null ? null : (
              <Banner
                title="A request is already active"
                description={`Request ${activeRequest.id} is ${activeRequest.status}. A new request remains blocked while it is non-terminal or its Refund is unresolved.`}
              />
            )}

            <TextField
              name="amount_minor"
              label="Refund amount (minor units)"
              description={`Refundable balance: ${eligibility.remaining_amount_minor} ${eligibility.currency.toUpperCase()} in minor units.`}
              type="text"
              value={amountMinor}
              onChange={(event) => {
                setAmountMinor(event.target.value);
                setFormErrors({});
              }}
              error={formErrors.amount}
              required
              disabled={requestDisabled}
            />
            <Select
              name="reason"
              label="Stripe refund reason"
              value={reason}
              onChange={(event) => {
                reasonChanged(event.target.value);
              }}
              required
              disabled={requestDisabled}
            >
              <option value="requested_by_customer">Requested by customer</option>
              <option value="duplicate">Duplicate</option>
              <option value="fraudulent">Fraudulent</option>
            </Select>
            {reason === "fraudulent" ? (
              <Banner
                type="caution"
                title="Fraud reporting changes Stripe risk signals"
                description="Choose fraudulent only when the payment was genuinely unauthorized."
              />
            ) : null}
            <TextArea
              name="justification"
              label="Internal justification"
              description="Required for the approver. Between 10 and 2,000 characters."
              minLength={10}
              maxLength={2_000}
              rows={5}
              value={justification}
              onChange={(event) => {
                setJustification(event.target.value);
                setFormErrors({});
              }}
              error={formErrors.justification}
              required
              disabled={requestDisabled}
            />
            <Button
              type="primary"
              pending={submitting}
              disabled={requestDisabled}
              onPress={() => {
                void submitRequest();
              }}
            >
              Request refund
            </Button>
          </>
        )}

        {phase0Controls.refreshEvidence ? (
          <>
            <Divider />
            <Banner
              title="Phase-0 signed evidence"
              description="Refreshing evidence sends a non-mutating Stripe-signed report request and creates no Refund. This development-only control is unavailable in the uploaded manifest."
            />
            {phase0Controls.initializeTenant ? (
              <>
                <Banner
                  title="Phase-0 local setup"
                  description="Initializing creates only the local test tenant and signed Stripe-user record. It does not create a Refund or call a live environment."
                />
                <Button
                  pending={submitting}
                  disabled={submitting || loading}
                  onPress={() => {
                    void initializePhase0Tenant();
                  }}
                >
                  Initialize test tenant
                </Button>
              </>
            ) : null}
            {phase0Controls.runRefundProbe && eligibility !== null ? (
              <>
                <Banner
                  type="caution"
                  title="Phase-0 technical refund probe"
                  description="This control creates an immediate Stripe test Refund and bypasses the approval workflow."
                />
                <Checkbox
                  label="I confirm this is an allowlisted synthetic PaymentIntent and understand that a test Refund will be created now."
                  checked={probeConfirmed}
                  onChange={(event) => {
                    setProbeConfirmed(event.target.checked);
                  }}
                />
                <Button
                  type="destructive"
                  pending={submitting}
                  disabled={
                    submitting ||
                    requestDisabled ||
                    !probeConfirmed ||
                    eligibility.eligible !== true
                  }
                  onPress={() => {
                    void runPhase0Probe();
                  }}
                >
                  Run technical refund probe
                </Button>
              </>
            ) : null}
            <Button
              pending={submitting}
              disabled={submitting}
              onPress={() => {
                void refreshPhase0Evidence();
              }}
            >
              Refresh verified webhook evidence
            </Button>
          </>
        ) : null}
      </Box>
    </ContextView>
  );
}
