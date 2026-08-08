# ADR 0026 — Webhook secret overlap, and why the export key does not need one

- Status: Accepted
- Date: 2026-08-03
- Owners: Security and engineering

## Context

Two key families were listed as never drilled: webhook secrets and export signing. Reading the
configuration explains why. Three families carry a `_V1`/`_V2` pair with an active-version
selector — field encryption, proof HMAC, approval-attestation HMAC — and all three have been
drilled. The other two carry a single value each. **They were undrilled because they were not
rotatable**, which is a code gap, not an evidence gap.

The two cases then turn out to be opposites, and treating them alike would have been wrong.

## Webhook secrets: overlap is required

Stripe signs a delivery with the secret current **at send time**, and then retries that same
signature for days if the endpoint does not answer. A bare cutover therefore rejects every
delivery already in flight, for as long as those retries last.

The consequence is financial, not cosmetic. RefundDesk's supported events include
`refund.failed`, which is how a refund believed to have succeeded is corrected. Dropping one
leaves the request terminal, the effect recorded as `identified` and the payment guard
released, while Stripe holds that no money moved. A silently discarded lifecycle event is the
same class of problem: `account.application.deauthorized` is what places a tenant in pending
deletion.

### Decision

Verification accepts an **ordered list** of secrets, active first, and stops at the first that
validates. A second entry exists only while a secret is being rolled:
`STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET_PREVIOUS` and its sandbox counterpart, both optional.

Constraints that come with it:

- **Every webhook secret in play must be distinct from every other.** A value shared across
  endpoints would let an event delivered for one environment verify on the other; a previous
  secret equal to its own current one makes a roll a no-op that reads as if it had happened.
  Configuration refuses both.
- **A failure is reported identically whichever secret failed.** A caller learns that the
  signature did not verify, never which secret is live.
- **An endpoint with no secret refuses with 503**, as an explicitly disabled one already did.
  An empty list must not fall through to a loop that rejects everything for the wrong reason.
- The previous secret is accepted for verification and **never used to sign** anything.

## Export signing: a cutover is correct

`REFUNDDESK_EXPORT_SIGNING_KEY_V1` signs one thing: the audit download token, whose lifetime
is five minutes (`AUDIT_LINK_LIFETIME_MILLISECONDS`). Rotating it invalidates at most five
minutes of unused links, and the holder asks for another.

Overlap exists in the other three families because something durable must stay readable or
verifiable: ciphertext written under an old field key, a proof or attestation HMAC'd under an
old key. Nothing durable is signed with the export key.

### Decision

**Do not add a `_V2` or an active-version selector for export signing.** Its rotation is a
restart with a new key, and the only observable is that links minted in the preceding five
minutes stop working — which is the intended meaning of rotating a signing key.

The PLANS entry asking for a staged-v2 → active-v2 → rollback-v1 → final-v2 drill of this
family is therefore mis-specified: there is nothing to stage, and nothing to roll back to.

## Consequences

- Webhook secrets become rotatable without losing events. The hosted drill remains open and is
  now possible; it needs public ingress, which is a separate decision.
- Export signing needs no mechanism, and its gate should be recorded as answered by design
  rather than left open pretending a mechanism is missing.
- Five tests pin the overlap: a delivery signed with the previous secret is accepted during a
  roll, one signed with the new secret is accepted in the same roll, an unrelated secret is
  still refused, the previous secret stops working once the roll ends, and an unconfigured
  endpoint refuses. The first was verified by mutation — restricting verification to the first
  secret makes it, and only it, fail.
- Configuration tests pin the distinctness rules and that the field stays absent when no roll
  is in progress.

## Rejected alternatives

- **Accepting an unbounded list of secrets.** Two is what a roll needs; more would let a
  forgotten secret stay valid indefinitely, which is the state a rotation exists to end.
- **Trying the previous secret first.** It would make the common path pay for the exceptional
  one and would keep working after the roll, hiding an unfinished rotation.
- **Adding `_V2` to export signing for symmetry.** Symmetry is not a reason; it would add key
  material, a selector and a drill for a value nothing durable depends on.
