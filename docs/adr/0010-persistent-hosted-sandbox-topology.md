# ADR 0010 — Persistent hosted sandbox topology

## Status

Accepted

## Context

The financial pilot now works against real Stripe test and managed-sandbox objects, but the
unpublished Stripe App still points to a placeholder API origin. A temporary tunnel proved the UI
and backend flow; it is not an autonomous, persistent installation boundary.

A hosted sandbox must not turn a Node production process into Stripe live mode, reunite database or
Stripe authority in one service, expose migration ownership to a long-lived process, or make webhook
ingestion unavailable whenever the worker is unhealthy.

## Decision

RefundDesk uses one repository-root, provider-neutral OCI build with three separate targets:

- `web`: the minimal Next.js standalone server;
- `worker`: the compiled pg-boss worker and its production dependency graph;
- `migrate`: a serialized one-shot release job with the full Prisma and grant toolchain.

All targets use Node.js 24.18.0 on Debian slim. Runtime targets run as the unprivileged `node` user.
Images never receive secrets as build arguments or build-time environment values. A Linux builder
generates Prisma and native dependencies; host-built Windows artifacts are excluded from the build
context.

`NODE_ENV=production` means optimized hosted Node execution only. Stripe operation remains limited
to test mode and managed sandbox. The global live interlock remains the literal `false`, the live
webhook endpoint remains disabled, and neither image contains a live credential path.

Runtime configuration is split by authority:

- the web receives its web PostgreSQL login, direct-account test/sandbox webhook secrets,
  account-bound read-only Stripe restricted keys, the field-encryption key and the export-signing
  key;
- the worker receives its worker and pg-boss logins, distinct Stripe effect keys and the proof-HMAC
  key;
- the one-shot migration job receives the owner and runtime database URLs needed to migrate, apply
  grants and verify separation, but no Stripe or application cryptographic secret.

Production loaders reject known secrets belonging to another runtime. Generic Stripe key names are
a development/test compatibility bridge only and are forbidden in production. Before a hosted
release, an offline one-shot preflight loads three separate environment files and verifies:

- web, worker/queue and migration database-principal separation;
- pairwise separation of all four Stripe read/effect credentials;
- equality of the web/worker expected Stripe account IDs within each environment and inequality
  between test and managed sandbox;
- pairwise separation of field-encryption, proof-HMAC and export-signing keys.

The canonical database release command runs, in order, Prisma deploy plus runtime grants, pg-boss
migration plus its narrow worker grants, and the runtime access check. It is never an application
startup hook and must be serialized by the hosting platform.

The web and worker have independent probes. Web readiness verifies PostgreSQL 18, writability,
the current schema contract, forced RLS, restricted runtime authority and append-only audit
privileges. It does not depend on worker health, so valid webhooks can still be durably ingested
during worker recovery. The worker exposes generic health/readiness responses on a separately
configured listener; readiness inspects only its own pg-boss consumers, exact schedules and scanner
checkpoint coverage. Probes never call Stripe and never expose tenant IDs, Stripe IDs, payloads,
timestamps or raw errors.

For the separately authorized pilot deployment, the selected topology is one dedicated AWS
Lightsail `micro_3_0` instance running the composed services, with a private versioned Lightsail
bucket for encrypted backups and instance-scoped bucket access. The stable sandbox origin is bound
to the instance static IPv4 address. This selection remains test/sandbox-only under the separately
approved total ceiling of EUR 10 per month. The AWS USD 10 budget is an alert boundary, not a hard
cap or permission to create additional resources.

The schema-v1 OCI manifest records the classic Docker configuration digest as `imageId`, and the
release validator binds that value to `docker image inspect .Id`. Fresh Docker Engine 29 hosts
instead expose the OCI descriptor digest when the containerd image store is active. For this exact
single-platform release cycle, the bootstrap therefore pins
`features.containerd-snapshotter=false`, requires an empty containerd store before switching, and
verifies the `overlay2` driver after restart. Future manifest schemas must distinguish configuration
and descriptor digests before RefundDesk can move back to the containerd image store.

The Stripe App manifest is not changed or uploaded until the hosted application is healthy. This
ADR does not authorize live mode, Stripe review or Marketplace publication.

## Observed implementation evidence — 2026-07-28

Immutable backend revision `42a1e4e65cf6e9144261a077c6956e77b368fffc` was promoted on the selected
Lightsail host. The account-scoped migrations, separate runtime principals, five container health
checks, public/private route boundaries and both false live interlocks passed.

The active revision then produced a cold PostgreSQL 18 backup encrypted to the offline `age`
recipient and stored as a versioned SSE-S3 AES-256 object. The obsolete SSE systemd drop-in and
hotfix were removed only after their script matched the revision's canonical `backup.sh`. A
disposable EC2 verifier started the restored copy on `postgres:18.4-bookworm`, passed physical
checksums, Prisma migration and restricted-role checks, then removed the private identity/archive
and every temporary AWS resource. The redacted artifact
`active-revision-backup-restore-2026-07-28.json` has SHA-256
`9221974966fc2a62bbfa19ca883354b9d2098cdb19392f29a6f19ef18a77d939`.

This is recovery evidence for that exact archive and revision. It is not a production availability
claim, a perpetual restore guarantee or authorization to exceed the approved budget.

## Consequences

- A web compromise does not inherit the worker database login, proof key or Stripe refund authority.
- A worker compromise does not inherit App-signing, webhook, field-encryption or export-signing
  secrets.
- Owner credentials exist only in an auditable, short-lived release job.
- Webhook ingestion and financial execution have separately observable availability.
- A real sandbox permission test must still prove that each web read key can retrieve its allowed
  object but receives Stripe HTTP 403 for `refunds.create`.
- Docker builds are validated in Linux CI; this Windows workstation can validate source, portable
  bundles and static image contracts but has no local Docker engine.
- Docker stores from another backend remain hidden rather than deleted. Operators must not prune
  the inactive store or switch stores after application containers start without a separate
  maintenance and migration plan.
- Each future hosted Stripe App version requires a stable origin, a clean source snapshot and new
  artifact provenance. Evidence is never transferred from an earlier upload.

## Rejected alternatives

- One image and one environment for every process: reunites secrets and makes least privilege
  unverifiable.
- Running migrations from web or worker startup: exposes owner authority and allows concurrent
  migration races.
- Giving the web the worker's Stripe effect key: a web compromise could bypass the approval
  workflow and create a Refund directly.
- Making web readiness depend on worker readiness: discards useful durable webhook ingestion during
  a worker outage.
- A shared heartbeat table readable by the web: unnecessary new database authority for the current
  hosted-sandbox milestone.
- Reusing the temporary public tunnel as a persistent origin: it has no durable provenance,
  availability, access or backup contract.
