import { useCallback, useEffect, useRef, useState } from "react";

import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import {
  Badge,
  Banner,
  Box,
  Button,
  ContextView,
  Divider,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  TextArea,
} from "@stripe/ui-extension-sdk/ui";

import {
  refundDeskApi,
  type ExternalAlert,
  type PaymentResource,
  type RefundRequestSummary,
  type WorkflowStatus,
} from "../api/client";
import { MutationIntentRegistry } from "../api/mutation-intent";
import {
  createRequestNonce,
  isAdministrator,
  isDefinitiveMutationRejection,
  publicRequestError,
} from "../api/signed-fetch";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState";
import {
  PilotLimitationNotice,
  PilotModeBanner,
  PilotModeLabel,
} from "../components/PilotModeBanner";
import { formatMinorAmount } from "../money";
import { viewContextKey } from "../view-context";

type RequestScope = "all_activity" | "awaiting_my_approval" | "my_requests";

function isRequestScope(value: string): value is RequestScope {
  return value === "all_activity" || value === "awaiting_my_approval" || value === "my_requests";
}

function statusBadgeType(
  status: WorkflowStatus,
): "info" | "negative" | "neutral" | "positive" | "warning" {
  if (status === "succeeded") {
    return "positive";
  }
  if (status === "rejected" || status === "failed_terminal") {
    return "negative";
  }
  if (status === "pending_approval" || status === "approved") {
    return "warning";
  }
  if (status === "executing" || status === "reconciliation_required") {
    return "info";
  }
  return "neutral";
}

function itemResource(item: RefundRequestSummary): PaymentResource {
  return {
    resourceType: item.resource_type,
    resourceId: item.resource_id,
  };
}

function refundReasonLabel(reason: RefundRequestSummary["reason"]): string {
  if (reason === "requested_by_customer") {
    return "Requested by customer";
  }
  return reason === "fraudulent" ? "Fraudulent" : "Duplicate";
}

function RefundRequestCard({
  actionsDisabled,
  approvalUnderReview,
  busy,
  item,
  rejectionNote,
  onApprove,
  onCancel,
  onDismissApproval,
  onNoteChange,
  onReject,
  onReviewApproval,
}: {
  readonly actionsDisabled: boolean;
  readonly approvalUnderReview: boolean;
  readonly busy: boolean;
  readonly item: RefundRequestSummary;
  readonly rejectionNote: string;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  readonly onDismissApproval: () => void;
  readonly onNoteChange: (value: string) => void;
  readonly onReject: () => void;
  readonly onReviewApproval: () => void;
}) {
  const selfApprovalBlocked = item.is_requester && item.status === "pending_approval";
  return (
    <Box
      css={{
        stack: "y",
        gap: "small",
        padding: "medium",
        backgroundColor: "container",
        borderRadius: "medium",
      }}
    >
      <Box css={{ stack: "x", gap: "small", distribute: "space-between" }}>
        <Box>{formatMinorAmount(item.amount_minor, item.currency)}</Box>
        <Badge type={statusBadgeType(item.status)}>{item.status}</Badge>
      </Box>
      <Box>Request {item.id}</Box>
      <Box>Payment {item.resource_id}</Box>
      <Box>Requested by {item.requester_user_id}</Box>
      <Box>Stripe reason: {refundReasonLabel(item.reason)}</Box>
      <Box>Created {item.created_at}</Box>
      {item.justification === null ? null : (
        <Box>Requester justification: {item.justification}</Box>
      )}

      {selfApprovalBlocked ? (
        <Banner
          type="caution"
          title="Self-approval is prohibited"
          description="The requester must wait for a different eligible approver."
        />
      ) : null}

      {item.can_decide && !item.is_requester ? (
        <>
          {approvalUnderReview ? (
            <Banner
              type="caution"
              title="Confirm this refund approval"
              description={`Approving queues a ${formatMinorAmount(item.amount_minor, item.currency)} refund for payment ${item.resource_id}. RefundDesk cannot undo it after Stripe executes it.`}
            />
          ) : (
            <TextArea
              label="Rejection reason"
              description="Required only when rejecting; 10 to 2,000 characters."
              value={rejectionNote}
              minLength={10}
              maxLength={2_000}
              rows={3}
              onChange={(event) => {
                onNoteChange(event.target.value);
              }}
              disabled={actionsDisabled}
            />
          )}
          <Box css={{ stack: "x", gap: "small", wrap: "wrap" }}>
            <Button
              type="primary"
              pending={busy}
              disabled={actionsDisabled}
              onPress={approvalUnderReview ? onApprove : onReviewApproval}
            >
              {approvalUnderReview ? "Approve and queue refund" : "Review approval"}
            </Button>
            {approvalUnderReview ? (
              <Button type="secondary" disabled={actionsDisabled} onPress={onDismissApproval}>
                Back
              </Button>
            ) : null}
            <Button
              type="destructive"
              pending={busy}
              disabled={approvalUnderReview || actionsDisabled || rejectionNote.trim().length < 10}
              onPress={onReject}
            >
              Reject
            </Button>
          </Box>
        </>
      ) : null}

      {item.can_cancel ? (
        <Button type="secondary" pending={busy} disabled={actionsDisabled} onPress={onCancel}>
          Cancel request
        </Button>
      ) : null}
    </Box>
  );
}

function ExternalAlertCard({
  actionsDisabled,
  alert,
  busy,
  onAcknowledge,
}: {
  readonly actionsDisabled: boolean;
  readonly alert: ExternalAlert;
  readonly busy: boolean;
  readonly onAcknowledge: () => void;
}) {
  const classificationLabel =
    alert.classification === "proof_replay"
      ? "Copied RefundDesk proof"
      : alert.classification === "tampered"
        ? "Invalid RefundDesk metadata"
        : "Outside RefundDesk";
  return (
    <Box
      css={{
        stack: "y",
        gap: "small",
        padding: "medium",
        backgroundColor: "container",
        borderRadius: "medium",
      }}
    >
      <Box css={{ stack: "x", gap: "small", distribute: "space-between" }}>
        <Box>{formatMinorAmount(alert.amount_minor, alert.currency)}</Box>
        <Badge type={alert.acknowledged ? "neutral" : "warning"}>
          {alert.acknowledged ? "Acknowledged" : "Needs review"}
        </Badge>
      </Box>
      <Box>Stripe Refund {alert.refund_id}</Box>
      <Box>Classification: {classificationLabel}</Box>
      <Box>Detected {alert.detected_at}</Box>
      {alert.classification === "proof_replay" || alert.classification === "tampered" ? (
        <Banner
          type="critical"
          title="Possible workflow-proof falsification"
          description="This Refund must be investigated; it cannot replace the first Refund linked to a RefundDesk request."
        />
      ) : null}
      {!alert.acknowledged ? (
        <>
          <Box>
            Acknowledging records review only; it does not reconcile the Refund or release its
            financial protection.
          </Box>
          <Button
            type="secondary"
            pending={busy}
            disabled={actionsDisabled}
            onPress={onAcknowledge}
          >
            Acknowledge review
          </Button>
        </>
      ) : null}
    </Box>
  );
}

function RefundDrawerView({ context }: { readonly context: ExtensionContextValue }) {
  const liveMode = context.environment.mode === "live";
  const [scope, setScope] = useState<RequestScope>("my_requests");
  const [requests, setRequests] = useState<RefundRequestSummary[]>([]);
  const [requestCursor, setRequestCursor] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<ExternalAlert[]>([]);
  const [alertCursor, setAlertCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [alertLoading, setAlertLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approvalReviewId, setApprovalReviewId] = useState<string | null>(null);
  const [rejectionNotes, setRejectionNotes] = useState<Record<string, string>>({});
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadExpiresAt, setDownloadExpiresAt] = useState<string | null>(null);
  const [currentUserIsApprover, setCurrentUserIsApprover] = useState(false);
  const [contextLoaded, setContextLoaded] = useState(false);
  const requestSequence = useRef(0);
  const alertSequence = useRef(0);
  const [mutationIntents] = useState(() => new MutationIntentRegistry(createRequestNonce));
  const administrator = isAdministrator(context);

  const loadRequests = useCallback(
    async (cursor?: string, append = false) => {
      if (liveMode) {
        setLoading(false);
        return;
      }
      const sequence = ++requestSequence.current;
      setLoading(true);
      setError(null);
      try {
        const response = await refundDeskApi.listRefundRequests(context, scope, cursor);
        if (sequence !== requestSequence.current) {
          return;
        }
        setRequests((current) => (append ? [...current, ...response.items] : response.items));
        setRequestCursor(response.next_cursor);
      } catch (requestError) {
        if (sequence === requestSequence.current) {
          setError(publicRequestError(requestError));
        }
      } finally {
        if (sequence === requestSequence.current) {
          setLoading(false);
        }
      }
    },
    [context, liveMode, scope],
  );

  const loadAlerts = useCallback(
    async (cursor?: string, append = false) => {
      if (liveMode) {
        return;
      }
      const sequence = ++alertSequence.current;
      setAlertLoading(true);
      try {
        const response = await refundDeskApi.listExternalAlerts(context, cursor);
        if (sequence !== alertSequence.current) {
          return;
        }
        setAlerts((current) => (append ? [...current, ...response.items] : response.items));
        setAlertCursor(response.next_cursor);
      } catch (alertError) {
        if (sequence === alertSequence.current) {
          setError(publicRequestError(alertError));
        }
      } finally {
        if (sequence === alertSequence.current) {
          setAlertLoading(false);
        }
      }
    },
    [context, liveMode],
  );

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    if (liveMode) {
      setContextLoaded(true);
      return;
    }
    let active = true;
    const loadContext = async () => {
      try {
        const response = await refundDeskApi.syncContext(context);
        if (!active) {
          return;
        }
        setCurrentUserIsApprover(response.current_user_is_approver);
        if (response.current_user_is_approver) {
          await loadAlerts();
        }
      } catch (contextError) {
        if (active) {
          setError(publicRequestError(contextError));
        }
      } finally {
        if (active) {
          setContextLoaded(true);
        }
      }
    };
    void loadContext();
    return () => {
      active = false;
    };
  }, [context, liveMode, loadAlerts]);

  const decide = async (item: RefundRequestSummary, decision: "approve" | "reject") => {
    if (item.is_requester) {
      setError("A requester cannot approve or reject their own request.");
      return;
    }
    const note = rejectionNotes[item.id]?.trim();
    if (decision === "reject" && (note === undefined || note.length < 10)) {
      setError("Provide at least 10 characters before rejecting.");
      return;
    }

    const intentKey = `refund-request:decide:${item.id}:${decision}`;
    const intentStart = mutationIntents.begin(intentKey);
    if (intentStart.status === "failed") {
      setError(publicRequestError(intentStart.error));
      return;
    }
    if (intentStart.status === "busy") {
      return;
    }
    const { requestNonce } = intentStart;
    setBusyId(item.id);
    setError(null);
    try {
      await refundDeskApi.decideRefundRequest(
        context,
        itemResource(item),
        {
          request_id: item.id,
          decision,
          ...(decision === "reject" && note !== undefined ? { justification: note } : {}),
        },
        requestNonce,
      );
      mutationIntents.complete(intentKey);
      if (decision === "approve") {
        setApprovalReviewId(null);
      } else {
        setRejectionNotes((current) => ({ ...current, [item.id]: "" }));
      }
      await loadRequests();
    } catch (decisionError) {
      if (isDefinitiveMutationRejection(decisionError)) {
        mutationIntents.complete(intentKey);
      } else {
        mutationIntents.release(intentKey);
      }
      setError(publicRequestError(decisionError));
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (item: RefundRequestSummary) => {
    const intentKey = `refund-request:cancel:${item.id}`;
    const intentStart = mutationIntents.begin(intentKey);
    if (intentStart.status === "failed") {
      setError(publicRequestError(intentStart.error));
      return;
    }
    if (intentStart.status === "busy") {
      return;
    }
    const { requestNonce } = intentStart;
    setBusyId(item.id);
    setError(null);
    try {
      await refundDeskApi.cancelRefundRequest(context, itemResource(item), item.id, requestNonce);
      mutationIntents.complete(intentKey);
      await loadRequests();
    } catch (cancelError) {
      if (isDefinitiveMutationRejection(cancelError)) {
        mutationIntents.complete(intentKey);
      } else {
        mutationIntents.release(intentKey);
      }
      setError(publicRequestError(cancelError));
    } finally {
      setBusyId(null);
    }
  };

  const acknowledge = async (alert: ExternalAlert) => {
    const intentKey = `external-alert:acknowledge:${alert.id}`;
    const intentStart = mutationIntents.begin(intentKey);
    if (intentStart.status === "failed") {
      setError(publicRequestError(intentStart.error));
      return;
    }
    if (intentStart.status === "busy") {
      return;
    }
    const { requestNonce } = intentStart;
    setBusyId(alert.id);
    setError(null);
    try {
      await refundDeskApi.acknowledgeExternalAlert(context, alert.id, requestNonce);
      mutationIntents.complete(intentKey);
      await loadAlerts();
    } catch (acknowledgeError) {
      if (isDefinitiveMutationRejection(acknowledgeError)) {
        mutationIntents.complete(intentKey);
      } else {
        mutationIntents.release(intentKey);
      }
      setError(publicRequestError(acknowledgeError));
    } finally {
      setBusyId(null);
    }
  };

  const exportAudit = async () => {
    const intentKey = "audit:export";
    const intentStart = mutationIntents.begin(intentKey);
    if (intentStart.status === "failed") {
      setError(publicRequestError(intentStart.error));
      return;
    }
    if (intentStart.status === "busy") {
      return;
    }
    const { requestNonce } = intentStart;
    setBusyId("audit-export");
    setError(null);
    try {
      const response = await refundDeskApi.createAuditExport(context, requestNonce);
      mutationIntents.complete(intentKey);
      setDownloadUrl(response.download_url);
      setDownloadExpiresAt(response.expires_at);
    } catch (exportError) {
      if (isDefinitiveMutationRejection(exportError)) {
        mutationIntents.complete(intentKey);
      } else {
        mutationIntents.release(intentKey);
      }
      setError(publicRequestError(exportError));
    } finally {
      setBusyId(null);
    }
  };

  const requestCards = (
    <Box css={{ stack: "y", gap: "medium" }}>
      {loading ? <LoadingState label="Loading refund requests…" /> : null}
      {!loading && requests.length === 0 ? (
        <EmptyState message="No refund requests in this view." />
      ) : null}
      {requests.map((item) => (
        <RefundRequestCard
          key={item.id}
          item={item}
          actionsDisabled={busyId !== null}
          approvalUnderReview={approvalReviewId === item.id}
          busy={busyId === item.id}
          rejectionNote={rejectionNotes[item.id] ?? ""}
          onNoteChange={(value) => {
            mutationIntents.reset(`refund-request:decide:${item.id}:reject`);
            setRejectionNotes((current) => ({
              ...current,
              [item.id]: value,
            }));
          }}
          onApprove={() => {
            void decide(item, "approve");
          }}
          onReviewApproval={() => {
            setError(null);
            setApprovalReviewId(item.id);
          }}
          onDismissApproval={() => {
            setApprovalReviewId(null);
          }}
          onReject={() => {
            void decide(item, "reject");
          }}
          onCancel={() => {
            void cancel(item);
          }}
        />
      ))}
      {requestCursor === null ? null : (
        <Button
          type="secondary"
          pending={loading}
          disabled={loading}
          onPress={() => {
            void loadRequests(requestCursor, true);
          }}
        >
          Load more
        </Button>
      )}
      <Button
        type="secondary"
        disabled={loading || busyId !== null}
        onPress={() => {
          void loadRequests();
        }}
      >
        Refresh requests
      </Button>
    </Box>
  );

  return (
    <ContextView
      title="Refund workflows"
      description="Approve another person’s request, follow your own requests, and review external refunds."
      banner={<PilotModeBanner context={context} />}
    >
      <Box css={{ stack: "y", gap: "large" }}>
        <Box css={{ stack: "x", gap: "small", alignY: "center" }}>
          <PilotModeLabel context={context} />
          <Box>Self-approval is always blocked.</Box>
        </Box>
        <PilotLimitationNotice />
        {error === null ? null : <ErrorState message={error} />}

        {!liveMode ? (
          <Tabs
            selectedKey={scope}
            onSelectionChange={(value) => {
              if (isRequestScope(value)) {
                if (busyId !== null) {
                  setError("Wait for the current workflow action before changing views.");
                  return;
                }
                if (value !== "my_requests" && !currentUserIsApprover) {
                  setError("Only an explicit approver can open this activity view.");
                  return;
                }
                if (value === scope) {
                  return;
                }
                setApprovalReviewId(null);
                requestSequence.current += 1;
                setRequests([]);
                setRequestCursor(null);
                setLoading(true);
                setScope(value);
              }
            }}
          >
            <TabList>
              <Tab id="my_requests">My requests</Tab>
              <Tab id="awaiting_my_approval">Awaiting my approval</Tab>
              <Tab id="all_activity">All activity</Tab>
            </TabList>
            <TabPanels>
              <TabPanel id="my_requests">{requestCards}</TabPanel>
              <TabPanel id="awaiting_my_approval">{requestCards}</TabPanel>
              <TabPanel id="all_activity">{requestCards}</TabPanel>
            </TabPanels>
          </Tabs>
        ) : null}

        <Divider />
        <Box css={{ stack: "y", gap: "medium" }}>
          <Box>Refunds detected outside RefundDesk</Box>
          {contextLoaded && !currentUserIsApprover ? (
            <Banner
              type="caution"
              title="Explicit approvers only"
              description="External refund alerts are available only to a configured RefundDesk approver."
            />
          ) : null}
          {alertLoading ? <LoadingState label="Loading external refund alerts…" /> : null}
          {currentUserIsApprover && !alertLoading && alerts.length === 0 ? (
            <EmptyState message="No external refund alert needs review." />
          ) : null}
          {alerts.map((alert) => (
            <ExternalAlertCard
              key={alert.id}
              alert={alert}
              actionsDisabled={busyId !== null}
              busy={busyId === alert.id}
              onAcknowledge={() => {
                void acknowledge(alert);
              }}
            />
          ))}
          {alertCursor === null ? null : (
            <Button
              type="secondary"
              pending={alertLoading}
              disabled={busyId !== null || alertLoading}
              onPress={() => {
                void loadAlerts(alertCursor, true);
              }}
            >
              Load more alerts
            </Button>
          )}
        </Box>

        <Divider />
        <Box css={{ stack: "y", gap: "small" }}>
          <Button
            type="secondary"
            pending={busyId === "audit-export"}
            disabled={
              liveMode ||
              busyId !== null ||
              !contextLoaded ||
              (!administrator && !currentUserIsApprover)
            }
            onPress={() => {
              void exportAudit();
            }}
          >
            Prepare audit CSV
          </Button>
          {downloadUrl === null ? null : (
            <>
              <Box>
                This redacted link expires at {downloadExpiresAt ?? "the server-provided time"}.
              </Box>
              <Button href={downloadUrl} target="_blank" type="primary">
                Download audit CSV
              </Button>
            </>
          )}
        </Box>
      </Box>
    </ContextView>
  );
}

export default function RefundDrawer(context: ExtensionContextValue) {
  return <RefundDrawerView key={viewContextKey(context, false)} context={context} />;
}
