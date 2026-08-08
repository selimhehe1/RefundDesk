# ADR 0019 — Exact-e4 contained compromised Stripe credential transition

- Status: Accepted
- Date: 2026-08-01
- Owners: Security, engineering and operations

## Context

Three Stripe credentials used by the exact hosted sandbox revision
`e4cec06068d71afb5c2ac9fc04175bfdfd6756c2` were exposed: the managed-sandbox restricted read
key, the managed-sandbox restricted effect key and the Stripe App signing secret. A full-access
test key was exposed at the same time but has no RefundDesk runtime binding. A later unintended
Stripe CLI authentication created one platform-test and one platform-live CLI key; neither is a
RefundDesk runtime binding.

Containment stopped the worker and public Caddy, stopped backup and retention timers, closed
Lightsail ports 80 and 443, and left live mode disabled. PostgreSQL, verifier and web remained
internal-only. Replacement restricted read and effect candidates passed a read-only admission
probe, but the replacement effect key has not yet produced a Refund and the replacement App
signing secret has not yet passed a hosted request proof.

ADR 0016 normally permits only one restricted API-key binding per same-revision transition and
requires the canonical release. That release restores the public and maintenance surfaces that
must remain stopped during this incident. Three sequential transitions would also create
unnecessary intermediate configurations in which the coupled web and worker credential set is
part old and part new. Its requirement to call an exposed old key to prove denial would reuse
compromised bytes after revocation.

## Decision

This ADR defines one incident-only operational unit for exact revision e4. It supersedes ADR 0016
only for this named transition. It changes exactly these bindings:

- `STRIPE_MANAGED_SANDBOX_READ_KEY` in `/etc/refunddesk/platform.env`;
- `STRIPE_MANAGED_SANDBOX_EFFECT_KEY` in `/etc/refunddesk/worker.env`;
- `STRIPE_APP_SIGNING_SECRET` in `/etc/refunddesk/worker.env`.

No other environment value may change. The full-access test key and the two Stripe CLI keys are
revoked or deleted only in the Stripe Dashboard because no hosted RefundDesk service consumes
them.

### Admission and revocation evidence

The transition remains locked until fixed, root-owned, mode-0600 candidate files and a strict
redacted Dashboard proof are present. The proof binds the pinned managed-sandbox and platform-test
account fingerprints, SHA-256 of the two incident artifacts, candidate preflight and unintended-CLI
artifact, plus SHA-256 fingerprints of all three candidates. It records all of the following:

1. the exposed managed-sandbox read key, effect key, full-access test key and App signing secret
   are expired or revoked;
2. the unintended platform-test and platform-live Stripe CLI keys are deleted;
3. API request logs and Dashboard activity were reviewed and contain no unexpected activity;
4. Caddy and both maintenance timers remain stopped, ports 80 and 443 remain closed, and no raw
   secret, signature, payload, customer data or live data is present in the artifact.

The strict proof also carries `containmentCapturedAt` and `containmentValidUntil` at UTC-second
precision. The validity deadline must be later than capture and no more than 15 minutes later.
Host admission rejects a capture more than two minutes in the future and rejects the proof once
the deadline has passed; freshness therefore survives composition and staging.

Dashboard row state and the associated activity/request-log review are the revocation proof. Old
credential bytes are never copied into a probe, called again or retained merely to demonstrate an
authentication error. This replaces ADR 0016's old-key-denial probe for this incident only.

### Contained transition

One root-only durable journal binds the Dashboard proof, candidate fingerprints, configuration
hashes, container identities, financial safety snapshot, the exact source/Compose/release
contract, the retained bundle and installed manifest, and the image/config identities of all four
stateless services. Under the existing operator lock, the helper:

1. proves exact revision e4; pinned SHA-256 for Compose, release helper, release launcher, shared
   helper, both Caddyfiles, revision marker and release environment; the retained e4 OCI
   bundle/checksum/manifest; exact manifest SHA-256 and installed-manifest equality; pinned
   web/worker/migrate and Caddy image IDs; a streaming docker-save check that binds manifest
   Config digests, tags and layers to the exact bundle; runtime Compose labels; live interlocks;
   stopped public/effect/maintenance surfaces; healthy internal PostgreSQL/verifier/web services;
   and zero active workflow, payment guard, effect job or prepared transaction;
2. builds two candidate environment files by replacing exactly the three authorized bindings;
3. durably records `prepared` before replacing either environment file, then moves forward to the
   candidates and validates the exact Compose configuration; it does not create or restore a
   predecessor credential copy;
4. stops verifier and web, keeps worker and Caddy stopped, and force-recreates exactly verifier,
   worker, web and Caddy with `--no-start`, `--no-deps`, `--no-build` and `--pull never`;
5. starts only internal verifier and web, proves all four stateless container IDs changed,
   PostgreSQL's container ID did not change, the three candidate fingerprints reached their
   intended container environments, application/Caddy image identities stayed invariant,
   verifier/Caddy Compose config hashes stayed invariant, web/worker config hashes changed under
   the exact candidate environment rewrites, and financial counters did not change;
6. stops every known effect-capable Compose service (`worker`, `caddy`, `bootstrap`, `migrate` and
   `maintenance`), rejects any running container outside the exact PostgreSQL/verifier/web ID
   allowlist, and checks both TCP and UDP listeners on ports 80/443;
7. leaves the journal at `awaiting_new_credential_proof` with worker, Caddy, every maintenance
   timer/service and ports 80/443 still contained.

The operational unit is atomic at the incident-policy level, not a multi-file filesystem
transaction. Individual files use durable same-directory replacement. The durable state machine
is `prepared` -> `awaiting_new_credential_proof` -> `finalizing_cleanup` -> `cleanup_complete`,
followed by completion-marker `committing` -> `complete`. `resume` and `recover` are forward-only:
they converge a partially replaced/recreated `prepared` state, idempotently finish cleanup, retire
the journal only after a `committing` marker binds the cleanup-complete journal, and publish no
completion PASS before the marker is `complete`. A failure trap performs direct Docker stops before
any fallible Compose resolution, stops both timers and every related maintenance service, then
reasserts the running-container allowlist and TCP/UDP listener closure. A revoked predecessor
credential is never automatically restored; another replacement set requires a separate security
decision.

### Replacement proof and finalization

Only new candidate credentials may be exercised. Before finalization, a separate redacted proof
bound to the journal must show:

- the managed read key can perform the required PaymentIntent and Charge reads, is denied
  `refunds.create`, and leaves the Refund set unchanged;
- the App signing secret accepts one exact synthetic test/sandbox signed request through the
  private verifier boundary;
- the managed effect key completes one allowlisted card-only synthetic Refund through the normal
  distinct-requester/approver workflow, links exactly one Refund, reconciles idempotently without
  ambiguity, and reaches a terminal state that safely releases the guard;
- the old credentials were not retested, live remained false, and Caddy, timers and ports 80/443
  remained contained.

The worker may run only privately and only for that bounded new-credential proof, then must be
stopped before finalization. Finalization admits the proof, durably records
`finalizing_cleanup`, deletes and verifies absence of all candidate/staging/fixed secret inputs,
records `cleanup_complete`, writes a redacted `committing` marker, retires the journal, and only
then promotes the marker to `complete`. Repeating `finalize`, `resume` or `recover` after any crash
continues that sequence idempotently. It still does not start worker or Caddy, restart timers or
maintenance services, open ports, publish the App, use live mode or submit Marketplace review.
Restoring any public or scheduled surface is a separate authorized operation after independent
review.

## Local implementation state at 1 August 2026 — historical

The ignored local implementation was replaced after independent review found that named write
stages could strand partial files across a power loss. The replacement transport writes credentials,
tools, ciphertext and initial authority records to Linux `O_TMPFILE` file descriptors, validates and
tags those anonymous inodes, fsyncs them, and publishes them with `linkat(AT_EMPTY_PATH)` and
no-replace semantics. The four input members are flat root-only files; their manifest is published
last and is the sole bundle commit marker. There is no decrypted input directory and no named
plaintext transport stage. Unsupported anonymous-file, xattr or link primitives fail before a
service or financial mutation. Redacted journal updates may still use validated `.next` files under
the root-only operator lock; initial journal and completion-marker creation do not.

The frozen transport and transition chain is:

- transition helper `e4-managed-sandbox-secret-transition.staging.remote.sh`, SHA-256
  `25b66b1e540c3c82709d8709236734f08c254d9d9254df4a69b028a1d2c68976`;
- transition validator `e4-managed-sandbox-secret-transition-validator.remote.py`, SHA-256
  `a1ec1772050113d8244cc82511eb611b676415a9c5c7000951119a59ebd2a4e2`;
- transport validator `validate-exact-e4-contained-transition-bundle.remote.py`, SHA-256
  `432f071c12a4e340c33782e2ec3e4cc7adbf04acbc589521b5b713f8d0506e56`;
- transport controller `install-exact-e4-contained-transition-bundle.remote.sh`, SHA-256
  `5a726a73c9f408325978402ccea52a3aa730ec9b8b1d973993d0a39956539cc4`;
- bootstrap `bootstrap-exact-e4-contained-transition-tools.remote.py`, SHA-256
  `4ec62849f439ef9ddab0570222226d533b2ad476b114808980f6fbbd7c374d16`;
- local transport wrapper `transport-install-exact-e4-contained-transition.local.ps1`, SHA-256
  `fd068ac388de3292c2d05a04882476439e64115c99dc0c2ebfa75801a2a942a1`.

The replacement-only proof chain is:

- proof client `e4-managed-sandbox-new-credential-proof-client.remote.mjs`, SHA-256
  `1744f5a1094f8f2047acc778cfc38a5cdd9d42ae01693e47ef15182dda876716`;
- current-containment observation installer
  `install-e4-current-containment-observation.remote.py`, SHA-256
  `5258c21134a25821d0d3a763bf3a0257915ff81f0cc6f94b00f4b049790351eb`;
- proof runner `e4-managed-sandbox-new-credential-proof.remote.py`, SHA-256
  `b325876f2f96362c8c240caf22bc131096f72a2d790bd700a1b5ab7368ad2bf4`;
- proof orchestrator `orchestrate-e4-managed-sandbox-proof.remote.py`, SHA-256
  `d1a943ea838a2ff1116f32266ee5b87b7739e916ddf463b71c9a59abd66b2ab9`;
- proof-tool installer `install-e4-managed-sandbox-proof-tools.remote.py`, SHA-256
  `f46f32cc725250717555824a59674e6b09af0546eb3523deefc9e843d3ef168b`;
- local proof wrapper `invoke-e4-managed-sandbox-proof-orchestration.local.ps1`, SHA-256
  `b649ee7da24eeec9281939e7291b92ec81b93dc96a6ded48f8314ae062919ebb`.

The proof runner publishes its final proof from an anonymous inode after validating the exact JSON
through a proc-fd path. A watchdog acknowledges readiness before the worker restart policy or state
can change, binds the parent PID and `/proc` start time plus exact container identities, and stops
the worker and restores containment if the parent dies or the lease changes. The local wrapper
refreshes the independently captured containment observation before every proof attempt and again
before finalization. Host admission requires at least 720 seconds of the 15-minute observation
window to remain.

Two independent reviews and a separate root rerun produced `GO_LOCAL`. The exact contracts passed
13 proof-client cases, 46 proof-runner cases, 6 observation-installer cases, 18 orchestration cases,
the transport/crash matrix, transition and allowlist contracts, PowerShell 5.1 descendant-process
termination, syntax checks and post-test hash verification. Redacted evidence is
`sandbox-evidence.local/aws/exact-e4-flat-anonymous-transition-proof-local-review-2026-08-01.local.json`,
SHA-256 `5aa768189ed404c844137ddbf8be49d4ac02620f103f6b0999e59a266aa41a82`.

This is local preparation evidence only. The Linux syscalls have not been exercised on the target
host; the artifacts have not been installed; AWS, SSH and Stripe were not called; and no runtime was
transitioned. Dashboard admission, a new App signing-secret candidate and a fresh point-in-time
containment observation remain mandatory before the contained run.

### Execution addendum — 3 August 2026

ADR 0024 supersedes the historical implementation state above. It records that the one-time
exact-e4 transition completed with final `PASS_CONTAINED` and proof hash
`39e9351c387c1bc6316cdc23f507ddc9f073899b4863a1f09d4c0c5621fe7706`, after execution forced
corrections to nine artifacts. The fixed final proof file was removed during the designed cleanup;
the two 1 August incident JSONs retain `IN_PROGRESS_CONTAINED` and are not substitutes for it.

The independent review of the nine corrected artifacts remains outstanding. The consumed helper
must not be installed, resumed or executed again, and this result authorizes no public ingress,
worker, timer, live, publication or later-revision action.

## Consequences

- Compromised old credential bytes are not reused merely to prove revocation.
- The coupled web/worker credential set changes under one durable incident journal while every
  effect, public and maintenance surface remains fail-closed.
- A mid-transition failure can require `resume`/`recover` and may leave internal read-only
  availability degraded. Recovery is idempotent and forward-only; it cannot authorize fallback to
  compromised credentials.
- This ADR authorizes no live mode, customer data, public ingress, scheduled maintenance,
  deployment, Stripe publication, Marketplace action or paid resource.
- The exact-e4 helper cannot be reused for another revision, incident, binding set or candidate
  proof.

## Rejected alternatives

- Three independent ADR-0016 rotations: they create mixed intermediate configurations and would
  use a release path that restores surfaces deliberately contained for this incident.
- The canonical release during containment: it starts Caddy and maintenance timers before the
  incident proof is complete.
- Calling exposed credentials after Dashboard revocation: this unnecessarily reuses compromised
  material and risks retaining it in local tooling or logs.
- Creating or automatically restoring predecessor snapshots: they would duplicate revoked
  credentials and are not a safe runtime target.
- Rotating unrelated application keys or platform-test runtime keys in the same operation: the
  evidence and authorized binding boundary cover exactly three values.
