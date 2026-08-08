import { defineConfig } from "vitest/config";

if ((process.env["REFUNDDESK_TEST_DATABASE_URL"] ?? "").trim().length === 0) {
  throw new Error(
    "REFUNDDESK_TEST_DATABASE_URL is required for PostgreSQL integration tests; skipped tests are not a passing gate.",
  );
}

export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    setupFiles: ["./test/throw-deprecations.integration-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
