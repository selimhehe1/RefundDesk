import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function workspacePackage(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export const workspaceAliases = {
  "@refunddesk/config": workspacePackage("../../packages/config/src/index.ts"),
  "@refunddesk/contracts": workspacePackage("../../packages/contracts/src/index.ts"),
  "@refunddesk/db": workspacePackage("../../packages/db/src/index.ts"),
  "@refunddesk/domain": workspacePackage("../../packages/domain/src/index.ts"),
  "@refunddesk/notifications": workspacePackage("../../packages/notifications/src/index.ts"),
  "@refunddesk/observability": workspacePackage("../../packages/observability/src/index.ts"),
  "@refunddesk/stripe-adapter": workspacePackage("../../packages/stripe-adapter/src/index.ts"),
} as const;

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    environment: "node",
    exclude: ["test/sandbox/**"],
    include: ["test/**/*.test.ts"],
  },
});
