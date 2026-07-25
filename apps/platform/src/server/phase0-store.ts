import { timingSafeEqual } from "node:crypto";

export type Phase0Correlation =
  "internal" | "pending_correlation" | "outside_workflow" | "invalid_proof" | "proof_replay";

export interface Phase0Probe {
  readonly requestNonce: string;
  readonly accountId: string;
  readonly actorUserId: string;
  readonly environment: "test" | "sandbox";
  readonly targetType: "payment_intent";
  readonly targetId: string;
  readonly paymentKey: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly reason: "duplicate" | "fraudulent" | "requested_by_customer";
  readonly idempotencyKey: string;
  readonly proof: string;
  firstRefundId: string | null;
  readonly candidateRefundIds: Set<string>;
}

export type Phase0ProbeIdentity = Pick<
  Phase0Probe,
  | "accountId"
  | "actorUserId"
  | "amountMinor"
  | "currency"
  | "environment"
  | "idempotencyKey"
  | "reason"
  | "requestNonce"
  | "targetId"
  | "targetType"
>;

export interface Phase0ObservedRefund {
  readonly eventId: string;
  readonly refundId: string;
  readonly accountId: string;
  readonly environment: "test" | "sandbox";
  readonly paymentKey: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly requestNonce: string | null;
  readonly proof: string | null;
  readonly eventIdempotencyKey: string | null;
}

interface Phase0Evidence {
  readonly observedAt: string;
  readonly refundId: string;
  readonly correlation: Phase0Correlation;
  readonly requestNonce: string | null;
  readonly accountId: string;
  readonly environment: Phase0Probe["environment"];
}

export class Phase0NonceConflictError extends Error {
  constructor() {
    super("A phase-0 nonce was reused with different probe data");
    this.name = "Phase0NonceConflictError";
  }
}

function equalText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function probeKey(
  accountId: string,
  environment: Phase0Probe["environment"],
  requestNonce: string,
): string {
  return `${environment}\0${accountId}\0${requestNonce}`;
}

export class Phase0Store {
  private readonly probes = new Map<string, Phase0Probe>();
  private readonly evidence: Phase0Evidence[] = [];
  private readonly observedEvents = new Map<string, Phase0Correlation>();

  resolve(identity: Phase0ProbeIdentity): Phase0Probe | null {
    const existing = this.probes.get(
      probeKey(identity.accountId, identity.environment, identity.requestNonce),
    );
    if (existing === undefined) {
      return null;
    }
    if (
      existing.accountId !== identity.accountId ||
      existing.actorUserId !== identity.actorUserId ||
      existing.environment !== identity.environment ||
      existing.targetType !== identity.targetType ||
      existing.targetId !== identity.targetId ||
      existing.amountMinor !== identity.amountMinor ||
      existing.currency !== identity.currency ||
      existing.reason !== identity.reason ||
      existing.idempotencyKey !== identity.idempotencyKey
    ) {
      throw new Phase0NonceConflictError();
    }
    return existing;
  }

  register(probe: Phase0Probe): Phase0Probe {
    const key = probeKey(probe.accountId, probe.environment, probe.requestNonce);
    const existing = this.resolve(probe);
    if (existing !== null) {
      if (existing.paymentKey !== probe.paymentKey || !equalText(existing.proof, probe.proof)) {
        throw new Phase0NonceConflictError();
      }
      return existing;
    }
    this.probes.set(key, probe);
    return probe;
  }

  bindApiResponse(
    accountId: string,
    environment: Phase0Probe["environment"],
    requestNonce: string,
    refundId: string,
  ): Phase0Correlation {
    const probe = this.probes.get(probeKey(accountId, environment, requestNonce));
    if (probe === undefined) {
      return "outside_workflow";
    }
    if (probe.firstRefundId === null) {
      probe.firstRefundId = refundId;
      this.evidence.push({
        observedAt: new Date().toISOString(),
        refundId,
        correlation: "internal",
        requestNonce,
        accountId,
        environment,
      });
      for (const candidateRefundId of probe.candidateRefundIds) {
        if (candidateRefundId !== refundId) {
          this.evidence.push({
            observedAt: new Date().toISOString(),
            refundId: candidateRefundId,
            correlation: "proof_replay",
            requestNonce,
            accountId,
            environment,
          });
        }
      }
      return "internal";
    }
    return probe.firstRefundId === refundId ? "internal" : "proof_replay";
  }

  observe(refund: Phase0ObservedRefund): Phase0Correlation {
    const observedCorrelation = this.observedEvents.get(refund.eventId);
    if (observedCorrelation !== undefined) {
      return observedCorrelation;
    }

    const probe =
      refund.requestNonce === null
        ? undefined
        : this.probes.get(probeKey(refund.accountId, refund.environment, refund.requestNonce));
    let correlation: Phase0Correlation;

    if (probe === undefined) {
      correlation = "outside_workflow";
    } else if (
      refund.proof === null ||
      !equalText(refund.proof, probe.proof) ||
      refund.accountId !== probe.accountId ||
      refund.environment !== probe.environment ||
      refund.paymentKey !== probe.paymentKey ||
      refund.amountMinor !== probe.amountMinor ||
      refund.currency !== probe.currency
    ) {
      correlation = "invalid_proof";
    } else if (probe.firstRefundId !== null) {
      correlation = probe.firstRefundId === refund.refundId ? "internal" : "proof_replay";
    } else if (
      refund.eventIdempotencyKey !== null &&
      equalText(refund.eventIdempotencyKey, probe.idempotencyKey)
    ) {
      probe.firstRefundId = refund.refundId;
      correlation = "internal";
    } else {
      probe.candidateRefundIds.add(refund.refundId);
      correlation = "pending_correlation";
    }

    this.evidence.push({
      observedAt: new Date().toISOString(),
      refundId: refund.refundId,
      correlation,
      requestNonce: refund.requestNonce,
      accountId: refund.accountId,
      environment: refund.environment,
    });
    this.observedEvents.set(refund.eventId, correlation);
    return correlation;
  }

  report(
    accountId?: string,
    environment?: Phase0Probe["environment"],
  ): Readonly<{ probes: number; evidence: readonly Phase0Evidence[] }> {
    const inScope = (value: {
      readonly accountId: string;
      readonly environment: Phase0Probe["environment"];
    }): boolean =>
      (accountId === undefined || value.accountId === accountId) &&
      (environment === undefined || value.environment === environment);
    return {
      probes: [...this.probes.values()].filter(inScope).length,
      evidence: this.evidence.filter(inScope).map((item) => ({ ...item })),
    };
  }
}

const phase0Global = globalThis as typeof globalThis & {
  __refundDeskPhase0Store?: Phase0Store;
};

export const phase0Store = (phase0Global.__refundDeskPhase0Store ??= new Phase0Store());
