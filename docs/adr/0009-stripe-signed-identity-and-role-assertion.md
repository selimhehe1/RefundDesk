# ADR 0009 — Stripe-signed identity and optional role assertion

## Status

Accepted

## Context

RefundDesk needs Stripe-authenticated identity and command integrity for every Dashboard request.
Its app also retains `charge_write` so the backend can execute an approved test Refund. In a real
Stripe test, the `View only` user could obtain a backend signature for the ordinary request payload,
but Stripe returned HTTP 403 before RefundDesk when the special `stripe_roles` key was included.
Removing `charge_write` made the role assertion signable but would remove the permission required by
the same-app execution architecture.

Treating an omitted assertion as `stripe_roles=[]` was unsafe: it blurred the evidence boundary and
could overwrite a previously observed durable role snapshot.

Account-scoped calls also do not need a duplicated `resource_id=acct_…`; Stripe already adds and
signs `account_id`.

## Decision

The signed envelope has two strict role variants:

- `roles_asserted=false` omits `stripe_roles`. It authenticates the signed identity, account,
  environment and command, but proves no role.
- `roles_asserted=true` requires a non-empty strict `stripe_roles` list. Administrator-only
  operations and provisioning require this variant. The direct Phase-0 controls also required it
  during the evidence window, and were removed before the pilot snapshot.

The backend maps an unasserted request to no current role claims and never replaces durable
`tenant_users.stripe_roles` from it. Explicit approver authority remains a RefundDesk database
assignment and self-approval remains prohibited independently of Stripe roles.

Resource binding also has two strict variants:

- payment-scoped envelopes require `resource_id` after `resource_type`;
- account-scoped envelopes prohibit `resource_id` and bind only through the signed `account_id`,
  installation, environment and user context.

The client signs exactly the same top-level fields it sends. For an asserted role payload, it passes
Stripe’s original role objects to the special signing input while the body keeps the strict canonical
role projection that the real Stripe signer has been verified to attest.

## Consequences

- Restricted users can use ordinary RefundDesk request/cancel/read flows while the app retains the
  execution permission.
- No code may infer “no roles” or “View only” from `roles_asserted=false`.
- Decision and audit snapshots contain roles only when the current command asserted them; an
  unasserted command records an empty snapshot plus `roles_asserted=false`, never a durable stale
  role observation.
- A Phase-0 role-gap result must link the signed user identity to an independent native-role
  observation; it cannot claim signed role propagation.
- Administrator actions fail closed when role assertion is unavailable.
- The four canonical envelope shapes (account/payment × asserted/unasserted) require explicit
  contract and negative tests.

## Rejected alternatives

- Remove `charge_write`: incompatible with the selected same-app backend Refund architecture.
- Send `stripe_roles=[]`: Stripe can still reject the special key, and an empty value is not an
  authenticated observation of the user’s actual roles.
- Trust the UI’s local role context without a signed assertion for Administrator actions: this
  would move an authorization decision outside the verified boundary.
- Duplicate `account_id` as `resource_id`: unnecessary and observed to make account-scoped signature
  generation fail for the restricted user.
