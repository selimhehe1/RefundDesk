# Privacy policy — draft

Draft for the privacy policy URL that the Stripe App Marketplace listing requires.

**This is a draft, not legal advice, and must be reviewed by a qualified adviser before it is
published.** It describes the system as built, so that a reviewer is not asked to approve claims the
code does not support. Where the product's behaviour is not yet decided, the section says so instead
of inventing a commitment.

---

## What RefundDesk is

RefundDesk is a Stripe App that adds a two-person approval workflow to refunds requested from the
Stripe Dashboard, records those decisions, and flags refunds created outside the workflow.

## What we process

RefundDesk processes the minimum needed to decide whether a refund is eligible, to bind an approval
to the right payment, and to reconcile the result:

- **Stripe object identifiers** — PaymentIntent, Charge and Refund identifiers, the connected
  account identifier, and the mode (test or live).
- **Payment attributes needed for eligibility** — captured status, payment method type, currency,
  refundable amount and dispute status.
- **Workflow content you enter** — requested amount, refund reason, and the free-text justification
  a requester writes.
- **Team member identifiers** — the Stripe user identifiers of the requester and approver, and the
  display name Stripe exposes for them, so an approver can be chosen by name.
- **Audit records** — the decision, its timestamp, the execution attempt and its outcome.

## What we do not process

- We do not store cardholder data, card numbers, or payment credentials.
- We do not store end-customer personal data. RefundDesk operates on Stripe object identifiers and
  the payment attributes above.
- We do not read Stripe objects outside the permissions listed in the app manifest: `charge_read`,
  `charge_write`, `payment_intent_read` and `event_read`.

## Why we process it

To determine refund eligibility, to guarantee that a requester and approver are distinct people, to
create at most one Stripe Refund per approved request, to reconcile that refund against Stripe, and
to retain an auditable record of the decision.

## Retention

Workflow and audit records are retained for the configured retention period and then deleted.
Justifications and rejection reasons are never written to application logs.

_Pending: the default retention period offered to installers, and whether it is configurable per
account._

## Storage and security

- Records are held in a PostgreSQL database with per-tenant isolation enforced in the database, not
  only in application code.
- Sensitive fields are encrypted at rest with versioned AES-256-GCM keys; separate versioned keys
  are used for integrity proofs and approval attestations.
- Web and worker runtimes use distinct database principals, neither of which can bypass row-level
  security.
- Requests from the Stripe Dashboard are signature-verified from raw bytes before parsing, and
  webhook signatures are verified before any payload is read.
- Secrets, full signatures, complete Stripe payloads, justifications and rejection reasons are never
  logged.

_Pending: hosting region and sub-processor list, which depend on the production hosting decision._

## Sharing

We share data with Stripe, because RefundDesk acts on your Stripe account through the Stripe API on
your instruction.

_Pending: any other sub-processor — hosting, monitoring or error reporting — must be listed here
once production hosting is decided._

## Your choices

Uninstalling RefundDesk from your Stripe account ends its access. _Pending: what happens to retained
records on uninstall — immediate deletion, deletion after the retention period, or export first —
is a product decision that is not yet made and must be stated here before publication._

## Contact

_Pending: the support address published in the Marketplace listing._

---

## Why sections are marked pending

Every pending item is a decision that has not been made, not a detail to fill in later. A privacy
policy that commits to a retention period, a hosting region or an uninstall behaviour the system
does not implement would be inaccurate on the day it is published.
