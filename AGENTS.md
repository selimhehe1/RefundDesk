# RefundDesk agent guide

Read `REFUNDDESK_CODEX_BUILD_SPEC.md` before changing product behavior. Read the relevant ADR and runbook before changing a financial boundary.

## Scope

- Phase 0 passed with `34/34` real Stripe cases; mocks never contributed to that verdict.
- Phase-0 `PASS` authorizes continued test/sandbox engineering only. It does not authorize live
  mode, Stripe review submission or Marketplace publication.
- The separately approved 28 July 2026 boundary authorizes the configured RefundDesk GitHub
  repository and its Actions plus the dedicated AWS test/sandbox deployment, with a total hosting
  ceiling of EUR 10 per month. It does not authorize another repository, production hosting,
  customer data, live mode or paid expansion beyond that ceiling.
- Test mode and managed sandbox only.
- Never use customer data, live keys, live webhooks or live PaymentIntents.
- Do not create another paid resource, deploy beyond the approved AWS sandbox, publish the Stripe
  App, submit it for review or push to another remote without explicit authorization.
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

```powershell
pnpm dev:platform
pnpm dev:worker
$env:REFUNDDESK_DEV_API_BASE = "https://<temporary-host>/api"
pnpm dev:stripe-app
```

The workspace uses pnpm `11.17.0`. The Stripe Apps CLI packages `apps/stripe-app` as a standalone
project, so that directory deliberately carries a separate pnpm `10.30.3` package-manager pin and
lockfile. Keep its dependencies explicit and validate both lockfiles; do not remove or merge the
standalone lock without re-running a real unpublished Stripe App upload.

The distinct external-account installation evidence remains tied to unpublished version `0.1.0`.
Version `0.1.1` was uploaded unpublished from clean commit
`100ae946ec593df1f21ba3efa6fe5c72ec366e89` with packaged artifact SHA-256
`ec5fc4940092343c9d6bd8b25948ea31272666d4e041a2ff23d36f10e27446be`, after removal of every
Phase-0 runtime surface. Upload alone does not prove that `0.1.1` was installed or rerun in the
external test account. Never transfer evidence between versions without an explicit artifact, and
never reuse an evidenced version for changed source.

The last admitted canonical hosted release is immutable test/sandbox revision
`e4cec06068d71afb5c2ac9fc04175bfdfd6756c2`. ADR 0030 records later release attempts involving
`8da280b7...`. The first admissible read-only ADR 0032 postflight from clean HEAD
`74b6da5742cd032204373d24006f0396d9c5ac0c` captured the host at `2026-08-08T12:37:17Z` with
top-level `FAIL`, admission `ADMISSIBLE_READ_ONLY` and posture `COHERENT_RUNNING`. It observed active
revision `8da280b78a9d1475c7bd79063e72c5af77121e8d`, all five services healthy, worker and Caddy
running, backup and retention timers active, internal TCP listeners on ports 80/443, two unexpected
running containers and a runtime quiescence journal. Remote code was
`CADDY_RUNNING`; `unexpectedRunningContainerCount` was `2`; exact
diagnostics were `CADDY_RUNNING`, `MAINTENANCE_ACTIVE`, `PUBLIC_LISTENER_ACTIVE`,
`UNEXPECTED_RUNNING_CONTAINER`, `UNRESOLVED_JOURNAL` and `WORKER_RUNNING`. The AWS 80/443 firewall
was closed and unchanged, live was disabled, and the financial snapshots were stable and
quiescent. Evidence is
`sandbox-evidence.local/aws/host-postflight-20260808T123717Z-f7a9e869c50a.local.json`, SHA-256
`8a49edb18858ef207e2ad5f8c3c3c412100d24ef8788d087cfd710d301ce9ca5`. It expired at
`2026-08-08T12:52:17Z`; retain it as historical point-in-time failure evidence, not proof of later
host state.

Exact candidate `442955960d326bd0c1c6f7424e4b842566c75f92` was then published to the configured
`main` and `release/sandbox-edge-2026-08-03` refs. Exact CI run `31267023532` and sandbox-bundle
run `31267027925` passed. GitHub fallback artifact `9024495857`, named
`refunddesk-sandbox-442955960d32`, has ZIP SHA-256
`2c29c4d8d8a7ae3dcca8ea06fd6c981c5aa104a09a3620d568b0936fb833a32`; attestation `39596414`
covered two subjects with Rekor entry `2386077969`. A fresh admissible preflight retained the same
`FAIL`/`COHERENT_RUNNING` posture, closed and unchanged AWS firewall, disabled live mode and exact
six diagnostics. Evidence is
`sandbox-evidence.local/aws/host-postflight-20260808T163955Z-df841d8f0701.local.json`, SHA-256
`d43a93a8455f9653d883b01dd77c1664de6fed5f022b25a968c6e5e45ad7580d`.

The single exact-442 reconciliation invocation then failed closed with exit `20`, result `FAIL`,
code `CORE_RUNTIME_INVALID` and operation `retention`. The successor marker remained absent, the
quiescence journal remained present, `resumed` was false and every current and cumulative mutation
counter was zero. Evidence is
`sandbox-evidence.local/aws/containment-reconciliation-20260808T164110Z-d5f78e9e3501.local.json`,
SHA-256 `921f0b5906d558d62e4cb7f322e66b59dc9418dee9b35c96b406f96f91a2ba5c`. The immediate
read-only control postflight returned exit `20` with the same `FAIL`/`COHERENT_RUNNING` state and
six diagnostics, proving the observed host posture unchanged. Evidence is
`sandbox-evidence.local/aws/host-postflight-20260808T164238Z-37c7a198f47f.local.json`, SHA-256
`9b5862e88c5bf0a66a83027296328116ff6e8dab21dc891cda2846ccfac372c0`.

A local real-Docker reproduction identified the implementation defect: canonical `docker create`
inspection has `Config.AttachStdout=true` and `Config.AttachStderr=true`, while the exact-442
predicate incorrectly required both fields to be false. The disposable container was never
started, had networking disabled, was removed with its volumes and left zero residue. Do not rerun
the exact-442 reconciliation. Its three artifacts remain historical `failed_pre_effect` evidence
and do not inherit the corrected successor's result.

At execution time, corrected exact successor `d096b0ea23b44090c2f7b10762002d6b2de7cb7e` had been
published to the configured `main` and `release/sandbox-edge-2026-08-03` refs. A later
documentation commit may advance those refs; the operational evidence remains bound to d096.
Exact CI run `31269541134` and sandbox-bundle run `31269550192` passed. GitHub artifact `9025216948`
has ZIP SHA-256
`f17f7b074c11a3283d7f9fb06ab446825ef7492351463a1f21defb57fa5b2b2a`; attestation `39599897`
covered two subjects with Rekor entry `2386447207`.

The fresh initial postflight
`sandbox-evidence.local/aws/host-postflight-20260808T180616Z-fc8d1e3837e6.local.json`, SHA-256
`a9665dc7c49866fd87569d9cdd952279057c35cb913e3f7aa229fc6f02888430`, observed
`FAIL`/`COHERENT_RUNNING` and was valid from `2026-08-08T18:06:16Z` through
`2026-08-08T18:21:16Z`. The single exact-d096 reconciliation then returned
`PASS`/`PASS_CONTAINED_JOURNAL_CLEARED` for operation `retention`, advanced the successor marker to
`complete`, cleared the quiescence journal and left every containment and financial assertion true.
Its counters were restart fences `2`, stopped containers `2`, journal clears `1`, marker
transitions `4`, reservation reconciliations `0` and stopped units `5`. Evidence is
`sandbox-evidence.local/aws/containment-reconciliation-20260808T180631Z-84a498eb6859.local.json`,
SHA-256 `c5c69f4339c242f2ff7bb6b9d80c0422199d20bb79d93738d0e12f154b399d63`.

The immediate final postflight
`sandbox-evidence.local/aws/host-postflight-20260808T180724Z-40c305db3399.local.json`, SHA-256
`532b56318fcf30234e43e068da72577135ed45c12712b430af6e6575ab83ac2e`, returned
`PASS`/`COHERENT_CONTAINED`/`PASS_CONTAINED` with zero diagnostics. The AWS firewall remained closed
and unchanged, live remained disabled, worker, Caddy, maintenance units and TCP/UDP 80/443
listeners were stopped, journals and the runtime fence were closed, and the financial snapshots
were stable and quiescent. It was valid from `2026-08-08T18:07:24Z` through
`2026-08-08T18:22:24Z` and is point-in-time evidence only. The exact-d096 one-shot and its harness
are consumed and must never be executed or resumed. Preserve the durable `complete` successor
marker and never remove it. This closes only the exact-8da containment repair. Exact-e4 remains the
last admitted canonical release, and no release, ingress reopening, service restart, Stripe action,
live mode or financial proof is authorized.

ADR 0036 now defines and implements locally the only new admission path for the current replacement
managed-sandbox read/effect bindings and Stripe App signing secret. Its production wrapper requires
an exact contained-candidate promotion, a fresh post-promotion ADR 0034 postflight, a fresh strict
human Dashboard attestation and an access-restricted synthetic fixture. The contained worker mode
serves only `refunddesk_refund_execute`, with schedules, supervision, startup recovery and signed
routes disabled, and must finish stopped/fenced. The local fake-host and wrapper contracts pass,
including deterministic same-idempotency-key resume and exact final post-incident/candidate joins.
No human Dashboard handoff, AWS/SSH transport or Stripe call was performed, however, and no real
`PASS_INCIDENT_ADMITTED_CONTAINED` artifact exists. Do not invoke the production path without new
explicit authorization and operator inputs. Local fixtures do not close the incident or authorize
release, ingress, restart, live mode or any later reopening decision; consult ADR 0036 and the
operations runbook before touching this boundary.

ADR 0037 locally implements the only future successor to ADR 0029's unadmitted edge window. It
requires one exact contained promotion, a real fresh exit-`0` ADR 0036 capture with its exact final
ADR 0034 bytes, and a separate canonical human authorization. Its exact-revision non-root operator
image is supplied as five independently hashed workflow artifacts and never mounts the caller
repository or Docker socket. The state machine binds the authorized CloudFront origin to a
transient Caddy token, opens only bounded CloudFront-origin TCP 443 ingress, uses a host-held lease
and same-boot watchdog, then requires AWS closure, origin restoration, token removal and a new
official contained postflight. An absolute 35-minute deadline from durable `operationStartedAt`
caps every new effect, call timeout and PASS; the watchdog uses the earliest authorization,
operation or armed-window deadline, and cleanup after a deadline can only contain and return `21`.
Only statuses `0`, `20`, `21` and `64` have defined meanings; an ambiguous attempt retains its exact
immutable-input and writable-state volumes for same-nonce cleanup and never authorizes another
window.

That implementation is incomplete and its local contracts do not pass. On 10 August 2026 the Linux
edge contract returned 160 passing and 69 failing of 229 scenarios, measured as an unprivileged user
on a native Linux filesystem, and the production-path PowerShell contract did not terminate on the
Windows workstation. A boot-time clock layer —
`operatorControlCalculatedMonotonicMilliseconds`, `runnerBootIdentifierSha256`,
`runnerStartedBoottimeMilliseconds` and `runnerDeadlineBoottimeMilliseconds` — had reached the
canonical schema and the Linux state machine but not the validator, its test, the edge contract or
ADR 0037. The validator, its test, the contract control document and ADR 0037 were completed on the
same date; the remaining edge-contract failures are unresolved. Running that contract on Windows is
not a check: it skips 216 of 229 scenarios and still exits `0`. No hash is frozen for ADR 0037 and
`PENDING_FINAL_LOCAL_GEL` is not satisfied.

This implementation has not run against AWS, SSH, CloudFront, Stripe, Workbench or a public
endpoint. No real `PASS_EDGE_WINDOW_RECONTAINED` exists; do not invoke it without new explicit
authority and all exact operator inputs. Local contracts authorize no release, restart, ingress,
live mode or reopening decision. Consult ADR 0037 and the operations runbook before touching this
boundary.

The historical e4 release passed with five healthy services, closed journals,
active timers and live disabled. The release performed one
bounded PostgreSQL container recreation because the canonical Compose project path changed, while
preserving the PostgreSQL system identifier and every financial/audit count. A later scheduled
retention invocation and scheduled cold backup both passed through the exact e4 Compose path; the
backup stopped and restarted the same PostgreSQL container, uploaded one verified encrypted
versioned object, recovered all five services and left no maintenance journal or local archive.
The first exact-e4 disposable restore attempt failed closed during input validation because a
Windows PowerShell native-pipeline carriage return made the final SHA-256 argument 65 bytes.
Decryption and containers never started, and remote plus independent AWS cleanup found zero
residue. This remains the distinct historical `FAIL_PRE_EFFECT_CLEANED`, not restore evidence.
The corrected one-shot path then restored the exact e4 archive successfully on 1 August 2026 and
cleaned every disposable resource. Redacted evidence is
`sandbox-evidence.local/aws/restore-e4cec060-2026-08-01.local.json`, SHA-256
`951505c6b61ce77a4bc04645837e595e33c2b0a13543088913af4c153fc3acf3`, with top-level result
`PASS`. The e4 commit is an ancestor of the configured `origin/main`; no exact GitHub artifact
attestation is claimed for e4. Do not repeat the restore or create a second paid verifier without
new authorization.

Before that admissible capture, the production wrapper failed closed on an unsafe inherited ACL for
the default AWS credential file. Explicitly authorized ACL remediation changed only access control
and never read credential bytes. Ignored evidence is
`sandbox-evidence.local/aws/aws-credentials-acl-remediation-2026-08-08.local.json`, SHA-256
`0ba446b4de31b56876744219269900f65c584c754e3b6714c0358eb48bd9e2b1`. The Windows child-process
HOME isolation correction is revision `a96ce03...`; captured HEAD `74b6da5...` corrects only the
OpenSSH child environment (`HOME`, `USERPROFILE`, `PROGRAMDATA` plus guards). Source provenance had
already been hardened. Their relevant contracts passed before capture.

On 1 August 2026 the then-current Stripe App signing secret was exposed in local diagnostic output after
an ignored legacy configuration file was included in a broad search. Treat that secret as
compromised and never reuse or retest its raw value. ADR 0024 records that the exact-e4 contained
transition completed on 3 August 2026 with `PASS_CONTAINED`. Under ADR 0019's admission contract,
that outcome asserts Dashboard revocation/activity admission and proof of only the replacement App
signing, managed-sandbox read and managed-sandbox effect credentials. The final proof was cleaned by
design and is not independently retrievable. ADR 0034 records that two independent static reviews
of the nine corrected execution artifacts concluded `NO_GO_REOPENING`; this does not relabel the
historical outcome, but it prevents those artifacts from admitting it or supporting a reopening.
The 1 August incident JSON remains an initial `IN_PROGRESS_CONTAINED` record, not the final proof.
The normative containment requirement and last admitted incident record have public Caddy, the
worker, backup and retention timers and Lightsail ports 80/443 stopped, with live disabled. The
admissible 8 August postflight proved that the captured host service posture violated those
requirements while the AWS edge, live interlocks and financial state remained closed/quiescent.
ADR 0029 records a later bounded public window, but ADR 0031 classifies its generic CloudFront
allowlist as non-authenticating and the window as unadmitted hosted evidence. The exact-442
reconciliation failure and its control postflight remain historical `failed_pre_effect` evidence.
The exact-d096 successor later restored the required contained posture at its final postflight, but
that short-lived result authorizes no reopening or restart. Do not restore or change any surface
without a new tracked successor where required and a separate decision.

Later on 1 August 2026, the operator pasted one managed-sandbox restricted read key, one
managed-sandbox restricted effect key and one full-access test secret into the conversation. Treat
all three secret API credentials as compromised. The publishable test key shown with them is not a
secret, but must not be mistaken for a server credential. The worker was stopped immediately and
remains required to be stopped. Both the first admissible 8 August postflight and the exact-442
control postflight observed it running; the final exact-d096 postflight later observed it stopped.
That final capture is point-in-time only, so do not infer later state from it. Redacted evidence is
`sandbox-evidence.local/aws/stripe-api-key-chat-exposure-2026-08-01.local.json`. Do not use, test,
copy into tooling or redeploy any exposed value. ADR 0024 records a `PASS_CONTAINED` outcome under
the ADR 0019 admission contract, which required Dashboard revocation/activity review and real
least-privilege proof of the replacement managed-sandbox read/effect bindings. The final proof was
cleaned by design, and ADR 0034's independent review ended `NO_GO_REOPENING`, so ADR 0024 is not
standalone retained evidence of those details. The 1 August JSON remains an initial
`IN_PROGRESS_CONTAINED` record. Worker, Caddy, timers and public financial proofs are required to
stay stopped; the exact-d096 containment pass does not authorize a restart.

An unintended `stripe apps list` later launched Stripe CLI authentication against the pinned
platform test account and created one platform-test and one platform-live CLI key. Local logout
completed and no local secret was retained. ADR 0024's recorded `PASS_CONTAINED` outcome implies
the ADR 0019 admission contract for Dashboard deletion and activity review; its cleaned final proof
is not independently retrievable, and ADR 0034's static review is `NO_GO_REOPENING`. Redacted
initial evidence is
`sandbox-evidence.local/stripe-cli-unintended-auth-2026-08-01.local.json`, SHA-256
`d51f557fd8f76af871d4a5019eac8e00e4ed465ed487afd05ac6750877ac9da7`. Do not run an
authentication-capable Stripe CLI command during incident preparation.

Before the transition, replacement managed-sandbox read/effect candidates were saved only in ignored local input
files and passed a real read-only preflight: exact account/test binding, distinct old/new/read/effect
fingerprints, required PaymentIntent/Charge reads, unrelated Customer denial, and a decisive
`403 more_permissions_required` for `refunds.create` with the known fully refunded Phase-0 fixture;
the Refund set remained unchanged. Evidence is
`sandbox-evidence.local/managed-sandbox-rotation-candidates-2026-08-01.local.json`, SHA-256
`ec07ef8b14fee601f7339bf8a3837dee0ba3817601fa8330486e758eab10e606`. That preflight alone did not
prove the effect credential; ADR 0024 records the later bounded real Refund proof.

ADR 0019 defines the one-time exact-e4 transition; ADR 0024 records its completed execution on
3 August 2026. The final recorded proof hash is
`39e9351c387c1bc6316cdc23f507ddc9f073899b4863a1f09d4c0c5621fe7706`, but its fixed proof file was
removed during the designed final cleanup. Do not substitute either 1 August incident JSON as that
final proof. Execution exposed eleven defects and required corrections to nine artifacts; ADR 0034
records two independent static reviews and a chain-level `NO_GO_REOPENING`. The one-time helper is
consumed and must not be installed, resumed or executed again. Preserve containment until a new
tracked successor where required and a separate reopening decision; no evidence or authorization
transfers to a later revision.

Unpublished Stripe App `0.1.3` was uploaded from clean commit
`c241a097fc5f4b8e8eaa2f057f9c7db40d9dffa3`, observed installed in a distinct test sandbox and
reauthorized for the stable hosted origin. The exact UI-generated request bytes and Stripe
signature were observed relayed unchanged to the then-current `42a1e4e...` backend and verified
with HTTP 200. Raw capture was intentionally destroyed, so the installation and relay are not
reproducible from the redacted artifact alone. A normal direct browser-profile delivery remains
`BLOCKED_TOOLING`; do not report a native browser end-to-end pass or a hosted financial effect
from that evidence.

Unpublished Stripe App `0.1.4` was uploaded from clean commit
`71bbd98fa1e5d9989f92fba9310c200e7cf63d4f`, then freshly installed through Stripe's official
external-test flow in the distinct managed sandbox. Its automatic
`account.application.authorized` delivery passed on `4521b8c9...` and a manual replay was
deduplicated. This is fresh-install and lifecycle evidence only; it does not close the normal
financial direct-browser gate.

The real direct-account Refund webhook gate remains version-bound to `42a1e4e...`. Disposable
backup/restore passed separately for `42a1e4e...`, `71bbd98...`, `4521b8c9...` and exact revision
e4. An exact replay
of a real managed-sandbox `account.application.deauthorized` Event passed on `4521b8c9...`, then
the fresh `0.1.4` installation above restored one clean active installation; all lifecycle
observations produced zero financial effects. Test-account lifecycle, an automatic post-fix
managed-sandbox deauthorization and native financial browser delivery remain open. ADR 0024 closes
only the exact-e4 managed-sandbox read/effect and App-signing incident transition; ADR 0034's
independent review is `NO_GO_REOPENING`, and all other rotation families remain open.

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

The Lightsail operator contracts under `deploy/lightsail/*-contract.test.mjs` only yield a valid
measurement **on Linux, as an unprivileged user**. They assert file modes, ownership and access
refusals, and `root` traverses those refusals, so a privileged run reports failures that do not
exist. On 10 August 2026 the same bytes of the edge contract returned 39 of 229 as root and 160 as
an unprivileged user; the incident-admission contract returned 6 of 65 as root and 64 of 65 with one
skip unprivileged. On Windows they measure almost nothing: `linuxContractAvailable` is false and a
full `pnpm container:check` reported 248 passing, 0 failing and **239 of 487 scenarios skipped**,
exiting `0`. Roughly half the operator suite does not run there, which is how a broken
implementation passed the only gate wired to it. Always record the platform, the user and the skip count beside any count —
a bare number is not evidence. A local Linux container is sufficient:

```bash
docker run --rm -v "$PWD:/mnt/src:ro" node:24.18.0-bookworm bash -c \
  'apt-get update -qq && apt-get install -y -qq jq python3 >/dev/null \
   && mkdir /work && tar -C /mnt/src --exclude=node_modules --exclude=.git -cf - . | tar -C /work -xf - \
   && chown -R node:node /work \
   && su node -s /bin/bash -c "cd /work && node --test deploy/lightsail/edge-window-contract.test.mjs"'
```

`pnpm test:integration` is fail-closed without `REFUNDDESK_TEST_DATABASE_URL`. The URL must target a
disposable PostgreSQL 18 control database whose local test owner can create/drop the suite's
strictly named ephemeral databases. The current passing run executes all 29 cases and leaves no generated
database or `refunddesk_integration_*_probe` role behind.

Validate the exact standalone extension graph with:

```bash
corepack pnpm@10.30.3 --dir apps/stripe-app install --frozen-lockfile --ignore-workspace --ignore-scripts
corepack pnpm@10.30.3 --dir apps/stripe-app --ignore-workspace run lint
corepack pnpm@10.30.3 --dir apps/stripe-app --ignore-workspace run build
corepack pnpm@10.30.3 --dir apps/stripe-app --ignore-workspace run test
corepack pnpm@10.30.3 --dir apps/stripe-app --ignore-workspace audit --prod --audit-level high
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
