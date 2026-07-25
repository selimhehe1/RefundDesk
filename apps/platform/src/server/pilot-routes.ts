import type { PilotOperation } from "@refunddesk/contracts";

export type PilotRouteName =
  | "alertAcknowledge"
  | "alertList"
  | "auditExport"
  | "contextSync"
  | "paymentEligibility"
  | "refundRequestCancel"
  | "refundRequestCreate"
  | "refundRequestDecide"
  | "refundRequestGet"
  | "refundRequestList"
  | "settingsGet"
  | "settingsUpdate";

export interface PilotRouteSpec {
  readonly operation: PilotOperation;
  readonly path: `/api/v1/${string}`;
  readonly resource: "account" | "payment";
  readonly mutation: boolean;
}

export const PILOT_ROUTE_SPECS = {
  contextSync: {
    operation: "context.sync",
    path: "/api/v1/context/sync",
    resource: "account",
    mutation: true,
  },
  paymentEligibility: {
    operation: "payment.eligibility",
    path: "/api/v1/payments/eligibility",
    resource: "payment",
    mutation: false,
  },
  refundRequestCreate: {
    operation: "refund_request.create",
    path: "/api/v1/refund-requests/create",
    resource: "payment",
    mutation: true,
  },
  refundRequestList: {
    operation: "refund_request.list",
    path: "/api/v1/refund-requests/list",
    resource: "account",
    mutation: false,
  },
  refundRequestGet: {
    operation: "refund_request.get",
    path: "/api/v1/refund-requests/get",
    resource: "payment",
    mutation: false,
  },
  refundRequestDecide: {
    operation: "refund_request.decide",
    path: "/api/v1/refund-requests/decide",
    resource: "payment",
    mutation: true,
  },
  refundRequestCancel: {
    operation: "refund_request.cancel",
    path: "/api/v1/refund-requests/cancel",
    resource: "payment",
    mutation: true,
  },
  alertList: {
    operation: "external_alert.list",
    path: "/api/v1/external-alerts/list",
    resource: "account",
    mutation: false,
  },
  alertAcknowledge: {
    operation: "external_alert.acknowledge",
    path: "/api/v1/external-alerts/acknowledge",
    resource: "account",
    mutation: true,
  },
  settingsGet: {
    operation: "settings.get",
    path: "/api/v1/settings/get",
    resource: "account",
    mutation: false,
  },
  settingsUpdate: {
    operation: "settings.update",
    path: "/api/v1/settings/update",
    resource: "account",
    mutation: true,
  },
  auditExport: {
    operation: "audit.export",
    path: "/api/v1/audit/export",
    resource: "account",
    mutation: true,
  },
} as const satisfies Readonly<Record<PilotRouteName, PilotRouteSpec>>;
