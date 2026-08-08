# ADR 0017 — Durable signed-request rate limiter

## Status

Accepted

## Context

RefundDesk accepts Stripe-signed API requests that can read workflow state or initiate durable
mutations. Body-size limits, signature verification and mutation idempotency do not by themselves
bound the rate at which an authenticated Stripe account can consume web and PostgreSQL capacity.
An in-memory limiter would reset on restart and would split its allowance across web replicas.

The tenant is deliberately unresolved until after Stripe has authenticated the exact raw envelope
and the account/environment binding can be checked. The capacity decision must therefore be global
and pre-tenant, without trusting an account identifier parsed from an invalid signature and without
granting any runtime direct access to shared limiter state.

## Decision

Every pilot signed route verifies the Stripe signature over the exact raw body first. Once the
verified envelope supplies a syntactically valid test/sandbox account and environment, and before
tenant resolution, command dispatch, mutation-receipt lookup or any financial workflow action, the
web runtime consumes one PostgreSQL-backed capacity unit.

The limiter uses GCRA with shared PostgreSQL time and one durable row per scope. The scope is:

```text
stripe_account_id + environment + request_class
```

`request_class` comes from the fixed server route contract and is exactly `mutation` or `read`.
PostgreSQL stores only the 32-byte digest:

```text
SHA-256(stripe_account_id || ":" || environment || ":" || request_class)
```

It does not store the raw account, environment or class in the bucket table. The policies are:

| Class      | Burst | Sustained rate | Token interval |
| ---------- | ----: | -------------: | -------------: |
| `mutation` |    30 | 0.5 requests/s |      2 seconds |
| `read`     |    60 |    1 request/s |       1 second |

Consumption serializes on the scope row and persists the theoretical arrival time. First creation
of a scope also takes a transaction-scoped global cardinality lock. The database retains at most
256 active scope rows. On new-scope admission it removes buckets that have been inactive for ten
minutes and carry no remaining GCRA debt; if capacity still cannot be admitted, the limiter fails
closed.

The database exposes exactly one limiter capability,
`refunddesk_consume_signed_request_rate_limit(VARCHAR, stripe_environment, VARCHAR)`. It is a
`SECURITY DEFINER` function with a fixed safe search path and bounded lock wait. `PUBLIC` has no
execution right. Among runtime principals, only the web runtime may execute it. Web has no direct
table privilege, and worker, queue and maintenance principals may neither execute the function nor
read or mutate the bucket table. The migration owner remains the controlled schema authority.

A valid capacity denial returns HTTP `429` with a positive `Retry-After`. A database error, lock or
cardinality failure, malformed database result or unavailable limiter returns a generic retryable
HTTP `503`; it never falls back to an in-memory allowance or permits the request. Neither response
creates a mutation receipt or reaches the tenant transaction. Operational signals contain no raw
scope, signature, payload or internal exception.

## Consequences

- Capacity is shared across web processes and survives application restarts.
- Test and managed-sandbox traffic, reads and mutations, and distinct Stripe accounts have
  independent budgets without persisting their readable scope in the limiter table.
- Limiter availability becomes a fail-closed dependency for every otherwise valid signed route.
- A `429` is retryable after the advertised delay; idempotency still applies only after the request
  later reaches the mutation boundary.
- The 256-scope ceiling bounds durable cardinality. Valid signed traffic can still consume its own
  scope allowance or contribute to that global ceiling.
- This control does not protect signature verification itself. Missing, invalid or unverifiable
  signatures are rejected before the limiter and still require separate edge/ingress protection.
- Source alone does not constitute real PostgreSQL evidence, an end-to-end pass, a hosted deployment
  or a production/live authorization. The exact PostgreSQL evidence recorded below closes only its
  stated repository and disposable-database gates; the remaining claims require their own
  revision-bound evidence.

## Required evidence

Before this limiter is reported as operational, prove all of the following against a disposable
PostgreSQL 18 database and the exact candidate revision:

- exact 30/0.5-per-second mutation and 60/1-per-second read burst/refill behavior;
- atomic concurrent consumption without over-admission;
- state persistence across web-process restart and separation by account, environment and class;
- ten-minute inactive cleanup, the 256-scope ceiling and fail-closed database/lock failures;
- web-only function execution and denial of every direct table access plus worker, queue and
  maintenance execution;
- HTTP `429`/`503`, positive `Retry-After`, redacted response/log behavior and ordering after valid
  signature verification but before tenant dispatch;
- a separate signed-route end-to-end scenario and, only after explicit authorization, exact hosted
  deployment evidence.

## Evidence — 1 August 2026

- Code-only implementation commit `9e2c39e41acaefc326f4423e710a16a73f1128bb` and access-check
  correction `ec67b50bc615c4c87799f53629c47d5728212af5` are published on the configured GitHub `main`.
- Exact CI run `30698815827`, headed by `ec67b50...`, completed `success`. Its disposable
  PostgreSQL 18 suite passed all 29 cases covering the GCRA policies, concurrent admission,
  persistence and scope separation, inactive cleanup, cardinality, bounded lock failure and role
  isolation. The restricted web, worker, queue and maintenance access check also passed in the
  isolated retention and scoped OCI smoke environments.
- The same exact run passed the HTTP `429`/`503`, ordering and redaction contracts in the workspace
  suite, as well as formatting, lint, type checks, builds, dependency audit, OCI security/smokes and
  the standalone Stripe App package.
- This evidence does not claim a separate signed-route end-to-end pass, a hosted deployment of this
  revision, invalid-signature edge protection, real Stripe financial behavior, live authorization
  or Marketplace readiness. Those gates remain open.

## Rejected alternatives

- Process-local token buckets: restarts and multiple replicas mint independent capacity.
- Tenant-local limiting after dispatch: expensive authenticated work and tenant resolution would
  occur before the capacity control.
- Limiting from an unverified body or account header: an attacker could choose or poison the scope.
- Direct runtime access to the bucket table: broadens the pre-tenant shared-state authority and
  permits bypassing the atomic GCRA function.
- Fail open when PostgreSQL is unavailable: converts a capacity-control outage into unbounded signed
  work.
- Rely only on this application limiter: it cannot protect raw signature verification or the public
  network edge.
