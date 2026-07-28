import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export interface DatabaseClientOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMilliseconds?: number;
}

export function createPrismaClient(options: DatabaseClientOptions): PrismaClient {
  let protocol: string;
  try {
    protocol = new URL(options.connectionString).protocol;
  } catch {
    throw new TypeError("A direct PostgreSQL connection string is required");
  }
  if (protocol !== "postgresql:" && protocol !== "postgres:") {
    throw new TypeError("A direct PostgreSQL connection string is required");
  }
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMilliseconds ?? 5_000,
    // @prisma/adapter-pg currently receives PostgreSQL temporal values through
    // the session representation. Force UTC so a database configured with a
    // regional timezone cannot shift TIMESTAMPTZ values during deserialization.
    options: "-c timezone=UTC -c search_path=pg_catalog,public",
  });
  return new PrismaClient({ adapter });
}
