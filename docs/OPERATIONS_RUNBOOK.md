# RefundDesk pilot operations runbook

> Scope: local pilot, Stripe test mode and managed sandbox  
> Live execution: prohibited  
> First rule: preserve the financial guard when the Stripe outcome is uncertain

## 1. Operator safety

Before any action:

1. identify the tenant, Stripe account, mode and sandbox marker;
2. verify the object is synthetic and `livemode=false`;
3. avoid copying secrets or full payloads into notes;
4. prefer read-only inspection;
5. do not manually change a financial state to make a queue “green”;
6. never generate a new Stripe idempotency key for an existing request.

Stop and escalate as Severity 0 if a live object, wrong account or duplicate Refund is observed.

## 2. Local startup

Prerequisites:

```bash
node --version
pnpm --version
stripe --version
docker --version
```

Expected Node is `24.18.0`; expected pnpm is `11.17.0`.
The independently packaged Stripe extension is the documented exception: its nested lockfile is
validated with pnpm `10.30.3`, matching the successful unpublished upload.

Install and initialize:

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
docker compose up -d postgres
pnpm db:local:roles
pnpm db:generate
pnpm db:migrate:dev
pnpm db:pgboss:migrate
pnpm db:access:check
```

The Docker service binds only to loopback. Its init script creates distinct
`refunddesk_web_login` and `refunddesk_worker_login` users; `db:local:roles` is
an idempotent repair step for pre-existing local volumes and refuses non-local
targets. Prisma and pg-boss migrations use `DATABASE_MIGRATION_URL`.
Application runtime grants are applied after Prisma, and pg-boss runtime grants
are applied after the owner migration. Do not start the web or worker with the
owner credential.

External-alert INSERT rights are intentionally column-scoped. The repository uses a parameterized
INSERT listing only those allowed columns so PostgreSQL, not runtime code, owns `id`, `status`,
acknowledgement and reconciliation defaults. If this path returns `42501`, verify the generated SQL
and current grants; never repair it by granting table-wide INSERT or lifecycle-column writes.

Pilot queues use pg-boss' non-partitioned default. The worker has DML and
function execution in the `pgboss` schema, but no schema `CREATE` privilege.
Enabling partitioned queues therefore requires a reviewed owner migration
instead of a runtime privilege escalation.

Start the three processes in separate terminals:

```powershell
pnpm dev:platform
pnpm dev:worker
$env:REFUNDDESK_DEV_API_BASE = "https://<temporary-host>/api"
pnpm dev:stripe-app
```

The Stripe App launcher rejects HTTP, loopback, IP and reserved DNS suffixes, then verifies that
every resolved address is public. It invokes the CLI without a command shell, generates an ignored
local manifest from `stripe-app.json`, forces the probe on and live off, then removes the generated
manifest and `.build` output when the CLI exits. DNS classification is a startup snapshot, not a
defense against later rebinding; use only a short-lived operator-controlled tunnel hostname. The
temporary HTTPS path is for a short evidence window only; stop it after use. A human must grant the
Dashboard's browser prompt for local-network access so Stripe can load the CLI-served extension
bundle.

If the tunnel forwards the complete local Next.js origin, `/`, `/api/health` and `/api/ready` are
also publicly reachable for that window without a Stripe signature. They expose no tenant data,
but readiness performs a database probe. Prefer a path-restricted proxy where available; otherwise
keep the window short, monitor the local process and stop the tunnel immediately after collecting
the evidence.

Webhook forwarding is environment-specific. Start only the test or sandbox listener being exercised and map it to the matching endpoint/secret. Never forward a live endpoint in this cycle.

## 3. Readiness checklist

The process liveness endpoint proves only that the process runs. Readiness must fail when an indispensable dependency or safety condition fails.

Verify:

- PostgreSQL is reachable with the unprivileged runtime role;
- required migrations are applied;
- pg-boss schema is ready before worker claims;
- the App signing secret for the exact Stripe environment is configured without printing it;
- exactly the intended test or sandbox Stripe credential is available;
- global live switch is false;
- tenant live switch is false;
- live credential is absent;
- worker and scanner heartbeat are current;
- no unresolved startup validation error exists.

Useful local checks:

```bash
docker compose ps
pnpm db:access:check
pnpm secrets:check
pnpm typecheck
```

`db:access:check` is a real database check. It verifies the login identities,
absence of `SUPERUSER`/`BYPASSRLS`, fail-closed tenant reads, separation of the
web role from pg-boss, and a rolled-back pg-boss queue operation by the worker.
If PostgreSQL is unavailable, the command fails; it must never be reported as
passed from a static test.

## 4. Normal operating signals

Track per environment:

- requests created, approved, rejected, expired and stale;
- executions by workflow/effect state;
- Stripe API latency and redacted error code;
- age of oldest executable job;
- webhook receipt lag and signature failures;
- scanner last successful completion and checkpoint age;
- external and proof-replay alert counts;
- tenant-context/RLS failures;
- log-redaction test status.

Never label raw e-mail, justification, rejection reason, request body or ciphertext as a metric dimension.

Suggested pilot alerts:

| Condition                                              | Severity                  |
| ------------------------------------------------------ | ------------------------- |
| Any live context or wrong account/environment          | S0                        |
| More than one Refund ID linked/candidate for a request | S0                        |
| Confirmed cross-tenant access or exposed key           | S0                        |
| `reconciliation_required` older than 15 minutes        | S1                        |
| Scanner last success older than 30 minutes             | S1                        |
| Oldest executable job older than 10 minutes            | S1                        |
| Repeated webhook signature failures                    | S1/S2 depending on source |
| Retention purge overdue                                | S2                        |

## 5. Incident severity and first response

### Severity 0

Examples:

- live effect in the pilot;
- duplicate Refund attributable to RefundDesk;
- wrong account, payment or environment;
- confirmed tenant isolation breach;
- exposed Stripe, signing, webhook, encryption or HMAC key.

Actions:

1. Disable the global effect switch and stop worker claims.
2. Leave webhook ingestion and read-only reconciliation available if safe.
3. Preserve logs and redacted identifiers; do not export sensitive payloads.
4. Record the last known safe commit, deployment/process version and timestamp.
5. Rotate compromised credentials immediately.
6. Inspect Stripe Workbench/request logs for unexpected activity.
7. Do not delete or relink Refund records.
8. Reconcile every request in `possible`, `identified` or `reconciliation_required`.
9. Add a regression test and complete a post-incident review before resuming.

If a Stripe API key is exposed, rotate it first, review activity, and contact Stripe Support if activity is unrecognized.

### Severity 1

Examples:

- ambiguous effect with guard intact;
- worker or scanner unavailable past its objective;
- audit append failure;
- sensitive text written to logs.

Actions:

1. Pause new execution claims when they could increase ambiguity.
2. Keep the guard intact.
3. Repair/restart the failed component.
4. Reconcile before resuming.
5. Rotate or purge affected logging data when applicable and allowed by the incident evidence policy.

### Severity 2

Examples:

- elevated non-financial errors;
- delayed audit export;
- overdue but not yet policy-breaching maintenance.

Handle in normal engineering flow, preserving evidence.

## 6. Ambiguous Refund recovery

Trigger: timeout, connection reset, worker crash after effect boundary, webhook-before-response race or multiple plausible Stripe candidates.

Do not:

- create another job with a new key;
- unlink the first Refund ID;
- mark the request failed merely to release the guard;
- issue a compensating Refund.

Procedure:

1. Record request UUID, expected account, environment, PaymentIntent/Charge, amount, currency and original idempotency-key fingerprint.
2. Confirm `effect_state` is `possible` or `identified`; correct only through a reviewed domain operation, never ad hoc SQL.
3. Query Stripe read-only in the exact account/environment.
4. Look for the synchronous response record, Event request idempotency key when present, and valid HMAC candidates.
5. Apply the evidence order from ADR 0002.
6. If exactly one Refund is proven, link it once and process its current status.
7. For an empty-scan proof, verify that the complete Stripe window starts no later than
   `execution_started_at` and ends no earlier than the database-managed
   `reconciliation_safe_after_at`. Never use `execution_started_at` alone.
8. An orphaned `started` attempt must first be durably moved to reconciliation so it receives a
   safe boundary; only a later scan can prove absence.
9. If no effect is conclusively proven, record `absence_proven` with evidence before any guard
   release.
10. If proof remains ambiguous, keep `reconciliation_required` and escalate.
11. Run the relevant crash/regression test before unpausing.

## 7. Duplicate or proof-replay investigation

1. Stop new claims for the affected tenant.
2. Preserve the immutable first Refund ID.
3. Compare account, environment, payment, amount, currency, creation time, Event request data and proof version.
4. Mark a different Refund ID carrying the same proof as `proof_replay`/tampering.
5. Determine whether it came from RefundDesk, native Dashboard action or another credential using Stripe request logs.
6. If RefundDesk used more than one idempotency key, treat as Severity 0.
7. Do not hide the alert by acknowledging it until the investigation is attached to the audit.

### Acknowledgement is not reconciliation

An external, tampered or proof-replay alert protects its exact tenant, installation, environment
and payment scope. In the pilot:

1. acknowledging the alert records only that an operator reviewed it;
2. acknowledgement never permits another RefundDesk request for that payment;
3. do not edit `reconciled_at`, reopen a released request guard or create a replacement request;
4. reconcile Stripe read-only and retain the alert as financial evidence;
5. escalate any need to reuse that payment to engineering and a reviewed future policy.

For an Event, compare `Event.created` with the stored watermark. A direct scanner retrieval is a
current snapshot and is instead validated against the immutable Refund ID and complete payment
tuple. Either authoritative observation may correct the same linked Refund from `succeeded` to
`failed_terminal`; never relink it or rewrite the original terminal and guard-release timestamps.

## 8. Webhook outage

Symptoms:

- signature errors;
- no receipts while Stripe shows events;
- growing Event delivery retries;
- environment endpoint mismatch.

Procedure:

1. Verify the endpoint is the expected test or sandbox endpoint.
2. Verify raw-body handling was not changed.
3. Verify the matching webhook secret is loaded without printing it.
4. Check clock drift and request body limits.
5. Restore ingestion.
6. Use the creation-window scan to recover newly created Refunds and direct linked-ID refresh to
   converge older linked Refunds outside the overlap; replay real Stripe Events only when useful
   for contract verification.
7. Confirm duplicate replay is harmless.
8. Verify scanner completion and checkpoint age before closing.

Never accept an unsigned payload as a recovery shortcut.

## 9. Scanner lag or failure

Procedure:

1. Pause only the affected environment’s scan claim if necessary.
2. Inspect the last successful checkpoint and the failing page/cursor.
3. Confirm a temporal page failure did not advance the temporal checkpoint. A linked-target
   failure may coexist with a valid temporal checkpoint advance, but it must not starve later
   targets or suppress the aggregate retry.
4. Fix credential, rate-limit, pagination or database error.
5. Resume from the previous checkpoint with the one-hour overlap.
6. Confirm Refund IDs deduplicate repeated coverage.
7. Confirm completion time is under the thirty-minute detection objective.

Do not manually move a checkpoint past an unprocessed window.

## 10. Queue and worker recovery

For a stopped worker:

1. keep web mutations available only if they cannot enqueue unsafe work;
2. inspect oldest jobs and effect states read-only;
3. restore database and pg-boss readiness;
4. start one worker;
5. observe claims, attempts and Stripe calls;
6. scale only after confirming unique claims and stable idempotency.

Recovery matrix:

- `approved/not_started` and `executing/not_started`: re-enqueue;
- `executing/absence_proven`: re-enqueue only with the persisted canonical execution and expected
  deterministic key;
- `executing/possible`: move to reconciliation and never call Stripe directly;
- missing execution after `absence_proven`, a wrong key or an already linked Refund: fail closed
  into reconciliation.

For a poison job:

- retain the request guard;
- record the redacted error class;
- move to terminal failure only when absence of effect is proven;
- otherwise move to reconciliation.

Never delete a financial job solely to clear queue depth.

## 11. Database migration failure

1. Stop web writes and worker claims.
2. Keep the database owner credential isolated.
3. Determine whether the migration transaction committed.
4. Use migration tooling state and schema inspection; do not guess.
5. Forward-fix a partially applied migration unless an already reviewed reversible rollback exists.
6. Re-run RLS privilege and negative tenant tests.
7. Start web, then worker, only when readiness passes.

Do not grant owner or `BYPASSRLS` to a runtime to bypass a migration problem.

## 12. Key rotation

### Stripe/API, app signing or webhook secret

1. Stop effect claims if the compromised key could create Refunds.
2. Rotate/revoke in Stripe.
3. update the local secret source without committing it;
4. restart the relevant process;
5. verify the old credential fails and the new one works in the intended environment;
6. review Stripe activity logs.

Prefer a restricted API key with only the required operations whenever the Stripe App authentication model permits it.

### Field-encryption key

1. Add a new version to the secret source.
2. Make it active for new writes.
3. Keep the prior version decrypt-only.
4. Re-encrypt in bounded, audited batches.
5. Verify counts and AAD failures.
6. Retire the old version only after no retained row depends on it and backups have aged out.

### Proof-HMAC key

1. Add a new version.
2. Sign new proofs with it.
3. Keep prior versions verify-only for the maximum retained workflow lifetime.
4. Never re-sign old Refund metadata to conceal its original version.

## 13. Uninstallation

1. Mark the installation suspended immediately.
2. Reject new signed mutations and job claims.
3. Let no `not_started` financial job cross the effect boundary.
4. Reconcile jobs already `possible` or `identified`.
5. Record uninstall timestamp and purge deadline.
6. Start the 30-day tenant deletion process.
7. Remove webhooks/credentials when they are no longer needed for safe reconciliation.

Uninstallation is not evidence that an in-flight Stripe effect did not happen.

## 14. Retention and purge

Follow `docs/RETENTION.md`. The maintenance role can execute only the reviewed purge procedure. Web and worker never purge tenant data directly.

Before purge:

- verify uninstall and deadline;
- verify no documented legal hold;
- verify no unresolved effect;
- produce a dry-run count by data class;
- obtain the required operator review.

After purge, retain only the non-personal purge certificate described in the retention policy.

## 15. Shutdown

For a normal local stop:

1. stop new test actions;
2. wait for `not_started` claims to settle;
3. inspect any `possible` effects;
4. stop the worker;
5. stop web/UI processes;
6. stop webhook forwarding;
7. stop PostgreSQL only after writes are complete.

```bash
docker compose stop postgres
```

Do not delete the database or volumes as part of routine shutdown.

## 16. Exit criteria after an incident

- cause and affected scope identified;
- account/environment verified;
- every ambiguous request reconciled or guarded;
- exposed keys rotated;
- scanners and webhooks caught up;
- audit evidence preserved and redacted;
- regression test added;
- local gates pass;
- sandbox scenario re-run when the incident touched Stripe behavior;
- `PLANS.md`, ADR or threat model updated if an assumption changed.
