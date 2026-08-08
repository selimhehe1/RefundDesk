# ADR 0013 - Unpublished hosted-sandbox Stripe App origin

- Status: Accepted
- Date: 2026-07-28
- Owners: Engineering and security

## Context

Unpublished Stripe App `0.1.2` proved the UI and signed distinct-user workflow through a temporary
local manifest overlay. Its uploadable manifest deliberately retained a fail-closed placeholder
origin, so the installed immutable artifact could not call RefundDesk by itself.

The persistent AWS sandbox is now healthy at one stable HTTPS origin. It runs immutable revision
`42a1e4e65cf6e9144261a077c6956e77b368fffc`, keeps both live interlocks false, rejects unsigned
mutations, exposes no public readiness or internal route, and has direct-account test and managed
sandbox webhook evidence. At decision time, the current Stripe App source was version `0.1.3` and
had not previously been uploaded; the implementation evidence below records its subsequent
unpublished upload and installation.

## Decision

The uploadable `0.1.3` manifest uses only:

```text
https://refunddesk-sandbox-35-181-162-193.sslip.io/api
```

as `API_BASE`, with the exact corresponding `/api/` CSP source. It keeps
`PILOT_LIVE_ENABLED=false`, the existing four minimal permissions, and no Phase-0 or local-preview
surface.

This origin is authorized only for an unpublished test/sandbox engineering version. Upload does not
authorize Stripe review, a distribution channel, Marketplace publication, live mode or customer
data. A clean Git commit, standalone pnpm 10.30.3 gates and a reproducible source checksum are
required before upload. Installation and runtime evidence must name the exact version; evidence
from `0.1.0`, `0.1.1`, `0.1.2` or a local overlay does not transfer.

Every request carrying tenant data or a mutation remains authenticated by the signed Stripe request
contract. The hosted API continues to revalidate account, environment, identities, object state and
financial invariants independently of manifest constants.

Any API-origin change requires a new Stripe App version and new installation evidence. The sandbox
origin must never be reused as evidence for a future live or production origin.

## Observed implementation evidence — 2026-07-28

Stripe App `0.1.3` was uploaded unpublished from clean commit
`c241a097fc5f4b8e8eaa2f057f9c7db40d9dffa3` after all 69 standalone tests, lint, build, manifest
validation and production audit passed. The reproducible Git source archive has SHA-256
`f8b792876ce8d1fe969a5d24e8ab3c5a37d13eb89755ed223caa3f7a61471611`. Stripe reported
`UPLOAD_COMPLETED`; this does not claim access to or a checksum for Stripe's internal upload ZIP.

The external test channel selected `0.1.3`, the installed-app row showed that exact version, and the
distinct test sandbox reauthorized permissions for the hosted origin with no remaining update
prompt. The external-tester counter was not used as installation evidence.

The exact commit source rendered in Stripe developer preview and generated a real Stripe signature.
A test harness relayed the exact request bytes and signature unchanged to the hosted
`/api/v1/payments/eligibility` route, which returned HTTP 200 with a valid response schema. No
financial effect was performed. These are operator observations: the raw signed capture and
temporary harness were intentionally destroyed, so the event-level hashes cannot be reproduced
from the redacted artifact alone.

The controlled browser profile intercepted direct cross-origin delivery with
`ERR_BLOCKED_BY_CLIENT` before a normal response could be observed. Native direct-browser
end-to-end delivery therefore remains `BLOCKED_TOOLING`. The signed relay proves Stripe signature
generation plus hosted verification, not browser transport or a hosted financial happy path.

The redacted artifact
`stripe-app-0.1.3-install-signed-runtime-2026-07-28.json` has SHA-256
`33c5ceac81ede68a3469fcd4f472ecd9944fda62f1ec64686308572bdb463c0c`.

## Consequences

- The immutable unpublished App is configured for the hosted sandbox without a local overlay.
  Direct browser-profile delivery is not claimed until the tooling limitation is removed.
- The CSP stays exact and contains no wildcard or development tunnel.
- The installed App and backend may have different Git commit IDs when the later commit changes only
  the Stripe App manifest and tests; evidence must prove the backend trees are otherwise unchanged.
- The version remains unsuitable for commercial live use, review submission or Marketplace
  publication.

## Rejected alternatives

- Keep the placeholder origin: fail-closed but incapable of producing immutable installed-runtime
  evidence.
- Upload a generated local manifest: violates ADR 0008 and loses release provenance.
- Use a wildcard or temporary tunnel in `connect-src`: unnecessarily broadens the installed
  artifact.
- Enable live mode for convenience: outside the authorized cycle and blocked by both runtime
  interlocks.
