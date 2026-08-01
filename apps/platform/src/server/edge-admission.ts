import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export type EdgeAdmissionClass = "account_webhook" | "audit_download" | "signed_api";

export enum EdgeAdmissionDeniedReason {
  ClockUnavailable = "clock_unavailable",
  ConcurrencyLimited = "concurrency_limited",
  EdgeNotTrusted = "edge_not_trusted",
  GlobalRateLimited = "global_rate_limited",
  InternalFailure = "internal_failure",
  OriginTokenForwarded = "origin_token_forwarded",
  PolicyUnavailable = "policy_unavailable",
  SourceCapacityExceeded = "source_capacity_exceeded",
  SourceInvalid = "source_invalid",
  SourceRateLimited = "source_rate_limited",
  WebhookSourceForbidden = "webhook_source_forbidden",
}

export interface EdgeAdmissionLease {
  release(): void;
}

export interface EdgeAdmissionAllowed {
  readonly allowed: true;
  readonly lease: EdgeAdmissionLease;
}

export interface EdgeAdmissionDenied {
  readonly allowed: false;
  readonly reason: EdgeAdmissionDeniedReason;
  readonly retryAfterSeconds?: number;
  readonly status: 403 | 429 | 503;
}

export type EdgeAdmissionDecision = EdgeAdmissionAllowed | EdgeAdmissionDenied;

export interface EdgeAdmissionGate {
  acquire(headers: Headers, requestClass: EdgeAdmissionClass): EdgeAdmissionDecision;
}

export interface EdgeAdmissionRatePolicy {
  readonly burst: number;
  readonly intervalMs: number;
}

export interface EdgeAdmissionClassPolicy {
  readonly concurrency: number;
  readonly global: EdgeAdmissionRatePolicy;
  readonly source: EdgeAdmissionRatePolicy;
}

export interface EdgeAdmissionRatePolicyOverride {
  readonly burst?: number;
  readonly intervalMs?: number;
}

export interface EdgeAdmissionClassPolicyOverride {
  readonly concurrency?: number;
  readonly global?: EdgeAdmissionRatePolicyOverride;
  readonly source?: EdgeAdmissionRatePolicyOverride;
}

export interface MemoryEdgeAdmissionGateOptions {
  readonly clockMs?: () => number;
  readonly key?: Uint8Array;
  readonly policies?: Partial<
    Readonly<Record<EdgeAdmissionClass, EdgeAdmissionClassPolicyOverride>>
  >;
  readonly requireTrustedEdge: boolean;
}

export const STRIPE_WEBHOOK_IP_ALLOWLIST_VERSION = "stripe-docs-2026-08-01";

const TRUSTED_EDGE_MARKER = "cloudfront-v1";
const EDGE_MARKER_HEADER = "x-refunddesk-edge-verified";
const ORIGIN_TOKEN_HEADER = "x-refunddesk-origin-token";
const VIEWER_CHAIN_HEADER = "x-refunddesk-viewer-chain";
const MAX_VIEWER_CHAIN_BYTES = 2_048;
const MAX_VIEWER_CHAIN_ELEMENTS = 32;
const SOURCE_IDLE_MS = 5 * 60 * 1_000;
const SWEEP_INTERVAL_MS = 60 * 1_000;

export const EDGE_SOURCE_SCOPE_CAPACITIES: Readonly<Record<EdgeAdmissionClass, number>> = {
  account_webhook: 64,
  audit_download: 64,
  signed_api: 1_920,
};

export const EDGE_SOURCE_SCOPE_CAPACITY_TOTAL = Object.values(EDGE_SOURCE_SCOPE_CAPACITIES).reduce(
  (total, capacity) => total + capacity,
  0,
);

const STRIPE_WEBHOOK_IPV4_ADDRESSES = [
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

export const STRIPE_WEBHOOK_IP_ALLOWLIST_SIZE = STRIPE_WEBHOOK_IPV4_ADDRESSES.length;

const STRIPE_WEBHOOK_IPV4_ALLOWLIST: ReadonlySet<string> = new Set(STRIPE_WEBHOOK_IPV4_ADDRESSES);

const DEFAULT_POLICIES: Readonly<Record<EdgeAdmissionClass, EdgeAdmissionClassPolicy>> = {
  account_webhook: {
    concurrency: 8,
    global: { burst: 80, intervalMs: 200 },
    source: { burst: 40, intervalMs: 500 },
  },
  audit_download: {
    concurrency: 2,
    global: { burst: 20, intervalMs: 2_000 },
    source: { burst: 5, intervalMs: 10_000 },
  },
  signed_api: {
    concurrency: 16,
    global: { burst: 200, intervalMs: 100 },
    source: { burst: 100, intervalMs: 250 },
  },
};

interface GcraBucket {
  tatMs: number;
}

interface SourceState {
  activeLeases: number;
  readonly bucket: GcraBucket;
  lastSeenMs: number;
}

interface ParsedSource {
  readonly allowlistAddress: string | null;
  readonly scopeBytes: Buffer;
}

interface GcraAllowedPreview {
  readonly allowed: true;
  readonly nextTatMs: number;
}

interface GcraDeniedPreview {
  readonly allowed: false;
  readonly retryAfterSeconds: number;
}

type GcraPreview = GcraAllowedPreview | GcraDeniedPreview;

function denied(
  reason: EdgeAdmissionDeniedReason,
  status: 403 | 429 | 503,
  retryAfterSeconds?: number,
): EdgeAdmissionDenied {
  if (retryAfterSeconds === undefined) {
    return { allowed: false, reason, status };
  }
  return { allowed: false, reason, retryAfterSeconds, status };
}

function assertPositiveInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a bounded positive integer`);
  }
}

function mergePolicy(
  requestClass: EdgeAdmissionClass,
  override: EdgeAdmissionClassPolicyOverride | undefined,
): EdgeAdmissionClassPolicy {
  const base = DEFAULT_POLICIES[requestClass];
  const policy = {
    concurrency: override?.concurrency ?? base.concurrency,
    global: {
      burst: override?.global?.burst ?? base.global.burst,
      intervalMs: override?.global?.intervalMs ?? base.global.intervalMs,
    },
    source: {
      burst: override?.source?.burst ?? base.source.burst,
      intervalMs: override?.source?.intervalMs ?? base.source.intervalMs,
    },
  };

  assertPositiveInteger(policy.concurrency, `${requestClass}.concurrency`, 100_000);
  assertPositiveInteger(policy.global.burst, `${requestClass}.global.burst`, 1_000_000);
  assertPositiveInteger(policy.global.intervalMs, `${requestClass}.global.intervalMs`, 3_600_000);
  assertPositiveInteger(policy.source.burst, `${requestClass}.source.burst`, 1_000_000);
  assertPositiveInteger(policy.source.intervalMs, `${requestClass}.source.intervalMs`, 3_600_000);
  return policy;
}

function previewGcra(
  bucket: GcraBucket,
  policy: EdgeAdmissionRatePolicy,
  nowMs: number,
): GcraPreview {
  const toleranceMs = (policy.burst - 1) * policy.intervalMs;
  const earliestAllowedMs = bucket.tatMs - toleranceMs;
  if (nowMs < earliestAllowedMs) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((earliestAllowedMs - nowMs) / 1_000)),
    };
  }
  return {
    allowed: true,
    nextTatMs: Math.max(bucket.tatMs, nowMs) + policy.intervalMs,
  };
}

function parseIpv4Bytes(address: string): Buffer | null {
  const octets = address.split(".");
  if (octets.length !== 4) {
    return null;
  }
  const values = octets.map((octet) => Number(octet));
  if (
    values.some(
      (value, index) =>
        !Number.isInteger(value) || value < 0 || value > 255 || String(value) !== octets[index],
    )
  ) {
    return null;
  }
  return Buffer.from(values);
}

function parseIpv6Groups(tokens: readonly string[]): number[] | null {
  const groups: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.includes(".")) {
      if (index !== tokens.length - 1) {
        return null;
      }
      const ipv4 = parseIpv4Bytes(token);
      if (ipv4 === null) {
        return null;
      }
      groups.push(ipv4.readUInt16BE(0), ipv4.readUInt16BE(2));
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/iu.test(token)) {
      return null;
    }
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}

function parseIpv6Bytes(address: string): Buffer | null {
  if (address.includes("%")) {
    return null;
  }
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const leftTokens = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
  const rightTokens = halves.length === 1 || halves[1] === "" ? [] : (halves[1]?.split(":") ?? []);
  const left = parseIpv6Groups(leftTokens);
  const right = parseIpv6Groups(rightTokens);
  if (left === null || right === null) {
    return null;
  }

  const specified = left.length + right.length;
  const compressed = halves.length === 2;
  if ((!compressed && specified !== 8) || (compressed && specified >= 8)) {
    return null;
  }
  const groups = compressed
    ? [...left, ...Array.from({ length: 8 - specified }, () => 0), ...right]
    : left;
  if (groups.length !== 8) {
    return null;
  }

  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => {
    bytes.writeUInt16BE(group, index * 2);
  });
  return bytes;
}

function parseSource(headers: Headers, requireTrustedEdge: boolean): ParsedSource | null {
  if (!requireTrustedEdge) {
    // Development and tests do not traverse CloudFront. Collapse every local
    // caller into one non-attacker-controlled scope instead of trusting a
    // forwarding header that any client could supply directly.
    return { allowlistAddress: null, scopeBytes: Buffer.from("local", "utf8") };
  }
  if (headers.get(EDGE_MARKER_HEADER) !== TRUSTED_EDGE_MARKER) {
    return null;
  }

  const chain = headers.get(VIEWER_CHAIN_HEADER);
  if (
    chain === null ||
    chain.length === 0 ||
    Buffer.byteLength(chain, "utf8") > MAX_VIEWER_CHAIN_BYTES
  ) {
    return null;
  }
  const elements = chain.split(",").map((element) => element.trim());
  if (
    elements.length === 0 ||
    elements.length > MAX_VIEWER_CHAIN_ELEMENTS ||
    elements.some((element) => element.length === 0 || isIP(element) === 0)
  ) {
    return null;
  }

  const address = elements.at(-1);
  if (address === undefined) {
    return null;
  }
  const version = isIP(address);
  if (version === 4) {
    const bytes = parseIpv4Bytes(address);
    if (bytes === null) {
      return null;
    }
    return {
      allowlistAddress: [...bytes].join("."),
      scopeBytes: Buffer.concat([Buffer.from([4, 32]), bytes]),
    };
  }
  if (version === 6) {
    const bytes = parseIpv6Bytes(address);
    if (bytes === null) {
      return null;
    }
    return {
      allowlistAddress: null,
      scopeBytes: Buffer.concat([Buffer.from([6, 64]), bytes.subarray(0, 8)]),
    };
  }
  return null;
}

function isEdgeAdmissionClass(value: string): value is EdgeAdmissionClass {
  return value === "account_webhook" || value === "audit_download" || value === "signed_api";
}

export class MemoryEdgeAdmissionGate implements EdgeAdmissionGate {
  readonly #clockMs: () => number;
  readonly #concurrency: Record<EdgeAdmissionClass, number> = {
    account_webhook: 0,
    audit_download: 0,
    signed_api: 0,
  };
  readonly #globalBuckets: Record<EdgeAdmissionClass, GcraBucket> = {
    account_webhook: { tatMs: 0 },
    audit_download: { tatMs: 0 },
    signed_api: { tatMs: 0 },
  };
  readonly #overflowBuckets: Record<EdgeAdmissionClass, GcraBucket> = {
    account_webhook: { tatMs: 0 },
    audit_download: { tatMs: 0 },
    signed_api: { tatMs: 0 },
  };
  readonly #key: Buffer;
  readonly #policies: Readonly<Record<EdgeAdmissionClass, EdgeAdmissionClassPolicy>>;
  readonly #requireTrustedEdge: boolean;
  readonly #sources: Record<EdgeAdmissionClass, Map<string, SourceState>> = {
    account_webhook: new Map(),
    audit_download: new Map(),
    signed_api: new Map(),
  };
  #lastClockMs = 0;
  readonly #lastSweepMs: Record<EdgeAdmissionClass, number> = {
    account_webhook: Number.NEGATIVE_INFINITY,
    audit_download: Number.NEGATIVE_INFINITY,
    signed_api: Number.NEGATIVE_INFINITY,
  };

  constructor(options: MemoryEdgeAdmissionGateOptions) {
    if (process.env.NODE_ENV === "production" && !options.requireTrustedEdge) {
      throw new Error("Production edge admission requires the trusted CloudFront contract");
    }
    const key = Buffer.from(options.key ?? randomBytes(32));
    if (key.byteLength < 32) {
      throw new Error("The edge admission HMAC key must contain at least 32 bytes");
    }

    this.#clockMs = options.clockMs ?? Date.now;
    this.#key = key;
    this.#policies = {
      account_webhook: mergePolicy("account_webhook", options.policies?.account_webhook),
      audit_download: mergePolicy("audit_download", options.policies?.audit_download),
      signed_api: mergePolicy("signed_api", options.policies?.signed_api),
    };
    this.#requireTrustedEdge = options.requireTrustedEdge;
  }

  acquire(headers: Headers, requestClass: EdgeAdmissionClass): EdgeAdmissionDecision {
    try {
      return this.#acquire(headers, requestClass);
    } catch {
      return denied(EdgeAdmissionDeniedReason.InternalFailure, 503);
    }
  }

  #acquire(headers: Headers, requestClass: EdgeAdmissionClass): EdgeAdmissionDecision {
    if (!isEdgeAdmissionClass(requestClass)) {
      return denied(EdgeAdmissionDeniedReason.PolicyUnavailable, 503);
    }
    if (this.#requireTrustedEdge && headers.has(ORIGIN_TOKEN_HEADER)) {
      return denied(EdgeAdmissionDeniedReason.OriginTokenForwarded, 503);
    }
    if (this.#requireTrustedEdge && headers.get(EDGE_MARKER_HEADER) !== TRUSTED_EDGE_MARKER) {
      return denied(EdgeAdmissionDeniedReason.EdgeNotTrusted, 503);
    }

    const source = parseSource(headers, this.#requireTrustedEdge);
    if (source === null) {
      return denied(EdgeAdmissionDeniedReason.SourceInvalid, 503);
    }
    if (
      requestClass === "account_webhook" &&
      this.#requireTrustedEdge &&
      (source.allowlistAddress === null ||
        !STRIPE_WEBHOOK_IPV4_ALLOWLIST.has(source.allowlistAddress))
    ) {
      return denied(EdgeAdmissionDeniedReason.WebhookSourceForbidden, 403);
    }

    const nowMs = this.#now();
    if (nowMs === null) {
      return denied(EdgeAdmissionDeniedReason.ClockUnavailable, 503);
    }
    this.#sweep(requestClass, nowMs);

    const policy = this.#policies[requestClass];
    const sources = this.#sources[requestClass];
    const sourceKey = this.#sourceKey(requestClass, source.scopeBytes);
    let sourceState = sources.get(sourceKey);
    const isNewSource = sourceState === undefined;
    if (sourceState === undefined) {
      if (sources.size >= EDGE_SOURCE_SCOPE_CAPACITIES[requestClass]) {
        const overflowBucket = this.#overflowBuckets[requestClass];
        const overflowPreview = previewGcra(overflowBucket, policy.global, nowMs);
        if (overflowPreview.allowed) {
          overflowBucket.tatMs = overflowPreview.nextTatMs;
        }
        return denied(
          EdgeAdmissionDeniedReason.SourceCapacityExceeded,
          429,
          Math.max(
            this.#capacityRetryAfterSeconds(requestClass, nowMs),
            overflowPreview.allowed ? 1 : overflowPreview.retryAfterSeconds,
          ),
        );
      }
      sourceState = { activeLeases: 0, bucket: { tatMs: 0 }, lastSeenMs: nowMs };
    }

    const sourcePreview = previewGcra(sourceState.bucket, policy.source, nowMs);
    if (!sourcePreview.allowed) {
      return denied(
        EdgeAdmissionDeniedReason.SourceRateLimited,
        429,
        sourcePreview.retryAfterSeconds,
      );
    }
    if (!isNewSource) {
      // Charge an already tracked source before shared capacity so one noisy peer cannot capture
      // every global refill. An unseen source remains provisional until full admission so rejected
      // address churn cannot fill the bounded map.
      sourceState.bucket.tatMs = sourcePreview.nextTatMs;
    }

    const globalBucket = this.#globalBuckets[requestClass];
    const globalPreview = previewGcra(globalBucket, policy.global, nowMs);
    if (!globalPreview.allowed) {
      return denied(
        EdgeAdmissionDeniedReason.GlobalRateLimited,
        429,
        globalPreview.retryAfterSeconds,
      );
    }

    if (this.#concurrency[requestClass] >= policy.concurrency) {
      return denied(EdgeAdmissionDeniedReason.ConcurrencyLimited, 429, 1);
    }

    if (isNewSource) {
      sourceState.bucket.tatMs = sourcePreview.nextTatMs;
      sources.set(sourceKey, sourceState);
    }
    sourceState.lastSeenMs = nowMs;
    globalBucket.tatMs = globalPreview.nextTatMs;
    sourceState.activeLeases += 1;
    this.#concurrency[requestClass] += 1;

    let released = false;
    return {
      allowed: true,
      lease: {
        release: () => {
          if (released) {
            return;
          }
          released = true;
          sourceState.activeLeases = Math.max(0, sourceState.activeLeases - 1);
          this.#concurrency[requestClass] = Math.max(0, this.#concurrency[requestClass] - 1);
        },
      },
    };
  }

  #capacityRetryAfterSeconds(requestClass: EdgeAdmissionClass, nowMs: number): number {
    const nextSweepMs = this.#lastSweepMs[requestClass] + SWEEP_INTERVAL_MS;
    if (!Number.isFinite(nextSweepMs)) {
      return 1;
    }
    return Math.max(1, Math.ceil((nextSweepMs - nowMs) / 1_000));
  }

  #now(): number | null {
    const observed = this.#clockMs();
    if (!Number.isFinite(observed) || observed < 0) {
      return null;
    }
    this.#lastClockMs = Math.max(this.#lastClockMs, Math.trunc(observed));
    return this.#lastClockMs;
  }

  #sourceKey(requestClass: EdgeAdmissionClass, scopeBytes: Buffer): string {
    return createHmac("sha256", this.#key)
      .update("refunddesk-edge-source-v1\0", "utf8")
      .update(requestClass, "utf8")
      .update("\0", "utf8")
      .update(scopeBytes)
      .digest("base64url");
  }

  #sweep(requestClass: EdgeAdmissionClass, nowMs: number): void {
    if (nowMs - this.#lastSweepMs[requestClass] < SWEEP_INTERVAL_MS) {
      return;
    }
    for (const [sourceKey, source] of this.#sources[requestClass]) {
      if (
        source.activeLeases === 0 &&
        nowMs - source.lastSeenMs >= SOURCE_IDLE_MS &&
        source.bucket.tatMs <= nowMs
      ) {
        this.#sources[requestClass].delete(sourceKey);
      }
    }
    this.#lastSweepMs[requestClass] = nowMs;
  }
}

let runtimeGate: EdgeAdmissionGate | undefined;

export function getEdgeAdmissionGate(): EdgeAdmissionGate {
  runtimeGate ??= new MemoryEdgeAdmissionGate({
    requireTrustedEdge: process.env.NODE_ENV === "production",
  });
  return runtimeGate;
}
