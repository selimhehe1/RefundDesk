# ADR 0008 - Stripe App standalone packaging and local preview boundary

- Status: Accepted
- Date: 2026-07-25
- Owners: Engineering and security

## Context

The Stripe CLI packages `apps/stripe-app` as a standalone project. The first unpublished test-mode
upload succeeded only after using the pnpm 10 dependency graph expected by that packaging path,
while the repository workspace itself uses pnpm 11.

The current Stripe Apps CLI also rejects loopback HTTP origins in the UI extension `connect-src`
policy. A short-lived public HTTPS tunnel is therefore required to run the local Phase 0 overlay,
even though the uploaded manifest must keep the direct probe and live operation disabled.

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

The installed evidence remains unpublished version `0.1.0`. Current source is version `0.1.1` and
has not been uploaded. Any future upload must come from a clean commit and record the source commit
and artifact checksum.

## Consequences

- Stripe App packaging is reproducible independently of the workspace dependency graph.
- Local Phase 0 testing can satisfy Stripe's CSP rules without weakening the uploadable manifest.
- The temporary tunnel expands the local API's network exposure, so short lifetime, strict
  signatures and immediate shutdown remain mandatory.
- Dependency upgrades must update and validate both lockfiles.

## Rejected alternatives

- Reuse only the workspace lockfile: the Stripe CLI packages the extension independently.
- Put the probe or tunnel origin in the uploadable manifest: this would expose development controls
  in an installed artifact.
- Forward arbitrary launcher arguments: this could bypass the test-only boundary.
- Claim DNS validation prevents rebinding: a one-time lookup cannot provide that guarantee.
