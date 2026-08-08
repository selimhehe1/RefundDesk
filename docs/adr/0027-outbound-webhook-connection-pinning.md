# ADR 0027 — Pinning the outbound webhook connection to the checked addresses

- Status: Accepted
- Date: 2026-08-03
- Owners: Security and engineering
- Satisfies, in part: the prerequisite recorded by ADR 0025

## Context

ADR 0025 recorded that re-checking every address a destination resolves to **narrows** DNS
rebinding without closing it, and made closing it a prerequisite for wiring the notification
provider to any runtime. The residue was concrete: the request was issued against the URL, so
the HTTP stack resolved the name a second time and independently. A name served with a very
short TTL could answer the check with a public address and the connection with a private one.

Closing it means resolving once, under the policy, and connecting to that result.

## The constraint that shapes the decision

Node's socket layer accepts a `lookup` for exactly this, and `net.connect`, `tls.connect` and
undici's `connect.lookup` all pass it through. But undici is not reachable from the Node core
of this runtime — `node:undici` does not exist and the package is not installed — and
`packages/notifications` deliberately carries **no runtime dependency at all**.

Adding one to reach a dispatcher would be disproportionate, and it would put the composition
concern in the package that owns the policy.

## Decision

Split the concern where the constraint already splits it.

**The primitive lives with the policy.** `createPinnedLookup(addresses)` returns a lookup that
answers with those addresses and nothing else, in both shapes Node calls it with. It ignores
the hostname it is asked about — that is the point: whatever a resolver would answer now, the
connection goes where the policy already agreed. It is declared structurally, so the package
stays dependency-free.

Two details are decisions rather than mechanics:

- **An empty address set throws at construction.** A lookup built from nothing would report
  every connection as unresolvable, which reads as a network problem rather than as a missing
  check. Failing where the mistake is made keeps the two apart.
- **A requested family that no checked address satisfies is a resolution failure**, not an
  invitation to substitute the other family. A dispatcher pinned to an IPv4-only result must
  not be handed an IPv6 address it will not use.

**The request carries its own resolution.** The fetcher contract takes a `PinnedRequest` —
url, init, the checked addresses and the lookup built from them — instead of a bare url and
init. A fetcher cannot silently skip a parameter it is given, so the pin cannot be forgotten
at the call site the way an out-of-band convention would be.

**The dispatcher stays at the composition root.** Whichever runtime eventually sends the
notification builds its agent with this lookup. That runtime does not exist yet: the provider
still has no caller.

## Consequences

- The prerequisite of ADR 0025 is satisfied _as far as this package can_: the pin is
  expressible, derived from the checked addresses, and impossible to omit from a request.
  What remains is one wiring step in the runtime that will send — building the agent with the
  lookup — and that step cannot be written until that runtime exists.
- Eight tests cover it: family detection, the all-addresses and single-address shapes, family
  selection, the refusal to substitute a family, the empty-set refusal, and the provider
  handing the fetcher a lookup derived from the addresses it checked. The last was verified by
  mutation — building the lookup from an address the policy never saw makes it, and only it,
  fail.
- Nothing is sent today, so this changes no behaviour in production. It changes what the code
  will permit once something does send, which is the only moment at which it would be too late.

## Rejected alternatives

- **Adding undici to `packages/notifications`.** It would buy a dispatcher the package has no
  use for, in exchange for its only dependency and for owning a composition concern.
- **Rewriting the URL to the address and setting `Host` by hand.** `Host` is a forbidden
  header for `fetch`, and TLS SNI cannot be set separately, so the request would either fail
  or present the wrong name to the server.
- **Documenting the convention and trusting the caller.** That is what ADR 0021 already did,
  and ADR 0025 exists because the documentation and the code had drifted apart.
