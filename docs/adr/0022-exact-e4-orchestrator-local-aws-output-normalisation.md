# ADR 0022 — Exact-e4 orchestrator local AWS output normalisation

- Status: Accepted
- Date: 2026-08-03
- Owners: Security, engineering and operations
- Supersedes: the pinned SHA-256 recorded in ADR 0019 for
  `invoke-e4-managed-sandbox-proof-orchestration.local.ps1`, and nothing else

## Context

ADR 0019 froze twelve artifacts for the exact-e4 contained credential transition, each
pinned by SHA-256 and cleared by two independent local reviews. That review was explicit
that "AWS, SSH and Stripe were not called": the chain had never been executed against the
real tools.

On 3 August 2026, with all three replacement candidates captured and a fresh composed
bundle, the orchestration was run for the first time. It failed immediately with
`AWS_CALLER_ENCODING`, before installing anything, before any transport, before any
transition.

The cause is a latent defect in the frozen wrapper. `ConvertFrom-ExactJson` rejects any text
containing a carriage return, and `Invoke-AwsJson` feeds it the raw stdout of
`aws.exe`. Measured directly on the pinned binary
(`C:\Program Files\Amazon\AWSCLIV2\aws.exe`), a `sts get-caller-identity --output json`
reply of 129 characters contains 5 carriage returns: the AWS CLI writes CRLF on Windows,
because its Python runtime translates newlines in text mode. No CLI option or environment
variable changes that, and the binary is frozen.

The wrapper cannot be run from Linux or WSL instead: it pins Windows absolute paths for both
`ssh.exe` and `aws.exe`. So the orchestration could never have succeeded on any machine.

The carriage-return rule itself is sound and must be kept. A stray CR in a transported
payload is precisely the defect that failed the 31 July disposable restore, where a
PowerShell native pipeline appended a carriage return and made a SHA-256 argument 65 bytes.

## Decision

`Invoke-AwsJson` normalises CRLF pairs to LF before parsing, and nothing else changes.

```powershell
ConvertFrom-ExactJson ($result.Stdout.Replace("`r`n", "`n")) $Code
```

The scope is deliberately narrow:

- only the output of the **local** AWS CLI is normalised;
- the four remote call sites — tool install, orchestrator actions, containment observation
  install and transport refresh — keep the strict rejection unchanged, so an integrity
  defect in anything transported still fails closed;
- only the CRLF pair is replaced, so a lone carriage return is still refused;
- the failure mode remains fail-closed: this line is on the read path of a local identity
  check, it cannot alter what is transported, transitioned or proven, and malformed JSON
  still fails to parse.

## Consequences

- ADR 0019's pinned SHA-256 for this file is superseded. The artifact moves from
  `b649ee7da24eeec9281939e7291b92ec81b93dc96a6ded48f8314ae062919ebb` to
  `30725a4a3b8bf9c8d77ff94e9a7af9410b978397340d4a85e7d1fc23f5fe91df`. The other eleven
  artifacts are untouched.
- The chain loses its "double independent review at the exact pinned hashes" property for
  this file. Restoring it requires a review of this one change; the owner authorised
  proceeding without waiting for it, and that trade-off is recorded here rather than
  hidden.
- The failure that prompted this changed nothing on the host: the identity check runs
  before tool installation, transport and preparation, so no tool was installed, no bundle
  transported, no journal opened, no credential replaced and no container recreated.
- ADR 0019's operational contract is otherwise unchanged: single bounded orchestration path,
  forward-only durable states, `PASS_CONTAINED` as the only admissible completion, and
  worker, Caddy, timers and ports 80/443 left contained.

## Rejected alternatives

- **Relaxing the carriage-return rule globally.** It would remove the integrity check on
  transported payloads, which is the check that the 31 July failure proved necessary.
- **Interposing a wrapper named `aws` earlier in PATH.** The wrapper resolves the canonical
  path and verifies the binary's owner precisely to prevent tool substitution; defeating
  that in a chain with financial effect is the improvisation the operating rules forbid.
- **Running the orchestration from Linux or WSL.** Impossible: the wrapper pins Windows
  absolute paths for `ssh.exe` and `aws.exe`.
- **Abandoning the transition.** It would leave four exposed Stripe credentials in place and
  the hosted runtime contained indefinitely.
