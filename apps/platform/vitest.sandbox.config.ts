import { defineConfig } from "vitest/config";

import { workspaceAliases } from "./vitest.config";

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    environment: "node",
    include: ["test/sandbox/**/*.test.ts"],
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
    testTimeout: 180_000,
  },
});
