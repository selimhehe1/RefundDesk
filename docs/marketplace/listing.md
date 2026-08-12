# Stripe App Marketplace listing copy

Draft listing content for `com.refunddesk.workflow`, mapped field by field to the required fields in
Stripe's publishing guide. English only, as Stripe supports English listings only.

Nothing here is submitted. Every claim is deliberately verifiable: Stripe rejects hyperbole,
keyword stuffing and unverifiable claims at review, and this product has one limitation that must be
stated rather than hidden.

## Required fields

| Field                      | Value                                                                           |
| -------------------------- | ------------------------------------------------------------------------------- |
| Name                       | `RefundDesk`                                                                    |
| Built by                   | _(pending: legal entity name, max 80 chars)_                                    |
| Category                   | Operations                                                                      |
| Compatible with            | Payments, Customers                                                             |
| Countries of establishment | _(pending)_                                                                     |
| Supported languages        | English                                                                         |
| Pricing                    | Free                                                                            |
| Pricing page               | Not required: free apps do not need one                                         |
| Privacy policy             | See `privacy-policy.md`; needs a public URL before submission                   |
| Terms of service           | _(optional)_                                                                    |
| Support channel            | _(pending: address plus a stated response time, e.g. "within 2 business days")_ |

The name is 10 characters and contains none of the forbidden tokens (`Stripe`, `app`, `free`,
`paid`, `RAK`, `Generator`, `API Key`, `Authenticator`).

## Subtitle

Max 80 characters. Current draft is 78:

> Require a second approver for refunds, and flag any made outside the workflow.

## About

Max 1000 characters. Current draft is 780:

> Anyone with refund access in a Stripe account can issue a refund alone, and Stripe's built-in
> roles cannot express "support agent, but not unilateral refunds" — the roles that allow refunds
> also allow the rest of support work.
>
> RefundDesk adds a two-person workflow to refunds requested from the Stripe Dashboard. A team
> member requests a refund from a payment, a different eligible approver accepts or rejects it with
> a recorded reason, and RefundDesk creates at most one Stripe Refund for that request. Every
> decision, attempt and reconciliation is retained for the configured retention period.
>
> RefundDesk also detects refunds created outside the workflow and flags them, so a control that
> was bypassed is visible rather than silent.

## Key features

Each key feature needs a title (max 80), a description (max 300) and an image at least 1600px wide
showing the app inside the Stripe Dashboard, with no real customer data.

### 1. Require a second person before a refund leaves the account

> A requester opens a payment, asks for a full or partial refund with a justification, and names a
> distinct eligible approver. The requester can never approve their own request, and a request
> cannot be created without an eligible approver. Only an approval creates the Stripe Refund.

_Image: payment detail viewport, request form with approver selector._

### 2. Keep an auditable record of every decision

> Requests, approvals, rejections with reasons, execution attempts and reconciliations are recorded
> and exportable for the configured retention period. Each approval is bound to an append-only
> attestation of the exact payment, amount and the two distinct identities involved.

_Image: audit view with export control._

### 3. See refunds that bypassed the workflow

> RefundDesk reconciles against Stripe and flags refunds created outside it — from the Dashboard,
> another API key or another integration. It reports them; it does not block them.

_Image: reconciliation view showing an externally created refund flagged._

## Stated limitation

To be included in the About text or the third feature description, not omitted:

> RefundDesk cannot prevent a refund issued directly in Stripe, with another API key, or by another
> integration. It enforces approval for refunds requested through RefundDesk and reports the rest.
> To make approval the only path, remove refund permission from the relevant team members in your
> Stripe role settings.

That last sentence is the honest form of the value proposition. Stripe's `View Only`,
`Dispute Analyst`, `Tax Analyst` and `Accountant` roles can view payments without refunding; every
role that permits support work also permits refunds, and roles are additive rather than
subtractive.

## Why free for the first submission

Free removes the entire billing surface from the first review: no pricing page, and no subscription
flow that must route users through our own site before Stripe Checkout. The spec defers Billing,
trials and quotas outright, so none of it exists. Paid can be added later on an app that is already
approved, and a second submission is faster than a first.

## Open before submission

- Legal entity name, countries of establishment, support channel and response time.
- A public privacy policy URL.
- A 300x300 square logo matching `apps/stripe-app/assets/icon.png`.
- Three key-feature images at 1600px or wider, with synthetic data only.
- An activated Stripe account: publication requires it, and this project has operated in test and
  managed sandbox only.
- A reachable production backend. The manifest's `connect-src` points at the sandbox CloudFront
  origin, which is currently contained with ingress closed.
- A decision on the multi-account architecture; the pilot is bound to a fixed account, while a
  published app is installed by arbitrary accounts.
