import { loadConfig } from "@refunddesk/config";

import { loadWorkerStore } from "./database-bridge.js";
import { createWorkerDependencies } from "./dependencies.js";
import { startPgBossWorker } from "./pg-boss-runtime.js";
import { assertPilotConfiguration } from "./safety.js";

async function main(): Promise<void> {
  const config = loadConfig();
  assertPilotConfiguration(config);
  const store = await loadWorkerStore(config);
  const dependencies = createWorkerDependencies(config, store);
  const worker = await startPgBossWorker(config, dependencies);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await worker.stop();
    await store.close?.();
  };

  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

main().catch(() => {
  process.exitCode = 1;
});
