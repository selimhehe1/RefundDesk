# ADR 0037 — Contained candidate promotion and bounded CloudFront origin window

- Status: Accepted
- Date: 2026-08-08
- Owners: Security, engineering and operations
- Complements: ADR 0031, ADR 0032, ADR 0034, ADR 0035 and ADR 0036
- Supersedes for future edge evidence only: ADR 0029's unadmitted public-window procedure

## Context

ADR 0031 establishes that AWS `CLOUDFRONT_ORIGIN_FACING` prefixes are a generic network filter,
not the identity of RefundDesk's CloudFront distribution. A future edge proof therefore needs both
an exact distribution-to-origin secret and the prefix filter. It must also join the complete
before, during and after state into one canonical artifact; ADR 0029 retained no admissible
artifact with that chain.

The last admitted canonical release is exact e4, while later host repair restored only a
point-in-time contained posture. A candidate cannot be tested at the edge until it has been
promoted without starting effect-capable or public services and has passed a new contained
postflight. Conversely, a successful contained promotion does not itself authorize CloudFront,
Caddy, ingress or a financial delivery. Promotion and the public window are therefore separate
states in one decision, with an explicit authority handoff between them.

The operation is run from Windows PowerShell, but its security-critical state machine requires a
reproducible Linux environment. Depending on an operator's mutable WSL, Git Bash or `PATH` would
not bind the implementation to the candidate. Sending AWS credentials to the Lightsail host would
also collapse the control-plane boundary.

## Decision

### 1. Contained candidate promotion is the first state

The tracked promotion successor installs exactly one attested revision and leaves it contained.
It may run the migration owner and inert verification paths required to establish the candidate,
but it never opens an AWS port, changes CloudFront, starts Caddy or worker, enables backup,
retention or recovery timers, enables live mode, or performs a financial effect.

The promotion journal is durable and forward-only. Before the commit phase, a failure reasserts
containment and retains the journal and evidence. Once phase `committing` is durable, rollback to
the former source is prohibited; a later invocation may only resume the exact candidate forward.
Success is one canonical, root-owned mode-`0600` document with:

- `kind=refunddesk-contained-promotion`, `result=PASS`,
  `code=PASS_CONTAINED_CANDIDATE_PROMOTED` and `phase=complete`;
- the exact `revision`, `fromRevision`, nonce and four externally verified bundle, manifest,
  source and provenance SHA-256 values;
- strict UTC-second `operationStartedAt`, `startedAt` and `completedAt`, ordered
  `operationStartedAt <= startedAt <= completedAt`; `operationStartedAt` preserves the first
  durable attempt across recovery, while the current invocation alone, from `startedAt` through
  `completedAt`, is no greater than 900 seconds;
- five distinct exact container IDs for PostgreSQL, verifier, web, worker and Caddy;
- all nine containment assertions true, including stopped worker/Caddy, stopped and disabled
  maintenance, absent public listeners, disabled live mode and healthy verifier/web; and
- a stable database snapshot containing exact totals for active financial jobs, active workflows,
  API mutation receipts, audit events, live installations, live tenants, prepared transactions,
  Refund execution attempts, Refund executions, Refund requests, unreleased payment guards and
  webhook receipts, plus the PostgreSQL system identifier and the derived snapshot SHA-256.

That capture is consumed only after strict schema validation, an out-of-band file SHA-256 match,
exact revision match and a fresh ADR 0034 postflight captured at or after promotion completion.
The promotion wrapper's durable complete/consumed marker binds its nonce, five input hashes,
promotion evidence SHA-256 and postflight SHA-256. No promotion evidence transfers to another
revision or nonce.

### 2. Edge admission is separate and exact

Before any edge mutation, the window wrapper requires all of the following as canonical,
access-restricted, hash-pinned inputs:

- the successful promotion capture above;
- the exact final ADR 0034 capture referenced by the ADR 0036 incident admission for the same
  revision, with `PASS`,
  `COHERENT_CONTAINED`, `PASS_CONTAINED`, an unchanged closed AWS firewall, every containment and
  financial assertion true;
- a fresh ADR 0036 local incident-admission capture with
  `PASS_INCIDENT_ADMITTED_CONTAINED`, including the remote proof field
  `denialRefundSetUnchanged`, the exact referenced final ADR 0034 bytes, an eight-counter
  post-incident baseline and candidate binding; and
- a separate, time-bounded human authorization naming the exact AWS account, region, Lightsail
  instance, CloudFront distribution and origin, public base URL, revision, event fingerprint and
  maximum window.

ADR 0036 first completes the referenced final ADR 0034 capture and only then seals its outer local
incident capture. Edge admission therefore requires
`postflightCapturedAt <= incidentCapturedAt <= startedAt`; the reverse order, a future incident
capture or any timestamp ambiguity is rejected before the host lease or any external effect.
At the exact edge `startedAt`, both the ADR 0036 incident and its referenced final ADR 0034
postflight must each have between 720 and 900 seconds remaining, inclusively. These are
point-in-time admission proofs with the fixed ADR 0034/0036 15-minute TTL; they are not extended to
cover the later CloudFront waits, armed deadline or terminal `completedAt`. The separate human
authorization alone must cover the armed deadline and the independent 35-minute orchestration
bound measured from durable `operationStartedAt`, never from a later resumed invocation's
`startedAt`. The runner revalidates the exact host, database and containment facts while the host
lease is held before any effect, rather than treating an expired point-in-time capture as a
continuing lock.

The authorization is not synthesized from configuration. Its identifiers are compared with the
current AWS and host observations and carried into evidence only as SHA-256 projections. The
admission and topology projections include the AWS account, AWS region, Lightsail instance,
CloudFront distribution and origin, public URL, SSH host and signed SSH `/32`; evidence also
carries the integer authorization maximum and the validator requires the requested window not to
exceed it. A
promotion or incident admission never implies this authorization. The allowed scope remains the
configured test/sandbox deployment; live mode, customer data, another repository, another paid
resource, Stripe review and Marketplace publication remain prohibited.

Authorization bytes are one canonical JSON line with exact keys `awsAccountId`, `awsRegion`,
`code`, `distributionId`, `eventFingerprintSha256`, `expectedRevision`, `expectedSshCidr`,
`instanceName`, `kind`, `maxWindowSeconds`, `originId`, `publicBaseUrl`, `result`, `schemaVersion`,
`sourceRef`, `sshHost`, `validFrom` and `validUntil`. `schemaVersion` and `maxWindowSeconds` are JSON
integers. The latter is at most 300; the validity interval is at most two hours and must cover the
35-minute orchestration and the armed public deadline. The SSH `/32` is part of the signed bytes,
not an unbound CLI assertion. First use is durably consumed on the host by authorization SHA-256;
another directory, operator or orchestrator cannot reuse it for a second window.

The post-incident baseline, not the earlier promotion snapshot, is the only database baseline for
the edge window. Its exact counters are active financial jobs, audit events, API mutation receipts
projected as mutation receipts, Refund execution attempts, Refund executions, Refund requests,
unreleased payment guards and webhook receipts. Its SHA-256 is recomputed over their compact,
recursively key-sorted JSON projection. The ADR 0036 outer and remote projections and both `a` and
`b` database captures in the referenced ADR 0034 document must all agree. The same two captures
must bind the promotion's PostgreSQL system identifier and five exact container IDs. ADR 0036's
`candidateBinding` contains the raw-UTF-8 SHA-256 of those six values; mix-and-match evidence is
inadmissible.

Every tracked source used by the runner, watchdog, operator image, promotion admission, ADR 0034
postflight or validator must be a regular file whose worktree and index bytes equal the same clean
committed `HEAD`. Open handles, Git object IDs and SHA-256 values bind the bytes consumed by each
transport. AWS, GitHub CLI, Git, Docker, Node, PowerShell and OpenSSH are pinned and invoked with
isolated environments, bounded streams and bounded process-tree termination.

### 3. Reproducible Windows-to-Linux operator boundary

The edge state machine runs in a separate exact-revision operator container image produced by the
`sandbox-images` workflow. It is not a fourth runtime role and is not part of the web/worker/migrate
bundle. The workflow exports five separately hashed inputs for the same exact revision: the exact
Docker `image save` archive compressed with zstd, its SHA-256 sidecar, a canonical image manifest,
the GitHub/Sigstore attestation bundle and a canonical operator-input provenance document. That
provenance binds the exact workflow run ID and attempt, source ref, revision, archive, manifest,
attestation and Rekor entry. The production wrapper verifies every out-of-band SHA-256, the signed
workflow identity and the completed successful GitHub run before `docker image load`.

The input provenance is canonical JSON with no unknown key and exact keys
`archiveSha256`, `attestationBundleSha256`, `createdAt`, `kind`, `manifestSha256`,
`rekorEntryIndex`, `repository`, `revision`, `schemaVersion`, `sourceRef`, `verification`,
`workflowPath`, `workflowRunAttempt` and `workflowRunId`. Numeric fields are JSON integers, not
coercible strings. `kind` is `refunddesk-edge-operator-input-provenance`, `repository` is
`selimhehe1/RefundDesk`, `workflowPath` is `.github/workflows/sandbox-images.yml` and
`verification` is `github-actions-attestation-bundle-issued`.

The wrapper requires Docker 29 or later, verifies the loaded image ID, user, entrypoint, command,
network-independent tool inventory and exact image configuration, and uses `pull=never`. It never
builds or pulls during the operation. `/workspace` in the attested image contains exactly the
commit-bound `PinnedSourcePaths` inventory and no other caller file. The caller repository is never
mounted, so ignored evidence, untracked files and local secrets are inaccessible to the
network-enabled container. The Docker build context is deny-by-default through the
Dockerfile-specific `deploy/lightsail/edge-operator.Dockerfile.dockerignore`; it starts with `**`
and re-includes only parent directories and the exact 30 pinned source files. Its only `.github`
file re-inclusion is `.github/workflows/sandbox-images.yml`, which is itself pinned and baked. A
workflow probe proves one admitted file can be copied while an arbitrary canary beneath a
re-included parent remains excluded before the real image build. AWS
credentials, SSH identity and known-host files are individually mounted read-only into the operator
container; there is no Docker socket. The container receives no AWS credential in SSH argv,
environment or standard input, so the host never obtains it.

Two separately named private Docker volumes enforce the Linux input/state boundary. The state
volume is writable only by UID `10001` at `/var/lib/refunddesk/control`; it contains journals,
requests, checkpoints and terminal evidence. An offline root helper populates the input volume
exactly once with control JSON, transport JSON, SSH config and AWS config, makes the four regular
single-link files `root:root 0444`, makes their exact directory `root:root 0555`, and fsyncs both
files and directory. The main and cleanup containers mount that second volume at
`/var/lib/refunddesk/input` with Docker `RW=false`; neither can rename, truncate or replace an input
after admission. Container inspection requires exactly these two named volumes plus the three
individual read-only credential/SSH binds and rejects every other mount.

The runner has no direct root production mode. Outside the isolated offline test adapter, it
accepts only the local orchestrator contract: non-root UID `10001`, the exact immutable input
paths above, GID `10001`, the exact writable state/runtime paths, and no command adapter or crash
injection.
Consequently, root-owned ad hoc control or transport files cannot bypass the wrapper, provenance,
container or read-only input-volume boundary.

Input failures are phase-sensitive. Before any nonce-bound operation directory exists, malformed
control/transport bytes or a wrong immutable-input layout are usage/pre-effect rejection. Once
that durable path exists, missing or corrupt control/transport/AWS/SSH input, ownership/mode drift
or a no-longer-sealed input directory is recovery ambiguity: the runner returns `21`, preserves
both volumes and the watchdog/lease state, and performs no new open or PASS. It must never map that
post-crash state to usage `64` merely because the immutable input can no longer be parsed.

The Windows filesystem is never mounted as the writable control root. Only a redacted checkpoint
request is copied out. The human checkpoint is created locally with create-new semantics and a
strict ACL, then streamed to an `O_CREAT|O_EXCL` mode-`0600` receiver in the state volume. The final
redacted evidence is copied out only after validation. A successful attempt removes its container,
both volumes and any image loaded solely by that attempt. An ambiguous attempt retains both private
volumes as one recovery set and never claims secret cleanup. A crash before the immutable-input
digests are committed is pre-runner: exact attempt labels permit cleanup of both volumes, but never
creation or resumption of a runner from unattributed input bytes.

### 4. Origin identity is configured before ingress

The state machine generates a new 32-byte base64url token from the operating system RNG. The raw
token is never printed, returned in evidence, placed in argv or copied to the workstation. It is
written only to the root-owned host `caddy.env` and the restricted private operation volume.

Before changing the host environment, the runner durably stores both the exact current CloudFront
distribution configuration and the intended bound configuration. It selects exactly the
authorized origin and installs exactly one custom header named
`X-RefundDesk-Origin-Token`, preserving all unrelated configuration. It updates with the observed
ETag and waits boundedly for status `Deployed`; an ETag race, a second matching origin, a third
configuration state or a deployment timeout fails closed. On recovery, the exact current provider
configuration is authoritative: exact original means restoration already occurred, exact bound is
unbound with its current ETag, and any third state remains ambiguous. A lost or truncated update
response cannot be relabelled as an attributed mutation; cleanup may converge from an exact known
state but the terminal result remains `INCOMPLETE`.

The same strict routing predicate is applied first to the admission observation and again to the
exact `get-distribution` configuration and ETag used by the update CAS. The default behavior and
every ordered behavior target the authorized origin directly. Origin groups, CloudFront Function
or Lambda@Edge associations, custom error responses, staging distributions and continuous
deployment policies are absent, and no Web ACL is attached. Thus neither a stale
admission-to-update race nor an
edge-generated or remapped `200` can substitute another origin for the authorized Lightsail
candidate.

With the AWS 80/443 firewall still closed, Caddy is force-recreated from the exact local candidate
using `--no-build --pull never`, fenced to `restart=no`, and verified by ID, image, labels and
configuration. A local functional test proves missing token `404`, wrong token `404`, correct
token traversal `200`, and a synthetic backend rejection when the token reaches it. Thus the test
observes that the exact public Caddy matcher accepted the header and stripped it upstream; it does
not infer stripping merely from static configuration.

### 5. Prefix and firewall contract

Immediately before the window, the operator downloads the AWS public `ip-ranges.json` over pinned
HTTPS tooling. It accepts exactly canonical IPv4 and IPv6 prefixes whose service is
`CLOUDFRONT_ORIGIN_FACING`, records the upstream document and allowlist SHA-256 values plus
`syncToken`, and rejects empty, duplicate, wildcard, malformed or non-canonical networks.
`createDate` is parsed strictly as AWS UTC format. Relative to the captured `fetchedAt`, it may be
at most two minutes in the future and at most 30 days old; freshness is independently derived by
the validator and is never trusted from an asserted boolean.

The initial firewall must be closed on 80/443 and its SSH rule must exactly match authorization.
Opening adds only TCP 443 for the exact fresh prefix set. Port 80, UDP, wildcard rules and every
other source stay closed; SSH stays byte-for-byte unchanged. The open response and a subsequent
read must match the expected canonical state. Immediately before the open mutation, after the
same-boot monotonic guard, the runner durably records a conservative `openedAt`. That timestamp is
the earliest instant at which the effect may begin, not merely the later successful readback. A
lost acknowledgement or process death after AWS accepts the request therefore remains a
post-open cleanup case with non-null `openedAt`; it can never be relabelled as pre-effect.

### 6. Host interlock and deadline are independent of the operator process

Before origin binding, a revision-and-nonce-bound transient host lease holder acquires the real
`/run/refunddesk/operator.lock` and durably writes a root-owned mode-`0600` edge marker. It keeps
that lock through origin binding, the entire public interval, AWS close, host containment,
CloudFront unbind, after-counts and the new official final postflight. Both `release.sh` and
`recover-quiesced-runtime.sh` check the marker before and again after their own lock acquisition.
They refuse pre-effect while it is held or malformed. Only a canonical `complete` marker is
non-blocking. The runner journals the acquire intent before invoking the holder and derives cleanup
recovery from that durable intent, not from a volatile acknowledgement. A lost acquire response is
therefore resolved by exact marker/status proof, containment and release without a second acquire,
origin bind or ingress. Neither acquisition nor recovery may ever regress a `complete` lease marker
to `held`.

The holder first acquires its nonce-independent `edge-window-holder.lock` exclusively and then
acquires `operator.lock` shared and non-blocking. Both locks are held before either lease authority
is published. It never acquires `operator.lock` exclusively and then converts it to shared: Linux
lock conversion has a release/reacquire gap in which a queued release or recovery mutator could
win. The separate exclusive holder lock serializes edge holders, while the directly acquired
shared operator lock continuously excludes release and quiesce-recovery writers for the holder's
whole lifetime.

Admission under that lease also requires the edge watchdog marker absent, its timer inactive and
disabled, and its service quiescent. The same predicate is repeated immediately before install;
the new marker is created without replacement under the watchdog lock. A residual marker or
enabled unit from any nonce is an unresolved interlock, never an object a later attempt may
overwrite.

After CloudFront has deployed the bound origin, while the Lightsail firewall is still closed, the
runner force-recreates and fully inspects the token-bound Caddy with `restart=no` and leaves it
stopped. It records that exact 64-hex container ID, then writes a durable watchdog marker binding
both that Caddy ID and the exact stopped worker ID before any listener can exist. The arm intent is
journaled before this marker or any service/timer effect. A death after intent or marker creation
but before the arm acknowledgement is cleanup-only: it contains the host, removes the exact marker,
disarms any partial unit state and releases the lease as `INCOMPLETE/21`, never as PASS. The runner enables
the tracked systemd timer with `enable --now`. Its script is installed outside the mutable
`current` symlink and the marker binds its SHA-256. Arm and each tick require exact service/timer
`FragmentPath`, no drop-ins and the exact effective service identity, sandbox and one-second timer
properties. The effective oneshot has exactly one `ExecStart` structure, one exact script path and
one identical zero-extra-argument `argv[]`; a second command in stale systemd state is rejected.
A synchronous real tick, run after releasing the installation lock, writes a
nonce/revision/marker/boot/boottime receipt which repeats the two exact container IDs; timer
activation alone is not pre-ingress proof. Each later tick revalidates those bytes and effective
units. An unchanged healthy marker with an exact receipt does not rewrite or fsync the receipt on
every one-second tick. A marker-binding change is published by a separate process bounded to two
seconds; timeout, short write or fsync failure enters the hard-fence path. Once Caddy is in
`armed_running`, a missing or substituted receipt is never republished from current state and
instead triggers containment. Only after the initial receipt exists may the runner start the same
already-inspected Caddy. Before
opening ingress it proves Docker uses the systemd cgroup driver, `docker.service` is the loaded and
active owner at `/system.slice/docker.service` with a live `dockerd` MainPID, and the exact active
Caddy scope is `/system.slice/docker-<id>.scope`. The watchdog holds no lock across ticks; a forced
invocation waits boundedly for a concurrent tick and fails if it cannot verify containment. The
same host boot ID and `CLOCK_BOOTTIME`-derived observations bind arm, open and close. Wall-clock
rollback, a changed boot ID or either elapsed bound reaching the deadline recontains the host.
Remote installation latency never starts a fresh monotonic window: the host derives its
`CLOCK_BOOTTIME` deadline from the positive seconds remaining until the already durable UTC
deadline, requires that remainder to be between 30 seconds and the original effective budget, and
therefore may only shorten the fail-safe interval. A clock skew that would extend it fails closed.

The authority handoff itself is recorded in evidence provenance, so that neither side of it has to
be trusted on assertion. The operator publishes `operatorStartedMonotonicMilliseconds`,
`operatorDeadlineMonotonicMilliseconds` exactly 2 100 000 milliseconds later, and
`operatorControlCalculatedMonotonicMilliseconds`, the monotonic instant at which it computed the
grant. That instant is at or after its own start and strictly before its own deadline, and the
granted `operationRemainingSecondsAtRunnerStart` never exceeds the whole seconds still left at that
instant less the 240-second handoff reserve. An operator whose own clock has advanced therefore
grants less, never more, and can never grant budget it no longer holds.

The runner records the same handoff on `CLOCK_BOOTTIME` as `runnerBootIdentifierSha256`,
`runnerStartedBoottimeMilliseconds` and `runnerDeadlineBoottimeMilliseconds`, whose span never
exceeds the granted seconds. `CLOCK_BOOTTIME` keeps running across suspend but restarts at zero on
reboot, so a rebooted host cannot present a still-valid runner deadline, and a wall-clock rollback
cannot lengthen one. The boot identity ties that span to the same boot as the durable watchdog
arm/open/close identity. The runner enforces these relations from the control document before it
acts; the Windows wrapper's validator re-derives them independently from the published bytes, using
the same truncating whole-second arithmetic so that neither bound is looser than the other. A
document whose grant, monotonic instants or boot-time span disagree is rejected, never repaired.

The authorized window is between 60 and 300 seconds from watchdog arm, not from the start of a
potentially slow CloudFront deployment. The durable fail-safe deadline is deliberately 30 seconds
earlier than that authorized maximum. It therefore includes Caddy start, the local origin
probe and the firewall-open interval and leaves a non-spendable containment reserve. The timer
ticks every second with one-millisecond accuracy; at its conservative deadline it fences and stops
Caddy before any durable marker write, Docker inventory, graceful stop or unrelated unit. The
deadline path immediately kills the exact pre-armed Caddy scope, reads all four public sockets in
one process-group budget, and on any survivor or ambiguity runtime-masks and stops `docker.socket`
before killing all Docker scopes plus `docker.service`/proxies and repeating that aggregate
readback. No Docker API call is permitted after that broad fence, so socket activation cannot
restart dockerd or recreate a proxy during the same containment attempt. It then kills the exact worker scope
before entering the slower full containment/proof pass. The additive hard-fence command budget is
strictly below the 25-second guard, including TERM-ignoring helpers and their KILL grace. Each tick
parses the marker and reads both clocks before effective-unit
introspection. At or within 25 seconds of the conservative deadline it starts Caddy-first
containment immediately; otherwise it reads every effective service property in one bounded call
per unit, re-reads both clocks, and may only then prove the existing exact receipt or perform the
single bounded pre-ingress publication described above. At or after the conservative deadline, or for a missing, malformed or
temporally unreadable marker, the watchdog best-effort stops and restart-fences every exact worker
and Caddy container, disables and stops both maintenance timers, stops all maintenance services
and release/fence units in every non-inactive state, and verifies the timers disabled and TCP/UDP 80/443
listeners absent. It inventories stopped containers too, so `restart=always` cannot hide behind a
stopped state. Failure of one stop never skips the remaining fence actions.

Missing or malformed authorities, failed prerequisites, unsafe control/runtime directories and a
forced tick all execute the deadline hard fence and full physical containment before writing any
trigger sentinel or synchronizing it. Sentinel persistence is best-effort and process-group
bounded after the public and financial surfaces have been fenced; a blocked filesystem sync can
never delay Caddy, worker or the four listener readbacks.

If Docker's API becomes unavailable after that exact scope proof, the watchdog cannot infer safety
from the failed daemon call. It first kills the pre-armed Caddy and worker scopes through PID 1,
then runtime-masks and stops `docker.socket`, kills every loaded `docker-*.scope` in one bounded
systemd call and kills/stops `docker.service` to terminate any `docker-proxy` outside the container
scope. It makes no later Docker API call and finally requires
the independent `ss` readback to show all TCP/UDP 80/443 listeners absent. Immediately after the
Caddy group, before worker, maintenance or release-unit work, it reads all four TCP/UDP 80/443
sockets; a survivor or unreadable socket triggers the broad scope/daemon fence and a second
four-socket readback within the containment reserve.
Each later `contained` tick first proves, without contacting Docker, whether `docker.socket` is
still runtime-masked/inactive (including systemd `LoadState=masked`) and `docker.service` remains
inactive. If so, it preserves that broad
fence and refreshes only from the nonce-bound receipt, exact systemd scopes, units and `ss`; it
never reconnects to Docker merely to synchronize the marker/receipt pair. The socket and service
remain off until an explicit recovery outside this window contract.
Every `ss`/adapter producer is cut at one byte while it runs; non-empty output, overflow, timeout
or pipe failure all mean unsafe/unknown rather than absent. The final four-socket readback remains
mandatory. A malformed marker is
never an identity source: the separately canonical, exact-schema, root-owned, single-link receipt
supplies the two scope identities even if the primary marker is subsequently missing or malformed.
If both identity documents are invalid, the all-scope and daemon fences still execute. This broad
daemon fence is deadline-only recovery: it can never produce PASS, it keeps
the attempt incomplete and its interlocks/recovery material retained until exact cleanup is
re-established. Docker inventories are capped while read at 16,385 bytes and 64 IDs; overflow or
truncation is never iterated or forwarded as argv and takes the same exact-scope/daemon fence.

The overall successful orchestration is separately bounded to 35 minutes, covering two bounded
CloudFront `Deployed` waits, the public interval and a final-postflight wait of at most 300 seconds.
Slow CloudFront binding cannot consume or extend the 300-second public interval.

### 7. Functional gate is created during the open interval

The Workbench attestation path must not exist before opening. Its parent has a strict operator ACL.
After `ingress_open`, the runner emits a canonical redacted request binding the operation nonce,
revision, authorized event fingerprint, opening time and deadline. The wrapper waits only until
the deadline for a human-created `O_EXCL` checkpoint. A pre-existing file, overwrite, rename race,
wrong nonce/fingerprint/revision, timestamp outside the interval, duplicate document or missing
final LF fails closed.

After appearance, the runner opens the checkpoint once with no-follow semantics, verifies the
path and open descriptor identify the same regular mode-`0600` file, reads a bounded byte snapshot,
rechecks descriptor and path identity, and validates, hashes and transports only that immutable
snapshot. The private mode-`0400` snapshot is published with the same durable no-replace protocol
as the final postflight snapshot and remains in the operation volume until terminal volume GC. A
retry always consumes an existing snapshot before considering the mutable checkpoint pathname,
including when the process died before the checkpoint facts were journaled. It never republishes
the Workbench event or parses the mutable pathname a second time.

The checkpoint represents a Stripe Workbench replay, never a Stripe CLI command. It must attest a
public HTTP `200`, `duplicate=true`, the exact event fingerprint and no new durable effect. The
runner compares repeatable-read, read-only PostgreSQL snapshots before, during and after the replay
for Refund requests, Refund executions, Refund execution attempts, webhook receipts, mutation
receipts, audit events, active financial jobs and unreleased payment guards. The exact PostgreSQL
container ID is inherited from promotion and revalidated; a familiar container name is not
sufficient. All eight totals remain unchanged and active jobs/guards remain zero.

Public health must traverse the authorized CloudFront distribution, return `200`, match the exact
revision and be non-cacheable. Neither a local curl nor the synthetic Caddy test substitutes for
the Workbench replay.

### 8. AWS-first close, secret restoration and final evidence

Cleanup always attempts removal of the exact authorized TCP-443 rule first, then a bounded number
of every other observed AWS 80/443 rule within one global cleanup budget. Oversized, malformed or
excessive inventories never defer that first exact close attempt. Only an exact bounded read-back
of the original closed firewall permits progress toward completion. Any additional dangerous rule
observed after the exact open is removed but permanently invalidates the CloudFront-only exposure
claim; returning to the closed baseline permits cleanup and interlock release only as
`INCOMPLETE/21`, never PASS. The host is then contained immediately,
before waiting for a potentially slow CloudFront unbind. Caddy therefore cannot remain active
during that wait. Host containment fences and stops the exact prepared Caddy identity first and
the exact worker identity second, before maintenance units and independent listener checks. Any
additional Caddy or worker inventory is capped at 16,385 bytes and 64 validated IDs and uses
fixed-time bulk operations; overflow is never iterated or forwarded as argv, does not skip later
barriers and makes the attempt incomplete. Any inventory, bulk-operation or stopped-state
ambiguity additionally kills every loaded `docker-*.scope` and `docker.service` in bounded time
after runtime-masking and stopping `docker.socket`, and forbids every later Docker API call before
those later barriers, so an unknown worker or listener-bearing drift container cannot
survive merely because Docker's inventory was unusable. A non-empty or unreadable first TCP/UDP
80/443 listener readback triggers that same broad fence even when Docker reports the exact
containers stopped; all four sockets are then read again and any survivor keeps the attempt
incomplete. Once that broad fence runs, host containment preserves the existing marker/receipt
pair and does not start a new watchdog tick merely to refresh its hash; such a child would reset
its process-local Docker fence and could reconnect to the masked-or-ambiguous socket. The attempt
therefore remains recovery-required with those authorities retained. CloudFront is restored only when its current
configuration equals exactly the recorded original or bound state; any third state is ambiguous.

After exact unbind, the original host `caddy.env` is restored without ever downloading its values.
With the firewall closed, Caddy is force-recreated inert with that restored environment, fenced to
`restart=no`, and verified stopped with the expected ID, image and configuration. The runner then
records a private canonical status receipt binding the exact restored ETag and configuration,
transient-token digest, final Caddy ID, nonce and revision. That receipt is never projected into
evidence. It then durably removes every restricted operation file that could contain original or
replacement custom header values, removes the host backup, and scans for a token canary before asserting
`tokenFileRemoved` or redaction. On ambiguity those files remain restricted for exact resumption
and cleanup is not asserted. The bounded canary scan is repeated immediately before every GC or
PASS attempt; after GC, the private status receipt's transient-token SHA-256 detects any copied
43-byte canary without retaining the raw token. A historical successful-scan fact is never replay
authority after a process death.

The scan includes the bounded root-owned `/etc/refunddesk/.caddy.env.*` candidate namespace used
by the host rewrite. Any candidate left by process death before the atomic `caddy.env` replacement
is removed and the directory is synced while the transient token canary is still available;
unknown ownership, links, excessive cardinality or any remaining occurrence is incomplete.

Before any recovery-material GC and again on every replay before PASS, a status-only operation
re-reads CloudFront and requires `Deployed`, the exact restored ETag and exact configuration. It
also verifies the inert host Caddy metadata and proves its environment contains the restored token
rather than the transient token. The private receipt preserves these comparisons after raw
provider documents are removed. From the durable GC intent onward, or whenever raw provider
documents are absent after an origin effect, that exact receipt is mandatory. Missing, linked,
malformed or corrupt receipt bytes are lost attribution and cannot be recreated by treating the
current header-free provider state as a new baseline, even when it otherwise appears unchanged.
This operation never updates CloudFront or recreates Caddy; a
post-unbind rebind, third state or host-token replacement is incomplete and retains recovery state.
The same status-only check is repeated after the potentially 300-second official-postflight wait
and immediately before `contained_verified`, so a provider rebind during that wait cannot inherit
the earlier receipt. After watchdog disarm and the last provider/host status, a second current
post-GC canary scan runs at the terminal boundary before PASS bytes or lease consumption; residue
created during the postflight wait therefore makes the attempt incomplete even though the earlier
pre-GC scan succeeded.

The after-count snapshot and a newly launched official ADR 0034 capture execute while both the
watchdog and host lease are still active. The official capture must validate the exact candidate,
closed and unchanged AWS firewall, disabled live mode, contained host, exact source/provenance and
redaction. Its request is a canonical create-new document carrying `requestedAt`, the host boot-ID
SHA-256 and `requestedBoottimeMilliseconds`. That boot identity must equal the durable watchdog
arm/open/close identity, and the request boottime must be at or after the exact monotonic close
observation. The result must appear within 300 seconds by both UTC and that same host
`CLOCK_BOOTTIME`; a reboot, wall-clock rollback, pre-existing late result or capture timestamp
after that bound is never accepted. A runner-local observation is not the final postflight. Only
one `O_NOFOLLOW`/`O_CLOEXEC` descriptor supplies the bounded canonical capture bytes to a private
mode-`0400`, create-new, fsynced snapshot. The full official ADR 0034
`validate-lightsail-postflight.mjs` schema, derived-summary and result-semantics validation, the
incident envelope validator, containment projection, candidate/baseline joins and evidence SHA-256
all consume those exact bound bytes. The snapshot remains mode `0400` in the private operation
volume until terminal volume GC; after process death a retry consumes that snapshot before it ever
considers the mutable capture pathname. Publication uses Linux `renameat2(RENAME_NOREPLACE)` and
fsyncs the fully written pending entry's containing directory before the rename and the published
directory entry after it. Recovery also recognizes the only prior hard-link publication
boundary: exactly one pending mode-`0400` name and the destination must identify the same inode
with link count two; it unlinks that pending name, fsyncs the directory and requires destination
link count one before parsing. A unique fully written pending file from a crash before rename may
be promoted with the same no-replace primitive. Multiple pending names, a different inode, link,
owner, mode or non-canonical bytes fail closed.
Both Node validation processes run in a 30-second process group with TERM followed by KILL, and
their stdout is cut at 4,097 and 524,289 bytes respectively while it is produced. Timeout,
overflow or a child that survives TERM is incomplete and cannot delay physical cleanup
indefinitely.

If a reboot, boot-ID mismatch or monotonic-clock failure has already made PASS impossible, cleanup
does not launch a new final ADR 0034 request tied to the lost boot. Its final-postflight probe stays
explicitly unobserved/false while AWS, origin, host, watchdog and lease cleanup continue with boot
enforcement disabled only for the safe `INCOMPLETE/21` path. Only after the normal
final-postflight checks pass does the journal remain in the physically contained, non-PASS
`ingress_closed` state. While the host lease is still held, the runner takes the watchdog lock,
disables the timer and any in-flight service, verifies both quiescent, and removes the marker under
that same lock. It then repeats the status-only CloudFront and inert-host Caddy read and the current
post-GC secret scan; a rebind, host-token drift or residue during disarm is incomplete. After the
terminal timestamp and temporal bounds pass, it embeds the exact canonical PASS candidate and its
SHA-256 under `contained_disarmed_pending_validation`, still a nonterminal state. The pinned public
validator consumes only those immutable bytes. Only validator success advances the journal to
`contained_verified` and publishes the derived evidence pathname; a crash during validation
restores and revalidates the same embedded candidate. Validator rejection is durably latched as
`OFFICIAL_VALIDATOR_REJECTED` and exact complete `FAIL/20`. Clock, boot, watchdog-continuity,
authorization or temporal failures retain their allowlisted factual reason and exact
`INCOMPLETE/21`; a later retry cannot erase or relabel that cause. Only then does the runner make both the host-lease
and authorization-consumption markers canonical `complete`, signal
the holder to release `/run/refunddesk/operator.lock`, and preserve the durable complete marker.
Immediately before the first PASS-capable completion, the host independently captures its current
UTC instant and refuses to write either marker unless it is between the evidence completion time
and the earliest of the 35-minute operation limit, authorization expiry and final-postflight
expiry. The incident and admission-postflight TTLs were consumed only at edge admission and do not
become terminal bounds. Existing partial/complete markers must carry timestamps in that same
interval. The runner repeats the current-time guard after remote
finalization and again after the last public validator immediately before its local complete
marker; crossing a bound at any slow boundary produces `INCOMPLETE/21`, never a backdated PASS.
Completion, release and final lock-status checks are idempotent: a crash between the two marker
replacements or immediately after watchdog disarm resumes the same nonce without reopening.
If process death leaves historical PASS bytes in `contained_verified`, replay repeats the
status-only CloudFront/inert-Caddy observation, the current post-GC canary scan and watchdog boot
guard before either completion marker. It also requires the replay observation to remain within
the 35-minute operation bound and the authorization and final-postflight validity intervals, then
revalidates the exact evidence against the updated
facts. Drift, residue or expiry makes the replay
cleanup-only `INCOMPLETE/21`; it may restore and release safe surfaces but never consumes the old
bytes as PASS.

Every terminal document carries `interlocksAtCapture`, a point-in-time projection of the exact
authorization marker, host-lease marker, holder activity and watchdog marker state. A PASS
candidate is built and publicly validated while both authorization and host-lease markers are
`held`, the holder is active and the watchdog marker is `complete`; only afterward may the runner
write the two completion markers and release the holder. The immutable candidate never claims a
release that had not yet occurred. If the final provider read detects a rebind after physical
watchdog disarm, the runner emits only narrow `INCOMPLETE/21`: AWS is exactly closed, the host and
listeners are contained, the watchdog is truthfully complete, but both authorization/lease markers
remain `held` and the holder remains active. That profile is admissible only with the exact held
projection and complete final-postflight/count/database facts; it can never PASS or release either
lease.

The watchdog boot identity is rechecked under the disarm lock, before both completion markers,
before holder release and in final lock-status proof. A reboot after the official postflight or
after watchdog disarm therefore yields safe `INCOMPLETE`, never a stale PASS.

If the final AWS state is not exactly the original closed baseline, the timer, watchdog marker and
held host lease are never removed or disarmed. Every later tick continues to recontain a newly
started surface until exact cleanup proves closure. If an individual close response or the initial
inventory was ambiguous but the final read-back proves that exact baseline, cleanup may remove
secrets and release interlocks, but the lost attribution remains `INCOMPLETE`, never PASS. A local
crash at any phase leaves the independent holder and watchdog able to block or re-fence
release/recovery. Re-running an already complete nonce performs no origin, firewall, service or
CloudFront mutation; the complete result is consumed rather than reopened.

The local journal and source admission are also phase-sensitive. A fresh invocation whose pinned
source set is invalid fails with status `20` before it creates an operation directory or performs
any external effect. Once that durable directory exists, a missing marker, invalid embedded-facts
digest, unsafe directory mode or unreadable journal is an unattributed recovery set and returns
only `INCOMPLETE/21`; it is never called a complete failure. If the journal is still canonical but
the source/provenance set drifts after a crash, the already-loaded image-baked runner restores the
minimal monotone facts first, permanently disables PASS, closes AWS first, contains the host,
disarms the watchdog and completes/releases only the exact lease markers. It returns `21` without
publishing an evidence document whose provenance assertions are known false and never reopens or
launches a final postflight.

The incident-admission candidate binding records the pre-window Caddy container ID. Because origin
bind and restoration intentionally force-recreate Caddy, the final official ADR 0034 capture may
contain a different Caddy ID. PostgreSQL, verifier, web and worker IDs and the database system
identifier must still equal promotion exactly. The final Caddy ID must be identical in captures
`a` and `b`, distinct from the other four IDs, and bound to the exact promoted Caddy image,
configuration, labels, stopped state, `restart=no` fence and restored token-free environment. Edge
evidence carries both the pre-window promotion Caddy digest and the final Caddy digest; it never
silently transfers the old ID.

### 9. Evidence and exits

The runner emits at most one recursively key-sorted compact JSON object followed by one LF, no
stderr, and no more than 256 KiB. The schema rejects unknown keys. Diagnostics are allowlisted
identifiers. Redaction explicitly excludes raw secrets, API keys, signatures, payloads, customer
data, Stripe identifiers, arbitrary paths, IP addresses, stderr and key-derived digests.

Success is exactly process status `0`, `kind=refunddesk.lightsail.edge-window`, `result=PASS`,
`code=PASS_EDGE_WINDOW_RECONTAINED`, state `complete`, window at most 300 seconds, all containment
assertions true, exact AWS close, origin restoration, unchanged counts, official final postflight
and an immutable held-at-capture interlock projection followed by separately verified durable
completion/release. Status `20` is a complete fail-closed observation, `21` is
incomplete or requires exact cleanup/resumption, and `64` is usage only. No failure or ambiguity
authorizes a second public window.

For any status-`20` document that projects an origin or ingress effect, “complete fail-closed”
requires the exact closed AWS baseline, all four host-containment assertions, exact CloudFront
restoration, transient-token removal, physical watchdog disarm and marker completion. A false
origin/token/watchdog assertion is necessarily recovery-bearing status `21`; setting a failure
label cannot substitute for those facts. The same origin/token requirement applies when an origin
effect is projected before `openedAt`, including a lost firewall-open acknowledgement.

After physical watchdog disarm is positively proven, but while the host lease remains held and
before either the host-lease or authorization-completion marker can consume the authorization as
PASS, the runner embeds provisional canonical evidence under
`contained_disarmed_pending_validation` and invokes the same pinned public edge schema and
validator with process exit `0`, exact nonce, revision and time bounds. The validator reads the
embedded authority bytes once from a producer-capped standard-input descriptor and rejects input
after 256 KiB; it never reopens the derived evidence pathname.
Only validator success may
publish the evidence pathname and advance the journal to `contained_verified`. PASS evidence
therefore carries the required `watchdog.disarmed=true` fact without permitting either durable
completion marker to advance first. Any mismatch disables PASS, removes the provisional file and
durably records its allowlisted terminal reason and exact `20`/`21` classification before any later
crash point, then converges only to a safe failure result. The Windows wrapper then validates the copied bytes
independently; neither validation substitutes for the other.

Every terminal run marker embeds the exact canonical evidence object and its SHA-256 before stdout
is exposed. On replay, that journal copy is authoritative over the derived `evidence.json`
pathname: an absent or substituted file is atomically reconstructed, while validation,
publication and stdout all consume only the same embedded authority bytes and SHA-256. No pathname
rehash or reread after validation may replace that authority. Replay then emits the embedded exit
exactly (`0`, `20` or `21`) with zero remote operation. If reconstruction or
validation cannot be proven, replay returns `21`; it never changes an embedded `INCOMPLETE/21`
into `FAIL/20`, nor lets a corrupt convenience file suppress an already-complete PASS.

## Verification requirements

The offline contracts use only fake AWS/SSH/host/Workbench behavior. They cover missing, wrong and
correct origin tokens; exact Caddy header-name binding; ETag races; CloudFront never reaching
`Deployed`; stale, future and malformed prefix documents; wildcard, port-80 and UDP rules; close
ambiguity, lost bind/unbind/close acknowledgements and bounded excessive-rule cleanup; stopped `restart=always`
containers; release/fence units in transitional states; blocked stops and forced-lock collision;
missing, invalid and temporally unreadable watchdog markers; one-second timer cadence with
Caddy-first bounded containment; process death after every mutation boundary and after
`contained_verified`; a killed runner at deadline; a reboot model; Workbench create-new races;
wrong duplicate/count assertions; oversized output; secret canaries and residual Docker config;
exact source/index/HEAD mismatches; promotion/postflight/authorization drift; systemd drop-ins and
effective-unit drift; immutable-input replacement attempts; massive container-inventory drift;
crash recovery of both pending-only and two-link immutable snapshots; and successful-nonce replay
with zero opens or mutations.
The timing matrix uses real 15-minute ADR 0034/0036 TTLs: 719 seconds remaining is rejected, 720,
899 and 900 are admitted, and 901 is rejected. It also proves those point-in-time inputs may expire
during an otherwise authorized 35-minute orchestration. Receipt recovery rejects a canonical
second-inode pending authority before any healthy-heartbeat fast path, and a provider rebind after
watchdog disarm is validated only as the narrow held-lease `INCOMPLETE/21` profile above.

The PowerShell contract must fail its own process on any assertion failure. It proves the Windows
production path uses the separately attested Docker image archive, separate immutable-input and writable-state volumes, the
image-baked source allowlist and isolated read-only credential mounts, with no caller-repository
bind, implicit WSL, mutable `PATH`, Docker socket or AWS credential transport to SSH.

## Consequences

- Promotion evidence and edge evidence remain distinct even though this ADR orders both state
  machines. A contained promotion cannot be described as an edge pass.
- The generic CloudFront prefix filter is retained as defense in depth, while the exact custom
  origin header establishes distribution-to-origin identity.
- A successful bounded proof closes only the exact authorized test/sandbox edge gate for its
  revision, nonce and evidence interval. It does not establish continuous availability or current
  state after the capture.
- Worker, Caddy, timers, listeners and AWS 80/443 return to the contained posture. Live mode stays
  disabled.
- No outcome under this ADR authorizes production, customer data, a paid expansion, Stripe review,
  Marketplace publication or a retry after an ambiguous window.
