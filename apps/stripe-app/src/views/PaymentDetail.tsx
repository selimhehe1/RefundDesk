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
import { MutationIntentRegistry } from "../api/mutation-intent";
import {
  createRequestNonce,
  isDefinitiveMutationRejection,
  publicRequestError,
} from "../api/signed-fetch";
import { ErrorState, LoadingState } from "../components/AsyncState";
import {
  PilotLimitationNotice,
  PilotModeBanner,
  PilotModeLabel,
} from "../components/PilotModeBanner";
import { formatMinorAsDecimal, parseAmountToMinor } from "../money";
import { refundReasonLabel, workflowStatusLabel } from "../presentation";
import { validateRefundForm, type RefundFormErrors } from "../validation";
import { viewContextKey } from "../view-context";

const CREATE_REQUEST_INTENT = "refund-request:create";

/**
 * The banner title is derived from this discriminant rather than by matching a
 * substring of the message shown to the user, which would break on any rewording.
 */
type RequestOutcome = {
  readonly kind: "submitted" | "canceled";
  readonly requestId: string;
};

const OUTCOME_TITLES: Readonly<Record<RequestOutcome["kind"], string>> = {
  submitted: "Request submitted",
  canceled: "Request canceled",
};

function outcomeDescription(outcome: RequestOutcome): string {
  return outcome.kind === "submitted"
    ? `Request ${outcome.requestId} is awaiting another approver.`
    : `Request ${outcome.requestId} was canceled before execution.`;
}

function hasErrors(errors: RefundFormErrors): boolean {
  return errors.amount !== undefined || errors.justification !== undefined;
}

function PaymentDetailView({ context }: { readonly context: ExtensionContextValue }) {
  const paymentResource = getPaymentResource(context);
  const resourceType = paymentResource?.resourceType;
  const resourceId = paymentResource?.resourceId;
  const liveMode = context.environment.mode === "live";
  const [eligibility, setEligibility] = useState<EligibilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // What the person types, in the payment's currency. Stripe minor units are derived from
  // it at submit time so nobody has to convert 25,00 EUR into 2500 by hand.
  const [amountInput, setAmountInput] = useState("");
  const [reason, setReason] = useState<RefundReason>("requested_by_customer");
  const [justification, setJustification] = useState("");
  const [formErrors, setFormErrors] = useState<RefundFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<RequestOutcome | null>(null);
  const [mutationIntents] = useState(() => new MutationIntentRegistry(createRequestNonce));

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
      setAmountInput(formatMinorAsDecimal(response.remaining_amount_minor, response.currency));
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
    const parsedAmount = parseAmountToMinor(amountInput, eligibility.currency);
    if ("error" in parsedAmount) {
      setFormErrors({ amount: parsedAmount.error });
      return;
    }
    const amountMinor = parsedAmount.minorAmount;
    const errors = validateRefundForm(
      { amountMinor, justification, reason },
      eligibility.remaining_amount_minor,
    );
    setFormErrors(errors);
    if (hasErrors(errors)) {
      return;
    }
    const intentStart = mutationIntents.begin(CREATE_REQUEST_INTENT);
    if (intentStart.status === "failed") {
      setLoadError(publicRequestError(intentStart.error));
      return;
    }
    if (intentStart.status === "busy") {
      return;
    }
    const { requestNonce } = intentStart;

    setSubmitting(true);
    setLoadError(null);
    setOutcome(null);
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
        requestNonce,
      );
      mutationIntents.complete(CREATE_REQUEST_INTENT);
      setOutcome({ kind: "submitted", requestId: response.request_id });
      setJustification("");
      await loadEligibility();
    } catch (error) {
      if (isDefinitiveMutationRejection(error)) {
        mutationIntents.complete(CREATE_REQUEST_INTENT);
      } else {
        mutationIntents.release(CREATE_REQUEST_INTENT);
      }
      setLoadError(publicRequestError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const reasonChanged = (value: string) => {
    const parsed = refundReasonSchema.safeParse(value);
    if (parsed.success) {
      mutationIntents.reset(CREATE_REQUEST_INTENT);
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

    const intentKey = `refund-request:cancel:${activeRequest.id}`;
    const intentStart = mutationIntents.begin(intentKey);
    if (intentStart.status === "failed") {
      setLoadError(publicRequestError(intentStart.error));
      return;
    }
    if (intentStart.status === "busy") {
      return;
    }
    const { requestNonce } = intentStart;
    setSubmitting(true);
    setLoadError(null);
    setOutcome(null);
    try {
      await refundDeskApi.cancelRefundRequest(
        context,
        { resourceType, resourceId },
        activeRequest.id,
        requestNonce,
      );
      mutationIntents.complete(intentKey);
      setOutcome({ kind: "canceled", requestId: activeRequest.id });
      await loadEligibility();
    } catch (error) {
      if (isDefinitiveMutationRejection(error)) {
        mutationIntents.complete(intentKey);
      } else {
        mutationIntents.release(intentKey);
      }
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
        {outcome === null ? null : (
          <Banner title={OUTCOME_TITLES[outcome.kind]} description={outcomeDescription(outcome)} />
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
                  description={`Request ${activeRequest.id} is ${workflowStatusLabel(activeRequest.status).toLowerCase()}. A new request remains blocked while it is non-terminal or its Refund is unresolved.`}
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
              name="amount"
              label={`Refund amount (${eligibility.currency.toUpperCase()})`}
              description={`Refundable balance: ${formatMinorAsDecimal(eligibility.remaining_amount_minor, eligibility.currency)} ${eligibility.currency.toUpperCase()}. Prefilled with the full amount; edit it for a partial refund.`}
              type="text"
              value={amountInput}
              onChange={(event) => {
                mutationIntents.reset(CREATE_REQUEST_INTENT);
                setAmountInput(event.target.value);
                setFormErrors({});
              }}
              invalid={formErrors.amount !== undefined}
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
              <option value="requested_by_customer">
                {refundReasonLabel("requested_by_customer")}
              </option>
              <option value="duplicate">{refundReasonLabel("duplicate")}</option>
              <option value="fraudulent">{refundReasonLabel("fraudulent")}</option>
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
                mutationIntents.reset(CREATE_REQUEST_INTENT);
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

export default function PaymentDetail(context: ExtensionContextValue) {
  return <PaymentDetailView key={viewContextKey(context, true)} context={context} />;
}
