# Reviewer testing instructions — draft

Draft of the "Testing tips" and "Test account credentials" fields the Stripe App Marketplace listing
requires. Stripe's review team follows these literally, and the most common rejection causes are
instructions that miss a flow a new user would see, credentials that need two-factor authentication,
and test links that do not work.

Nothing here is submitted.

## Test account credentials

Stripe does not permit real (non-test) accounts for app review.

_Pending: a dedicated Stripe test account with RefundDesk installed at the submitted version, two
users on it so the two-person workflow can actually be exercised, and two-factor authentication
disabled or bypass instructions provided._

| Test account | Username    | Password    | Role in RefundDesk        |
| ------------ | ----------- | ----------- | ------------------------- |
| _(pending)_  | _(pending)_ | _(pending)_ | Administrator / requester |
| _(pending)_  | _(pending)_ | _(pending)_ | Approver                  |

Two distinct users are mandatory, not a convenience: RefundDesk refuses to create a request without
a distinct eligible approver, and refuses to let a requester approve their own request. A reviewer
given one account cannot complete the primary flow and will reject the submission.

## Setup before the scenarios

1. Install RefundDesk on the test account from the public install link.
2. Open the app and complete onboarding: choose which team members may approve refunds.
3. Create a synthetic card payment to refund. Use Stripe's test card `4242 4242 4242 4242`, any
   future expiry and any CVC, then capture it.

## Scenario 1 — a refund requires a second person

1. Sign in as the requester.
2. Open **Payments**, select the captured test payment.
3. Open the RefundDesk panel in the payment detail view.
4. Enter a partial amount, choose a reason, and write a justification of at least 10 characters.
5. Select the second user as approver, then submit.
6. Confirm the request appears as pending approval, and that **no Stripe Refund exists yet** on the
   payment.
7. Still as the requester, try to approve the request. Confirm it is refused.

## Scenario 2 — approval creates exactly one refund

1. Sign out and sign in as the approver.
2. Open the same payment and the RefundDesk panel.
3. Approve the pending request.
4. Confirm a Stripe Refund is created for exactly the requested amount, and that the request shows
   the refund identifier.
5. Refresh and confirm no second refund is created.

## Scenario 3 — rejection records a reason and creates nothing

1. As the requester, create a second request on another test payment.
2. As the approver, reject it and enter a reason.
3. Confirm the request shows as rejected with the reason recorded, and that no Stripe Refund was
   created.

## Scenario 4 — a refund made outside RefundDesk is flagged

1. Refund a third test payment **directly in the Stripe Dashboard**, not through RefundDesk.
2. Open RefundDesk and confirm the refund is detected and flagged as created outside the workflow.
3. This demonstrates the documented limitation: RefundDesk reports such refunds, it does not block
   them.

## Scenario 5 — audit export

1. Open the RefundDesk settings or audit view.
2. Export the audit record and confirm it contains the request, approval, rejection and the
   externally created refund from the scenarios above.

## Notes for the reviewer

- RefundDesk supports card payments only. Requests against other payment method types are refused
  with an explicit ineligibility message; this is by design and is stated in the listing.
- `card_present` (Terminal) payments and payments in a Connect flow are also refused.
- All scenarios above run in test mode. _Pending: live-mode instructions, which require an activated
  account and a reachable production backend._

## Open before submission

- The dedicated review test account, its two users, and installed app version.
- Screen recordings of scenarios 1 and 2, which Stripe recommends for the more involved flows.
- Live-mode coverage: Stripe expects features to be tested in both test and live mode.
