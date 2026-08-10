# ADR 0036 — Current Stripe binding incident admission

- Status: Accepted
- Date: 2026-08-08
- Owners: Security, engineering and operations
- Complements: ADR 0034's current-host postflight
- Supersedes for future admission only: the consumed exact-e4 proof chain recorded by ADR 0024

## Context

ADR 0024 records that the exact-e4 replacement of the exposed managed-sandbox read, effect and
Stripe App signing bindings ended `PASS_CONTAINED`. Its final redacted proof was removed during
cleanup. ADR 0034's independent review then found the consumed chain unsuitable as an input to a
reopening decision and recorded `NO_GO_REOPENING`. That negative review does not relabel the
historical result, but the historical result cannot independently admit the current bindings.

The consumed exact-e4 transition, proof and observation artifacts must remain immutable. The
exact-d096 containment reconciliation is also consumed. Neither family may be patched, installed,
resumed or executed for this gate. The tracked ADR 0034 postflight is the only reusable current-host
observation, and even a `PASS` postflight does not admit a credential or authorize a Stripe proof.

## Decision

Create a new, tracked, one-time admission chain for the three current replacement bindings. It is
an admission of their current state, not another rotation. It never uses an exposed predecessor
credential and never changes an environment file. A mismatch returns `NEW_ROTATION_REQUIRED` and
requires a separately reviewed rotation; the chain does not repair or rotate automatically.

### Inputs and freshness

The local wrapper accepts exactly four ignored, access-restricted inputs:

- the canonical `PASS_CONTAINED_CANDIDATE_PROMOTED` capture produced by the tracked
  contained-candidate promotion successor, bound to the exact candidate revision, source archive,
  release manifest, bundle and provenance statement;

- a post-promotion ADR 0034 postflight capture bound to that same candidate revision, with `PASS`,
  `COHERENT_CONTAINED`, `PASS_CONTAINED`, a closed and unchanged AWS firewall, all containment and
  financial assertions true, and at least 720 seconds remaining;
- a strict redacted Dashboard attestation whose capture window is positive and at most 15 minutes,
  whose capture is no more than two minutes in the future, and which also has at least 720 seconds
  remaining;
- one synthetic-fixture document containing only the managed-sandbox identifiers needed for a
  fully refunded denial target, a fresh refundable card target, two distinct test users, and the
  single fixed effect of exactly one minor unit in `eur` (`amountMinor="1"`, `currency="eur"`).

Promotion is a strict prerequisite, not an admission side effect. The promotion capture must be a
single canonical JSON document, be root-owned mode `0600` on the host and access-restricted at the
local handoff, have kind `refunddesk-contained-promotion`, phase `complete`, and bind the exact
candidate revision and nonce. Its strict UTC `operationStartedAt`, `startedAt` and `completedAt`
prove `operationStartedAt <= startedAt <= completedAt`; only the final invocation from `startedAt`
through `completedAt` is bounded to 900 seconds. A non-resumed promotion requires
`operationStartedAt == startedAt`, while a delayed durable resume may retain an older
`operationStartedAt`. The fresh postflight capture time must be at or after `completedAt`. Its four `inputs` hashes,
database snapshot hash, the complete request/execution/attempt/webhook/mutation/audit totals and
five exact runtime container IDs and `runtime.workerRuntimeMode="incident_admission"` are
validated, and only the redacted provenance hashes, mode and revision are carried forward.
The postflight must have been captured after promotion completed. No binding observation made on
the former active revision transfers to the candidate.

The Dashboard attestation binds the managed-sandbox and platform-test account fingerprints, the
three current candidate fingerprints and these historical SHA-256 values:

| Evidence                             | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| Stripe App signing exposure          | `ab29955376fea135f14646c7b7dcdd512449d1abbd3645c9befaea9246b7395b` |
| Stripe API-key chat exposure         | `791c2832500e59b5147e09add7d429e1c871f92e06f73432559156c0d22f9d2f` |
| Managed-sandbox candidate preflight  | `ec07ef8b14fee601f7339bf8a3837dee0ba3817601fa8330486e758eab10e606` |
| Unintended Stripe CLI authentication | `d51f557fd8f76af871d4a5019eac8e00e4ed465ed487afd05ac6750877ac9da7` |
| Exact-e4 independent negative review | `613f868c80e52b834b7fe33594f590fea1990c52b155eef9dfcbaf9fc7b9fba2` |

It asserts that all four exposed credentials are revoked or expired, both unintended CLI keys are
deleted, request and Dashboard activity were reviewed through the capture time with no unexpected
activity, containment is unchanged and every redaction flag is false. The read replacement row is
active, restricted and not full-access; it has only PaymentIntent, Charge and Refund read access,
has no `refunds.create` or Customer read permission and declares zero unrelated permissions. The
effect replacement row is active, restricted and not full-access; it has only the same three read
permissions plus `refunds.create`, has no Customer read permission and declares zero unrelated
permissions. The App-signing row is current and its predecessor is disabled. A broad or full-access
key cannot become admissible merely by being labelled restricted. A future or scheduled expiry is
not a revocation. Dashboard observation is human evidence; no Stripe CLI command may substitute
for it.

The attestation also carries the exact historical SHA-256 fingerprints retained by the redacted
candidate and App-signing incident artifacts. Each current read, effect and App-signing candidate
must differ from its exposed fingerprint. Because the API-key and unintended-CLI incident records
did not retain every old secret fingerprint, the operator additionally supplies six mutually
distinct SHA-256 digests of the stable Dashboard credential-row identifiers, with exact terminal
states (`revoked` for the four exposed rows and `deleted` for the two CLI rows). These are hashes of
Dashboard record identifiers, never hashes computed by rereading an exposed raw secret. The
wrapper binds this complete projection into the durable operation.

The fixture document is root/operator-only mode `0600`, is never committed, and is transported only
as bounded standard input. Stripe and user identifiers never appear in stdout, stderr, a marker or
the final artifact. The wrapper and runner bind its SHA-256 instead.

### Provenance and transport

Runner, schema, validator, wrapper, the contained-candidate promotion runner and all four ADR 0034
postflight sources must be regular tracked files whose worktree bytes equal their index blobs and
the same clean committed `HEAD`. The wrapper
keeps verified read handles open while the relevant executable or transport consumes those bytes,
records each Git object ID and SHA-256, and rejects replacement, reparse points, unmerged index
entries, alternate heads, dirty sources or an uncommitted source.

Production transport retains the existing exact AWS account, region, Lightsail instance, SSH key,
known-host and closed-firewall contract. AWS, SSH, Git and Node are invoked through pinned
executables, isolated child environments, bounded streaming stdout/stderr and complete process-tree
timeouts. No raw credential is sent from the workstation. Contract mode uses only local fake
executables and documentation-only addresses and is always labelled `FIXTURE_ONLY`.

### Host admission and proof

The runner requires root in production, acquires `/run/refunddesk/operator.lock` exclusively and
holds it until final containment is proved. Before any worker start it validates the candidate
promotion capture and verifies:

- exact active/current/source/release revision and installed source identities;
- root-owned mode-`0600` platform and worker environment files;
- the current read, effect and App-signing fingerprints match the Dashboard attestation;
- Caddy, backup, retention and quiescence-recovery units are stopped;
- TCP and UDP listeners on ports 80 and 443 are absent, live is disabled in files and effective
  runtimes, and no release, maintenance, transition or foreign container is active;
- application work queues, active workflows, unreleased guards and prepared transactions are
  empty. Internal queue-engine jobs are excluded only by the anchored `__pgboss__` prefix.

The five runtime container IDs, images, Compose labels, configuration and effective environment
are revalidated against the promotion proof before every worker start. The worker environment and
`Config.Env` must both carry exactly one
`REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission`; legacy Stripe aliases, predecessor signing
material, cross-scope read/effect keys and any unexpected credential variable are forbidden. The
sentinel database reservation retains the exact harmless stopped-container contract sealed by the
promotion. Inventory errors, missing or duplicate containers and truncated IDs fail before effect.

Incident mode starts PgBoss with scheduling, supervision and LISTEN/NOTIFY disabled and registers
only the four concurrency slots for `refunddesk_refund_execute`. It performs no startup scan,
recovery send, schedule creation, other queue consumption, signed-attestation route or signed
request-authority construction. The standard release path remains `normal`-only; promotion and
admission use this contained mode solely for the one-shot proof, and a later successor must recreate
the worker in normal mode before any authorized reopening.

Only the worker may be started, privately, after a watchdog is ready. Caddy, timers, maintenance,
ports and live remain stopped. The bounded proof models one normal synthetic workflow and must show:

1. the read binding retrieves the allowlisted PaymentIntent and Charge, receives the expected
   permission denial for `refunds.create`, and leaves the Refund set unchanged;
2. the current App signing binding accepts one exact synthetic signed request through the private
   verifier boundary while an unrelated in-memory secret is refused;
3. distinct requester and approver identities create and approve exactly one request; the effect
   binding creates exactly one Refund with the operation's deterministic idempotency key, links it
   immutably, reconciles it terminally and releases the guard safely;
4. replay or ambiguity uses the same persisted operation and idempotency key. No alternative key or
   second Refund is permitted.

The repository contract exercises these semantics only through a fake host. It performs no real
AWS, SSH or Stripe call and is not real incident evidence. A real invocation remains separately
authorized and must use test/sandbox objects only.

The non-secret proof client is streamed into a root-owned mode-`0400` file beneath a nonce-bound
root-only directory in the web container's `/tmp` tmpfs, rehashed and opened without following a
symlink. The Dashboard projection, fixture and current secrets travel only through root-owned
bounded inputs and anonymous stdin, never argv or a named client-source file. The exact client
process has an absolute deadline and is terminated, reaped and proved absent before its source is
removed. All temporary secret inputs are strictly removed and absence is proved before a PASS is
emitted.

The worker is stopped before success or failure output. A failure trap and watchdog perform only
idempotent worker stop/fence actions. Caddy, timers and ingress are never started or opened. After
the remote worker stop/fence, the local wrapper must launch a new independent ADR 0034 postflight,
validate it with the official postflight validator, require the exact candidate revision, closed
and unchanged AWS firewall, `COHERENT_CONTAINED` posture and at least 720 seconds remaining, then
bind its SHA-256 and capture time into the local incident envelope. The runner's own host
`postflight` action is necessary financial evidence but never substitutes for that AWS/SSH capture.
Both stable ADR 0034 captures must report `INCIDENT_ADMISSION` for the release environment and the
effective worker mode.

The remote proof and local capture each carry an exact `postIncidentBaseline` with the eight edge
surfaces `activeFinancialJobs`, `auditEvents`, `mutationReceipts`,
`refundExecutionAttempts`, `refundExecutions`, `refundRequests`,
`unreleasedPaymentGuards` and `webhookReceipts`, plus `snapshotSha256`. The digest is SHA-256 over
the UTF-8 compact recursively key-sorted JSON projection of those eight non-negative integer
counts, without a final LF. The remote value comes from the terminal read-only database snapshot.
The wrapper independently projects the same counters from `captures.b.database` in the official
final ADR 0034 bytes (`mutationReceipts` is projected only from `apiMutationReceipts`), recomputes
the digest and requires exact equality before writing the local capture.
`finalPostflight.sha256`, `capturedAt`, `validUntil`, worker mode and
`postIncidentBaselineSha256` identify that same artifact. A reopening consumer must revalidate
those exact postflight bytes and must not substitute the pre-incident postflight or promotion
snapshot.

The same final postflight must preserve the promotion's PostgreSQL system identifier and each of
its five exact runtime container IDs in both stable captures. The wrapper compares those raw host
observations to the locked promotion proof, then publishes only their six SHA-256 digests under
`finalPostflight.candidateBinding`. A database or container replacement between the remote proof
and the final postflight is therefore incomplete and cannot be transferred to an edge decision.

### Durable state and evidence

A root-owned mode-`0600` marker advances durably and forward-only through `prepared`,
`proof_started`, `proof_observed`, `contained_verified` and `complete`. Each replacement uses an
exclusive temporary file, file fsync, atomic rename and directory fsync. The marker binds the exact
revision, repository head, runner, Dashboard authority projection and fixture SHA-256. The nonce and
Stripe idempotency key are deterministic for that bound operation.

An ambiguous effect leaves the marker at `proof_started`. Resumption accepts only the same bound
operation and same idempotency key, then reconciles forward. It never starts a fresh workflow. A
different fixture, Dashboard authority, revision, runner or marker returns fail-closed. A complete
marker is reusable only to prove that the same operation already completed and that current
containment still holds. `proof_observed`, `contained_verified` and `complete` replays never start
the worker or invoke Stripe; they revalidate the persisted proof and current containment only.

The runner emits exactly one recursively key-sorted compact JSON object followed by one LF, with a
bounded maximum size and closed stderr. The schema has no unknown keys. Diagnostics are allowlisted
codes matching `^[A-Z][A-Z0-9_]{0,63}$`. The final local capture is create-new, redacted and valid
for 15 minutes. Success is exactly:

- process status `0`;
- `result=PASS`;
- `code=PASS_INCIDENT_ADMITTED_CONTAINED`;
- marker state `complete`;
- all binding, proof, containment and redaction assertions true.

The `mutations` object is the cumulative durable history of the bound operation, not the mutations
performed by the current invocation. A complete replay therefore still reports one worker start,
one worker stop, one workflow, one Refund and five marker transitions while performing none of
those actions again.

Status `20` is a complete fail-closed observation, `21` is incomplete or may require the exact
modeled resume, and `64` is usage only. The local wrapper maps every invalid invocation, provenance,
transport or output condition fail-closed and never promotes usage to host evidence.

## Failure and resumption

- A refusal before `prepared` performs no mutation.
- After `prepared`, every caught failure stops and fences only the worker and preserves the marker.
- `proof_started` can resume only the same deterministic workflow. An ambiguous call is never
  retried with a new key.
- `proof_observed` permits only containment verification and forward marker transitions.
- A failed final postflight preserves the complete marker and classifies the gate incomplete; it
  does not reopen a surface or rerun the financial effect.
- If the original Dashboard window leaves less than 720 seconds after a terminal effect, the local
  artifact is `INCOMPLETE/LOCAL_EVIDENCE_LIFETIME_INVALID`. A later invocation supplies a fresh
  Dashboard authority and fresh ADR 0034 postflight for the same stable authority projection, then
  follows the complete-marker no-effect replay path.
- `NEW_ROTATION_REQUIRED` is terminal for this admission design. It never authorizes loading an
  exposed old credential or editing a host environment.

## Verification requirements

Negative contracts cover at least: 719 seconds remaining; future or over-15-minute evidence;
additional or multiple JSON documents; CR, BOM, NUL or missing final LF; mode `0644`; missing or
false redaction; wrong historical hash; malformed AWS port state; injected diagnostic values;
oversized output; source/index/HEAD/OID mismatch; wrong account, mode, revision or binding; a read
key that is not denied; pre-existing application work; public/listener/live drift; requester equals
approver; two workflows or Refunds; changed idempotency key; ambiguous resume; watchdog/worker-stop
failure; normal or divergent effective worker mode; missing, extra, negative, incorrectly hashed or
mixed post-incident baseline counts; final-postflight substitution; non-canonical local capture;
and secret, path, address or Stripe-identifier canaries.

## Consequences

- A retained `PASS_INCIDENT_ADMITTED_CONTAINED` can close only the named three-binding incident gate
  for its exact revision and binding set.
- It does not admit a release, authenticate a CloudFront origin, reopen ingress, keep the worker
  running, restart timers, prove a native browser flow, enable live, publish the App or authorize
  Marketplace work.
- Reopening still requires ADR 0031 origin identity, exact-SHA CI and attested bundle, a fresh
  contained postflight and a separate human authorization.
