# Marketplace readiness — what stands between here and publication

Assessed 10 August 2026 against Stripe's official publishing requirements. This is the gap list, not
a plan: some items are decisions only the owner can make, and one is an architectural question that
is still `Proposed`.

## Already satisfied

The app manifest is publish-shaped. `apps/stripe-app/stripe-app.json` declares
`distribution_type: public`, `sandbox_install_compatible: true`, an icon path, a content security
policy with a stated purpose, and four permissions each carrying a justification —
`charge_read`, `charge_write`, `payment_intent_read`, `event_read`. There are no localhost or dummy
redirect URIs, which is one of the failure causes Stripe names explicitly.

The name `RefundDesk` is 10 characters and contains none of the tokens Stripe forbids in a listing
name.

## Blocking, technical

**The backend the manifest points at is deliberately switched off.** The manifest's `connect-src` is
the sandbox CloudFront origin. Since the 1 August credential incident the host has been contained:
Caddy stopped, worker stopped, Lightsail 80/443 closed, live disabled. A published app needs a
reachable backend, and Stripe's reviewers test in both test and live mode. Reopening is a separate
decision requiring independent review — it is not a step in a publication checklist.

**The hosting shape was never intended for this.** The approved deployment is a single Lightsail
instance under a EUR 10 per month ceiling, sized for a sandbox pilot. A Marketplace app is installed
by arbitrary merchants.

## Blocking, architectural

**The account model is not decided.** ADR 0020 is `Status: Proposed — requires owner ratification`.
Its first decision — that an account becomes known only by explicit registration, and that
installing the app is not consent to create a tenant — is implementable today and already shapes the
admission boundary. Its second decision is the open one: the manifest declares
`stripe_api_access_type: platform`, meaning the publisher's own secret key acts on each merchant's
account via `Stripe-Account`. That is a coherent model, but it has never been exercised beyond the
fixed-account pilot, and ADR 0012 records that `Stripe-Account` and `Event.account` conflicted with
the direct-account pilot credentials during earlier work.

Publishing means arbitrary accounts install the app on day one. The pilot is bound to one.

## Blocking, business and legal

None of these exist:

- an activated Stripe account — publication requires activation, and this project has run in test
  and managed sandbox only;
- a public privacy policy URL — a draft is in `privacy-policy.md`, with every undecided commitment
  marked pending rather than invented;
- a support channel with a stated response time;
- a legal entity name and country of establishment;
- a pricing decision, and a pricing page if paid.

## Blocking, listing assets

- a 300x300 square logo matching the manifest icon;
- three key-feature images at 1600px or wider, showing the app inside the Stripe Dashboard with
  synthetic data only;
- a dedicated review test account with **two** users and two-factor authentication disabled.

That last one is not a formality. RefundDesk refuses to create a request without a distinct eligible
approver and refuses to let a requester approve their own request. A reviewer given a single account
cannot complete the primary flow, and the submission is rejected.

## Product gates that publication does not waive

`PLANS.md` records these as open, and they remain open regardless of listing readiness: real pending
and failed refund paths, complete install and uninstall lifecycle in both environments, the native
direct-browser financial path and its accessibility review, monitoring and alert delivery, and the
remaining hosted key-rotation drill.

## Honest summary

The listing copy, the privacy policy and the reviewer instructions can be written now, and are. The
manifest is ready. What stands in the way is not paperwork: it is an offline backend held that way
on purpose, an unratified account architecture, and an unactivated account. Publication is a
different phase of the project, not the next task in this one.
