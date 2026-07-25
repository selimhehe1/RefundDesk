# RefundDesk implementation plan

> Last updated: 25 July 2026  
> Current gate: `BLOCKED_HUMAN`  
> Blocker: the Stripe Apps Agreement has not been accepted by an authorized human  
> Allowed environment: local + Stripe test/managed sandbox

Checkboxes represent observed evidence or locally implemented scope. Local tests, fixtures and
PostgreSQL integration do not validate the real Stripe Phase 0 gate.

## Phase 0 — real Stripe feasibility gate

Status: `BLOCKED_HUMAN`.

Real preflight completed:

- [x] Authenticate the Stripe CLI against the intended test account.
- [x] Create and confirm one synthetic EUR PaymentIntent in test mode with `livemode=false`.
- [x] Attempt the unpublished Stripe App upload and record Stripe’s legal-agreement blocker.

Not performed:

- [ ] Upload the unpublished Stripe App.
- [ ] Install the unpublished Stripe App.
- [ ] Render `stripe.dashboard.payment.detail` on an allowlisted synthetic payment.
- [ ] Verify the canonical signed envelope against real signed UI bytes.
- [ ] Prove the Administrator / `View only` role gap with two real users.
- [ ] Create a backend Refund with the app’s real permissions.
- [ ] Replay the Stripe idempotency key against a real Refund.
- [ ] Receive and deduplicate a real `refund.created` Event.
- [ ] Detect a real manual external Refund.
- [ ] Classify copied metadata from real Stripe objects.
- [ ] Prove test mode and managed sandbox independently.
- [ ] Confirm the minimal permissions and pilot publishability.
- [ ] Produce the complete redacted Phase 0 evidence set.
- [ ] Disable and remove the direct probe endpoint before pilot completion.

No Refund, app upload, app installation, Marketplace action or live operation was performed.
Continuation requires an authorized human to review and accept the Stripe Apps Agreement. Login,
MFA, installation, permissions and the second Stripe user remain human-controlled checkpoints.

## Phase 1 — repository foundations

Status: `LOCALLY_VERIFIED`.

- [x] Preserve the v1.0 specification and publish the v1.1 pilot contract locally.
- [x] Add the agent guide, implementation plan, ADRs, threat model, runbook and retention policy.
- [x] Create the pinned pnpm workspace and package boundaries.
- [x] Configure strict TypeScript, formatting, lint, tests, build and secret scanning.
- [x] Bring up an isolated PostgreSQL 18.4 process and execute the real migration, role bootstrap,
      pg-boss, access-check and integration suites.
- [x] Separate web, worker and migration connection contracts.

## Phase 2 — domain and database

Status: `LOCALLY_VERIFIED`; 18 integration cases ran against an isolated PostgreSQL 18.4 process.
This remains local implementation evidence, not real Stripe evidence.

- [x] Implement exact-money and strict contract types.
- [x] Implement the request state machine and effect states.
- [x] Add tenant schema, constraints and append-only audit.
- [x] Add forced RLS and negative tenant-isolation coverage.
- [x] Add encrypted fields and versioned proof HMAC.
- [x] Add mutation receipts and concurrency primitives.
- [x] Separate owner, web, worker and maintenance database roles.
- [x] Deny web writes to executions and worker-owned lifecycle transitions; require durable coherent
      decisions in PostgreSQL while retaining only monotone deauthorization protection.
- [x] Exercise real `23505`, `40001`, `40P01`, decision races, receipt races, payment guards and
      transaction retry behavior.

## Phase 3 — signed API and policy

Status: `LOCALLY_IMPLEMENTED`; real Stripe App signing remains unvalidated.

- [x] Implement raw-body Stripe App signature verification.
- [x] Implement canonical mutation idempotency.
- [x] Implement installation binding and fail-closed `AccessPolicy`.
- [x] Implement explicit approver activation and self-approval denial.
- [x] Implement card-only payment eligibility.
- [x] Keep `NotificationProvider` as no-op.

## Phase 4 — refund execution

Status: `LOCALLY_IMPLEMENTED`; no real Refund has been created.

- [x] Implement deterministic Stripe idempotency keys.
- [x] Revalidate immediately before the effect boundary.
- [x] Persist the effect boundary outside the network call.
- [x] Implement retry and crash recovery without alternate keys.
- [x] Link the first Refund ID immutably.
- [x] Preserve the guard for ambiguous and pending outcomes.
- [x] Recover missed approved work and orphaned `executing` work only when the effect is
      `not_started`, or `absence_proven` with the original persisted execution and deterministic
      key; divert `possible`, mismatched, linked or incomplete identities to reconciliation.
- [x] Stamp a database-managed safe boundary when ambiguous or orphaned work enters reconciliation.

All execution evidence in this phase is local or simulated. The worker remains test/sandbox-only
and fails closed for live mode.

## Phase 5 — webhooks and reconciliation

Status: `LOCALLY_IMPLEMENTED`; real Event delivery and detection timing remain unvalidated.

- [x] Separate test, sandbox and disabled-live endpoints.
- [x] Verify raw webhook bodies and persist deduplicated receipts.
- [x] Delegate normalized receipt processing asynchronously.
- [x] Classify workflow, external and proof-replay Refunds.
- [x] Implement the 15-minute paginated scanner with one-hour overlap.
- [x] Anchor the first scan to installation time so delayed startup cannot miss early Refunds.
- [x] Advance temporal checkpoints only after all temporal pages succeed.
- [x] Prove empty-scan absence only across the execution start and durable reconciliation boundary,
      with no unresolved external alert.
- [x] Refresh non-terminal and previously succeeded linked Refunds periodically by immutable ID,
      including Refunds older than the temporal overlap.
- [x] Isolate linked-target failures, continue later targets and the temporal pass, then fail the
      aggregate job for retry.
- [ ] Prove with real Stripe evidence that a missed webhook is found within 30 minutes.

Local evidence on 2026-07-25: both PostgreSQL 18 integration suites pass `18/18`, including the
safe-boundary, linked-Refund, real-login role and deauthorization cases. These are local database
and simulated Stripe observations, not Phase 0 Stripe evidence.

## Phase 6 — pilot UI and audit

Status: `LOCALLY_IMPLEMENTED`; unpublished app upload and installation remain blocked.

- [x] Payment detail request flow.
- [x] Drawer for pending requests and alerts.
- [x] Onboarding and settings.
- [x] Decision, cancel and acknowledgement actions.
- [x] Redacted audit export.
- [x] Stripe UI toolkit and keyboard-oriented component implementation.
- [ ] Rendered accessibility audit with the installed Stripe App.

## Phase 7 — hardening

Status: `LOCALLY_VERIFIED`; real Stripe and operational drills remain blocked or pending.

- [x] Local crash matrix, `429`, timeout and `5xx` worker tests.
- [x] Local idempotency, state-transition and isolation tests.
- [x] Local deauthorization and guarded purge database rehearsal.
- [x] Final consolidated local verification: 197 local tests, 18 PostgreSQL integration tests,
      formatting, lint, type checks, build, secret scan and dependency audits.
- [ ] Pending and failed Refund scenarios in a real Stripe sandbox.
- [ ] Real Stripe App uninstallation rehearsal.
- [ ] Key rotation and compromise drills.
- [ ] Complete real managed-sandbox gate.

## Deferred until a separately authorized cycle

- Live mode.
- Hosting and production deployment.
- Marketplace submission.
- Billing, trials and quotas.
- Email delivery.
- Team policies and multi-approver quorum.
- Public marketing site.

## Evidence policy

Every completed real gate must link or refer to a local redacted artifact containing:

- timestamp and tool/version context;
- tenant-safe identifiers;
- expected and observed result;
- explicit outcome;
- no secret, PII, full payload or customer data.

Fixtures, mocks, unit tests and local PostgreSQL runs remain implementation evidence only.
