import { loadPlatformConfig } from "@refunddesk/config";
import { createPrismaClient, type PrismaClient } from "@refunddesk/db";
import { createLogger } from "@refunddesk/observability";
import { DirectAccountStripeClient, StripeCredentialResolver } from "@refunddesk/stripe-adapter";

import { createFieldEncryptionKeyring } from "./field-keyring";
import { PostgresSignedRequestRateLimiter } from "./mutation-rate-limit";
import type { PilotOperationalSignal } from "./pilot-http";
import { TestAndSandboxAccessPolicy } from "./pilot-access-policy";
import { DirectStripePaymentReader } from "./pilot-payment-reader";
import { PilotPrismaRepository } from "./pilot-prisma-repository";
import { PilotService } from "./pilot-service";
import { RemoteSignedRequestVerifier, type SignedRequestVerifier } from "./signed-request";

export interface PilotRuntime {
  readonly auditSigningKey: Uint8Array;
  readonly client: PrismaClient;
  readonly emitOperationalSignal: (signal: PilotOperationalSignal) => void;
  readonly signedRequestRateLimiter: PostgresSignedRequestRateLimiter;
  readonly service: PilotService;
  readonly signedRequestVerifier: SignedRequestVerifier;
}

let runtimeInstance: PilotRuntime | undefined;
const logger = createLogger("platform");

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
    emitOperationalSignal(signal) {
      logger.warn({ event: signal }, "Platform operational signal");
    },
    service: new PilotService(
      repository,
      new DirectStripePaymentReader(stripeClient),
      new TestAndSandboxAccessPolicy(),
    ),
    signedRequestRateLimiter: new PostgresSignedRequestRateLimiter(client),
    signedRequestVerifier: new RemoteSignedRequestVerifier(
      config.signedRequestVerifierUrl,
      config.signedRequestVerifierToken,
    ),
  };
  return runtimeInstance;
}
