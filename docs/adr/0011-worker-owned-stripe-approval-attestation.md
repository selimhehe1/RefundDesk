# ADR 0011 — Worker-owned Stripe approval attestation

## Status

Accepted

## Context

ADR 0010 separated the web and worker Stripe credentials, but still placed the Stripe App signing
secret in the web process. That separation was insufficient: a compromised web process could write
an apparently valid approval decision and enqueue work even though no Stripe-signed approver action
had occurred. Database constraints could validate workflow shape, but they could not prove the
origin or exact contents of the approval.

The pilot requires one approval, test/sandbox operation only, and a distinct requester and
approver. The authorization must bind the exact account, environment, payment, request version,
financial snapshot and Stripe identities that the approver saw.

## Decision

The worker is the sole long-lived holder of `STRIPE_APP_SIGNING_SECRET`. The web process never
receives that secret.

The web forwards the exact raw request body and `Stripe-Signature` header to the worker's private
`POST /internal/v1/signed-requests/verify` endpoint. The endpoint:

- requires a dedicated bearer token shared only between web and worker;
- returns `403` when that inter-service bearer is absent or invalid, reserving `401` for a Stripe
  signature rejected after service authentication; the web treats `403` as verifier
  unavailability, never as a client-signature verdict;
- verifies the Stripe signature against the unmodified raw bytes;
- validates the strict canonical signed-envelope and command schemas;
- rejects live mode;
- resolves the installation and current request state through the worker database role; and
- persists an append-only approval attestation before returning its identifier.

The bearer token authenticates the calling service; it is not approval authority. A caller without
a valid Stripe signature cannot create an attestation.

An approval command includes the displayed request version and exact amount, currency, reason and
requester Stripe user. The worker re-resolves the durable request and binds those values, together
with the tenant, installation, Stripe account, environment, resource, internal requester and
approver identities, payment identity, policy, quorum, request expiry, signed-envelope hash, nonce
and a bounded consumption window. It authenticates that snapshot with the dedicated, versioned
`REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1`.

Only a dedicated NOLOGIN database capability may insert or read approval attestations. The worker
login receives that capability; the web and queue logins receive no table or column privilege on
the attestation table. Rows are tenant-isolated with forced RLS and are append-only. An approving
decision must reference a matching, unused, unexpired attestation; rejection decisions must not
reference one. PostgreSQL enforces that binding and counts only attested approvals when advancing
the workflow.

The worker loads the decision and complete attestation evidence under the execution authorization
lock. It verifies the immutable snapshot hash and HMAC before claiming work, after the claim, and
again immediately before persisting the Stripe effect boundary. Missing, malformed, stale or
incompatible evidence fails closed. If an effect may already have occurred, the request moves to
`reconciliation_required` and retains its financial guard.

Attestation nonces are idempotent only for the same signed-envelope hash. Reuse with another body is
a conflict. The web also recomputes the raw-body hash and requires an attestation identifier exactly
for an approve command, preventing substitution in the internal response.

The web, worker and pg-boss queue use three distinct login principals. The owner credential remains
exclusive to the serialized migration job. Production uses HTTPS for the private verifier URL;
local development may use loopback HTTP. The verifier route must not be exposed through public
ingress.

There is no attestation backfill. Release preparation fails if an existing `approved`, `executing`
or `reconciliation_required` request has an approving decision without an attestation. An operator
must reconcile or terminate that old state before promotion.

This ADR supersedes ADR 0010 only where ADR 0010 assigns the App-signing secret to web, groups the
worker and queue database login, or describes three application cryptographic keys. All other
hosted-sandbox decisions remain in force.

## Consequences

- Compromising the web process is no longer sufficient to fabricate approval authority or create a
  Stripe Refund.
- A worker compromise remains financially powerful and therefore keeps the narrow effect keys,
  Stripe App signing secret and approval-attestation key, but it does not inherit webhook,
  field-encryption or export-signing secrets.
- Worker availability is now required for signed Stripe App API actions. Webhook ingestion remains
  independent and durable during a worker outage.
- Rotating the App signing secret or approval-attestation HMAC key requires a coordinated worker
  rollout. Historical key versions must remain available while executable attestations reference
  them.
- The changed approval command and private verification boundary require a new unpublished Stripe
  App artifact and fresh installation evidence. Evidence from version `0.1.2` does not transfer.
- This decision authorizes local and sandbox engineering only. It does not authorize deployment,
  live mode, Stripe review or publication.

## Rejected alternatives

- Keeping the App signing secret in web and trusting its database writes: a web compromise could
  manufacture the approval state.
- Letting web mint an HMAC proof after local signature verification: the proof would inherit the
  same compromised trust boundary.
- Treating the internal bearer token as approval authority: a compromised web necessarily knows
  that token.
- Backfilling attestations for existing approvals: no durable evidence proves the exact
  Stripe-signed financial snapshot for those decisions.
- Allowing the queue login to share the worker login: pg-boss does not need financial tables,
  attestation authority or Stripe-related database capability.
