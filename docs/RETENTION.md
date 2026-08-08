# RefundDesk pilot retention and deletion policy

> Version: 1.1 for the v1.1 pilot
> Effective: 2026-07-25; hosted-sandbox posture note updated 2026-08-08
> Scope: local and approved AWS hosting, Stripe test mode and managed sandbox
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
| Merchant staff identity    | Stripe user ID, Dashboard display name, signed Stripe roles, last-seen timestamp    |                          Until tenant purge | first RefundDesk visit      | Delete with the tenant                         |
| Workflow records           | request state, amount, currency, payment/refund IDs                                 |                                    365 days | request creation            | Delete                                         |
| Decisions                  | approver ID, decision, timestamps                                                   |                                    365 days | decision timestamp          | Delete                                         |
| Approval attestations      | signed-body hash, identity/financial snapshot hash, HMAC and bounded timestamps     |                                    365 days | verification timestamp      | Delete with the associated request             |
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

The prohibition on names and e-mail addresses covers the merchant's **customers**. The
Dashboard display name of a member of the merchant's own staff is a separate, narrower class:
Stripe supplies it in the extension context, RefundDesk stores it only so an Administrator can
recognise the people they authorise as approvers instead of matching raw `usr_…` identifiers,
and it is deleted with the tenant. Staff e-mail addresses remain out of scope: reading them
would require the `user_email_read` permission, which the manifest must not declare.

## 4. Encryption lifecycle

Sensitive text is AES-256-GCM encrypted with a versioned external key and AAD bound to tenant, row
and field. Refund proof metadata and approval attestations use two separate versioned HMAC keys.

Rotation:

- new writes use the active version;
- previous field keys remain decrypt-only while retained ciphertext depends on them;
- previous proof keys remain verify-only while a retained Refund proof can appear;
- previous approval-attestation keys remain verify-only while any retained guarded request can
  execute or reconcile;
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

The admitted hosted maintenance contract schedules the reviewed retention service hourly. A run is
successful only when the primary unit exits zero, emits a completed structured result, recovers the
exact active revision, leaves all five runtime services healthy and clears every
transition/quiescence journal. Successful `OnFailure` recovery after a primary error is
`FAIL_RECOVERED`, not retention evidence. See ADR 0015 and the operations runbook.

The first admissible read-only postflight on 8 August returned `FAIL` and observed both retention and
backup timers active while a runtime quiescence journal was present. Its stable/quiescent financial
snapshots contained no active financial workflow or guard, but timer state does not prove a
successful invocation, retention execution or recoverable maintenance state. The artifact expired
at `2026-08-08T12:52:17Z` and does not establish later state. Evidence is
`sandbox-evidence.local/aws/host-postflight-20260808T123717Z-f7a9e869c50a.local.json`, SHA-256
`8a49edb18858ef207e2ad5f8c3c3c412100d24ef8788d087cfd710d301ce9ca5`. Do not start another
maintenance operation or interpret the captured timer state as maintenance evidence without a
separate operational decision and authorization.

Exact candidate `442955960d326bd0c1c6f7424e4b842566c75f92` later passed exact CI run
`31267023532` and sandbox-bundle run `31267027925`. Its fresh preflight again observed
`FAIL`/`COHERENT_RUNNING`, the same six diagnostics, a closed and unchanged AWS firewall and
disabled live mode. Evidence SHA-256 is
`d43a93a8455f9653d883b01dd77c1664de6fed5f022b25a968c6e5e45ad7580d`.

The exact-442 contained reconciliation identified the unresolved journal operation as `retention`
but returned exit `20`, result `FAIL` and code `CORE_RUNTIME_INVALID` before effect. The successor
marker remained absent, the retention journal remained present, `resumed` was false and every
current and cumulative mutation counter was zero. Evidence SHA-256 is
`921f0b5906d558d62e4cb7f322e66b59dc9418dee9b35c96b406f96f91a2ba5c`. The immediate
read-only control postflight observed the same `FAIL`/`COHERENT_RUNNING` posture and diagnostics;
evidence SHA-256 is `9b5862e88c5bf0a66a83027296328116ff6e8dab21dc891cda2846ccfac372c0`.

Local real-Docker reproduction showed that canonical `docker create` inspection has
`Config.AttachStdout=true` and `Config.AttachStderr=true`, while the exact-442 predicate required
false. Its network-disabled disposable container was never started and was removed with its
volumes, leaving zero residue. This local diagnosis is not maintenance or host-repair evidence. The
original retention operation remains failed and unresolved; exact 442 must not be retried, and no
timer or maintenance service may be started while a corrected, newly gated successor is pending.

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
6. approval attestations and decisions;
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

The authorized AWS test/sandbox contract uses a private versioned bucket and a daily cold-backup
timer. The ADR 0032 postflight above recorded a point-in-time containment failure, not a backup or
retention pass. This is not a managed production backup service and it carries synthetic pilot data
only.

Hosted backup rules:

- quiesce all five services before copying PostgreSQL 18 PGDATA;
- encrypt every archive client-side to an offline public `age` recipient and require bucket
  SSE-S3 AES-256;
- keep the private `age` identity off the application host and bucket;
- store only generated backup objects below the dedicated sandbox prefix;
- prove versioned writes before quiescence through a unique revision-bound put/head/exact-delete
  probe, and require zero probe residue;
- retain at most the configured seven successful versions and keep total versioned bucket storage
  below 4 GiB;
- reject static AWS credentials, incomplete multipart uploads, missing revision metadata or remote
  size/SHA/encryption mismatch;
- remove the local encrypted archive after a verified upload;
- include every retained backup in field-key retirement, tenant deletion and incident checks.

On 28 July 2026, a cold backup of active revision
`42a1e4e65cf6e9144261a077c6956e77b368fffc` was restored on a disposable PostgreSQL 18.4 verifier.
Physical checksums, migrations and restricted runtime roles passed. The copied private identity and
archive were removed before termination, and zero verifier instance, volume, security group, key
pair, network interface, snapshot, image or public IPv4 remained.

On 30 July 2026, immutable revision
`71bbd98fa1e5d9989f92fba9310c200e7cf63d4f` produced a new cold archive after a clean stop of all
five services. Its unique object version, encrypted archive SHA-256, byte length, revision metadata
and SSE-S3 AES-256 state were verified. Exact-revision recovery passed, and no multipart upload,
probe residue, local archive or unfinished upload/quiescence journal remained. The exact object
then passed a disposable PostgreSQL 18.4 restore, including out-of-band checksum, decryption,
physical checksums, startup, migrations and restricted runtime-role checks. The copied identity
and archive were removed before termination, and no temporary verifier resource remained.

Later that day, then-current revision `4521b8c9e783d807813686476e4e01dfaf85e798` independently
produced one exact versioned archive with SHA-256
`f0196155190a5e46a792b463b771959a81e244458f108cabe8464b5dd001503c`, length `8327820`,
revision metadata and SSE-S3 AES-256. Exact runtime recovery passed. The selected version then
passed the same offline PostgreSQL 18.4 physical-checksum, migration and restricted-role restore
checks on a no-IAM disposable verifier after egress had been removed. All copied and temporary
material and every billable verifier resource were removed; the successful object version remains
subject to the normal seven-version/four-GiB retention boundary.

On 31 July 2026, current revision `e4cec06068d71afb5c2ac9fc04175bfdfd6756c2`
independently passed its natural hourly retention and scheduled daily cold backup. The retention
selected and purged zero rows and preserved its captured pre-invocation PostgreSQL container,
creation/start timestamps, cluster identity and database safety counts. The backup restarted that
same PostgreSQL container and verified one 8,992,512-byte encrypted object version with SHA-256
`5e4b91c06efd11932b4f5c4ee5392f56d63ac7a60d1a3bb335c8c7a36ed758fd`,
revision metadata and SSE-S3 AES-256. Both operations recovered five healthy services with live
disabled and left no local archive, probe, multipart upload or unfinished journal.

Its first disposable restore attempt on 31 July failed closed before decryption: a Windows
PowerShell native-pipeline carriage return made the final SHA-256 argument 65 bytes, and
`restore-verify.sh` rejected it during input validation. No container, PostgreSQL process,
migration or role check started and no retry was attempted. The copied identity/archive and all
temporary AWS resources were removed; cleanup and an independent audit both reported zero residue.
This result is `FAIL_PRE_EFFECT_CLEANED`, not recoverability evidence.

A separately authorized second verifier restored the exact e4 archive on 1 August 2026. Egress was
removed before transferring the private identity, and the corrected LF-only wrapper was invoked
exactly once. Archive decryption/decompression, physical checksums, offline PostgreSQL 18 startup,
migrations and restricted runtime-role checks passed. The copied identity/archive, local ephemeral
runtime files and every AWS verifier resource were removed; independent cleanup found zero residue.

The four restores prove recoverability only for their respective `42a1e4e...`, `71bbd98...`,
`4521b8c9...` and `e4cec060...` archives and exact procedures. No proof permits longer retention,
customer data, production backup claims or deletion of a key still needed by any retained version.

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
- approval-attestation count in the purge certificate;
- encryption-key dependency count;
- logs expire at 30 days;
- webhook receipts expire at 90 days;
- uninstall purge completes within 30 days;
- purge certificate contains no Stripe identifier or PII.

Quarterly in the persistent test/sandbox pilot, and before any production launch, rehearse:

- uninstallation-to-purge;
- field-key rotation;
- proof-key rotation;
- approval-attestation-key rotation;
- backup expiry and restore;
- prohibited-data discovery.

Real revision-bound backup/restore rehearsals passed for `42a1e4e...` on 28 July 2026 and for
`71bbd98...` and `4521b8c9...` on 30 July 2026. A manual retention run and the distinct
persistent-timer catch-up passed on `71bbd98...` with zero selected/purged rows and no unfinished
journal. Historical exact-e4 revision `e4cec060...` separately passed one natural retention and one scheduled encrypted
backup. Its first exact-e4 verifier attempt failed during input validation before any decryption or
restore effect and cleaned to zero. The separately authorized corrected restore then passed on
1 August 2026 and cleaned every disposable resource; the exact evidence SHA-256 is
`951505c6b61ce77a4bc04645837e595e33c2b0a13543088913af4c153fc3acf3`. Field-encryption,
Refund-proof HMAC and approval-attestation HMAC activation, rollback and reactivation, plus the
verifier-token transition, passed earlier on `71bbd98...`, but old-version retirement and a new
financial write under the active versions remain separate gates. Export-signing and remaining
Stripe-owned credential rotation/compromise drills remain open.

## 13. Ownership

- Engineering owns implementation and automated tests.
- Operations owns monitoring, exceptions and purge evidence.
- Security owns key lifecycle and incident handling.
- A future production product owner/legal reviewer approves changes to purpose and retention.

Any changed duration, new data class or new destination requires this policy and the threat model to be updated before collection begins.
