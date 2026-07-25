import type { RefundDeskConfig } from "@refunddesk/config";
import { RefundProofKeyring } from "@refunddesk/domain";
import { createLogger } from "@refunddesk/observability";
import { ConnectedAccountStripeClient, StripeCredentialResolver } from "@refunddesk/stripe-adapter";

import type { Clock, WorkerLogger, WorkerStore } from "./ports.js";

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface WorkerDependencies {
  readonly store: WorkerStore;
  readonly stripe: ConnectedAccountStripeClient;
  readonly proofs: RefundProofKeyring;
  readonly clock: Clock;
  readonly logger: WorkerLogger;
}

export function createWorkerDependencies(
  config: RefundDeskConfig,
  store: WorkerStore,
): WorkerDependencies {
  return {
    store,
    stripe: new ConnectedAccountStripeClient(
      new StripeCredentialResolver({
        platformTestKey: config.stripe.platformTestKey,
        managedSandboxKey: config.stripe.managedSandboxKey,
      }),
    ),
    proofs: new RefundProofKeyring({
      active: {
        version: config.keys.activeProofVersion,
        key: config.keys.proofV1,
      },
    }),
    clock: systemClock,
    logger: createLogger("refunddesk-worker", config.logLevel),
  };
}
