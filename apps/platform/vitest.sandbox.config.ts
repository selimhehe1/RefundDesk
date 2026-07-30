import { defineConfig } from "vitest/config";

import { workspaceAliases } from "./vitest.config";

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    environment: "node",
    include: ["test/sandbox/**/*.test.ts"],
    hookTimeout: 360_000,
    teardownTimeout: 60_000,
    testTimeout: 360_000,
  },
});
