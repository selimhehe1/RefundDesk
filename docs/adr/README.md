# Architecture decision records

ADRs are immutable after acceptance. Supersede an ADR with a new file instead of rewriting its decision.

| ADR                                                                     | Decision                                              | Status   |
| ----------------------------------------------------------------------- | ----------------------------------------------------- | -------- |
| [0001](0001-pilot-scope-and-live-interlock.md)                          | Pilot scope and live interlock                        | Accepted |
| [0002](0002-refund-effect-boundary.md)                                  | Refund effect boundary and immutable identity         | Accepted |
| [0003](0003-tenant-isolation-and-cryptography.md)                       | Forced RLS and separate cryptographic purposes        | Accepted |
| [0004](0004-external-refund-reconciliation.md)                          | External refund detection through webhooks and scans  | Accepted |
| [0005](0005-payment-scoped-external-refund-protection.md)               | Durable payment protection after an external Refund   | Accepted |
| [0006](0006-durable-executing-recovery-and-dual-lane-reconciliation.md) | Safe recovery and dual-lane Refund reconciliation     | Accepted |
| [0007](0007-database-financial-authority-boundary.md)                   | Web/worker financial authority separation             | Accepted |
| [0008](0008-stripe-app-local-packaging-and-preview-boundary.md)         | Standalone packaging and local preview boundary       | Accepted |
| [0009](0009-stripe-signed-identity-and-role-assertion.md)               | Separate signed identity from optional role assertion | Accepted |
