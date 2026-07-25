import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function workspacePackage(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@refunddesk/config": workspacePackage("../../packages/config/src/index.ts"),
      "@refunddesk/contracts": workspacePackage("../../packages/contracts/src/index.ts"),
      "@refunddesk/db": workspacePackage("../../packages/db/src/index.ts"),
      "@refunddesk/domain": workspacePackage("../../packages/domain/src/index.ts"),
      "@refunddesk/notifications": workspacePackage("../../packages/notifications/src/index.ts"),
      "@refunddesk/observability": workspacePackage("../../packages/observability/src/index.ts"),
      "@refunddesk/stripe-adapter": workspacePackage("../../packages/stripe-adapter/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
