# ADR 0003 — Tenant isolation and cryptographic purposes

- Status: Accepted
- Date: 2026-07-25
- Owners: Security and engineering

## Context

RefundDesk stores workflow decisions for multiple Stripe installations. An application predicate omitted from one query could expose one tenant’s data to another. Justifications and rejection reasons may contain sensitive operational context. Workflow metadata also needs a tamper-evident proof without disclosing that context.

## Decision

All tenant-owned tables use PostgreSQL row-level security with both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.

- Web and worker roles do not own the tables and do not have `BYPASSRLS`.
- Tenant context is set as the first statement inside every tenant transaction.
- Tenant-table access outside that transaction helper is prohibited.
- Owner/migration and restricted maintenance roles are separate from runtime roles.
- Tests prove tenant A cannot read, update or infer tenant B, and no-context access fails closed.

Sensitive text fields use AES-256-GCM with:

- a random unique nonce per value;
- an explicit key version;
- AAD binding tenant, table, row and field;
- prior versions retained for decryption during rotation.

Workflow proofs use independent versioned HMAC keys:

- the active version signs new proofs;
- prior versions verify only;
- encryption keys are never reused as HMAC keys.

Short-lived audit-export links use a third signing key. It is independent from
both the field-encryption keyring and the refund-proof HMAC keyring, so an
export-token compromise cannot forge workflow proof or decrypt sensitive text.

Secret keys remain in local ignored files for development and in a secret manager for any future deployment. Logs, errors and exports never include keys, plaintext sensitive fields or complete ciphertext envelopes.

## Consequences

- Database access requires transaction-scoped tenant context.
- Connection-pool reset and context-leak tests are mandatory.
- Key rotation is an explicit operation with audit evidence.
- A database-only compromise does not reveal encrypted text without the external key, although metadata and operational identifiers remain in scope.

## Rejected alternatives

- Application-only tenant filters: a single missing predicate can leak data.
- A privileged runtime role: it silently bypasses policy.
- Deterministic encryption: equality leakage is unnecessary for these fields.
- One key for encryption and proof: it couples compromise and rotation domains.
