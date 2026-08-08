# ADR 0015 — Maintenance finalization and quiescence recovery boundary

- Status: Accepted
- Date: 2026-07-30
- Owners: Engineering and operations

## Context

Hosted retention and cold backup temporarily stop part or all of the sandbox runtime. Their
durable quiescence journal is cleared only after the exact active revision is restored and the
deployment verifier has proved database readiness, worker readiness, the private verifier
boundary, public HTTPS routing and the absence of forbidden host listeners.

The Lightsail instance's bucket resource-access identity can put, head, list and delete exact S3
object versions, but cannot call `s3:GetBucketVersioning`. Requiring that unsupported control-plane
read blocked backup even though bucket versioning was enabled. Omitting the versioning proof would
instead allow a falsely non-versioned recovery claim.

Release also activates persistent retention and backup timers. A persistent timer can immediately
run a missed calendar event. Starting it before durably closing the release transition journal
allows a valid new launcher to observe an otherwise committed release as unfinished.

The hourly retention invocation at `2026-07-30T01:02:27Z` on revision
`eeb840e526addbe6ca40a1e11c474b0c6ed5fb31` exposed three independent defects:

- a heredoc failure handler was parsed as Python input, so an `IndentationError` did not stop the
  shell at the intended preflight boundary;
- `refunddesk-retention.service` allowed only `AF_UNIX`, while inline recovery needs `AF_INET` and
  `AF_INET6` to verify the configured HTTPS origin;
- the recovery service did not allow `AF_NETLINK`, while `ss` needs it to inspect host listeners,
  and the previous conditional form could silently skip that failed inspection.

The retention unit failed, but its separate `OnFailure` recovery restored the exact runtime and
cleared the journal. This invocation is therefore `FAIL_RECOVERED`, never a retention pass. There
was no Refund request, execution, attempt, executable queue job or live tenant during the
incident.

## Decision

Maintenance recovery is part of the primary maintenance result, not optional cleanup:

- every preflight command that protects a financial or recovery boundary must fail closed;
- a heredoc command and its failure handler remain on the same parsed shell command, with a
  functional regression test that exercises both the success and rejection paths;
- `refunddesk-retention.service` waits for `network-online.target` and permits only the address
  families needed by its work and recovery: `AF_UNIX`, `AF_INET`, `AF_INET6` and `AF_NETLINK`;
- `refunddesk-quiesce-recovery.service` also permits `AF_NETLINK`;
- listener verification must first capture a successful `ss` result and must fail before
  interpreting it if the netlink query itself fails;
- no capability is added, no public listener is introduced and the existing filesystem,
  privilege, live-mode and secret boundaries remain unchanged;
- the durable quiescence journal remains until exact-revision recovery and deployment
  verification both pass.

Before quiescence, backup proves versioning through the operations available to the Lightsail
resource-access identity:

1. list a unique revision-bound probe key and require no existing version or delete marker;
2. put the active-revision marker with SSE-S3 and purpose/revision metadata;
3. require a non-null syntactically valid `VersionId`;
4. head that exact version and verify its bytes, metadata and encryption;
5. delete that exact version ID and list again until no probe version or delete marker remains.

An ambiguous put, missing version ID, metadata mismatch, ambiguous exact deletion, truncated
inventory or remaining probe aborts before any service is stopped. The tiny probe is preserved
when its state cannot be reconciled safely.

Release durably completes the transition journal and commit marker before starting either
persistent timer. The release-held operator lock serializes any immediate timer catch-up until the
release exits. If post-promotion finalization fails, release stops both maintenance timers and
services before applying its existing fail-closed runtime handling.

The stable backup, retention and quiescence-recovery launchers resolve the root-owned `current`
pointer to the exact revision directory before invoking any revision-owned runner. They export the
Compose file through that canonical revision path, and each runner rejects any different path
spelling even when it resolves to the same file. Docker Compose includes the configuration-file
path in container identity; alternating between `/opt/refunddesk/current/.../compose.yml` and the
resolved `/opt/refunddesk/releases/<revision>/source/.../compose.yml` can otherwise recreate the
stateful PostgreSQL container during maintenance recovery. No maintenance path may normalize that
drift by accepting a PostgreSQL generation change.

Operational evidence uses four outcomes:

- `PASS`: the primary maintenance unit exits zero, its structured operation result is successful,
  exact-revision recovery passes, all five runtime services are healthy and no transition,
  quiescence or upload journal remains;
- `FAIL_SAFE_PRE_QUIESCE`: a preflight fails before the durable quiescence journal and before any
  runtime service is stopped; the maintenance operation did not pass, but no runtime recovery is
  required;
- `FAIL_RECOVERED`: the primary unit fails but an independent recovery restores the runtime; this
  preserves availability but does not validate the maintenance operation;
- `FAIL_UNRECOVERED`: the primary unit and recovery contract do not complete; the journal remains
  a hard block on release and further maintenance until explicit reconciliation.

A real invocation of each changed maintenance path is required on the immutable deployed revision
before its timer is considered operational. Manual proof runs stop both timers first. A
`Persistent=true` timer catch-up after reactivation is a separate invocation and must receive its
own result; it is never folded into the manual proof.

## Consequences

- Retention recovery can reach only the network families already required to verify the sandbox
  runtime; the service still has no ambient capability and no application secret beyond its
  existing maintenance configuration.
- Backup can prove a versioned recovery object without broadening the existing resource-access
  role or granting bucket-control or Lightsail-control-plane permissions.
- Every successful versioning probe is deleted by exact version ID before quiescence, so it does
  not consume the backup rotation or storage budget.
- A DNS, routing, HTTPS or netlink failure now makes maintenance fail visibly and preserves the
  recovery block instead of producing a false pass.
- An `OnFailure` success cannot overwrite or reclassify the failed primary invocation.
- Operators must capture the primary invocation ID, structured purge/backup result, recovery
  result, final journals, runtime health and timer state.
- Persistent timer catch-up may run immediately after a maintenance window. Operators must not
  submit a duplicate manual start while that invocation is active or ambiguous.
- Maintenance and release use one canonical revision-scoped Compose path, preventing a successful
  maintenance recovery from changing the next same-revision release's container identity.
- The Refund effect, idempotency, reconciliation guard, tenant isolation and live interlocks are
  unchanged.

## Observed current-revision evidence — 2026-07-30

Revision `4521b8c9e783d807813686476e4e01dfaf85e798` completed one uniquely identified manual cold
backup invocation. Preflight found five healthy services, no financial blocker or active effect,
live disabled, an available operator lock and active/enabled retention and backup timers. The
backup quiesced the runtime, created exactly one revision-bound encrypted S3 object version,
verified SHA-256, length and `AES256`, then recovered the exact runtime to five healthy services.
The primary invocation itself returned `success`; this is `PASS`, not `FAIL_RECOVERED`.

That exact object version then passed the repository offline PostgreSQL 18.4 restore verifier on a
disposable no-IAM EC2 host after all egress was removed. The copied identity and archive, plaintext
work directory and every active or billable verifier resource were removed; AWS retains one
terminated historical descriptor. Final hosted checks retained active/enabled timers and `success`
for both retention and backup. The redacted proof is
`hosted-sandbox-4521b8c9-lifecycle-backup-restore-2026-07-30.json`, SHA-256
`f5b41ee5f192a5744fdeed762845747cfb82e3284cde6a346fc33a6b27322d5f`.

## Rejected alternatives

- Count successful `OnFailure` recovery as a maintenance pass: it proves availability recovery,
  not that retention or backup completed.
- Give maintenance unrestricted address families or capabilities: the recovery needs are narrow
  and can be expressed explicitly.
- Skip public-origin or listener verification during recovery: this could clear the journal while
  ingress is broken or an internal service port is exposed.
- Clear the quiescence journal before verification: a crash would lose the durable recovery
  obligation.
- Retry with a second start when the first result is unclear: a unique systemd invocation remains
  the only allowed evidence boundary.
- Require `GetBucketVersioning` from the host: that API is outside the narrow Lightsail
  resource-access contract, while the exact object-version operations can prove the property
  needed by backup.
- Trust a configured versioning flag without a data-plane probe: configuration evidence can drift
  from the identity and bucket actually used by the backup process.
- Start persistent timers before closing the transition journal: an immediate catch-up can enter a
  valid launcher while release metadata still says the transition is unfinished.
