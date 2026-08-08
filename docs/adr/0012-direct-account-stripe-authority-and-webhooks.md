# ADR 0012 — Direct-account Stripe authority and webhook provenance

## Status

Accepted — API-version decision amended 2026-07-30

## Context

ADR 0001 excludes Stripe Connect from the pilot. Nevertheless, the first hosted implementation
used `Stripe-Account` request options and required `Event.account`, which are connected-account
semantics. Real calls made with the platform test credential and a `Stripe-Account` header against
the intended external test and managed-sandbox accounts returned Stripe `account_invalid`.

The successful Phase-0 connected-event evidence remains valid for its historical artifact, but it
cannot prove the hosted pilot topology. Workbench exposes the required Refund and application
lifecycle event types on account-scoped destinations in both target environments.

On 30 July 2026, reauthorizing unpublished Stripe App `0.1.4` produced a real
`account.application.authorized` delivery in the managed sandbox. Workbench showed the
account-scoped destination configured for `2026-06-24.dahlia`, while the signed Event body's
`api_version` was `2026-02-25.clover`. Backend revision `71bbd98...` returned HTTP 400
`API_VERSION_MISMATCH` before persistence. This disproves the earlier assumption that every Event
sent to a Dahlia-configured destination necessarily carries Dahlia in `Event.api_version`. It proves
only real delivery of `authorized` in that one environment; it is not successful lifecycle
processing, deauthorization evidence or uninstall coverage.

## Decision

The fixed two-account pilot uses direct-account credentials and direct-account webhook
destinations:

- `/api/webhooks/stripe-account/test` is bound to
  `STRIPE_PLATFORM_TEST_ACCOUNT_ID`;
- `/api/webhooks/stripe-account/sandbox` is bound to
  `STRIPE_MANAGED_SANDBOX_ACCOUNT_ID`;
- `/api/webhooks/stripe-account/live` remains disabled and is blocked at public ingress;
- every legacy `/api/webhooks/stripe-connected/*` route is absent and blocked at public ingress.

Each test/sandbox destination remains configured for API version `2026-06-24.dahlia`, uses its own
signing secret and has account scope (`connect=false`). After verifying the signature over the raw
body, ingress:

1. rejects `livemode=true`;
2. applies an exact event-type/API-version allowlist:
   - `refund.created`, `refund.updated` and `refund.failed` require
     `2026-06-24.dahlia`;
   - `account.application.authorized` and `account.application.deauthorized` accept only
     `2026-06-24.dahlia` or the explicitly observed lifecycle serialization
     `2026-02-25.clover`;
   - null, arbitrary, prefix-only and every other version combination are rejected before
     persistence;
3. rejects the presence of `Event.account`, even when it equals the configured account;
4. derives the Stripe account only from the route's validated configuration;
5. resolves or provisions only the installation for that account and environment.

The Clover exception is not general backward compatibility. It is restricted to the two exact
Stripe App lifecycle types, whose normalized payload contains only the expected App ID and common
Event metadata. A Clover Refund remains rejected. Any additional lifecycle version requires a
reviewed ADR amendment, negative regression coverage and new real sandbox evidence.

`2026-06-24.dahlia` remains the only Refund object contract. The destination's configured version
and `Event.api_version` were observed to differ for one Stripe App lifecycle delivery, so operator
evidence records both fields without treating either as proof of the other.

The web read credential and worker effect credential for an environment are both bound to the same
expected account ID. Release preflight rejects a web/worker account-ID mismatch and rejects reuse of
one account ID across test and managed sandbox. The Stripe adapter never sends `Stripe-Account` and
refuses an installation/account mismatch before constructing a Stripe client or making a network
call. Objects carrying Connect semantics remain ineligible.

PostgreSQL records new receipts as `account_test` or `account_sandbox`. Historical
`connected_test` and `connected_sandbox` receipts are not rewritten and remain recoverable.
Uniqueness is enforced by `(stripe_account_id, stripe_event_id)` across both provenance families so
an overlapping migration cannot process the same Stripe Event twice.

`account.application.authorized` and `account.application.deauthorized` remain candidate lifecycle
signals filtered by the configured Stripe App ID and the exact type/version allowlist above. One
real managed-sandbox `authorized` delivery first exposed the version mismatch, then corrected
revisions processed managed-sandbox authorization successfully. Revision `4521b8c9...` also
processed an exact replay of a real managed-sandbox deauthorization Event. Until successful
processing is proven in both environments, Administrator-signed `context/sync` remains the
provisioning authority. Until test-account lifecycle and an automatic post-fix managed-sandbox
deauthorization delivery are proven, uninstall safety remains open. Lack of activity and manual
state editing never simulate deauthorization.

## Consequences

- The hosted backend can operate with the actual direct-account restricted keys already proven in
  test and managed sandbox.
- A body, header or connected Event cannot choose the tenant or Stripe account.
- Historical connected-webhook evidence is retained but does not satisfy the new hosted
  direct-account gate.
- The direct-account gate remained `BLOCKED_REAL` until separately signed Refund deliveries were
  observed and deduplicated on both hosted endpoints.
- This topology is suitable only for the fixed two-account pilot. Marketplace distribution or
  arbitrary multi-tenant installation would require a new credential/destination registry and a
  separate ADR.

## Observed implementation evidence — 2026-07-28

Backend revision `42a1e4e65cf6e9144261a077c6956e77b368fffc` received and processed one real
`refund.created` on each account-scoped hosted endpoint. Each source object was synthetic and
`livemode=false`. A manual Stripe Workbench replay produced a second successful delivery attempt
but no second receipt, alert or durable transition. The redacted proof is
`stripe-hosted-direct-webhooks-2026-07-28.json`, SHA-256
`b0d85e964aa440dcda32dd601b48be11f3826fcc750f90b56a0c8ac2eabc737e`.

After two fresh Dashboard checks showed no visible delivery history on the identified obsolete
connected test destination, that destination was deleted. The current direct destination and its
configured events remained unchanged. Historical `connected_*` database receipts were neither
deleted nor relabelled. No live request, Connect header or unrelated endpoint mutation occurred.

The hosted direct-account Refund delivery/replay gate is therefore `PASSED_REAL` for test and
managed sandbox. Real App install/uninstall lifecycle-signal evidence remains a separate open gate.

## Observed lifecycle-version incompatibility — 2026-07-30

Unpublished App `0.1.4` reauthorization emitted a real managed-sandbox
`account.application.authorized`. The account-scoped destination displayed
`2026-06-24.dahlia`, the signed Event carried `2026-02-25.clover`, and backend `71bbd98...`
returned HTTP 400 `API_VERSION_MISMATCH` before any receipt or lifecycle transition. No live object
or financial effect was involved. This observation motivated the narrow type/version amendment; it
does not close any lifecycle gate.

## Observed lifecycle processing — 2026-07-30

Backend `4521b8c9e783d807813686476e4e01dfaf85e798` processed an exact Workbench replay of a real
managed-sandbox `account.application.deauthorized` Event with HTTP 200. It created one receipt and
one applied audit, moved the installation to deauthorized and the tenant to pending deletion, and
created no financial effect. A second replay was deduplicated. This closes the code-processing
failure for that exact Event but does not claim an automatic post-fix delivery.

App `0.1.4` was then freshly installed through Stripe's official external-test flow in the distinct
managed sandbox. Its automatic `account.application.authorized` delivery returned HTTP 200 and was
applied once; the manual replay was deduplicated. Final preflight found one clean active
installation, no failed lifecycle receipt and no financial effect. Test-account lifecycle remains
unproven. The redacted combined proof is
`hosted-sandbox-4521b8c9-lifecycle-backup-restore-2026-07-30.json`, SHA-256
`f5b41ee5f192a5744fdeed762845747cfb82e3284cde6a346fc33a6b27322d5f`.

## Rejected alternatives

- Keep sending `Stripe-Account`: real calls fail and Connect is outside the pilot.
- Accept `Event.account` when it matches configuration: silently mixes two delivery authorities.
- Infer the account from the body, a caller-controlled header or the first installation: permits
  cross-environment or cross-tenant confusion.
- Relabel historical receipts: destroys provenance and could transfer evidence between
  architectures.
- Treat `context/sync` as uninstall evidence: provisioning refresh cannot prove that Stripe removed
  the App.
