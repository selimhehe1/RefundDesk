# RefundDesk implementation plan

> Last updated: 26 July 2026
> Current gate: `BLOCKED_HUMAN`
> Blocker: connected-account topology and the second independently bound test/sandbox environment
> required by the remaining Phase-0 matrix
> Allowed environment: local + Stripe test/managed sandbox

Checkboxes represent observed evidence or locally implemented scope. Local tests, fixtures and
PostgreSQL integration do not validate the real Stripe Phase 0 gate.

## Phase 0 — real Stripe feasibility gate

Status: `BLOCKED_HUMAN`.

Real preflight completed:

- [x] Authenticate the Stripe CLI against the intended test account.
- [x] Create and confirm one synthetic EUR PaymentIntent in test mode with `livemode=false`.
- [x] Obtain explicit human acceptance of the Stripe Apps Agreement.
- [x] Upload unpublished RefundDesk version `0.1.0` without `--live` or Marketplace publication.
- [x] Install version `0.1.0` only in the account's **Mode test** environment.
- [x] Render the installed extension on the allowlisted synthetic PaymentIntent.
- [x] Confirm the uploaded safe manifest hides the direct probe and fails closed.
- [x] Grant Chrome local-network access and load the Stripe CLI preview.
- [x] Verify a real canonical Stripe-signed request against the environment-specific test App
      signing secret; the non-mutating Phase-0 report returned HTTP 200.
- [x] Preserve Stripe's signed stable role ID and authorize the observed built-in `super_admin`
      role without trusting a custom homonym.
- [x] Move the post-probe source and manifest to `0.1.1` so the installed `0.1.0` evidence is not
      conflated with later fixes. Version `0.1.1` has not been uploaded.
- [x] Add a distinct real user with Stripe's built-in `View only` role and prove `P0-ROLE-001` in
      Pattamap's test environment: the user can view a successful synthetic card payment but Stripe
      exposes no native refund action. The redacted real evidence is retained locally.

Not performed:

- [x] Complete `P0-ROLE-002` with the exact Stripe user identity already evidenced as built-in
      `View only` in `P0-ROLE-001`. A real Stripe-authenticated request reached RefundDesk, persisted
      as `pending_approval/not_started`, and was canceled by the same requester with zero decisions,
      executions, attempts or Stripe Refunds. Stripe rejected the special `stripe_roles` signing
      input for this restricted user while `charge_write` remained present, so the case proves
      authenticated identity and request creation, not signed role propagation.
- [x] Create a backend Refund with the app’s real permissions.
- [x] Replay the exact signed command and Stripe idempotency key against the real Refund; Stripe
      retained one effect and returned the same Refund.
- [ ] Receive and deduplicate a real `refund.created` Event.
- [x] Detect a real Refund created outside RefundDesk through periodic reconciliation.
- [ ] Classify copied metadata from real Stripe objects.
- [ ] Prove test mode and managed sandbox independently.
- [ ] Confirm the minimal permissions and pilot publishability.
- [ ] Upload only from a clean, committed `0.1.1` source snapshot and record its commit and
      artifact checksum; the installed `0.1.0` upload did not preserve a reproducible clean snapshot.
- [ ] Complete the redacted Phase 0 evidence set; 17 test-account cases are recorded as
      `passed_real`, including the Refund, replay, external-detection, non-allowlisted UI and all
      signed-request cases except the cross-test/sandbox `P0-SIGN-008`, plus the native
      `View only` refund denial and authenticated RefundDesk request.
- [x] Disable and remove every Phase-0 runtime route, client call, UI control and manifest switch
      before pilot completion.

Exactly two small partial Refunds were created on the allowlisted synthetic PaymentIntent in test
mode: one through the signed RefundDesk probe and one deliberately outside it. No Marketplace
action or live operation was performed. The app upload and test-only installation are complete.
Login, MFA, the second Stripe user, distinct connected-account topology and managed-sandbox
credentials remain human-controlled checkpoints.

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

Status: `LOCALLY_IMPLEMENTED`; one canonical real Stripe App request and the same-environment
negative matrix are validated in test mode, while the cross-test/sandbox signature case remains
blocked.

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

All execution evidence in this phase is local or simulated. The worker remains test/sandbox-only
and fails closed for live mode.

## Phase 5 — webhooks and reconciliation

Status: `LOCALLY_IMPLEMENTED`; real connected-Event delivery remains unvalidated, while a real
external test Refund was detected by periodic scanning in under eight minutes.

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

Status: `LOCALLY_VERIFIED`; real Stripe and operational drills remain blocked or pending.

- [x] Local crash matrix, `429`, timeout and `5xx` worker tests.
- [x] Local idempotency, state-transition and isolation tests.
- [x] Local deauthorization and guarded purge database rehearsal.
- [x] Final consolidated local verification: 237 local tests, 19 PostgreSQL integration tests,
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
