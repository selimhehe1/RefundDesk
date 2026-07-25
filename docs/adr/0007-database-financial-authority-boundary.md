# ADR 0007 — Database financial authority boundary

- Status: Accepted
- Date: 2026-07-25
- Owners: Engineering and security

## Context

The web runtime records signed user mutations while the worker owns Stripe effects. Broad table
grants previously let the web role insert or update `refund_executions`, and a direct request UPDATE
could enter `approved` without a durable decision row. Application checks were correct, but the
database boundary did not independently preserve the four-eyes and execution separation
invariants.

Connected deauthorization is a special case: before acknowledging the lifecycle Event, the web
transaction must make every affected request less executable. Removing all lifecycle writes from
the web role would break that fail-safe operation.

## Decision

The web runtime:

- may read an execution and its attempts for request-detail views;
- has no insert, update, delete or truncate privilege on executions, attempts or correlation
  candidates;
- may create only `pending_approval/not_started` requests;
- may perform the normal `pending_approval` approval, rejection and cancellation transitions;
- may perform only monotone protective deauthorization transitions after the installation is
  durably `suspended` or `deauthorized`;
- can never move a request into `executing` or `succeeded`.

The database requires a durable coherent decision before `pending_approval` becomes `approved` or
`rejected`. A decision is valid only for the same tenant, while the request remains open, from an
explicitly enabled approver distinct from the requester. The approver row is locked while the
decision is inserted. Approval requires the stored quorum and no rejection; rejection requires a
stored rejection.

The worker role retains the lifecycle and execution writes needed for claims, attempts, effects and
reconciliation. The migration owner remains privileged for migrations and controlled fixtures.
Runtime access checks inspect both table and column privileges, and real PostgreSQL login tests
exercise the allowed and denied paths.

## Consequences

- A web query compromise cannot directly manufacture an execution or claim worker-owned
  transitions.
- A request status cannot represent human approval without its append-only decision evidence.
- Deauthorization can still neutralize or guard work before the webhook is acknowledged.
- The web service remains a security-sensitive verifier of signed Stripe identities; database
  controls add defense in depth but do not make a fully compromised web process trustworthy.

## Rejected alternatives

- Keep broad execution grants and rely only on application code: a SQL injection or repository bug
  would cross the effect boundary.
- Forbid every web lifecycle transition: connected deauthorization would acknowledge before
  financial state was protected.
- Expose a generic security-definer lifecycle function: a broad capability would recreate the
  bypass under another name.
