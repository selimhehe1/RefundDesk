# RefundDesk

RefundDesk is a Stripe App pilot that routes card-refund requests through a one-person approval
workflow, records every workflow decision, and flags refunds detected outside it.

The pilot is test/sandbox-only. Live refunds, Marketplace publication, Billing and e-mail
notifications are deliberately disabled. An AWS sandbox deployment is authorized under a
10 EUR/month ceiling; it contains synthetic data only.

## Current pilot status

As of 8 August 2026, RefundDesk remains a test/sandbox engineering pilot and is not available for
commercial evaluation. Live mode, customer data, Stripe review submission and Marketplace
publication remain disabled and unapproved. ADR 0024 records that the exposed exact-e4
managed-sandbox read/effect and App-signing bindings completed their replacement-only transition
with `PASS_CONTAINED` on 3 August. ADR 0034 records that two independent reviews of its nine
execution-time corrections ended `NO_GO_REOPENING`; this does not relabel the historical outcome,
but the consumed chain cannot admit it or support a reopening. Two read-only pre-commit diagnostics
on 8 August observed revision `8da280b7...`, public Caddy, the worker and both maintenance timers
active, internal TCP listeners on ports 80/443 and a runtime quiescence journal. They also observed
the AWS 80/443 firewall closed and unchanged, live disabled and the financial state quiescent. The
diagnostics used pre-final tooling and are not an admissible ADR 0032 postflight; a committed,
HEAD-bound capture remains pending. Evidence artifacts named below are redacted and retained
locally under the ignored
`sandbox-evidence.local/` directory; they are not committed to the repository.

Phase 0 is `PASS`: all 34 required Stripe cases are recorded as `passed_real`. RefundDesk proved the
real test-account and managed-sandbox boundaries, signed-request rejection matrix, role gap,
backend Refund permission, Stripe idempotency, historical connected-webhook deduplication and
ordering, external-Refund detection, copied-proof classification and minimal permission set.

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
the uploaded commit. This historical `0.1.2` evidence does not transfer to the current backend
trust boundary or to `0.1.3`. It does not mean Marketplace approval.

The P1 UI makes approval an explicit two-step financial action, preserves mutation nonces across
ambiguous retries, serializes concurrent mutations, displays exact currency amounts and approval
context, invalidates stale account and scope state, and hardens onboarding, settings, alerts and
audit-download attribution.

On 27 July 2026, two distinct authenticated users completed the managed-sandbox happy path through
the signed Stripe UI: one created the synthetic card-refund request, the other approved it, and one
worker produced exactly one terminal Refund. PostgreSQL and Stripe agreed on the deterministic
idempotency identity, canonical parameter hash, HMAC proof, Event request identity, immutable
Refund link and terminal guard release. The final state had no unresolved target alert, webhook
backlog or executable queue item, and the temporary restricted test key was revoked afterward.

This financial run used the local API overlay, not the immutable uploaded runtime. The upload-safe
manifest still uses the fail-closed placeholder RefundDesk API origin, so the evidence does not
claim that the `0.1.2` uploaded artifact can execute the workflow by itself. The redacted local
evidence is split between
`p1-manual-stripe-app-financial-flow-2026-07-27T19-11-59-907Z.json` and
`p1-stripe-app-0.1.2-financial-preview-provenance-2026-07-27.json`.

Separately, on 26 July 2026, the opt-in durable test gate created a synthetic card PaymentIntent,
routed a partial refund through a distinct requester and approver, executed exactly one real test
Refund through pg-boss, replayed the execution without a second Refund or attempt, reconciled the
immutable Refund link, and removed its ephemeral database and login roles. That result remains
test-mode engineering evidence, not live authorization or production readiness.

The distinct external-account installation evidence remains attributed to installed version
`0.1.0`. The clean `0.1.1` upload proves reproducible packaging provenance; it does not by itself
claim that `0.1.1` was reinstalled or rerun in that external account. Likewise,
`P0-PUBLISH-001` means that no currently observed distribution constraint makes the pilot
impossible, not that Stripe has approved the App for Marketplace distribution. External-test link
access for that Phase-0 evidence window was closed after verification.

The repository foundations and durable pilot path are implemented and locally verified. The pinned
workspace, strict contracts, PostgreSQL role separation, ordered migrations, forced-RLS checks,
PostgreSQL integration suites, build, secret scanning and dependency audits pass.

The current local hardening revision also replaces a Prisma sibling-relation load at the financial
execution boundary with explicit sequential reads on the transaction client. Its full suite now
passes 716 workspace tests and 29 PostgreSQL 18 integration tests; the latter cover the real
adapter-pg boundary and the isolated queue capability, so neither an overlapping
`pg.Client.query()` warning nor a worker-capable pg-boss login can be silently accepted. The exact
standalone Stripe App graph separately passes 115 tests under its pinned pnpm 10.30.3 lockfile.
Formatting, lint, typecheck, build, secret scanning and production dependency audits also pass.
The PostgreSQL gate now creates and removes exact allowlisted ephemeral databases, applies
transaction-owning migrations before opening its rollback-only fixture transaction, and fails
closed instead of reporting skipped tests when its PostgreSQL URL is absent. The current 29-case
gate passed with no generated database or probe role left behind.

Exact-e4 (`e4cec06068d71afb5c2ac9fc04175bfdfd6756c2`) is the last revision with admitted
canonical deployment evidence on the approved AWS Lightsail instance. ADR 0030 records later
release attempts involving `8da280b7...`; the active state remains
`HOST_STATE_INDETERMINATE_POSTFLIGHT_REQUIRED` pending a final redacted ADR 0032 host postflight
captured from committed source. The preliminary diagnostics above are strong evidence of a
containment divergence but cannot be promoted into an admitted host-state record. Do not infer
public health or complete release/Compose correctness from them. The implemented postflight is a
point-in-time containment observer only; it cannot authorize release, recovery, ingress reopening,
worker or maintenance restart, or a financial proof. Those operations also require the applicable
tracked successor, exact CI and attested bundle where relevant, and a separate decision.

Web, worker and migration have separate configuration and database authority. Four distinct
restricted Stripe test/sandbox credentials are split between web reads and worker effects, and the
web read keys were proved unable to create Refunds. The Stripe App signing secret exists only in
the worker. Web forwards exact signed bodies to a private worker verifier, and an approval can
advance only when PostgreSQL binds it to a worker-created, append-only HMAC attestation of the
exact financial and identity snapshot. A provider-neutral multi-target Dockerfile produces a
minimal Next.js server, a portable worker and a one-shot migrator. Web and worker have independent
readiness probes for their exact database, queue, schedule and scanner responsibilities.

The direct-account webhook gate is `passed_real` on the earlier hosted revision
`42a1e4e65cf6e9144261a077c6956e77b368fffc` in both Stripe test mode and a managed sandbox. In each
environment, a real signed `refund.created` delivery was persisted
and processed once into one external-refund alert. A Stripe Workbench manual replay received a
second `2xx` response while the durable receipt and alert snapshot remained unchanged. No live or
Connect request was used. The obsolete test endpoint targeting a blocked legacy connected route
was then deleted; both direct endpoints remained enabled and unchanged. Redacted evidence is in
`stripe-hosted-direct-webhooks-2026-07-28.json` with SHA-256
`b0d85e964aa440dcda32dd601b48be11f3826fcc750f90b56a0c8ac2eabc737e` and the
legacy-cleanup artifact has SHA-256
`5c33976bae39318417a5282542a09c2f546c9eacc838952cb620bce4943f8952`.

That earlier `42a1e4e...` revision also passed a real encrypted backup and restore drill. Its
canonical scheduled
backup produced an `age`-encrypted archive stored with AES-256 server-side encryption in the
private versioned bucket. The archive hash, PostgreSQL checksums, migrations and separated runtime
roles were verified on a disposable PostgreSQL 18 verifier with the restore container isolated
from the network. The private identity, remote archive, temporary instance, volume, network and
access resources were removed afterward, while the hosted five-container stack remained healthy
and live-disabled. The redacted evidence file
`active-revision-backup-restore-2026-07-28.json` has SHA-256
`9221974966fc2a62bbfa19ca883354b9d2098cdb19392f29a6f19ef18a77d939`. This is a
test/sandbox recovery proof, not a production disaster-recovery or RPO/RTO claim.

Historical exact-e4 revision `e4cec060...` separately passed its canonical release, natural retention and
scheduled encrypted cold backup. Its first exact disposable restore attempt failed closed before
decryption because a Windows PowerShell native-pipeline carriage return made the final SHA-256
argument 65 bytes. No container or PostgreSQL process started, no retry was made, and remote plus
independent AWS cleanup found zero residue. Redacted historical
failure evidence is `restore-e4cec060-failed-pre-effect-2026-07-31.local.json`, SHA-256
`ab6233b44cba2fc8d1970c54ea25171da8ee765f0cbd76a2dd1efe54366782db`; that artifact is not
recoverability evidence. The corrected path then restored the exact e4 archive successfully on
1 August 2026 and removed every disposable resource. Redacted success evidence is
`restore-e4cec060-2026-08-01.local.json`, SHA-256
`951505c6b61ce77a4bc04645837e595e33c2b0a13543088913af4c153fc3acf3`, with top-level result
`PASS`. This is revision-bound sandbox recovery evidence, not a production DR, RPO or RTO claim;
the paid verifier exercise must not be repeated without new authorization.

Unpublished Stripe App `0.1.3` binds the UI to the stable hosted sandbox origin and was uploaded in
test mode from clean commit `c241a097fc5f4b8e8eaa2f057f9c7db40d9dffa3`. The backend trees are
unchanged from then-deployed commit `42a1e4e65cf6e9144261a077c6956e77b368fffc`. Stripe CLI reports
`UPLOAD_COMPLETED`; neither `--live` nor `--force` was used, and no review or publication was
requested. The reproducible Git source archive has SHA-256
`f8b792876ce8d1fe969a5d24e8ab3c5a37d13eb89755ed223caa3f7a61471611`, the committed manifest
has SHA-256 `89e44a68b5e82ed35234f80673db805047b01f499f9bfed5a4b2e4df222ceb9d`,
and the Stripe App source tree is `e0fdb14690a6302bfc42786ee574184c1b16a71d`. These hashes
describe the clean Git source; they are not presented as Stripe's internal upload ZIP.

The exact `0.1.3` version was then observed selected and installed in a distinct Stripe test
sandbox, and the hosted-origin permissions were reauthorized without a pending update. Separately,
the exact commit source rendered in Stripe developer preview and generated a real Stripe UI
signature. A test harness relayed the exact generated request bytes and signature unchanged to the
hosted AWS eligibility endpoint, which verified them and returned HTTP `200` with the expected
schema. No financial effect was performed. The raw capture and temporary harness were intentionally
destroyed, so the installation and relay observations are not reproducible from the redacted
artifact alone.

The controlled browser profile blocked the direct cross-origin request with
`ERR_BLOCKED_BY_CLIENT` before a normal response could be observed. Native direct-browser
end-to-end execution is therefore `BLOCKED_TOOLING` and is not claimed. The evidence result is
`PASS_WITH_TOOLING_LIMITATION`, recorded in
`stripe-app-0.1.3-install-signed-runtime-2026-07-28.json` with SHA-256
`33c5ceac81ede68a3469fcd4f472ecd9944fda62f1ec64686308572bdb463c0c`.

The production-shape offline configuration preflight also passes with four distinct database
principals, separately scoped Stripe credentials, four distinct application keys and a dedicated
verifier token. Synthetic temporary configuration files used for that check were removed
immediately afterward. RefundDesk remains limited to synthetic test/sandbox evaluation: it has no
live authorization, Stripe review, Marketplace publication or commercial-readiness claim.

## Prerequisites

- Node.js 24.18.0
- pnpm 11.17.0
- PostgreSQL 18 through Docker Desktop or an isolated local PostgreSQL 18 instance
- Stripe CLI with the Apps plugin for local preview or future test/sandbox validation

The workspace uses pnpm 11.17.0. Stripe's CLI packages the UI extension independently, so
`apps/stripe-app` intentionally has a standalone pnpm 10.30.3 lockfile with the same explicitly
pinned direct dependency versions; repository verification treats both installation graphs
separately.

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
