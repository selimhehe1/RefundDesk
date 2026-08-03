import { loadPlatformConfig } from "@refunddesk/config";
import { createPrismaClient, type PrismaClient } from "@refunddesk/db";
import { createLogger } from "@refunddesk/observability";
import { DirectAccountStripeClient, StripeCredentialResolver } from "@refunddesk/stripe-adapter";

import { getEdgeAdmissionGate, type EdgeAdmissionGate } from "./edge-admission";
import { createFieldEncryptionKeyring } from "./field-keyring";
import { PostgresSignedRequestRateLimiter } from "./mutation-rate-limit";
import type { PilotOperationalSignal } from "./pilot-http";
import { TestAndSandboxAccessPolicy } from "./pilot-access-policy";
import { ConfiguredAccountAdmission } from "./pilot-account-admission";
import { DirectStripePaymentReader } from "./pilot-payment-reader";
import { PilotPrismaRepository } from "./pilot-prisma-repository";
import { PilotService } from "./pilot-service";
import { SampledSignalEmitter } from "./sampled-signal-emitter";
import { RemoteSignedRequestVerifier, type SignedRequestVerifier } from "./signed-request";

export interface PilotRuntime {
  readonly auditSigningKey: Uint8Array;
  readonly client: PrismaClient;
  readonly edgeAdmissionGate: EdgeAdmissionGate;
  readonly emitOperationalSignal: (signal: PilotOperationalSignal) => void;
  readonly signedRequestRateLimiter: PostgresSignedRequestRateLimiter;
  readonly service: PilotService;
  readonly signedRequestVerifier: SignedRequestVerifier;
}

let runtimeInstance: PilotRuntime | undefined;
const logger = createLogger("platform");
const operationalSignalEmitter = new SampledSignalEmitter<PilotOperationalSignal>({
  emit({ observedCount, signal, suppressedCount }) {
    logger.warn(
      {
        event: signal,
        observed_count: observedCount,
        suppressed_count: suppressedCount,
      },
      "Platform operational signal",
    );
  },
});

export function getPilotRuntime(): PilotRuntime {
  if (runtimeInstance !== undefined) {
    return runtimeInstance;
  }
  const config = loadPlatformConfig();
  const client = createPrismaClient({
    connectionString: config.databaseUrl,
  });
  const fieldKeyring = createFieldEncryptionKeyring(config.keys);
  const repository = new PilotPrismaRepository({
    appBaseUrl: config.appBaseUrl,
    auditSigningKey: config.keys.exportV1,
    client,
    fieldKeyring,
  });
  const stripeClient = new DirectAccountStripeClient(
    new StripeCredentialResolver({
      platformTest: {
        apiKey: config.stripe.platformTestReadKey,
        expectedAccountId: config.stripe.platformTestAccountId,
      },
      managedSandbox: {
        apiKey: config.stripe.managedSandboxReadKey,
        expectedAccountId: config.stripe.managedSandboxAccountId,
      },
    }),
  );
  runtimeInstance = {
    auditSigningKey: config.keys.exportV1,
    client,
    edgeAdmissionGate: getEdgeAdmissionGate(),
    emitOperationalSignal(signal) {
      operationalSignalEmitter.emit(signal);
    },
    service: new PilotService(
      repository,
      new DirectStripePaymentReader(stripeClient),
      new TestAndSandboxAccessPolicy(),
      new ConfiguredAccountAdmission([
        { accountId: config.stripe.platformTestAccountId, environment: "test" },
        { accountId: config.stripe.managedSandboxAccountId, environment: "sandbox" },
      ]),
    ),
    signedRequestRateLimiter: new PostgresSignedRequestRateLimiter(client),
    signedRequestVerifier: new RemoteSignedRequestVerifier(
      config.signedRequestVerifierUrl,
      config.signedRequestVerifierToken,
    ),
  };
  return runtimeInstance;
}
