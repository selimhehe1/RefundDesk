# ADR 0006 — Durable executing recovery and dual-lane reconciliation

- Status: Accepted
- Date: 2026-07-25
- Owners: Engineering and operations

## Context

A worker can stop after a request enters `executing`, including after the durable effect boundary
but before a Stripe response is stored. Recovering only `approved` work leaves safe, never-started
executions orphaned. Retrying every `executing` request is unsafe because a `possible` effect may
already exist.

The creation-window scanner also cannot converge every linked Refund. A Refund created before the
overlap window may later change status, and using only `execution_started_at` to prove an empty
ambiguous result creates a race when the scan cutoff predates the end of the ambiguous attempt or
its durable recovery.

## Decision

Recovery re-enqueues only:

- `approved/not_started`;
- `executing/not_started`;
- `executing/absence_proven` with the existing canonical execution, its expected deterministic key
  and no linked Refund.

`executing/possible`, a missing or inconsistent execution identity, a different key, or an already
linked Refund is diverted to reconciliation. Recovery never invents another execution or
idempotency key.

Every transition into `reconciliation_required` receives a database-managed
`reconciliation_safe_after_at` timestamp. An orphaned `started` attempt must first be moved to
reconciliation so that it receives this boundary. A temporal scan can prove absence only when its
complete inclusive window:

1. starts no later than `execution_started_at`;
2. ends no earlier than `reconciliation_safe_after_at`;
3. contains no matching candidate; and
4. has no unresolved external, tampered or proof-replay alert for the payment.

The scanner has two independent lanes:

1. a checkpointed, paginated listing of Refunds created in the temporal window;
2. a paginated list of workflows with an immutable linked Refund ID, followed by direct retrieval
   of each current Refund snapshot.

The direct lane validates the exact account, environment, immutable ID and payment tuple. A
terminal snapshot resolves `executing` or `reconciliation_required`; `pending` and
`requires_action` retain the guard. A current `failed` snapshot of the same linked Refund may
correct `succeeded` to `failed_terminal` without rewriting the original terminal or guard-release
timestamps.

A linked-target failure does not starve later targets or the temporal lane. The aggregate job still
fails after all safe work completes so that normal retry remains active. Only temporal-page success
controls the temporal checkpoint.

## Consequences

- Lost initial enqueues and safe orphaned executions recover automatically.
- Ambiguous effects remain guarded until a later complete window crosses the database-stamped
  boundary.
- Old linked Refunds converge even when their creation time is outside the overlap.
- The scanner performs additional read calls and must page both lanes.
- An ambiguity too old for a complete covering window remains in reconciliation for reviewed
  handling instead of being guessed safe.

## Rejected alternatives

- Retry every `executing` request: a prior call may already have reached Stripe.
- Use `execution_started_at` as the only absence boundary: the scan cutoff may precede the end of
  the ambiguous operation.
- Scan by creation time only: old linked Refund status changes can remain invisible.
- Stop at the first linked-target failure: one bad Refund would starve unrelated reconciliation.
