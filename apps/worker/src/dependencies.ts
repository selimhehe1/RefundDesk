import type { WorkerConfig } from "@refunddesk/config";
import { RefundProofKeyring } from "@refunddesk/domain";
import { createLogger } from "@refunddesk/observability";
import { DirectAccountStripeClient, StripeCredentialResolver } from "@refunddesk/stripe-adapter";

import type { Clock, WorkerLogger, WorkerStore } from "./ports.js";

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface WorkerDependencies {
  readonly store: WorkerStore;
  readonly stripe: DirectAccountStripeClient;
  readonly proofs: RefundProofKeyring;
  readonly clock: Clock;
  readonly logger: WorkerLogger;
}

export function createWorkerDependencies(
  config: WorkerConfig,
  store: WorkerStore,
): WorkerDependencies {
  return {
    store,
    stripe: new DirectAccountStripeClient(
      new StripeCredentialResolver({
        platformTest: {
          apiKey: config.stripe.platformTestEffectKey,
          expectedAccountId: config.stripe.platformTestAccountId,
        },
        managedSandbox: {
          apiKey: config.stripe.managedSandboxEffectKey,
          expectedAccountId: config.stripe.managedSandboxAccountId,
        },
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
