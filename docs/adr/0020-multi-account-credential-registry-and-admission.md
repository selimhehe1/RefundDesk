# ADR 0020 — Stripe API authentication model and account admission

- Status: Proposed — requires owner ratification before any implementation beyond the
  admission hardening described in "First increment"
- Date: 2026-08-03
- Owners: Security, engineering and product

> Revised on 3 August 2026, before ratification. The first draft decided to build a
> multi-account **credential registry**. Stripe's documented authentication model shows
> that framing was wrong: the registry would reimplement `restricted_api_key` by hand,
> paying the full cost of storing merchant secrets without Stripe's tooling. The decision
> below replaces it. Only an unratified `Proposed` ADR may be revised this way; the
> immutability rule in `README.md` applies after acceptance.

## Context

`PLANS.md` lists "decide the multi-account architecture replacing the fixed-account
boundary" among the prerequisites to revisiting the commercial `NO_GO` verdict. This ADR
records that decision. It supersedes nothing; it extends ADR 0010 and ADR 0012 with the
shape a multi-account deployment must take.

### The boundary as it exists today

The fixed-account boundary is not one mechanism but three cumulative ones.

1. **Configuration cardinality is frozen at two.** `PlatformConfig.stripe` and
   `WorkerConfig.stripe` (`packages/config/src/index.ts:569-579`, `:593-600`) are scalar
   fields named `platformTest*` and `managedSandbox*`, not collections indexed by account.
   A third account would need new variable names, which production rejects by static
   allowlist (`index.ts:646-669`, `:727-749`) and which the topology contract pins
   (`deploy/lightsail/topology-contract.test.mjs:1113-1179`).
2. **Credentials resolve by environment, never by account.**
   `StripeCredentialResolver.resolve()` (`packages/stripe-adapter/src/index.ts:47-69`) is a
   `switch` on `installation.environment` with two branches, followed by the equality
   assertion `installation.stripeAccountId !== credential.expectedAccountId`
   (`:64-68`). The database may hold N installations; only two account values can pass.
3. **One webhook secret per route, one route per account.**
   `defaultDependencies(endpoint)` (`apps/platform/src/server/account-webhook.ts:279-301`)
   maps the endpoint to a signing secret and an expected account, and the account is fixed
   before the body is read (`:428`). The routes are physical files with a literal
   environment.

The data model is already ahead of the runtime. `stripe_installations` carries
`stripeAccountId` and `environment` (`packages/db/prisma/schema.prisma:175-203`), RLS is
forced and fails closed on a missing `app.tenant_id`
(`packages/db/src/tenant-transaction.ts:98`), and the worker already iterates over every
active installation (`refunddesk_list_scannable_installations`). Two data-level facts
constrain the decision: `@@unique([stripeAccountId, environment])` is **global**, not
scoped by tenant (`schema.prisma:197`), and `refunddesk_provision_installation` always
creates a **new** tenant for an unknown pair, so the 1-N `Tenant → StripeInstallation`
relation is structurally unused.

### The defect this exposes

Account admission does not exist. `context.sync` provisions on demand for any
Administrator (`apps/platform/src/server/pilot-service.ts:236`), and
`refunddesk_provision_installation` validates only that the environment is not `live` and
that the identifier matches `^acct_[A-Za-z0-9]+$` — there is no account allowlist. Any
Stripe account that installs the App can therefore create a tenant row. The first
rejection happens later, at the first Stripe call, and `StripeAccountMismatchError` is
mapped to `500 INTERNAL_ERROR` (`apps/platform/src/server/pilot-errors.ts:36-41`) rather
than a `403`.

No financial effect follows: without a credential for that account no Refund can be read
or created, and RLS keeps the rows isolated. The exposure is unbounded tenant creation and
an error contract that reports a rejected caller as a server fault.

## Decision

### 1. Accounts are admitted explicitly, never by installation alone

An account becomes known to RefundDesk only by being registered. Provisioning checks
membership before creating anything, and a caller whose account is not registered receives
`403 ACCOUNT_ENVIRONMENT_MISMATCH`, never `500`. Installing the App is not consent to
create a tenant.

This holds in both the current two-account deployment and any future multi-account one; it
is the part of this ADR that can be implemented immediately.

### 2. The Stripe authentication model is `platform`, with `oauth` as the defined fallback

A Stripe App declares one of three values for `stripe_api_access_type`:

- **`platform`** — the publisher's own secret key acts on behalf of the merchant's account,
  identified by `Stripe-Account`. No merchant secret is stored anywhere.
- **`oauth`** — an access token per account, issued automatically at install and revocable
  at uninstall.
- **`restricted_api_key`** — Stripe generates a key at install that **the merchant must
  copy and paste** into the software. Documented for software that supports neither
  platform signup nor OAuth.

`apps/stripe-app/stripe-app.json:54` already declares `platform`, and the manifest declares
exactly the four permissions RefundDesk needs (`:31-48`). The runtime, however, abandoned
that mechanism after real calls returned `account_invalid` (ADR 0012) and now uses
restricted keys created by hand in the two accounts the publisher controls. That is
`restricted_api_key` reimplemented manually, and it does not survive contact with real
customers: no merchant can be asked to mint a key and hand it over.

The target is therefore `platform`. It removes the problem rather than solving it: with no
merchant credential to hold, there is no registry, no per-account key rotation, no web and
worker split over merchant material, and a far smaller compliance surface.

`oauth` is the defined fallback if the test below refutes `platform`. It keeps installation
automatic and revocation real, at the cost of a token store that must respect ADR 0010's
separation.

`restricted_api_key` is rejected for a public Marketplace app: every merchant would perform
a manual paste, and RefundDesk would hold long-lived merchant secrets to no benefit.

### 2b. The test that settles it

The historical `account_invalid` is not yet explained. The most likely cause is that the
call used a **restricted key belonging to one account** together with a `Stripe-Account`
header naming a different account; an `rk_` cannot act for a third-party account. The
`platform` model requires the publisher's own secret key. This is a hypothesis, and the
decision above is provisional until it is tested.

The test must use the publisher's platform secret key — never a restricted key of another
account — against an account that has genuinely installed the App, and must exercise the
four declared permissions: read a PaymentIntent, read a Charge, read Events, and create one
allowlisted synthetic Refund through the normal distinct-requester/approver workflow. It
emits a redacted `PASS_PLATFORM_ACCESS` or `FAIL_PLATFORM_ACCESS` with the exact Stripe
error code, and never a credential value.

It calls Stripe, so it waits for the exact-e4 rotation to complete. Until it returns, no
registry, no OAuth flow and no per-account webhook destination may be built.

### 3. Webhook delivery keeps ADR 0012's rule; its multi-merchant shape is deferred

One rule is decided and unconditional: the account is derived from the route or the
verified delivery, **never from the body**, and a present `Event.account` is rejected.
Selecting a signing secret by reading the payload is rejected outright, because it would
require parsing unverified input to choose the key that verifies it.

The concrete shape for N merchants is deferred to the same test as decision 2. Today's
destinations are created by hand in two accounts the publisher controls, which no more
survives real customers than the manual keys do. How events reach RefundDesk for an
installed account depends on the authentication model that the test confirms, so committing
to a route shape now would be guessing.

### 4. Cryptographic keys stay global

Field encryption, refund-proof HMAC, approval-attestation HMAC and export signing remain
single global keyrings. Their AAD and canonical payloads already bind `tenantId`,
`stripeAccountId` and `environment`, which prevents replaying a ciphertext or a proof from
one account into another. Per-account derivation is rejected for now: it would multiply
rotation surfaces without closing a demonstrated attack, and rotation is already an open
gate. The accepted consequence is explicit: a key compromise spans every account, and no
per-tenant rotation is possible.

### 5. Tenant-to-installation cardinality is left unchanged in this ADR

One tenant per `(account, environment)` remains, and the global uniqueness of
`(stripe_account_id, environment)` remains. Letting one tenant own several installations —
the same customer's test and sandbox — is a separate decision with data-migration
consequences and no bearing on the credential boundary. It is deferred, not implied.

## First increment

Only the admission hardening is authorized by this ADR without further review, because it
narrows behaviour rather than widening it and needs no schema or credential change:

- provisioning verifies that `(account, environment)` is configured before creating a
  tenant or installation;
- an unregistered account receives `403 ACCOUNT_ENVIRONMENT_MISMATCH`;
- a regression test covers both the rejection and the continued success of the configured
  accounts.

Everything else — the authentication model beyond its provisional target, the
multi-merchant webhook shape, and any change to the startup invariants — requires the test
in 2b, ratification, and its own implementation plan.

## Consequences

- The one-account boundary becomes an admission decision that is stated and tested, instead
  of an accident of which credentials happen to be configured.
- A caller from an account RefundDesk does not serve is told so, and operators stop seeing
  rejected callers as server faults.
- If `platform` is confirmed, RefundDesk never holds a merchant credential: the whole class
  of per-merchant key storage, rotation and leakage disappears rather than being managed.
- If `platform` is refuted, `oauth` reintroduces a per-account token store, and ADR 0010's
  web/worker separation must be re-established over those tokens.
- The manifest already declares `platform` while the runtime does not use it. Until 2b
  returns, that discrepancy stands and must not be presented as a working model.
- This ADR authorizes no live mode, no Connect semantics, no Marketplace action and no
  change to the contained incident state.

## Rejected alternatives

- **A hand-managed multi-account credential registry** (this ADR's own first draft). It
  reimplements `restricted_api_key` without Stripe's tooling: RefundDesk would carry the
  full cost of storing, separating and rotating merchant secrets, and merchants would still
  have to hand them over.
- **`restricted_api_key` as the published model.** Every merchant performs a manual paste,
  which is unacceptable for a public Marketplace app.
- **Deriving the account from the webhook body.** It requires trusting unverified input to
  select the secret that verifies it, and contradicts ADR 0012.
- **One credential set per environment with an account allowlist.** It keeps a single key
  able to act on several accounts, so a leaked key widens instead of being contained.
- **Per-account cryptographic keys.** Rejected for now; see decision 4.
- **Leaving provisioning open and relying on the credential mismatch.** That defers the
  rejection to the first Stripe call, reports it as `500`, and lets any installer create
  tenant rows.
