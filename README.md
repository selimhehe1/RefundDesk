# RefundDesk

RefundDesk is a Stripe App pilot that routes card-refund requests through a one-person approval
workflow, records every workflow decision, and flags refunds detected outside it.

The pilot is test/sandbox-only. Live refunds, Marketplace publication, Billing, e-mail
notifications, paid infrastructure and production deployment are deliberately disabled.

## Current pilot status

Phase 0 remains `BLOCKED_HUMAN`, but the original legal blocker is cleared. The authorized human
accepted the Stripe Apps Agreement, Stripe accepted the unpublished RefundDesk `0.1.0` upload, and
the version is installed only in the account's **Mode test** environment. The real extension renders
on the synthetic EUR PaymentIntent with `livemode=false`; the uploaded production-safe manifest
keeps both the direct probe and live operation disabled and fails closed against its placeholder API.
The repository now targets unuploaded version `0.1.1`, separating the post-probe fixes from the
installed evidence version; any next upload must come from a clean commit with a recorded checksum.

Chrome local-network access is granted. A real Stripe test-mode signed request now passes raw-body
verification and the non-mutating Administrator-only Phase-0 report returns HTTP 200. The runtime
role is identified by its signed stable ID (`super_admin`) even though the installed SDK's type
definition omits that current field.

The signed allowlisted probe created one small EUR partial Refund in test mode. An exact signed
replay returned the same Stripe Refund without a second effect. A second test Refund, created
outside RefundDesk with empty metadata, was found in under eight minutes by real periodic
reconciliation and persisted as an open `external` alert under the restricted worker role.

No live Refund, Marketplace publication, live request or production deployment was performed. The
same distinct real user with Stripe's built-in `View only` role now passes both role-gap cases. The
user can view a successful synthetic card payment but Stripe exposes no native refund action. The
exact Stripe user identity then submitted a real Stripe-authenticated RefundDesk request, which was
persisted as `pending_approval/not_started` and safely canceled by the requester with no approval,
execution attempt or Stripe Refund.

Stripe did not attest that user's `View only` claim in the request: with the app retaining
`charge_write`, Stripe rejected the special `stripe_roles` signing input before it reached
RefundDesk. The request therefore proves authenticated identity and request creation, not signed
role propagation. RefundDesk now models that boundary explicitly with `roles_asserted=false`, omits
`stripe_roles`, preserves durable role observations and still requires an asserted Administrator
role for privileged operations. A distinct connected test account and the remaining independently
bound test/sandbox topology are still necessary. The connected-webhook, copied-proof replay,
cross-test/sandbox signature and full environment-isolation cases are not yet complete, so the
verdict correctly remains `BLOCKED_HUMAN`.

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
- Stripe CLI with the Apps plugin when continuing the real Phase 0 matrix

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

The human checkpoints, real Stripe cases, operating procedures and evidence rules are documented
in [PLANS.md](./PLANS.md), [docs/SANDBOX_TEST_PLAN.md](./docs/SANDBOX_TEST_PLAN.md), and
[docs/OPERATIONS_RUNBOOK.md](./docs/OPERATIONS_RUNBOOK.md).
