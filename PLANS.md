# RefundDesk implementation plan

> Last updated: 8 August 2026
> Current gate: Phase 0 `PASS`; hosted sandbox `BLOCKED_RECONCILIATION`; complete pilot
> `BLOCKED_GATES`; commercial/live/Marketplace `NO_GO`
> Phase-0 evidence: `34/34 passed_real`
> Current delivery status: exact-e4 is the last admitted canonical hosted release. Its scheduled
> cold backup and corrected disposable PostgreSQL 18 restore both passed; the earlier 31 July
> attempt remains a distinct `FAIL_PRE_EFFECT_CLEANED`. ADR 0030 records later `8da280b7...`
> release attempts. The admissible read-only postflight from clean HEAD `74b6da5...` captured active
> revision `8da280b78a9d1475c7bd79063e72c5af77121e8d` at `2026-08-08T12:37:17Z` with result `FAIL`,
> admission `ADMISSIBLE_READ_ONLY`, posture `COHERENT_RUNNING` and remote code `CADDY_RUNNING`.
> Worker, Caddy, both maintenance timers, internal TCP 80/443 listeners, two unexpected running
> containers and a runtime quiescence journal violated containment. All five services were healthy;
> the AWS 80/443 firewall was closed and unchanged, live was disabled and the financial state was
> stable/quiescent. The capture expired at `12:52:17Z` and is point-in-time evidence, not proof of
> later state. Stripe App financial direct-browser delivery remains `BLOCKED_TOOLING`.
> Allowed environment: local + approved GitHub/AWS sandbox + Stripe test/managed sandbox
> Configured GitHub `main` and `release/sandbox-edge-2026-08-03` are
> `9263d7075815b26e911efc8fe95deb665034798c`; e4 is their ancestor, but no exact GitHub artifact
> attestation is claimed for e4. Implementation commit `e86241d1...` has the exact full-CI plus
> attested-bundle pair recorded below. The later local postflight-source fixes `a96ce03...` and
> `74b6da5...` do not inherit that pair. Evidence remains revision-bound and is never transferred
> from an ancestor or another bundle.
> Safety containment: ADR 0024 records `PASS_CONTAINED` for the 3 August exact-e4 replacement of the
> exposed managed-sandbox read/effect and App-signing bindings. The two 1 August incident JSONs remain
> initial `IN_PROGRESS_CONTAINED` records, not the final proof. ADR 0034 records that two independent
> reviews of the nine corrected artifacts ended `NO_GO_REOPENING`; the consumed chain cannot admit
> the historical outcome or support another transition. The normative containment requirement and
> last admitted incident record have public Caddy, the worker, Lightsail 80/443 and maintenance
> timers stopped, with live disabled. The admitted postflight proves that the captured service
> posture violated those requirements; its `FAIL` does not relax them or authorize remediation.
> ADR 0029's historical public window is unadmitted under ADR 0031 and cannot authorize another.
> Repair, reopening, release and financial proof remain prohibited without the applicable tracked
> successor and a separate authorization decision.
> PostgreSQL integration, workspace verification, `pnpm audit:prod`, Lightsail contracts, all three
> OCI targets and smokes, plus standalone Stripe App lint/build/test/audit passed.

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

No live credential, live object, live request, production deployment, review submission or
Marketplace publication was used. A later, separately approved GitHub/AWS test-sandbox cycle is
documented below; it does not retroactively change the Phase-0 boundary.

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

Status: `LOCALLY_VERIFIED`; the current local PostgreSQL 18 run passed 2 files and all 29
integration cases, then left zero generated database and zero `refunddesk_integration_*_probe`
role. This remains local implementation evidence, not real Stripe evidence.

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

Status: `MANAGED_SANDBOX_HAPPY_PATH_VERIFIED`; the durable requester-to-approver-to-worker path
created exactly one real managed-sandbox Refund through a local preview overlay.

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
- [x] Load execution-boundary relations explicitly and sequentially on the interactive transaction
      client, with fail-closed missing-tenant and missing-installation behavior.

The isolated Phase-0 probe supplied the original real Stripe Refund evidence. On 27 July 2026, the
P1 path added a distinct signed requester and approver, one durable decision, one execution, one
attempt and one terminal managed-sandbox Refund. The deterministic idempotency identity, canonical
parameter hash, HMAC proof, Stripe Event request identity, immutable Refund link and terminal guard
release all matched. The redacted result is recorded in
`p1-manual-stripe-app-financial-flow-2026-07-27T19-11-59-907Z.json`.

This run used a temporary local API overlay whose Stripe App source tree matched the uploaded
`0.1.2` commit exactly. It does not transfer runtime evidence to the immutable uploaded artifact,
whose API origin remains the fail-closed placeholder. The worker remains test/sandbox-only and
fails closed for live mode. The version and source-tree linkage is recorded separately in
`p1-stripe-app-0.1.2-financial-preview-provenance-2026-07-27.json`.

The `pg.Client.query()` overlap warning observed during that run was traced to Prisma sibling
relation loading in `getExecutionWorkItem`. The local hardening revision removes the overlap and
adds both an overlap-detecting unit regression and a real adapter-pg integration case. The full
PostgreSQL suite passes with Node deprecations promoted to errors.

## Phase 5 — webhooks and reconciliation

Status: `DIRECT_ACCOUNT_HOSTED_GATE_PASSED_REAL`; historical connected-Event evidence remains
attributed to its original artifact, while the corrected hosted endpoints now have their own real
test and managed-sandbox delivery and replay evidence.

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
- [x] Preserve the historical proof that connected test Events were accepted once, replayed safely,
      rejected after byte tampering and correlated correctly before the API response.
- [x] Locally prove that direct-account Events omit `Event.account`, bind only to the configured
      account, accept only the exact type/API-version matrix, reject Clover Refunds and arbitrary,
      null or prefix-only lifecycle versions, and deduplicate across historical/new provenance.
- [x] Receive and process one real `refund.created` on each hosted direct-account endpoint.
- [x] Replay each real Event manually from Stripe Workbench and prove the durable receipt, alert
      and classification state remains unchanged.
- [x] Remove the identified legacy connected test destination after two fresh Dashboard checks,
      while leaving the direct destination and historical database provenance unchanged.

The redacted hosted evidence is
`stripe-hosted-direct-webhooks-2026-07-28.json` (SHA-256
`b0d85e964aa440dcda32dd601b48be11f3826fcc750f90b56a0c8ac2eabc737e`). The legacy endpoint
cleanup is recorded separately and does not delete or relabel historical receipts. Local database
and simulated Stripe coverage remains implementation evidence only.

## Phase 6 — pilot UI and audit

Status: `APP_0_1_3_INSTALLED_SIGNED_RELAY_PASS_DIRECT_BROWSER_BLOCKED_TOOLING`; the earlier
managed-sandbox financial flow remains tied to its `0.1.2` local overlay, while `0.1.3` now has
exact-version hosted-origin installation and signed runtime evidence without a financial effect.

- [x] Payment detail request flow.
- [x] Drawer for pending requests and alerts.
- [x] Onboarding and settings.
- [x] Decision, cancel and acknowledgement actions.
- [x] Redacted audit export.
- [x] Stripe UI toolkit and keyboard-oriented component implementation.
- [x] Signed requester to distinct approver to worker to terminal Refund happy path in managed
      sandbox through a local overlay matching the uploaded `0.1.2` source tree.
- [x] Upload unpublished `0.1.3` from clean commit
      `c241a097fc5f4b8e8eaa2f057f9c7db40d9dffa3`, install that exact version in the distinct test
      sandbox and reauthorize its hosted-origin permissions.
- [x] Generate an exact Stripe UI signature from that source and relay the unchanged request bytes
      and signature to the hosted eligibility route, which returned HTTP 200 with a valid schema.
      This is an operator observation; the raw capture was intentionally destroyed and cannot be
      reproduced from the redacted artifact alone.
- [ ] Observe the same request complete through a normal direct controlled-browser transport. The
      current browser-control profile returns `ERR_BLOCKED_BY_CLIENT`, so this gate is
      `BLOCKED_TOOLING`, not passed.
- [ ] Complete rendered accessibility audit with the installed Stripe App.

## Phase 7 — hardening

Status: `LOCALLY_VERIFIED`; the Phase-0 Stripe hardening matrix is complete while broader
operational drills remain deferred.

- [x] Local crash matrix, `429`, timeout and `5xx` worker tests.
- [x] Local idempotency, state-transition and isolation tests.
- [x] Local deauthorization and guarded purge database rehearsal.
- [x] Re-run the complete local verification on 1 August 2026 while hosted containment remained
      active: formatting, lint, type checks, 508 Vitest assertions, all builds, 38 runnable
      container/topology/restore/PKI contract tests and the secret scan passed; eight POSIX/Linux
      contract cases were skipped on Windows as designed. The separate Stripe App pnpm `10.30.3`
      lock graph then passed install, lint, build, 73 tests and production audit with zero known
      vulnerability. PostgreSQL integration was not rerun because the disposable control URL and
      Docker are absent; the prior 21/21 evidence remains separate.
- [x] Remove the obsolete Phase-0 observer seam from production webhook ingress while retaining its
      webhook-before-API-response race coverage in a test-only persistence adapter. Remove the
      local Stripe App signing-secret verifier from the web package, expand the private worker
      verifier's fail-closed negative matrix, and distinguish inter-service bearer rejection
      (`403`, verifier unavailable) from Stripe-signature rejection (`401`, invalid signature).
      Harden the source secret scanner for App secrets containing underscores, unreadable Git
      inputs, encrypted/DSA private keys and terminal-safe paths. The resulting local gate passed
      formatting, lint, type checks, 525 Vitest assertions, all builds, 39 runnable container
      contracts, six scanner regressions, the real source scan and the production dependency audit;
      eight platform-specific container cases remained skipped on Windows as designed. No hosted or
      Stripe action occurred. Initial CI run `30694666364` failed only because its OCI smoke still
      expected the former inter-service `401` while the runtime correctly returned `403`; all prior
      gates in that run had passed. Commit `1310e92a282df793028ad4abb6762ba88302fd91` aligned the CI
      smoke and deployment verifier, added a regression contract and passed exact CI run
      `30695038739`, including 21 PostgreSQL integration cases, Linux operator contracts, all three
      OCI builds and smokes, isolated retention and the standalone Stripe App graph. No deployment
      followed.
- [x] Add a worker-local 60-second readiness monitor with allowlisted samples, deduplicated
      `raised`/`resolved` S0/S1 transitions, overlap coalescing, fail-safe logger handling and an
      immediate shutdown that suppresses late samples. Add direct audit-download coverage for
      authorization revalidation, stable cursor pagination, the 10,000-event cap and the documented
      five-minute bearer replay contract. Local verification passed formatting, lint, type checks,
      548 Vitest assertions, all builds, 39 runnable container contracts, six secret-scanner
      regressions and the source secret scan; eight platform-specific container cases remained
      skipped on Windows as designed. The operational transitions currently reach structured local
      logs only: at that checkpoint, external alert delivery and durable ingress rate limiting were
      still unselected. Code-only commits `9aebdaa` and `d5c08a2` passed exact GitHub CI run
      `30696269855`, including 21 PostgreSQL integration cases, Linux operator contracts, all three
      OCI builds and smokes, isolated retention and the standalone Stripe App graph. No hosted
      deployment or Stripe action occurred.
- [ ] Close the durable signed-request rate-limit evidence gate. ADR 0017 fixes a global pre-tenant
      PostgreSQL GCRA keyed by SHA-256 of account/environment/class: mutation burst 30 at 0.5/s,
      read burst 60 at 1/s, 256 active scopes and ten-minute inactive cleanup. Code-only commits
      `9e2c39e41acaefc326f4423e710a16a73f1128bb` and
      `ec67b50bc615c4c87799f53629c47d5728212af5` expose one SECURITY DEFINER function to web only,
      with no direct runtime table access and fail-closed `429`/`503` behavior. Exact CI run
      `30698815827` passed all 29 disposable PostgreSQL 18 integration cases, including burst/refill,
      concurrent admission, persistent and separated scopes, cleanup/cap, bounded lock failure and
      restricted-role checks. The same run passed the HTTP ordering/redaction contracts, complete
      workspace verification, dependency audit, Lightsail contracts, OCI builds/security/smokes,
      isolated retention and the standalone Stripe App package. The overall checkbox remains open:
      no separate signed-route end-to-end pass, hosted deployment or real operational proof is
      claimed for this revision. A separately authorized exact-revision deployment gate and
      invalid-signature edge limiting remain distinct open controls.
- [x] Final consolidated local verification: 423 local tests, 21 PostgreSQL integration tests,
      69 exact standalone Stripe App tests, formatting, lint, type checks, build, secret scan and
      dependency audits.
- [x] Repair the PostgreSQL security harness after transaction-owning enum migrations exposed its
      obsolete outer-migration transaction. The gate now fails closed without its database URL,
      applies migrations in an allowlisted ephemeral PostgreSQL 18 database, opens the fixture
      transaction afterward, and passed 21/21 twice with no database or probe role left behind.
      Code commit: `29b0cb10459b21045c4f1cccc48d484592b0a6ce`; ignored redacted evidence:
      `postgres-integration-harness-2026-07-28.json`, SHA-256
      `6705dcc9fa19765bc756aef8db95f4f9ec8331fc7ce762f151662ddf0c7674bf`.
- [x] Rebaseline and complete the 8 August local working-tree gates based on `9a170529...`: Node
      `24.18.0`, pnpm `11.17.0`, format, lint and typecheck passed; `pnpm test` passed 71 files and
      all 717 tests; the PostgreSQL 18 integration gate passed 2 files and all 29 tests, then left
      zero generated database and zero `refunddesk_integration_*_probe` role; and the build passed
      with 21 Next.js pages/routes. `pnpm container:check` passed 64 tests with 54 passed, 10
      platform skips and zero failure. The observer's Linux suite separately passed all 38 cases
      and `shellcheck`. Secret-scanner regressions passed 6/6, the repository secret scan passed and
      the production dependency audit passed. The exact standalone Stripe App graph passed lint,
      build, all 115 tests and its production audit under pnpm `10.30.3`. This phase also repaired the
      Lightsail topology contract so its unique executable `--force-recreate` assertion no longer
      counts the new operator diagnostic string. Static regressions cover orderly rollback journal
      retirement and its non-executing recovery instruction. Exact-revision CI is manually
      dispatchable, and GitHub bundle provenance is a hard delivery gate. The four Prisma relation
      mappings now match their explicit deployed foreign-key names with an empty migration diff. The
      concurrent limiter harness serializes calls per `pg.Client` while keeping eight clients
      parallel. Integration promotes every Node deprecation to an error, and patched transitives
      remain pinned at `fast-uri 3.1.5` and `nanoid 3.3.17`. These are local gates; no host capture,
      release, AWS mutation or Stripe action is claimed by them.
- [x] Publish implementation commit `e86241d1f1097c2e9018ed4628bdfe1f975ab6c6` atomically to the
      configured `main` and `release/sandbox-edge-2026-08-03` refs, then close both exact-revision
      GitHub gates. CI run `31255267222` passed its complete Linux `verify` job and the Windows
      postflight contract job. Ignored redacted evidence is
      `sandbox-evidence.local/github/ci-e86241d1-2026-08-08.local.json`, SHA-256
      `42585a4da65965c28fb2aba5012ff37a32abce078fdac4f6eaec6a742649540f`.
- [x] Complete sandbox bundle run `31255272748` for the same exact revision. Provenance creation and
      its hard gate passed; the repository has no configured private-bucket secret, so the S3 step
      was skipped and one-day GitHub artifact `9021236979` was uploaded instead. The downloaded
      five-file set, both companion hashes, both Zstandard archives, the strict manifest and both
      GitHub attestations were independently verified. The image bundle SHA-256 is
      `5c4fcc688c34840a2bdddd3687e900ff8f79c32ed52995bb3e3e9f4286048edb`; the operator-source bundle
      SHA-256 is `ce95bd84ee62df274cfe3c179abe7ec2c94db42f2db88fa05be01891ed095d8f`.
      Ignored redacted evidence is
      `sandbox-evidence.local/github/sandbox-bundle-e86241d1-2026-08-08.local.json`, SHA-256
      `79d58c399e2c7da0d04decc31842c09eb2cec67d71ed99ed55da8f80f5d885e5`.
- [x] Capture the committed-HEAD read-only host postflight without mutating AWS or the host. The first
      production-mode invocation failed closed on `AWS_CREDENTIAL_FILE_INVALID` before AWS, SSH or
      evidence creation. After explicit approval, the default AWS credential file ACL was restricted
      without reading credential bytes. Ignored evidence is
      `sandbox-evidence.local/aws/aws-credentials-acl-remediation-2026-08-08.local.json`, SHA-256
      `0ba446b4de31b56876744219269900f65c584c754e3b6714c0358eb48bd9e2b1`.
      Revision `a96ce03...` fixed isolated HOME propagation and clean HEAD
      `74b6da5742cd032204373d24006f0396d9c5ac0c` fixed only the OpenSSH child environment
      (`HOME`, `USERPROFILE`, `PROGRAMDATA` plus guards); source provenance had already been
      hardened. Relevant contracts, the 38-case Linux observer suite and `shellcheck` passed. The
      admissible capture at
      `2026-08-08T12:37:17Z` returned top-level `FAIL`, admission `ADMISSIBLE_READ_ONLY`, posture
      `COHERENT_RUNNING`, remote code `CADDY_RUNNING` and exact diagnostics `CADDY_RUNNING`,
      `MAINTENANCE_ACTIVE`, `PUBLIC_LISTENER_ACTIVE`, `UNEXPECTED_RUNNING_CONTAINER`,
      `UNRESOLVED_JOURNAL`, `WORKER_RUNNING`. It observed active
      `8da280b78a9d1475c7bd79063e72c5af77121e8d`, five healthy services, the AWS 80/443 firewall closed
      and unchanged, live disabled and stable/quiescent financial snapshots. It also observed worker,
      Caddy, both maintenance timers and internal TCP 80/443 listeners active, two unexpected
      running containers (`unexpectedRunningContainerCount=2`) and the runtime quiescence journal.
      Evidence is
      `sandbox-evidence.local/aws/host-postflight-20260808T123717Z-f7a9e869c50a.local.json`, SHA-256
      `8a49edb18858ef207e2ad5f8c3c3c412100d24ef8788d087cfd710d301ce9ca5`. The artifact expired at
      `2026-08-08T12:52:17Z`; this closes the observation task with a point-in-time failure, not a
      current availability claim or authorization to repair, release, reopen ingress or run a
      financial proof.
- [ ] Pending and failed Refund scenarios in a real Stripe sandbox. Exact-e4 ignored runners are
      statically ready and pinned: API runner `d836b3a5...c5b7`, DB watcher
      `ca706ec8...85f9`, proof composer `2a9a3764...500f` and PowerShell orchestrator
      `9c60178a...b00c`. Syntax, redaction, revision/account/environment bindings, synthetic
      pending/failed paths and fail-closed interlocks pass. No hosted/Stripe run occurred.
      **The rotation condition stated here is now met** — the exact-e4 evidence is `PASS_CONTAINED`
      as of 3 August 2026 — so the blocker has changed rather than lifted. What blocks execution now:
      (a) forcing these statuses needs Stripe's asynchronous-refund test payment methods,
      `pm_card_pendingRefund` and `pm_card_refundFail`, which are cards and therefore pass the
      card-only eligibility rule — with any other test card a refund succeeds immediately and never
      changes state again; (b) creating those two synthetic PaymentIntents needs a key able to
      create PaymentIntents, which the current restricted keys are not; and (c) the state changes
      arrive as `refund.updated` and `refund.failed` webhooks, so the **webhook lane stays blocked
      while public ingress is closed**. The outbound **scanner lane** is exercisable without
      reopening, and proving one lane does not prove the other (ADR 0006).
      Non-terminal handling is meanwhile pinned by unit tests: `pending` and `requires_action` keep
      the workflow open and the payment guard held, verified by mutation.
- [ ] Real Stripe App uninstallation rehearsal.
- [ ] Key rotation and compromise drills. **The replacement-only exact-e4 transition completed on
      3 August 2026** with a final `PASS_CONTAINED` and proof
      `sha256:39e9351c387c1bc6316cdc23f507ddc9f073899b4863a1f09d4c0c5621fe7706`. The three
      replacement credentials are proven in real use: the managed-sandbox read key performed its
      reads and was correctly refused a Refund creation, the App signing secret had a signed
      synthetic request accepted, and the effect key created, approved, executed and reconciled a
      real Stripe Refund. ADR 0024 records `PASS_CONTAINED`; under ADR 0019's admission contract,
      that recorded outcome would require the Dashboard expiry/revocation and activity-review
      control-plane sub-gate. Its final proof was cleaned by design and ADR 0034's independent
      review ended `NO_GO_REOPENING`, so this is a recorded outcome rather than a retained
      standalone proof. ADR 0024's
      superseded copies are redacted control-plane
      journals/state only; ADR 0019 requires every raw secret/candidate input to be removed before
      completion, and no retained raw secret is claimed. Old raw values were never retested.
      Containment held throughout and was verified
      independently of the final document: Caddy never started, worker stopped again, ports 80 and
      443 without a listener, maintenance timers inactive, live disabled in both environments.
      The two redacted 1 August incident records retain their original
      `IN_PROGRESS_CONTAINED` result and are not the final 3 August proof:
      `stripe-app-signing-secret-exposure-2026-08-01.local.json`, SHA-256
      `ab29955376fea135f14646c7b7dcdd512449d1abbd3645c9befaea9246b7395b`.
      ADR 0034 closes the independent-review task with `NO_GO_REOPENING`. Redacted evidence is
      `sandbox-evidence.local/aws/exact-e4-independent-static-review-2026-08-08.local.json`, SHA-256
      `613f868c80e52b834b7fe33594f590fea1990c52b155eef9dfcbaf9fc7b9fba2`.
      Any future transition needs a new tracked successor. The ADR 0032 postflight now has an
      admitted `FAIL`; ingress still requires a separate reopening decision after explicitly
      authorized remediation and every other gate.
      Initial incident record: `stripe-api-key-chat-exposure-2026-08-01.local.json`, SHA-256
      `791c2832500e59b5147e09add7d429e1c871f92e06f73432559156c0d22f9d2f`.
      Replacement managed-sandbox read/effect candidates then passed real read-only account/test
      binding, separation, required-read and unrelated-resource denial checks. The cloned read key
      returned `403 more_permissions_required` for `refunds.create` against the already fully
      refunded Phase-0 fixture and the Refund set remained unchanged. Evidence:
      `managed-sandbox-rotation-candidates-2026-08-01.local.json`, SHA-256
      `ec07ef8b14fee601f7339bf8a3837dee0ba3817601fa8330486e758eab10e606`.
      Effect permission was deliberately not exercised before the App signing-secret rotation.
      A later unintended `stripe apps list` authenticated the local CLI against the pinned platform
      test account and created one test plus one live CLI restricted key. Local logout completed
      with no retained local secret; ADR 0024's recorded `PASS_CONTAINED` outcome implies ADR 0019's
      Dashboard-deletion and activity-review admission contract. The cleaned final proof is not
      independently retrievable, and ADR 0034's review is `NO_GO_REOPENING`. Initial evidence:
      `stripe-cli-unintended-auth-2026-08-01.local.json`, SHA-256
      `d51f557fd8f76af871d4a5019eac8e00e4ed465ed487afd05ac6750877ac9da7`.
      Historical 1 August preparation state, superseded by ADR 0024's executed outcome: ADR 0019
      defined one exact-e4 contained three-binding transition. Independent review of
      the earlier named-stage implementation found non-convergent partial-write crash windows, so
      that freeze was invalidated. The replacement local chain now publishes credentials,
      ciphertext, tools, flat input members and initial authority records from validated anonymous
      Linux file descriptors with xattr binding, fsync and no-replace `linkat(AT_EMPTY_PATH)`.
      Four root-only mode-0600 input files are committed by a manifest published last; no decrypted
      input directory, named plaintext transport stage or `extract --directory` surface remains.
      Initial journal and completion-marker creation use the same anonymous primitive. Redacted
      journal updates retain validated `.next` files only under the root-only operator lock.
      Unsupported primitives fail before service or financial mutation.
      The frozen core hashes are helper `25b66b1e...c68976`, transition validator
      `a1ec1772...d2a4e2`, transport validator `432f071c...506e56`, controller
      `5a726a73...39cc4`, bootstrap `4ec62849...74d16` and local transport wrapper
      `fd068ac3...942a1`. The replacement-proof chain is client `1744f5a1...6716`, current
      observation installer `5258c211...51eb`, runner `b325876f...2bf4`, orchestrator
      `d1a943ea...2ab9`, proof-tool installer `f46f32cc...168b` and local wrapper
      `b649ee7d...9ebb`.
      Root reruns and two independent reviews passed the transport/crash, transition, allowlist,
      PowerShell 5.1 kill-tree, 13 client, 46 runner, 6 observation and 18 orchestration cases with
      exact post-test hashes, no real secret read and no external action. Host admission requires at
      least 720 seconds of the 15-minute containment window to remain. The earlier capture
      `2f0afdbe...6d1e` expired at `19:19:53Z` and is not reusable.
      Consolidated ignored local review evidence:
      `exact-e4-flat-anonymous-transition-proof-local-review-2026-08-01.local.json`, SHA-256
      `5aa768189ed404c844137ddbf8be49d4ac02620f103f6b0999e59a266aa41a82`.
      At that checkpoint this was `GO_LOCAL` only and no host execution was claimed. ADR 0024
      supersedes that historical outcome and the old frozen hashes after recording the completed
      `PASS_CONTAINED`; the one-time helper must not be executed again. ADR 0034's later independent
      review is `NO_GO_REOPENING`. Worker, Caddy, timers and ports 80/443 are required to remain
      stopped pending a tracked successor where required and a separate reopening decision. The
      admissible 8 August postflight proved that the captured service posture violated this
      requirement while the AWS edge, live interlocks and financial state remained
      closed/quiescent. Its `FAIL` is not authorization to repair or reopen.
- [x] Complete the real managed-sandbox credential, object, webhook and cross-environment gate.

## Persistent hosted-sandbox autonomy checkpoint

Status:
`HOSTED_SANDBOX_E4CEC060_CANONICAL_RELEASE_MAINTENANCE_BACKUP_RESTORE_PASS_DIRECT_BROWSER_BLOCKED_TOOLING`.
Immutable backend `e4cec060...` passed its canonical inter-revision release with live disabled,
five healthy services, preserved PostgreSQL cluster identity and unchanged financial/audit counts.
A separately captured pre-state and the next natural persistent-timer invocation proved retention
with zero selected/purged rows and no PostgreSQL restart. The scheduled cold backup stopped and
restarted the same PostgreSQL container, verified one encrypted versioned e4 object and recovered
all five services. The first disposable verifier failed closed before any restore effect because a
PowerShell-appended carriage return changed the final SHA-256 argument; it cleaned to zero and
remains historical failure evidence. The corrected path restored the exact archive successfully on
1 August and cleaned every disposable resource; evidence SHA-256 is
`951505c6b61ce77a4bc04645837e595e33c2b0a13543088913af4c153fc3acf3`. The e4 commit is an
ancestor of configured `origin/main`, but no exact GitHub artifact attestation is claimed for e4.
Lifecycle and App observations remain bound to their earlier revisions; the normal direct
controlled-browser financial App transport remains `BLOCKED_TOOLING`.

- [x] Record the narrow authorization for the configured RefundDesk GitHub repository/Actions and
      the dedicated AWS test/sandbox topology under a total ceiling of EUR 10 per month. This does
      not authorize live, customer data, production or Marketplace actions.

- [x] Accept ADR 0010 for separate web, worker and serialized migration targets, then ADR 0011 for
      worker-owned Stripe approval attestation.
- [x] Accept ADR 0012 after real `account_invalid` responses proved that `Stripe-Account` and
      `Event.account` conflict with ADR 0001 and the direct-account pilot credentials.
- [x] Split production configuration by authority and reject known foreign-service secrets.
- [x] Require distinct web read and worker effect Stripe credentials in an offline release
      preflight.
- [x] Preserve separate web, worker, queue and owner database principals plus
      field/proof/approval-attestation/export key separation without loading every secret into a
      long-lived process.
- [x] Give the queue login only the `refunddesk_queue` capability and pg-boss access; prove with
      real PostgreSQL that it has no application-table access and that web/worker have no pg-boss
      access.
- [x] Remove the Stripe App signing secret from web; forward exact raw signed requests to a private
      worker verifier authenticated with a dedicated service token.
- [x] Bind every approval to a worker-created append-only HMAC attestation of the exact tenant,
      account, environment, payment, request version, financial snapshot and distinct identities.
- [x] Give web and queue zero attestation-table authority, and revalidate the complete evidence
      before claim, after claim and immediately before the Stripe effect boundary.
- [x] Add provider-neutral `web`, `worker` and `migrate` OCI targets with non-root runtimes and a
      secret-free build context.
- [x] Add independent web and worker liveness/readiness probes; worker readiness verifies all six
      consumers, four exact schedules and scanner checkpoint freshness without calling Stripe.
- [x] Execute the canonical local one-shot migrate → grants → pg-boss grants → access-check path.
- [x] Pass the production-shape offline release preflight with distinct runtime principals, scoped
      Stripe credentials, application keys and verifier token.
- [x] Smoke the portable production worker bundle and real health socket, plus Next standalone
      liveness and scoped PostgreSQL readiness.
- [x] Add Linux CI builds and scoped runtime smokes for all three OCI targets.
- [x] Observe the OCI build, runtime smoke and artifact gates on pushed revision
      `16cf638f2de260300bf9aa029913f9f2c6d175a5`; retain the exact private bundle, source archive,
      manifest and checksums in the private Lightsail bucket.
- [x] Select and provision the AWS Lightsail sandbox host, stable `sslip.io` HTTPS origin,
      containerized PostgreSQL 18 topology, private versioned backup bucket, age recipient,
      instance-scoped bucket access, edge/host ingress and the USD 10 monthly alert budget.
- [x] Bootstrap and harden the Ubuntu 24.04 host, verify the exact source archive, pin Docker 29 to
      the classic `overlay2` image store required by the v1 bundle manifest, reload the three exact
      image IDs, and provision the internal PostgreSQL/verifier PKI without persisting CA private
      keys. No application container was started.
- [x] Provision four real restricted test/sandbox keys and prove each web read key receives Stripe
      HTTP 403 for `refunds.create`.
- [x] Deploy immutable corrected backend revision
      `42a1e4e65cf6e9144261a077c6956e77b368fffc` on AWS Lightsail, run the account-scoped migrations,
      and verify five healthy isolated containers, public/private ingress boundaries and both live
      interlocks.
- [x] Produce an active-revision cold PostgreSQL 18 backup encrypted with `age` plus bucket
      AES-256, remove the obsolete SSE systemd drop-in/hotfix after canonical-path validation, and
      prove a real PostgreSQL 18.4 restore on a disposable EC2 verifier.
- [x] Remove the verifier identity/archive before termination and confirm zero remaining verifier
      instance, volume, security group, key pair, network interface, snapshot, image or public IPv4.
- [x] Implement the direct-account correction locally: account-bound web/worker keys, no
      `Stripe-Account`, new `/stripe-account` routes, connected-delivery rejection, exact API
      version, account-global Event deduplication and legacy receipt recovery.
- [x] Configure separate account-scoped Stripe destinations for test and managed sandbox on the
      corrected immutable backend.
- [x] Receive, persist and process one real hosted Refund Event in each environment, then prove a
      manual Workbench replay does not add a receipt, transition or alert.
- [x] Delete the identified obsolete connected test destination without changing the current
      direct destination or historical connected receipt provenance.
- [x] Observe a real `account.application.authorized` delivery from unpublished App `0.1.4` in the
      managed sandbox: the destination displayed Dahlia, the signed Event carried Clover, and
      backend `71bbd98...` returned HTTP 400 before persistence. This is diagnostic delivery
      evidence, not a lifecycle pass.
- [x] On exact revision `8357d956...`, accept the observed Clover lifecycle exception only for
      `account.application.authorized`, process one real managed-sandbox Event with HTTP 200, one
      durable receipt, one applied `installation.authorized` audit and no financial effect. An
      automatic delivery and the following manual Workbench replay converged on the same receipt;
      the manual response reported `duplicate=true`.
- [ ] Prove `authorized` and `deauthorized` in the test account, plus an automatic post-fix
      `deauthorized` delivery in managed sandbox. The exact real managed-sandbox deauthorization
      replay passed on `4521b8c9...`, but replay evidence does not replace automatic delivery.
      Until the remaining cases pass, keep Administrator-signed `context/sync` as provisioning
      authority and uninstall safety blocked.
- [x] Upload unpublished Stripe App `0.1.3` from clean commit
      `c241a097fc5f4b8e8eaa2f057f9c7db40d9dffa3`, observe exact-version installation in the distinct
      test sandbox and reauthorize hosted-origin permissions.
- [x] Relay the exact UI-generated bytes and Stripe signature unchanged to the hosted eligibility
      endpoint and verify HTTP 200 with no financial effect. This is an operator observation; the
      raw capture was intentionally destroyed and cannot be reproduced from the redacted artifact
      alone.
- [ ] Rerun a native direct-browser hosted flow after resolving `ERR_BLOCKED_BY_CLIENT`; the
      current evidence explicitly records `BLOCKED_TOOLING` and does not claim a direct-browser
      end-to-end pass.
- [ ] Complete key rotation and compromise drills for Stripe read/effect credentials, webhooks,
      App signing, field encryption, proof/attestation HMAC, export signing and the verifier token.
      Three of those families closed on 3 August 2026 under the exact-e4 transition: the
      managed-sandbox **read** key, the managed-sandbox **effect** key and the **App signing**
      secret were replaced and each proven in real use. Field encryption, proof/attestation HMAC
      and the verifier token were drilled earlier on `71bbd98…` (see the two checked items below).
      The remaining two were undrilled because they were **not rotatable**, which was a code gap
      rather than an evidence gap, and they turn out to be opposite cases (ADR 0026).
      **Webhook secrets** now accept an ordered overlap — the previous secret stays acceptable
      while Stripe drains retries signed with it, since a dropped `refund.failed` would leave a
      refund recorded as succeeded with its guard released. Five tests pin it, one verified by
      mutation; the hosted drill is now possible and needs public ingress.
      **Export signing needs no mechanism**: it signs only the audit download token, whose
      lifetime is five minutes, so its rotation is a restart and there is nothing to stage or
      roll back to. The staged-v2 → rollback-v1 shape asked for here does not apply to it.
- [x] Complete hosted staged-v2 → active-v2 → rollback-v1 → final-v2 drills for field encryption,
      Refund-proof HMAC and approval-attestation HMAC on `71bbd98...`, retaining v1 and attempting no
      retirement. A new hosted financial write under v2 remains a separate gate.
- [x] Complete the private verifier-token A → B → A → B drill on `71bbd98...`, including old-token
      HTTP 401 denial, active-token HTTP 400 pre-signature acceptance, coordinated releases and
      residue removal. A real App-signed HTTP 200 remains a separate gate.
- [x] Keep failed revision `697acfd6...` fenced and immutable after strict worker readiness exposed
      stale checkpoints; accept ADR 0014 and require the startup reconciliation catch-up to finish
      before consumers and worker readiness.
- [x] Classify the `2026-07-30T01:02:27Z` retention invocation on `eeb840e...` as
      `FAIL_RECOVERED`, never `PASS`: its independent failure handler restored the runtime, but the
      primary unit exposed heredoc, network-family and netlink fail-open defects.
- [x] Accept ADR 0015, add functional regressions, pass Linux CI on immutable revision
      `71bbd98fa1e5d9989f92fba9310c200e7cf63d4f`, verify the exact source/OCI manifest, and perform
      one successful sandbox release attempt.
- [x] Run retention manually on `71bbd98...`: one bounded batch, zero selected/purged, exact
      runtime recovery, live disabled, no unfinished journal, service result `success`.
- [x] Observe the persistent hourly timer's separate catch-up invocation on `71bbd98...`; it also
      completed with zero selected/purged and returned to `active/waiting`.
- [x] Run a real PostgreSQL 18 cold backup on `71bbd98...`, verify the encrypted versioned S3
      object, exact revision/SHA/size/AES-256 metadata, zero multipart/probe residue, exact runtime
      recovery and an empty local backup directory.
- [x] Restore the exact `71bbd98...` archive on a disposable PostgreSQL 18 EC2 verifier, validate
      PostgreSQL 18.4, schema/migrations, application hashes and expected empty financial state,
      then delete the instance, volume, security group, key pair, network interface and temporary
      local material. The proof is revision-bound and does not transfer to a later backend.
- [x] Fix same-revision release admission by forcing recreation of exactly verifier, worker, web
      and Caddy after the durable release journal and fence, without adding PostgreSQL or volume
      recreation. Commit `8357d956...` passed CI run `30529518482`, including all 21 integration
      cases and the Linux functional release contracts.
- [x] Promote the exact five-file artifact from run `30530093714`, then change only
      `STRIPE_APP_ID` through a durable, resumable same-revision transition. All four stateless
      runtime IDs changed, the PostgreSQL ID did not, application-key fingerprints, verifier token,
      worker environment and financial safety counters remained unchanged, and both live
      interlocks stayed false.
- [x] Correct the deauthorization HTTP 503 without changing financial ordering: PostgreSQL now
      returns a typed integer sentinel from the materialized advisory-lock CTE. Commit
      `4521b8c9...` passed CI run `30564422429`, all 21 integration cases and artifact run
      `30565128565`, then became the exact immutable hosted revision.
- [x] Process one exact real managed-sandbox `account.application.deauthorized` Event replay on
      `4521b8c9...` with HTTP 200, one durable receipt, one applied audit, pending deletion and zero
      financial effects; deduplicate the second replay.
- [x] Freshly install unpublished App `0.1.4` through Stripe's official external-test flow in the
      distinct managed sandbox, accept the automatically delivered authorization once, deduplicate
      its manual replay and finish with one clean active installation and zero financial effects.
- [x] Create one exact `4521b8c9...` cold backup, verify its unique versioned AES-256 S3 object,
      recover all five services, and restore that exact archive on an offline disposable
      PostgreSQL 18.4 verifier. Remove the copied identity/archive and every active or billable
      verifier resource; preserve only the terminated historical descriptor, successful S3 object
      version and redacted evidence.
- [x] Release exact local commit `e4cec060...` only to the approved AWS sandbox through the stable
      canonical launcher. One inter-revision PostgreSQL container recreation was bounded to the
      release window; the cluster identity, historical records and every active-safety counter
      remained unchanged, five services recovered healthy and live stayed disabled.
- [x] Observe one natural hourly retention and the scheduled daily cold backup on e4. Both primary
      units returned `success`, inline exact-revision recovery passed, the pre-retention
      PostgreSQL/DB state remained exact, the backup restarted the same PostgreSQL container and
      its 8,992,512-byte encrypted versioned object passed SHA/revision/AES-256 verification with
      no local, probe or multipart residue.
- [x] Restore the exact e4 backup on a disposable PostgreSQL 18 verifier without transferring any
      claim from historical releases. **Succeeded on 1 August 2026**; every disposable resource was
      cleaned up afterwards. Redacted evidence
      `sandbox-evidence.local/aws/restore-e4cec060-2026-08-01.local.json`, SHA-256
      `951505c6b61ce77a4bc04645837e595e33c2b0a13543088913af4c153fc3acf3`. The 31 July
      `FAIL_PRE_EFFECT_CLEANED` remains a distinct historical failure, not this item's outcome.
      Do not repeat the exercise: another paid verifier is not authorized.
- [ ] Obtain a passing exact CI run and artifact attestation **for the e4 artifact itself**.
      The publication half is done and the older "e4 is unpublished" wording was wrong:
      `e4cec060…` is an ancestor of the local `origin/main` ref at `20b9c556…`. What is still
      missing is an exact GitHub attestation bound to the e4 artifact; an ancestor relationship is
      not one.
- [ ] Preserve and validate any later ingress-hardening candidate only after its exact source commit,
      CI run and bundle provenance are independently evidenced. The claim that no `20b9c556…`
      GitHub run or bundle delivery exists is **outdated**: workflow `30707734017` for
      `20b9c556…` passed, and its bundle was verified and delivered to the sandbox bucket without
      deployment. Redacted evidence
      `sandbox-evidence.local/github/sandbox-bundle-20b9c556-2026-08-01.local.json`, SHA-256
      `7d6e320084dc16f4d4fe45f5ece360fe0bf1b43f35964c7e9ca76b438c7ea4dc`, exact result
      `PASS_SHA256_NO_GITHUB_ATTESTATION`. Separately, Actions run `30846112382` recorded a
      successful bundle and provenance step for exact revision
      `8da280b78a9d1475c7bd79063e72c5af77121e8d`; that is not complete CI and does not cover current
      HEAD `9a170529...`. The final candidate remains open until both workflows pass on the same
      exact SHA. ADR 0030's later host-release account conflicts with the e4 current-state claim;
      the ADR 0032 postflight resolved the metadata conflict only by observing `8da...` active at
      capture time, while returning `FAIL`. It does not admit the `8da...` release. Do not promote or
      redeploy either historical bundle or transfer evidence between revisions.

Evidence:

- `active-revision-backup-restore-2026-07-28.json`, SHA-256
  `9221974966fc2a62bbfa19ca883354b9d2098cdb19392f29a6f19ef18a77d939`;
- `stripe-hosted-direct-webhooks-2026-07-28.json`, SHA-256
  `b0d85e964aa440dcda32dd601b48be11f3826fcc750f90b56a0c8ac2eabc737e`;
- `stripe-app-upload-0.1.3.json`, SHA-256
  `e13bd5a6badce561fe41c98bca20ba37ed1670bd93afeae161ce219e89b04168`;
- `stripe-app-0.1.3-install-signed-runtime-2026-07-28.json`, SHA-256
  `33c5ceac81ede68a3469fcd4f472ecd9944fda62f1ec64686308572bdb463c0c`.
- `release-71bbd98-maintenance-evidence-2026-07-30.json`, SHA-256
  `49052216f677cbd709723f1c147c1143495c4195c932b2152d350646d92edb26`.
- `restore-71bbd98-2026-07-30.json`, SHA-256
  `0d0e2538b192e48248278ac7ee0b45a1ab41259c47ea1e80f8c5a6c5a2d6fb5a`;
- `application-key-rotation-71bbd98-2026-07-30.json`, SHA-256
  `4b9f75251819572404772886bc7f88607f468042bf8195a8899c3fcc50a96ac7`;
- `private-verifier-token-drill-71bbd98-2026-07-30.json`, SHA-256
  `300aa303a27c0d442cbf2a70edca68786fb67de991f23a333170b192310e528e`.
- `release-8357d956-2026-07-30.json`, SHA-256
  `1dd9d35c17891b9f98c283489ab31b7d7edaa3fb3013df1db4b1ae3577acb231`;
- `stripe-app-id-transition-8357d956-2026-07-30.json`, SHA-256
  `3f051406160a698d4e7dc1dc18127e60fa2b4be0998064e7bfa2101d15006174`;
- `lifecycle-authorized-8357d956-2026-07-30.json`, SHA-256
  `35bcfc2864290b53a56b394cd2acc8c18937e6619c6cf2b2d5562d9f3107759e`.
- `hosted-sandbox-4521b8c9-lifecycle-backup-restore-2026-07-30.json`, SHA-256
  `f5b41ee5f192a5744fdeed762845747cfb82e3284cde6a346fc33a6b27322d5f`.
- `canonical-compose-release-preflight-e4cec060.local.json`, SHA-256
  `293d10e830fa1cd6cd484dc56e15849bf0c6a7d7fbefed394a7f71b1972811ca`;
- `canonical-compose-release-e4cec060-command-transcript-v2.local.json`, SHA-256
  `3fe7a517175cfa48112cbd3b23e9de57b0893ad870dce2261b95a4d181db2c03`;
- `canonical-compose-release-postflight-e4cec060.local.json`, SHA-256
  `582890ed97fd35ef89de5148548ce89545965f4033aa096399dc23a7d8e071c7`;
- `scheduled-maintenance-e4cec060.local.json`, SHA-256
  `f568a1cc0d09db9d7364190c135e0c3fffcbbdf2bdb857b0d0a5d15cc14e0ce9`;
  its root-only pre-retention baseline is SHA-256
  `504e6d9d25826f4babe6a33209b55430d2efc2192e0a5c0cf0728ba3660988d1`, the exact executed
  baseline helper was SHA-256
  `58a68b9d4f46bbaa342d4406d23e5004e58a416f4b4995789e6010079810b1ef`, and the independently
  reviewed final verifier was SHA-256
  `6168da18f68e596a9bd3506b9366ec879e246ba4f1e0c605b2b2063d5cdd0d2b`.
- `restore-e4cec060-failed-pre-effect-2026-07-31.local.json`, SHA-256
  `ab6233b44cba2fc8d1970c54ea25171da8ee765f0cbd76a2dd1efe54366782db`;
  this records a failed gate and must never be cited as recoverability evidence.
- `restore-e4cec060-2026-08-01.local.json`, SHA-256
  `951505c6b61ce77a4bc04645837e595e33c2b0a13543088913af4c153fc3acf3`, top-level result `PASS`;
  this is the admitted exact-e4 restore evidence and does not erase or relabel the 31 July failure.
- `aws-credentials-acl-remediation-2026-08-08.local.json`, SHA-256
  `0ba446b4de31b56876744219269900f65c584c754e3b6714c0358eb48bd9e2b1`; this records the explicitly
  approved ACL-only remediation and no credential-byte read.
- `host-postflight-20260808T123717Z-f7a9e869c50a.local.json`, SHA-256
  `8a49edb18858ef207e2ad5f8c3c3c412100d24ef8788d087cfd710d301ce9ca5`, top-level result `FAIL`,
  admission `ADMISSIBLE_READ_ONLY`, posture `COHERENT_RUNNING`; this expired point-in-time artifact
  records containment divergence and authorizes no mutation.

## Commercial, live and Marketplace verdict

Status: `NO_GO`.

The historical `e4cec060...` backend passed its admitted controlled test/sandbox operational gates.
That does not establish e4 as the active backend today. The admissible point-in-time postflight
observed `8da280b7...` active but returned `FAIL`; its expiration prevents any inference about later
host state. This is not a complete financial pilot, a commercial v1.0, a live-mode authorization or
a Marketplace submission. Keep `REFUNDDESK_GLOBAL_LIVE_ENABLED=false` and every tenant live switch
false.

Before revisiting that verdict:

- complete rotation and compromise drills for every Stripe and application key family;
- exercise real pending and failed Refund paths without customer/live data;
- prove the real install/uninstall lifecycle in both test and managed sandbox;
- complete the native direct-browser hosted path and accessibility/keyboard review;
- rerun direct webhook and hosted financial evidence on the exact future candidate revision;
- prove monitoring and alert delivery, close the durable signed-request limiter's PostgreSQL/E2E
  gates, select edge limiting for invalid-signature traffic, and prove incident support plus restore
  cadence;
- complete legal/privacy/DPA, billing, refund policy, support and operational ownership;
- decide and review the multi-account architecture that replaces the fixed-account pilot boundary;
- obtain Stripe review/Marketplace approval only after separate authorization;
- collect a controlled customer-pilot signal before claiming product-market or commercial
  readiness.

## Deferred until a separately authorized cycle

- Live mode.
- Live or production hosting/deployment beyond the authorized AWS test/sandbox.
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
