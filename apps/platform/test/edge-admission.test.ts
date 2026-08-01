import { describe, expect, it } from "vitest";

import {
  EDGE_SOURCE_SCOPE_CAPACITIES,
  EDGE_SOURCE_SCOPE_CAPACITY_TOTAL,
  EdgeAdmissionDeniedReason,
  MemoryEdgeAdmissionGate,
  STRIPE_WEBHOOK_IP_ALLOWLIST_SIZE,
  STRIPE_WEBHOOK_IP_ALLOWLIST_VERSION,
  type EdgeAdmissionClassPolicyOverride,
  type EdgeAdmissionDecision,
} from "../src/server/edge-admission.js";

const TEST_KEY = Buffer.alloc(32, 0x5a);
const STRIPE_WEBHOOK_IPS = [
  "3.18.12.63",
  "3.130.192.231",
  "13.235.14.237",
  "13.235.122.149",
  "18.211.135.69",
  "35.154.171.200",
  "52.15.183.38",
  "54.88.130.119",
  "54.88.130.237",
  "54.187.174.169",
  "54.187.205.235",
  "54.187.216.72",
  "35.157.207.129",
  "3.69.109.8",
  "3.120.168.93",
] as const;

function headers(chain: string, marker = "cloudfront-v1"): Headers {
  return new Headers({
    "x-refunddesk-edge-verified": marker,
    "x-refunddesk-viewer-chain": chain,
  });
}

function expectAllowed(
  decision: EdgeAdmissionDecision,
): asserts decision is Extract<EdgeAdmissionDecision, { allowed: true }> {
  expect(decision.allowed).toBe(true);
}

function release(decision: EdgeAdmissionDecision): void {
  expectAllowed(decision);
  decision.lease.release();
}

function roomyPolicy(
  override: EdgeAdmissionClassPolicyOverride = {},
): EdgeAdmissionClassPolicyOverride {
  return {
    concurrency: override.concurrency ?? 10_000,
    global: {
      burst: override.global?.burst ?? 10_000,
      intervalMs: override.global?.intervalMs ?? 1,
    },
    source: {
      burst: override.source?.burst ?? 10_000,
      intervalMs: override.source?.intervalMs ?? 1,
    },
  };
}

describe("MemoryEdgeAdmissionGate", () => {
  it("uses one synthetic source and ignores untrusted forwarding headers outside hosted mode", () => {
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      policies: {
        account_webhook: roomyPolicy({ source: { burst: 1, intervalMs: 1_000 } }),
        audit_download: roomyPolicy({ source: { burst: 1, intervalMs: 1_000 } }),
        signed_api: roomyPolicy({ source: { burst: 1, intervalMs: 1_000 } }),
      },
      requireTrustedEdge: false,
    });

    release(gate.acquire(new Headers(), "signed_api"));
    expect(gate.acquire(headers("198.51.100.1"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });
    release(gate.acquire(new Headers(), "account_webhook"));
    release(gate.acquire(new Headers(), "audit_download"));
  });

  it("enforces the default signed source burst and deterministic refill", () => {
    let nowMs = 0;
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      requireTrustedEdge: true,
    });
    const requestHeaders = headers("198.51.100.10");

    for (let index = 0; index < 100; index += 1) {
      release(gate.acquire(requestHeaders, "signed_api"));
    }
    expect(gate.acquire(requestHeaders, "signed_api")).toEqual({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
      retryAfterSeconds: 1,
      status: 429,
    });

    nowMs = 249;
    expect(gate.acquire(requestHeaders, "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });
    nowMs = 250;
    release(gate.acquire(requestHeaders, "signed_api"));
  });

  it("enforces the exact default global bursts and refill intervals", () => {
    let nowMs = 0;
    const signedGate = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      requireTrustedEdge: true,
    });
    const address = (index: number): string => `198.51.${Math.floor(index / 256)}.${index % 256}`;
    for (let index = 0; index < 200; index += 1) {
      release(signedGate.acquire(headers(address(index)), "signed_api"));
    }
    expect(signedGate.acquire(headers(address(200)), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
    });
    nowMs = 100;
    release(signedGate.acquire(headers(address(200)), "signed_api"));

    nowMs = 0;
    const webhookGate = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      requireTrustedEdge: true,
    });
    for (let index = 0; index < 80; index += 1) {
      release(
        webhookGate.acquire(
          headers(STRIPE_WEBHOOK_IPS[index % STRIPE_WEBHOOK_IPS.length] ?? ""),
          "account_webhook",
        ),
      );
    }
    expect(webhookGate.acquire(headers(STRIPE_WEBHOOK_IPS[0]), "account_webhook")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
    });
    nowMs = 200;
    release(webhookGate.acquire(headers(STRIPE_WEBHOOK_IPS[0]), "account_webhook"));

    nowMs = 0;
    const auditGate = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      requireTrustedEdge: true,
    });
    for (let index = 0; index < 20; index += 1) {
      release(auditGate.acquire(headers(address(index)), "audit_download"));
    }
    expect(auditGate.acquire(headers(address(20)), "audit_download")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
    });
    nowMs = 2_000;
    release(auditGate.acquire(headers(address(20)), "audit_download"));
  });

  it("enforces the exact default webhook source burst and refill", () => {
    let nowMs = 0;
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      requireTrustedEdge: true,
    });
    const requestHeaders = headers(STRIPE_WEBHOOK_IPS[0]);
    for (let index = 0; index < 40; index += 1) {
      release(gate.acquire(requestHeaders, "account_webhook"));
    }
    expect(gate.acquire(requestHeaders, "account_webhook")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });
    nowMs = 500;
    release(gate.acquire(requestHeaders, "account_webhook"));
  });

  it("enforces the exact default audit-download source burst and refill", () => {
    let nowMs = 0;
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      requireTrustedEdge: true,
    });
    const requestHeaders = headers("198.51.100.30");
    for (let index = 0; index < 5; index += 1) {
      release(gate.acquire(requestHeaders, "audit_download"));
    }
    expect(gate.acquire(requestHeaders, "audit_download")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });
    nowMs = 10_000;
    release(gate.acquire(requestHeaders, "audit_download"));
  });

  it("charges tracked sources first without retaining unseen globally denied sources", () => {
    let nowMs = 0;
    const globalFirst = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      policies: {
        signed_api: roomyPolicy({
          global: { burst: 2, intervalMs: 1_000 },
          source: { burst: 2, intervalMs: 1_000 },
        }),
      },
      requireTrustedEdge: true,
    });
    release(globalFirst.acquire(headers("198.51.100.1"), "signed_api"));
    release(globalFirst.acquire(headers("198.51.100.2"), "signed_api"));
    expect(globalFirst.acquire(headers("198.51.100.1"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
      status: 429,
    });
    expect(globalFirst.acquire(headers("198.51.100.1"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });
    expect(globalFirst.acquire(headers("198.51.100.3"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
    });
    expect(globalFirst.acquire(headers("198.51.100.3"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
    });
    nowMs = 1_000;
    release(globalFirst.acquire(headers("198.51.100.3"), "signed_api"));

    nowMs = 0;
    const atomic = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      policies: {
        signed_api: roomyPolicy({
          global: { burst: 2, intervalMs: 1_000 },
          source: { burst: 1, intervalMs: 1_000 },
        }),
      },
      requireTrustedEdge: true,
    });
    release(atomic.acquire(headers("198.51.100.1"), "signed_api"));
    expect(atomic.acquire(headers("198.51.100.1"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });
    release(atomic.acquire(headers("198.51.100.2"), "signed_api"));
    expect(atomic.acquire(headers("198.51.100.3"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
    });
    expect(atomic.acquire(headers("198.51.100.3"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
    });
    nowMs = 1_000;
    release(atomic.acquire(headers("198.51.100.3"), "signed_api"));
  });

  it("does not retain new sources rejected by the global budget", () => {
    let nowMs = 0;
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      policies: {
        audit_download: roomyPolicy({ global: { burst: 1, intervalMs: 1_000 } }),
      },
      requireTrustedEdge: true,
    });
    const capacity = EDGE_SOURCE_SCOPE_CAPACITIES.audit_download;
    const address = (index: number): string => `198.51.100.${index + 1}`;

    release(gate.acquire(headers(address(0)), "audit_download"));
    for (let index = 1; index <= capacity; index += 1) {
      expect(gate.acquire(headers(address(index)), "audit_download")).toMatchObject({
        allowed: false,
        reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
      });
    }

    nowMs = 1_000;
    release(gate.acquire(headers(address(capacity)), "audit_download"));
  });

  it("charges tracked sources without retaining unseen sources rejected by concurrency", () => {
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      policies: {
        audit_download: roomyPolicy({
          concurrency: 1,
          source: { burst: 2, intervalMs: 1_000 },
        }),
      },
      requireTrustedEdge: true,
    });
    const capacity = EDGE_SOURCE_SCOPE_CAPACITIES.audit_download;
    const address = (index: number): string => `198.51.100.${index + 1}`;
    const held = gate.acquire(headers(address(0)), "audit_download");
    expectAllowed(held);
    expect(gate.acquire(headers(address(0)), "audit_download")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.ConcurrencyLimited,
    });
    expect(gate.acquire(headers(address(0)), "audit_download")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });

    for (let index = 1; index <= capacity; index += 1) {
      expect(gate.acquire(headers(address(index)), "audit_download")).toMatchObject({
        allowed: false,
        reason: EdgeAdmissionDeniedReason.ConcurrencyLimited,
      });
    }

    held.lease.release();
    release(gate.acquire(headers(address(capacity)), "audit_download"));
  });

  it("bounds concurrency and releases an idempotent lease", () => {
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      policies: { signed_api: roomyPolicy({ concurrency: 2 }) },
      requireTrustedEdge: true,
    });
    const first = gate.acquire(headers("198.51.100.1"), "signed_api");
    const second = gate.acquire(headers("198.51.100.2"), "signed_api");
    expectAllowed(first);
    expectAllowed(second);

    expect(gate.acquire(headers("198.51.100.3"), "signed_api")).toEqual({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.ConcurrencyLimited,
      retryAfterSeconds: 1,
      status: 429,
    });
    first.lease.release();
    first.lease.release();
    release(gate.acquire(headers("198.51.100.3"), "signed_api"));
    second.lease.release();
  });

  it("uses the exact default signed, webhook and audit-download concurrency ceilings", () => {
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      requireTrustedEdge: true,
    });
    const signedLeases = Array.from({ length: 16 }, (_, index) =>
      gate.acquire(headers(`198.51.100.${index + 1}`), "signed_api"),
    );
    signedLeases.forEach(expectAllowed);
    expect(gate.acquire(headers("198.51.100.17"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.ConcurrencyLimited,
    });
    signedLeases.forEach((decision) => {
      if (decision.allowed) {
        decision.lease.release();
      }
    });

    const webhookLeases = Array.from({ length: 8 }, (_, index) =>
      gate.acquire(headers(STRIPE_WEBHOOK_IPS[index] ?? ""), "account_webhook"),
    );
    webhookLeases.forEach(expectAllowed);
    expect(gate.acquire(headers(STRIPE_WEBHOOK_IPS[8]), "account_webhook")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.ConcurrencyLimited,
    });
    webhookLeases.forEach((decision) => {
      if (decision.allowed) {
        decision.lease.release();
      }
    });

    const auditLeases = Array.from({ length: 2 }, (_, index) =>
      gate.acquire(headers(`198.51.100.${index + 40}`), "audit_download"),
    );
    auditLeases.forEach(expectAllowed);
    expect(gate.acquire(headers("198.51.100.42"), "audit_download")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.ConcurrencyLimited,
    });
    auditLeases.forEach((decision) => {
      if (decision.allowed) {
        decision.lease.release();
      }
    });
  });

  it("caps source cardinality and cleans only idle scopes without debt", () => {
    let nowMs = 0;
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => nowMs,
      key: TEST_KEY,
      policies: {
        signed_api: roomyPolicy({
          global: { burst: 10_000, intervalMs: 1 },
          source: { burst: 1, intervalMs: 400_000 },
        }),
      },
      requireTrustedEdge: true,
    });
    const address = (index: number): string =>
      `10.${Math.floor(index / 65_536)}.${Math.floor(index / 256) % 256}.${index % 256}`;

    for (let index = 0; index < EDGE_SOURCE_SCOPE_CAPACITIES.signed_api; index += 1) {
      release(gate.acquire(headers(address(index)), "signed_api"));
    }
    const overflowAddress = address(EDGE_SOURCE_SCOPE_CAPACITIES.signed_api);
    expect(gate.acquire(headers(overflowAddress), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceCapacityExceeded,
      status: 429,
    });

    nowMs = 300_000;
    expect(gate.acquire(headers(overflowAddress), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceCapacityExceeded,
    });
    nowMs = 400_000;
    release(gate.acquire(headers(overflowAddress), "signed_api"));
  });

  it("uses three isolated source maps with an exact fixed total capacity", () => {
    expect(EDGE_SOURCE_SCOPE_CAPACITIES).toEqual({
      account_webhook: 64,
      audit_download: 64,
      signed_api: 1_920,
    });
    expect(EDGE_SOURCE_SCOPE_CAPACITY_TOTAL).toBe(2_048);

    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      policies: {
        account_webhook: roomyPolicy(),
        audit_download: roomyPolicy(),
        signed_api: roomyPolicy(),
      },
      requireTrustedEdge: true,
    });
    const address = (index: number): string =>
      `10.${Math.floor(index / 65_536)}.${Math.floor(index / 256) % 256}.${index % 256}`;

    for (let index = 0; index < EDGE_SOURCE_SCOPE_CAPACITIES.signed_api; index += 1) {
      release(gate.acquire(headers(address(index)), "signed_api"));
    }
    expect(
      gate.acquire(headers(address(EDGE_SOURCE_SCOPE_CAPACITIES.signed_api)), "signed_api"),
    ).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceCapacityExceeded,
    });

    for (let index = 0; index < EDGE_SOURCE_SCOPE_CAPACITIES.audit_download; index += 1) {
      release(gate.acquire(headers(address(index)), "audit_download"));
    }
    expect(
      gate.acquire(headers(address(EDGE_SOURCE_SCOPE_CAPACITIES.audit_download)), "audit_download"),
    ).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceCapacityExceeded,
    });

    release(gate.acquire(headers(STRIPE_WEBHOOK_IPS[0]), "account_webhook"));
  });

  it("uses a separate O(1) overflow budget without spending admitted-work capacity", () => {
    const capacity = EDGE_SOURCE_SCOPE_CAPACITIES.signed_api;
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      policies: {
        signed_api: roomyPolicy({
          global: { burst: capacity + 1, intervalMs: 1_000 },
        }),
      },
      requireTrustedEdge: true,
    });
    const address = (index: number): string =>
      `10.${Math.floor(index / 65_536)}.${Math.floor(index / 256) % 256}.${index % 256}`;

    for (let index = 0; index < capacity; index += 1) {
      release(gate.acquire(headers(address(index)), "signed_api"));
    }
    expect(gate.acquire(headers(address(capacity)), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceCapacityExceeded,
    });
    release(gate.acquire(headers(address(0)), "signed_api"));
    expect(gate.acquire(headers(address(1)), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.GlobalRateLimited,
    });
  });

  it("requires the exact trusted marker and a bounded, valid viewer chain", () => {
    const gate = new MemoryEdgeAdmissionGate({ key: TEST_KEY, requireTrustedEdge: true });
    const missingMarker = new Headers({ "x-refunddesk-viewer-chain": "198.51.100.1" });
    expect(gate.acquire(missingMarker, "signed_api")).toEqual({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.EdgeNotTrusted,
      status: 503,
    });
    expect(gate.acquire(headers("198.51.100.1", "CloudFront-v1"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.EdgeNotTrusted,
    });
    expect(
      gate.acquire(new Headers({ "x-refunddesk-edge-verified": "cloudfront-v1" }), "signed_api"),
    ).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceInvalid,
      status: 503,
    });

    const malformedChains = [
      "",
      "not-an-ip",
      "198.51.100.1,",
      Array.from({ length: 33 }, () => "198.51.100.1").join(","),
      `198.51.100.1${" ".repeat(2_048)},198.51.100.2`,
    ];
    for (const chain of malformedChains) {
      expect(gate.acquire(headers(chain), "signed_api")).toMatchObject({
        allowed: false,
        reason: EdgeAdmissionDeniedReason.SourceInvalid,
        status: 503,
      });
    }
  });

  it.each(["signed_api", "account_webhook", "audit_download"] as const)(
    "fails closed if the CloudFront origin token reaches the hosted %s path",
    (requestClass) => {
      const hosted = new MemoryEdgeAdmissionGate({ key: TEST_KEY, requireTrustedEdge: true });
      const forwarded = headers("3.18.12.63");
      forwarded.set("x-refunddesk-origin-token", "synthetic-must-be-stripped");

      expect(hosted.acquire(forwarded, requestClass)).toEqual({
        allowed: false,
        reason: EdgeAdmissionDeniedReason.OriginTokenForwarded,
        status: 503,
      });

      const local = new MemoryEdgeAdmissionGate({ key: TEST_KEY, requireTrustedEdge: false });
      release(local.acquire(forwarded, requestClass));
    },
  );

  it("uses only the rightmost viewer address and resists a spoofed leftmost value", () => {
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      policies: {
        signed_api: roomyPolicy({ source: { burst: 1, intervalMs: 1_000 } }),
      },
      requireTrustedEdge: true,
    });
    release(gate.acquire(headers("192.0.2.1, 198.51.100.8"), "signed_api"));
    expect(gate.acquire(headers("203.0.113.200, 198.51.100.8"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });
    release(gate.acquire(headers("192.0.2.1, 198.51.100.9"), "signed_api"));
  });

  it("aggregates canonical IPv6 sources by /64", () => {
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      policies: {
        signed_api: roomyPolicy({ source: { burst: 1, intervalMs: 1_000 } }),
      },
      requireTrustedEdge: true,
    });
    release(gate.acquire(headers("2001:db8:abcd:12::1"), "signed_api"));
    expect(gate.acquire(headers("2001:0db8:abcd:0012:ffff::2"), "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });
    release(gate.acquire(headers("2001:db8:abcd:13::1"), "signed_api"));
  });

  it("applies the versioned official Stripe webhook allowlist to the rightmost source", () => {
    expect(STRIPE_WEBHOOK_IP_ALLOWLIST_VERSION).toBe("stripe-docs-2026-08-01");
    expect(STRIPE_WEBHOOK_IP_ALLOWLIST_SIZE).toBe(STRIPE_WEBHOOK_IPS.length);
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      requireTrustedEdge: true,
    });
    for (const address of STRIPE_WEBHOOK_IPS) {
      release(gate.acquire(headers(address), "account_webhook"));
    }
    expect(gate.acquire(headers("3.18.12.63, 203.0.113.8"), "account_webhook")).toEqual({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.WebhookSourceForbidden,
      status: 403,
    });
    release(gate.acquire(headers("203.0.113.8, 3.18.12.63"), "account_webhook"));
  });

  it("isolates request classes for one source", () => {
    const gate = new MemoryEdgeAdmissionGate({
      clockMs: () => 0,
      key: TEST_KEY,
      policies: {
        account_webhook: roomyPolicy({ source: { burst: 1, intervalMs: 1_000 } }),
        audit_download: roomyPolicy({ source: { burst: 1, intervalMs: 1_000 } }),
        signed_api: roomyPolicy({ source: { burst: 1, intervalMs: 1_000 } }),
      },
      requireTrustedEdge: true,
    });
    const requestHeaders = headers("3.18.12.63");
    release(gate.acquire(requestHeaders, "signed_api"));
    expect(gate.acquire(requestHeaders, "signed_api")).toMatchObject({
      allowed: false,
      reason: EdgeAdmissionDeniedReason.SourceRateLimited,
    });
    release(gate.acquire(requestHeaders, "account_webhook"));
    release(gate.acquire(requestHeaders, "audit_download"));
  });

  it("keeps source state private and resets it with a new process-local instance", () => {
    const options = {
      clockMs: () => 0,
      key: TEST_KEY,
      policies: {
        signed_api: roomyPolicy({ source: { burst: 1, intervalMs: 1_000 } }),
      },
      requireTrustedEdge: true,
    } as const;
    const first = new MemoryEdgeAdmissionGate(options);
    const requestHeaders = headers("198.51.100.44");
    release(first.acquire(requestHeaders, "signed_api"));
    expect(first.acquire(requestHeaders, "signed_api")).toMatchObject({ allowed: false });
    expect(Object.keys(first)).toEqual([]);
    expect(JSON.stringify(first)).toBe("{}");

    const replacement = new MemoryEdgeAdmissionGate(options);
    release(replacement.acquire(requestHeaders, "signed_api"));
  });
});
