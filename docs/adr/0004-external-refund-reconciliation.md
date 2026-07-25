# ADR 0004 — External refund reconciliation

- Status: Accepted
- Date: 2026-07-25
- Owners: Engineering and operations

## Context

RefundDesk cannot prevent an authorized Dashboard user, another API key or another integration from creating a refund. Webhook delivery is retryable but not a permanent query mechanism, and events can arrive before a synchronous API response is committed.

## Decision

RefundDesk detects refunds through two complementary channels:

1. verified, deduplicated Stripe webhooks;
2. a paginated scanner every fifteen minutes.

The scanner operates per tenant and environment, uses a one-hour overlap and advances its checkpoint only after every page succeeds. Its first window starts one hour before the installation timestamp, so a delayed first worker run cannot create an initial blind spot. Refund IDs provide deduplication. Under normal pilot operation, a missed webhook is detected within thirty minutes.

A Refund is linked to a workflow only through the evidence policy in ADR 0002. Everything else is external or ambiguous.

An external Refund:

- makes a `pending_approval` or `approved` request stale and neutralizes its job by atomic comparison-and-exchange;
- forces reconciliation during `executing` or `reconciliation_required`;
- never triggers an automatic second call to `refunds.create`.

Copied metadata with a second Refund ID is a proof replay/tampering alert, not authority to relink the request.

## Consequences

- RefundDesk’s public promise is detection, not universal prevention.
- Webhook and scanner logic share one idempotent classifier.
- Pagination, out-of-order delivery and partial scanner failure are required tests.
- Scan lag and checkpoint age are operational alerts.

## Rejected alternatives

- Webhooks only: events can be delayed or missed operationally.
- Polling only: detection is slower and creates unnecessary API load.
- Trust any matching metadata: an external actor can copy it.
- Automatically retry after an external refund: this can duplicate the financial effect.
