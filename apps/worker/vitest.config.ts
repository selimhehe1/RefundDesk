import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function workspaceSource(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@refunddesk/config": workspaceSource("../../packages/config/src/index.ts"),
      "@refunddesk/contracts": workspaceSource("../../packages/contracts/src/index.ts"),
      "@refunddesk/db": workspaceSource("../../packages/db/src/index.ts"),
      "@refunddesk/domain": workspaceSource("../../packages/domain/src/index.ts"),
      "@refunddesk/observability": workspaceSource("../../packages/observability/src/index.ts"),
      "@refunddesk/stripe-adapter": workspaceSource("../../packages/stripe-adapter/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
