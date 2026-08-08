# ADR 0025 — Correcting the outbound-webhook record

- Status: Accepted
- Date: 2026-08-03
- Owners: Security and engineering
- Corrects: ADR 0021 — three statements that describe behaviour which was never built

## Context

A review of the whole working tree compared every claim in ADR 0021 against
`packages/notifications`. Three statements do not hold. They matter because ADR 0021 is an
`Accepted` security ADR written in the present tense, and a reader — or a future evidence
artifact — would reasonably take it as a description of the running system.

ADRs are immutable after acceptance, so this file corrects the record instead of rewriting
ADR 0021.

## What ADR 0021 says, and what is actually built

**1. "the connection is pinned to a checked address" (section 3).** It is not. The delivery
client re-checks every address the name resolves to, then issues the request against the
URL, so the HTTP stack resolves the name a second time and independently. A name served with
a very short TTL can answer the check with a public address and the connection with a
private one.

The send-time re-check is therefore a **narrowing of DNS rebinding, not a guarantee**, and no
evidence artifact may describe it otherwise. Closing the gap means connecting to the address
that was checked while preserving SNI and `Host`, which needs a custom dispatcher.

Everything else section 3 claims is real and unit tested: HTTPS only, length bound, no
embedded credentials, port 443 only, private and reserved address classes refused whether
written literally or reached through DNS, no redirects, explicit timeout, response body
discarded.

**2. "A destination that fails any check is rejected when it is saved" (section 3).** There
is no save path. Validation exists and is tested; nothing calls it on a write.

**3. "The destination is stored per installation, encrypted with the field-encryption
keyring" (section 4).** No such storage exists — no column, no field, no read. This
statement is also inconsistent with ADR 0021's own later sections, which conclude that the
worker cannot read field-encrypted data and that the destination is an operator-held worker
configuration value for now. Section 4 is a leftover from the first draft.

**Not a defect, but easy to miss:** `WebhookNotificationProvider` has no caller anywhere in
`apps/` or `packages/`. It is exported and exercised only by its own tests. No notification
is sent today and no destination is read from anywhere, so the section 3 controls currently
protect a path that is not open.

## Decision

- The three statements above are corrected by this ADR and are not to be quoted from ADR 0021.
- The send-time re-check is documented as a narrowing, not a guarantee, until the connection
  is pinned to the checked address.
- Connection pinning is a prerequisite for wiring the provider to any runtime. The feature
  must not be enabled on the strength of ADR 0021's section 3 as written.
- The storage question stays open and belongs with ADR 0020, which must answer where
  per-merchant secrets live.

## Consequences

- No code changes. Everything built is already correct; what was wrong is the description.
- The webhook feature remains inert, which is why this correction costs nothing today and
  would have cost a great deal after wiring.
- This is the second documentation-versus-behaviour gap found in one review, after the stale
  hashes and outdated narrative corrected by ADR 0024. Both were invisible to every
  automated gate: `format`, `lint`, `typecheck`, `test`, `build`, `secrets` and `audit` all
  pass on a tree whose security documentation overstates the system. The project's own
  definition of done already requires that documentation match behaviour; nothing enforces
  it, and only reading the two side by side finds it.
