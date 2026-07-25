# ADR 0002 — Refund effect boundary and immutable identity

- Status: Accepted
- Date: 2026-07-25
- Owners: Engineering

## Context

An HTTP timeout or process crash can occur after Stripe accepted a refund but before RefundDesk persisted the response. Retrying with a different key can create a second refund. Holding a PostgreSQL transaction during a network call creates long locks without resolving this ambiguity.

## Decision

Each approved request receives one deterministic Stripe idempotency key:

```text
refunddesk:refund-request:<request_uuid>:v1
```

That key never changes, including after timeouts, restarts or operator intervention.

Execution persists an attempt and crosses a durable effect boundary before ending the database transaction and calling Stripe. No database transaction remains open during the call.

The request records one of:

- `not_started`
- `possible`
- `identified`
- `absence_proven`

The first sufficiently proven Stripe Refund ID is immutable. Evidence is ranked:

1. the synchronous Stripe response;
2. a matching Event request idempotency key when present;
3. one unique candidate with a valid versioned HMAC and matching account, environment, payment, amount and currency.

An absent Event idempotency key is not an error. An ambiguous candidate set moves the request to `reconciliation_required`.

After the first link, any different Refund ID bearing the same proof is classified as `proof_replay` or tampering and never replaces it.

Once a Refund ID is linked, a direct retrieval of that same object is
authoritative for status convergence. `succeeded` resolves an executing or
reconciling request successfully; `failed` or `canceled` resolves it to
`failed_terminal`. `pending`, `requires_action` or an unknown status keeps the
guard and any existing reconciliation state. Snapshot refreshes never replace
the Event-created freshness watermark.

### Empty-scan absence proof

Entering `reconciliation_required` stamps a database-managed
`reconciliation_safe_after_at` boundary. For a completed ambiguous call, this
boundary is recorded only after the call has returned. Recovery gives an
orphaned `started` attempt a new boundary when it durably moves the request to
reconciliation. PostgreSQL uses the later of its statement clock and the
persisted `execution_started_at`, so an application clock ahead of the database
cannot place the safe boundary before execution.

An empty Stripe scan proves absence only when its complete window starts no
later than `execution_started_at` and ends no earlier than
`reconciliation_safe_after_at`. `execution_started_at` alone is never
sufficient: a Refund can be created after that timestamp. A scan that predates
the safe boundary leaves the request and guard unchanged.

## Guard release

- Rejection, cancellation and expiration release the guard before any effect.
- `failed_terminal` and `stale` release it only with `absence_proven`.
- `reconciliation_required` never releases it.
- A Stripe Refund in `pending` or `requires_action` keeps it until a terminal status.

## Consequences

- Operators investigate ambiguous outcomes; they do not “try another key.”
- Recovery reuses the same key or reconciles existing Stripe state.
- Crash tests must cover every point around the effect boundary.
- Exactly-once delivery is not assumed; the design targets one financial effect through durable identity and reconciliation.

## Rejected alternatives

- Holding a transaction across Stripe: it increases contention and cannot atomically commit with Stripe.
- Generating a key per attempt: it permits duplicate effects.
- Trusting metadata alone: metadata can be copied and is not proof of uniqueness.
- Releasing the guard on timeout: the effect may already exist.
