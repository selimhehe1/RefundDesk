import { loadWorkerConfig } from "@refunddesk/config";

import { loadWorkerStore } from "./database-bridge.js";
import { createWorkerDependencies } from "./dependencies.js";
import { startWorkerHealthServer, type RunningWorkerHealthServer } from "./health-server.js";
import { startPgBossWorker, type RunningWorker } from "./pg-boss-runtime.js";
import { assertPilotConfiguration } from "./safety.js";
import { StripeSignedRequestAuthority } from "./signed-request-authority.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  assertPilotConfiguration(config);
  const store = await loadWorkerStore(config);
  const dependencies = createWorkerDependencies(config, store);
  const signedRequestAuthority = new StripeSignedRequestAuthority(
    [config.stripe.appSigningSecret, config.stripe.appSigningSecretPrevious].filter(
      (secret): secret is string => secret !== undefined,
    ),
    store,
  );
  let worker: RunningWorker;
  try {
    worker = await startPgBossWorker(config, dependencies);
  } catch (error) {
    await store.close?.().catch(() => undefined);
    throw error;
  }

  let healthServer: RunningWorkerHealthServer;
  try {
    healthServer = await startWorkerHealthServer({
      host: config.health.host,
      port: config.health.port,
      readiness: worker.readiness,
      signedRequestAuthority,
      signedRequestVerifierToken: config.signedRequestVerifierToken,
    });
  } catch (error) {
    await worker.stop().catch(() => undefined);
    await store.close?.().catch(() => undefined);
    throw error;
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      await worker.stop();
    } finally {
      try {
        await healthServer.close();
      } finally {
        await store.close?.();
      }
    }
  };

  process.once("SIGINT", () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
}

main().catch(() => {
  process.exitCode = 1;
});
