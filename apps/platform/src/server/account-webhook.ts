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

import { apiError, jsonResponse } from "./http";
import type { Phase0Correlation, Phase0ObservedRefund } from "./phase0-store";
import { getPilotRuntime } from "./pilot-runtime";

export type AccountWebhookRouteEnvironment = "live" | "test" | "sandbox";

const MAX_WEBHOOK_BYTES = 1_048_576;
const TENANT_PURGE_DELAY_MILLISECONDS = 29 * 24 * 60 * 60 * 1_000;
const STRIPE_ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]+$/u;
const SUPPORTED_EVENT_TYPES = new Set<AccountWebhookEventType>([
  "refund.created",
  "refund.updated",
  "refund.failed",
  "account.application.authorized",
  "account.application.deauthorized",
]);

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
  readonly signingSecret: string;
  readonly constructEvent: (
    rawBody: Buffer,
    signature: string,
    signingSecret: string,
  ) => Stripe.Event;
  readonly persistence: AccountWebhookPersistence;
  readonly now: () => Date;
  readonly phase0Observer?: {
    observe(refund: Phase0ObservedRefund): Phase0Correlation;
  };
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
  const signingSecret =
    endpoint === "test"
      ? config.stripe.accountTestWebhookSecret
      : config.stripe.accountSandboxWebhookSecret;
  const expectedAccountId =
    endpoint === "test"
      ? config.stripe.platformTestAccountId
      : config.stripe.managedSandboxAccountId;
  return {
    expectedApplicationId: config.stripe.appId,
    expectedAccountId,
    expectedApiVersion: config.stripe.apiVersion,
    signingSecret,
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

function observePhase0Refund(
  dependencies: AccountWebhookDependencies,
  event: Stripe.Event,
  stripeAccountId: string,
  payload: NormalizedAccountWebhookPayload,
): Phase0Correlation | undefined {
  if (dependencies.phase0Observer === undefined || !("refund" in payload)) {
    return undefined;
  }
  const refund = payload.refund;
  const paymentKey = refund.payment_intent_id ?? refund.charge_id;
  if (paymentKey === null) {
    return undefined;
  }
  return dependencies.phase0Observer.observe({
    eventId: event.id,
    refundId: refund.refund_id,
    accountId: stripeAccountId,
    environment: payload.environment,
    paymentKey,
    amountMinor: refund.amount_minor,
    currency: refund.currency,
    requestNonce: refund.metadata_request_id,
    proof: refund.metadata_proof,
    eventIdempotencyKey: payload.event_idempotency_key,
  });
}

export async function receiveAccountWebhook(
  request: Request,
  endpoint: AccountWebhookRouteEnvironment,
  injectedDependencies?: AccountWebhookDependencies,
): Promise<Response> {
  if (endpoint === "live") {
    return apiError("ENDPOINT_DISABLED", "Webhook endpoint is disabled", 503);
  }
  const dependencies = injectedDependencies ?? defaultDependencies(endpoint);
  if (dependencies.signingSecret === "disabled") {
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
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    return apiError("PAYLOAD_TOO_LARGE", "Webhook payload is too large", 413);
  }

  let event: Stripe.Event;
  try {
    event = dependencies.constructEvent(rawBody, signature, dependencies.signingSecret);
  } catch {
    return apiError("WEBHOOK_INVALID", "Webhook could not be verified", 400);
  }
  if (event.livemode) {
    return apiError("MODE_MISMATCH", "Live events are disabled for the pilot", 400);
  }
  if (event.api_version !== dependencies.expectedApiVersion) {
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
      const phase0Correlation = observePhase0Refund(
        dependencies,
        event,
        accountId,
        normalized.payload,
      );
      return jsonResponse({
        received: true,
        event_id: event.id,
        receipt_id: existing.receiptId,
        duplicate: true,
        ...(phase0Correlation === undefined ? {} : { phase0_correlation: phase0Correlation }),
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
    const phase0Correlation = observePhase0Refund(
      dependencies,
      event,
      accountId,
      normalized.payload,
    );
    return jsonResponse({
      received: true,
      event_id: event.id,
      receipt_id: inserted.receipt.id,
      duplicate: !inserted.inserted,
      queued_by: "durable_receipt_recovery",
      ...(phase0Correlation === undefined ? {} : { phase0_correlation: phase0Correlation }),
    });
  } catch {
    return apiError("WEBHOOK_PERSISTENCE_UNAVAILABLE", "Webhook could not be persisted", 503);
  }
}
