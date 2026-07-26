# RefundDesk

RefundDesk is a Stripe App pilot that routes card-refund requests through a one-person approval
workflow, records every workflow decision, and flags refunds detected outside it.

The pilot is test/sandbox-only. Live refunds, Marketplace publication, Billing, e-mail
notifications, paid infrastructure and production deployment are deliberately disabled.

## Current pilot status

Phase 0 is `PASS`: all 34 required Stripe cases are recorded as `passed_real`. RefundDesk proved the
real test-account and managed-sandbox boundaries, signed-request rejection matrix, role gap,
backend Refund permission, Stripe idempotency, connected webhook deduplication and ordering,
external-Refund detection, copied-proof classification and minimal permission set.

Every Phase-0 runtime route, client call, UI control and manifest switch has been removed from the
pilot surface. Unpublished version `0.1.1` was uploaded from clean commit
`100ae946ec593df1f21ba3efa6fe5c72ec366e89` with packaged artifact SHA-256
`ec5fc4940092343c9d6bd8b25948ea31272666d4e041a2ff23d36f10e27446be`. No live request,
production deployment, Stripe review submission or Marketplace publication was performed.

The distinct external-account installation evidence remains attributed to installed version
`0.1.0`. The clean `0.1.1` upload proves reproducible packaging provenance; it does not by itself
claim that `0.1.1` was reinstalled or rerun in that external account. Likewise,
`P0-PUBLISH-001` means that no currently observed distribution constraint makes the pilot
impossible, not that Stripe has approved the App for Marketplace distribution. External-test link
access was closed after verification.

The repository foundations and durable pilot path are implemented and locally verified. The pinned
workspace, strict contracts, PostgreSQL role separation, five migrations, forced-RLS checks,
PostgreSQL integration suites, build, secret scanning and dependency audits pass.

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
runtime schema privileges. `db:access:check` proves that the distinct web and worker logins are
unprivileged, fail closed without tenant context, and that only the worker can use pg-boss.

External-alert observation deliberately uses column-scoped PostgreSQL INSERT grants. Its
parameterized SQL names only the allowed financial-observation fields, leaving alert lifecycle
fields database-managed; do not replace this with a broad table grant.

Never paste secrets into source files, Git, logs, issues, or chat. Put local credentials only in
the ignored `.env.local`. Do not run real sandbox scenarios without explicit test/sandbox
credentials and synthetic allowlisted objects.

## Durable Stripe test gate

`pnpm test:sandbox` is deliberately excluded from ordinary tests and fails closed unless every
required test/sandbox setting and the exact synthetic-test consent are present:

```powershell
$env:REFUNDDESK_RUN_SANDBOX_E2E = "I_ACKNOWLEDGE_SYNTHETIC_TEST_ONLY"
$env:REFUNDDESK_GLOBAL_LIVE_ENABLED = "false"
$env:REFUNDDESK_SANDBOX_E2E_ENVIRONMENT = "test"
$env:REFUNDDESK_SANDBOX_E2E_ACCOUNT_ID = "<selected test account ID>"
$env:REFUNDDESK_SANDBOX_E2E_ADMIN_DATABASE_URL = "<explicit loopback PostgreSQL 18 owner URL>"
$env:STRIPE_PLATFORM_TEST_KEY = "<test-mode platform key>"
$env:STRIPE_FIXTURE_TEST_KEY = "<test-mode key bound to the selected account>"
$env:STRIPE_MANAGED_SANDBOX_KEY = "<separate managed-sandbox test key>"
pnpm test:sandbox
```

The gate refuses production, live mode, live keys, non-loopback PostgreSQL and a fixture key bound
to another account. It creates only a synthetic EUR card payment of 10.99 and a partial test refund
of 1.09. A fully converged run deletes its isolated database and runtime logins before atomically
writing a fingerprint-only JSON result under the ignored `sandbox-evidence.local` directory. If
execution has started but convergence is uncertain, it preserves the database for reconciliation
and does not write `PASS`.

The human checkpoints, real Stripe cases, operating procedures and evidence rules are documented
in [PLANS.md](./PLANS.md), [docs/SANDBOX_TEST_PLAN.md](./docs/SANDBOX_TEST_PLAN.md), and
[docs/OPERATIONS_RUNBOOK.md](./docs/OPERATIONS_RUNBOOK.md).
