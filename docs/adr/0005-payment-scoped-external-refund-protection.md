# ADR 0005 — Payment-scoped external Refund protection

- Status: Accepted
- Date: 2026-07-25
- Owners: Engineering and operations

## Context

The request guard is released after RefundDesk records a successful internal Refund. A different
Refund can nevertheless be created outside RefundDesk during the same execution window and be
observed only after that release. Reopening the old request guard would violate its immutable
release timestamp and could conflict with a newer request that already owns the unique guard.

Stripe can also report that the same linked Refund failed after RefundDesk first observed it as
successful. Freezing every terminal local status would retain an incorrect success.

## Decision

An unresolved external alert is a second, payment-scoped financial protection. Its scope is the
tenant, installation, environment and PaymentIntent or Charge key.

Request creation and transitions into an executable state take the same transaction-scoped
advisory lock as external Refund observation. While an external, tampered or proof-replay alert in
that scope has no `reconciled_at`, the database rejects a new pending, approved or executing
request.

Observation then acts under that lock:

- `pending_approval` and `approved` requests with no internal effect become `stale`;
- an `executing` request with no possible internal effect becomes `failed_terminal`;
- an `executing` request in `possible` or `identified` becomes `reconciliation_required` and keeps
  its request guard;
- a terminal request whose inclusive execution window contains the external Refund creation time
  is linked to the alert without reopening its immutable guard.

Acknowledging an alert is only an operator workflow action. It never sets `reconciled_at` and never
removes payment protection. The pilot intentionally has no automatic or generic alert-resolution
operation: an external alert permanently blocks another RefundDesk request for that payment.
Introducing reviewed resolution evidence requires a later ADR and migration.

For the same immutable linked Refund ID, state observations are ordered by Stripe `Event.created`.
Older Events are no-ops. At equal timestamps, `failed` wins. A scanner snapshot may advance a
non-terminal state and may correct `succeeded` to `failed`, but it never regresses `failed`.
Precisely that correction changes the workflow from `succeeded` to `failed_terminal` and the effect
to `absence_proven`; the original terminal and guard-release timestamps remain immutable.

## Consequences

- A reverse-order external Refund race cannot leave the payment executable.
- Acknowledgement cannot be mistaken for financial reconciliation.
- The first linked Refund ID and request history remain immutable.
- False-positive external classification blocks that payment for the pilot and requires engineering
  review rather than an unsafe UI override.
- Payment-scoped locking serializes only financially related mutations.

## Rejected alternatives

- Reopen the old request guard: its release is immutable and a newer request may already exist.
- Treat acknowledgement as resolution: reading an alert is not evidence about Stripe's effect.
- Keep `succeeded` forever: Stripe can later emit a verified failure for the same Refund.
- Allow a generic operator unblock: it would turn an administrative action into financial proof.
