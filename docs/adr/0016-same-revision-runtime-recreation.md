# ADR 0016 — Same-revision runtime recreation

- Status: Accepted
- Date: 2026-07-30
- Owners: Engineering and operations

## Context

RefundDesk loads hosted runtime configuration from root-only environment files mounted into
Compose services. Changing such a file does not change an image tag. After the release fence stops
the active services, `docker compose up --no-start` may therefore reuse an existing exited
container whose image and Compose configuration appear unchanged.

The release candidate contract requires verifier, worker, web and Caddy to exist as newly created,
inert containers before database preparation, candidate admission and start. Reuse violates that
contract and can leave an updated configuration file on disk while the runtime still contains its
previous environment.

The defect was exposed while replacing the local placeholder Stripe App ID with the real
unpublished App ID on the hosted sandbox. No Refund request, execution, attempt or effect-capable
job existed, and both live interlocks were false.

## Decision

The canonical release invokes Compose with `--force-recreate` for exactly:

- verifier;
- worker;
- web;
- Caddy.

The command remains after the durable transition journal and release fence are armed. It retains
`--no-start`, `--no-deps`, `--no-build` and `--pull never`, and runs before the created-candidate
proof. PostgreSQL and volumes are not arguments to this command.

A same-revision configuration transition additionally requires:

1. a root-only durable configuration journal and exact rollback copy;
2. maintenance timers stopped while the transition is unresolved;
3. the canonical release with the exact active revision and retained OCI bundle;
4. proof that all four stateless container IDs changed;
5. proof that the PostgreSQL container ID did not change;
6. unchanged application-key fingerprints, verifier token, live interlocks and financial safety
   counters; the worker environment is unchanged except for the narrowly authorized Stripe
   credential rotation described below;
7. removal of the rollback and journals only after deployment verification passes.

An interrupted transition is resumed or explicitly rolled back. It is never normalized by editing
runtime state or invoking Compose outside the canonical release.

### Amendment — Stripe-owned restricted credential rotation

A confirmed exposure of a Stripe restricted API credential may require a same-revision
configuration transition before a new product revision is otherwise warranted. This exception is
limited to exactly one of these bindings per transition:

- `STRIPE_PLATFORM_TEST_READ_KEY` in the platform environment;
- `STRIPE_MANAGED_SANDBOX_READ_KEY` in the platform environment;
- `STRIPE_PLATFORM_TEST_EFFECT_KEY` in the worker environment;
- `STRIPE_MANAGED_SANDBOX_EFFECT_KEY` in the worker environment.

The transition must follow the credential order and probes in the operations runbook. It requires
a root-only durable journal and rollback copy, fingerprints of the old and candidate credential,
an exact proof that no other environment binding changed, stopped maintenance timers, and the
canonical release for the exact active revision and retained OCI bundle. The four stateless
container IDs must change while the PostgreSQL container ID remains stable.

Release, retention, backup and quiescence recovery must all address Compose through the exact
canonical revision-scoped configuration path. A symlink-equivalent path is not equivalent for this
contract because Docker Compose may treat it as a changed bind/configuration identity. A
maintenance invocation that reintroduces such path drift invalidates the precondition for a
same-revision transition; the PostgreSQL-stability proof is never relaxed to accommodate it.

Before the old read credential is revoked, its replacement must prove the required Stripe reads
and a denied `refunds.create` against an already fully refunded synthetic test object, with no new
Refund. Before the old effect credential is revoked, its replacement must complete one allowlisted
synthetic Refund through the ordinary distinct-requester approval workflow and idempotent
reconciliation. A transport-ambiguous effect is reconciled with the same request and idempotency
key; it is never replaced by another probe.

The transition remains open until the replacement is proven, the old credential is revoked and
denied, Stripe activity is reviewed, the hosted runtime is healthy, all live interlocks remain
false, and the journal and rollback copy are retired. If an exposed effect credential must be
revoked before those proofs can complete, the affected test effect path stays unavailable; that is
a fail-closed security outcome, not a completed rotation.

## Observed evidence

Commit `8357d9561be3e49987f572dc21d01dda8b40f81c` passed CI run `30529518482`, including all 21
PostgreSQL integration cases and Linux Lightsail contracts. Exact artifact run `30530093714`
produced the five-file bundle promoted to the AWS sandbox.

The following same-revision Stripe App ID transition then passed:

- four stateless runtime container IDs changed;
- the PostgreSQL container ID remained unchanged;
- five services passed deployment verification;
- application-key fingerprints and the private verifier token remained unchanged;
- financial safety counters remained unchanged and zero effect-capable row existed;
- live remained disabled;
- release, application-key and configuration journals closed;
- maintenance timers returned active.

The redacted local artifact `stripe-app-id-transition-8357d956-2026-07-30.json` has SHA-256
`3f051406160a698d4e7dc1dc18127e60fa2b4be0998064e7bfa2101d15006174`.

## Consequences

- Canonical same-revision releases force recreation of the four stateless runtimes before
  candidate admission.
- Canonical maintenance launchers bind their runners to the same revision-scoped Compose path used
  by release, and runners fail closed on any alias.
- A partial Compose recreation can remove a predecessor container before the candidate is proved.
  This remains a fail-closed availability outcome: the release fence prevents public or
  effect-capable service from starting without admission.
- PostgreSQL bookkeeping may still change during canonical migrations and queue maintenance. The
  same-revision proof covers its container identity and the explicit financial/live counters, not
  a byte-for-byte database checksum.
- The observed transition authorizes no live mode, customer data, Stripe review or Marketplace
  action.

## Rejected alternatives

- Rely on Compose's default change detection: an environment-file value can change without
  changing the Compose service hash observed for an existing container.
- Delete containers before release preflight: this destroys the active runtime evidence required
  to verify key and token continuity.
- Replace configuration and call Compose manually: this bypasses the release journal, fence,
  database preparation and deployment verifier.
- Include PostgreSQL or volumes in forced recreation: the stateless configuration problem does
  not justify broadening the stateful boundary.
