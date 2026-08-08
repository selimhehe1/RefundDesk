# RefundDesk real Stripe sandbox test plan

> Purpose: produce the evidence required for Phase 0 and pilot acceptance  
> Safety: test mode and managed sandbox only; synthetic data only  
> Final result: `PASS` — 34/34 required cases recorded as `passed_real` on 2026-07-26
> Hosted checkpoint: historical canonical exact-e4 runtime evidence; exact real managed-sandbox
> deauthorization replay, fresh App `0.1.4` installation/automatic authorization and exact
> exact-e4 scheduled backup plus exact disposable restore passed. Direct Refund webhook evidence remains bound to
> `42a1e4e...`, test-account lifecycle remains open, and direct financial controlled-browser
> transport is `BLOCKED_TOOLING`. The admissible 8 August read-only postflight observed active
> `8da280b7...` but returned `FAIL` with posture `COHERENT_RUNNING`; it authorizes no repair,
> release, reopening or financial proof. Exact candidate `4429559...` later passed its exact CI and
> sandbox-bundle gates, but its contained reconciliation failed closed before effect on a Docker
> reservation-inspection mismatch. The immediate control postflight found the host unchanged in
> `COHERENT_RUNNING`; a corrected successor remains required.

## 1. Rules of execution

- Never paste a secret into a command captured for evidence, a log or this document.
- Use ignored local environment files or an interactive secret mechanism.
- Never use a real card, customer identity or production PaymentIntent.
- Confirm `livemode=false` from the returned Stripe objects before continuing.
- Use only synthetic PaymentIntents recorded for the exact evidence case. The direct Phase-0 probe
  surface no longer exists in the pilot runtime.
- Use separate credentials, app installations and webhook secrets for test mode and managed sandbox.
- Stop immediately if the account, mode or sandbox marker is not the expected one.
- Do not use this plan for load testing.

The canonical source for the refund test PaymentMethods is [Stripe testing — refunds](https://docs.stripe.com/testing#refunds).

## 2. Human prerequisites

- Stripe account access with MFA.
- One Administrator user.
- One distinct `View only` user who can see Payments.
- Unpublished RefundDesk Stripe App installed in both target test environments where required.
- The signing secret for the exact uploaded Stripe App is available locally. Stripe documents one
  signing secret per App, with temporary overlap during rotation; unlike webhook endpoint secrets,
  it is not split between test mode and managed sandboxes. Environment isolation is therefore
  proved by the signed `is_sandbox` value, account binding, environment-specific API credentials
  and webhook endpoints rather than by assuming distinct App signing secrets.
- Test and managed-sandbox server credentials available locally.
- Separate webhook endpoint secrets.
- Stripe CLI authenticated to the intended test context.

Missing human prerequisites produce `BLOCKED_HUMAN`, not a failed technical gate.

## 3. Preflight

Record versions without secrets:

```bash
node --version
pnpm --version
stripe --version
git rev-parse HEAD
```

Run local gates:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm secrets:check
```

Upload and install the unpublished, production-safe `stripe-app.json` in **test mode only** after an
authorized human has accepted the Stripe Apps Agreement. Do not pass `--live`. Historical `0.1.1`
contains no direct Phase-0 probe surface. Current `0.1.3` is bound to the approved hosted sandbox
origin and must retain exact commit, source-archive, upload and installation provenance. For a
separately authorized local UI preview, expose the local API through a temporary public-HTTPS
origin, then start the developer overlay separately:

```powershell
$env:REFUNDDESK_DEV_API_BASE = "https://<temporary-host>/api"
pnpm dev:stripe-app
```

The current Stripe Apps CLI rejects loopback HTTP origins in `connect-src`. The launcher therefore
accepts only a public-DNS HTTPS origin whose resolved addresses are all public, invokes Stripe
without a command shell, derives an ignored `stripe-app.local.json` from the safe uploadable
manifest, points the local build at the configured development API, keeps live mode off, starts
`stripe apps start`, then removes the generated manifest and `.build` output at exit. Never upload
either generated artifact.

The HTTPS origin can make the local Next.js origin reachable from the public internet. Keep every
mutating or tenant-data route authenticated according to its route contract, expose it only for the
evidence window, and stop the tunnel immediately afterward. A whole-origin tunnel also exposes the
landing page and bounded health/readiness endpoints without a Stripe signature; prefer a
path-restricted proxy where available. DNS validation is a startup snapshot; use only a short-lived
tunnel hostname under the operator's control and do not treat it as protection against later
rebinding.
Chrome also requires the operator to grant `dashboard.stripe.com` local-network access before it can
load the bundle served by the Stripe CLI. That privacy permission is a human checkpoint.

Before any Stripe call, verify:

- global live switch is false;
- tenant live switch is false;
- no direct Phase-0 route, client method, UI control or runtime switch is present;
- every synthetic PaymentIntent belongs to the exact recorded test/sandbox case;
- expected account ID and environment are displayed to the operator;
- live webhook secret and live credential are unavailable to the process.

## 4. Synthetic fixtures

Create small EUR PaymentIntents independently in test mode and managed sandbox. Use PaymentMethod tokens, not card numbers:

| Fixture          | PaymentMethod           | Purpose                                 |
| ---------------- | ----------------------- | --------------------------------------- |
| `normal`         | `pm_card_visa`          | partial/full happy path and idempotency |
| `pending_refund` | `pm_card_pendingRefund` | pending to succeeded transition         |
| `failed_refund`  | `pm_card_refundFail`    | asynchronous failed refund              |

Recommended amount: 1,099 EUR minor units for each isolated scenario. Do not reuse a PaymentIntent if its refundable amount would make the next assertion ambiguous.

For every fixture, record only:

- environment label;
- Stripe account ID;
- PaymentIntent ID;
- Charge ID;
- amount and currency;
- `livemode=false`;
- creation timestamp.

Record the generated PaymentIntent IDs only in the redacted case evidence after verifying the
environment. There is no runtime probe allowlist after Phase-0 acceptance.

## 5. Evidence format

Create one redacted JSON record per case and a Markdown summary. Suggested schema:

```json
{
  "case_id": "P0-SIGN-001",
  "gate": "SIGNATURE",
  "environment": "test",
  "account_id": "acct_…last6",
  "started_at": "RFC3339",
  "finished_at": "RFC3339",
  "tool_versions": {},
  "inputs": {
    "resource_id": "pi_…last6"
  },
  "expected": "altered signed body is rejected",
  "observed": "HTTP 401 SIGNATURE_INVALID",
  "status": "passed_real",
  "artifacts": []
}
```

Allowed statuses:

- `passed_real`
- `failed_real`
- `blocked_human`
- `not_run`

Redact account and resource IDs in any artifact intended for broad sharing. Local restricted evidence may retain full non-secret Stripe object IDs, but never secrets, full payloads, e-mail or sensitive text.

## 6. Phase 0 cases

### 6.1 App and UI

| Case         | Procedure                                                        | Expected                                                 |
| ------------ | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `P0-APP-001` | Create/upload and install the unpublished app without publishing | App installation is visible in the intended test context |
| `P0-UI-001`  | Open an allowlisted synthetic payment                            | RefundDesk renders at `stripe.dashboard.payment.detail`  |
| `P0-UI-002`  | Open a non-allowlisted or live-context resource                  | Probe action is absent or fails closed                   |

### 6.2 Signed request

Use the exact canonical variant from the v1.1 specification. Payment envelopes include
`resource_id`; account envelopes omit it and bind through the Stripe-signed `account_id`.
`roles_asserted=false` must omit `stripe_roles`; `roles_asserted=true` must contain a non-empty,
strictly validated role list.

| Case          | Mutation                                        | Expected                          |
| ------------- | ----------------------------------------------- | --------------------------------- |
| `P0-SIGN-001` | Valid current signature and canonical body      | Accepted                          |
| `P0-SIGN-002` | Change one byte in `command_json`               | `401` signature failure           |
| `P0-SIGN-003` | Reorder two signed fields                       | Rejected                          |
| `P0-SIGN-004` | Add an unknown field                            | Strict validation rejection       |
| `P0-SIGN-005` | Substitute `user_id`                            | Rejected                          |
| `P0-SIGN-006` | Substitute `account_id`                         | Rejected                          |
| `P0-SIGN-007` | Use an expired signature                        | Rejected                          |
| `P0-SIGN-008` | Cross test/sandbox credential or installation   | Rejected                          |
| `P0-SIGN-009` | Present `livemode=true`                         | Rejected before any Stripe effect |
| `P0-SIGN-010` | Add `resource_id` to an account envelope        | Strict validation rejection       |
| `P0-SIGN-011` | Omit `resource_id` from a payment envelope      | Strict validation rejection       |
| `P0-SIGN-012` | Send `stripe_roles` with `roles_asserted=false` | Strict validation rejection       |
| `P0-SIGN-013` | Omit roles with `roles_asserted=true`           | Strict validation rejection       |

### 6.3 Role gap and Refund

1. As Administrator, confirm the synthetic payment is visible.
2. As `View only`, confirm the payment is visible.
3. As `View only`, attempt to locate/use Stripe’s native refund capability and record that the role cannot perform the refund.
4. From RefundDesk as `View only`, submit a small partial request.
5. Verify the raw signed body, exact signed user/requester match, `pending_approval/not_started`
   persistence, zero decision/execution/Refund, then cancel the request as the same requester.
6. Exercise the separate allowlisted Administrator-only Refund probe for the Refund permission gate.

| Case            | Expected                                                      |
| --------------- | ------------------------------------------------------------- |
| `P0-ROLE-001`   | `View only` can view the payment but cannot refund natively   |
| `P0-ROLE-002`   | `View only` can send an authenticated RefundDesk request      |
| `P0-REFUND-001` | Backend returns one `re_...`, exact minor amount and currency |
| `P0-REFUND-002` | Stripe account and `livemode=false` match the installation    |

`P0-ROLE-002` may omit a role assertion when Stripe refuses to sign `stripe_roles` for the restricted
user. In that case it proves authenticated identity and request creation, not role propagation or
role-based authorization. It passes only when a stable redacted actor hash proves that the exact same
full Stripe user ID was independently observed as built-in `View only` in `P0-ROLE-001`. Record the
limitation explicitly. If that identity link is missing, the case fails. Do not reinterpret different
role behavior as success.

### 6.4 Stripe idempotency

1. Capture the deterministic request key without exposing credentials.
2. Send the exact same `refunds.create` operation twice with that key.
3. Retrieve/observe both responses.

Expected:

- both responses refer to the same Refund ID;
- Stripe contains one Refund for the intended effect;
- RefundDesk stores one immutable link;
- attempts are audit-visible without a second effect.

Case: `P0-IDEM-001`.

Keep the same local API process running for the two calls and the related webhook observation. The
development-only Phase-0 correlation store is intentionally process-local; a restart makes the case
inconclusive and requires a fresh synthetic payment and nonce. The pilot workflow uses durable
PostgreSQL state and does not inherit this exception.

### 6.5 Webhook

| Case             | Procedure                                     | Expected                                    |
| ---------------- | --------------------------------------------- | ------------------------------------------- |
| `P0-WEBHOOK-001` | Receive the real `refund.created`             | Signature passes and receipt is stored once |
| `P0-WEBHOOK-002` | Replay the same Event                         | No second domain transition                 |
| `P0-WEBHOOK-003` | Change one body byte                          | Signature fails                             |
| `P0-WEBHOOK-004` | Send sandbox Event to test endpoint           | Environment binding rejects it              |
| `P0-WEBHOOK-005` | Deliver Event before API-response persistence | Same first Refund ID is linked safely       |

During the bounded evidence window, the signed Administrator-only report control captured the
redacted webhook correlation. The sealed local evidence records that observation without retaining
the signing secret, raw Event body or another account's evidence.

The control, route and manifest switch were removed after the Phase-0 verdict. They were evidence
tooling and are not part of the pilot runtime surface.

### 6.6 External Refund and proof replay

Use a fresh synthetic payment.

1. Create a Refund manually in the Stripe Dashboard or with a credential outside RefundDesk.
2. Confirm RefundDesk classifies it as external.
3. On that same still-refundable payment, create a **different Refund object** carrying the copied
   RefundDesk metadata. The proof binds the payment key, so copying it to a different PaymentIntent
   must produce `invalid_proof`, not `proof_replay`.
4. Confirm it becomes a `proof_replay`/tampering alert and does not replace an existing link.

Cases:

- `P0-EXT-001`
- `P0-PROOF-001`

### 6.7 Environment isolation

Repeat the happy path independently in:

- account test mode;
- managed sandbox.

Then exercise both credential crossovers. Expected:

- each happy path creates an effect only in its own environment;
- every crossover fails before a Stripe effect;
- no test object is accepted as a sandbox object or vice versa.

Cases:

- `P0-ENV-TEST-001`
- `P0-ENV-SANDBOX-001`
- `P0-ENV-CROSS-001`
- `P0-ENV-CROSS-002`

### 6.8 Permissions and publishability

Record the installed permissions and prove each use:

- `charge_read`
- `charge_write`
- `payment_intent_read`
- `event_read`

Confirm `user_email_read` is absent. Remove any requested permission that the real workflow does not exercise. Record any current Marketplace or app-review constraint that would make the product impossible to distribute, without submitting the app.

Cases:

- `P0-PERM-001`
- `P0-PUBLISH-001`

## 7. Pilot behavior cases after Phase 0 PASS

### 7.1 Workflow and exact money

- partial Refund;
- full remaining Refund;
- zero, negative, malformed and excessive amount refusal;
- zero-decimal currency fixture at the domain/contract layer;
- request refused without a distinct approver;
- self-approval refused;
- rejection with encrypted reason;
- cancellation only before approval;
- expiration after seven days.

### 7.2 Async refund states

`pm_card_pendingRefund`:

- Refund starts `pending`;
- guard remains held;
- real `refund.updated` moves it to `succeeded`;
- no second create occurs.

`pm_card_refundFail`:

- Stripe can initially report success then emit `refund.failed`;
- the same immutable Refund ID moves `identified -> absence_proven`;
- the original terminal and guard-release timestamps remain unchanged;
- repeat with `refund.failed` processing suppressed and confirm direct retrieval by Refund ID
  converges the same state;
- the workflow does not retry with a new key.

### 7.3 Crash matrix

Inject a controlled process stop:

1. before persisting the attempt;
2. after persisting but before the Stripe call;
3. after the request could reach Stripe;
4. after Stripe response but before database commit;
5. after commit but before job acknowledgement.

For each point:

- restart the worker;
- verify the same idempotency key;
- verify zero or one Stripe Refund, never two;
- verify the guard state;
- verify an audit trail.

Exercise all recovery outcomes:

- safe re-enqueue of `approved/not_started` and `executing/not_started`;
- safe re-enqueue of `executing/absence_proven` with the persisted execution and expected key;
- diversion of `executing/possible` to reconciliation;
- refusal of a missing execution, different key or already linked Refund.

### 7.4 Reconciliation scanner

- suppress webhook processing for one Refund;
- wait/run scanner;
- assert detection within thirty minutes;
- create over 100 Refund fixtures only if Stripe test limits and pilot cost allow, otherwise validate pagination with a controlled contract fixture and separately exercise at least two real pages when safe;
- fail after an intermediate page;
- verify checkpoint did not advance;
- rerun and verify deduplication;
- complete an empty window covering both execution start and `reconciliation_safe_after_at`, then
  verify absence proof and same-key resume;
- complete an empty partial or non-covering window and verify reconciliation remains;
- refresh a linked Refund older than the temporal overlap by exact ID;
- fail one linked retrieval and verify later targets plus the temporal scan continue while the
  aggregate job remains retryable.

The real Phase 0 gate does not require a high-volume test.

### 7.5 Uninstallation

1. Queue a request without effect.
2. Uninstall/suspend the app.
3. Confirm no new job is claimed.
4. Reconcile any attempt already in `possible`.
5. Confirm retention deadline is scheduled.
6. Confirm subsequent signed actions fail closed.

### 7.6 Hosted autonomy checkpoint — observed 2026-07-28

| Gate                                 | Observed evidence                                                                                             | Result            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------- |
| Backend                              | Immutable `42a1e4e65cf6e9144261a077c6956e77b368fffc`, five healthy services, live disabled                    | `passed_real`     |
| Direct webhooks                      | One real `refund.created` processed in test and managed sandbox                                               | `passed_real`     |
| Webhook replay                       | Manual Workbench replay left receipt/alert/classification state unchanged in each environment                 | `passed_real`     |
| Legacy destination                   | Identified obsolete connected test destination removed; direct destination and historical receipts unchanged  | `passed_real`     |
| Backup/restore                       | Active-revision `age` + SSE-S3 backup restored on disposable PostgreSQL 18.4; all temporary resources removed | `passed_real`     |
| App upload                           | Unpublished `0.1.3` from clean `c241a09...` reported `UPLOAD_COMPLETED`                                       | `passed_real`     |
| App install/reauthorization          | Exact version and hosted permissions observed in a distinct test sandbox                                      | `passed_observed` |
| Signed hosted verification           | Exact UI-generated bytes/signature observed relayed unchanged; hosted eligibility returned HTTP 200           | `passed_observed` |
| Direct controlled browser            | Browser-control profile intercepted transport with `ERR_BLOCKED_BY_CLIENT`                                    | `BLOCKED_TOOLING` |
| Hosted financial effect from `0.1.3` | Not attempted by the signed-relay evidence                                                                    | `not_run`         |
| App uninstall lifecycle signal       | Still requires real evidence in both environments                                                             | `not_run`         |
| Full key rotation/compromise drill   | Still open across every credential/key family                                                                 | `not_run`         |

Do not combine the `0.1.2` local-overlay financial happy path with the `0.1.3` hosted signed-relay
proof. The former proves one managed-sandbox financial workflow; the latter proves exact-version
installation, Stripe signature generation and hosted verification without a financial effect.
`BLOCKED_TOOLING` is neither a product failure nor a native browser pass; rerun transport in a
controlled profile that does not intercept the request. The raw signed capture and temporary
harness were intentionally destroyed, so the install and relay observations cannot be reproduced
from the redacted artifact alone.

### 7.7 Immutable maintenance correction — observed 2026-07-30

| Gate                             | Observed evidence                                                                                                          | Result                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Prior retention invocation       | `eeb840e...` primary unit failed; independent recovery restored the exact runtime and removed its journal                  | `FAIL_RECOVERED`         |
| Immutable release                | One release attempt of `71bbd98...`; exact source/OCI hashes, migrations, five runtimes, public health and live interlocks | `passed_operational`     |
| Startup reconciliation ordering  | Two installation scans completed before startup catch-up and before the worker reported started                            | `passed_operational`     |
| Manual retention                 | Invocation `74fbf08f...`; one batch, zero selected/purged, exact recovery, no unfinished journal                           | `passed_operational`     |
| Persistent retention timer       | Distinct catch-up invocation `4c4b33bf...`; zero selected/purged, success, timer returned to future `active/waiting`       | `passed_operational`     |
| Cold backup                      | Invocation `c3562a69...`; clean five-service stop, encrypted upload, exact recovery, service result success                | `passed_operational`     |
| Versioned backup object          | Unique `71bbd98...` version with exact SHA/length/revision/AES-256 metadata; no multipart/probe/local residue              | `passed_operational`     |
| Revision-bound restore           | The exact `71bbd98...` object passed a disposable PostgreSQL 18.4 restore; all temporary resources were removed            | `passed_operational`     |
| Final financial and queue state  | Read-only PostgreSQL 18 snapshot: zero requests/executions/attempts/protected effects/live installs/active jobs            | `passed_operational`     |
| Live, Stripe review, Marketplace | Neither authorized nor attempted                                                                                           | `not_run_not_authorized` |

ADR 0015 defines the maintenance outcomes. A recovered runtime does not convert a failed primary
maintenance service into a pass. The manual proof and the persistent timer catch-up are separate
invocations; neither may be inferred from the other. This checkpoint validates hosted sandbox
operation only and does not alter the Phase-0, App transport, uninstall, key-rotation or live gates.

### 7.8 Same-revision release and lifecycle authorization — observed 2026-07-30

| Gate                                | Observed evidence                                                                                                          | Result                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Code and exact artifact             | Commit `8357d956...`, CI run `30529518482` and five-file artifact run `30530093714` completed successfully                 | `passed_operational`     |
| Canonical release                   | Five healthy services, exact public revision, no open release journal, active timers and both live interlocks false        | `passed_operational`     |
| Same-revision App-ID transition     | Four stateless containers recreated; PostgreSQL identity, application-key fingerprints and verifier token stayed unchanged | `passed_operational`     |
| Managed-sandbox lifecycle delivery  | One real `account.application.authorized` Event returned HTTP 200 and produced one processed receipt and one applied audit | `passed_real`            |
| Manual Workbench replay             | HTTP 200 with `duplicate=true`; no second receipt, installation transition or audit was created                            | `passed_real`            |
| Financial isolation                 | Zero Refund request, execution, attempt, candidate or effect audit was attributable to the lifecycle Event                 | `passed_operational`     |
| Test-account `authorized`           | Not yet observed on this revision                                                                                          | `not_run`                |
| Test and managed-sandbox uninstall  | Real `account.application.deauthorized` still unobserved in both environments                                              | `not_run`                |
| Native Stripe App browser transport | No new native rerun; the prior controlled-profile result remains blocked before normal delivery                            | `BLOCKED_TOOLING`        |
| Current-revision backup and restore | No backup or disposable restore has been run for `8357d956...`; earlier revision evidence does not transfer                | `not_run`                |
| Live, Stripe review and Marketplace | Neither authorized nor attempted                                                                                           | `not_run_not_authorized` |

The automatic delivery completed before the manually captured replay, so the manual response
correctly reported a duplicate. The database snapshot proves a single post-transition receipt and
consistent lifecycle state; it does not turn the replay into a fresh-install observation. This
checkpoint authorizes continued controlled sandbox engineering only.

### 7.9 Deauthorization hotfix, fresh install and exact restore — observed 2026-07-30

| Gate                                          | Observed evidence                                                                                                                | Result                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Code and exact artifact                       | Commit `4521b8c9...`, CI run `30564422429` and artifact run `30565128565` completed successfully                                 | `passed_operational`     |
| Lifecycle-lock hotfix                         | Materialized advisory-lock CTE returns a typed integer sentinel; locking and financial-state order are unchanged                 | `passed_operational`     |
| Managed-sandbox deauthorization processing    | Exact Workbench replay of a real Event returned HTTP 200, created one receipt/audit, pending deletion and zero financial effects | `passed_real_replay`     |
| Managed-sandbox deauthorization deduplication | Second exact replay returned HTTP 200 and did not create a second receipt, transition or audit                                   | `passed_real_replay`     |
| Fresh App `0.1.4` installation                | Stripe's official external-test flow displayed the App installed in the distinct managed sandbox                                 | `passed_observed`        |
| Automatic managed-sandbox authorization       | Fresh installation emitted one automatic Event accepted with HTTP 200; its manual replay was deduplicated                        | `passed_real`            |
| Final lifecycle and financial state           | One clean active installation, no failed lifecycle receipt, no active workflow/guard/effect and live disabled                    | `passed_operational`     |
| Exact current-revision cold backup            | Unique versioned `4521b8c9...` object with exact SHA/length/AES-256 metadata and five-service recovery                           | `passed_operational`     |
| Exact current-revision disposable restore     | Offline PostgreSQL 18.4 physical checksums, migrations and restricted roles passed with one PASS and zero errors                 | `passed_operational`     |
| Verifier and sensitive-material cleanup       | Identity/archive/SSH material removed; zero active instance, volume, ENI, SG, key, EIP, snapshot, AMI or old-IP association      | `passed_operational`     |
| Test-account lifecycle                        | Neither corrected `authorized` nor `deauthorized` processing is proven                                                           | `not_run`                |
| Automatic post-fix managed deauthorization    | Corrected exact replay passed, but no fresh automatic post-fix delivery was captured                                             | `not_run`                |
| Native Stripe App financial browser transport | Previous controlled-profile interception remains unresolved                                                                      | `BLOCKED_TOOLING`        |
| Live, Stripe review and Marketplace           | Neither authorized nor attempted                                                                                                 | `not_run_not_authorized` |

The real deauthorization payload is stronger than a fixture but remains replay evidence; it must
not be relabelled as automatic post-fix delivery. The fresh authorization is automatic and proves
the separate install path. The restore proof is revision-bound and does not transfer to changed
source. Redacted evidence:
`hosted-sandbox-4521b8c9-lifecycle-backup-restore-2026-07-30.json`, SHA-256
`f5b41ee5f192a5744fdeed762845747cfb82e3284cde6a346fc33a6b27322d5f`.

### 7.10 Canonical Compose release and scheduled maintenance — observed 2026-07-31/2026-08-01

| Gate                                     | Observed evidence                                                                                                                  | Result                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Canonical inter-revision release         | Stable launcher activated exact local revision `e4cec060...`; five services healthy, live disabled, no journal                     | `passed_operational`     |
| PostgreSQL release boundary              | One bounded container recreation; root bind and cluster system identifier preserved; historical and active-safety counts exact     | `passed_operational`     |
| Natural persistent-timer retention       | Pre-state captured; new timer-correlated invocation selected/purged zero rows and preserved ID, Created, StartedAt, DB and cluster | `passed_operational`     |
| Scheduled encrypted cold backup          | Same PostgreSQL container restarted; exact invocation and inline e4 recovery succeeded                                             | `passed_operational`     |
| Versioned backup object                  | 8,992,512 bytes, exact SHA/revision/AES-256 metadata; zero local/probe/multipart residue                                           | `passed_operational`     |
| Final runtime and financial safety       | Five healthy services, no active workflow/guard/effect job, no live tenant/install and both timers active/enabled/waiting          | `passed_operational`     |
| Exact e4 disposable restore              | First verifier failed pre-effect and cleaned; corrected path then passed on 1 August and cleaned every disposable resource         | `passed_operational`     |
| Native App financial transport/lifecycle | Prior revision-bound evidence does not transfer to e4                                                                              | `not_run`                |
| Live, Stripe review and Marketplace      | Neither authorized nor attempted                                                                                                   | `not_run_not_authorized` |

The application images were promoted through a manifest-derived artifact rather than rebuilt
natively. The e4 source commit is an ancestor of configured `origin/main`, but no exact GitHub
artifact attestation is claimed for e4. Docker's historical event buffer was incomplete, so the backup lifecycle
claim is based on its exact systemd journal plus stable container ID/creation time and a new
`StartedAt` inside the backup window, not on missing Docker events. Redacted evidence:
`scheduled-maintenance-e4cec060.local.json`, SHA-256
`f568a1cc0d09db9d7364190c135e0c3fffcbbdf2bdb857b0d0a5d15cc14e0ce9`.
The separate failed restore artifact is
`restore-e4cec060-failed-pre-effect-2026-07-31.local.json`, SHA-256
`ab6233b44cba2fc8d1970c54ea25171da8ee765f0cbd76a2dd1efe54366782db`.
It proves endpoint authentication, offline staging, fail-closed argument validation and complete
cleanup only; it does not prove archive decryption or recoverability. The separate corrected restore
then passed on 1 August 2026. Redacted evidence is
`restore-e4cec060-2026-08-01.local.json`, SHA-256
`951505c6b61ce77a4bc04645837e595e33c2b0a13543088913af4c153fc3acf3`, top-level result `PASS`.

This section is historical exact-e4 evidence only. ADR 0030 records later release attempts involving
`8da280b7...`. The ADR 0032 postflight observed `8da...` active at capture time but returned `FAIL`,
so it does not admit that release or establish later host state.
ADR 0034's rotation review ended `NO_GO_REOPENING`; a tracked successor, real Refund edge states,
App lifecycle/browser, live and commercial gates remain open.

### 7.11 Read-only host postflight — observed 2026-08-08

| Gate                              | Admissible observation                                                                                  | Result                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------- |
| Capture provenance                | Clean HEAD `74b6da5742cd032204373d24006f0396d9c5ac0c`; captured `12:37:17Z`, expired `12:52:17Z`        | `ADMISSIBLE_READ_ONLY`      |
| Overall host posture              | Top-level `FAIL`, posture `COHERENT_RUNNING`, remote code `CADDY_RUNNING`                               | `failed_operational`        |
| Revision and health               | Active `8da280b78a9d1475c7bd79063e72c5af77121e8d`; all five services healthy                            | `observed_not_release_pass` |
| Required stopped surfaces         | Worker, public Caddy, backup and retention timers were active                                           | `divergent`                 |
| Host listeners and journal        | Internal TCP 80/443 listeners, two unexpected running containers and runtime quiescence journal present | `divergent`                 |
| Exact diagnostics                 | Caddy, maintenance, listener, unexpected-containers, journal and worker diagnostics all present         | `six_fail_codes`            |
| AWS public edge                   | Lightsail ports 80/443 remained closed before and after capture                                         | `observed_closed_unchanged` |
| Live and financial safety         | Live disabled; financial snapshots stable and quiescent                                                 | `observed_quiescent`        |
| Release/recovery/reopening effect | A postflight `FAIL` cannot authorize deployment, recovery, ingress or Stripe work                       | `not_authorized`            |

Exact diagnostics are `CADDY_RUNNING`, `MAINTENANCE_ACTIVE`, `PUBLIC_LISTENER_ACTIVE`,
`UNEXPECTED_RUNNING_CONTAINER`, `UNRESOLVED_JOURNAL` and `WORKER_RUNNING`, with
`unexpectedRunningContainerCount=2`. Redacted evidence is
`sandbox-evidence.local/aws/host-postflight-20260808T123717Z-f7a9e869c50a.local.json`, SHA-256
`8a49edb18858ef207e2ad5f8c3c3c412100d24ef8788d087cfd710d301ce9ca5`. The expired artifact is
point-in-time evidence only. It does not admit `8da...`, prove complete Compose/release health or
authorize repair. Exact CI, attested bundle provenance, CloudFront origin identity, incident
admission and separate authorization remain independent gates.

### 7.12 Exact-442 contained reconciliation — failed pre-effect

| Gate               | Admissible observation                                                                                                                                                | Result                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Exact source gates | Revision `442955960d326bd0c1c6f7424e4b842566c75f92`; CI run `31267023532` and sandbox-bundle run `31267027925` passed                                                 | `passed_source_gates`          |
| Bundle provenance  | GitHub artifact `9024495857`, ZIP SHA-256 `2c29c4d8d8a7ae3dcca8ea06fd6c981c5aa104a09a3620d568b0936fb833a32`; attestation `39596414`, two subjects, Rekor `2386077969` | `passed_bundle_gate`           |
| Fresh preflight    | `FAIL`/`ADMISSIBLE_READ_ONLY`/`COHERENT_RUNNING`; same six diagnostics, AWS firewall closed and unchanged, live disabled                                              | `admitted_for_bounded_attempt` |
| Reconciliation     | Exit `20`, result `FAIL`, code `CORE_RUNTIME_INVALID`, operation `retention`                                                                                          | `failed_pre_effect`            |
| Mutation proof     | Marker absent, journal present, `resumed=false`, every current and cumulative mutation counter zero                                                                   | `zero_effect`                  |
| Control postflight | Exit `20`, same `FAIL`/`COHERENT_RUNNING` posture and six diagnostics                                                                                                 | `host_observed_unchanged`      |
| Local diagnosis    | Real Docker reports canonical `Config.AttachStdout=true` and `Config.AttachStderr=true`; the exact-442 predicate required false                                       | `implementation_defect`        |
| Next gate          | Corrected committed/published successor, new exact CI/bundle, fresh preflight, reconciliation and final independent postflight                                        | `pending`                      |

The preflight, reconciliation and control-postflight evidence SHA-256 values are, respectively,
`d43a93a8455f9653d883b01dd77c1664de6fed5f022b25a968c6e5e45ad7580d`,
`921f0b5906d558d62e4cb7f322e66b59dc9418dee9b35c96b406f96f91a2ba5c` and
`9b5862e88c5bf0a66a83027296328116ff6e8dab21dc891cda2846ccfac372c0`. The local disposable
container was network-disabled, never started and removed with its volumes, leaving zero residue.
This evidence proves neither a contained host nor a Stripe or financial gate. Exact 442 must not be
rerun; the sandbox remains `BLOCKED_RECONCILIATION` and the one-shot remains unconsumed.

## 8. Verdict procedure

All Phase 0 gates must have at least one `passed_real` case and no unresolved `failed_real`.

Decision:

```text
if every required gate passed_real:
  PASS
else if any required human prerequisite is missing:
  BLOCKED_HUMAN
else:
  FAIL
```

The Markdown report lists every gate, case ID, result and redacted artifact path. It must explicitly state that no live request was made.

## 9. Cleanup

- verify that the direct Phase-0 route, client method, UI control and runtime switch remain absent;
- remove temporary synthetic-fixture references and local helper artifacts;
- stop local webhook forwarding;
- remove temporary test objects where Stripe supports safe cleanup;
- keep only redacted evidence for the documented retention period;
- rotate a secret if it appeared in terminal capture, logs or evidence.

Successful secret separation or one operational webhook-secret change does not close the key
rotation gate. Record old-version denial, new-version success, rollback/recovery and retained-backup
dependency checks for each family before marking rotation complete.
