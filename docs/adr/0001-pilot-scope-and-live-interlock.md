# ADR 0001 — Pilot scope and live interlock

- Status: Accepted
- Date: 2026-07-25
- Owners: Product and engineering

## Context

RefundDesk can create irreversible financial effects. The key feasibility assumption is that a Stripe App backend can execute an approved refund while a requester with a restricted Dashboard role cannot use Stripe’s native refund action. The assumption must be proven with a real Stripe test account and managed sandbox before building or claiming the financial workflow.

The first cycle does not authorize production infrastructure, customer data or live-mode effects.

## Decision

The pilot supports only synthetic card payments in Stripe test mode and managed sandbox. Connect, `card_present`, disputes and non-card payment methods are excluded.

Phase 0 is a blocking real-world gate with three verdicts:

- `PASS` only when every gate has real evidence;
- `BLOCKED_HUMAN` when a login, MFA, secret, app installation, permission or second user is missing;
- `FAIL` only after a real test demonstrates a technical or distribution impossibility.

Mocks can validate implementation mechanics but cannot satisfy a Phase 0 gate.

Live execution is protected by two independent controls:

```text
global_live_enabled AND tenant_live_enabled
```

Both default to false and no activation procedure is part of this cycle. Account ID, mode and sandbox marker are bound to the installation and credential at every Stripe boundary.

## Consequences

- Non-financial scaffolding may progress under `BLOCKED_HUMAN`.
- Execution, reconciliation and pilot acceptance remain blocked without `PASS`.
- The system may contain a live webhook route for future topology, but it rejects work in this cycle.
- Any live credential, request or evidence invalidates the first-cycle acceptance run and triggers incident review.
- A later live pilot requires a new authorization, threat review and ADR.

## Rejected alternatives

- Treating Stripe mocks as feasibility evidence: they cannot prove roles, app permissions or environment behavior.
- A single environment flag: one configuration mistake would enable live effects.
- Broad payment-method support: refund behavior differs and expands the proof matrix prematurely.
