import { useCallback, useEffect, useState } from "react";

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
import { isAdministrator, publicRequestError } from "../api/signed-fetch";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState";
import {
  PilotLimitationNotice,
  PilotModeBanner,
  PilotModeLabel,
} from "../components/PilotModeBanner";

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

function RefundRequestCard({
  busy,
  item,
  rejectionNote,
  onApprove,
  onCancel,
  onNoteChange,
  onReject,
}: {
  readonly busy: boolean;
  readonly item: RefundRequestSummary;
  readonly rejectionNote: string;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  readonly onNoteChange: (value: string) => void;
  readonly onReject: () => void;
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
        <Box>
          {item.amount_minor} {item.currency.toUpperCase()}
        </Box>
        <Badge type={statusBadgeType(item.status)}>{item.status}</Badge>
      </Box>
      <Box>Request {item.id}</Box>
      <Box>Payment {item.resource_id}</Box>
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
            disabled={busy}
          />
          <Box css={{ stack: "x", gap: "small" }}>
            <Button type="primary" pending={busy} disabled={busy} onPress={onApprove}>
              Approve
            </Button>
            <Button
              type="destructive"
              pending={busy}
              disabled={busy || rejectionNote.trim().length < 10}
              onPress={onReject}
            >
              Reject
            </Button>
          </Box>
        </>
      ) : null}

      {item.can_cancel ? (
        <Button type="secondary" pending={busy} disabled={busy} onPress={onCancel}>
          Cancel request
        </Button>
      ) : null}
    </Box>
  );
}

function ExternalAlertCard({
  alert,
  busy,
  onAcknowledge,
}: {
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
        <Box>
          {alert.amount_minor} {alert.currency.toUpperCase()}
        </Box>
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
        <Button type="secondary" pending={busy} disabled={busy} onPress={onAcknowledge}>
          Acknowledge
        </Button>
      ) : null}
    </Box>
  );
}

export default function RefundDrawer(context: ExtensionContextValue) {
  const liveMode = context.environment.mode === "live";
  const [scope, setScope] = useState<RequestScope>("my_requests");
  const [requests, setRequests] = useState<RefundRequestSummary[]>([]);
  const [requestCursor, setRequestCursor] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<ExternalAlert[]>([]);
  const [alertCursor, setAlertCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectionNotes, setRejectionNotes] = useState<Record<string, string>>({});
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [currentUserIsApprover, setCurrentUserIsApprover] = useState(false);
  const [contextLoaded, setContextLoaded] = useState(false);
  const administrator = isAdministrator(context);

  const loadRequests = useCallback(
    async (cursor?: string, append = false) => {
      if (liveMode) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const response = await refundDeskApi.listRefundRequests(context, scope, cursor);
        setRequests((current) => (append ? [...current, ...response.items] : response.items));
        setRequestCursor(response.next_cursor);
      } catch (requestError) {
        setError(publicRequestError(requestError));
      } finally {
        setLoading(false);
      }
    },
    [context, liveMode, scope],
  );

  const loadAlerts = useCallback(
    async (cursor?: string, append = false) => {
      if (liveMode) {
        return;
      }
      try {
        const response = await refundDeskApi.listExternalAlerts(context, cursor);
        setAlerts((current) => (append ? [...current, ...response.items] : response.items));
        setAlertCursor(response.next_cursor);
      } catch (alertError) {
        setError(publicRequestError(alertError));
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

    setBusyId(item.id);
    setError(null);
    try {
      await refundDeskApi.decideRefundRequest(context, itemResource(item), {
        request_id: item.id,
        decision,
        ...(decision === "reject" && note !== undefined ? { justification: note } : {}),
      });
      await loadRequests();
    } catch (decisionError) {
      setError(publicRequestError(decisionError));
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (item: RefundRequestSummary) => {
    setBusyId(item.id);
    setError(null);
    try {
      await refundDeskApi.cancelRefundRequest(context, itemResource(item), item.id);
      await loadRequests();
    } catch (cancelError) {
      setError(publicRequestError(cancelError));
    } finally {
      setBusyId(null);
    }
  };

  const acknowledge = async (alert: ExternalAlert) => {
    setBusyId(alert.id);
    setError(null);
    try {
      await refundDeskApi.acknowledgeExternalAlert(context, alert.id);
      await loadAlerts();
    } catch (acknowledgeError) {
      setError(publicRequestError(acknowledgeError));
    } finally {
      setBusyId(null);
    }
  };

  const exportAudit = async () => {
    setBusyId("audit-export");
    setError(null);
    try {
      const response = await refundDeskApi.createAuditExport(context);
      setDownloadUrl(response.download_url);
    } catch (exportError) {
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
          busy={busyId === item.id}
          rejectionNote={rejectionNotes[item.id] ?? ""}
          onNoteChange={(value) => {
            setRejectionNotes((current) => ({
              ...current,
              [item.id]: value,
            }));
          }}
          onApprove={() => {
            void decide(item, "approve");
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
                if (value !== "my_requests" && !currentUserIsApprover) {
                  setError("Only an explicit approver can open this activity view.");
                  return;
                }
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
          {currentUserIsApprover && alerts.length === 0 ? (
            <EmptyState message="No external refund alert needs review." />
          ) : null}
          {alerts.map((alert) => (
            <ExternalAlertCard
              key={alert.id}
              alert={alert}
              busy={busyId === alert.id}
              onAcknowledge={() => {
                void acknowledge(alert);
              }}
            />
          ))}
          {alertCursor === null ? null : (
            <Button
              type="secondary"
              disabled={busyId !== null}
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
            <Button href={downloadUrl} target="_blank" type="primary">
              Download audit CSV
            </Button>
          )}
        </Box>
      </Box>
    </ContextView>
  );
}
