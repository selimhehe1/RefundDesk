# ADR 0018 — Trusted edge admission and two-stage approval attestation

## Status

Accepted

## Context

ADR 0017 added a durable PostgreSQL GCRA after Stripe authentication, but invalid or missing
signatures could still consume body-reading and private-worker verification capacity. The public
Lightsail origin was also directly addressable, so a source limiter based on a public
`X-Forwarded-For` header would have been attacker-controlled.

The original ADR 0011 verifier contract also combined signature verification with approval
attestation persistence. Consequently, a valid approving request could persist an attestation
before ADR 0017 admitted its authenticated account scope. That contradicted the intended rule that
the durable account limiter precedes every workflow-related write.

## Decision

The hosted public path is CloudFront to the stock pinned Caddy image to one web process. CloudFront
must attach a random 32-byte base64url origin token in `X-RefundDesk-Origin-Token`. Caddy rejects a
missing or unequal token with `404` before proxying, freezes the incoming CloudFront
`X-Forwarded-For` chain, overwrites the private upstream headers
`X-RefundDesk-Edge-Verified: cloudfront-v1` and `X-RefundDesk-Viewer-Chain`, and removes the origin
token before the request reaches Next. The application never trusts public forwarding headers or
falls back to the Caddy peer address. It accepts only the rightmost IP in a bounded, syntactically
valid chain because CloudFront appends the actual viewer address on the right.

Caddy additionally limits request headers to 64 KiB and applies bounded header-read, body-read,
write and idle timeouts. Hosted application admission rejects any request for which the origin
token survived the Caddy hop. This both adds defense in depth and lets a successful local-origin
probe establish token removal without exposing the token through a diagnostic response.
`persist_config off` prevents Caddy from expanding the origin token into its autosaved native JSON.
The release removes only the exact legacy public-Caddy autosave file after validating every parent
as a real fixed-path directory, before any candidate runtime starts; deployment verification fails
if that file remains. The Caddy environment parser is byte-strict and rejects comments, blanks,
duplicates and CRLF before release mutation.

Before reading a body or performing any signature verification, the web process applies a
process-local, no-wait admission gate. It previews GCRA and capacity in this order: source budget,
admitted-work global class budget, then a concurrency lease. A tracked source commits its source
budget as soon as that preview passes, so it cannot capture every later global refill. An unseen
source stays provisional and is retained only after all three checks pass. The global budget is
committed only for fully admitted work. Source identifiers are HMAC-SHA-256 digests under a random
per-process key; raw IP addresses and chains are never retained or logged. IPv4 uses a `/32` scope
and IPv6 a canonical `/64`. The fixed total of 2,048 source scopes is split into independent maps:
1,920 signed API, 64 direct-account webhook and 64 audit-download scopes. One traffic class cannot
evict another. Only five-minute-idle scopes without debt or an active lease may be removed, and a
full map is swept at most once per minute.

A source denial does not consume the admitted-work global budget. A tracked source that passes its
own budget remains charged if the later global or concurrency control denies it, while an unseen
source rejected at either stage is never retained. Thus one noisy known source cannot starve peers
and rejected address churn cannot fill the source map. When a source map is full, unseen sources are
denied through a separate fixed per-class overflow GCRA; this keeps that path O(1) and metered
without spending admitted-work capacity. A distributed set of fully admitted pre-authentication
requests can still consume the global budget and pin the bounded source map until eligible entries
become idle; upstream network controls remain necessary for that residual denial-of-service risk.

The policies are:

| Class                  | Source burst / interval | Global burst / interval | Concurrent verification |
| ---------------------- | ----------------------: | ----------------------: | ----------------------: |
| Signed Stripe App POST |            100 / 250 ms |            200 / 100 ms |                      16 |
| Direct-account webhook |             40 / 500 ms |             80 / 200 ms |                       8 |
| Audit download         |                5 / 10 s |                20 / 2 s |                       2 |

Hosted direct-account webhooks additionally require their rightmost source to be in the versioned
official Stripe webhook IP list before body allocation and HMAC verification. Signature
verification remains mandatory. Development and tests do not traverse CloudFront, so they collapse
all callers into one synthetic local source and never trust caller-supplied forwarding headers.
Signed and webhook streams have an absolute 30-second application body deadline in addition to
Caddy's timeout. The reader checks the clock inside the stream loop, accepts at most 1,024 chunks
and copies into one fixed maximum-size buffer, preventing already-buffered microtasks or tiny
fragments from bypassing the time or memory bound. Expiry cancels the stream and releases its lease
before verification or database work. Audit-download admission precedes bearer HMAC verification
and holds its lease through the bounded transaction and CSV rendering.

The signed-request authority is split into two exact private POST endpoints using the same narrow
service bearer and 32 KiB body ceiling:

1. `/internal/v1/signed-requests/verify` validates the exact raw Stripe signature and canonical
   test/sandbox envelope and returns only the envelope plus its SHA-256 hash. It performs no store
   access.
2. After route/resource/command validation and successful ADR 0017 admission, an approving decision
   is sent as the same raw bytes and signature to `/internal/v1/signed-requests/attest`. The worker
   re-verifies both, persists the idempotent approval attestation, and returns its identifier plus
   the same hash and envelope. Web fails closed unless all returned bindings equal the first
   verification. It recalculates SHA-256 from the retained raw bytes before the second call, accepts
   only exact HTTP `200` success, maps only an `/attest` nonce conflict to public `409`, and retains
   the edge concurrency lease until attestation completes. The lease is released before dispatch.

An edge capacity denial returns generic `429` with a positive `Retry-After`; malformed trust state,
clock or limiter failure returns generic retryable `503`; a non-Stripe webhook source returns
generic `403`. None of these paths reads the body, calls the worker, creates an attestation, resolves
a tenant or writes a webhook receipt. Operational signals contain only an allowlisted event name
and bounded aggregate counts: one immediate warning, then at most one aggregate per event per
minute.

This ADR supersedes ADR 0011 only where one `/verify` call both verified and persisted. It clarifies
ADR 0017: its durable authenticated limiter remains after pure verification, but now precedes every
approval-attestation write.

## Consequences

- Missing and invalid signed requests can no longer allocate verifier work without passing bounded
  process-global and source admission.
- Slow or oversized direct-origin HTTP requests are bounded at Caddy before application admission.
- Slow application request streams are cancelled after 30 seconds, and rejection logging is
  process-locally aggregated.
- Signed, webhook and audit source-cardinality budgets are isolated, and audit bearer replay is
  bounded before HMAC and database access.
- A durably rate-limited approval cannot create an attestation.
- Webhook source filtering is defense in depth; it never replaces Stripe signature verification.
- The process-local gate resets on web restart. More than one web replica would multiply its budget
  and requires a new architecture review.
- A distributed attacker can exhaust the global budget and deny legitimate traffic, but cannot
  drive protected verification work without bound.
- Stripe can change its webhook IP list. The pinned list must be reviewed against the official
  source before every hosted release and immediately after a Stripe notification.
- The CloudFront custom header and root-owned Caddy value must be changed as one controlled release.
  Public ingress must remain closed if either side is missing or if the exposed Stripe credentials
  have not completed their independent rotation proof.
- Caddy autosave stays disabled; a stale autosave is deleted and its absence proved before the
  origin token may be used.
- The stock Caddy image remains unchanged; no third-party rate-limit module, WAF or paid resource is
  introduced.

## Required evidence

Before reporting this boundary as hosted and operational, prove on the exact candidate revision:

- deterministic burst/refill, source-first admission, admitted-work global consumption,
  concurrency release, per-class source-cardinality isolation, separately metered O(1) overflow,
  bounded sweep and restart behavior;
- spoofed-left XFF resistance, strict malformed-chain failure and IPv4/IPv6 normalization;
- edge rejection before body reads, worker calls, Stripe HMAC, attestation and database access;
- signed/webhook absolute body deadlines plus audit-download admission before bearer HMAC/database;
- bounded aggregate operational signals under repeated denials;
- pure `/verify`, second-pass `/attest`, exact response binding and no attestation on a durable
  `429`;
- Caddy validation with the stock pinned image, missing/wrong-token `404`, correct-token local
  traversal, application-enforced token stripping, bounded server timeouts/header size and preserved
  CloudFront viewer source, plus disabled/absent autosave;
- a CloudFront viewer traversal and a real Stripe test/sandbox webhook from an officially listed
  Stripe address;
- exact CI and revision evidence.

Repository tests, fixtures and synthetic local HMACs do not prove CloudFront configuration, a real
Stripe source, hosted operation, live mode or Marketplace readiness.
In particular, the synthetic signed relay traverses local Caddy only. CloudFront raw-body
preservation is closed only by a real Stripe test/sandbox delivery that passes both the source
allowlist and Stripe signature verification.

## Rejected alternatives

- Caddy rate-limit plugins: they require a custom image and broaden the supply chain.
- AWS WAF for this pilot: its fixed and request costs threaten the approved EUR 10 monthly ceiling.
- Public `X-Forwarded-For` scopes: a direct-origin caller can choose them.
- Durable PostgreSQL scopes before signature verification: an attacker could create arbitrary
  shared rows from untrusted account identifiers.
- Keeping `verifyAndAttest`: the durable authenticated limiter would remain after an append-only
  financial authorization artifact.
- Letting web submit an already-parsed envelope to the attester: a compromised web process could
  substitute approval content. The worker must re-verify the exact original bytes and signature.
