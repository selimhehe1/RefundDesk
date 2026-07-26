# ADR 0008 - Stripe App standalone packaging and local preview boundary

- Status: Accepted
- Date: 2026-07-25
- Last updated: 2026-07-26
- Owners: Engineering and security

## Context

The Stripe CLI packages `apps/stripe-app` as a standalone project. The first unpublished test-mode
upload succeeded only after using the pnpm 10 dependency graph expected by that packaging path,
while the repository workspace itself uses pnpm 11.

The current Stripe Apps CLI also rejects loopback HTTP origins in the UI extension `connect-src`
policy. During the Phase-0 evidence window, a short-lived public HTTPS tunnel was therefore used to
run the local overlay. The uploaded `0.1.1` manifest contains no direct probe surface and keeps live
operation disabled.

## Decision

The workspace keeps its pnpm 11 pin. `apps/stripe-app` carries explicit direct dependencies, an
independent pnpm 10.30.3 lockfile and an independent ESLint configuration. CI verifies install,
lint, build, tests and production audit against that exact standalone graph with
`--ignore-workspace`.

The uploadable `stripe-app.json` always keeps `PILOT_LIVE_ENABLED=false` and contains no Phase-0
runtime switch or endpoint. The local launcher:

- accepts no CLI arguments or live-mode flags;
- accepts only an HTTPS public-DNS hostname and verifies its resolved addresses at startup;
- uses only a short-lived, operator-controlled tunnel;
- invokes Stripe without a command shell;
- derives an ignored local manifest that points to the temporary development API while forcing live
  mode off;
- removes the generated manifest and `.build` output when the CLI exits;
- never uploads generated development artifacts.

DNS validation is only a startup snapshot and is not treated as a defense against later rebinding.
Every mutating or tenant-data route remains authenticated according to its route contract, and the
tunnel exists only for the evidence window. If the tunnel forwards the complete Next.js origin,
the landing page and bounded health/readiness endpoints are also reachable without a Stripe
signature; prefer a path-restricted proxy where available and otherwise minimize the exposure
window.

The distinct external-account installation evidence remains attributed to unpublished version
`0.1.0`; that first upload did not preserve reproducible release provenance. Unpublished version
`0.1.1` was subsequently uploaded from clean commit
`100ae946ec593df1f21ba3efa6fe5c72ec366e89`, with packaged artifact SHA-256
`ec5fc4940092343c9d6bd8b25948ea31272666d4e041a2ff23d36f10e27446be`. The direct Refund probe
route, client call and UI control were removed before that snapshot.

The `0.1.1` upload proves clean packaging provenance but does not, by itself, prove an external
reinstall or rerun of that version. Earlier external-account observations remain attributed to
`0.1.0` unless separate evidence says otherwise. No live upload, Stripe review submission or
Marketplace publication occurred.

## Consequences

- Stripe App packaging is reproducible independently of the workspace dependency graph.
- Local Phase 0 testing can satisfy Stripe's CSP rules without weakening the uploadable manifest.
- The temporary tunnel expands the local API's network exposure, so short lifetime, strict
  signatures and immediate shutdown remain mandatory.
- Dependency upgrades must update and validate both lockfiles.
- Phase-0 `PASS` is an evidence-set verdict, not a claim that every case was rerun on one uploaded
  App version.
- An accepted unpublished upload establishes packaging feasibility, not external installation,
  Stripe review approval, Marketplace approval or live readiness.
- Every future uploaded version requires a new clean commit and recorded artifact checksum.

## Rejected alternatives

- Reuse only the workspace lockfile: the Stripe CLI packages the extension independently.
- Put the probe or tunnel origin in the uploadable manifest: this would expose development controls
  in an installed artifact.
- Forward arbitrary launcher arguments: this could bypass the test-only boundary.
- Claim DNS validation prevents rebinding: a one-time lookup cannot provide that guarantee.
