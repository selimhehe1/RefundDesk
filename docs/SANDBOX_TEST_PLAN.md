# RefundDesk real Stripe sandbox test plan

> Purpose: produce the evidence required for Phase 0 and pilot acceptance  
> Safety: test mode and managed sandbox only; synthetic data only  
> Result at document creation: not run

## 1. Rules of execution

- Never paste a secret into a command captured for evidence, a log or this document.
- Use ignored local environment files or an interactive secret mechanism.
- Never use a real card, customer identity or production PaymentIntent.
- Confirm `livemode=false` from the returned Stripe objects before continuing.
- Keep a strict allowlist of synthetic PaymentIntent IDs for the Phase 0 probe.
- Use separate credentials, app installations and webhook secrets for test mode and managed sandbox.
- Stop immediately if the account, mode or sandbox marker is not the expected one.
- Do not use this plan for load testing.

The canonical source for the refund test PaymentMethods is [Stripe testing — refunds](https://docs.stripe.com/testing#refunds).

## 2. Human prerequisites

- Stripe account access with MFA.
- One Administrator user.
- One distinct `View only` user who can see Payments.
- Unpublished RefundDesk Stripe App installed in both target test environments where required.
- App signing secret available locally.
- Test and managed-sandbox server credentials available locally.
- Separate webhook endpoint secrets.
- Stripe CLI authenticated to the intended test context.

Missing human prerequisites produce `BLOCKED_HUMAN`, not a failed technical gate.

## 3. Preflight

Record versions without secrets:

```bash
node --version
pnpm --version
stripe --version
git rev-parse HEAD
```

Run local gates:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm secrets:check
```

Upload and install the unpublished, production-safe `stripe-app.json` in **test mode only** after an
authorized human has accepted the Stripe Apps Agreement. Do not pass `--live`. The uploaded manifest
keeps the direct probe disabled and proves installation and permissions. For the local technical
probe, start the developer overlay separately:

```bash
pnpm dev:stripe-app
```

That command uses `stripe apps start --manifest stripe-app.dev.json`, which overrides the API origin
with loopback and enables the allowlisted Phase-0 control. The extended development manifest must
never be uploaded as a release; it exists only for the local CLI development session.

Before any Stripe call, verify:

- global live switch is false;
- tenant live switch is false;
- probe is enabled only for Phase 0;
- allowlist is empty until synthetic PaymentIntents are created;
- expected account ID and environment are displayed to the operator;
- live webhook secret and live credential are unavailable to the process.

## 4. Synthetic fixtures

Create small EUR PaymentIntents independently in test mode and managed sandbox. Use PaymentMethod tokens, not card numbers:

| Fixture          | PaymentMethod           | Purpose                                 |
| ---------------- | ----------------------- | --------------------------------------- |
| `normal`         | `pm_card_visa`          | partial/full happy path and idempotency |
| `pending_refund` | `pm_card_pendingRefund` | pending to succeeded transition         |
| `failed_refund`  | `pm_card_refundFail`    | asynchronous failed refund              |

Recommended amount: 1,099 EUR minor units for each isolated scenario. Do not reuse a PaymentIntent if its refundable amount would make the next assertion ambiguous.

For every fixture, record only:

- environment label;
- Stripe account ID;
- PaymentIntent ID;
- Charge ID;
- amount and currency;
- `livemode=false`;
- creation timestamp.

Add the generated PaymentIntent IDs to the probe allowlist only after verifying the environment.

## 5. Evidence format

Create one redacted JSON record per case and a Markdown summary. Suggested schema:

```json
{
  "case_id": "P0-SIGN-001",
  "gate": "SIGNATURE",
  "environment": "test",
  "account_id": "acct_…last6",
  "started_at": "RFC3339",
  "finished_at": "RFC3339",
  "tool_versions": {},
  "inputs": {
    "resource_id": "pi_…last6"
  },
  "expected": "altered signed body is rejected",
  "observed": "HTTP 401 SIGNATURE_INVALID",
  "status": "passed_real",
  "artifacts": []
}
```

Allowed statuses:

- `passed_real`
- `failed_real`
- `blocked_human`
- `not_run`

Redact account and resource IDs in any artifact intended for broad sharing. Local restricted evidence may retain full non-secret Stripe object IDs, but never secrets, full payloads, e-mail or sensitive text.

## 6. Phase 0 cases

### 6.1 App and UI

| Case         | Procedure                                                        | Expected                                                 |
| ------------ | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `P0-APP-001` | Create/upload and install the unpublished app without publishing | App installation is visible in the intended test context |
| `P0-UI-001`  | Open an allowlisted synthetic payment                            | RefundDesk renders at `stripe.dashboard.payment.detail`  |
| `P0-UI-002`  | Open a non-allowlisted or live-context resource                  | Probe action is absent or fails closed                   |

### 6.2 Signed request

Use the exact canonical field order from the v1.1 specification.

| Case          | Mutation                                      | Expected                          |
| ------------- | --------------------------------------------- | --------------------------------- |
| `P0-SIGN-001` | Valid current signature and canonical body    | Accepted                          |
| `P0-SIGN-002` | Change one byte in `command_json`             | `401` signature failure           |
| `P0-SIGN-003` | Reorder two signed fields                     | Rejected                          |
| `P0-SIGN-004` | Add an unknown field                          | Strict validation rejection       |
| `P0-SIGN-005` | Substitute `user_id`                          | Rejected                          |
| `P0-SIGN-006` | Substitute `account_id`                       | Rejected                          |
| `P0-SIGN-007` | Use an expired signature                      | Rejected                          |
| `P0-SIGN-008` | Cross test/sandbox credential or installation | Rejected                          |
| `P0-SIGN-009` | Present `livemode=true`                       | Rejected before any Stripe effect |

### 6.3 Role gap and Refund

1. As Administrator, confirm the synthetic payment is visible.
2. As `View only`, confirm the payment is visible.
3. As `View only`, attempt to locate/use Stripe’s native refund capability and record that the role cannot perform the refund.
4. From RefundDesk as `View only`, submit a small partial request.
5. As the distinct enabled approver, approve it.
6. Observe the backend create the Refund using the app/platform credential for the exact account and environment.

| Case            | Expected                                                      |
| --------------- | ------------------------------------------------------------- |
| `P0-ROLE-001`   | `View only` can view the payment but cannot refund natively   |
| `P0-ROLE-002`   | `View only` can send an authenticated RefundDesk request      |
| `P0-REFUND-001` | Backend returns one `re_...`, exact minor amount and currency |
| `P0-REFUND-002` | Stripe account and `livemode=false` match the installation    |

If current Stripe role behavior differs, capture the real behavior. Do not reinterpret the result as success.

### 6.4 Stripe idempotency

1. Capture the deterministic request key without exposing credentials.
2. Send the exact same `refunds.create` operation twice with that key.
3. Retrieve/observe both responses.

Expected:

- both responses refer to the same Refund ID;
- Stripe contains one Refund for the intended effect;
- RefundDesk stores one immutable link;
- attempts are audit-visible without a second effect.

Case: `P0-IDEM-001`.

Keep the same local API process running for the two calls and the related webhook observation. The
development-only Phase-0 correlation store is intentionally process-local; a restart makes the case
inconclusive and requires a fresh synthetic payment and nonce. The pilot workflow uses durable
PostgreSQL state and does not inherit this exception.

### 6.5 Webhook

| Case             | Procedure                                     | Expected                                    |
| ---------------- | --------------------------------------------- | ------------------------------------------- |
| `P0-WEBHOOK-001` | Receive the real `refund.created`             | Signature passes and receipt is stored once |
| `P0-WEBHOOK-002` | Replay the same Event                         | No second domain transition                 |
| `P0-WEBHOOK-003` | Change one body byte                          | Signature fails                             |
| `P0-WEBHOOK-004` | Send sandbox Event to test endpoint           | Environment binding rejects it              |
| `P0-WEBHOOK-005` | Deliver Event before API-response persistence | Same first Refund ID is linked safely       |

After delivery, use the signed Administrator-only Phase-0 report control in the payment view. Record
the redacted correlation returned by `/api/internal/phase0/report`; never expose the signing secret,
raw Event body or full evidence from another account.

### 6.6 External Refund and proof replay

Use a fresh synthetic payment.

1. Create a Refund manually in the Stripe Dashboard or with a credential outside RefundDesk.
2. Confirm RefundDesk classifies it as external.
3. Create a Refund carrying copied RefundDesk metadata on a separate refundable fixture.
4. Confirm it becomes a `proof_replay`/tampering alert and does not replace an existing link.

Cases:

- `P0-EXT-001`
- `P0-PROOF-001`

### 6.7 Environment isolation

Repeat the happy path independently in:

- account test mode;
- managed sandbox.

Then exercise both credential crossovers. Expected:

- each happy path creates an effect only in its own environment;
- every crossover fails before a Stripe effect;
- no test object is accepted as a sandbox object or vice versa.

Cases:

- `P0-ENV-TEST-001`
- `P0-ENV-SANDBOX-001`
- `P0-ENV-CROSS-001`
- `P0-ENV-CROSS-002`

### 6.8 Permissions and publishability

Record the installed permissions and prove each use:

- `charge_read`
- `charge_write`
- `payment_intent_read`
- `event_read`

Confirm `user_email_read` is absent. Remove any requested permission that the real workflow does not exercise. Record any current Marketplace or app-review constraint that would make the product impossible to distribute, without submitting the app.

Cases:

- `P0-PERM-001`
- `P0-PUBLISH-001`

## 7. Pilot behavior cases after Phase 0 PASS

### 7.1 Workflow and exact money

- partial Refund;
- full remaining Refund;
- zero, negative, malformed and excessive amount refusal;
- zero-decimal currency fixture at the domain/contract layer;
- request refused without a distinct approver;
- self-approval refused;
- rejection with encrypted reason;
- cancellation only before approval;
- expiration after seven days.

### 7.2 Async refund states

`pm_card_pendingRefund`:

- Refund starts `pending`;
- guard remains held;
- real `refund.updated` moves it to `succeeded`;
- no second create occurs.

`pm_card_refundFail`:

- Stripe can initially report success then emit `refund.failed`;
- the same immutable Refund ID moves `identified -> absence_proven`;
- the original terminal and guard-release timestamps remain unchanged;
- repeat with `refund.failed` processing suppressed and confirm direct retrieval by Refund ID
  converges the same state;
- the workflow does not retry with a new key.

### 7.3 Crash matrix

Inject a controlled process stop:

1. before persisting the attempt;
2. after persisting but before the Stripe call;
3. after the request could reach Stripe;
4. after Stripe response but before database commit;
5. after commit but before job acknowledgement.

For each point:

- restart the worker;
- verify the same idempotency key;
- verify zero or one Stripe Refund, never two;
- verify the guard state;
- verify an audit trail.

Exercise all recovery outcomes:

- safe re-enqueue of `approved/not_started` and `executing/not_started`;
- safe re-enqueue of `executing/absence_proven` with the persisted execution and expected key;
- diversion of `executing/possible` to reconciliation;
- refusal of a missing execution, different key or already linked Refund.

### 7.4 Reconciliation scanner

- suppress webhook processing for one Refund;
- wait/run scanner;
- assert detection within thirty minutes;
- create over 100 Refund fixtures only if Stripe test limits and pilot cost allow, otherwise validate pagination with a controlled contract fixture and separately exercise at least two real pages when safe;
- fail after an intermediate page;
- verify checkpoint did not advance;
- rerun and verify deduplication;
- complete an empty window covering both execution start and `reconciliation_safe_after_at`, then
  verify absence proof and same-key resume;
- complete an empty partial or non-covering window and verify reconciliation remains;
- refresh a linked Refund older than the temporal overlap by exact ID;
- fail one linked retrieval and verify later targets plus the temporal scan continue while the
  aggregate job remains retryable.

The real Phase 0 gate does not require a high-volume test.

### 7.5 Uninstallation

1. Queue a request without effect.
2. Uninstall/suspend the app.
3. Confirm no new job is claimed.
4. Reconcile any attempt already in `possible`.
5. Confirm retention deadline is scheduled.
6. Confirm subsequent signed actions fail closed.

## 8. Verdict procedure

All Phase 0 gates must have at least one `passed_real` case and no unresolved `failed_real`.

Decision:

```text
if every required gate passed_real:
  PASS
else if any required human prerequisite is missing:
  BLOCKED_HUMAN
else:
  FAIL
```

The Markdown report lists every gate, case ID, result and redacted artifact path. It must explicitly state that no live request was made.

## 9. Cleanup

- disable the probe immediately after evidence collection;
- remove the direct probe endpoint before pilot acceptance;
- remove synthetic allowlist entries;
- stop local webhook forwarding;
- remove temporary test objects where Stripe supports safe cleanup;
- keep only redacted evidence for the documented retention period;
- rotate a secret if it appeared in terminal capture, logs or evidence.
