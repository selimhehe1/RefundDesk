# ADR 0034 — Exact-e4 independent review and read-only host postflight

- Status: Accepted
- Date: 2026-08-08
- Owners: Security and operations
- Completes: ADR 0024's outstanding independent review and implements ADR 0032's postflight

## Context

ADR 0024 records that the one-time exact-e4 credential transition ended with
`PASS_CONTAINED`. Its final proof was removed by the designed cleanup, and the nine corrected
execution artifacts therefore still required an independent static review before they could be
used as an admission input for any reopening decision.

Two reviewers independently recalculated all nine SHA-256 values and reviewed only the named,
consumed artifacts. Both reached the same chain-level result: `NO_GO_REOPENING`. Their individual
artifact matrices differ in a few places, so the evidence preserves both matrices rather than
inventing a consensus. Redacted evidence is
`sandbox-evidence.local/aws/exact-e4-independent-static-review-2026-08-08.local.json`, SHA-256
`613f868c80e52b834b7fe33594f590fea1990c52b155eef9dfcbaf9fc7b9fba2`.

The review found that the historical observer accepted non-exact or multi-document marker input,
did not require every redaction flag, and allowed secret-bearing environment files to be readable
by group or world. The corrected observer was not pinned end to end by the orchestration chain.
Other components admitted less than 720 seconds of remaining containment, could relay unbounded or
non-code diagnostic material, treated malformed AWS port state as empty, incompletely excluded
internal pg-boss jobs, or applied output limits only after buffering.

These defects do not demonstrate that the recorded historical transition failed. They do prevent
the consumed chain from independently proving that outcome or authorizing a new operation.

The replacement ADR 0032 postflight is now implemented as four tracked layers: a remote read-only
observer, an exact JSON schema, an independent local validator and a Windows capture wrapper. The
production wrapper admits those four sources only when their worktree and index bytes equal the
same clean repository `HEAD`; it pins the local transport tools, validates AWS identity and the
exact Lightsail firewall shape before and after SSH observation, and writes only a short-lived,
redacted local artifact.

Two read-only captures were run on 8 August 2026 while that implementation was still being
hardened. Both diagnostic observations identified active revision `8da280b7...`, with worker and
public Caddy running, backup and retention timers active, internal TCP listeners on ports 80 and
443, and a runtime quiescence journal present. The AWS firewall kept ports 80 and 443 closed and
unchanged, both live interlocks were false, and the two financial snapshots were quiescent. These
captures predate the final source contract and a committed `HEAD`; they are diagnostic only, have
no admissible evidence status and do not complete ADR 0032. No evidence hash is assigned to them in
this ADR.

## Decision

- Preserve all nine exact-e4 artifacts byte-for-byte. They are consumed historical inputs and must
  not be patched, installed, resumed or executed again.
- Record the independent review as `NO_GO_REOPENING`. Continue to describe ADR 0024's
  `PASS_CONTAINED` as a recorded outcome whose cleaned final proof is not independently retained.
- Build the ADR 0032 current-host postflight as a new tracked, read-only observer. It may inspect
  metadata, Docker state, PostgreSQL aggregates, journals, fences, timers, listeners and live
  interlocks, but it may not run a health request, start or stop a service, acquire an exclusive
  operator lock, write remote state or perform a financial action.
- Treat every diagnostic as a bounded identifier matching `^[A-Z][A-Z0-9_]{0,63}$`. Never relay
  stderr, exception text, paths, environment values, Stripe identifiers, payloads or logs.
- Require an exact single-object JSON schema, no unknown keys, all redaction flags false, streamed
  output limits, exact `0600` permissions for secret-bearing environment and marker files, and
  fail-closed AWS response schemas.
- Bind an admissible capture to one committed repository `HEAD`: the observer, validator, wrapper
  and schema must match that commit in both the index and worktree. A capture made from mutable or
  pre-commit sources is diagnostic only.
- Classify the postflight as a containment observation, not as a complete release or Compose
  configuration admission. It verifies the explicitly modeled revision, image, service-state,
  listener, journal, fence, live, financial and AWS-edge properties; it does not validate every
  possible container command, mount, network or runtime setting.
- A future credential-transition successor must be a new versioned chain whose every layer
  enforces at least 720 seconds of remaining containment, pins and transports every observer and
  validator, separates internal pg-boss jobs from application work, and has negative tests for
  719 seconds, extra or multiple JSON documents, mode `0644`, empty redaction, malformed AWS port
  state, diagnostic-value injection and oversized output.
- A successful read-only postflight resolves only the modeled containment state at its capture
  time. It does not repair availability, provide a complete release/Compose admission, validate
  CloudFront origin identity, authorize a release, reopen ingress, restart worker or timers, or
  permit a Stripe proof.

## Consequences

- The independent-review prerequisite is closed with a negative result rather than left
  outstanding or incorrectly promoted to `GO`.
- The two pre-commit diagnostics contradict the required contained service posture: they observed
  public Caddy, worker and maintenance timers active, internal TCP listeners on ports 80/443 and a
  runtime quiescence journal. They also observed the AWS 80/443 edge closed, live disabled and the
  financial state quiescent. This is a fail-closed warning, not an admitted current-state record.
- `HOST_STATE_INDETERMINATE_POSTFLIGHT_REQUIRED` remains authoritative until the final committed
  source is captured through the HEAD-bound wrapper and the resulting redacted local/AWS envelope
  is reviewed. No release, recovery, ingress reopening or financial proof is authorized meanwhile.
- Any future reopening still requires ADR 0031's origin-identity control, exact CI plus attested
  bundle for one SHA, current containment, incident admission and separate authorization.
