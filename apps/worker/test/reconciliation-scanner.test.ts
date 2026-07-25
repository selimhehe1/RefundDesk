import { describe, expect, it } from "vitest";

import { handleReconciliationScanJob } from "../src/reconciliation-scanner.js";
import type { ScannableWorkerInstallation } from "../src/ports.js";
import {
  FakeLogger,
  FakeStore,
  FakeStripe,
  INSTALLATION_ID,
  TENANT_ID,
  fixedClock,
  normalizedRefund,
} from "./helpers.js";

function installation(
  overrides: Partial<ScannableWorkerInstallation> = {},
): ScannableWorkerInstallation {
  return {
    tenantId: TENANT_ID,
    installationId: INSTALLATION_ID,
    stripeAccountId: "acct_scan",
    environment: "sandbox",
    active: true,
    tenantLiveEnabled: false,
    installedAt: new Date("2030-01-01T11:30:00.000Z"),
    ...overrides,
  };
}

describe("reconciliation scanner", () => {
  it("paginates with a one-hour overlap and commits only after every page", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    store.installations.push(installation());
    store.checkpoint = { windowEnd: new Date("2030-01-01T11:00:00.000Z") };
    stripe.pageHandler = (cursor) => {
      if (cursor === undefined) {
        return {
          refunds: [normalizedRefund({ id: "re_page_1" }), normalizedRefund({ id: "re_page_2" })],
          hasMore: true,
        };
      }
      expect(cursor).toBe("re_page_2");
      return {
        refunds: [normalizedRefund({ id: "re_page_3" })],
        hasMore: false,
      };
    };

    await handleReconciliationScanJob(
      { scope: "all" },
      {
        store,
        stripe,
        clock: fixedClock,
        logger: new FakeLogger(),
      },
    );

    expect(stripe.listCalls).toHaveLength(2);
    expect(stripe.listCalls[0]?.created).toEqual({
      gte: Date.parse("2030-01-01T10:00:00.000Z") / 1_000,
      lte: Date.parse("2030-01-01T12:00:00.000Z") / 1_000,
    });
    expect(stripe.listCalls[1]?.startingAfter).toBe("re_page_2");
    expect(store.observations.map((item) => item.refund.refundId)).toEqual([
      "re_page_1",
      "re_page_2",
      "re_page_3",
    ]);
    expect(store.observations.every((item) => item.source.kind === "scan")).toBe(true);
    expect(store.checkpointCommits).toEqual([
      expect.objectContaining({
        previousWindowEnd: new Date("2030-01-01T11:00:00.000Z"),
        windowStart: new Date("2030-01-01T10:00:00.000Z"),
        windowEnd: new Date("2030-01-01T12:00:00.000Z"),
        pageCount: 2,
        refundCount: 3,
      }),
    ]);
    expect(store.trace.at(-1)).toBe("store.checkpoint.commit");
  });

  it("anchors the first scan to installation time so delayed workers do not miss refunds", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    store.installations.push(installation({ installedAt: new Date("2029-12-30T12:00:00.000Z") }));

    await handleReconciliationScanJob(
      { scope: "all" },
      {
        store,
        stripe,
        clock: fixedClock,
        logger: new FakeLogger(),
      },
    );

    expect(stripe.listCalls).toHaveLength(1);
    expect(stripe.listCalls[0]?.created).toEqual({
      gte: Date.parse("2029-12-30T11:00:00.000Z") / 1_000,
      lte: Date.parse("2030-01-01T12:00:00.000Z") / 1_000,
    });
    expect(store.checkpointCommits).toEqual([
      expect.objectContaining({
        previousWindowEnd: null,
        windowStart: new Date("2029-12-30T11:00:00.000Z"),
        windowEnd: new Date("2030-01-01T12:00:00.000Z"),
      }),
    ]);
  });

  it("refreshes an already-linked Refund by ID even when it predates the overlap window", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    store.installations.push(installation());
    store.checkpoint = { windowEnd: new Date("2030-01-01T11:00:00.000Z") };
    store.linkedRefundTargets.push({
      requestId: "11111111-1111-4111-8111-111111111111",
      refundId: "re_oldlinked",
    });
    stripe.refundRetrieveHandler = (refundId) =>
      normalizedRefund({
        id: refundId,
        created: Date.parse("2029-12-01T12:00:00.000Z") / 1_000,
        status: "failed",
      });

    await handleReconciliationScanJob(
      { scope: "all" },
      {
        store,
        stripe,
        clock: fixedClock,
        logger: new FakeLogger(),
      },
    );

    expect(stripe.listCalls[0]?.created.gte).toBe(Date.parse("2030-01-01T10:00:00.000Z") / 1_000);
    expect(stripe.refundRetrieveCalls).toHaveLength(1);
    expect(stripe.refundRetrieveCalls[0]?.installation).toMatchObject({
      environment: "sandbox",
      stripeAccountId: "acct_scan",
    });
    expect(stripe.refundRetrieveCalls[0]?.refundId).toBe("re_oldlinked");
    expect(store.linkedRefundObservations).toHaveLength(1);
    expect(store.linkedRefundObservations[0]).toMatchObject({
      tenantId: TENANT_ID,
      installationId: INSTALLATION_ID,
      environment: "sandbox",
      requestId: "11111111-1111-4111-8111-111111111111",
      expectedRefundId: "re_oldlinked",
      refund: {
        refundId: "re_oldlinked",
        status: "failed",
      },
      scanWindowEnd: new Date("2030-01-01T12:00:00.000Z"),
    });
  });

  it("continues linked Refund refreshes and the creation-window scan after one target fails", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    const logger = new FakeLogger();
    store.installations.push(installation());
    store.linkedRefundTargets.push(
      {
        requestId: "11111111-1111-4111-8111-111111111111",
        refundId: "re_failing",
      },
      {
        requestId: "22222222-2222-4222-8222-222222222222",
        refundId: "re_healthy",
      },
    );
    stripe.refundRetrieveHandler = (refundId) => {
      if (refundId === "re_failing") {
        throw new Error("SENSITIVE_LINKED_REFRESH_FAILURE");
      }
      return normalizedRefund({ id: refundId, status: "succeeded" });
    };

    await expect(
      handleReconciliationScanJob(
        { scope: "all" },
        {
          store,
          stripe,
          clock: fixedClock,
          logger,
        },
      ),
    ).rejects.toThrow("REFUND_SCAN_PARTIAL_FAILURE");

    expect(stripe.refundRetrieveCalls.map((call) => call.refundId)).toEqual([
      "re_failing",
      "re_healthy",
    ]);
    expect(store.linkedRefundObservations.map((item) => item.refund.refundId)).toEqual([
      "re_healthy",
    ]);
    expect(store.checkpointCommits).toHaveLength(1);
    expect(logger.entries).toContainEqual({
      level: "error",
      context: {
        code: "LINKED_REFUND_REFRESH_FAILED",
        installationId: INSTALLATION_ID,
        refundId: "re_failing",
        requestId: "11111111-1111-4111-8111-111111111111",
        tenantId: TENANT_ID,
      },
      message: "Linked Stripe Refund status refresh failed",
    });
    expect(JSON.stringify(logger.entries)).not.toContain("SENSITIVE_LINKED_REFRESH_FAILURE");
  });

  it("clamps a future installation timestamp to the current scan window", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    store.installations.push(installation({ installedAt: new Date("2030-01-02T12:00:00.000Z") }));

    await handleReconciliationScanJob(
      { scope: "all" },
      {
        store,
        stripe,
        clock: fixedClock,
        logger: new FakeLogger(),
      },
    );

    expect(stripe.listCalls[0]?.created).toEqual({
      gte: Date.parse("2030-01-01T11:00:00.000Z") / 1_000,
      lte: Date.parse("2030-01-01T12:00:00.000Z") / 1_000,
    });
  });

  it("does not advance the checkpoint after an intermediate page failure", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    store.installations.push(installation());
    store.checkpoint = { windowEnd: new Date("2030-01-01T11:00:00.000Z") };
    stripe.pageHandler = (cursor) => {
      if (cursor === undefined) {
        return {
          refunds: [normalizedRefund({ id: "re_before_failure" })],
          hasMore: true,
        };
      }
      throw new Error("INJECTED_PAGE_FAILURE");
    };

    await expect(
      handleReconciliationScanJob(
        { scope: "all" },
        {
          store,
          stripe,
          clock: fixedClock,
          logger: new FakeLogger(),
        },
      ),
    ).rejects.toThrow("REFUND_SCAN_PARTIAL_FAILURE");

    expect(store.observations).toHaveLength(1);
    expect(store.checkpointCommits).toEqual([]);
    expect(store.checkpoint?.windowEnd).toEqual(new Date("2030-01-01T11:00:00.000Z"));
  });

  it("continues beyond one hundred Stripe pages before advancing the checkpoint", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    store.installations.push(installation());
    stripe.pageHandler = (cursor) => {
      const pageNumber = cursor === undefined ? 1 : Number(cursor.replace("re_page_", "")) + 1;
      return {
        refunds: [normalizedRefund({ id: `re_page_${pageNumber}` })],
        hasMore: pageNumber < 101,
      };
    };

    await handleReconciliationScanJob(
      { scope: "all" },
      {
        store,
        stripe,
        clock: fixedClock,
        logger: new FakeLogger(),
      },
    );

    expect(stripe.listCalls).toHaveLength(101);
    expect(store.observations).toHaveLength(101);
    expect(store.checkpointCommits).toEqual([
      expect.objectContaining({
        pageCount: 101,
        refundCount: 101,
      }),
    ]);
  });

  it("rejects an empty page that claims more data", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    store.installations.push(installation());
    stripe.pageHandler = () => ({ refunds: [], hasMore: true });

    await expect(
      handleReconciliationScanJob(
        { scope: "all" },
        {
          store,
          stripe,
          clock: fixedClock,
          logger: new FakeLogger(),
        },
      ),
    ).rejects.toThrow("REFUND_SCAN_PARTIAL_FAILURE");
    expect(store.checkpointCommits).toEqual([]);
  });

  it("continues scanning later installations before reporting a partial failure", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    const logger = new FakeLogger();
    store.installations.push(
      installation({
        tenantId: "11111111-1111-4111-8111-111111111111",
        installationId: "22222222-2222-4222-8222-222222222222",
        stripeAccountId: "acct_failing",
      }),
      installation({
        tenantId: "33333333-3333-4333-8333-333333333333",
        installationId: "44444444-4444-4444-8444-444444444444",
        stripeAccountId: "acct_healthy",
      }),
    );
    let pageCall = 0;
    stripe.pageHandler = () => {
      pageCall += 1;
      if (pageCall === 1) {
        throw new Error("SENSITIVE_INJECTED_FAILURE");
      }
      return {
        refunds: [normalizedRefund({ id: "re_later_installation" })],
        hasMore: false,
      };
    };

    await expect(
      handleReconciliationScanJob(
        { scope: "all" },
        {
          store,
          stripe,
          clock: fixedClock,
          logger,
        },
      ),
    ).rejects.toThrow("REFUND_SCAN_PARTIAL_FAILURE");

    expect(stripe.listCalls).toHaveLength(2);
    expect(
      store.observations.map((observation) => ({
        tenantId: observation.tenantId,
        installationId: observation.installationId,
        refundId: observation.refund.refundId,
      })),
    ).toEqual([
      {
        tenantId: "33333333-3333-4333-8333-333333333333",
        installationId: "44444444-4444-4444-8444-444444444444",
        refundId: "re_later_installation",
      },
    ]);
    expect(store.checkpointCommits).toEqual([
      expect.objectContaining({
        tenantId: "33333333-3333-4333-8333-333333333333",
        installationId: "44444444-4444-4444-8444-444444444444",
      }),
    ]);
    expect(logger.entries).toContainEqual({
      level: "error",
      context: {
        code: "REFUND_SCAN_INSTALLATION_FAILED",
        installationId: "22222222-2222-4222-8222-222222222222",
        tenantId: "11111111-1111-4111-8111-111111111111",
      },
      message: "Refund reconciliation scan failed for an installation",
    });
    expect(JSON.stringify(logger.entries)).not.toContain("SENSITIVE_INJECTED_FAILURE");
  });

  it("skips live installations without making a Stripe call", async () => {
    const store = new FakeStore();
    const stripe = new FakeStripe();
    store.installations.push(installation({ environment: "live", tenantLiveEnabled: true }));

    await handleReconciliationScanJob(
      { scope: "all" },
      {
        store,
        stripe,
        clock: fixedClock,
        logger: new FakeLogger(),
      },
    );

    expect(stripe.listCalls).toEqual([]);
    expect(stripe.refundRetrieveCalls).toEqual([]);
    expect(store.linkedRefundTargetListCalls).toEqual([]);
    expect(store.checkpointCommits).toEqual([]);
  });
});
