# RefundDesk pilot threat model

> Scope: v1.1 pilot in local, Stripe test mode and managed sandbox  
> Review date: 2026-07-25  
> Re-review triggers: live-mode proposal, new payment method, Connect, new notification channel, new hosting topology or a financial/security incident

## 1. Security objectives

1. A Refund is created only for the intended tenant, environment, payment, amount and approved request.
2. A request creates at most one linked financial effect.
3. A requester cannot approve their own request or forge another Stripe user.
4. Cross-tenant reads and writes fail closed.
5. An ambiguous Stripe outcome cannot silently release the execution guard.
6. Secrets and sensitive workflow text remain confidential.
7. Audit history is attributable, append-only and retained for its stated period.
8. External or replayed refunds are detected without automatically creating another refund.
9. Live mode is unreachable in the authorized pilot.

This model does not claim PCI, SOC 2, ISO 27001 or regulatory certification.

## 2. Assets

Highest impact:

- Stripe platform credentials and app signing secret;
- webhook signing secrets;
- field-encryption and proof-HMAC keys;
- authority to create a Refund;
- tenant/environment binding;
- deterministic Stripe idempotency key;
- first linked Refund ID and effect state.

Sensitive:

- justifications and rejection reasons;
- approver membership and decisions;
- audit records;
- database credentials;
- mutation receipts and reconciliation state.

Operational:

- Stripe Event and Refund identifiers;
- logs and metrics;
- scanner checkpoints;
- redacted phase-0 evidence.

RefundDesk does not need card PAN, CVC, customer e-mail, address or complete Stripe payload storage.

## 3. Actors

- Requester: authenticated Stripe Dashboard user who can view the payment.
- Approver: observed Stripe user explicitly enabled in RefundDesk.
- Administrator: can install/configure the app, but is not automatically an approver.
- Operator: maintains the local pilot and performs documented recovery.
- Stripe: identity, UI context, Refund API, events and sandbox provider.
- External integration: any other key/app able to create a Refund.
- Attacker: unauthenticated network actor, compromised Dashboard user, compromised runtime, malicious tenant user or database-only intruder.

## 4. Trust boundaries

```text
Stripe Dashboard UI
  -> signed app request boundary
RefundDesk web API
  -> transaction + RLS boundary
PostgreSQL

RefundDesk worker
  -> credential/account/environment boundary
Stripe Refund API

Stripe webhook sender
  -> raw-body signature boundary
RefundDesk webhook ingress

Operator
  -> secret store and migration role boundary
Local/runtime environment
```

Data crossing a boundary is untrusted until its authentication, schema, tenant and environment checks succeed.

## 5. Assumptions and exclusions

- Stripe’s signature and webhook primitives are correctly implemented by official libraries.
- The workstation and local secret storage are under the user’s control.
- Test and managed-sandbox credentials are distinct.
- Only synthetic data is used.
- A Dashboard user or external API credential with native refund rights can bypass RefundDesk; detection is the control.
- Denial of Stripe itself and compromise of Stripe infrastructure are outside the implementation threat model.

## 6. Threats and controls

| ID  | Threat                                                                   | Impact                                            | Preventive controls                                                                                                                                                                                                                                      | Detection / required test                                                                                                     | Residual risk                                                                        |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| T01 | Forge a Stripe App request                                               | Unauthorized workflow action                      | Raw-byte signature verification, strict canonical variant/order, timestamp window, Zod strict; account scope omits `resource_id`; unasserted roles omit `stripe_roles`                                                                                   | Modified body/order/account/user plus invalid resource/role-variant tests                                                     | Compromised app signing secret enables forgery until rotation                        |
| T02 | Replay a valid signed mutation                                           | Duplicate request or decision                     | Durable `request_nonce` receipt bound to actor, operation and payload hash                                                                                                                                                                               | Exact replay returns stored response; changed replay returns `409`                                                            | Receipt loss during unavailable DB causes safe failure, not availability             |
| T03 | Substitute tenant/account                                                | Refund on wrong account                           | Signed `account_id`, installation triplet binding, explicit Stripe account/credential                                                                                                                                                                    | Cross-account and cross-environment negative tests                                                                            | Misconfigured installation must fail closed                                          |
| T04 | Reach live accidentally                                                  | Real financial effect                             | Global AND tenant switches, live credentials absent, `livemode` rejection, synthetic allowlist in probe                                                                                                                                                  | Startup/config tests and a live-context rejection test                                                                        | Future activation needs a new review                                                 |
| T05 | Self-approve or spoof approver                                           | Circumvent four-eyes control                      | Actor from verified signature; Administrator actions require `roles_asserted=true`; unasserted requests neither claim nor overwrite roles; append-only decision; active, same-tenant approver distinct from requester; database-enforced coherent quorum | Role-assertion downgrade, role-preservation, self-approval, missing-decision, disabled-approver and concurrent-decision tests | Two colluding users can still approve                                                |
| T06 | Create request with no real second approver                              | Unexecutable or illusory control                  | Creation requires a distinct active approver                                                                                                                                                                                                             | Last-approver removal and create tests                                                                                        | Approver can later become unavailable; request expires                               |
| T07 | Amount overflow/rounding                                                 | Wrong refund amount                               | Decimal-string boundary, bounded parsing, `bigint`, Stripe revalidation                                                                                                                                                                                  | Zero/negative/large/zero-decimal currency tests                                                                               | Incorrect upstream Stripe data is outside scope                                      |
| T08 | Payment-method confusion                                                 | Unsupported refund behavior                       | Require captured Charge and `type=card`; reject `card_present`, Connect, disputes                                                                                                                                                                        | Wallet-as-card and all refusal cases                                                                                          | Stripe can evolve fields; unknown values fail closed                                 |
| T09 | Duplicate refund after timeout/crash                                     | Financial loss                                    | One deterministic key, durable effect state, immutable link, no alternate key; empty scans must cover the database-stamped post-call/recovery boundary                                                                                                   | Crash matrix plus pre/post-boundary empty scans                                                                               | Stripe/API defects remain external residual risk                                     |
| T10 | Release a request guard before a conflicting external Refund is observed | Second effect becomes possible                    | `possible`/`reconciliation_required` retain the request guard; unresolved external alerts add a payment-scoped database guard                                                                                                                            | Reverse-order external observation and three-way race tests                                                                   | Pilot protection is permanent and requires a future reviewed resolution              |
| T11 | Copy workflow metadata to another Refund                                 | Relink or hide external refund                    | HMAC proof plus full tuple match, immutable first ID                                                                                                                                                                                                     | Copied metadata yields `proof_replay`                                                                                         | An actor with HMAC key can forge proof                                               |
| T12 | Webhook spoofing                                                         | False state transition                            | Raw-body webhook signature, separate secret per environment                                                                                                                                                                                              | Invalid signature, wrong secret and altered body tests                                                                        | Secret compromise enables spoofing until rotation                                    |
| T13 | Duplicate/out-of-order webhook                                           | State regression or duplicate action              | Event receipt uniqueness, monotonic/domain transitions, idempotent classifier                                                                                                                                                                            | Duplicate and out-of-order suites                                                                                             | Delayed valid events may create alerts but no extra effect                           |
| T14 | Missed creation Event or old linked Refund status update                 | External refund or terminal change goes unnoticed | Fifteen-minute creation-window scan with overlap plus periodic direct retrieval by immutable linked Refund ID                                                                                                                                            | Dropped Event and old linked Refund outside the overlap                                                                       | Stripe outage or scanner outage delays detection                                     |
| T15 | Advance a checkpoint or starve later work after a scan failure           | Permanent blind spot                              | Temporal checkpoint advances only after all temporal pages; linked-target failures are isolated; later targets/installations continue; aggregate retry remains                                                                                           | Page-N failure, failed linked target then healthy target, and two-installation non-starvation                                 | Very high volumes may increase lag and require tuning                                |
| T16 | Cross-tenant query or connection context leak                            | Confidentiality/integrity breach                  | Forced RLS, unprivileged roles, transaction-scoped context first                                                                                                                                                                                         | A/B/no-context/pool-reuse tests                                                                                               | Table owner compromise bypasses database control                                     |
| T17 | Operator/runtime bypasses RLS or web crosses the effect boundary         | Bulk tenant breach or unauthorized effect         | Separate owner, web, worker and maintenance roles; no `BYPASSRLS`; web cannot write executions or worker transitions; real-login privilege checks                                                                                                        | Privilege inspection plus web/worker allow-and-deny matrix                                                                    | Owner credentials and a fully compromised signed-request verifier remain high impact |
| T18 | Read sensitive workflow text from DB                                     | Confidentiality loss                              | AES-256-GCM with external versioned key and AAD                                                                                                                                                                                                          | Wrong tenant/field AAD and rotation tests                                                                                     | Runtime compromise with key can decrypt in-scope rows                                |
| T19 | Reuse nonce/key incorrectly                                              | GCM, proof or export-token compromise             | Random unique GCM nonce; separate encryption, proof-HMAC and export-signing keys                                                                                                                                                                         | Key-version, separation and nonce-format tests                                                                                | RNG compromise is residual                                                           |
| T20 | Leak secret or PII in logs/evidence                                      | Credential or privacy incident                    | Structured allowlist logging, redaction, secret scan, no full payloads                                                                                                                                                                                   | Canary redaction and repository secret scan                                                                                   | Third-party/process logs require separate review                                     |
| T21 | Modify or delete audit                                                   | Repudiation                                       | Append-only permissions, application events, restricted purge role                                                                                                                                                                                       | Runtime update/delete denial test                                                                                             | Owner/maintenance compromise can alter DB                                            |
| T22 | Queue same execution twice                                               | Concurrent Stripe calls                           | Unique job identity, CAS claim, same Stripe key                                                                                                                                                                                                          | Concurrent worker test                                                                                                        | Calls can still race safely under Stripe idempotency                                 |
| T23 | SSRF/generic Stripe proxy abuse                                          | Broader account access                            | Fixed route operations, strict schemas, no user-supplied API paths                                                                                                                                                                                       | Unknown operation and extra-field tests                                                                                       | A future generic proxy would invalidate this control                                 |
| T24 | Dependency or build compromise                                           | Runtime takeover                                  | Lockfile, frozen install, dependency audit, secret scan, review                                                                                                                                                                                          | CI/local gates                                                                                                                | Registry/account compromise is residual                                              |
| T25 | Resource exhaustion                                                      | Delayed approvals/scans                           | Body limits, pagination bounds, timeouts, queue backpressure                                                                                                                                                                                             | Oversized input and scan-lag alert tests                                                                                      | Pilot has no global DDoS service                                                     |
| T26 | Uninstallation races an execution                                        | Effect after access revoked                       | Suspend installation first, reject new claims, reconcile already-possible effects                                                                                                                                                                        | Uninstall during queued/executing tests                                                                                       | An effect already accepted by Stripe cannot be undone                                |
| T27 | Freeze an incorrect terminal Refund status                               | Audit and guard state diverge from Stripe         | Immutable same-ID and tuple validation, Event watermark ordering, failure-at-equality, and direct current-snapshot refresh outside the temporal overlap                                                                                                  | Newer/stale/equal-time Events plus direct refresh of an old linked Refund                                                     | Stripe remains the authoritative external state source                               |

## 7. Authorization matrix

| Action                        |                                        Requester |                                      Approver |                   Administrator |                  Worker |                                  Maintenance |
| ----------------------------- | -----------------------------------------------: | --------------------------------------------: | ------------------------------: | ----------------------: | -------------------------------------------: |
| View eligible payment context |                                              Yes |                                           Yes |                             Yes |      Read for execution |                                           No |
| Create request                |                                              Yes | Yes, if not sole approver condition violation |                             Yes |                      No |                                           No |
| Decide request                | No unless explicitly approver; never own request |                     Yes, other requester only |     Only if explicitly approver |                      No |                                           No |
| Cancel pending own request    |                                              Yes |                              Own request only |                Own request only |                      No |                                           No |
| Create Stripe Refund          |                  No direct RefundDesk credential |               No direct RefundDesk credential | No direct RefundDesk credential | Yes, approved jobs only |                                           No |
| Configure approvers           |                                               No |                                            No |                             Yes |                      No |                                           No |
| Purge expired tenant data     |                                               No |                                            No |                              No |                      No |                         Restricted procedure |
| Run migrations                |                                               No |                                            No |                              No |                      No | Separate owner role, not maintenance runtime |

Stripe native rights remain outside this table and are handled through exception detection.

## 8. Abuse cases to exercise in Phase 0

1. Change one signed byte, reorder one field and substitute the account.
2. Use `View only` to attempt a native Stripe refund and a RefundDesk request.
3. Replay the same app request nonce with both identical and changed content.
4. Replay the Stripe refund call with the identical idempotency key.
5. Create a manual Refund without proof metadata.
6. Copy proof metadata to a second Refund.
7. Present test credentials to a managed sandbox installation and vice versa.
8. Present any `livemode=true` context.

## 9. Incident priorities

Severity 0:

- live effect during the pilot;
- duplicate Refund attributable to RefundDesk;
- Refund on the wrong account/payment/environment;
- exposed Stripe or cryptographic key;
- confirmed cross-tenant access.

Severity 1:

- ambiguous effect with guard intact;
- webhook and scanner both unavailable;
- audit integrity failure;
- sensitive workflow text in logs.

For response procedures, see `docs/OPERATIONS_RUNBOOK.md`.

## 10. Residual-risk acceptance

The pilot explicitly accepts:

- RefundDesk cannot prevent native/external refunds;
- a compromised authorized approver can approve another user’s malicious request;
- detection can exceed thirty minutes during Stripe or worker outage;
- local operator credentials are a high-trust boundary;
- the pilot is not production hardened or certified.

It does not accept duplicate financial effects, wrong-tenant effects, live execution or silent release of an ambiguous effect guard.
