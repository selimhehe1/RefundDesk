import { defineConfig } from "prisma/config";

const databaseUrl =
  process.env["DATABASE_MIGRATION_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgresql://offline:offline@127.0.0.1:1/refunddesk";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
