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
`8da280b7...`, but no admitted redacted postflight resolves whether any attempt committed. Treat the
host state as `HOST_STATE_INDETERMINATE_POSTFLIGHT_REQUIRED` under ADR 0032 and perform no release, recovery,
ingress reopening or financial proof until that postflight is reviewed. Two read-only pre-commit
diagnostics on 8 August observed revision `8da280b7...`, worker, Caddy and both maintenance timers
active, internal TCP listeners on ports 80/443 and a runtime quiescence journal. They also observed
the AWS 80/443 firewall closed and unchanged, live disabled and the financial state quiescent. The
diagnostics used pre-final tooling and are not an admissible ADR 0032 postflight; the final
committed-HEAD capture remains pending. The historical e4 release passed with five healthy services,
closed journals, active timers and live disabled. The release performed one
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
preliminary 8 August diagnostics observed that the host service posture violated those requirements
while the AWS edge, live interlocks and financial state remained closed/quiescent; they are not a
final admitted current-state record. ADR 0029 records a later bounded public window, but ADR 0031 classifies its generic
CloudFront allowlist as non-authenticating and the window as unadmitted hosted evidence. Do not
restore any surface before the ADR 0032 postflight, a new tracked successor for any future
transition, and a separate reopening decision.

Later on 1 August 2026, the operator pasted one managed-sandbox restricted read key, one
managed-sandbox restricted effect key and one full-access test secret into the conversation. Treat
all three secret API credentials as compromised. The publishable test key shown with them is not a
secret, but must not be mistaken for a server credential. The worker was stopped immediately and
remains required to be stopped; the preliminary 8 August diagnostics observed it running, so do
not report that requirement as currently satisfied. Redacted evidence is
`sandbox-evidence.local/aws/stripe-api-key-chat-exposure-2026-08-01.local.json`. Do not use, test,
copy into tooling or redeploy any exposed value. ADR 0024 records a `PASS_CONTAINED` outcome under
the ADR 0019 admission contract, which required Dashboard revocation/activity review and real
least-privilege proof of the replacement managed-sandbox read/effect bindings. The final proof was
cleaned by design, and ADR 0034's independent review ended `NO_GO_REOPENING`, so ADR 0024 is not
standalone retained evidence of those details. The 1 August JSON remains an initial
`IN_PROGRESS_CONTAINED` record. Worker, Caddy, timers and public financial proofs are required to
stay stopped until the final committed-source current-host postflight and a separate reopening
decision; a diagnostic observation of divergence does not relax that requirement.

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
tracked successor, the current-host postflight and a separate reopening decision; no evidence or
authorization transfers to a later revision.

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
