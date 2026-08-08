# ADR 0029 — CloudFront-only origin ingress, and the edge posture as measured

- Status: Accepted
- Date: 2026-08-03
- Owners: Security, engineering and operations

## Context

Reopening public ingress was authorised on the strength of the runbook's §2A description:
_"Hosted traffic is valid only through CloudFront and Caddy. CloudFront must overwrite
`X-RefundDesk-Origin-Token`… Caddy returns 404 before proxying when that token is absent or
wrong."_

That description does not match the deployed revision, and the discrepancy was found before
anything was opened. Two independent confirmations:

- `Caddyfile.public` for `e4cec060…` contains **zero** occurrences of
  `X-RefundDesk-Origin-Token` or `cloudfront-v1`;
- the CloudFront distribution `E3OSH9E8AJPRNH` reports `CustomHeaders.Quantity: 0` — it sends
  no origin header for Caddy to check.

The threat model was already honest about this: edge limiting and source filtering are
"implemented and locally tested but **not claimed as hosted**". It is §2A of the runbook that
reads as a live guarantee.

## What the deployed edge actually does, measured

Measured through CloudFront during a bounded window, not inferred:

| Probe                                                           | Result                                        |
| --------------------------------------------------------------- | --------------------------------------------- |
| `/api/ready`, `/internal*`, `stripe-connected`, `live` webhooks | `404` at Caddy                                |
| `/api/v1/*` unsigned                                            | `401`                                         |
| 15 unsigned `/api/v1/*` in a burst                              | `401` × 15 — **no `429`**                     |
| `/api/webhooks/stripe-account/sandbox` unsigned                 | `400`, **not** `403 WEBHOOK_SOURCE_FORBIDDEN` |

So on this revision the pre-authentication rate limiter and the webhook source filter are
**absent**, and Stripe signature verification is the only control on the two exposed paths.
The runbook expects a synthetic public caller to receive `403`; it receives `400`.

**Consequence for planning:** the "rate-limit E2E / edge" gate is not blocked by ingress. It is
blocked by the deployed revision predating the feature. No amount of reopening closes it.

## Decision

Enforce the CloudFront-only property **at the network layer**, since it cannot be enforced at
the application layer on this revision.

- Port **443 only** — the distribution's origin protocol policy is `https-only`, so port 80 is
  unnecessary. The stored certificate is valid to 26 October 2026, so no ACME challenge needs
  it either.
- Restricted to AWS's published `CLOUDFRONT_ORIGIN_FACING` prefixes: 45 IPv4 and 3 IPv6, frozen
  with their `syncToken` in
  `sandbox-evidence.local/aws/cloudfront-origin-ingress-allowlist-2026-08-03.local.json`,
  SHA-256 `ef5851c97eea38e3b17256066a2cadffa4931bf9d668c9fdfcd2d6e81809d611`.
- Applied with `open-instance-public-ports`, never `put-instance-public-ports`: the latter
  replaces the whole rule set and would have removed the SSH rule.
- `0.0.0.0/0` appears nowhere.

Both directions were proven, not assumed: a direct request to the origin from an address
outside the allowlist times out without establishing a connection, while the same request
through CloudFront reaches the application and is refused `401` with
`Via: 1.1 Caddy, 1.1 …cloudfront.net`.

## Consequences

- The property the runbook claimed now holds, by a different mechanism than it describes. The
  origin-token contract remains undeployed and is still the better control, because it survives
  an attacker who can route through CloudFront.
- Exposure lasted roughly two minutes. Containment `PASS_CONTAINED` before
  (`763d32a71f73…`) and after (`6692077a80ef…`); Caddy and worker stopped again, 443 closed,
  zero listeners, live disabled in both environments.
- **No financial effect and no webhook receipt were created during the window** — refund
  requests and receipt counts were identical before and after.
- The AWS prefix list changes over time. This allowlist is a snapshot; any future window must
  refresh it rather than reuse these 48 entries.

## Rejected alternatives

- **Opening `0.0.0.0/0`.** With no origin token and no source filter deployed, that would leave
  Stripe signature verification as the only barrier on a directly addressable origin.
- **Opening port 80 as well.** Nothing needs it: the origin policy is `https-only` and the
  certificate does not expire for months.
- **Deploying the origin-token contract first.** It is the right long-term answer, but it
  requires a new revision and a CloudFront change; the network restriction gives the same
  property today without touching either.
