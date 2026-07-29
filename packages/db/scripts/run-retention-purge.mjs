import { Client } from "pg";

import {
  loadRetentionPurgeConfig,
  runRetentionPurge,
  safeRetentionErrorCode,
} from "./retention-purge.mjs";

let client;
let pseudonymKey;

try {
  const config = loadRetentionPurgeConfig();
  pseudonymKey = config.pseudonymKey;
  client = new Client({
    connectionString: config.databaseUrl,
    application_name: "refunddesk-retention-purge",
    options: "-c search_path=pg_catalog",
  });
  await client.connect();
  const result = await runRetentionPurge(client, config);
  process.stdout.write(
    `${JSON.stringify({
      component: "retention-purge",
      status: "completed",
      batches: result.batches,
      selected: result.selected,
      purged: result.purged,
      blocked_after_selection: result.blockedAfterSelection,
      blocked_by_reason: result.blockedByReason,
      oldest_overdue_seconds: result.oldestOverdueSeconds,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      component: "retention-purge",
      code: safeRetentionErrorCode(error),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  if (pseudonymKey !== undefined) {
    pseudonymKey.fill(0);
  }
  if (client !== undefined) {
    await client.end().catch(() => undefined);
  }
}
