# ADR 0035 — Exact-8da contained quiescence reconciliation

- Status: Accepted
- Date: 2026-08-08
- Owners: Security, operations and engineering
- Supersedes in part: ADR 0015's full-availability recovery requirement for the one unresolved
  exact-8da quiescence journal
- Complements: ADR 0034's read-only host postflight

## Context

The final committed-HEAD ADR 0034 postflight observed active sandbox revision
`8da280b78a9d1475c7bd79063e72c5af77121e8d` in a coherent but non-contained state. Worker, public
Caddy, both maintenance timers and host TCP listeners on ports 80 and 443 were active. A durable
runtime-quiescence journal was also present. The AWS edge remained closed, live mode was disabled,
and two database snapshots were stable and financially quiescent. That artifact was a short-lived
point-in-time observation and is not reusable as mutation admission.

ADR 0015's normal recovery path cannot reconcile this incident safely. The stable recovery service
starts worker and Caddy, requires public-origin and CloudFront verification through ports 80 and
443, and clears the journal only after all five services pass. ADR 0031 and the credential-incident
boundary prohibit that ingress window. With the AWS edge closed, the verification would fail after
starting effect-capable and public services, leaving the journal unresolved.

Merely stopping worker, Caddy and maintenance restores a safer posture, but retaining the journal
indefinitely leaves boot-wired recovery able to restart them and leaves every release and
maintenance operation blocked. Deleting or editing the journal by hand would discard the durable
recovery obligation without proving the state it protected.

## Decision

Create a new, one-time, exact-8da contained reconciliation chain. It is a host repair, not a
release, maintenance pass, credential proof, ingress authorization or availability claim.

- The local wrapper first requires a fresh, committed-HEAD ADR 0034 postflight with at least 720
  seconds remaining. Initial admission requires exact active revision `8da280b7...`, the six known
  containment diagnostics, a closed and unchanged AWS firewall, live disabled, stable/quiescent
  financial snapshots, exact runtime identity, and no active release or fence.
- The wrapper requires its own bytes, the runner, validator and schema, and the four ADR 0034
  source files to match both the index and one committed `HEAD`. It also pins the local AWS,
  OpenSSH, Git and Node executables. It uses isolated child environments, bounded streams and
  timeouts, the existing exact SSH identity/known-host contract, and exact AWS account, region,
  instance and firewall checks before and after the remote operation.
- The remote runner is pinned to active revision
  `8da280b78a9d1475c7bd79063e72c5af77121e8d`. It verifies the canonical `current` source,
  `ACTIVE_REVISION`, release environment, installed manifest, image identities and the exact
  revision-owned Compose, `_common.sh` and journal-helper bytes before mutation.
- The runner acquires `/run/refunddesk/operator.lock` exclusively and holds it through final
  verification. It refuses every active release/fence unit or runtime marker, release/application
  transition, backup-upload journal, managed transition, unknown container, unreadable inventory,
  live interlock or financial-work state.
- The only service mutation is fail-closed containment. It stops the five backup, retention and
  quiescence-recovery units; requires the bootstrap, migrate and maintenance containers to be
  absent; validates and fences only exact worker and Caddy containers; disables restart on those
  two containers; and never starts or recreates a service. Once admission arms the containment
  fence, a failure trap repeats only those stop and fence operations.
- The runner requires exactly PostgreSQL, verifier and web to remain running and healthy with
  stable container identities. Worker and Caddy must be stopped, every maintenance unit inactive,
  TCP and UDP listeners on ports 80 and 443 absent, and both file and effective-runtime live
  interlocks false.
- Two bounded, read-only PostgreSQL snapshots must be identical. Active financial workflows,
  unreleased payment guards, application Refund jobs in `created`, `retry` or `active`, live
  tenants, live installations and prepared transactions must all be zero. Total request and audit
  counts must not change.
- Both `backup` and `retention` journals require the existing harmless stopped database-owner
  reservation to be exact. This successor never removes or recreates that reservation and refuses
  every bootstrap, migrate or maintenance one-shot, even when stopped. An invalid reservation
  therefore fails before journal retirement and requires a separately reviewed successor. No
  application table, backup object, archive, container or customer datum is created or deleted.
- A separate root-owned mode-`0600` reconciliation marker advances durably and forward-only through
  `prepared`, `contained_verified`, `quiesce_cleared` and `complete`. Each transition creates a
  temporary candidate without clobbering an existing candidate, then uses the pinned helper's
  atomic durable replacement with file-and-directory fsync. It is bound to the revision, operation
  and runner SHA-256. `prepared` also binds a canonical admission-invariant digest covering exact source,
  five container identities, live bindings and the full database snapshot while excluding only
  the stop-progress fields. `contained_verified` and every later phase bind a second canonical
  digest of the complete contained capture except its timestamp and retired journal. Crash recovery
  accepts only the immediately valid predecessor state and must recompute both applicable digests.
- Only after `contained_verified` may the runner invoke the pinned journal helper's
  `clear-quiesce` operation with the exact journal operation and revision. A crash after durable
  unlink but before the next marker transition is recovered from the marker plus journal absence;
  no old state is restored and no service is started.
- The runner preserves the admission capture separately from both contained snapshots and the final
  capture, so its validator can prove that stopping services did not mask a core or database change.
  It emits one bounded, canonical, exact-schema JSON object. It contains only allowlisted
  codes, booleans, counts, timestamps, the nonce, revision, operation, public provenance digests
  and the allowlisted container/image digests required to derive identity stability. It closes
  stderr and must not emit paths, addresses, external or account identifiers, logs, payloads,
  signatures or secret-derived material.
- Mutation counters distinguish the current invocation from the durable operation: unit-stop,
  restart-fence and actual container-stop counts report unique successful effects in this invocation,
  including the emergency fence; marker-transition and journal-clear counts report the cumulative
  operation proven by the bound forward-only marker. Reservation reconciliation is always zero. A
  resumed invocation never claims a container stop that it did not execute.
- Success requires marker state `complete`, the original quiescence journal absent and all
  containment/financial assertions still true. The independent postflight then must return
  `PASS`, posture `COHERENT_CONTAINED` and code `PASS_CONTAINED` with the AWS firewall closed and
  unchanged. Its short validity remains point-in-time only.

The one-time runner is not installed as a general host command. The consumed exact-e4 tooling
remains immutable and must not be reused. No step opens ingress, calls Stripe, enables live mode,
starts a timer, starts worker/Caddy, changes application configuration, releases a revision or
creates a paid resource.

## Failure and resumption

- Once admission has armed the containment fence, every caught failure before `contained_verified`
  preserves the original quiescence journal and repeats the stop fence for all effect-capable and
  public surfaces. A refusal before admission deliberately performs no such mutation.
- A crash may leave any monotonic subset of maintenance, Caddy, worker and listener shutdown
  complete. A fresh ADR 0034 postflight may admit that partial posture only when exact source,
  core identities, database snapshot, live interlocks, journal and AWS firewall remain bound and
  every changed surface moved strictly toward containment. The same runner then repeats only
  idempotent stop/fence operations.
- After `contained_verified`, the only permitted forward mutation is exact journal retirement and
  marker advancement. Ambiguous transport output never authorizes a second fresh operation; a new
  postflight plus the same pinned runner must reconcile the durable marker.
- If the journal is absent without the exact successor marker, or the marker, source, revision,
  operation, hashes, runtime identities, financial counts or live state diverge, stop with no
  journal fabrication or service restart.
- A failed final postflight does not roll back containment. Preserve the marker and evidence,
  classify the repair as incomplete, and investigate without reopening ingress or starting
  effect-capable services.

## Consequences

- The historical backup or retention invocation remains failed/reconciled; journal retirement
  does not turn it into a maintenance `PASS`.
- A final contained postflight closes only this host-repair gate. It does not admit the 8da release,
  supply missing exact-8da complete CI, authorize credential use, reopen ingress, restart worker or
  timers, run a financial proof, enable live mode or permit Marketplace publication.
- Normal future maintenance still follows ADR 0015. This exception is bound to one revision, one
  pre-existing journal and one containment incident.
