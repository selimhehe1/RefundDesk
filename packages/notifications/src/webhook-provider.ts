import type { Notification, NotificationProvider } from "./index.js";
import { createPinnedLookup, type PinnedLookup } from "./pinned-lookup.js";
import { isBlockedAddress, validateWebhookDestination } from "./webhook-destination.js";

/** Resolves a hostname to the addresses a connection would actually use. */
export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * A request that carries its own resolution.
 *
 * The addresses have already been checked against the destination policy, and `lookup` answers
 * with those and only those. A fetcher must connect through it: resolving the name again would
 * reopen the DNS rebinding window this exists to close (ADR 0025). Passing them as part of the
 * request rather than leaving the caller to remember is the point — a fetcher cannot silently
 * skip a parameter it is given.
 */
export interface PinnedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly addresses: readonly string[];
  readonly lookup: PinnedLookup;
}

export type PinnedFetcher = (request: PinnedRequest) => Promise<Response>;

/** Looks up the destination a tenant configured, or `null` when it configured none. */
export type DestinationLookup = (tenantId: string) => Promise<string | null>;

export type WebhookDeliveryOutcome =
  | { readonly status: "delivered" }
  | { readonly status: "skipped"; readonly reason: "no_destination" }
  | {
      readonly status: "dropped";
      readonly reason: "rejected_destination" | "blocked_address" | "unreachable" | "refused";
    };

export interface WebhookNotificationOptions {
  readonly destinationLookup: DestinationLookup;
  readonly resolveAddresses: AddressResolver;
  readonly fetcher: PinnedFetcher;
  readonly now?: () => Date;
  readonly timeoutMilliseconds?: number;
  readonly onOutcome?: (notification: Notification, outcome: WebhookDeliveryOutcome) => void;
}

const DEFAULT_TIMEOUT_MILLISECONDS = 5_000;

/**
 * Decides whether a pending-approval reminder is worth sending.
 *
 * The worker cannot learn of a new request the moment it is created: the web runtime holds
 * no queue access, and a durable "already notified" marker would need a schema change. So
 * the signal is derived from state rather than events — it fires when work appears and
 * when the amount of work grows, and stays quiet otherwise, which keeps a restart or a
 * crash loop from turning into a stream of identical messages.
 */
export function shouldNotifyPendingApprovals(input: {
  readonly pendingCount: number;
  readonly lastNotifiedCount: number | null;
}): boolean {
  // `NaN <= 0` is false, so a bare comparison would let an unusable count through.
  if (!Number.isInteger(input.pendingCount) || input.pendingCount <= 0) {
    return false;
  }
  return input.lastNotifiedCount === null || input.pendingCount > input.lastNotifiedCount;
}

/**
 * Body deliberately carries no amount, identifier, person or justification (ADR 0021).
 * It exists to make someone open RefundDesk; the Dashboard stays the only place the
 * workflow is visible, so a leaked destination cannot become a disclosure incident.
 */
function notificationBody(notification: Notification, occurredAt: Date): string {
  return JSON.stringify({
    type: `refunddesk.${notification.kind}`,
    occurred_at: occurredAt.toISOString(),
    text: "A refund workflow in RefundDesk needs attention. Open RefundDesk in the Stripe Dashboard.",
  });
}

/**
 * Delivers a signal to the merchant's own HTTPS endpoint.
 *
 * Delivery is best-effort by contract: every failure resolves to an outcome instead of
 * throwing, because a notification must never change or fail a financial workflow.
 */
export class WebhookNotificationProvider implements NotificationProvider {
  constructor(private readonly options: WebhookNotificationOptions) {}

  async send(notification: Notification): Promise<void> {
    const outcome = await this.deliver(notification);
    this.options.onOutcome?.(notification, outcome);
  }

  async deliver(notification: Notification): Promise<WebhookDeliveryOutcome> {
    const raw = await this.options.destinationLookup(notification.tenantId);
    if (raw === null || raw.trim().length === 0) {
      return { status: "skipped", reason: "no_destination" };
    }

    const destination = validateWebhookDestination(raw);
    if ("error" in destination) {
      return { status: "dropped", reason: "rejected_destination" };
    }

    // Resolved once, here, and checked before anything connects. The result is then pinned
    // onto the request, so the name is never resolved a second time by the HTTP stack.
    let addresses: readonly string[];
    try {
      addresses = await this.options.resolveAddresses(destination.url.hostname);
    } catch {
      return { status: "dropped", reason: "unreachable" };
    }
    if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
      return { status: "dropped", reason: "blocked_address" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS);
    try {
      const response = await this.options.fetcher({
        url: destination.url.toString(),
        addresses,
        lookup: createPinnedLookup(addresses),
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: notificationBody(notification, this.options.now?.() ?? new Date()),
          // A redirect could send the request to an address that never passed the checks.
          redirect: "manual",
          signal: controller.signal,
        },
      });
      // Only the status is read. The body is never parsed, logged or surfaced.
      return response.ok ? { status: "delivered" } : { status: "dropped", reason: "refused" };
    } catch {
      return { status: "dropped", reason: "unreachable" };
    } finally {
      clearTimeout(timeout);
    }
  }
}
