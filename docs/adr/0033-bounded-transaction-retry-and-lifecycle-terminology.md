# ADR 0033 — Bounded transaction retry and lifecycle terminology

- Status: Accepted
- Date: 2026-08-08
- Owners: Engineering and security
- Supersedes: ADR 0007 in the particulars below

## Context

ADR 0007 established the web/worker database financial-authority boundary. Later implementation
made two clarifications without changing that boundary: `connected deauthorization` is specifically
a verified Stripe App deauthorization lifecycle Event, and serializable conflicts need bounded
contention handling.

## Decision

- Before acknowledging a verified Stripe App deauthorization Event, the web transaction may make
  affected requests less executable only through ADR 0007's monotone protective transitions.
- Retry only PostgreSQL serialization failures (`40001`) and deadlocks (`40P01`), with bounded
  exponential delay and jitter.
- Every retry opens a fresh transaction, sets tenant context as its first statement and reruns the
  complete operation. The process-local delay holds no database transaction or financial guard.
- All other ADR 0007 authority and privilege decisions remain unchanged.

## Consequences

- Concurrent serializable work does not immediately spin through every retry while a winning
  transaction is still completing.
- Retry cannot bypass tenant initialization, reuse partial financial work or widen web authority.
