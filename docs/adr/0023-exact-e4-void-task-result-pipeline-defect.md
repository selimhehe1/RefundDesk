# ADR 0023 — Exact-e4 chain: discarded VoidTaskResult on stdin-bearing calls

- Status: Accepted — **superseded in part by ADR 0024.** Every hash recorded below is stale,
  and the addendum's closing statement that work stopped before the remote controller was
  edited no longer holds: the owner authorised going further on the same day, and nine
  artifacts were corrected. The diagnosis in this ADR stands; its final state does not.
- Date: 2026-08-03
- Owners: Security, engineering and operations
- Supersedes: the pinned SHA-256 recorded in ADR 0019 for
  `invoke-e4-managed-sandbox-proof-orchestration.local.ps1` (already superseded once by
  ADR 0022) and for `transport-install-exact-e4-contained-transition.local.ps1`

## Context

After ADR 0022 removed the first blocker, the orchestration reached its second step and
failed with `PropertyNotFoundStrict` on `ExitCode`. The failure was located precisely at
`invoke-e4-managed-sandbox-proof-orchestration.local.ps1:392`, inside `Install-ProofTools`,
on the result of the first SSH call.

The cause was established by isolated reproduction rather than inference. Mirroring
`Invoke-ProcessStrict` against a harmless local process that reads standard input shows
that the function emits **two** objects, not one:

```
emitted-count: 2
  [0] type=System.Threading.Tasks.VoidTaskResult
  [1] type=System.Management.Automation.PSCustomObject
```

In Windows PowerShell 5.1, `GetResult()` on a **non-generic** `Task` puts a
`VoidTaskResult` on the pipeline instead of returning nothing. `Invoke-ProcessStrict`
therefore returned an array whenever `$InputBytes` was non-null, and `$result.ExitCode`
failed under `Set-StrictMode -Version Latest`.

This explains the exact observed behaviour: AWS CLI calls pass `$null` input and always
worked, while every SSH call carries input and always failed. No SSH call in this chain
could ever have succeeded.

The same omission exists twice in the transport wrapper, at the write task and the copy
task. The author clearly knew the idiom — lines 382-383 of that same file already write
`[void]$stdoutTask.GetAwaiter().GetResult()` — so this is an oversight, not a design
choice.

## Decision

Discard the result of the awaited task at the three affected call sites, and change
nothing else:

- `invoke-e4-managed-sandbox-proof-orchestration.local.ps1`, write task in
  `Invoke-ProcessStrict`;
- `transport-install-exact-e4-contained-transition.local.ps1`, write task;
- `transport-install-exact-e4-contained-transition.local.ps1`, copy task.

The awaited call is kept: it is how a failed write surfaces as an exception. Only its
pipeline value is suppressed, which is what every other awaited task in these files already
does.

## Consequences

- The pinned SHA-256 change again. Orchestrator:
  `30725a4a3b8bf9c8d77ff94e9a7af9410b978397340d4a85e7d1fc23f5fe91df` →
  `6e214a92ebc51f72e9d17bb0ef59c515e440275054bfea7823a570130cda1635`. Transport:
  `fd068ac388de3292c2d05a04882476439e64115c99dc0c2ebfa75801a2a942a1` →
  `720ea5461b6667b7cd89088ba96c2147b6ab93da69c507be241e31ed8a469d1c`. The other ten
  artifacts remain untouched.
- Two of the twelve frozen artifacts have now been corrected without the independent review
  the project mandates. The owner authorised proceeding; the review remains due and is
  recorded here as outstanding rather than treated as done.
- The defect proves that the chain's "double review at exact hashes" never included an
  execution: a chain in which no SSH call can succeed cannot have been exercised end to
  end. Any future confidence in it must come from running it, not from reviewing it.
- The diagnosis cost nothing operationally. Invoking the wrapper **without**
  `-ComposedBundleDirectory` makes it fail closed at
  `FRESH_COMPOSED_BUNDLE_REQUIRED_BEFORE_PREPARE`, so identity and tool installation are
  exercised while no credential, journal or container is touched. That is the safe probe to
  reuse for any further diagnosis.

## Addendum, same day: what the corrected chain then revealed

With the pipeline defect removed, the chain advanced stage by stage and each stage exposed
the next problem. Recorded here because every one of them was invisible to review:

1. **`TOOL_INSTALL_FAILED` / `CODE_UNEXPECTED`.** Root cause: `/usr/local/libexec` does not
   exist on this Ubuntu image, while the installer publishes the proof client into it.
   Opening the parent raised `FileNotFoundError`, which is not an `InstallError`, so the
   catch-all reported `UNEXPECTED`. Fixed by creating the standard directory
   (`root:root 0755`, matching `/usr/local/sbin`). **No frozen artifact was changed for
   this.** Tool installation then succeeded.
2. **`TRANSPORT_REFRESH_FAILED` → `REMOTE_BOOTSTRAP_BEGIN_FAILED` → `CONTROLLER_FAILED` →
   `JOURNAL_INITIAL_PUBLISH`.** The controller fails while publishing its initial journal.
   Ruled out by measurement on the host: `age` 1.1.1 is present with the expected hashes,
   `O_TMPFILE` and xattr work in the journal directory, and `linkat(AT_EMPTY_PATH)` — the
   primitive the controller actually uses through ctypes — works. A `/proc/self/fd` hard
   link does fail with `EXDEV` on this 6.17 kernel, but no artifact in this chain uses that
   variant, so it is not the cause.

Each layer discards the diagnostics of the layer beneath it. Two local wrappers were
therefore given a bounded, redaction-safe way to surface the remote `code` — never the
document, never a payload, filtered to characters a code can contain. Final hashes:
orchestrator `ed82dd697540fa363bab3784cd47b93a8129e0b15cc98cc3230b30be157f04bd`, transport
`14aeb32ae407afbe546061360361223f3de0061ff43f37d00e08f56b34b48dbf`.

Work stopped there. Going deeper means editing the root-executed remote controller, whose
hash the bootstrap verifies, whose hash the transport wrapper verifies in turn — a cascade
of pinned artifacts running as root on the host. That is a materially different risk class
from the local corrections above, and it is a decision for the owner, not a continuation of
this one.

> **The owner took that decision the same day.** The controller and the rest of the cascade
> were corrected, the transition ran to a final `PASS_CONTAINED`, and eleven further defects
> came to light in the process. ADR 0024 records them and carries the current hashes; the
> two recorded in this paragraph are stale.

The host was observed with the frozen observer after every failure and returned
`PASS_CONTAINED` each time: no transition journal, exactly the three expected containers,
worker and Caddy stopped, ports 80/443 closed, live false, financial state quiescent.

## Rejected alternatives

- **Removing the awaited call.** It would silence write failures, replacing a crash with a
  silent truncation of a transported payload — the worst possible trade in this chain.
- **Relaxing `Set-StrictMode`.** It would hide this class of defect everywhere else in the
  same scripts.
- **Taking `$result[-1]` at the call sites.** It would paper over an array whose shape
  nobody intended, in several places, instead of removing the cause once.
