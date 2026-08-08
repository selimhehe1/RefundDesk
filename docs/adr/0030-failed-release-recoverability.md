# ADR 0030 — A failed release must leave a recoverable host

- Status: Accepted
- Date: 2026-08-03
- Owners: Operations and engineering

## Context

Promoting revision `8da280b7` took five attempts. Four of them failed, and each failure
left the host in a worse state than the documentation describes. The defects are
independent of why the release failed, so they apply to every future failure too.

`release.sh` fails closed and rolls back: it restores `current`, `ACTIVE_REVISION`,
`release.env`, the rotation state and the image selection, stops the maintenance timers
and stops the candidate containers. That much worked, every time. What follows did not.

## What a failed release actually left behind

**The transition journal is never retired.** `complete` requires a commit marker that
only exists after a successful promotion, and no rollback path removes the journal. So
it stays for ever.

**The stable fence outlives the release it watches.** `release-fence.sh` breaks out of
its watch loop when the release process dies, then enters a second loop that keeps
fencing candidate containers _while the journal remains_ — which is now always. Measured:
`refunddesk-release-fence-…-2025347` still running against a long-dead pid, killing the
web container with SIGTERM within seconds of every start attempt. **The host could not
run its own runtime**, at the previous revision or any other.

**Every later release is refused.** The resume path admits only a journal whose
`.to.revision` equals the requested revision. When the failure is in that revision's own
verification — as it was, twice — that revision can never succeed, so the host is
blocked permanently rather than temporarily.

**The rollback restores metadata but not containers.** The candidates stay in place,
stopped, still labelled with the abandoned revision, while the metadata names the active
one. Nothing reports the gap. It surfaces later as
`RELEASE_TRANSITION_CONTRACT_INVALID`, when `fingerprint_active_containers` requires the
labels to match the active revision — an error that names neither the containers nor the
revision that disagrees.

Together: one failed release, and the host serves nothing and accepts no new release.

## Decision

**Retire the journal when, and only when, the rollback is provably complete.** The
condition is all three of: the transition was not committed, every metadata target was
restored, and the candidate containers were stopped. Anything less leaves the journal,
and the fence keeps doing its job.

This deliberately preserves the case the fence was written for. A release killed
outright — SIGKILL, power loss — never reaches its `EXIT` trap, so its journal survives
and late candidates are still fenced. The change only covers the orderly path, where the
release itself established that nothing is left to fence.

**Do not recreate the candidate containers.** It is tempting: it would close the label
gap and make a retry work with no operator step. It also destroys the stopped containers
and their logs, and a failed release is exactly when those logs matter — the sixth defect
of this series was diagnosed from a single line in a stopped web container, which proved
the application had behaved correctly and the verification had not. The rollback names
the recreate command in its output instead of running it.

## Consequences

- A failed release leaves a host that still runs its previous revision and still accepts
  a new one. That was the intent all along; nothing implemented it.
- The recovery is two steps and both are printed: recreate the stateless runtime at the
  active revision, then release again.
- The fence's post-release loop is unchanged. Its termination condition simply becomes
  reachable.
- This cannot be exercised by a test. It runs only when a real release fails after
  promotion started, on a real host. It was written against four observed failures and
  the manual recovery that followed each; it is unverified in the sense that matters,
  and the next genuine failure is its first execution.

## Rejected alternatives

- **A bounded fence loop.** Exiting after a timeout would unblock the host without
  knowing whether anything still needs fencing. The journal's presence is the correct
  signal; it was simply never cleared.
- **A separate operator command to retire the journal.** That is what was done by hand
  four times tonight. Reserving the fix for an operator who already knows the internals
  is not a fix.
- **Removing the journal unconditionally on any failure.** The fence exists for the
  release that dies without running its trap. Clearing the journal from inside the trap
  is safe precisely because reaching the trap proves the orderly path ran.
