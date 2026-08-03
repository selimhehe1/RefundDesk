import { describe, expect, it, vi } from "vitest";

import type { Notification } from "../src/index.js";
import {
  shouldNotifyPendingApprovals,
  WebhookNotificationProvider,
  type PinnedRequest,
} from "../src/webhook-provider.js";

const notification: Notification = {
  kind: "approval_requested",
  tenantId: "6f2f1f27-0f4a-4a1d-9d4c-0b4c9b0a1d2e",
  recipientUserIds: ["usr_Approver"],
};

function providerWith({
  destination = "https://hooks.example.com/services/abc",
  addresses = ["93.184.216.34"],
  fetcher = vi.fn(() => Promise.resolve(new Response("", { status: 200 }))),
  resolveAddresses = vi.fn(() => Promise.resolve(addresses)),
}: {
  destination?: string | null;
  addresses?: readonly string[];
  fetcher?: ReturnType<typeof vi.fn>;
  resolveAddresses?: ReturnType<typeof vi.fn>;
} = {}) {
  const provider = new WebhookNotificationProvider({
    destinationLookup: () => Promise.resolve(destination),
    resolveAddresses: resolveAddresses as never,
    fetcher: fetcher as never,
    now: () => new Date("2026-08-03T12:00:00Z"),
  });
  return { provider, fetcher, resolveAddresses };
}

describe("shouldNotifyPendingApprovals", () => {
  it("speaks up when work appears and when it grows", () => {
    expect(shouldNotifyPendingApprovals({ pendingCount: 1, lastNotifiedCount: null })).toBe(true);
    expect(shouldNotifyPendingApprovals({ pendingCount: 3, lastNotifiedCount: 1 })).toBe(true);
  });

  it("stays quiet when nothing waits, or when nothing new arrived", () => {
    expect(shouldNotifyPendingApprovals({ pendingCount: 0, lastNotifiedCount: null })).toBe(false);
    expect(shouldNotifyPendingApprovals({ pendingCount: 0, lastNotifiedCount: 4 })).toBe(false);
    expect(shouldNotifyPendingApprovals({ pendingCount: 2, lastNotifiedCount: 2 })).toBe(false);
    // Decreasing means somebody is working through the queue; do not nag.
    expect(shouldNotifyPendingApprovals({ pendingCount: 1, lastNotifiedCount: 5 })).toBe(false);
  });

  it("cannot be made to fire on a negative or absurd count", () => {
    expect(shouldNotifyPendingApprovals({ pendingCount: -1, lastNotifiedCount: null })).toBe(false);
    expect(
      shouldNotifyPendingApprovals({ pendingCount: Number.NaN, lastNotifiedCount: null }),
    ).toBe(false);
  });
});

describe("WebhookNotificationProvider", () => {
  it("delivers a signal that carries no financial or personal detail", async () => {
    const { provider, fetcher } = providerWith();

    await expect(provider.deliver(notification)).resolves.toEqual({ status: "delivered" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [request] = fetcher.mock.calls[0] as [PinnedRequest];
    const { url, init } = request;
    expect(url).toBe("https://hooks.example.com/services/abc");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");

    expect(typeof init.body).toBe("string");
    const serialized = init.body as string;
    const body = JSON.parse(serialized) as Record<string, unknown>;
    // The exact key set matters: an added field is how detail would start leaking.
    expect(Object.keys(body).sort()).toEqual(["occurred_at", "text", "type"]);
    expect(body["type"]).toBe("refunddesk.approval_requested");
    expect(body["occurred_at"]).toBe("2026-08-03T12:00:00.000Z");
    expect(String(body["text"])).toContain("needs attention");
    // Nothing that identifies a person, a payment or an amount may travel.
    expect(serialized).not.toContain(notification.tenantId);
    expect(serialized).not.toContain("usr_Approver");
  });

  it("hands the fetcher the checked addresses and a lookup that answers with them", async () => {
    // Without this the request would be issued against the URL alone, and the HTTP stack would
    // resolve the name a second time — reopening the window the send-time check just closed.
    const addresses = ["93.184.216.34", "2606:2800:220:1::1"];
    const { provider, fetcher } = providerWith({ addresses });

    await provider.deliver(notification);

    const [request] = fetcher.mock.calls[0] as [PinnedRequest];
    expect(request.addresses).toEqual(addresses);

    const answered = vi.fn();
    request.lookup("rebound.example", { all: true }, answered);
    expect(answered).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  it("does nothing when the merchant configured no destination", async () => {
    const { provider, fetcher } = providerWith({ destination: null });
    await expect(provider.deliver(notification)).resolves.toEqual({
      status: "skipped",
      reason: "no_destination",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never requests a destination that fails the policy", async () => {
    for (const destination of [
      "http://hooks.example.com/x",
      "https://127.0.0.1/x",
      "https://hooks.example.com:8443/x",
      "https://user:pass@hooks.example.com/x",
    ]) {
      const { provider, fetcher, resolveAddresses } = providerWith({ destination });
      await expect(provider.deliver(notification)).resolves.toEqual({
        status: "dropped",
        reason: "rejected_destination",
      });
      expect(resolveAddresses).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("refuses a public name that resolves to an internal address", async () => {
    // DNS rebinding: the destination passed the saved-time policy, the answer did not.
    const { provider, fetcher } = providerWith({ addresses: ["169.254.169.254"] });
    await expect(provider.deliver(notification)).resolves.toEqual({
      status: "dropped",
      reason: "blocked_address",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses when any single answer is internal, not only when all are", async () => {
    const { provider, fetcher } = providerWith({ addresses: ["93.184.216.34", "10.0.0.7"] });
    await expect(provider.deliver(notification)).resolves.toEqual({
      status: "dropped",
      reason: "blocked_address",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to nothing", async () => {
    const { provider, fetcher } = providerWith({ addresses: [] });
    await expect(provider.deliver(notification)).resolves.toEqual({
      status: "dropped",
      reason: "blocked_address",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a refusal without interpreting the response body", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("go away", { status: 403 })));
    const { provider } = providerWith({ fetcher });
    await expect(provider.deliver(notification)).resolves.toEqual({
      status: "dropped",
      reason: "refused",
    });
  });

  it("swallows a transport failure so a workflow is never affected", async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error("socket hang up")));
    const { provider } = providerWith({ fetcher });
    await expect(provider.deliver(notification)).resolves.toEqual({
      status: "dropped",
      reason: "unreachable",
    });
  });

  it("treats a resolver failure as undeliverable rather than throwing", async () => {
    const resolveAddresses = vi.fn(() => Promise.reject(new Error("ENOTFOUND")));
    const { provider } = providerWith({ resolveAddresses });
    await expect(provider.deliver(notification)).resolves.toEqual({
      status: "dropped",
      reason: "unreachable",
    });
  });

  it("send() reports the outcome and never rejects", async () => {
    const outcomes: unknown[] = [];
    const provider = new WebhookNotificationProvider({
      destinationLookup: () => Promise.resolve("https://hooks.example.com/x"),
      resolveAddresses: () => Promise.reject(new Error("ENOTFOUND")),
      fetcher: () => Promise.resolve(new Response("", { status: 200 })),
      onOutcome: (_, outcome) => outcomes.push(outcome),
    });

    await expect(provider.send(notification)).resolves.toBeUndefined();
    expect(outcomes).toEqual([{ status: "dropped", reason: "unreachable" }]);
  });
});
