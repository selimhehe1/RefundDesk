# RefundDesk

RefundDesk is a Stripe App pilot that routes card-refund requests through a one-person approval
workflow, records every workflow decision, and flags refunds detected outside it.

The pilot is test/sandbox-only. Live refunds, Marketplace publication, Billing and e-mail
notifications are deliberately disabled. An AWS sandbox deployment is authorized under a
10 EUR/month ceiling; it contains synthetic data only.

## Current pilot status

Phase 0 is `PASS`: all 34 required Stripe cases are recorded as `passed_real`. RefundDesk proved the
real test-account and managed-sandbox boundaries, signed-request rejection matrix, role gap,
backend Refund permission, Stripe idempotency, historical connected-webhook deduplication and ordering,
external-Refund detection, copied-proof classification and minimal permission set.

Every Phase-0 runtime route, client call, UI control and manifest switch has been removed from the
pilot surface. Unpublished version `0.1.1` was uploaded from clean commit
`100ae946ec593df1f21ba3efa6fe5c72ec366e89` with packaged artifact SHA-256
`ec5fc4940092343c9d6bd8b25948ea31272666d4e041a2ff23d36f10e27446be`. No live request,
production deployment, Stripe review submission or Marketplace publication was performed.

The hardened P1 pilot UI is implemented in unpublished version `0.1.2`. It was uploaded from clean
commit `e8644c92ada34551f84846a28b4c2528466f4222`; the reproducible Git source archive has SHA-256
`7da0bff7979cdd4f32e08ce8ed417931b932b824487d104867d52df8a058af42`, and its committed manifest
has SHA-256 `077b7032d53701201338dcf393902ad5f91e20c8dda895429be81c8610a4a319`. Stripe CLI reports
`UPLOAD_COMPLETED`; the Dashboard shows the processed version as `Approved` with no distribution
channel. The exact version was subsequently observed installed in the managed sandbox, and its UI
was exercised through a temporary local API overlay whose Stripe App source tree was identical to
the uploaded commit. This does not mean Marketplace approval. No deployment, review submission,
publication or remote push was performed.

The P1 UI makes approval an explicit two-step financial action, preserves mutation nonces across
ambiguous retries, serializes concurrent mutations, displays exact currency amounts and approval
context, invalidates stale account and scope state, and hardens onboarding, settings, alerts and
audit-download attribution. The source snapshot passed 274 workspace tests, 67 exact standalone
extension tests and 19 PostgreSQL integration tests, plus format, lint, typecheck, build, secret and
production dependency-audit gates.

On 27 July 2026, two distinct authenticated users completed the managed-sandbox happy path through
the signed Stripe UI: one created the synthetic card-refund request, the other approved it, and one
worker produced exactly one terminal Refund. PostgreSQL and Stripe agreed on the deterministic
idempotency identity, canonical parameter hash, HMAC proof, Event request identity, immutable
Refund link and terminal guard release. The final state had no unresolved target alert, webhook
backlog or executable queue item, and the temporary restricted test key was revoked afterward.

This financial run used the local API overlay, not the immutable uploaded runtime. The upload-safe
manifest still uses the fail-closed placeholder RefundDesk API origin, so the evidence does not
claim that Stripe's uploaded artifact can execute the workflow by itself. The redacted local
evidence is split between
`p1-manual-stripe-app-financial-flow-2026-07-27T19-11-59-907Z.json` and
`p1-stripe-app-0.1.2-financial-preview-provenance-2026-07-27.json`.

The distinct external-account installation evidence remains attributed to installed version
`0.1.0`. The clean `0.1.1` upload proves reproducible packaging provenance; it does not by itself
claim that `0.1.1` was reinstalled or rerun in that external account. Likewise,
`P0-PUBLISH-001` means that no currently observed distribution constraint makes the pilot
impossible, not that Stripe has approved the App for Marketplace distribution. External-test link
access was closed after verification.

The repository foundations and durable pilot path are implemented and locally verified. The pinned
workspace, strict contracts, PostgreSQL role separation, ordered migrations, forced-RLS checks,
PostgreSQL integration suites, build, secret scanning and dependency audits pass.

The current local hardening revision also replaces a Prisma sibling-relation load at the financial
execution boundary with explicit sequential reads on the transaction client. Its full suite now
passes 396 workspace tests and 21 PostgreSQL 18 integration tests; the latter cover the real
adapter-pg boundary and the isolated queue capability, so neither an overlapping
`pg.Client.query()` warning nor a worker-capable pg-boss login can be silently accepted. The exact
standalone Stripe App graph separately passes 69 tests under its pinned pnpm 10.30.3 lockfile.

The hosted sandbox now runs on one hardened AWS Lightsail instance with five isolated containers,
PostgreSQL 18, a stable HTTPS origin, a private versioned backup bucket and live mode disabled.
Web, worker and migration have separate configuration and database authority. Four distinct
restricted Stripe test/sandbox credentials are split between web reads and worker effects, and the
web read keys were proved unable to create Refunds. The Stripe App signing secret exists only in
the worker. Web forwards the exact signed body to a private worker verifier, and an approval can
advance only when PostgreSQL binds it to a worker-created, append-only HMAC attestation of the
exact financial and identity snapshot.

A provider-neutral multi-target Dockerfile produces a minimal Next.js server, a portable worker and
a one-shot migrator. Web readiness verifies PostgreSQL/schema/RLS authority, while the worker has
independent generic probes for its exact pg-boss consumers, schedules and scanner coverage.

The deployed immutable backend artifact passed its probes and a real encrypted PostgreSQL backup
was restored on a disposable PostgreSQL 18 verifier. The approval command and trust boundary
changed after `0.1.2`, so that upload cannot carry the current source or installation evidence.
Version `0.1.3` is reserved in the local manifest but has not been uploaded.

Real Stripe calls then exposed a topology mismatch: the pilot credentials are direct-account
credentials, while the first hosted client/webhook code used Connect semantics. The current source
removes every `Stripe-Account` request option, binds each credential to an expected account ID and
adds `/api/webhooks/stripe-account/test` plus `/sandbox`. It rejects any webhook carrying
`Event.account`, an unexpected API version or live mode. Historical `connected_*` receipts remain
recovery-only and Event deduplication is account-global. The hosted direct-account delivery gate
must be rerun in both environments before the product is called commercially ready.

The production-shape offline configuration preflight also passes with four distinct database
principals, separately scoped Stripe credentials, four distinct application keys and a dedicated
verifier token. Synthetic temporary configuration files used for that check were removed
immediately afterward.

On 26 July 2026, the opt-in durable gate also passed against the selected Stripe test account. It
created a synthetic card PaymentIntent, routed a partial refund through a distinct requester and
approver, executed exactly one real test Refund through pg-boss, replayed the execution without a
second Refund or attempt, reconciled the immutable Refund link, and removed its ephemeral database
and login roles before writing redacted `PASS` evidence. This is test-mode engineering evidence,
not live authorization or production readiness.

## Prerequisites

- Node.js 24.18.0
- pnpm 11.17.0
- PostgreSQL 18 through Docker Desktop or an isolated local PostgreSQL 18 instance
- Stripe CLI with the Apps plugin for local preview or future test/sandbox validation

The workspace uses pnpm 11.17.0. Stripe's CLI packages the UI extension independently, so
`apps/stripe-app` intentionally has a standalone pnpm 10.30.3 lockfile with the same explicitly
pinned direct dependency versions; CI verifies both installation graphs.

## Local setup

```powershell
Copy-Item .env.example .env.local
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm db:local:roles
pnpm db:generate
pnpm db:migrate:dev
pnpm db:pgboss:migrate
pnpm db:access:check
pnpm verify
pnpm test:integration
pnpm audit:prod
```

The local role bootstrap is idempotent and also repairs an existing Docker volume created before
the init script was added. Prisma migrations run with the dedicated owner credential and then
apply the application grants. pg-boss migrations run with that owner and then delegate only its
runtime schema privileges. `db:access:check` proves that the distinct web, worker and queue logins
are unprivileged and fail closed without tenant context, that only the queue login can use pg-boss,
and that only the worker login can persist or read approval attestations.

External-alert observation deliberately uses column-scoped PostgreSQL INSERT grants. Its
parameterized SQL names only the allowed financial-observation fields, leaving alert lifecycle
fields database-managed; do not replace this with a broad table grant.

Never paste secrets into source files, Git, logs, issues, or chat. Put local credentials only in
the ignored `.env.local`. Do not run real sandbox scenarios without explicit test/sandbox
credentials and synthetic allowlisted objects.

## Persistent sandbox release contract

The hosted sandbox release contract can also be checked locally:

```powershell
pnpm container:check
pnpm config:release:check -- .env.platform.local .env.worker.local .env.migration.local
pnpm db:release:prepare
```

The three environment files are ignored and service-scoped. In `NODE_ENV=production`, use
`STRIPE_PLATFORM_TEST_READ_KEY` and `STRIPE_MANAGED_SANDBOX_READ_KEY` only in the web service, and
distinct `STRIPE_PLATFORM_TEST_EFFECT_KEY` and `STRIPE_MANAGED_SANDBOX_EFFECT_KEY` only in the
worker. Both services must carry the same `STRIPE_PLATFORM_TEST_ACCOUNT_ID` and
`STRIPE_MANAGED_SANDBOX_ACCOUNT_ID`, and those IDs must be distinct. Platform alone receives
`STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET` and `STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET`;
`STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET` stays literally `disabled`. `STRIPE_APP_SIGNING_SECRET` and
the approval-attestation HMAC key belong only to the worker. Platform receives only the private
verifier URL and the bearer token shared with worker. The migration job receives database URLs
only. Generic `STRIPE_PLATFORM_TEST_KEY` and `STRIPE_MANAGED_SANDBOX_KEY` remain a non-production
compatibility bridge and are rejected by production loaders.

`db:release:prepare` is the sole release migration entrypoint: it runs Prisma migrations and grants,
pg-boss migration and grants, then the real-login access check. It must run once in a serialized
one-shot job, never from web or worker startup. Detailed hosted-topology and worker-owned approval
ADRs remain local under the repository's Markdown publication policy; this README records the
published runtime contract.

## Durable Stripe test gate

`pnpm test:sandbox` is deliberately excluded from ordinary tests and fails closed unless every
required test/sandbox setting and the exact synthetic-test consent are present:

```powershell
$env:REFUNDDESK_RUN_SANDBOX_E2E = "I_ACKNOWLEDGE_SYNTHETIC_TEST_ONLY"
$env:REFUNDDESK_GLOBAL_LIVE_ENABLED = "false"
$env:REFUNDDESK_SANDBOX_E2E_ENVIRONMENT = "test"
$env:REFUNDDESK_SANDBOX_E2E_ADMIN_DATABASE_URL = "<loopback PostgreSQL 18 owner URL for a disposable cluster>"
$env:REFUNDDESK_SANDBOX_E2E_DISPOSABLE_POSTGRES_CLUSTER = "I_ACKNOWLEDGE_DEDICATED_DISPOSABLE_POSTGRES_CLUSTER"
$env:STRIPE_PLATFORM_TEST_ACCOUNT_ID = "<test-mode account ID>"
$env:STRIPE_MANAGED_SANDBOX_ACCOUNT_ID = "<managed-sandbox account ID>"
$env:STRIPE_PLATFORM_TEST_EFFECT_KEY = "<test-mode effect key>"
$env:STRIPE_FIXTURE_TEST_KEY = "<test-mode key bound to the selected account>"
$env:STRIPE_MANAGED_SANDBOX_EFFECT_KEY = "<separate managed-sandbox effect key>"
$env:STRIPE_FIXTURE_MANAGED_SANDBOX_KEY = "<managed-sandbox fixture key>"
pnpm test:sandbox
```

The gate refuses production, live mode, live keys, non-loopback PostgreSQL and a fixture key bound
to another account. Because PostgreSQL roles are cluster-global, it also requires the exact
disposable-cluster consent above, an exclusive advisory lock and a control cluster with no other
connectable non-template database. Never point it at the normal local development cluster or any
shared PostgreSQL service. It creates only a synthetic EUR card payment of 10.99 and a partial test
refund of 1.09. A fully converged run deletes its isolated database and runtime logins before
atomically writing a fingerprint-only JSON result under the ignored `sandbox-evidence.local`
directory. If execution has started but convergence is uncertain, it preserves the database for
reconciliation and does not write `PASS`.

The human checkpoints, real Stripe cases, operating procedures and evidence rules are documented
in [PLANS.md](./PLANS.md), [docs/SANDBOX_TEST_PLAN.md](./docs/SANDBOX_TEST_PLAN.md), and
[docs/OPERATIONS_RUNBOOK.md](./docs/OPERATIONS_RUNBOOK.md).
