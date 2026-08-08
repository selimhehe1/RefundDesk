# ADR 0021 — Outbound approval webhook notifications

- Status: Accepted — **corrected by ADR 0025.** Two statements in section 3 and one in
  section 4 describe behaviour that was never built: connection pinning to a checked
  address, save-time rejection, and per-installation encrypted storage. Read ADR 0025 before
  relying on any part of this ADR as a description of the running system.
- Date: 2026-08-03
- Owners: Product, security and engineering

## Context

RefundDesk enforces two-person approval but tells nobody. A request reaches its approver
only if that person independently opens the Dashboard drawer, and an undecided request
lapses after the configured window. For a tool sold to teams this is the largest remaining
product gap: it removes much of the value of an approval workflow.

`PLANS.md` defers notifications, and `Settings` states that they are intentionally
disabled. The owner lifted that deferral for this narrow channel only. E-mail remains
deferred and is not merely a scheduling choice: delivering e-mail requires the recipients'
addresses, reading a Dashboard user's address requires the Stripe permission
`user_email_read`, and that permission is deliberately absent from the manifest and pinned
absent by `apps/stripe-app/test/manifest.test.ts` and `docs/SANDBOX_TEST_PLAN.md`. Widening
the App's permissions changes what a merchant consents to at install and what Marketplace
review examines; it is out of scope here.

## Decision

RefundDesk delivers an outbound HTTPS notification to a destination the merchant
configures, typically an incoming-webhook URL for their own chat tool. No personal data is
collected, no Stripe permission is added, and the merchant controls the destination.

### 1. The payload is a signal, not a data feed

The body carries the event kind, the environment and the instant. It carries **no** amount,
currency, payment or refund identifier, requester or approver identity, justification,
rejection reason or customer data. Its purpose is to make a person open RefundDesk, and the
Dashboard remains the only place the workflow is visible.

This is deliberate: a webhook destination is a long-lived credential-like URL held by a
third-party service. Keeping financial detail out of it means a leaked or mistyped
destination cannot become a data-disclosure incident. Enriching the payload is a separate
decision with its own review.

### 2. Only the worker sends

Outbound delivery belongs to the worker, alongside the other effect-capable operations.
The web runtime never performs it, so a compromised web process gains no outbound request
capability (ADR 0010, ADR 0011). Delivery never blocks or fails a refund workflow: a
notification failure is recorded and dropped, never surfaced as a workflow error.

### 3. The destination is treated as hostile input

Letting a tenant name a URL that our worker then requests is a server-side request forgery
primitive against the hosted network. The destination is therefore admitted only if all of
the following hold, checked before any connection:

- the URL parses, is at most 2048 characters and uses `https:`;
- it carries no embedded credentials;
- its port is the default 443, so the destination cannot be used to probe internal ports;
- its host is not a loopback, private, link-local, unique-local, multicast, unspecified or
  otherwise reserved address, whether written literally or reached through DNS;
- every address DNS resolves to is re-checked at send time, and the connection is pinned to
  a checked address, so a name that resolves publicly once cannot be rebound to an internal
  address for the real request.

Redirects are never followed, the request carries an explicit timeout, the response body is
discarded, and only the status code is interpreted. A destination that fails any check is
rejected when it is saved, not silently at send time.

### 4. Storage

The destination is stored per installation, encrypted with the existing field-encryption
keyring whose AAD already binds tenant, table, row and field (ADR 0003). It is never
returned to a client, never logged and never placed in an audit record or evidence
artifact; audit entries state that a notification was attempted and its outcome, never the
destination.

### 5. Delivery semantics

Delivery is best-effort and bounded: a small number of retries with backoff, a per-tenant
rate limit, and no ordering guarantee. Notifications are not a financial record — the audit
log is. A dropped notification must never change a workflow state.

## Consequences

- A team learns that a refund needs a decision without RefundDesk holding anyone's e-mail
  address or gaining a new Stripe permission.
- RefundDesk gains an outbound network path from the worker, which is the main new risk;
  section 3 exists to bound it, and the checks are unit tested.
- A merchant that configures no destination keeps today's behaviour exactly.
- The notification carries no detail, so it cannot replace opening the Dashboard. That is
  intended.
- This ADR authorizes no e-mail, no live mode, no new Stripe permission and no change to
  the contained incident state.

## Why the destination is operator-configured, not merchant-configured

Two properties of the existing architecture were verified against the code and decide this,
independently of any scheduling preference.

**The sender cannot read merchant-encrypted data.** Sensitive text is encrypted with the
field keyring, which lives in the web runtime. `workerEnvironmentSchema`
(`packages/config/src/index.ts:418-444`) does not carry `REFUNDDESK_FIELD_ENCRYPTION_KEY_*`,
and production configuration actively rejects a runtime holding another runtime's secret
names (`FOREIGN_RUNTIME_SECRET_FORBIDDEN`). A destination stored encrypted by the web is
therefore unreadable by the worker, which is the only runtime allowed to send it. Making it
readable would mean sharing key material across the boundary ADR 0010 exists to keep, or
introducing a public-key scheme so the web can write what only the worker can read — a new
key family with its own rotation story.

**The web cannot enqueue work.** `apps/platform/src` contains no queue access at all, so a
notification cannot be raised at the moment a request is created. Deriving it later in the
worker requires a durable "already notified" marker, which is a schema change.

A schema change cannot be validated in this workspace: there is no Docker, no Podman and no
local PostgreSQL, so `pnpm test:integration` — which enumerates columns and runtime grants —
cannot run. Shipping an unverifiable migration would contradict the project's evidence
discipline.

The destination is therefore a worker configuration value for now. That is coherent with
the current deployment, which serves one account per environment, and it costs nothing to
revisit: per-merchant destinations become straightforward once the multi-account decision in
ADR 0020 lands, since that work already has to answer where per-merchant secrets live.

## Implementation state

Implemented and unit tested in `packages/notifications`: the destination policy, the
delivery client with its send-time address re-check, and the reminder decision. Because the
worker learns of pending work by observing state rather than events, the reminder fires when
work appears and when it grows, and stays silent otherwise, so a restart or a crash loop
cannot become a stream of identical messages.

Not built: per-merchant storage, the Settings field and the worker schedule wiring — the
first two for the reasons above, the third because it belongs with whichever storage model
is chosen.

## Rejected alternatives

- **E-mail.** Requires `user_email_read`, which the manifest deliberately omits; adding a
  permission is a consent and Marketplace decision, not an implementation detail.
- **Asking the Administrator to type recipients' addresses.** Reintroduces the manual data
  entry just removed from Settings, and makes RefundDesk hold staff contact data.
- **An allowlist of chat vendors.** Simpler to secure but refuses a merchant's own endpoint
  for no benefit once the address checks in section 3 are in place.
- **Sending amounts and identifiers.** Turns a leaked destination into a data-disclosure
  incident for no functional gain over "open RefundDesk".
- **Sending from the web runtime.** Would grant outbound capability to the process that
  deliberately holds no effect authority.
