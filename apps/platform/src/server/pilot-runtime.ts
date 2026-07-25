import { loadConfig } from "@refunddesk/config";
import { createPrismaClient, type PrismaClient } from "@refunddesk/db";
import { FieldEncryptionKeyring } from "@refunddesk/domain";
import { ConnectedAccountStripeClient, StripeCredentialResolver } from "@refunddesk/stripe-adapter";

import { TestAndSandboxAccessPolicy } from "./pilot-access-policy";
import { ConnectedStripePaymentReader } from "./pilot-payment-reader";
import { PilotPrismaRepository } from "./pilot-prisma-repository";
import { PilotService } from "./pilot-service";

export interface PilotRuntime {
  readonly auditSigningKey: Uint8Array;
  readonly client: PrismaClient;
  readonly service: PilotService;
  readonly signingSecret: string;
}

let runtimeInstance: PilotRuntime | undefined;

export function getPilotRuntime(): PilotRuntime {
  if (runtimeInstance !== undefined) {
    return runtimeInstance;
  }
  const config = loadConfig();
  const client = createPrismaClient({
    connectionString: config.databaseUrl,
  });
  const fieldKeyring = new FieldEncryptionKeyring({
    active: {
      key: config.keys.fieldV1,
      version: config.keys.activeFieldVersion,
    },
  });
  const repository = new PilotPrismaRepository({
    appBaseUrl: config.appBaseUrl,
    auditSigningKey: config.keys.exportV1,
    client,
    fieldKeyring,
  });
  const stripeClient = new ConnectedAccountStripeClient(
    new StripeCredentialResolver({
      managedSandboxKey: config.stripe.managedSandboxKey,
      platformTestKey: config.stripe.platformTestKey,
    }),
  );
  runtimeInstance = {
    auditSigningKey: config.keys.exportV1,
    client,
    service: new PilotService(
      repository,
      new ConnectedStripePaymentReader(stripeClient),
      new TestAndSandboxAccessPolicy(),
    ),
    signingSecret: config.stripe.appSigningSecret,
  };
  return runtimeInstance;
}
