import { defineConfig } from "prisma/config";

const databaseUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgresql://offline:offline@127.0.0.1:1/refunddesk";

export default defineConfig({
  schema: "../../packages/db/prisma/schema.prisma",
  migrations: {
    path: "../../packages/db/prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
