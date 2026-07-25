# RefundDesk agent guide

Read `REFUNDDESK_CODEX_BUILD_SPEC.md` before changing product behavior. Read the relevant ADR and runbook before changing a financial boundary.

## Scope

- Phase 0 is a real Stripe gate. Mocks never produce `PASS`.
- Test mode and managed sandbox only until separately authorized.
- Never use customer data, live keys, live webhooks or live PaymentIntents.
- Do not deploy, publish the Stripe App, create paid resources or push remotely without explicit authorization.
- Preserve unrelated user changes in the worktree.

## Required toolchain

```text
Node.js 24.18.0
pnpm 11.17.0
Stripe API 2026-06-24.dahlia
PostgreSQL 18
```

Install and validate:

```bash
corepack enable
pnpm install --frozen-lockfile
stripe --version
docker compose up -d postgres
pnpm db:local:roles
pnpm db:generate
pnpm db:migrate:dev
pnpm db:pgboss:migrate
pnpm db:access:check
```

`db:migrate:*` uses `DATABASE_MIGRATION_URL`, then applies the application
runtime grants. `db:pgboss:migrate` uses the same owner credential, then grants
only the required queue access to the worker role. Never run either migration
from the web or worker runtime login.

## Development commands

```bash
pnpm dev:platform
pnpm dev:worker
pnpm dev:stripe-app
```

Verification:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm secrets:check
pnpm audit:prod
```

Run `pnpm test:sandbox` only with explicit test/sandbox credentials and synthetic allowlisted objects. Its result is reported separately from local tests.

## Financial invariants

1. A requester never approves their own request.
2. A request cannot be created without a distinct eligible approver.
3. Revalidate the Stripe object immediately before the effect.
4. Never keep a database transaction open during a Stripe API call.
5. A request uses one deterministic Stripe idempotency key forever.
6. Never retry an ambiguous call with a different key.
7. The first linked Refund ID is immutable.
8. `reconciliation_required` never releases the financial guard.
9. A pending Refund keeps the guard until a terminal Stripe status.
10. Account, mode and sandbox are explicit at every boundary.
11. Live requires both global and tenant switches; both remain false in this cycle.
12. Money is a decimal string at API boundaries and `bigint` internally.

## Security conventions

- Validate signed requests from raw bytes with strict schemas.
- Verify webhook signatures from the raw body before parsing.
- Set tenant context as the first statement in every tenant transaction.
- Web and worker roles must not have `BYPASSRLS`.
- Store secrets only in ignored local files or a secret manager.
- Use separate, versioned keys for AES-256-GCM field encryption and HMAC proofs.
- Never log secrets, full signatures, full Stripe payloads, PII, justifications or rejection reasons.
- Add a regression test for every financial or isolation bug.

## Change discipline

- Use an ADR for a changed architecture, dependency contract, state transition or safety policy.
- Update `PLANS.md` after each phase with evidence, not optimism.
- Do not mark a real Stripe gate passed from a unit test, fixture or mock.
- Avoid generic Stripe proxy endpoints and broad API keys.
- Keep Stripe UI extensions on the official Stripe component toolkit.

## Definition of done

A change is done when its relevant format, lint, type, test and build gates pass; negative paths are covered; documentation matches behavior; no critical TODO or production mock remains; and any sandbox claim has a redacted evidence artifact.
