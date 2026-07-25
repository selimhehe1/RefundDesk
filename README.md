# RefundDesk

RefundDesk is a Stripe App pilot that routes card-refund requests through a one-person approval
workflow, records every workflow decision, and flags refunds detected outside it.

The pilot is test/sandbox-only. Live refunds, Marketplace publication, Billing, e-mail
notifications, paid infrastructure and production deployment are deliberately disabled.

## Current pilot status

Phase 0 is `BLOCKED_HUMAN`: Stripe CLI authentication and one synthetic EUR PaymentIntent in test
mode succeeded with `livemode=false`, but Stripe refused the unpublished app upload because the
Stripe Apps Agreement has not been accepted by an authorized human.

No Refund, app upload or app installation was completed. Real signed UI, webhook, role-gap,
idempotency and managed-sandbox cases therefore remain unvalidated.

The repository foundations, domain, signed API, worker, pilot UI and database layer are implemented
locally. An isolated PostgreSQL 18.4 process exercised the real migration, pg-boss migration,
least-privilege bootstrap, runtime access checks, tenant isolation, purge behavior and concurrency
matrix. The PostgreSQL integration and local test suites pass; exact executed counts and gate
evidence are recorded in [PLANS.md](./PLANS.md). Formatting, lint, type checks, the production
build, secret scanning and production dependency audits also pass. This local evidence is not a
substitute for the blocked Stripe feasibility gate.

## Prerequisites

- Node.js 24.18.0
- pnpm 11.17.0
- PostgreSQL 18 through Docker Desktop or an isolated local PostgreSQL 18 instance
- Stripe CLI with the Apps plugin when resuming the human-gated Phase 0 work

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
```

The local role bootstrap is idempotent and also repairs an existing Docker volume created before
the init script was added. Prisma migrations run with the dedicated owner credential and then
apply the application grants. pg-boss migrations run with that owner and then delegate only its
runtime schema privileges. `db:access:check` proves that the distinct web and worker logins are
unprivileged, fail closed without tenant context, and that only the worker can use pg-boss.

Never paste secrets into source files, Git, logs, issues, or chat. Put local credentials only in
the ignored `.env.local`. Do not run real sandbox scenarios without explicit test/sandbox
credentials and synthetic allowlisted objects.

The human checkpoints, real Stripe cases, operating procedures and evidence rules are documented
in [PLANS.md](./PLANS.md), [docs/SANDBOX_TEST_PLAN.md](./docs/SANDBOX_TEST_PLAN.md), and
[docs/OPERATIONS_RUNBOOK.md](./docs/OPERATIONS_RUNBOOK.md).
