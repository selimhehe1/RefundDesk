# ADR 0031 — A CloudFront network filter is not origin identity

- Status: Accepted
- Date: 2026-08-08
- Owners: Security and operations
- Supersedes: ADR 0029's `CloudFront-only` and equivalent-control conclusions

## Context

ADR 0029 records a bounded public-ingress window on 3 August 2026 and a Lightsail allowlist made
from AWS `CLOUDFRONT_ORIGIN_FACING` prefixes. It also records that the measured e4 Caddyfile had no
origin-token check and that the named CloudFront distribution sent no custom origin header.

Those prefixes identify AWS CloudFront origin-facing infrastructure in general. They do not prove
that a request came through RefundDesk's expected distribution. A third party able to route a
request through another CloudFront distribution can still originate from the same prefix set.
The network rule therefore cannot provide the distribution identity that the missing secret header
was intended to establish.

The repository does not contain an independently reconciled redacted artifact that binds the
historical window's authorization, before/after containment, probes, active revision and unchanged
financial/receipt counts. The observations recorded by ADR 0029 must not be promoted into an
admitted reopening gate without that artifact.

## Decision

- Describe the AWS prefix allowlist only as a generic CloudFront source-network filter. Never call
  it `our CloudFront only`, an origin identity proof or an equivalent replacement for a secret
  distribution-to-origin binding.
- Retain ADR 0029 as a historical record, but treat its operational observations as unadmitted
  until a complete redacted artifact and the applicable authorization are independently reviewed.
- Before any new public-ingress window, require a current-host postflight, complete CI and attested
  bundle for one exact revision, incident-review closure, separate authorization, a configured
  CloudFront custom origin header, local Caddy missing/wrong-token denial and correct-token
  traversal, and a freshly captured network prefix set.
- During and immediately after that explicitly authorized bounded window, require public health, a
  real test/sandbox Stripe delivery, unchanged financial and receipt counters, final listener
  closure and one contemporaneous redacted before/after artifact. A failed or ambiguous observation
  closes the window without authorizing a retry.
- Keep ports 80/443, public Caddy, worker and maintenance timers stopped while any prerequisite is
  missing. Live remains disabled.

## Consequences

- Network filtering remains useful defense in depth, but it does not authenticate the expected
  distribution.
- The approximately two-minute window recorded by ADR 0029 cannot authorize or shorten a future
  reopening procedure.
- Any current-state statement must come from a new redacted postflight; historical e4 measurements
  do not establish the host's state after later release attempts.
