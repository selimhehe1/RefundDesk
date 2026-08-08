# ADR 0014 — Startup reconciliation catch-up

- Status: Accepted
- Date: 2026-07-29
- Owners: Engineering and operations

## Context

Worker readiness requires every active non-live installation to have a reconciliation checkpoint
no older than thirty minutes, unless the installation is still inside its bounded initial warmup.
The periodic reconciliation scan runs every fifteen minutes.

During the unique sandbox release of revision
`697acfd6ad9aea312f439fb85c2e63e7fdf61a82`, both existing non-live checkpoints were about five
hours old after an extended fenced maintenance window. The candidate worker started all expected
consumers and exact schedules, but startup enqueued only webhook and approved-execution recovery.
No reconciliation scan was enqueued. The release verifier therefore observed fifteen consecutive
generic `worker-ready` HTTP 503 responses and failed closed after 150 seconds, before promotion.

The fenced read-only database proof remained
`on|180004|10|10|0|20260728203000_sandbox_retention_candidates|0|0|0|4|2|0|0`.
There were zero Refund requests, executions, execution attempts or refund-execution jobs during
the release, so this incident created no ambiguous financial effect.

## Decision

Worker initialization retains all four periodic schedules, including the `*/15` reconciliation
schedule, and additionally runs one canonical `{ "scope": "all" }` reconciliation scan
synchronously during startup.

The startup catch-up occurs inside the guarded pg-boss initialization sequence, after schedule
registration but before any recovery job is enqueued and before any worker consumer is registered.
If the scan does not complete successfully, startup fails and pg-boss is force-stopped; the
process must not report that the pilot worker started. Process restart is the retry boundary for
this startup barrier.

The reconciliation job continues to:

- list only active installations through the existing non-live and tenant-live interlocks;
- use the existing account- and environment-bound Stripe worker credentials;
- perform Stripe reads only in its scanner path;
- advance a temporal checkpoint only after every temporal page succeeds;
- deduplicate observations and preserve every ambiguous financial guard;
- serialize locally through the existing scan consumer and fail closed on checkpoint races.

`GET /health` remains liveness-only. `GET /ready` remains strict and does not call Stripe itself:
it becomes ready only after the startup catch-up (or another valid scan) has produced fresh
checkpoint coverage.

## Consequences

- A worker restart no longer waits for the next quarter-hour cron boundary before it can repair
  stale scanner coverage.
- Restarting the worker performs an additional read-only reconciliation scan. Repeated starts may
  therefore repeat safe, idempotent Stripe reads and checkpoint comparisons.
- Health serving and financial job consumption begin only after the synchronous scan completes.
  Large installations can therefore increase startup latency and must remain inside the bounded
  process and release health windows.
- A scanner credential, pagination or database failure prevents the worker from starting and
  therefore prevents readiness and promotion.
- The periodic fifteen-minute detector remains the steady-state safety channel.
- Hosted release evidence must show a completed startup reconciliation scan before claiming worker
  readiness when any pre-start checkpoint was stale.

## Rejected alternatives

- Increase the release timeout until the next scheduled scan: startup latency would depend on wall
  clock alignment and would still hide a missing catch-up contract.
- Enqueue a startup scan before registering consumers: pg-boss does not make queue ordering a
  completion barrier, so a financial consumer could claim an existing job while the scan was
  still pending or running.
- Relax scanner freshness in worker readiness: this would make an overdue financial detector look
  healthy.
- Manually advance checkpoints: this would claim Stripe coverage that never happened.
- Restart or retry the failed `697acfd6...` release: the unique failed revision and its emergency
  fence remain immutable incident evidence.
