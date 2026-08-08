# ADR 0024 — Exact-e4: the corrections execution forced, and containment during a transition

- Status: Accepted
- Date: 2026-08-03
- Owners: Security, engineering and operations
- Supersedes: the pinned SHA-256 recorded in ADR 0023 for the orchestrator and the transport
  wrapper, and the closing statement of its addendum that work stopped before the remote
  controller was edited

## Context

ADR 0022 and ADR 0023 each removed one blocker and each recorded that the chain then failed
somewhere further along. This ADR records what happened when the chain was driven all the
way to a result: the exact-e4 replacement transition completed on 3 August 2026 with a final
`PASS_CONTAINED`, and reaching it required correcting nine artifacts, five of which ADR 0023
had explicitly declined to touch.

The defects share one property. Every one of them was invisible to review, to `bash -n`, to
PowerShell parsing and to the unit suites; each became visible only by running the step that
contained it. Several also made the _following_ step unreachable, which is why they could
only be found one at a time.

## What was wrong

**Delivery of a program to an interpreter.**

1. In bash, a here-document body begins on the line after the line carrying `<<`, not after
   the end of the command. Two blocks were written as `python3 … <<'PY' ||` with
   `transport_die` on the next line, so that bash line became line 1 of the Python program.
2. Two other blocks delivered the Python program _and_ read their input document on the same
   standard input. `commit_journal_update` and `receive_ciphertext_anonymous` could therefore
   never receive anything: the program is passed on descriptor 3 now, leaving stdin to the
   document. Since `commit_journal_update` publishes every state change, **no state
   transition of the controller was reachable before this**.
3. `importlib.machinery.SourceFileLoader` was given a `Path` where it requires a `str`. This
   one was ours, introduced with the explicit-loader correction and limited to the single
   call site that had not been reading `sys.argv`.

**PowerShell semantics.**

4. `[ArraySegment[byte]]::new()` cannot resolve: the type is a struct with no declared
   parameterless constructor. `New-Object` yields the default value the `TryGetBuffer` guard
   expects.
5. `$archiveBytes = $null` silently overwrote the `$ArchiveBytes` parameter of the same
   function, because PowerShell variable names are case-insensitive. The archive writer was
   handed a null dictionary on every call.

**Assumptions about the runtime that the runtime does not grant.**

6. `docker cp` is refused into any container whose rootfs is read-only, tmpfs destinations
   included; and `CAP_CHOWN` is dropped, so not even uid 0 inside the container can hand a
   file to the runtime uid. The proof client is written directly as that uid instead. The
   in-container verification of bytes, owner and mode is unchanged.
7. `/tmp` is sticky and `CAP_FOWNER` is dropped, so uid 0 may not unlink a file it does not
   own there. The client is removed by its owner.
8. `pg-boss` keeps housekeeping on queues named `__pgboss__*`. Counting them as unexpected
   runnable work made the worker permanently unstartable on a healthy host.

**Statements about data that the data does not support.**

9. `effect_state = 'terminal'` — a value the deployed enum has never had. Its members are
   `not_started`, `possible`, `identified`, `absence_proven`; a succeeded request carries
   `identified`, which the product's own repository writes. Every statement carrying the
   literal aborted its whole read.
10. The private verifier reports a created attestation as an explicit `null`; three separate
    claims were folded into one verdict, so a hash mismatch and a created attestation were
    indistinguishable. The envelope was also compared byte for byte against the raw body,
    which the verifier cannot reproduce because it parses and re-serialises. It is compared
    by content now — the canonical hash checked immediately above already binds the verifier
    to our exact bytes, so nothing is lost.
11. `creation_started` was missing from its own promotion set. The function persists that
    status immediately before crossing the create boundary, so it is the status every first
    creation arrives with — and the only one excluded. **No first refund request could ever
    be recorded.**

## Containment during and after a transition

Two separate defects, and the more interesting finding of the day.

The frozen observer listed the marker that an authorised transition _writes about itself_
among the journals whose absence it requires. Containment therefore became unobservable for
the whole duration of the operation the observer exists to supervise, and the orchestration
deadlocked: refreshing the fifteen-minute window needed a fresh bundle, composing one needed
a `PASS_CONTAINED`, and the observer could no longer give one.

The completion marker had the same problem permanently: requiring its absence asserts that
no transition has ever completed, which stops being true the moment one does.

Both are now accepted **by content, never by presence**:

- the in-flight marker while its gate, revision and status say it is this authorised
  transition, still in flight, with every redaction flag false;
- the completion marker while it attests a contained completion of this revision — and
  because that document states the posture itself, the check is _stricter_ than absence ever
  was: a completion claiming restored ingress, restored timers, re-enabled live, a retested
  old credential or a secret in the marker fails containment.

The two markers are refused together: both at once means the state machine is not where it
claims to be.

The proof runner's freshness gate had the mirror problem. The Dashboard proof is pinned into
the transition journal by SHA-256, the installer refuses to reopen the inputs once a
transition exists, and refreshing them would break that binding — so demanding residual
budget on that window stranded any operation whose prepare and proof straddled it. It now
falls back to the live containment observation, which is exactly the substitution
`validate_final_containment_admission` already performed, and which is bound by SHA-256 to
this journal and this Dashboard proof and must itself be unexpired.

## Decision

Correct the nine artifacts, keep every safety property, and prefer the stronger statement
wherever one was available. Final SHA-256:

| Artifact                                                    | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `install-exact-e4-contained-transition-bundle.remote.sh`    | `f58dafa9544a5f842467a0156b63a6aed1dcf00cc8226f9673c71beeaea5e5e6` |
| `bootstrap-exact-e4-contained-transition-tools.remote.py`   | `c9d772f8398fe1004d79922530095c7c3c5b994432989dffd14f0139ca68b31c` |
| `transport-install-exact-e4-contained-transition.local.ps1` | `74e3980d544b285ebed33235247b2a2912f29f43a25a33af1bbada30c1b7f8eb` |
| `invoke-e4-managed-sandbox-proof-orchestration.local.ps1`   | `f48e20c38c111b8a2381aa5cbe5e38f488b485d98a20e5f3b561896a05a285b5` |
| `e4-managed-sandbox-new-credential-proof.remote.py`         | `5fe99398cd94ee09d4ed4b80cff322f2760a76a8fcd1d0145c96207beebde92f` |
| `e4-managed-sandbox-new-credential-proof-client.remote.mjs` | `315433815e2f2ebfbb70e337ca48addce1c1bcd721c17317897b2898567792e0` |
| `install-e4-managed-sandbox-proof-tools.remote.py`          | `e5ea9c722f809703810e8a382bca345e51804f7a426985652bbcea6319684430` |
| `orchestrate-e4-managed-sandbox-proof.remote.py`            | `32b8cf2576f4359ae8fa7a2ccaf86e7dcc8d82e0434f198930fd5f02a0c4d680` |
| `inspect-exact-e4-containment.remote.sh`                    | `2b47e0a03004862c20f56bc427c1303cee14bc32820a069f8180ef2a91bbcf05` |

Diagnosis was made possible by surfacing, at each layer, a code **shaped like an identifier**
— never a message, a path, a payload or a value. Each layer discarded the diagnostics of the
layer beneath it, and a single verdict covering several distinct causes is what cost the most
time; splitting those verdicts is part of this decision, not incidental to it.

## Consequences

- The transition completed: final `PASS_CONTAINED`, proof
  `sha256:39e9351c387c1bc6316cdc23f507ddc9f073899b4863a1f09d4c0c5621fe7706`. The three
  replacement credentials are proven in real use — the read key performed its reads and was
  correctly refused a refund creation, the App signing secret had a signed synthetic request
  accepted, and the effect key created, approved, executed and reconciled a real Stripe
  Refund.
- Posture unchanged throughout and verified independently of the final document: Caddy never
  started, worker stopped again, ports 80 and 443 without a listener, maintenance timers
  inactive, live disabled in both environments.
- **The independent review of the corrected artifacts remains outstanding**, now across nine
  files rather than two. It is recorded here as due, not as done.
- The two redacted 1 August incident JSONs retain their original `IN_PROGRESS_CONTAINED` result.
  They establish the initial incident and containment state, not the final 3 August proof. The fixed
  final proof file was removed during ADR 0019 cleanup, so the `PASS_CONTAINED` above is the recorded
  outcome of this ADR and must not be attributed to either initial JSON.
- The claim that this chain was "double reviewed at exact hashes" cannot survive this record.
  Eleven defects, several of which made the next step unreachable, prove the reviews never
  included an execution. Future confidence in a chain of this kind must come from exercising
  it in a disposable environment, not from reading it.

## Rejected alternatives

- **Relaxing the proof's freshness requirement.** It would have let a financial effect run on
  a stale containment picture. The live observation preserves the guarantee instead of
  removing it.
- **Granting the container `CAP_CHOWN`, or dropping its read-only rootfs.** The hardening is
  correct; it was the tooling that assumed privileges the runtime rightly refuses.
- **Excluding queue-engine jobs by a loose name match.** The exclusion is anchored at the
  start of the name, so an application queue cannot hide behind a matching suffix.
- **Deleting the stuck journals and states.** Everything superseded was moved aside under a
  timestamped directory on the host, never removed.
