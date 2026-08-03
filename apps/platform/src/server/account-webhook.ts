import Stripe from "stripe";

import { loadPlatformConfig } from "@refunddesk/config";
import {
  findWebhookReceipt,
  normalizedAccountWebhookPayloadSchema,
  provisionWebhookInstallation,
  resolveInstallation,
  resolveWebhookInstallation,
  withTenantTransaction,
  type AccountWebhookEndpoint,
  type AccountWebhookEnvironment,
  type AccountWebhookEventType,
  type NormalizedAccountWebhookPayload,
  type PrismaClient,
  type WebhookReceiptInsertResult,
} from "@refunddesk/db";
import { createLogger } from "@refunddesk/observability";

import {
  EdgeAdmissionDeniedReason,
  getEdgeAdmissionGate,
  type EdgeAdmissionGate,
  type EdgeAdmissionLease,
} from "./edge-admission";
import {
  BoundedRequestBodyError,
  readBoundedRequestBody,
  REQUEST_BODY_DEADLINE_MS,
} from "./bounded-request-body";
import { apiError, jsonResponse } from "./http";
import { getPilotRuntime } from "./pilot-runtime";
import { SampledSignalEmitter } from "./sampled-signal-emitter";

export type AccountWebhookRouteEnvironment = "live" | "test" | "sandbox";

const MAX_WEBHOOK_BYTES = 1_048_576;
const TENANT_PURGE_DELAY_MILLISECONDS = 29 * 24 * 60 * 60 * 1_000;
const STRIPE_ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]+$/u;
// Stripe App lifecycle Events can retain the API version used when Stripe created
// the Event even when the receiving destination is configured for a newer version.
const STRIPE_APP_LIFECYCLE_SOURCE_API_VERSION = "2026-02-25.clover";
const SUPPORTED_EVENT_TYPES = new Set<AccountWebhookEventType>([
  "refund.created",
  "refund.updated",
  "refund.failed",
  "account.application.authorized",
  "account.application.deauthorized",
]);
const logger = createLogger("platform-webhook");
type WebhookIngressSignal =
  "edge_admission_unavailable" | "edge_rate_limited" | "webhook_source_rejected";
const edgeSignalEmitter = new SampledSignalEmitter<WebhookIngressSignal>({
  emit({ observedCount, signal, suppressedCount }) {
    logger.warn(
      {
        event: signal,
        observed_count: observedCount,
        suppressed_count: suppressedCount,
      },
      "Webhook ingress operational signal",
    );
  },
});

function emitEdgeSignal(event: WebhookIngressSignal): void {
  try {
    edgeSignalEmitter.emit(event);
  } catch {
    // Observability must never alter a fail-closed admission decision.
  }
}

function retryableEdgeResponse(status: 429 | 503, retryAfterSeconds: number): Response {
  const response = apiError(
    status === 429 ? "EDGE_RATE_LIMITED" : "EDGE_ADMISSION_UNAVAILABLE",
    status === 429
      ? "Webhook admission capacity is temporarily exhausted"
      : "Webhook admission is temporarily unavailable",
    status,
  );
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

function acquireWebhookAdmission(
  request: Request,
  gate: EdgeAdmissionGate,
): { readonly lease: EdgeAdmissionLease } | { readonly response: Response } {
  let decision;
  try {
    decision = gate.acquire(request.headers, "account_webhook");
  } catch {
    emitEdgeSignal("edge_admission_unavailable");
    return { response: retryableEdgeResponse(503, 60) };
  }
  if (decision.allowed) {
    return { lease: decision.lease };
  }
  if (decision.reason === EdgeAdmissionDeniedReason.WebhookSourceForbidden) {
    emitEdgeSignal("webhook_source_rejected");
    return {
      response: apiError("WEBHOOK_SOURCE_FORBIDDEN", "Webhook source is not accepted", 403),
    };
  }
  if (
    decision.status === 429 &&
    Number.isSafeInteger(decision.retryAfterSeconds) &&
    (decision.retryAfterSeconds ?? 0) > 0
  ) {
    emitEdgeSignal("edge_rate_limited");
    return { response: retryableEdgeResponse(429, decision.retryAfterSeconds ?? 1) };
  }
  emitEdgeSignal("edge_admission_unavailable");
  return { response: retryableEdgeResponse(503, 60) };
}

function supportsEventApiVersion(
  event: Stripe.Event,
  expectedApiVersion: AccountWebhookDependencies["expectedApiVersion"],
): boolean {
  if (event.api_version === expectedApiVersion) {
    return true;
  }
  return (
    (event.type === "account.application.authorized" ||
      event.type === "account.application.deauthorized") &&
    event.api_version === STRIPE_APP_LIFECYCLE_SOURCE_API_VERSION
  );
}

export interface ResolvedWebhookInstallation {
  readonly tenantId: string;
  readonly installationId: string;
  readonly applied: boolean;
}

export interface AccountWebhookPersistence {
  findExisting(
    endpoint: AccountWebhookEndpoint,
    stripeEventId: string,
    stripeAccountId: string,
  ): Promise<{ readonly receiptId: string } | null>;
  resolve(input: {
    readonly stripeAccountId: string;
    readonly environment: AccountWebhookEnvironment;
    readonly eventType: AccountWebhookEventType;
    readonly stripeEventId: string;
    readonly stripeEventCreatedAt: Date;
  }): Promise<ResolvedWebhookInstallation | null>;
  insert(input: {
    readonly resolved: ResolvedWebhookInstallation;
    readonly endpoint: AccountWebhookEndpoint;
    readonly stripeEventId: string;
    readonly stripeAccountId: string;
    readonly payload: NormalizedAccountWebhookPayload;
    readonly objectId: string;
    readonly receivedAt: Date;
  }): Promise<WebhookReceiptInsertResult>;
}

export interface AccountWebhookDependencies {
  readonly expectedApplicationId: string;
  readonly expectedAccountId: string;
  readonly expectedApiVersion: "2026-06-24.dahlia";
  /**
   * Ordered, active first. More than one entry only while a secret is being rolled: Stripe
   * signs with the secret current at send time and retries that same signature for days, so
   * the previous one has to stay acceptable until those retries drain. Verification stops at
   * the first secret that validates; every failure is reported identically.
   */
  readonly signingSecrets: readonly string[];
  readonly constructEvent: (
    rawBody: Buffer,
    signature: string,
    signingSecret: string,
  ) => Stripe.Event;
  readonly persistence: AccountWebhookPersistence;
  readonly now: () => Date;
}

class PrismaAccountWebhookPersistence implements AccountWebhookPersistence {
  constructor(private readonly client: PrismaClient) {}

  async findExisting(
    endpoint: AccountWebhookEndpoint,
    stripeEventId: string,
    stripeAccountId: string,
  ): Promise<{ readonly receiptId: string } | null> {
    const receipt = await findWebhookReceipt(this.client, endpoint, stripeEventId, stripeAccountId);
    return receipt === null ? null : { receiptId: receipt.receiptId };
  }

  async resolve(input: {
    readonly stripeAccountId: string;
    readonly environment: AccountWebhookEnvironment;
    readonly eventType: AccountWebhookEventType;
    readonly stripeEventId: string;
    readonly stripeEventCreatedAt: Date;
  }): Promise<ResolvedWebhookInstallation | null> {
    if (input.eventType === "account.application.authorized") {
      const provisioned = await provisionWebhookInstallation(
        this.client,
        input.stripeAccountId,
        input.environment,
        input.stripeEventId,
        input.stripeEventCreatedAt,
      );
      return {
        tenantId: provisioned.tenantId,
        installationId: provisioned.installationId,
        applied: provisioned.applied,
      };
    }
    const resolved =
      input.eventType === "account.application.deauthorized"
        ? await resolveWebhookInstallation(this.client, input.stripeAccountId, input.environment)
        : await resolveInstallation(this.client, input.stripeAccountId, input.environment);
    return resolved === null
      ? null
      : {
          tenantId: resolved.tenantId,
          installationId: resolved.installationId,
          applied: false,
        };
  }

  insert(input: {
    readonly resolved: ResolvedWebhookInstallation;
    readonly endpoint: AccountWebhookEndpoint;
    readonly stripeEventId: string;
    readonly stripeAccountId: string;
    readonly payload: NormalizedAccountWebhookPayload;
    readonly objectId: string;
    readonly receivedAt: Date;
  }): Promise<WebhookReceiptInsertResult> {
    return withTenantTransaction(this.client, input.resolved.tenantId, async ({ repositories }) => {
      const installation = await repositories.getInstallationContext(input.resolved.installationId);
      if (
        installation === null ||
        installation.stripeAccountId !== input.stripeAccountId ||
        installation.environment !== input.payload.environment ||
        installation.tenant.liveEnabled ||
        (input.payload.event_type.startsWith("refund.") &&
          (installation.status !== "active" || installation.tenant.status !== "active"))
      ) {
        throw new Error("WEBHOOK_INSTALLATION_MISMATCH");
      }
      const stripeEventCreatedAt = new Date(input.payload.event_created * 1_000);
      if (input.payload.event_type === "account.application.deauthorized") {
        await repositories.applyWebhookDeauthorization({
          installationId: input.resolved.installationId,
          stripeEventId: input.stripeEventId,
          stripeEventCreatedAt,
          purgeAt: new Date(stripeEventCreatedAt.getTime() + TENANT_PURGE_DELAY_MILLISECONDS),
        });
      }
      return repositories.insertWebhookReceipt({
        installationId: input.resolved.installationId,
        endpoint: input.endpoint,
        stripeEventId: input.stripeEventId,
        stripeAccountId: input.stripeAccountId,
        eventType: input.payload.event_type,
        objectId: input.objectId,
        normalizedPayload: input.payload,
        stripeCreatedAt: stripeEventCreatedAt,
        receivedAt: input.receivedAt,
      });
    });
  }
}

function accountEndpoint(
  endpoint: Exclude<AccountWebhookRouteEnvironment, "live">,
): AccountWebhookEndpoint {
  return endpoint === "test" ? "account_test" : "account_sandbox";
}

function environmentFor(
  endpoint: Exclude<AccountWebhookRouteEnvironment, "live">,
): AccountWebhookEnvironment {
  return endpoint;
}

function defaultDependencies(
  endpoint: Exclude<AccountWebhookRouteEnvironment, "live">,
): AccountWebhookDependencies {
  const config = loadPlatformConfig();
  const signingSecrets =
    endpoint === "test"
      ? [config.stripe.accountTestWebhookSecret, config.stripe.accountTestWebhookSecretPrevious]
      : [
          config.stripe.accountSandboxWebhookSecret,
          config.stripe.accountSandboxWebhookSecretPrevious,
        ];
  const expectedAccountId =
    endpoint === "test"
      ? config.stripe.platformTestAccountId
      : config.stripe.managedSandboxAccountId;
  return {
    expectedApplicationId: config.stripe.appId,
    expectedAccountId,
    expectedApiVersion: config.stripe.apiVersion,
    signingSecrets: signingSecrets.filter((secret): secret is string => secret !== undefined),
    constructEvent: (rawBody, signature, secret) =>
      Stripe.webhooks.constructEvent(rawBody, signature, secret, 300),
    persistence: new PrismaAccountWebhookPersistence(getPilotRuntime().client),
    now: () => new Date(),
  };
}

function referencedId(value: string | { readonly id: string } | null): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function metadataValue(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

function normalizeEvent(
  event: Stripe.Event,
  environment: AccountWebhookEnvironment,
): { readonly payload: NormalizedAccountWebhookPayload; readonly objectId: string } | null {
  if (!SUPPORTED_EVENT_TYPES.has(event.type as AccountWebhookEventType)) {
    return null;
  }
  const common = {
    schema_version: 1 as const,
    environment,
    event_created: event.created,
    event_idempotency_key: event.request?.idempotency_key ?? null,
  };
  if (
    event.type === "refund.created" ||
    event.type === "refund.updated" ||
    event.type === "refund.failed"
  ) {
    const refund = event.data.object;
    if (refund.source_transfer_reversal != null || refund.transfer_reversal != null) {
      throw new Error("CONNECT_REFUND_UNSUPPORTED");
    }
    const metadata = refund.metadata ?? {};
    const payload = normalizedAccountWebhookPayloadSchema.parse({
      ...common,
      event_type: event.type,
      refund: {
        refund_id: refund.id,
        payment_intent_id: referencedId(refund.payment_intent),
        charge_id: referencedId(refund.charge),
        amount_minor: String(refund.amount),
        currency: refund.currency.toLowerCase(),
        status: refund.status,
        created: refund.created,
        metadata_request_id: metadataValue(metadata["refunddesk_request_id"]),
        metadata_proof: metadataValue(metadata["refunddesk_proof"]),
      },
    });
    return { payload, objectId: refund.id };
  }
  if (
    event.type === "account.application.authorized" ||
    event.type === "account.application.deauthorized"
  ) {
    const application = event.data.object;
    const payload = normalizedAccountWebhookPayloadSchema.parse({
      ...common,
      event_type: event.type,
      application_id: application.id,
    });
    return { payload, objectId: application.id };
  }
  return null;
}

async function receiveAdmittedAccountWebhook(
  request: Request,
  endpoint: Exclude<AccountWebhookRouteEnvironment, "live">,
  injectedDependencies?: AccountWebhookDependencies,
  releaseVerificationLease: () => void = () => undefined,
  verificationDeadlineAtMs = Date.now() + REQUEST_BODY_DEADLINE_MS,
): Promise<Response> {
  const dependencies = injectedDependencies ?? defaultDependencies(endpoint);
  // An endpoint with nothing to verify against, or explicitly disabled, must refuse rather
  // than fall through to a verification loop that would reject everything anyway.
  if (
    dependencies.signingSecrets.length === 0 ||
    dependencies.signingSecrets.includes("disabled")
  ) {
    return apiError("ENDPOINT_DISABLED", "Webhook endpoint is disabled", 503);
  }
  if (!STRIPE_ACCOUNT_PATTERN.test(dependencies.expectedAccountId)) {
    return apiError("ENDPOINT_MISCONFIGURED", "Webhook endpoint is unavailable", 503);
  }
  const signature = request.headers.get("stripe-signature");
  if (signature === null) {
    return apiError("SIGNATURE_MISSING", "Stripe-Signature is required", 400);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return apiError("PAYLOAD_TOO_LARGE", "Webhook payload is too large", 413);
  }
  let rawBody: Buffer;
  try {
    rawBody = await readBoundedRequestBody(request, {
      deadlineAtMs: verificationDeadlineAtMs,
      maximumBytes: MAX_WEBHOOK_BYTES,
    });
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) {
      if (error.code === "deadline_exceeded") {
        return apiError("WEBHOOK_TIMEOUT", "Webhook body did not complete in time", 408);
      }
      if (error.code === "too_large") {
        return apiError("PAYLOAD_TOO_LARGE", "Webhook payload is too large", 413);
      }
      return apiError("PAYLOAD_INVALID", "Webhook payload is invalid", 400);
    }
    return apiError("PAYLOAD_INVALID", "Webhook payload is invalid", 400);
  }

  let event: Stripe.Event | null = null;
  try {
    for (const secret of dependencies.signingSecrets) {
      try {
        event = dependencies.constructEvent(rawBody, signature, secret);
        break;
      } catch {
        // Try the next secret. The refusal below is identical whichever one failed, so a
        // caller learns only that the signature did not verify, never which secret is live.
      }
    }
  } finally {
    releaseVerificationLease();
  }
  if (event === null) {
    return apiError("WEBHOOK_INVALID", "Webhook could not be verified", 400);
  }
  if (event.livemode) {
    return apiError("MODE_MISMATCH", "Live events are disabled for the pilot", 400);
  }
  if (!supportsEventApiVersion(event, dependencies.expectedApiVersion)) {
    return apiError("API_VERSION_MISMATCH", "Webhook API version is not supported", 400);
  }
  if (event.account !== undefined) {
    return apiError(
      "DELIVERY_SCOPE_MISMATCH",
      "Connected-account delivery is not accepted by this endpoint",
      400,
    );
  }
  const accountId = dependencies.expectedAccountId;

  let normalized: {
    readonly payload: NormalizedAccountWebhookPayload;
    readonly objectId: string;
  } | null;
  try {
    normalized = normalizeEvent(event, environmentFor(endpoint));
  } catch {
    return apiError("PAYLOAD_INVALID", "Webhook payload is invalid", 400);
  }
  if (normalized === null) {
    return jsonResponse({ received: true, event_id: event.id, ignored: true });
  }
  if (
    "application_id" in normalized.payload &&
    normalized.payload.application_id !== dependencies.expectedApplicationId
  ) {
    return apiError(
      "APPLICATION_MISMATCH",
      "Lifecycle event belongs to a different Stripe App",
      400,
    );
  }

  const dbEndpoint = accountEndpoint(endpoint);
  try {
    const existing = await dependencies.persistence.findExisting(dbEndpoint, event.id, accountId);
    if (existing !== null && normalized.payload.event_type !== "account.application.deauthorized") {
      return jsonResponse({
        received: true,
        event_id: event.id,
        receipt_id: existing.receiptId,
        duplicate: true,
      });
    }
    const resolved = await dependencies.persistence.resolve({
      stripeAccountId: accountId,
      environment: normalized.payload.environment,
      eventType: normalized.payload.event_type,
      stripeEventId: event.id,
      stripeEventCreatedAt: new Date(event.created * 1_000),
    });
    if (resolved === null) {
      return apiError("INSTALLATION_NOT_FOUND", "Stripe installation is not known", 400);
    }
    const inserted = await dependencies.persistence.insert({
      resolved,
      endpoint: dbEndpoint,
      stripeEventId: event.id,
      stripeAccountId: accountId,
      payload: normalized.payload,
      objectId: normalized.objectId,
      receivedAt: dependencies.now(),
    });
    return jsonResponse({
      received: true,
      event_id: event.id,
      receipt_id: inserted.receipt.id,
      duplicate: !inserted.inserted,
      queued_by: "durable_receipt_recovery",
    });
  } catch {
    return apiError("WEBHOOK_PERSISTENCE_UNAVAILABLE", "Webhook could not be persisted", 503);
  }
}

export async function receiveAccountWebhook(
  request: Request,
  endpoint: AccountWebhookRouteEnvironment,
  injectedDependencies?: AccountWebhookDependencies,
  injectedEdgeAdmissionGate?: EdgeAdmissionGate,
): Promise<Response> {
  if (endpoint === "live") {
    return apiError("ENDPOINT_DISABLED", "Webhook endpoint is disabled", 503);
  }
  const admission = acquireWebhookAdmission(
    request,
    injectedEdgeAdmissionGate ?? getEdgeAdmissionGate(),
  );
  if ("response" in admission) {
    return admission.response;
  }
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    admission.lease.release();
  };
  const verificationDeadlineAtMs = Date.now() + REQUEST_BODY_DEADLINE_MS;
  try {
    return await receiveAdmittedAccountWebhook(
      request,
      endpoint,
      injectedDependencies,
      release,
      verificationDeadlineAtMs,
    );
  } finally {
    release();
  }
}
