import type { WorkerConfig } from "@refunddesk/config";
import { createPrismaClient } from "@refunddesk/db";

import {
  createApprovalAttestationKeyring,
  createRefundProofKeyring,
} from "./application-keyrings.js";
import { PrismaWorkerStore } from "./db-store.js";
import type { WorkerStore } from "./ports.js";

/**
 * The worker runtime uses its dedicated, non-owner connection string. Tenant
 * transactions and global worker-only listing functions remain inside
 * @refunddesk/db.
 */
export function loadWorkerStore(config: WorkerConfig): Promise<WorkerStore> {
  const client = createPrismaClient({
    connectionString: config.workerDatabaseUrl,
  });
  return Promise.resolve(
    new PrismaWorkerStore(
      client,
      createRefundProofKeyring(config.keys),
      createApprovalAttestationKeyring(config.keys),
    ),
  );
}
