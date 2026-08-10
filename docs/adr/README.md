# Architecture decision records

ADRs are immutable after acceptance. Supersede an ADR with a new file instead of rewriting its decision.

| ADR                                                                          | Decision                                                     | Status                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------- |
| [0001](0001-pilot-scope-and-live-interlock.md)                               | Pilot scope and live interlock                               | Accepted                   |
| [0002](0002-refund-effect-boundary.md)                                       | Refund effect boundary and immutable identity                | Accepted                   |
| [0003](0003-tenant-isolation-and-cryptography.md)                            | Forced RLS and separate cryptographic purposes               | Accepted                   |
| [0004](0004-external-refund-reconciliation.md)                               | External refund detection through webhooks and scans         | Accepted                   |
| [0005](0005-payment-scoped-external-refund-protection.md)                    | Durable payment protection after an external Refund          | Accepted                   |
| [0006](0006-durable-executing-recovery-and-dual-lane-reconciliation.md)      | Safe recovery and dual-lane Refund reconciliation            | Accepted                   |
| [0007](0007-database-financial-authority-boundary.md)                        | Web/worker financial authority separation                    | Superseded in part by 0033 |
| [0008](0008-stripe-app-local-packaging-and-preview-boundary.md)              | Standalone packaging and local preview boundary              | Accepted                   |
| [0009](0009-stripe-signed-identity-and-role-assertion.md)                    | Separate signed identity from optional role assertion        | Accepted                   |
| [0010](0010-persistent-hosted-sandbox-topology.md)                           | Persistent least-privilege hosted sandbox topology           | Accepted                   |
| [0011](0011-worker-owned-stripe-approval-attestation.md)                     | Worker-owned Stripe approval attestation                     | Accepted                   |
| [0012](0012-direct-account-stripe-authority-and-webhooks.md)                 | Direct-account Stripe authority and webhooks                 | Accepted                   |
| [0013](0013-unpublished-hosted-sandbox-stripe-app-origin.md)                 | Unpublished hosted-sandbox Stripe App origin                 | Accepted                   |
| [0014](0014-startup-reconciliation-catch-up.md)                              | Startup reconciliation catch-up before readiness             | Accepted                   |
| [0015](0015-maintenance-quiescence-recovery-boundary.md)                     | Fail-closed maintenance finalization and recovery            | Accepted                   |
| [0016](0016-same-revision-runtime-recreation.md)                             | Same-revision stateless runtime recreation                   | Accepted                   |
| [0017](0017-durable-signed-request-rate-limiter.md)                          | Durable pre-tenant signed-request rate limiting              | Accepted                   |
| [0018](0018-trusted-edge-and-two-stage-approval-attestation.md)              | Trusted edge and two-stage approval attestation              | Accepted                   |
| [0019](0019-exact-e4-contained-compromised-stripe-credential-transition.md)  | Exact-e4 contained compromised Stripe credential transition  | Accepted                   |
| [0020](0020-multi-account-credential-registry-and-admission.md)              | Stripe API authentication model and account admission        | Proposed                   |
| [0021](0021-outbound-approval-webhook-notifications.md)                      | Outbound approval webhook notifications                      | Corrected by 0025          |
| [0022](0022-exact-e4-orchestrator-local-aws-output-normalisation.md)         | Exact-e4 orchestrator local AWS output normalisation         | Accepted                   |
| [0023](0023-exact-e4-void-task-result-pipeline-defect.md)                    | Exact-e4 discarded VoidTaskResult on stdin-bearing calls     | Superseded in part by 0024 |
| [0024](0024-exact-e4-execution-corrections-and-containment-observability.md) | Exact-e4 execution corrections and containment observability | Accepted                   |
| [0025](0025-outbound-webhook-record-correction.md)                           | Correcting the outbound-webhook record                       | Accepted                   |
| [0026](0026-webhook-secret-overlap-and-export-key-cutover.md)                | Webhook secret overlap and export key cutover                | Accepted                   |
| [0027](0027-outbound-webhook-connection-pinning.md)                          | Outbound webhook connection pinning                          | Accepted                   |
| [0028](0028-app-signing-secret-rotation-overlap.md)                          | App signing secret rotation overlap                          | Accepted                   |
| [0029](0029-cloudfront-only-origin-ingress-and-measured-edge-posture.md)     | CloudFront-only origin ingress and measured edge posture     | Superseded in part by 0031 |
| [0030](0030-failed-release-recoverability.md)                                | A failed release must leave a recoverable host               | Superseded in part by 0032 |
| [0031](0031-cloudfront-network-filter-is-not-origin-identity.md)             | CloudFront network filtering is not origin identity          | Accepted                   |
| [0032](0032-failed-release-is-recoverable-not-available.md)                  | Failed release is recoverable, not necessarily available     | Accepted                   |
| [0033](0033-bounded-transaction-retry-and-lifecycle-terminology.md)          | Bounded transaction retry and lifecycle terminology          | Accepted                   |
| [0034](0034-exact-e4-independent-review-and-read-only-host-postflight.md)    | Independent exact-e4 review and read-only host postflight    | Accepted                   |
| [0035](0035-exact-8da-contained-quiescence-reconciliation.md)                | Exact-8da contained quiescence reconciliation                | Accepted                   |
| [0036](0036-current-stripe-binding-incident-admission.md)                    | Current Stripe binding incident admission                    | Accepted                   |
| [0037](0037-bounded-cloudfront-origin-window.md)                             | Contained promotion and bounded CloudFront origin window     | Accepted                   |
