# ADR 0028 — App signing secret rotation overlap

- Status: Accepted
- Date: 2026-08-03
- Owners: Security and engineering
- Extends: ADR 0026, which established when an overlap is warranted and when a cutover is right

## Context

`docs/SANDBOX_TEST_PLAN.md` already recorded the fact that decides this: Stripe documents one
signing secret per App, **with temporary overlap during rotation**. The worker held exactly one.

During that overlap window both secrets are valid signers, and an extension request may arrive
signed with either. A runtime holding one refuses whichever half it does not have, so the
rotation is only seamless if Stripe's switch and our deployment happen at the same instant —
which they cannot.

ADR 0026 asked the right question of each key family: does anything outside our control still
sign, or still depend, with the retired value? For the App signing secret the answer is yes, and
it is Stripe.

## How this differs from the webhook case

The consequence is milder and it is worth naming, because it changes nothing about the decision
but everything about the urgency.

A dropped webhook is a financial correctness defect: a `refund.failed` that never arrives leaves
a refund recorded as succeeded with its payment guard released, and nothing later corrects it. A
refused extension request is a Dashboard action that fails in front of a merchant. It is
visible, it is immediate, and the merchant retries. Nothing is silently wrong afterwards.

So this is an availability and trust defect during every rotation, not a correctness one. It is
still worth removing, because the pattern already exists and the alternative is telling an
operator to synchronise two systems by hand.

## Decision

`StripeSignedRequestAuthority` accepts one secret or an ordered list, active first, and stops at
the first that verifies. `STRIPE_APP_SIGNING_SECRET_PREVIOUS` is optional, set only during a
roll, refused by configuration when equal to the current value, and never used to sign.

One detail is a decision rather than mechanics. **Only an invalid signature is retried across
secrets.** A missing signature and a malformed envelope fail identically against every secret,
so retrying them would waste work and — worse — report the last attempt's failure rather than
the real cause. A caller with no signature must be told the signature is missing, not that it is
invalid.

An empty list throws at construction, for the same reason as ADR 0027's pinned lookup: a runtime
that can verify nothing should say so where the mistake was made, not refuse every request as if
each were forged.

## Consequences

- Rolling the App signing secret stops requiring Stripe and the deployment to switch together.
- Six tests cover it: the previous secret accepted during a roll, the new secret accepted in the
  same roll, an unrelated secret still refused, the previous secret refused once the roll ends, a
  missing signature reported as missing rather than as invalid against the last secret, and the
  empty-list refusal. The first was verified by mutation — restricting verification to the first
  secret makes it, and only it, fail.
- `STRIPE_APP_SIGNING_SECRET_PREVIOUS` must be removed when the roll ends. Left set, a superseded
  secret stays valid indefinitely, which is the state a rotation exists to end. The runbook step
  says so explicitly.
- The rotation performed on 3 August used a hard cutover and succeeded, because nothing was in
  flight at that moment on a contained host with no ingress. That is luck, not a procedure.

## Rejected alternatives

- **Leaving it, since the failure is visible and self-healing.** It would mean every future App
  secret rotation is a small outage in front of a merchant, and that the runbook has to ask an
  operator to synchronise two systems by hand.
- **Retrying every verification failure across secrets.** It would report the wrong cause for a
  missing signature or a malformed envelope, and multiply work on requests that cannot succeed.
