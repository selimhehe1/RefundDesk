import { describe, expect, it } from "vitest";

import { NoopNotificationProvider } from "../src/index.js";

describe("NoopNotificationProvider", () => {
  it("does not perform an external effect", async () => {
    const provider = new NoopNotificationProvider();
    await expect(
      provider.send({
        kind: "approval_requested",
        tenantId: "tenant-1",
        recipientUserIds: ["user-2"],
      }),
    ).resolves.toBeUndefined();
    expect(Object.keys(provider)).toHaveLength(0);
  });
});
