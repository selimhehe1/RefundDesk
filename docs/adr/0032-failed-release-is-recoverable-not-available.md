# ADR 0032 — A failed release is recoverable, not necessarily available

- Status: Accepted
- Date: 2026-08-08
- Owners: Operations and engineering
- Supersedes: ADR 0030's availability and current-revision conclusions

## Context

ADR 0030 correctly requires an orderly rollback to retire its transition journal only when the
transition is uncommitted, metadata rollback succeeded and candidate containers are stopped. It
also deliberately preserves stopped candidate containers and their logs instead of recreating the
active runtime.

Those two decisions mean the rollback restores a recoverable control-plane state, not service
availability. The printed Compose command uses `up --no-start`; the rollback neither recreates and
starts the previous runtime nor proves health. ADR 0030's statement that the host continues running
the previous revision is therefore too strong.

ADR 0030 also says that promoting `8da280b7…` took five attempts, four of which failed. Current
summary documents still name e4 as active, while the repository has no admitted redacted host
postflight resolving that conflict and no recorded complete-CI result for `8da280b7…`.

## Decision

- After an orderly failed release, claim only: the transition was not committed, metadata was
  restored, candidate containers were stopped, and the transition journal was retired under the
  three-part guard. The runtime may remain stopped.
- Preserve failed candidate containers and logs. Print the exact `--no-start --force-recreate`
  recovery command, then instruct the operator to rerun only an exact authorized release command.
  Do not start an ad hoc mixture of revisions.
- Before recovery or another release, capture a redacted authoritative postflight covering
  `current`, `ACTIVE_REVISION`, stateless container labels/image IDs/state, PostgreSQL identity,
  transition journal, completion marker, release fence and live interlocks.
- The selected candidate must have complete CI and an attested bundle for the same exact SHA.
  After release, verify exact container identities, readiness, closed journals/fences, live false
  and unchanged financial/audit counters.
- Until that postflight exists, classify the host as
  `HOST_STATE_INDETERMINATE_POSTFLIGHT_REQUIRED` and perform no new release, ingress reopening or
  financial proof.

## Consequences

- `Recoverable` no longer implies `serving`.
- The last fully reconciled canonical e4 release remains historical evidence, not proof that e4 is
  still active after the later `8da280b7…` attempts.
- A retry cannot transfer CI, bundle, host or financial evidence from another revision.
