import { useCallback, useEffect, useState } from "react";

import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import {
  Banner,
  Box,
  Button,
  ContextView,
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

  const reasonChanged = (value: string) => {
    const parsed = refundReasonSchema.safeParse(value);
    if (parsed.success) {
      setReason(parsed.data);
    }
  };

  const activeRequest = eligibility?.active_request ?? null;
  const requestDisabled =
    liveMode || loading || submitting || eligibility?.eligible !== true || activeRequest !== null;
  const cancelActiveRequest = async () => {
    if (
      activeRequest === null ||
      activeRequest.status !== "pending_approval" ||
      resourceType === undefined ||
      resourceId === undefined
    ) {
      return;
    }

    setSubmitting(true);
    setLoadError(null);
    setSuccessMessage(null);
    try {
      await refundDeskApi.cancelRefundRequest(
        context,
        { resourceType, resourceId },
        activeRequest.id,
      );
      setSuccessMessage(`Request ${activeRequest.id} was canceled before execution.`);
      await loadEligibility();
    } catch (error) {
      setLoadError(publicRequestError(error));
    } finally {
      setSubmitting(false);
    }
  };

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
          <Banner
            title={
              successMessage.includes("was canceled") ? "Request canceled" : "Request submitted"
            }
            description={successMessage}
          />
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
              <>
                <Banner
                  title="A request is already active"
                  description={`Request ${activeRequest.id} is ${activeRequest.status}. A new request remains blocked while it is non-terminal or its Refund is unresolved.`}
                />
                {activeRequest.can_cancel ? (
                  <Button
                    type="secondary"
                    pending={submitting}
                    disabled={submitting}
                    onPress={() => {
                      void cancelActiveRequest();
                    }}
                  >
                    Cancel my pending request
                  </Button>
                ) : null}
              </>
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
      </Box>
    </ContextView>
  );
}
