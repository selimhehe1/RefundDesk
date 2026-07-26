# RefundDesk implementation plan

> Last updated: 26 July 2026
> Current gate: `PASS`
> Phase-0 evidence: `34/34 passed_real`
> Current delivery status: Phase 1 complete and locally verified
> Allowed environment: local + Stripe test/managed sandbox

Checkboxes represent observed evidence or locally implemented scope. Real Stripe evidence remains
distinct from local tests, fixtures and PostgreSQL integration evidence.

## Phase 0 — real Stripe feasibility gate

Status: `PASS`.

All 34 required cases are recorded as `passed_real`, with no unresolved `failed_real`,
`blocked_human` or `not_run` case:

- [x] Create, upload and install the unpublished Stripe App in test-only contexts.
- [x] Render the payment-detail UI on allowlisted synthetic card payments and fail closed elsewhere.
- [x] Prove canonical signed requests and all same- and cross-environment rejection cases.
- [x] Prove the real `View only` role gap and authenticated RefundDesk request creation.
- [x] Create a Refund through the App's real permissions and preserve one immutable first Refund ID.
- [x] Prove Stripe idempotency, webhook verification, deduplication and webhook-before-response
      safety.
- [x] Detect a real external Refund and classify copied workflow metadata as proof replay/tampering.
- [x] Prove test mode and managed sandbox independently and reject both credential crossovers.
- [x] Confirm the minimal permission set: `charge_read`, `charge_write`,
      `payment_intent_read` and `event_read`; `user_email_read` is absent.
- [x] Confirm no currently observed distribution constraint makes the test/sandbox pilot impossible.
- [x] Upload unpublished version `0.1.1` from clean commit
      `100ae946ec593df1f21ba3efa6fe5c72ec366e89` and record packaged artifact SHA-256
      `ec5fc4940092343c9d6bd8b25948ea31272666d4e041a2ff23d36f10e27446be`.
- [x] Remove every Phase-0 runtime route, client call, UI control and manifest switch before pilot
      handoff.

Provenance remains explicit. The distinct external-account installation evidence is attributed to
installed version `0.1.0`; that first upload was not a reproducible release snapshot. Version
`0.1.1` establishes clean source and packaging provenance, but its upload alone is not described as
an external-account reinstall or rerun. The `34/34` verdict applies to the complete Phase-0
evidence set.

`P0-PUBLISH-001` establishes feasibility only: Stripe accepted the unpublished test version, marked
it approved for external testing, and no known distribution blocker invalidated the pilot. It is
not Stripe review approval, Marketplace approval, production readiness or live authorization.
External-test link access was closed after the evidence window.

No live credential, live object, live request, production deployment, paid resource, review
submission or Marketplace publication was used.

## Phase 1 — repository foundations

Status: `COMPLETE (local scope)`.

Phase 1 is complete as repository work and locally verified. This status does not authorize live
mode, production deployment or Marketplace publication.

- [x] Preserve the v1.0 specification and publish the v1.1 pilot contract locally.
- [x] Add the agent guide, implementation plan, ADRs, threat model, runbook and retention policy.
- [x] Create the pinned pnpm workspace and package boundaries.
- [x] Configure strict TypeScript, formatting, lint, tests, build and secret scanning.
- [x] Bring up an isolated PostgreSQL 18.4 process and execute the real migration, role bootstrap,
      pg-boss, access-check and integration suites.
- [x] Separate web, worker and migration connection contracts.

## Phase 2 — domain and database

Status: `LOCALLY_VERIFIED`; 19 integration cases ran against an isolated PostgreSQL 18.4 process.
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

Status: `LOCALLY_VERIFIED`; the real canonical request and same- and cross-environment rejection
matrix passed in Stripe test mode and managed sandbox.

- [x] Implement raw-body Stripe App signature verification.
- [x] Implement canonical mutation idempotency.
- [x] Implement installation binding and fail-closed `AccessPolicy`.
- [x] Implement explicit approver activation and self-approval denial.
- [x] Implement card-only payment eligibility.
- [x] Keep `NotificationProvider` as no-op.

## Phase 4 — refund execution

Status: `LOCALLY_IMPLEMENTED`; the isolated Phase-0 probe created one real test Refund, while the
complete durable approval-to-worker execution path remains unvalidated against real Stripe.

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

The isolated Phase-0 probe supplied the real Stripe Refund evidence. Evidence for the durable
approval-to-worker execution path remains local or simulated. The worker remains test/sandbox-only
and fails closed for live mode.

## Phase 5 — webhooks and reconciliation

Status: `LOCALLY_VERIFIED`; real connected-Event delivery, deduplication, tamper rejection and
webhook-before-response ordering passed, and periodic scanning detected a real external test Refund.

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
- [x] Prove with real Stripe evidence that periodic scanning finds an external Refund without
      relying on webhook delivery; the external test Refund was classified in under eight minutes.
- [x] Prove with real Stripe evidence that connected test Events are accepted once, replayed safely,
      rejected after byte tampering and correlated correctly before the API response.

Local evidence on 2026-07-25: both PostgreSQL 18 integration suites pass `19/19`, including the
safe-boundary, linked-Refund, real-login role, column-scoped external-alert insert and
deauthorization cases. These are local database and simulated Stripe observations, not Phase 0
Stripe evidence.

## Phase 6 — pilot UI and audit

Status: `LOCALLY_IMPLEMENTED`; real test-mode upload, installation and initial rendering pass.

- [x] Payment detail request flow.
- [x] Drawer for pending requests and alerts.
- [x] Onboarding and settings.
- [x] Decision, cancel and acknowledgement actions.
- [x] Redacted audit export.
- [x] Stripe UI toolkit and keyboard-oriented component implementation.
- [ ] Complete rendered accessibility audit with the installed Stripe App.

## Phase 7 — hardening

Status: `LOCALLY_VERIFIED`; the Phase-0 Stripe hardening matrix is complete while broader
operational drills remain deferred.

- [x] Local crash matrix, `429`, timeout and `5xx` worker tests.
- [x] Local idempotency, state-transition and isolation tests.
- [x] Local deauthorization and guarded purge database rehearsal.
- [x] Final consolidated local verification: 248 local tests, 19 PostgreSQL integration tests,
      formatting, lint, type checks, build, secret scan and dependency audits.
- [ ] Pending and failed Refund scenarios in a real Stripe sandbox.
- [ ] Real Stripe App uninstallation rehearsal.
- [ ] Key rotation and compromise drills.
- [x] Complete the real managed-sandbox credential, object, webhook and cross-environment gate.

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
