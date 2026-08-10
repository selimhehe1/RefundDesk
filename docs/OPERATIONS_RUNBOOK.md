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
`refunddesk_web_login`, `refunddesk_worker_login` and `refunddesk_queue_login`
users; `db:local:roles` is an idempotent repair step for pre-existing local
volumes and refuses non-local targets. Prisma and pg-boss migrations use
`DATABASE_MIGRATION_URL`.
Application runtime grants are applied after Prisma, and pg-boss runtime grants
are applied after the owner migration. Do not start the web or worker with the
owner credential.

External-alert INSERT rights are intentionally column-scoped. The repository uses a parameterized
INSERT listing only those allowed columns so PostgreSQL, not runtime code, owns `id`, `status`,
acknowledgement and reconciliation defaults. If this path returns `42501`, verify the generated SQL
and current grants; never repair it by granting table-wide INSERT or lifecycle-column writes.

Pilot queues use pg-boss' non-partitioned default. The dedicated queue login has DML and
function execution in the `pgboss` schema, but no schema `CREATE` privilege. The worker login has
no `pgboss` access, while the queue login has no access to application tables.
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
local manifest from `stripe-app.json`, points only the development build at the configured API
origin and keeps live mode off. It removes the generated manifest and `.build` output when the CLI
exits. No direct Phase-0 probe route, client call or UI control exists. DNS classification is a
startup snapshot, not a defense against later rebinding; use only a short-lived
operator-controlled tunnel hostname. The temporary HTTPS path is for a short evidence window only;
stop it after use. A human must grant the Dashboard's browser prompt for local-network access so
Stripe can load the CLI-served extension bundle.

If the tunnel forwards the complete local Next.js origin, `/`, `/api/health` and `/api/ready` are
also publicly reachable for that window without a Stripe signature. They expose no tenant data,
but readiness performs a database probe. Prefer a path-restricted proxy where available; otherwise
keep the window short, monitor the local process and stop the tunnel immediately after collecting
the evidence.

Webhook forwarding is environment-specific. Start only the test or sandbox listener being exercised and map it to the matching endpoint/secret. Never forward a live endpoint in this cycle.

The opt-in `pnpm test:sandbox` harness is more invasive than ordinary local tests because PostgreSQL
roles are cluster-global. Run it only against a dedicated disposable loopback PostgreSQL 18 cluster
whose control database is the only connectable non-template database. It requires the exact
`REFUNDDESK_SANDBOX_E2E_DISPOSABLE_POSTGRES_CLUSTER` consent documented in the README, takes an
exclusive advisory lock and fails closed on a shared cluster. Never set that consent for the normal
development database or a hosted/shared service.

`pnpm test:integration` requires `REFUNDDESK_TEST_DATABASE_URL` and fails if it is absent; skipped
integration cases are never a passing gate. Point it only at a PostgreSQL 18 control database whose
local test owner may create and drop databases. Each integration suite creates an exact
allowlisted ephemeral database, applies migration files outside the rollback-only fixture
transaction, then removes the database. Verify that no `refunddesk_security_*`,
`refunddesk_concurrency_*` database or `refunddesk_integration_*_probe` role remains after a run.

## 2A. Hosted sandbox release and current boundary

The configured RefundDesk GitHub repository/Actions and the dedicated AWS test/sandbox topology are
separately authorized under a total ceiling of EUR 10 per month. This does not authorize live mode,
customer data, another repository, production hosting, Stripe review or Marketplace publication.
Check cost before every temporary resource because an AWS Budget alert is not a hard cap.

Exact-e4 is the last admitted canonical hosted release, but ADR 0030 records later release attempts
involving `8da280b7...`. The clean-HEAD ADR 0032 postflight captured the host at
`2026-08-08T12:37:17Z` with top-level `FAIL`, admission `ADMISSIBLE_READ_ONLY`, posture
`COHERENT_RUNNING` and remote code `CADDY_RUNNING`. It observed active revision
`8da280b78a9d1475c7bd79063e72c5af77121e8d`, all five services healthy, worker and public Caddy
running, backup and retention timers active, internal TCP listeners on ports 80/443, two unexpected
running containers (`unexpectedRunningContainerCount=2`) and a runtime quiescence journal. Exact
diagnostics were `CADDY_RUNNING`,
`MAINTENANCE_ACTIVE`, `PUBLIC_LISTENER_ACTIVE`, `UNEXPECTED_RUNNING_CONTAINER`,
`UNRESOLVED_JOURNAL` and `WORKER_RUNNING`. The AWS 80/443 firewall stayed closed and unchanged,
both live interlocks were false and the financial snapshots were stable and quiescent.

The redacted ignored artifact is
`sandbox-evidence.local/aws/host-postflight-20260808T123717Z-f7a9e869c50a.local.json`, SHA-256
`8a49edb18858ef207e2ad5f8c3c3c412100d24ef8788d087cfd710d301ce9ca5`. It was captured from HEAD
`74b6da5742cd032204373d24006f0396d9c5ac0c` and expired at `2026-08-08T12:52:17Z`. Treat it as an
historical point-in-time containment failure, not proof of later host state or permission to
repair.

Exact candidate `442955960d326bd0c1c6f7424e4b842566c75f92` later passed exact CI run
`31267023532` and sandbox-bundle run `31267027925`. GitHub fallback artifact `9024495857`, named
`refunddesk-sandbox-442955960d32`, has ZIP SHA-256
`2c29c4d8d8a7ae3dcca8ea06fd6c981c5aa104a09a3620d568b0936fb833a32`; attestation `39596414`
covers two subjects with Rekor entry `2386077969`. A fresh preflight remained
`FAIL`/`COHERENT_RUNNING`, with the same six diagnostics, closed and unchanged AWS firewall and
disabled live mode. Its redacted evidence has SHA-256
`d43a93a8455f9653d883b01dd77c1664de6fed5f022b25a968c6e5e45ad7580d`.

The one exact-442 reconciliation invocation returned exit `20`, result `FAIL`, code
`CORE_RUNTIME_INVALID` and operation `retention` before any effect. The successor marker remained
absent, the quiescence journal remained present, `resumed` was false and all current and cumulative
mutation counters were zero. Its redacted evidence has SHA-256
`921f0b5906d558d62e4cb7f322e66b59dc9418dee9b35c96b406f96f91a2ba5c`. The immediate
read-only control postflight returned the same `FAIL`/`COHERENT_RUNNING` posture and six diagnostics,
proving the observed host state unchanged; its evidence has SHA-256
`9b5862e88c5bf0a66a83027296328116ff6e8dab21dc891cda2846ccfac372c0`.

Local reproduction with real Docker established that canonical `docker create` inspection has
`Config.AttachStdout=true` and `Config.AttachStderr=true`; the exact-442 predicate incorrectly
required both fields to be false. The disposable container was never started, used no network and
was removed with its volumes, leaving no residue. Never rerun the exact-442 implementation and
never alter the stopped reservation to fit its defective predicate. Its three artifacts remain
historical `failed_pre_effect` evidence.

Corrected exact successor `d096b0ea23b44090c2f7b10762002d6b2de7cb7e` passed CI run
`31269541134` and sandbox-bundle run `31269550192`. Artifact `9025216948` has ZIP SHA-256
`f17f7b074c11a3283d7f9fb06ab446825ef7492351463a1f21defb57fa5b2b2a`; attestation `39599897`
covers two subjects with Rekor entry `2386447207`.

Fresh initial postflight `host-postflight-20260808T180616Z-fc8d1e3837e6.local.json`, SHA-256
`a9665dc7c49866fd87569d9cdd952279057c35cb913e3f7aa229fc6f02888430`, observed
`FAIL/COHERENT_RUNNING` and was valid from `2026-08-08T18:06:16Z` through
`2026-08-08T18:21:16Z`. Reconciliation
`containment-reconciliation-20260808T180631Z-84a498eb6859.local.json`, SHA-256
`c5c69f4339c242f2ff7bb6b9d80c0422199d20bb79d93738d0e12f154b399d63`, returned
`PASS/PASS_CONTAINED_JOURNAL_CLEARED` for `retention`. It advanced the successor marker to
`complete`, cleared the journal and kept every containment and financial assertion true. Exact
counters were restart fences `2`, stopped containers `2`, journal clears `1`, marker transitions
`4`, reservation reconciliations `0` and stopped units `5`.

Immediate final postflight `host-postflight-20260808T180724Z-40c305db3399.local.json`, SHA-256
`532b56318fcf30234e43e068da72577135ed45c12712b430af6e6575ab83ac2e`, returned
`PASS/COHERENT_CONTAINED/PASS_CONTAINED` with zero diagnostics. The AWS firewall remained closed and
unchanged, live remained disabled, worker, Caddy, maintenance units and TCP/UDP 80/443 listeners
were stopped, journals and the runtime fence were closed, and financial snapshots were stable and
quiescent. It was valid from `2026-08-08T18:07:24Z` through `2026-08-08T18:22:24Z` and is
point-in-time evidence only.

The exact-d096 one-shot and reviewed local harness are consumed. The harness SHA-256 is
`358b687a0fc44b7afe2d734097578bafc574d7d7a297d47732b5d2ad96a8633b`; its durable
`CreateNew` attempt marker exists and must never be removed. Preserve the separate remote
`complete` successor marker. Never execute or resume the one-shot or harness. This closes only the
exact-8da containment repair. Exact-e4 remains the last
admitted canonical release. Do not release, recover or restart containers, reopen ingress, call
Stripe, enable live mode or run a financial proof.

The first production invocation had failed closed before AWS/SSH on the default credential file's
inherited ACL. Explicitly approved remediation restricted only that ACL and did not read credential
bytes. Ignored evidence is
`sandbox-evidence.local/aws/aws-credentials-acl-remediation-2026-08-08.local.json`, SHA-256
`0ba446b4de31b56876744219269900f65c584c754e3b6714c0358eb48bd9e2b1`. Revision `a96ce03...`
corrected isolated HOME propagation; captured HEAD `74b6da5...` corrected only the OpenSSH child
environment (`HOME`, `USERPROFILE`, `PROGRAMDATA` plus guards). Source provenance had already been
hardened. The relevant contracts, 38 Linux observer cases and `shellcheck` passed.

### ADR 0036 current-binding admission — implemented locally, not executed

ADR 0036 replaces the consumed exact-e4 credential proof as the only tracked way to admit the
current managed-sandbox read key, managed-sandbox effect key and Stripe App signing secret. The
implementation is complete and locally verified, but **no production wrapper invocation, AWS/SSH
transport, Dashboard handoff or Stripe request has been made**. There is no
`PASS_INCIDENT_ADMITTED_CONTAINED` artifact, so this section authorizes neither incident closure nor
reopening.

Do not run the production command until a separately authorized operator has prepared all four
ignored, access-restricted inputs and approved the exact candidate. From a clean committed `HEAD`,
the only production entry point is:

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File `
  .\scripts\invoke-lightsail-incident-admission.ps1 `
  -PromotionEvidencePath <contained-promotion-capture.local.json> `
  -PreflightEvidencePath <fresh-post-promotion-adr0034-postflight.local.json> `
  -DashboardAttestationPath <fresh-redacted-dashboard-attestation.local.json> `
  -FixtureInputPath <root-or-operator-only-synthetic-fixture.local.json> `
  -ExpectedSshCidr "<current-operator-public-ipv4>/32"
```

The operator must obtain the Dashboard facts manually. The attestation is canonical redacted JSON,
is at most 15 minutes old, no more than two minutes in the future and has at least 720 seconds
remaining. It must prove revocation/expiry of the four exposed credentials, deletion of the two
unintended CLI keys, reviewed activity, the exact restricted permission projections, disabled
predecessor signing secret and distinct current fingerprints. Never put a raw secret, full Stripe
object ID, signature or payload in the attestation. The synthetic fixture is also canonical and
access-restricted; it fixes the only effect to `amountMinor="1"`, `currency="eur"`, a known fully
refunded denial target, one fresh refundable target and two distinct test users.

The promotion input must be a canonical `PASS_CONTAINED_CANDIDATE_PROMOTED` capture for the exact
revision, source, manifest, bundle and provenance. The ADR 0034 input must be captured after that
promotion, bind the same revision and `incident_admission` worker mode, report
`PASS/COHERENT_CONTAINED/PASS_CONTAINED`, retain at least 720 seconds and show the AWS firewall
closed and unchanged. Inputs, sources, tools, Git objects and their open handles are pinned and
revalidated; do not replace this command with ad-hoc SCP, SSH or a copied remote stage.

During a real authorized invocation, only the exact promoted worker may start, privately, after a
durable watchdog is armed. `REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission` disables schedules,
supervision, LISTEN/NOTIFY, startup scanning/recovery, every queue except
`refunddesk_refund_execute`, and the signed authority/routes. Caddy, maintenance timers, ports
80/443 and live mode remain off. The worker is stopped and fenced before any terminal document. A
future standard release must recreate it in `normal` mode; incident mode is never a steady-state
runtime.

Interpret the local process status and create-new capture together:

- `0`: exact `PASS/PASS_INCIDENT_ADMITTED_CONTAINED`; the remote marker is `complete`, exactly one
  workflow and one Refund are durably accounted for, and a new independent final ADR 0034
  postflight remains fresh and contained;
- `20`: complete fail-closed observation, including `NEW_ROTATION_REQUIRED`; do not resume it as a
  credential repair and never restore an exposed predecessor;
- `21`: incomplete or ambiguous; preserve every input and durable marker, then resume only the same
  operation and deterministic Stripe idempotency key with fresh time-bounded evidence;
- `1` locally or `64` remotely: usage, provenance, transport or artifact failure; no admissible
  incident evidence exists.

A late replay of `proof_observed`, `contained_verified` or `complete` must not start the worker or
call Stripe. It revalidates the persisted proof and containment only. Mutation counters are the
cumulative history of the operation, so a successful complete-marker replay still reports the
original one worker start, one workflow and one Refund without repeating them.

The local capture is usable only while its Dashboard and final-postflight window remains valid. It
binds the exact final ADR 0034 bytes and times, the post-incident eight-counter financial baseline,
and `finalPostflight.candidateBinding`: SHA-256 digests of the promotion's PostgreSQL system
identifier and five runtime container IDs. A later consumer must independently validate those
exact final-postflight bytes and equality with the outer and remote baselines; the pre-incident
postflight and promotion snapshot are historical provenance, not reopening input. Even an exact
exit-`0` capture closes only this three-binding incident for its revision. It does not by itself
admit a release or authorize ingress, worker/timer restart, live mode, App publication or any later
reopening decision.

### ADR 0037 bounded CloudFront origin window — incomplete, do not execute

> **The ADR 0037 implementation is not frozen.** Measured on 10 August 2026 as an unprivileged user
> on a native Linux filesystem, the edge contract returns 229 of 229 passing, zero skipped, up from
> 160 before four defects were repaired. The production-path PowerShell contract still does not
> terminate on the Windows workstation, so no hash is frozen. **Do not follow the procedure below**;
> running it would consume operator inputs and a bounded public window against a wrapper whose own
> Windows contract has never completed once.
>
> Three traps make this easy to miss. Running the edge contract on Windows is not a check —
> `linuxContractAvailable` is false there, 216 of 229 scenarios skip and the suite exits `0`, so
> `pnpm container:check` passes in full while the implementation is broken. Running it as `root` is
> not a check either — these contracts assert access refusals that root traverses, and the same
> bytes return 39 of 229 privileged against 160 unprivileged. And they have never run in continuous
> integration: their `container:check` entries are additions in an uncommitted `package.json`, so no
> Linux runner has ever seen them.

ADR 0037 defines the only tracked successor to ADR 0029 for a future, separately authorized edge
window. It orders an exact contained promotion, a real exit-`0` ADR 0036 incident admission and a
new human authorization before a maximum 300-second CloudFront-to-Caddy observation. The
implementation exists locally, but **no ADR 0037 production wrapper, AWS,
SSH, CloudFront, Stripe or public request was run while building it**. No real
`PASS_EDGE_WINDOW_RECONTAINED` artifact exists, and this section is preparation rather than
execution authority or a reopening decision.

The operator image is a separate exact-revision artifact produced by the successful
`sandbox-images` workflow. Acquire the following **exact five files** from that one workflow run,
either from its one-day GitHub fallback artifact or from the approved private bucket prefix
`refunddesk-sandbox/edge-operator/<revision>/`:

1. `refunddesk-edge-operator-<revision>.docker.tar.zst`;
2. `refunddesk-edge-operator-<revision>.docker.tar.zst.sha256`;
3. `refunddesk-edge-operator-<revision>.manifest.json`;
4. `refunddesk-edge-operator-<revision>.attestation.jsonl`;
5. `refunddesk-edge-operator-<revision>.provenance.json`.

Stage exactly those five regular files in an ignored, access-restricted local directory. Preserve
the attested archive basename byte-for-byte: do not rename, recompress, normalize or regenerate any
member. If the GitHub fallback ZIP is used, extract its `edge-operator` members; the ZIP itself is
not the operator archive. Reject an extra, missing or duplicate member. Record an independently
computed SHA-256 for each file. The sidecar has its own SHA-256 and its exact UTF-8 bytes must be
`<archive-sha256><two spaces><archive-basename><LF>`. Protect the staging directory and every other
input from inherited access; only the current operator, local Administrators and `SYSTEM` may have
full control. The wrapper reopens each regular file with that protected ACL, retains its handle and
compares all five out-of-band hashes before loading the image.

There is no tracked authorization generator. A separately authorized human must prepare the
authorization as UTF-8 without BOM: one compact, recursively key-sorted JSON object followed by
one LF, with exactly these keys and JSON types:

```text
{"awsAccountId":"633229204288","awsRegion":"eu-west-3","code":"PASS_EDGE_WINDOW_AUTHORIZED","distributionId":"<exact-distribution-id>","eventFingerprintSha256":"<64-lowercase-hex>","expectedRevision":"<40-lowercase-hex>","expectedSshCidr":"<operator-ipv4>/32","instanceName":"refunddesk-sandbox-paris","kind":"refunddesk.edge-window.authorization","maxWindowSeconds":300,"originId":"<exact-origin-id>","publicBaseUrl":"https://<authorized-host>","result":"PASS","schemaVersion":1,"sourceRef":"refs/heads/main","sshHost":"<exact-lightsail-host>","validFrom":"<UTC-second>","validUntil":"<UTC-second>"}
```

`schemaVersion` and `maxWindowSeconds` are integers. `sourceRef` may instead be the exact permitted
`refs/heads/release/sandbox-edge-YYYY-MM-DD`. The authorization interval is at most two hours,
begins no later than the first durable operation start and covers both the armed public deadline
and the full 35-minute orchestration bound. Its exact SSH `/32`, revision, event fingerprint,
account, region, instance, distribution, origin, public URL and maximum window are independent
human assertions; do not derive them from configuration or a prior proof. Store the document under
the same restricted ACL and compute its SHA-256 out of band.

At the initial durable edge `operationStartedAt`, both the real ADR 0036 incident capture and the
exact final ADR 0034 postflight embedded by that capture must have between 720 and 900 seconds
remaining, inclusive. Their ordering is
`postflightCapturedAt <= incidentCapturedAt <= operationStartedAt`. These two 15-minute documents
admit only that point-in-time boundary; they need not remain fresh through later waits. The human
authorization, in contrast, must cover the armed deadline and the independent 35-minute limit
measured from that same durable `operationStartedAt`. Never replace an expired admission document
with a different one inside an existing attempt.

The absolute operation deadline is `operationStartedAt + 2100 seconds`. The runner rechecks the
current time before origin binding, watchdog arm, Caddy start, firewall open and every PASS-capable
transition; each external call timeout is capped to the remaining budget. The watchdog deadline is
the earliest of authorization expiry, that absolute operation deadline and the effective armed
public deadline (`armedAt + WindowSeconds`). No new effect and no PASS may occur at or after the
applicable deadline. Cleanup may continue after it only to close AWS, restore origin/host state and
retain a truthful `INCOMPLETE/21`; elapsed time never grants a new window or permits backdating.

Only after a new explicit execution authorization and all preceding real gates exist, invoke the
production wrapper from the exact clean committed revision with every parameter below. The hash
next to the sidecar is the SHA-256 of the **sidecar file**, not a repeat of the archive hash.
The production boundary also requires Docker Desktop's Linux/amd64 engine at version `29.x`, the
pinned Node/Git/Docker/GitHub CLI/PowerShell/taskkill tools, a protected GitHub token file, the exact
default AWS credential path and the pinned SSH identity/known-hosts files. The output directory and
checkpoint parent must already exist with the strict ACL above, and the checkpoint itself must be
absent.

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `
  .\scripts\invoke-lightsail-edge-window.ps1 `
  -ExpectedRevision <40-lowercase-hex> `
  -IncidentEvidencePath <real-exit-0-adr0036-capture.local.json> `
  -ExpectedIncidentEvidenceSha256 <sha256> `
  -PreflightEvidencePath <exact-adr0036-final-adr0034-postflight.local.json> `
  -ExpectedPreflightEvidenceSha256 <sha256> `
  -PromotionEvidencePath <contained-promotion-capture.local.json> `
  -ExpectedPromotionEvidenceSha256 <sha256> `
  -PromotionNonce <64-lowercase-hex> `
  -ExpectedBundleSha256 <promotion-bundle-sha256> `
  -ExpectedManifestSha256 <promotion-manifest-sha256> `
  -ExpectedPromotionProvenanceSha256 <promotion-provenance-sha256> `
  -ExpectedSourceSha256 <promotion-source-sha256> `
  -AuthorizationPath <canonical-human-edge-authorization.local.json> `
  -ExpectedAuthorizationSha256 <sha256> `
  -OperatorArchivePath <refunddesk-edge-operator-revision.docker.tar.zst> `
  -ExpectedOperatorArchiveSha256 <archive-sha256> `
  -OperatorArchiveSidecarPath <refunddesk-edge-operator-revision.docker.tar.zst.sha256> `
  -ExpectedOperatorArchiveSidecarSha256 <sidecar-file-sha256> `
  -OperatorManifestPath <refunddesk-edge-operator-revision.manifest.json> `
  -ExpectedOperatorManifestSha256 <manifest-file-sha256> `
  -OperatorAttestationBundlePath <refunddesk-edge-operator-revision.attestation.jsonl> `
  -ExpectedOperatorAttestationBundleSha256 <attestation-file-sha256> `
  -OperatorProvenancePath <refunddesk-edge-operator-revision.provenance.json> `
  -ExpectedOperatorProvenanceSha256 <provenance-file-sha256> `
  -GitHubTokenPath <restricted-read-only-github-token-file> `
  -AwsCredentialsPath <absolute-user-profile\.aws\credentials> `
  -AwsProfile default `
  -SshIdentityPath .\sandbox-evidence.local\aws\refunddesk-sandbox-lightsail-rsa `
  -SshKnownHostsPath .\sandbox-evidence.local\aws\known_hosts.refunddesk-sandbox `
  -ExpectedSshCidr <authorized-operator-ipv4/32> `
  -WorkbenchCheckpointPath <restricted-create-new-checkpoint.local.json> `
  -OutputDirectory <restricted-existing-output-directory> `
  -WindowSeconds 300
```

The wrapper emits a create-new
`edge-window-workbench-request-<revision>-<nonce12>.local.json` in the output directory after the
remote watchdog, origin binding and bounded ingress are active. The human performs the one exact
synthetic Workbench replay named by the authorization, observes HTTP `200` with `duplicate=true`,
and then uses a second PowerShell process to create the checkpoint; never hand-edit or pre-create
it:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `
  .\scripts\submit-lightsail-edge-window-checkpoint.ps1 `
  -RequestPath <edge-window-workbench-request-revision-nonce12.local.json> `
  -CheckpointPath <the-exact-WorkbenchCheckpointPath-passed-above> `
  -HttpStatus 200 `
  -Duplicate $true
```

Interpret the process exit and its create-new evidence together:

- `0` is only canonical `PASS/PASS_EDGE_WINDOW_RECONTAINED` after exact AWS closure, origin
  restoration, token removal, watchdog disarm, contained host, unchanged financial counts, a new
  official ADR 0034 postflight and durable completion/release of the held interlocks;
- `20` is a complete fail-closed observation. It never authorizes another window;
- `21` is incomplete or recovery-bearing. Preserve the local attempt marker, exact input files,
  container/image where retained, and both Docker volumes
  `refunddesk-edge-window-<nonce12>` (state) and `refunddesk-edge-input-<nonce12>` (immutable
  inputs); do not remove, rename, copy, mutate or substitute them;
- runner status `64` is usage or pre-effect input rejection and creates no admissible edge
  evidence. The production wrapper accepts terminal evidence only for `0`, `20` or `21`; it maps a
  runner `64` or its own provenance/transport failure to a local non-admissible wrapper error
  (normally status `1`), never to PASS.

Resume only by re-running the **identical full command** with the same paths, hashes, revision,
authorization, `WindowSeconds` and checkpoint path. The attempt binding selects the same nonce and
retained volumes; it must converge cleanup or replay the embedded terminal bytes without another
origin bind, firewall open, Workbench replay or public window. A complete nonce is consumed, never
reopened. Admission-proof remaining time is always derived against the stored
`operationStartedAt`, not the resume wall clock; authorization covers the same fixed 35-minute
deadline rather than granting another 35 minutes. Once a remote journal exists, a late recovery is
cleanup-only and cannot reopen. If exact attribution, provider restoration or containment cannot
be proven, keep the recovery set and escalate; neither deletion nor a fresh nonce is a recovery
procedure.

Offline fake-AWS/SSH/host/Workbench contracts and validators cannot establish the current AWS or
host state, CloudFront origin identity, public traversal, Stripe delivery or financial behavior.
Even a future real exit-`0` artifact is revision-, nonce- and interval-bound and does not authorize
production, live mode, customer data, worker/timer restart, Stripe review, Marketplace publication
or a subsequent reopening.

### Read-only ADR 0032 postflight

Run the production capture only from the committed revision that contains the final observer,
validator, wrapper and schema. Their worktree and index bytes must equal the same repository
`HEAD`; do not stage around this check or run a modified copy. Keep the ignored pinned SSH identity,
known-hosts file and restricted default AWS credential file in their documented locations, then
run from the repository root:

```powershell
pnpm sandbox:postflight:capture -- -ExpectedSshCidr "<current-operator-public-ipv4>/32"
```

Replace the placeholder at invocation time only. The wrapper accepts one canonical IPv4 host CIDR
with prefix `/32`; never commit the operator address or include it in the evidence artifact.

The wrapper performs bounded read-only AWS and SSH observation, validates two host snapshots and
the before/after AWS firewall envelope, and writes one create-new redacted artifact below
`sandbox-evidence.local/aws/`. It does not issue a health request, acquire the remote operator lock,
start or stop a service, write remote state or call Stripe. Review the artifact immediately; its
`validUntil` is fifteen minutes after the earliest admitted local/remote observation.

Interpret process status exactly:

- `0`: a `PASS` capture was written;
- `20`: a `FAIL` capture was written;
- `21`: an `INCOMPLETE` capture was written;
- `1`: the local wrapper or its transport/provenance envelope failed; do not claim a capture;
- `64`: the remote observer rejected its invocation or execution context as usage; it is never a
  host-state result.

`PASS` means only that the modeled point-in-time containment contract was coherent, either with
the core runtime healthy and the prohibited surfaces stopped or with the narrowly modeled
recoverable runtime stopped. `FAIL` is a complete divergent observation. `INCOMPLETE` means the
observer could not obtain enough trusted state. Neither outcome authorizes an automatic repair or
retry, and an expired artifact is never current evidence.

This postflight is intentionally narrower than release admission. It verifies the explicit
revision, image, state, listener, journal, fence, live, financial and AWS-edge fields in its schema;
it does not prove every Compose command, mount, network or runtime setting, public health,
CloudFront origin identity, complete CI or bundle provenance. Even `PASS` cannot authorize a
release, recovery, ingress reopening, worker/timer restart or financial proof. Apply ADR 0031,
exact-SHA CI/bundle requirements, incident admission and separate authorization independently.

### Consumed exact-8da contained journal reconciliation

ADR 0035 was the only permitted successor for the exact-8da quiescence journal. Corrected exact
revision d096 completed that one bounded repair. Do not invoke the normal quiescence-recovery
service: it starts worker and Caddy and requires public verification through ports 80/443. Do not
invoke the consumed ADR 0035 path either; its stop-only success cannot release a revision, start a
service, open ingress, enable live mode or call Stripe.

The execution was admitted only from the exact committed and published revision whose complete CI
and sandbox-bundle gates passed. Immediately beforehand it consumed a fresh ADR 0032 postflight
with at least 720 seconds of its 15-minute window remaining. The wrapper admitted the exact initial
six-diagnostic `COHERENT_RUNNING` observation. Its historical invocation form is retained only for
audit and must never be executed again:

```powershell
pnpm sandbox:containment:reconcile -- -PreflightEvidencePath "<fresh-postflight.local.json>" -ExpectedSshCidr "<current-operator-public-ipv4>/32"
```

The wrapper pinned worktree, index and `HEAD` bytes for both the ADR 0034 preflight chain and the ADR
0035 runner/validator/schema/wrapper; it rechecked the exact AWS account, instance and firewall
before and after the bounded SSH operation. The remote runner held the operator lock exclusively,
stopped maintenance plus Caddy before worker, proved stable financial and core-runtime snapshots,
and retired the journal only after a durable `contained_verified` marker. Both backup and retention
required the existing stopped database-owner reservation to be exact; the successor never removed
or recreated it and refused every bootstrap, migrate or maintenance one-shot. For the canonical
never-started reservation created by Docker, exact inspection required
`Config.AttachStdin=false`, `Config.AttachStdout=true`, `Config.AttachStderr=true`,
`Config.Tty=false`, `Config.OpenStdin=false` and `Config.StdinOnce=false`. The reviewed contracts
asserted this against real Docker as well as synthetic negative fixtures. Any mismatch returned
`CORE_RUNTIME_INVALID` before marker creation, journal retirement or another mutation; never modify
the reservation as a workaround. Preserve the successor marker and do not fabricate or restore the
old journal.

Interpret status exactly:

- `0`: a `PASS_CONTAINED_JOURNAL_CLEARED` reconciliation artifact was written;
- `20`: a complete fail-closed `FAIL` artifact was written;
- `21`: an `INCOMPLETE` artifact was written and durable state may require the modeled resume;
- `1`: the local admission/transport/provenance envelope failed and no artifact is claimed.

Exact 442 returned a nonzero pre-effect result and never reached a resumable marker state; it must
not be retried. Exact d096 returned status `0`, then its immediate postflight returned `PASS`,
posture `COHERENT_CONTAINED`, code `PASS_CONTAINED`, closed and unchanged AWS ingress, disabled
live, financial quiescence, stopped worker/Caddy/timers/listeners and no quiescence journal. The
one-shot and reviewed harness are consumed. Never execute or resume either, and never remove the
local durable `CreateNew` attempt marker or the remote `complete` successor marker. This closes
only the one host repair; it never authorizes
release, ingress reopening, credential use, service restart or a financial proof.

Build the three provider-neutral targets from the repository root on Linux:

```bash
docker build --target web --tag refunddesk-web:<revision> .
docker build --target worker --tag refunddesk-worker:<revision> .
docker build --target migrate --tag refunddesk-migrate:<revision> .
```

Never reuse host `.next`, `dist`, generated Prisma or `node_modules` artifacts. The Docker context
excludes local environment and evidence files. Do not pass a credential through `ARG`, Dockerfile
`ENV`, an image label or a build log.

Prepare three ignored environment files:

- platform: web database URL, direct-account test/sandbox webhook secrets, both expected Stripe
  account IDs, field/export keys, distinct account-bound Stripe read-only restricted keys, the
  private worker verifier URL and its shared bearer token;
- worker: distinct worker and pg-boss queue URLs, the Stripe App signing secret, proof and
  approval-attestation HMAC keys, the same verifier bearer token, the same two expected account
  IDs, and distinct account-bound Stripe effect test/sandbox restricted keys;
- migration: owner plus the separate web, worker and queue database URLs needed by the canonical
  grants/access checks, but no Stripe or application cryptographic secret.

All three set `NODE_ENV=production`; this optimizes Node only. They keep
`REFUNDDESK_GLOBAL_LIVE_ENABLED=false`, contain no live key and use only synthetic test/sandbox
objects. Production loaders reject known foreign-service secrets and generic
`STRIPE_PLATFORM_TEST_KEY` / `STRIPE_MANAGED_SANDBOX_KEY` names.

Before build promotion, run the offline separation preflight without printing any value:

```bash
pnpm config:release:check -- .env.platform.local .env.worker.local .env.migration.local
```

The preflight requires pairwise-distinct web/worker Stripe credentials, exact web/worker equality
of each expected Stripe account ID, inequality between test and managed sandbox, distinct
field/proof/approval-attestation/export keys, an exact verifier-token match and separate web,
worker, queue and owner database principals. It also rejects the Stripe App signing secret in the
platform environment and requires it in the worker environment. It does not replace a real Stripe
permission test: each web read key must retrieve its allowed PaymentIntent/Charge and receive HTTP
403 for `refunds.create`; record only redacted evidence.

Run database release preparation once, serialized by the hosting control plane, before starting the
new web or worker revision:

```bash
docker run --rm --env-file .env.migration.local refunddesk-migrate:<revision>
```

The image runs `pnpm db:release:prepare`: Prisma deploy and runtime grants, then pg-boss migration
and worker grants, then the real-login access check. Never inject `DATABASE_MIGRATION_URL` into web
or worker and never run migration logic in their startup commands.

Runtime probes are independent:

```text
web     GET /api/health   liveness
web     GET /api/ready    PostgreSQL/schema/RLS/authority readiness
worker  GET /health       liveness
worker  GET /ready        pg-boss consumer/schedule and scanner coverage readiness
worker  POST /internal/v1/signed-requests/verify  private pure Stripe-signature verification
worker  POST /internal/v1/signed-requests/attest  private approval-attestation authority
```

The worker listener defaults to loopback locally. If a hosting probe requires
`WORKER_HEALTH_HOST=0.0.0.0`, keep that port off public ingress. Responses are generic, but public
exposure still expands attack surface. Configure the container health check against `/health`;
alert on `/ready` separately so a stale scanner is visible without turning a long scan into a
restart loop. The signed-request endpoints share this listener but must be reachable only from the
web service. Both require the shared bearer token and accept only the exact raw Stripe-signed JSON
body. `/verify` performs no database access. Only `/attest`, called for an admitted approving
decision, re-verifies the same bytes/signature and persists an attestation. Production
`REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL` must be HTTPS and end exactly in
`/internal/v1/signed-requests/verify`; loopback HTTP is a local-development exception only.

The private verifier returns `403` for a missing or invalid inter-service bearer and `401` only
after that bearer passed but Stripe rejected the request signature. The web maps `401` to a signed
request rejection. Only a durable `409` from `/attest` maps to the public
`409 IDEMPOTENCY_CONFLICT`; a `409` from `/verify` and every other `403`, non-`200`, transport
failure or worker `5xx` map to verifier unavailability so a token rollout mismatch cannot
masquerade as a client signature failure.

### Durable signed-request capacity boundary

After the private worker has purely verified the exact Stripe signature and the web has validated
the signed test/sandbox account shape, the web consumes the global pre-tenant PostgreSQL GCRA before
approval attestation or tenant dispatch. The durable scope is the SHA-256 digest of account,
environment and request class;
the table contains no readable account identifier. Mutations have a burst of 30 and refill at 0.5
request per second. Reads have a burst of 60 and refill at one request per second. PostgreSQL keeps
at most 256 active scopes and removes eligible scopes inactive for ten minutes when admitting a new
one.

Only the web runtime may execute
`refunddesk_consume_signed_request_rate_limit(VARCHAR, stripe_environment, VARCHAR)`. No runtime
has direct bucket-table access; worker, queue and maintenance cannot execute the function. A valid
denial returns `429` with a positive `Retry-After`. Any database, lock, capacity or decision failure
returns a generic retryable `503` with no in-memory bypass.

The process-local edge gate described below protects the signature-verification work that precedes
this durable limiter. The exact CI evidence for the durable PostgreSQL gate is recorded in ADR 0017;
a hosted signed-route end-to-end pass remains a separate revision-bound gate.

### Trusted edge and pre-authentication capacity boundary

The target hosted contract is valid only through CloudFront and Caddy. This describes a future
exact-revision admission requirement, not the currently admitted host state. CloudFront must overwrite
`X-RefundDesk-Origin-Token` with the random token also held in root-only `caddy.env`. Caddy returns
`404` before proxying when that token is absent or wrong, freezes the incoming XFF chain, injects the
private `cloudfront-v1` marker plus viewer chain, and strips the token upstream. Never put the token
in platform/worker environment files, command-line headers, logs or evidence.

AWS `CLOUDFRONT_ORIGIN_FACING` CIDRs filter a generic CloudFront network source; they do not
authenticate RefundDesk's expected distribution. ADR 0031 therefore supersedes ADR 0029's
`CloudFront-only` conclusion and classifies its historical public window as an unadmitted hosted
observation. Neither the CIDRs nor that window can authorize a new reopening.

Caddy limits request headers to 64 KiB and enforces a five-second header-read timeout, a 30-second
body-read timeout, a 30-second write timeout and a 60-second idle timeout. These limits apply before
application admission and bound slow direct-origin connections that cannot yet be checked against
the origin token. Hosted application admission fails closed if the origin-token header is still
present, so a successful correct-token local traversal proves that Caddy removed the secret without
returning or logging its value.

Keep `persist_config off` in both Caddy files. Release validates the fixed public Caddy config
directory, deletes only `/var/lib/refunddesk/caddy-public/config/caddy/autosave.json` when it is a
real regular file, and does so before candidate runtime admission. Deployment verification requires
that path to be absent. The root-owned `caddy.env` must contain exactly three LF-only assignments;
comments, blank lines, duplicates and CRLF fail before mutation.

Before any signed/webhook body read or signature check, the single web process previews a source
GCRA, then the admitted-work global GCRA, then a no-wait verification lease. A tracked source is
charged immediately after its preview passes, including when a later shared check denies it. An
unseen source remains provisional until all three checks pass, and the global budget is committed
only for fully admitted work. The process retains a fixed total of 2,048 HMAC-digested sources in
isolated maps: 1,920 signed API, 64 direct-account webhook and 64 audit download; never raw IPs.
Signed POST uses source `100/250ms`, global `200/100ms`, concurrency 16; direct-account webhooks use
`40/500ms`, `80/200ms`, concurrency 8; audit downloads use source `5/10s`, global `20/2s`,
concurrency 2. Source denial cannot spend shared capacity; global/concurrency denial cannot retain
an unseen source. A full map is swept at most once per minute; unseen sources then use a separate
fixed per-class overflow GCRA. Hosted webhooks also require the rightmost CloudFront viewer IP in
allowlist version `stripe-docs-2026-08-01`; Stripe signature verification remains mandatory. A
restart resets this edge state, and adding a web replica requires a new review because it multiplies
capacity. Multiple distributed, fully admitted pre-authentication requests can still exhaust the
global budget or temporarily pin a source map; treat CloudFront/network protections as part of the
residual availability boundary.

Signed and webhook streams have an absolute 30-second application body deadline in addition to
Caddy's limit. The loop checks the absolute clock, accepts at most 1,024 chunks and copies into one
fixed maximum-size buffer. Expiry or excessive fragmentation cancels the stream and releases the
lease before HMAC, worker or database work. Audit-download admission occurs before bearer HMAC
verification and retains its two-slot lease through the bounded tenant transaction and CSV
rendering. Repeated edge signals emit one immediate warning, then at most one bounded aggregate per
event per minute; logs never contain the source, forwarding chain, token, signature or body.

For a signed approval, keep the lease through the pure `/verify`, durable admission and second
`/attest` verification/write, then release it before tenant dispatch. Every error and non-approval
exit releases the lease exactly once. This bounds both signature-verification passes without
holding the process-local lease over the financial workflow transaction.

Do not deploy this Caddy contract until the same release has configured the CloudFront custom
origin header. Prove missing/wrong-token `404`, correct-token local traversal, public CloudFront
health, a synthetic local raw-body relay and a real Stripe test/sandbox delivery from an official
source. The synthetic public caller is expected to receive `403 WEBHOOK_SOURCE_FORBIDDEN`; it is not
real Stripe webhook evidence. The signed synthetic success proves only the local Caddy hop; only the
real Stripe delivery can prove CloudFront preserves the signed raw body end to end.

The last admitted canonical deployed backend is immutable revision
`e4cec06068d71afb5c2ac9fc04175bfdfd6756c2`; it is historical evidence, not a current-host
postflight. Its canonical inter-revision release completed on
31 July 2026. The changed host-control source was bound through a manifest-derived artifact; this
was not a native OCI rebuild. The source commit is an ancestor of configured `origin/main`, but no
exact GitHub artifact attestation is claimed for that local hosted promotion. The release performed one bounded PostgreSQL container
recreation because the prior and current revisions selected different canonical Compose project
paths. PostgreSQL retained the same cluster system identifier, root bind, schema and every
financial/audit count. Five isolated runtimes, private verifier boundary, public health,
startup-reconciliation ordering, active maintenance timers and both false live interlocks passed.
The snapshot contained two pre-existing terminal test/sandbox workflows, no active workflow or
guard, no pending Refund, no unfinished attempt/correlation, no live tenant or installation and no
active effect job.

ADR 0030 records later attempts to promote `8da280b7...`. The admitted ADR 0032 postflight observed
that revision active at capture time but returned `FAIL`; this resolves the metadata conflict only
for that point in time and does not admit the release. Do not call e4 current or promote `8da...`
from this observation.

For every future candidate, the exact source SHA must pass both the complete CI workflow and the
sandbox bundle workflow. Bundle provenance is a hard gate: if `actions/attest` fails, neither S3 nor
GitHub artifact delivery may run and the bundle is not promotable. Adjacent SHA-256 files remain
integrity checks, not substitutes for the required GitHub provenance.

Compose may reuse an exited container when its image and configuration are unchanged. Release
therefore uses `--force-recreate` for exactly verifier, worker, web and Caddy after the durable
journal and release fence are armed, and before candidate admission or start. It never adds
PostgreSQL, dependencies or volumes to that command. A same-revision configuration release is not
proved unless all four stateless container IDs change and the PostgreSQL container ID remains
unchanged. Keep a durable configuration journal and rollback copy until the canonical release,
deployment verification, key/token continuity, live interlocks and financial safety counters all
pass.

An orderly failed release that restores metadata, stops candidate containers and retires its
journal is `ROLLBACK_METADATA_RECOVERED_RUNTIME_STOPPED`, not recovered availability. Preserve the
failed container logs and do not start an ad hoc revision. Follow ADR 0032: capture the redacted
read-only postflight, run the printed exact `--no-start --force-recreate` recovery command only for
the admitted active revision, then rerun only an exact authorized release whose complete CI and
attested bundle share the same SHA. Claim recovery only after exact identities, readiness, closed
journals/fences, live false and financial/audit counters pass.

Docker Compose container identity also depends on the spelling of relative configuration paths.
The stable backup, retention and quiescence-recovery launchers must therefore export the exact
resolved revision path
`/opt/refunddesk/releases/<active-revision>/source/deploy/lightsail/compose.yml`; their runners
reject the `/opt/refunddesk/current/...` alias even though it resolves to the same bytes. Before a
same-revision credential transition, confirm a maintenance recovery does not recreate PostgreSQL
and that release dry-run sees PostgreSQL as `Running`, never `Recreate`. If either check fails,
repair and release the path contract first; do not waive the unchanged-container proof.

Direct `refund.created` delivery and one manual replay passed separately in test and managed
sandbox on the earlier `42a1e4e...` backend; the identified obsolete connected test destination
was deleted without rewriting historical receipts. Those Stripe-delivery observations remain
historical evidence and are not silently transferred to `71bbd98...`, `8357d956...` or
`4521b8c9...` or `e4cec060...`.

Both destinations remain configured for API version `2026-06-24.dahlia`. Refund Events must carry
that exact value in `Event.api_version`. The two Stripe App lifecycle types accept only Dahlia or the
explicitly observed `2026-02-25.clover` value. The destination setting must not be reported as proof
that a lifecycle Event body is Dahlia, and the Clover exception must never be applied to a Refund.

Unpublished Stripe App `0.1.3` was uploaded from clean commit
`c241a097fc5f4b8e8eaa2f057f9c7db40d9dffa3`, installed in the distinct test sandbox and
reauthorized for the stable origin. The exact UI-generated request bytes and Stripe signature were
relayed unchanged to the hosted eligibility endpoint and returned HTTP 200. No financial effect was
requested. The normal controlled-browser delivery remains `BLOCKED_TOOLING` after
`ERR_BLOCKED_BY_CLIENT`; do not call this a native browser end-to-end pass. Installation and relay
are operator observations whose raw capture and temporary harness were intentionally destroyed;
they cannot be reproduced from the redacted artifact alone.

Managed-sandbox lifecycle evidence now binds to `4521b8c9...`. An exact Workbench replay of a real
`account.application.deauthorized` Event returned HTTP 200, produced one receipt and one applied
audit, moved the installation to deauthorized and the tenant to pending deletion, and produced no
financial effect. A second replay was deduplicated. This proves corrected processing of that exact
real Event; it is not an automatic post-fix delivery.

Unpublished App `0.1.4` was then freshly installed in the distinct managed sandbox through Stripe's
official external-test flow. The automatically emitted `account.application.authorized` Event
returned HTTP 200 and was applied once; a later manual replay returned HTTP 200 with
`duplicate=true`. Final preflight found one clean active installation, two authorization receipts,
two authorization audits, no failed lifecycle receipt and no financial effect. Test-account
lifecycle and an automatic post-fix managed-sandbox deauthorization remain open. The native Stripe
App financial browser path also remains `BLOCKED_TOOLING`.

Any future backend, App version or origin change requires its own clean artifact and evidence.
Evidence from `42a1e4e...`, `71bbd98...`, `8357d956...`, `4521b8c9...`, installed App `0.1.3` or
installed App `0.1.4` does not transfer to changed source.

## 2B. Hosted cold backup and disposable restore

The canonical active backup is:

```bash
sudo systemctl start --wait refunddesk-backup.service
sudo systemctl show refunddesk-backup.service \
  --property=Result,ExecMainStatus,ActiveState
```

Before starting, confirm the exact active revision/current symlink, no financial effect in flight,
all five services healthy, the backup timer state and the service `ExecStart` bound to the stable
root-owned `/usr/local/sbin/refunddesk-backup` launcher. The launcher must resolve through the
active control-plane generation to the exact immutable source and manifest before it executes
`backup.sh`. The obsolete
`10-sse-hotfix.conf` may be removed only after the canonical `backup.sh` and hotfix copies compare
byte-for-byte. Keep a root-only rollback copy under `/run` until the canonical service completes.

`backup.sh` acquires the operator lock, rejects static AWS credentials, requires PostgreSQL 18,
stops ingress/worker/web/verifier/PostgreSQL, creates a numeric-owner cold archive, compresses it
with single-threaded zstd, encrypts it to the public `age` recipient and uploads one version with
SSE-S3 AES-256. It verifies remote size, SHA-256 and encryption, then restarts and verifies the
complete stack. On failure it attempts to identify and delete only the exact uncommitted object
version and to restore all services. If upload state or cleanup is ambiguous, it preserves the
encrypted archive and durable upload journal for explicit reconciliation instead of claiming
cleanup.

The Lightsail resource-access identity does not use `GetBucketVersioning`. Before quiescence,
`backup.sh` lists a unique probe key, puts the active-revision marker, requires and heads an exact
non-null `VersionId`, then deletes that same version and proves that no version/delete marker
remains. Any ambiguous result or residue stops the run before PostgreSQL is touched.

After success, identify exactly one object version created after the invocation. Validate its
`revision`, SHA-256, byte length, `VersionId` and `ServerSideEncryption=AES256` metadata before
removing the rollback copy and obsolete hotfix directory. Use `s3api get-object --version-id` for
restore input; a non-versioned download is insufficient evidence.

Run the repository `restore-verify.sh` on a separate disposable Linux host with the exact
`postgres:18.4-bookworm` image already present:

```bash
sudo bash restore-verify.sh \
  --archive /root/refunddesk-restore/postgres-backup.tar.zst.age \
  --identity /root/refunddesk-restore/age-identity.txt \
  --sha256 <out-of-band-lowercase-sha256>
```

When the operator shell is Windows PowerShell 5.1, do not pipe a command whose final token is the
SHA-256 directly to native SSH stdin: PowerShell appends CRLF and Bash can retain the carriage
return in that final argument. Transfer an LF-only wrapper, verify its SHA-256 and syntax on the
verifier, and execute it once with strict host-key checking. Independently assert that the
out-of-band value is exactly 64 lowercase hexadecimal bytes before the one-shot invocation.
The locally prepared retry wrapper
`sandbox-evidence.local/aws/run-e4-restore-once.local.sh` has SHA-256
`1f1d82725fb3ab8b0888385b4a9371100663df2f01d95a657ba2da10228ab552`, contains zero carriage-return
bytes, embeds the archive/common/restore hashes and uses a persistent atomic attempt lock under
`/var/lib`. At independent-review time it had not been executed and was not restore evidence. The
corrected one-shot path later passed on 1 August 2026; its separate redacted result is
`restore-e4cec060-2026-08-01.local.json`, SHA-256
`951505c6b61ce77a4bc04645837e595e33c2b0a13543088913af4c153fc3acf3`. Changed bytes or future
revisions require new evidence.

The verifier must have no IAM role, only operator-IP SSH ingress, an encrypted root volume with
delete-on-termination, and no egress before the private `age` identity is copied. The restore
container uses `--network none`. Success requires the encrypted archive digest, decryption and
compression checks, physical PostgreSQL checksums, PostgreSQL 18 startup, complete Prisma
migrations and unprivileged web/worker/queue roles.

On every exit, remove the copied identity and archive, terminate the verifier, and prove that its
non-terminated instance, volume, security group, key pair, network interface, public IPv4, snapshot
and image are gone. AWS may retain a terminated historical instance descriptor; do not confuse that
descriptor with a running or billable resource. Preserve only the successful versioned backup and
redacted evidence. This procedure passed separately for active revisions `42a1e4e...`,
`71bbd98...`, `4521b8c9...` and `e4cec060...`; it must be rerun for any future recovery claim.

Revision `71bbd98...` produced and verified one encrypted cold backup on 30 July 2026. The object
has an exact non-null version ID, revision-bound SHA-256/length metadata and
`ServerSideEncryption=AES256`; no multipart upload, versioning-probe residue, local archive or
unfinished upload/quiescence journal remained. That exact version then passed the disposable
PostgreSQL 18.4 restore procedure: out-of-band archive checksum, decryption, decompression,
physical checksums, server startup, migrations and runtime-role checks all passed. The copied
identity and archive were removed before termination, and the verifier instance, volume, security
group, key pair, network interface and public IPv4 were removed. The redacted local restore
artifact remains the provenance boundary. This evidence remains historical and revision-bound.

Revision `4521b8c9...` separately produced one exact encrypted cold backup on 30 July 2026. The
unique selected version has SHA-256
`f0196155190a5e46a792b463b771959a81e244458f108cabe8464b5dd001503c`, length `8327820` and
`ServerSideEncryption=AES256`. The runtime recovered to five healthy services with live disabled.
That exact version passed offline PostgreSQL 18.4 physical-checksum, migration and restricted-role
verification on a temporary `t3.micro` with zero egress before identity transfer. The identity,
archive, SSH material, instance, volume, ENI, security group, key pair and public-IP association
were removed. EIP, snapshot and AMI counts remained zero. The successful S3 object version was
preserved. Redacted evidence is
`hosted-sandbox-4521b8c9-lifecycle-backup-restore-2026-07-30.json`, SHA-256
`f5b41ee5f192a5744fdeed762845747cfb82e3284cde6a346fc33a6b27322d5f`.

At the final `4521b8c9...` capture, retention and backup timers were both enabled and active, and
the most recent retention and backup service results were both `success`. Timer state alone is not
scheduled-backup evidence for a revision. Only the invocation fingerprint recorded in the redacted
local artifact proves the manual backup above.

Historical exact-e4 revision `e4cec060...` separately passed the scheduled daily cold backup and a following
natural hourly retention on 31 July 2026. A root-only pre-retention snapshot and the following timer
invocation proved identical PostgreSQL container ID, creation/start timestamps, system identifier
and database safety counts before and after retention; its structured result selected and purged
zero rows. Earlier in the same maintenance window, the backup primary unit bound to the exact e4
Compose file, stopped and restarted
the same PostgreSQL container, and uploaded one 8,992,512-byte encrypted object version with
archive SHA-256 `5e4b91c06efd11932b4f5c4ee5392f56d63ac7a60d1a3bb335c8c7a36ed758fd`,
revision metadata and `ServerSideEncryption=AES256`. Both inline exact-revision recoveries passed,
five services were healthy, live remained disabled, and no local archive, versioning probe,
multipart upload or transition/maintenance journal remained. Redacted evidence is
`scheduled-maintenance-e4cec060.local.json`, SHA-256
`f568a1cc0d09db9d7364190c135e0c3fffcbbdf2bdb857b0d0a5d15cc14e0ce9`.
Docker's historical event buffer was not complete and is not claimed as lifecycle proof; the
backup proof instead uses its invocation journal plus preserved ID/creation time and a `StartedAt`
inside the backup window.

The first exact-e4 disposable attempt on 31 July 2026 authenticated the verifier with a one-time
AWS API/IMDSv2 challenge plus AWS-signed instance identity, verified its deadman, removed all
egress and matched the archive and verifier-script hashes. Its single invocation failed closed in
`restore-verify.sh` input validation because the Windows PowerShell native pipeline appended
carriage return byte `0d` to the final 64-character SHA-256 argument. Decryption, Docker,
PostgreSQL, migrations and role checks did not start, and no retry was made. Remote secrets were
removed, the watchdog was cancelled, cleanup plus an independent audit found zero instance,
volume, ENI, security-group, key-pair, EIP, snapshot, AMI or former-public-IP association. This is
`FAIL_PRE_EFFECT_CLEANED` and is not restore evidence. Redacted failure evidence is
`restore-e4cec060-failed-pre-effect-2026-07-31.local.json`, SHA-256
`ab6233b44cba2fc8d1970c54ea25171da8ee765f0cbd76a2dd1efe54366782db`.

The corrected path subsequently restored the exact e4 archive on 1 August 2026, passed the
PostgreSQL 18, migration and restricted-role checks, and cleaned every disposable resource. Its
redacted evidence has SHA-256
`951505c6b61ce77a4bc04645837e595e33c2b0a13543088913af4c153fc3acf3` and top-level result `PASS`.
Do not create another paid verifier without new authorization, and never cite the 31 July failed
attempt as recoverability evidence.

### Maintenance result classification

Apply ADR 0015 to retention and backup:

- `PASS` requires primary service `Result=success`, `ExecMainStatus=0`, a successful structured
  operation result, exact-revision recovery, five healthy runtimes and no transition, quiescence
  or upload journal;
- `FAIL_SAFE_PRE_QUIESCE` means a preflight failed before the durable quiescence journal and before
  any runtime service was stopped; maintenance did not pass, but no recovery was required;
- `FAIL_RECOVERED` means the primary maintenance service failed but an independent recovery
  restored the runtime; availability recovered, but the maintenance gate did not pass;
- `FAIL_UNRECOVERED` means the exact recovery contract did not complete. Preserve the journal,
  block release and further maintenance, and reconcile that exact invocation before any new
  start.

Never infer `PASS` from an `OnFailure` unit. Capture the primary invocation ID and result. Do not
submit a second start while the first invocation is active or ambiguous.

For a controlled manual maintenance proof, stop both timers, prove that no maintenance service,
operator lock, transition or quiescence journal is active, and then start exactly one service.
Reactivate both timers only after final health and journal checks. Because the retention timer is
`Persistent=true`, systemd may immediately run a distinct catch-up invocation for an elapsed
hourly window; observe it separately and wait for `active/waiting` with a future next trigger.

Recovery performs HTTPS and host-listener verification. The retention service therefore requires
`AF_UNIX`, `AF_INET`, `AF_INET6` and `AF_NETLINK`; the recovery service requires netlink for
`ss`. Failure to obtain the listener inventory is itself a hard failure. No recovery path may
clear the quiescence journal before the exact active revision and its deployment checks pass.
Release similarly closes its durable transition journal before activating persistent timers; the
release-held operator lock serializes any immediate catch-up until release exits.

The `2026-07-30T01:02:27Z` retention invocation on `eeb840e...` is permanently recorded as
`FAIL_RECOVERED`. The manual retention invocation, the later persistent-timer catch-up and the
cold backup on `71bbd98...` each completed independently with `success`.

## 3. Readiness checklist

The process liveness endpoint proves only that the process runs. Readiness must fail when an indispensable dependency or safety condition fails.

Verify:

- PostgreSQL is reachable with the unprivileged runtime role;
- required migrations are applied;
- pg-boss schema is ready before worker claims;
- the signing secret for the exact uploaded Stripe App exists only in the worker and is configured
  without printing it;
- platform and worker have the same private verifier token, and the verifier route is absent from
  public ingress;
- web has no table or column privilege on `approval_attestations`;
- the signed-request limiter migration is present, web alone can execute its SECURITY DEFINER
  function, and web, worker, queue and maintenance all lack direct bucket-table access;
- worker, queue and maintenance cannot execute the signed-request limiter function;
- no potentially executable legacy approval lacks an attestation;
- exactly the intended direct-account test or sandbox Stripe credential and expected account ID are
  available;
- global live switch is false;
- tenant live switch is false;
- live credential is absent;
- the worker `/ready` probe sees every expected consumer and exact schedule;
- every active test/sandbox installation has a fresh scanner checkpoint or is inside its bounded
  initial warming period;
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
web and worker roles from pg-boss, denial of application-table access to the queue login, and a
rolled-back pg-boss operation through that queue login.
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
- signed-route `429` denials and limiter-unavailable `503` responses, without account, signature,
  body or exception dimensions;
- log-redaction test status.

Never label raw e-mail, justification, rejection reason, request body or ciphertext as a metric dimension.

The worker samples its existing readiness probe every 60 seconds and writes only allowlisted
`operational_readiness_sample` fields plus deduplicated `operational_alert` `raised`/`resolved`
transitions. `live_enabled` is S0; consumer, schedule, scanner and dependency failures are S1.
These records are local structured logs, not a proven external paging channel or durable alert
store. They improve diagnosis but do not close the pilot gates for alert delivery, ingress rate
limiting or operational ownership.

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
| Unfinished maintenance quiescence/upload journal       | S1; block release/start   |
| Primary maintenance failure with successful recovery   | S2 and `FAIL_RECOVERED`   |
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

1. Verify the endpoint is the expected direct-account
   `/api/webhooks/stripe-account/test` or `/api/webhooks/stripe-account/sandbox` endpoint.
2. Verify Workbench shows account scope, destination API `2026-06-24.dahlia`, the expected account
   and no Connect delivery. Never reuse a `stripe-connected` destination.
3. Compare the signed Event's exact type and `api_version` with the allowlist: Refund types require
   Dahlia; only `account.application.authorized` and `account.application.deauthorized` may also
   carry `2026-02-25.clover`. Do not disable version validation or accept a family/prefix match.
4. If the response is `API_VERSION_MISMATCH`, record only redacted event type, environment,
   destination version, `Event.api_version`, active backend revision and HTTP result. Never retain
   the raw body, full signature or secret.
5. Verify raw-body handling was not changed.
6. Verify the matching webhook secret is loaded without printing it.
7. Check clock drift and request body limits.
8. Restore ingestion.
9. Use the creation-window scan to recover newly created Refunds and direct linked-ID refresh to
   converge older linked Refunds outside the overlap; replay real Stripe Events only when useful
   for contract verification.
10. Confirm duplicate replay is harmless across historical `connected_*` and current `account_*`
    receipt provenance.
11. Verify scanner completion and checkpoint age before closing.

Never accept an unsigned payload as a recovery shortcut.

A real lifecycle delivery rejected before persistence is diagnostic evidence, not a passed lifecycle
gate. After a correction, prove the exact active revision, HTTP 2xx, one durable receipt, the
expected monotone installation transition and zero financial effect. State explicitly whether the
proof used a fresh Stripe delivery or a Workbench replay.

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

## 9A. Signed-request rate-limit incident

Treat a `429 RATE_LIMITED` as an intentional capacity decision, not as verifier or database failure.
The client may retry only after the positive `Retry-After` value and must preserve the original
signed command and mutation nonce. Never mint a new nonce merely to bypass a bucket.

Treat `503 RATE_LIMITER_UNAVAILABLE` as fail-closed infrastructure unavailability:

1. Do not bypass the limiter, substitute a process-local bucket or grant direct table access.
2. Keep signed mutations unavailable while the decision is ambiguous; webhook ingestion and safe
   reconciliation may remain independent.
3. Check PostgreSQL readiness, migration presence and lock pressure without printing the scope or
   raw request.
4. Through the reviewed owner/access-check tooling, verify the function owner and fixed search path,
   web-only `EXECUTE`, no direct runtime table privilege, and denial to worker, queue and maintenance.
5. If the 256-scope ceiling is reached, verify the ten-minute inactivity policy and investigate
   valid signed scope creation. Do not delete active rows or raise the cap ad hoc.
6. Restore the database/function boundary, rerun the concurrency and privilege gates, then verify a
   synthetic signed request receives the expected `429` or success without crossing live mode.
7. If abusive traffic is missing or failing signature verification, this limiter is not the control:
   close temporary ingress or apply the separately reviewed edge response and preserve redacted
   counts only.

Until the disposable PostgreSQL, signed-route end-to-end and exact deployment gates pass, record
this path as locally implemented/documented only, never `PASSED_REAL` or deployed.

## 9B. Edge-admission or webhook-source incident

Treat `429 EDGE_RATE_LIMITED` as an intentional process-local admission decision and respect its
positive `Retry-After`. Treat `503 EDGE_ADMISSION_UNAVAILABLE` as fail-closed trust, clock or limiter
failure. Treat `403 WEBHOOK_SOURCE_FORBIDDEN` as an untrusted webhook source, never as proof of an
invalid Stripe signature.

1. Do not trust a public `X-Forwarded-For`, bypass the edge gate or add an IP ad hoc.
2. Confirm CloudFront viewer health, the origin-token binding and that direct origin requests
   without the token remain `404`; never print the token or viewer chain.
3. Confirm Caddy injects exactly `cloudfront-v1`, freezes the incoming chain before proxy rewriting
   and removes the origin token upstream. A correct-token local traversal must pass while a direct
   hosted-mode application request that still contains the token fails closed.
4. Confirm Caddy still enforces the reviewed 64 KiB header ceiling plus header/body/write/idle
   timeouts; never remove them as a workaround for a slow caller.
5. Compare the versioned allowlist with Stripe's official webhook IP page. Apply changes through a
   reviewed release and retain signature verification.
6. If limiter state is suspect, restart only through the normal exact-revision release/recovery
   boundary; record that restart resets its allowance.
7. Keep ingress closed if CloudFront/Caddy disagree, a credential rotation is unfinished or a real
   Stripe test webhook cannot pass.

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

Status on 30 July 2026: `IN_PROGRESS`. On revision `71bbd98...`, field encryption, Refund-proof HMAC
and approval-attestation HMAC completed staged v2 activation, rollback to v1 and final v2
reactivation. V1 remains present for decrypt/verify compatibility and retirement was not attempted.
The private verifier bearer token separately completed A → B → A → B activation, old-token denial
and residue checks. Neither artifact proves the Stripe-signed request path, a new v2 financial
write, export-key rotation or any Stripe-owned credential rotation.

Never overwrite or retire a retained field-encryption, Refund-proof or approval-attestation `v1` key
in place. V1 retirement requires separate authorization plus dependent-row and backup-retirement
evidence. Do not mark the overall gate complete until every remaining credential family below has
old-version denial, new-version success, rollback/recovery evidence and backup-retirement checks
where applicable.

ADR 0019 defines one narrow exception for the coupled 1 August 2026 Stripe incident on exact
revision e4. Because the old raw values are already compromised, their redacted Dashboard
expired/revoked state replaces an API denial call. Never reload an exposed value merely to produce
old-version denial evidence.

### Four Stripe restricted API credentials

1. Stop effect claims if the compromised key could create Refunds.
2. Replace one credential at a time:
   `STRIPE_PLATFORM_TEST_READ_KEY`, `STRIPE_MANAGED_SANDBOX_READ_KEY`,
   `STRIPE_PLATFORM_TEST_EFFECT_KEY`, then `STRIPE_MANAGED_SANDBOX_EFFECT_KEY`.
3. Update only the platform or worker secret source that owns that credential; never place an
   effect key in web.
4. Restart the relevant service and verify account/environment binding before revoking the old key.
5. For each read key, prove the required reads work and `refunds.create` remains denied.
6. For each effect key, execute one allowlisted synthetic test/sandbox Refund through the normal
   approved workflow and verify idempotent reconciliation.
7. Revoke the old credential, prove it fails, then review Stripe activity logs.

Prefer a restricted API key with only the required operations whenever the Stripe App authentication model permits it.

For the exact-e4 coupled incident only, do not follow the one-key-at-a-time sequence above. Follow
ADR 0019 and the contained procedure below. That exception does not apply to any platform-test
runtime credential, future revision or future incident.

### Direct-account webhook signing secrets

Two Stripe durations decide this procedure, and they do not match. Rolling an endpoint secret
keeps the previous one active for **up to 24 hours**, and during that window Stripe signs each
delivery with every active secret. But Stripe retries an undelivered event for **up to three
days**. A delivery created before the roll and retried on day two therefore carries only the
old signature, long after Stripe's own overlap has lapsed.

Replacing the value and restarting would drop exactly those retries. A dropped `refund.failed`
leaves a refund recorded as succeeded with its payment guard released, and a dropped
`account.application.deauthorized` leaves a tenant that asked to leave still provisioned. The
receiver therefore keeps the previous secret acceptable until the **retry** window drains, not
the secret window (ADR 0026).

1. Rotate test and managed-sandbox destinations separately.
2. Roll the endpoint secret in Stripe. Note the moment: the retry window is counted from the
   oldest event that may still be in flight, not from the roll.
3. In the platform secret source, set `STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS` (or the
   sandbox one) to the value being retired, and set the current variable to the new value.
   Configuration refuses the pair if the two are equal, or if either collides with the other
   environment.
4. Restart web. Deliver one real synthetic `refund.created`, manually replay it, and require
   two successful attempts with one durable receipt and one alert.
5. Verify that a delivery signed with the retired secret is still accepted, and that one signed
   with an unrelated secret is refused.
6. Wait out the full three-day retry window before finishing. Ending sooner is what the overlap
   exists to prevent.
7. Remove the `_PREVIOUS` variable, restart web, and verify the retired secret is now refused.
   Leaving it set keeps a superseded secret valid indefinitely, which is the state a rotation
   exists to end.
8. Confirm the other environment, the disabled live value and every legacy connected route
   remain unchanged.

### Stripe App signing secret

Incident state on 3 August 2026: `RESOLVED_CONTAINED_INGRESS_STILL_CLOSED`, replacing the 1 August
`IN_PROGRESS_CONTAINED`. The exposed test/sandbox App signing secret was expired in the Stripe
Dashboard, replaced, and the replacement proved in real use by the exact-e4 transition; the old raw
secret was never retested. The recorded 3 August containment had public Caddy, worker, retention
and backup timers and Lightsail ports 80/443 stopped, with live disabled. The admitted 8 August
postflight later proved the captured host service posture had diverged while the AWS 80/443
firewall, live interlocks and financial state remained closed/quiescent. Exact-d096 later completed
the bounded containment repair and its final postflight observed worker, Caddy, timers and
listeners stopped with AWS ingress closed and live disabled. That observation was point-in-time
only. **Reopening public ingress is still a separate decision.** ADR 0034 records that the two
independent static reviews ended `NO_GO_REOPENING`; a new tracked successor where applicable and
separate authorization are required. Evidence:
`sandbox-evidence.local/aws/stripe-app-signing-secret-exposure-2026-08-01.local.json`.
That JSON retains its original `IN_PROGRESS_CONTAINED` result and is initial incident evidence, not
the final 3 August proof recorded by ADR 0024.

ADR 0029 records a later bounded ingress window, but ADR 0031 classifies it as unadmitted because
the repository has no complete artifact joining authentic origin authorization and a signed-route
probe to the contained host state, and the generic CloudFront CIDRs do not authenticate the
expected distribution. Exact-d096 closes only the host
containment repair; it does not supply CloudFront origin identity, reopening authorization or a
signed-route probe. The required incident state is closed and the final exact-d096 postflight
recorded a point-in-time `PASS_CONTAINED`. ADR 0034's review is `NO_GO_REOPENING`, and any new
reopening remains prohibited pending a tracked successor where applicable and a separate
authorization decision.

**Rotate with an overlap, not a cutover.** Stripe documents one signing secret per App with a
temporary overlap during rotation, so during that window a Dashboard extension request may arrive
signed with either value. A runtime holding one refuses whichever half it does not have, and the
merchant sees a Dashboard action that simply fails. The 3 August rotation used a hard cutover and
survived only because the host had no ingress and nothing was in flight — that is luck, not a
procedure.

1. Expire the current secret in the Stripe Dashboard and obtain the replacement.
2. Set `STRIPE_APP_SIGNING_SECRET_PREVIOUS` to the value being retired and
   `STRIPE_APP_SIGNING_SECRET` to the new one. Configuration refuses the pair if they are equal.
3. Restart the worker. Both are now accepted; only the new one is ever used to sign.
4. Prove a signed request end to end, then verify that a request signed with the retired secret is
   still accepted and one signed with an unrelated secret is refused.
5. Once Stripe's overlap window has closed and no extension session can still hold the old value,
   remove `STRIPE_APP_SIGNING_SECRET_PREVIOUS`, restart, and verify the retired secret is refused.
   Leaving it set keeps a superseded secret valid indefinitely (ADR 0028).

A later conversation exposure on the same date included the managed-sandbox restricted read and
effect keys and one full-access test secret. The worker was stopped for the recorded incident
containment and is still required to be stopped; the admitted 8 August postflight observed it
running, while the final exact-d096 postflight later observed it stopped. That final capture does
not prove later state or authorize restart. Do not reuse or validate those raw values. ADR 0024
records `PASS_CONTAINED` under ADR 0019's
Dashboard revocation/activity-review and replacement least-privilege admission contract. Its final
proof was cleaned by design, and ADR 0034's independent review ended `NO_GO_REOPENING`; it is not
standalone retained evidence of those details. Initial evidence:
`sandbox-evidence.local/aws/stripe-api-key-chat-exposure-2026-08-01.local.json`.

An unintended `stripe apps list` also initiated a Stripe CLI login against the pinned platform
test account. Local logout removed the local authentication and no local secret remains, but the
login created one platform-test and one platform-live CLI restricted key. ADR 0024's recorded
`PASS_CONTAINED` outcome implies ADR 0019's Dashboard-deletion and review admission contract; the
cleaned final proof is not independently retrievable, and ADR 0034's review is
`NO_GO_REOPENING`. Do not run `stripe login`, `stripe apps list` or any other command that can
authenticate implicitly during incident work.
Initial evidence:
`sandbox-evidence.local/stripe-cli-unintended-auth-2026-08-01.local.json`, SHA-256
`d51f557fd8f76af871d4a5019eac8e00e4ed465ed487afd05ac6750877ac9da7`.

#### Historical exact-e4 contained procedure (ADR 0019)

Current implementation state is `EXECUTED_PASS_CONTAINED_INDEPENDENT_REVIEW_NO_GO_REOPENING`, replacing
the earlier `LOCAL_DOUBLE_REVIEWED_GO_NOT_INSTALLED_NOT_EXECUTED_DASHBOARD_PROOF_REQUIRED`. The
procedure ran to completion on 3 August 2026: final `PASS_CONTAINED`, proof
`sha256:39e9351c387c1bc6316cdc23f507ddc9f073899b4863a1f09d4c0c5621fe7706`, and the three
replacement credentials each proven in real use. The fixed final proof file was removed during the
designed cleanup, so this is a recorded ADR 0024 outcome rather than a proof recoverable from either
1 August incident JSON.

Two consequences an operator must carry into any future use of this section.

**The earlier "double reviewed" claim did not survive execution.** Running the chain surfaced
eleven defects, several of which made the following step unreachable — one of them meant no state
transition of the controller was reachable at all. A chain in which no SSH call can succeed cannot
have been exercised, so those reviews never included an execution. Nine artifacts were corrected;
ADR 0024 records each defect and every current hash. ADR 0034 records two later independent static
reviews and their chain-level `NO_GO_REOPENING`. Their redacted evidence is
`sandbox-evidence.local/aws/exact-e4-independent-static-review-2026-08-08.local.json`, SHA-256
`613f868c80e52b834b7fe33594f590fea1990c52b155eef9dfcbaf9fc7b9fba2`.

**The hashes below moved with those corrections.** They are the values as of 3 August 2026. Verify
them against ADR 0024 rather than against memory, and treat a mismatch as a question about which
record is stale before treating it as tampering.

The frozen ignored transport/transition artifacts are:

- helper `e4-managed-sandbox-secret-transition.staging.remote.sh`, SHA-256
  `25b66b1e540c3c82709d8709236734f08c254d9d9254df4a69b028a1d2c68976`;
- transition validator `e4-managed-sandbox-secret-transition-validator.remote.py`, SHA-256
  `a1ec1772050113d8244cc82511eb611b676415a9c5c7000951119a59ebd2a4e2`;
- transport validator `validate-exact-e4-contained-transition-bundle.remote.py`, SHA-256
  `432f071c12a4e340c33782e2ec3e4cc7adbf04acbc589521b5b713f8d0506e56`;
- transport controller `install-exact-e4-contained-transition-bundle.remote.sh`, SHA-256
  `f58dafa9544a5f842467a0156b63a6aed1dcf00cc8226f9673c71beeaea5e5e6`;
- bootstrap `bootstrap-exact-e4-contained-transition-tools.remote.py`, SHA-256
  `c9d772f8398fe1004d79922530095c7c3c5b994432989dffd14f0139ca68b31c`;
- local transport wrapper `transport-install-exact-e4-contained-transition.local.ps1`, SHA-256
  `74e3980d544b285ebed33235247b2a2912f29f43a25a33af1bbada30c1b7f8eb`.

The frozen replacement-proof artifacts are client `315433815e2f2ebfbb70e337ca48addce1c1bcd721c17317897b2898567792e0`,
current-observation installer `5258c21134a25821d0d3a763bf3a0257915ff81f0cc6f94b00f4b049790351eb`,
runner `5fe99398cd94ee09d4ed4b80cff322f2760a76a8fcd1d0145c96207beebde92f`,
orchestrator `32b8cf2576f4359ae8fa7a2ccaf86e7dcc8d82e0434f198930fd5f02a0c4d680`,
proof-tool installer `e5ea9c722f809703810e8a382bca345e51804f7a426985652bbcea6319684430`
and local proof wrapper `f48e20c38c111b8a2381aa5cbe5e38f488b485d98a20e5f3b561896a05a285b5`.

Credentials, ciphertext, tools, input members and initial authority records use anonymous Linux
file descriptors and no-replace publication. The four input members are flat root-only mode-0600
files and the manifest is their last-published commit marker. There is no decrypted input directory,
named plaintext transport stage or validator `extract --directory` surface. The host must support
`O_TMPFILE`, xattrs and `linkat(AT_EMPTY_PATH)`; absence fails before service or financial mutation.
Host admission requires at least 720 seconds of the containment observation to remain.

Local review evidence is
`sandbox-evidence.local/aws/exact-e4-flat-anonymous-transition-proof-local-review-2026-08-01.local.json`,
SHA-256 `5aa768189ed404c844137ddbf8be49d4ac02620f103f6b0999e59a266aa41a82`.
It is not host, AWS, Stripe or rotation evidence — and, as the execution of 3 August showed, a
local review of this chain did not establish that it worked. Read it as a record of what was
reviewed, never as evidence that the reviewed thing runs.

The separately reviewed read-only containment capture uses observer
`sandbox-evidence.local/aws/inspect-exact-e4-containment.remote.sh`, SHA-256
`2b47e0a03004862c20f56bc427c1303cee14bc32820a069f8180ef2a91bbcf05`, wrapper
`sandbox-evidence.local/aws/capture-exact-e4-containment.local.ps1`, SHA-256
`079470b8160a05c430c76cf146e6b579a46f05bf8dd1eefae1322e46bf9a6fa0`, and regression contract
`sandbox-evidence.local/aws/test-exact-e4-containment-observer.local.mjs`, SHA-256
`e9aef1932936fce5643d413a149346ad48cbc570dceb599b8a35611e5ea7db04`. It binds the approved AWS
account before and after capture, exact host/revision/images, the complete running-container set,
financial quiescence, TCP/UDP listeners and Lightsail rules. Its output expires 15 minutes after
the earliest local/remote observation. The reviewed capture at `2026-08-01T19:04:53Z`, SHA-256
`2f0afdbeaa1d208d3b77ff392d9191ae76fb92414073304a106db69707e16d1e`, was a point-in-time PASS
only and must not be reused after `2026-08-01T19:19:53Z`; run the frozen wrapper again immediately
before composing real inputs.

Do not install or execute these one-time artifacts again. ADR 0034's negative independent review is
not permission to patch or repeat the consumed transition. The numbered sequence below is retained
only as a historical review record; it is not an executable runbook.
Dashboard labels can be localized; the historical object and action still had to be exact.

1. Keep worker, public Caddy, backup and retention timers stopped; keep Lightsail ports 80 and 443
   closed for TCP and UDP and both live interlocks false. No container may be running outside the
   exact PostgreSQL, verifier and web container IDs; stop and investigate any bootstrap, migrate,
   maintenance or foreign container before continuing.
2. In **Developers → Workbench → Logs**, refresh the logs and review the incident window. Filter by
   source, endpoint and status as needed. For each exposed API key, the **API keys** tab also offers
   **⋯ → View request logs**. Record only a redacted conclusion; never copy a credential or full
   request payload into evidence.
3. On **API keys**, in **Restricted keys** or **Standard keys**, use the exposed row's **⋯ → Expire
   key → Expire key** for the managed-sandbox read, managed-sandbox effect and full-access test
   secret. If the replacement already exists, do not rotate again and create another candidate.
   Confirm each exposed row is expired/revoked.
4. On **Apps**, select RefundDesk. In the page header choose **⋯ → Signing secret → Expire secret**,
   select the shortest safe overlap, and confirm **Expire secret**. Stripe can keep both App
   secrets active for the selected overlap, up to 24 hours, and signs once with each; ingress must
   remain closed throughout it.
5. On **API keys → Restricted keys**, identify the exact platform-test and platform-live Stripe CLI
   rows created by the unintended login, review their logs, choose **⋯ → Delete key** and confirm
   both rows are absent. Merely logging out locally or waiting for their 90-day expiry is not proof.
   If the Dashboard does not offer deletion, stop and record `BLOCKED_HUMAN`; do not substitute a
   CLI call.
6. Complete the redacted Dashboard proof required by ADR 0019. It must bind the pinned
   managed-sandbox and platform-test account fingerprints, SHA-256 of both incident artifacts, the
   candidate preflight and unintended-CLI artifact, plus fingerprints of all three replacement
   candidates; every digest uses the exact `sha256:<64 lowercase hex>` form. Record the four
   exposed credentials expired/revoked, both CLI keys deleted, request/activity review clean,
   continued containment and all redaction flags false. Add exact UTC-second
   `containmentCapturedAt` and `containmentValidUntil`; the latter must be later, at most 15 minutes
   after capture, and still unexpired at host admission. A capture more than two minutes in the
   future is rejected. Never put a raw key, App secret, signature, payload or Stripe object ID in
   that proof.

The navigation and expiry behavior above are grounded in Stripe's official
[API-key](https://docs.stripe.com/keys),
[Stripe App backend](https://docs.stripe.com/stripe-apps/build-backend),
[Stripe CLI key](https://docs.stripe.com/stripe-cli/keys) and
[Workbench](https://docs.stripe.com/workbench/overview) documentation. If the current Dashboard
differs, stop and update this runbook from official documentation before acting.

After the Dashboard steps and candidate capture are complete, use only the frozen local wrappers;
do not recreate the transport with ad-hoc SCP, shell redirection or a manually populated host
directory:

1. Run the composer contract test, the transport/crash contract, the transition contract and the
   proof contracts. Recompute every hash listed above and stop on any mismatch.
2. Capture a new App signing candidate into the ignored local candidate file without displaying it.
   Capture the strict Dashboard attestation separately. The attestation must record only observed
   facts; a key that merely says it will expire later is not yet revoked.
3. Run the frozen containment-capture wrapper immediately before composition. Compose one fresh
   bundle with `compose-exact-e4-contained-stripe-transition-input.local.ps1`, passing the two
   restricted-key candidate paths, the App signing candidate, the Dashboard attestation, the fresh
   containment proof and the four pinned redacted source artifacts. Do not use a containment proof
   with less than 720 seconds remaining.
4. Invoke the single bounded orchestration path:

   ```powershell
   powershell -ExecutionPolicy Bypass -File `
     .\sandbox-evidence.local\aws\invoke-e4-managed-sandbox-proof-orchestration.local.ps1 `
     -ComposedBundleDirectory <fresh-composed-bundle-directory>
   ```

   The wrapper revalidates AWS identity and exact local hashes, installs only frozen tools, runs the
   encrypted anonymous-file transport if needed, prepares or resumes the transition, refreshes the
   current containment observation before every proof attempt, runs at most four bounded proof
   invocations, refreshes containment again and finalizes. Remote and local timeouts terminate the
   complete child-process tree.

5. Admit only final JSON `PASS_CONTAINED` or an already completed state whose exact completion marker
   and containment are revalidated. It must report worker stopped, public ingress and maintenance
   not restored, live false, old credentials not retested and no raw secret or Stripe object ID
   emitted. Any `BLOCKED_*`, timeout, hash mismatch, foreign file, unsupported filesystem primitive,
   ambiguous Stripe call or unverified worker stop is fail-closed; preserve evidence and do not
   improvise a second path.
6. Completion occurs only after the helper records cleanup, removes the exact tagged final proof and
   four flat input members, removes their verified manifest last, retires the transition journal and
   promotes the completion marker to `complete`. Re-running the frozen wrapper is the authorized
   recovery path; it never restores predecessor credentials or reopens worker, Caddy, timers or
   ports 80/443.

The helper pins exact-e4 SHA-256 for Compose, release scripts, both Caddyfiles, revision marker,
release environment and the retained/installed manifest. It pins the exact web, worker, migrate
and Caddy image IDs and streams the fixed-hash docker-save bundle to bind its Config digests,
RepoTags and layers to that manifest before trusting local image tags. It then checks Compose
project/service/revision labels and config hashes for verifier, worker, web and Caddy; image
identities plus verifier/Caddy config hashes must remain invariant across recreation, while only
web/worker config hashes may change under the exact three-binding environment rewrite. Direct
Docker stops for worker, Caddy and all release/maintenance one-shots precede fallible Compose
cleanup. Baseline and completed candidate states require exactly PostgreSQL, verifier and web to
be running; recovery permits only a subset of those exact IDs and rejects every foreign container.
`--pull never` is only an additional guard and is not treated as image provenance by itself. No
`PASS_CONTAINED` completion is emitted while cleanup or marker commit is incomplete.

Public ingress, worker service, scheduled maintenance, pending/failed financial gates and any
later revision deployment are separate decisions after independent evidence review. Never treat
`preflight`, `prepare`, local synthetic tests or bundle delivery as a completed credential
rotation.

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

### Approval-attestation HMAC key

1. Stop new approval consumption while changing the active version.
2. Add the new key version to worker configuration and deploy worker support for both versions.
3. Make the new version active only for newly verified approvals.
4. Keep every referenced prior version verify-only while any guarded request can still execute or
   reconcile.
5. Confirm worker readiness and execute a synthetic signed approval before resuming normal claims.
6. Never backfill, re-sign or mutate an existing attestation.

### Export-signing key

An audit-download URL is a bearer credential that remains replayable during its five-minute
lifetime. Every use revalidates the current installation and actor authorization and appends a
separate `audit.export_downloaded` event correlated by the token nonce. Do not describe the link as
single-use, and do not introduce an in-memory consumed-token set. A one-shot policy requires an
atomic durable design review.

1. Stop issuing new audit-export tokens and wait for every existing short-lived token to expire.
2. Replace `REFUNDDESK_EXPORT_SIGNING_KEY_V1` with a distinct random value in web only.
3. Restart web, verify a new export token succeeds and every token signed with the retired key
   fails.
4. Confirm the new value is distinct from every encryption and HMAC key.

### Private verifier bearer token

1. Stop new signed mutations.
2. Generate a new independent token in the secret manager.
3. Roll worker and platform in a coordinated window; mixed tokens fail closed.
4. Verify requests with an absent or retired inter-service bearer return a generic `403`, requests
   with the current bearer but an invalid Stripe signature return a generic `401`, valid signed
   synthetic requests succeed, and the route remains absent from public ingress.
5. Revoke the old token after both services converge.

## 13. Uninstallation

A webhook-triggered uninstallation requires a signature-verified, deduplicated
`account.application.deauthorized` for the configured App ID and an allowed lifecycle API version.
An `authorized` Event, `context/sync`, inactivity or an operator observation of the Dashboard does
not prove deauthorization. A manual safety suspension may still be applied conservatively, but it
must not be reported as Stripe uninstall evidence.

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
