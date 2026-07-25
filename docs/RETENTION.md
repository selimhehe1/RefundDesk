# RefundDesk pilot retention and deletion policy

> Version: 1.0 for the v1.1 pilot  
> Effective: 2026-07-25  
> Scope: local, Stripe test mode and managed sandbox  
> Review trigger: production hosting, live mode, customer data, legal hold or changed regulation

This is an engineering data-lifecycle policy, not legal advice. A production launch requires legal review of controller/processor roles, notices, data processing terms and applicable retention duties.

## 1. Principles

- Collect only data required to authorize, execute, reconcile and audit the pilot.
- Do not store customer e-mail, name, address, card data or complete Stripe payloads.
- Keep sensitive text encrypted and out of logs.
- Use the shortest operationally credible retention period.
- Suspend effects immediately after uninstallation.
- Delete tenant data no later than thirty days after uninstallation unless a documented legal hold applies.
- Keep purge capability separate from normal web and worker roles.

## 2. Data classes and schedule

| Data class                 | Examples                                                                            |                                   Retention | Start of clock              | Disposition                                    |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------: | --------------------------- | ---------------------------------------------- |
| Workflow records           | request state, amount, currency, payment/refund IDs                                 |                                    365 days | request creation            | Delete                                         |
| Decisions                  | approver ID, decision, timestamps                                                   |                                    365 days | decision timestamp          | Delete                                         |
| Sensitive workflow text    | justification, rejection reason                                                     |                                    365 days | associated request creation | Cryptographically delete then remove row/field |
| Audit events               | action, actor, transition, correlation                                              |                                    365 days | event timestamp             | Delete through maintenance procedure           |
| Mutation receipts          | nonce, operation, actor, payload hash, response                                     |                                    365 days | receipt creation            | Delete                                         |
| External alerts            | payment scope, classification, Refund ID, acknowledgement and unresolved protection |                                    365 days | alert creation              | Delete only through guarded tenant purge       |
| Webhook receipts           | Event ID, type, account, timestamps, processing status                              |                                     90 days | receipt creation            | Delete                                         |
| Reconciliation checkpoints | cursor/window and completion timestamps                                             | Current plus 90 days of history if retained | supersession                | Delete obsolete history                        |
| Operational logs           | redacted structured logs                                                            |                                     30 days | event timestamp             | Delete/expire                                  |
| Phase 0/pilot evidence     | redacted case results                                                               |                                    365 days | test completion             | Delete unless needed for an open incident      |
| Cryptographic key versions | encrypted/HMAC material                                                             |    While retained data requires the version | version retirement          | Revoke and securely remove                     |
| Purge certificate          | tenant pseudonym, completion time, counts, policy version                           |                                    365 days | purge completion            | Delete                                         |

The table defines maximum routine retention, not a promise to retain data for the entire period if the tenant is uninstalled and early purge is due.

## 3. Prohibited storage

Do not persist:

- card number, CVC or bank details;
- customer e-mail, name, phone or postal address;
- full PaymentIntent, Charge, Refund or Event payload;
- Stripe secret, restricted, app-signing or webhook key;
- full request signatures;
- plaintext justification or rejection reason outside the in-memory operation that needs it;
- authentication cookies or Dashboard credentials;
- raw HTTP bodies in logs, error trackers or evidence.

If prohibited data is discovered, treat it as an incident, stop further collection, restrict access and purge it after preserving only the minimum lawful incident evidence.

## 4. Encryption lifecycle

Sensitive text is AES-256-GCM encrypted with a versioned external key and AAD bound to tenant, row and field. Proof metadata uses a separate versioned HMAC key.

Rotation:

- new writes use the active version;
- previous field keys remain decrypt-only while retained ciphertext depends on them;
- previous proof keys remain verify-only while a retained Refund proof can appear;
- old key deletion occurs only after dependency counts reach zero and any retained backups have expired;
- compromise can require immediate revocation and makes affected data/evidence subject to incident review.

Deleting a key is not a substitute for deleting database rows and indexes, but it is used as an immediate confidentiality control during scheduled purge.

## 5. Routine expiry

Run maintenance at least daily in any persistent pilot environment.

Procedure:

1. calculate cutoffs from a database/UTC clock;
2. select bounded batches by data class;
3. exclude rows under documented legal hold;
4. avoid deleting data required by an unresolved `possible`, `identified` or `reconciliation_required` financial state;
5. delete dependent sensitive data before or with parent records;
6. record counts and completion without plaintext values;
7. retry idempotently;
8. alert on overdue oldest records.

Routine expiry must not run as a table owner from the web or worker. It uses a limited maintenance function/role that can execute only approved retention operations.

## 6. Uninstallation lifecycle

At `T0`, when uninstallation is observed:

1. suspend the installation;
2. block new requests, decisions and effect claims;
3. record the uninstall timestamp;
4. reconcile any effect already `possible` or `identified`;
5. set `purge_due_at <= T0 + 30 days`.

Before the deadline:

- complete or safely preserve unresolved financial reconciliation;
- detach webhook and app credentials after they are no longer needed;
- perform a dry-run count;
- confirm there is no active legal hold;
- purge all tenant-owned operational data.

If an unresolved financial effect prevents full deletion at day 30, escalate before the deadline. Retain only the minimum isolated record needed to resolve it, document the exception and delete immediately after resolution.

## 7. Tenant purge order

A reviewed purge transaction or sequence should remove:

1. queued jobs that have not crossed an effect boundary;
2. mutation receipts;
3. webhook receipts and reconciliation history;
4. external alerts;
5. execution attempts and executions after ambiguity checks;
6. decisions;
7. encrypted sensitive text and requests;
8. audit events under the maintenance policy;
9. users, policies and installation records;
10. tenant record.

Referential constraints should prevent orphaned data. Object-storage or error-tracker artifacts, if ever introduced, must join the same purge workflow before production.

## 8. Purge certificate

After successful purge, create a non-personal certificate containing only:

- one-way tenant pseudonym using a purge-specific key;
- uninstall time;
- purge completion time;
- policy version;
- counts by broad data class;
- operator/process version;
- result.

Do not include Stripe account ID, user ID, PaymentIntent, Charge, Refund, Event ID or sensitive text.

## 9. Legal holds

A legal hold is exceptional and requires:

- documented authority and scope;
- creation and expected review date;
- data classes covered;
- access restriction;
- an audit event;
- periodic review;
- prompt purge when released.

Application users cannot create an indefinite hold through a free-text field. Legal holds must not silently enable new financial work after uninstallation.

## 10. Backups and local copies

The first-cycle plan does not authorize a managed production backup service. If local backups are created for recovery testing:

- encrypt them;
- store them outside the repository;
- document creation and expiry;
- restrict access;
- use a maximum retention no longer than the underlying data class;
- include them in key-retirement and tenant-deletion checks.

Do not copy the database to personal cloud storage, chat, tickets or source control.

## 11. Exports

Audit export is tenant-scoped and redacted:

- authenticate and authorize the requesting Stripe user;
- include only the requested tenant/environment;
- exclude secrets, payloads and ciphertext envelopes;
- stream or create a short-lived local artifact;
- do not retain generated exports beyond the user operation;
- log only the export ID, actor, time, scope and row count.

The recipient controls any copy downloaded outside RefundDesk and must be informed of its sensitivity.

## 12. Verification

Required tests:

- exact cutoff boundaries;
- idempotent repeated purge;
- tenant A purge cannot affect tenant B;
- no-context and runtime-role purge denied;
- legal hold exclusion;
- unresolved effect exclusion and alert;
- foreign-key completeness;
- encryption-key dependency count;
- logs expire at 30 days;
- webhook receipts expire at 90 days;
- uninstall purge completes within 30 days;
- purge certificate contains no Stripe identifier or PII.

Quarterly in a future persistent pilot, and before any production launch, rehearse:

- uninstallation-to-purge;
- field-key rotation;
- proof-key rotation;
- backup expiry and restore;
- prohibited-data discovery.

## 13. Ownership

- Engineering owns implementation and automated tests.
- Operations owns monitoring, exceptions and purge evidence.
- Security owns key lifecycle and incident handling.
- A future production product owner/legal reviewer approves changes to purpose and retention.

Any changed duration, new data class or new destination requires this policy and the threat model to be updated before collection begins.
