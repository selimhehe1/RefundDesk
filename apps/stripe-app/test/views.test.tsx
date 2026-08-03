import { useState } from "react";

import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { getMockContextProps } from "@stripe/ui-extension-sdk/testing/mockData";
import { render } from "@stripe/ui-extension-sdk/testing/render";
import { Button } from "@stripe/ui-extension-sdk/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Onboarding from "../src/views/Onboarding";
import PaymentDetail from "../src/views/PaymentDetail";
import RefundDrawer from "../src/views/RefundDrawer";
import Settings from "../src/views/Settings";
import { SignedExtensionRequestError } from "../src/api/signed-fetch";
import { workflowStatusSchema } from "../src/api/client";
import { workflowStatusLabel } from "../src/presentation";

const apiMocks = vi.hoisted(() => ({
  acknowledgeExternalAlert: vi.fn(),
  cancelRefundRequest: vi.fn(),
  createAuditExport: vi.fn(),
  createRefundRequest: vi.fn(),
  decideRefundRequest: vi.fn(),
  getEligibility: vi.fn(),
  getRefundRequest: vi.fn(),
  getSettings: vi.fn(),
  listExternalAlerts: vi.fn(),
  listRefundRequests: vi.fn(),
  syncContext: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("../src/api/client", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/api/client");
  return {
    ...actual,
    refundDeskApi: apiMocks,
  };
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function amountFieldOf(wrapper: {
  findAll: (
    type: string,
  ) => { props: unknown; triggerKeypath: (path: string, value: unknown) => void }[];
}) {
  return wrapper
    .findAll("TextField")
    .find((field) => isRecord(field.props) && field.props["name"] === "amount");
}

function bannerTitles(wrapper: { findAll: (type: string) => { props: unknown }[] }): string[] {
  return wrapper.findAll("Banner").map((banner) => {
    const title = isRecord(banner.props) ? banner.props["title"] : undefined;
    return typeof title === "string" ? title : "";
  });
}

/** Banner copy is carried in props, so `wrapper.text` never sees it. */
function bannerDescriptions(wrapper: {
  findAll: (type: string) => { props: unknown }[];
}): string[] {
  return wrapper.findAll("Banner").map((banner) => {
    const description = isRecord(banner.props) ? banner.props["description"] : undefined;
    return typeof description === "string" ? description : "";
  });
}

function testContext({
  administrator = false,
  mode = "test",
  object = "payment_intent",
}: {
  readonly administrator?: boolean;
  readonly mode?: "live" | "test";
  readonly object?: "charge" | "payment_intent";
} = {}) {
  return getMockContextProps({
    userContext: {
      id: administrator ? "usr_Admin" : "usr_Requester",
      account: {
        id: "acct_Test",
        isSandbox: false,
      },
      roles: [
        administrator
          ? { name: "Administrator", type: "builtIn" }
          : { name: "View only", type: "builtIn" },
      ],
    },
    environment: {
      constants: {
        API_BASE: "https://api.refunddesk.example/api",
        PILOT_LIVE_ENABLED: false,
      },
      mode,
      objectContext: {
        id: object === "charge" ? "ch_Test" : "pi_Test",
        object,
      },
    },
  });
}

function accountContext(account: "A" | "B") {
  const context = testContext({ administrator: true });
  return {
    ...context,
    userContext: {
      ...context.userContext,
      id: `usr_Admin${account}`,
      account: {
        ...context.userContext.account,
        id: `acct_${account}`,
      },
    },
    environment: {
      ...context.environment,
      objectContext: {
        id: `pi_${account}`,
        object: "payment_intent",
      },
    },
  } satisfies ExtensionContextValue;
}

function SettingsContextSwitchHarness() {
  const [account, setAccount] = useState<"A" | "B">("A");
  return (
    <>
      <Button
        onPress={() => {
          setAccount((current) => (current === "A" ? "B" : "A"));
        }}
      >
        Switch account
      </Button>
      <Settings {...accountContext(account)} />
    </>
  );
}

const eligiblePayment = {
  active_request: null,
  approvals_required: 1,
  currency: "eur",
  eligible: true,
  ineligible_reason: null,
  remaining_amount_minor: "500",
} as const;

const pendingRequest = {
  amount_minor: "109",
  can_cancel: false,
  can_decide: true,
  created_at: "2026-07-26T17:00:00.000Z",
  currency: "eur",
  expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000).toISOString(),
  id: "4c7080f7-4401-4c67-b96f-c9e80e8249d3",
  is_requester: false,
  justification: "Customer requested a partial refund.",
  reason: "requested_by_customer",
  requester_user_id: "usr_Requester",
  resource_id: "pi_Test",
  resource_type: "payment_intent",
  status: "pending_approval",
  version: 3,
} as const;

describe("Stripe pilot views", () => {
  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset();
    }
    apiMocks.getEligibility.mockResolvedValue(eligiblePayment);
    apiMocks.listRefundRequests.mockResolvedValue({
      items: [],
      next_cursor: null,
    });
    apiMocks.listExternalAlerts.mockResolvedValue({
      items: [],
      next_cursor: null,
    });
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: false,
      installation_active: true,
      onboarding_completed: false,
    });
    apiMocks.getSettings.mockResolvedValue({
      approver_user_ids: ["usr_Admin"],
      expiration_days: 7,
      onboarding_completed: true,
      observed_users: [
        {
          stripe_user_id: "usr_Admin",
          display_name: "Ada Lovelace",
          approver_enabled: true,
          last_seen_at: "2026-07-26T17:00:00.000Z",
        },
        {
          stripe_user_id: "usr_Colleague",
          display_name: null,
          approver_enabled: false,
          last_seen_at: "2026-07-25T09:30:00.000Z",
        },
      ],
    });
  });

  it("renders live mode as disabled without contacting the pilot API", async () => {
    const { wrapper, update } = render(<PaymentDetail {...testContext({ mode: "live" })} />);
    await update();

    expect(wrapper.text).toContain("Live disabled");
    expect(wrapper.text).toContain("No live request can be sent");
    expect(apiMocks.getEligibility).not.toHaveBeenCalled();
  });

  it("submits a validated payment request with an explicit mutation nonce", async () => {
    apiMocks.createRefundRequest.mockResolvedValue({
      request_id: "4c7080f7-4401-4c67-b96f-c9e80e8249d3",
      status: "pending_approval",
    });
    const { wrapper, update } = render(<PaymentDetail {...testContext()} />);
    await update();

    const justification = wrapper
      .findAll("TextArea")
      .find((node) => isRecord(node.props) && node.props["name"] === "justification");
    expect(justification).toBeDefined();
    justification?.triggerKeypath("onChange", {
      target: { value: "Customer requested a partial refund." },
    });
    const submit = wrapper.findAll("Button").find((button) => button.text === "Request refund");
    expect(submit).toBeDefined();
    submit?.triggerKeypath("onPress");
    await update();

    expect(apiMocks.createRefundRequest).toHaveBeenCalledWith(
      expect.anything(),
      { resourceId: "pi_Test", resourceType: "payment_intent" },
      {
        amount_minor: "500",
        currency: "eur",
        justification: "Customer requested a partial refund.",
        reason: "requested_by_customer",
      },
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    );
  });

  it("reuses the same nonce after an ambiguous network failure", async () => {
    apiMocks.createRefundRequest
      .mockRejectedValueOnce(new TypeError("Network failed"))
      .mockResolvedValueOnce({
        request_id: "4c7080f7-4401-4c67-b96f-c9e80e8249d3",
        status: "pending_approval",
      });
    const { wrapper, update } = render(<PaymentDetail {...testContext()} />);
    await update();
    wrapper
      .findAll("TextArea")
      .find((node) => isRecord(node.props) && node.props["name"] === "justification")
      ?.triggerKeypath("onChange", {
        target: { value: "Customer requested a partial refund." },
      });

    wrapper
      .findAll("Button")
      .find((button) => button.text === "Request refund")
      ?.triggerKeypath("onPress");
    await update();
    wrapper
      .findAll("Button")
      .find((button) => button.text === "Request refund")
      ?.triggerKeypath("onPress");
    await update();

    expect(apiMocks.createRefundRequest).toHaveBeenCalledTimes(2);
    expect(apiMocks.createRefundRequest.mock.calls[1]?.[3]).toBe(
      apiMocks.createRefundRequest.mock.calls[0]?.[3],
    );
  });

  it.each([429, 503])(
    "reuses the same nonce after retryable HTTP %i without assuming completion",
    async (status) => {
      apiMocks.createRefundRequest
        .mockRejectedValueOnce(
          new SignedExtensionRequestError("REQUEST_FAILED", "Retry later", status),
        )
        .mockResolvedValueOnce({
          request_id: "4c7080f7-4401-4c67-b96f-c9e80e8249d3",
          status: "pending_approval",
        });
      const { wrapper, update } = render(<PaymentDetail {...testContext()} />);
      await update();
      wrapper
        .findAll("TextArea")
        .find((node) => isRecord(node.props) && node.props["name"] === "justification")
        ?.triggerKeypath("onChange", {
          target: { value: "Customer requested a partial refund." },
        });

      wrapper
        .findAll("Button")
        .find((button) => button.text === "Request refund")
        ?.triggerKeypath("onPress");
      await update();
      wrapper
        .findAll("Button")
        .find((button) => button.text === "Request refund")
        ?.triggerKeypath("onPress");
      await update();

      expect(apiMocks.createRefundRequest).toHaveBeenCalledTimes(2);
      expect(apiMocks.createRefundRequest.mock.calls[1]?.[3]).toBe(
        apiMocks.createRefundRequest.mock.calls[0]?.[3],
      );
    },
  );

  it("rotates the nonce after an authoritative 4xx rejection", async () => {
    apiMocks.createRefundRequest
      .mockRejectedValueOnce(new SignedExtensionRequestError("REQUEST_FAILED", "Rejected", 422))
      .mockResolvedValueOnce({
        request_id: "4c7080f7-4401-4c67-b96f-c9e80e8249d3",
        status: "pending_approval",
      });
    const { wrapper, update } = render(<PaymentDetail {...testContext()} />);
    await update();
    wrapper
      .findAll("TextArea")
      .find((node) => isRecord(node.props) && node.props["name"] === "justification")
      ?.triggerKeypath("onChange", {
        target: { value: "Customer requested a partial refund." },
      });

    wrapper
      .findAll("Button")
      .find((button) => button.text === "Request refund")
      ?.triggerKeypath("onPress");
    await update();
    wrapper
      .findAll("Button")
      .find((button) => button.text === "Request refund")
      ?.triggerKeypath("onPress");
    await update();

    expect(apiMocks.createRefundRequest).toHaveBeenCalledTimes(2);
    expect(apiMocks.createRefundRequest.mock.calls[1]?.[3]).not.toBe(
      apiMocks.createRefundRequest.mock.calls[0]?.[3],
    );
  });

  it("shows exact approval context and requires a separate confirmation click", async () => {
    apiMocks.listRefundRequests.mockResolvedValue({
      items: [pendingRequest],
      next_cursor: null,
    });
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: true,
      installation_active: true,
      onboarding_completed: true,
    });
    apiMocks.decideRefundRequest.mockResolvedValue({
      request_id: pendingRequest.id,
      status: "approved",
    });
    const { wrapper, update } = render(<RefundDrawer {...testContext({ administrator: true })} />);
    await update();
    await update();

    expect(wrapper.text).toContain("1.09 EUR — 109 minor units");
    expect(wrapper.text).toContain("Requested by usr_Requester");
    expect(wrapper.text).toContain("Stripe reason: Requested by customer");
    const review = wrapper.findAll("Button").find((button) => button.text === "Review approval");
    expect(review).toBeDefined();
    review?.triggerKeypath("onPress");
    expect(apiMocks.decideRefundRequest).not.toHaveBeenCalled();
    expect(wrapper.text).toContain("Approve and queue refund");

    const approve = wrapper
      .findAll("Button")
      .find((button) => button.text === "Approve and queue refund");
    expect(approve).toBeDefined();
    approve?.triggerKeypath("onPress");
    await update();

    expect(apiMocks.decideRefundRequest).toHaveBeenCalledWith(
      expect.anything(),
      { resourceId: "pi_Test", resourceType: "payment_intent" },
      {
        decision: "approve",
        request_id: pendingRequest.id,
        expected_request_version: pendingRequest.version,
        approval_snapshot: {
          amount_minor: pendingRequest.amount_minor,
          currency: pendingRequest.currency,
          reason: pendingRequest.reason,
          requester_user_id: pendingRequest.requester_user_id,
        },
      },
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    );
  });

  it("keeps the current request scope fixed while a decision is in flight", async () => {
    apiMocks.listRefundRequests.mockResolvedValue({
      items: [pendingRequest],
      next_cursor: null,
    });
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: true,
      installation_active: true,
      onboarding_completed: true,
    });
    let finishDecision:
      ((value: { readonly request_id: string; readonly status: string }) => void) | undefined;
    apiMocks.decideRefundRequest.mockReturnValue(
      new Promise((resolve) => {
        finishDecision = resolve;
      }),
    );
    const { wrapper, update } = render(<RefundDrawer {...testContext({ administrator: true })} />);
    await update();
    await update();

    wrapper
      .findAll("Button")
      .find((button) => button.text === "Review approval")
      ?.triggerKeypath("onPress");
    wrapper
      .findAll("Button")
      .find((button) => button.text === "Approve and queue refund")
      ?.triggerKeypath("onPress");
    wrapper.find("Tabs")?.triggerKeypath("onSelectionChange", "all_activity");

    expect(apiMocks.listRefundRequests.mock.calls.some((call) => call[1] === "all_activity")).toBe(
      false,
    );
    if (finishDecision === undefined) {
      throw new TypeError("Decision resolver was not initialized");
    }
    finishDecision({
      request_id: pendingRequest.id,
      status: "approved",
    });
    await update();
  });

  it("restores a completed onboarding acknowledgement after reload", async () => {
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: true,
      installation_active: true,
      onboarding_completed: true,
    });
    const { wrapper, update } = render(<Onboarding {...testContext({ administrator: true })} />);
    await update();

    const checkbox = wrapper.find("Checkbox");
    expect(isRecord(checkbox?.props) ? checkbox.props["checked"] : undefined).toBe(true);
    expect(wrapper.text).not.toContain("Complete a two-person synthetic refund workflow");
  });

  it("offers observed people to tick instead of demanding raw identifiers", async () => {
    const { wrapper, update } = render(<Settings {...testContext({ administrator: true })} />);
    await update();

    // No free-text identifier entry survives anywhere in the view.
    expect(
      wrapper
        .findAll("TextArea")
        .some((field) => isRecord(field.props) && field.props["name"] === "approver_user_ids"),
    ).toBe(false);

    const boxes = wrapper.findAll("Checkbox");
    expect(boxes).toHaveLength(2);
    const labels = boxes.map((box) => (isRecord(box.props) ? String(box.props["label"]) : ""));
    expect(labels).toContain("Ada Lovelace (you)");
    // Nobody has supplied a name for this colleague yet, so the identifier is the fallback.
    expect(labels).toContain("usr_Colleague");

    const checked = boxes.map((box) => (isRecord(box.props) ? box.props["checked"] : undefined));
    expect(checked).toEqual([true, false]);
  });

  it("refuses to save with nobody left to approve, and says why", async () => {
    const { wrapper, update } = render(<Settings {...testContext({ administrator: true })} />);
    await update();

    wrapper
      .findAll("Checkbox")
      .find((box) => isRecord(box.props) && box.props["checked"] === true)
      ?.triggerKeypath("onChange", { target: { checked: false } });
    await update();

    wrapper.find("SettingsView")?.triggerKeypath("onSave", {});
    await update();

    expect(apiMocks.updateSettings).not.toHaveBeenCalled();
    // Banner text lives in props, not in rendered content, so assert on the prop.
    expect(bannerDescriptions(wrapper)).toContain("Keep at least one person as an approver.");
  });

  it("names the pool people are chosen from and how to join it", async () => {
    apiMocks.getSettings.mockResolvedValue({
      approver_user_ids: [],
      expiration_days: 7,
      onboarding_completed: true,
      observed_users: [],
    });
    const { wrapper, update } = render(<Settings {...testContext({ administrator: true })} />);
    await update();

    // The rule the backend enforces silently must be stated where the choice is made.
    expect(bannerDescriptions(wrapper).join(" ")).toContain("open RefundDesk once");
  });

  it("remounts account-scoped state instead of exposing prior settings", async () => {
    apiMocks.getSettings.mockImplementation((context: ExtensionContextValue) => {
      const approver =
        context.userContext.account.id === "acct_A" ? "usr_ApproverA" : "usr_ApproverB";
      return Promise.resolve({
        approver_user_ids: [approver],
        expiration_days: 7,
        onboarding_completed: true,
        observed_users: [
          {
            stripe_user_id: approver,
            display_name: null,
            approver_enabled: true,
            last_seen_at: "2026-07-26T17:00:00.000Z",
          },
        ],
      });
    });
    const { wrapper, update } = render(<SettingsContextSwitchHarness />);
    await update();

    const firstLabels = wrapper
      .findAll("Checkbox")
      .map((box) => (isRecord(box.props) ? String(box.props["label"]) : ""));
    expect(firstLabels).toEqual(["usr_ApproverA"]);

    wrapper
      .findAll("Button")
      .find((button) => button.text === "Switch account")
      ?.triggerKeypath("onPress");
    await update();

    const secondLabels = wrapper
      .findAll("Checkbox")
      .map((box) => (isRecord(box.props) ? String(box.props["label"]) : ""));
    expect(secondLabels).toEqual(["usr_ApproverB"]);
    // The previous account's approver must not survive the remount.
    expect(secondLabels).not.toContain("usr_ApproverA");
  });

  it("never renders a raw workflow status or ISO timestamp to the user", async () => {
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: true,
      installation_active: true,
      onboarding_completed: true,
    });
    // One request per status: otherwise the loop below asserts on statuses that were
    // never rendered and the guarantee is vacuous.
    apiMocks.listRefundRequests.mockResolvedValue({
      items: workflowStatusSchema.options.map((status, index) => ({
        ...pendingRequest,
        id: `4c7080f7-4401-4c67-b96f-c9e80e82${String(index).padStart(4, "0")}`,
        status,
      })),
      next_cursor: null,
    });
    const { wrapper, update } = render(<RefundDrawer {...testContext()} />);
    await update();

    for (const status of workflowStatusSchema.options) {
      // Only the machine-shaped tokens are forbidden: single-word statuses like "approved"
      // are ordinary English and legitimately appear in explanatory copy.
      if (status.includes("_")) {
        expect(wrapper.text).not.toContain(status);
      }
      expect(wrapper.text).toContain(workflowStatusLabel(status));
    }
    expect(wrapper.text).not.toContain(pendingRequest.created_at);
    expect(wrapper.text).toContain("26 Jul 2026, 17:00 UTC");
  });

  it("explains on the field why a short rejection note blocks Reject", async () => {
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: true,
      installation_active: true,
      onboarding_completed: true,
    });
    apiMocks.listRefundRequests.mockResolvedValue({
      items: [pendingRequest],
      next_cursor: null,
    });
    const { wrapper, update } = render(<RefundDrawer {...testContext()} />);
    await update();

    const note = wrapper
      .findAll("TextArea")
      .find((field) => isRecord(field.props) && field.props["label"] === "Rejection reason");
    expect(note).toBeDefined();
    note?.triggerKeypath("onChange", { target: { value: "too short" } });
    await update();

    const updated = wrapper
      .findAll("TextArea")
      .find((field) => isRecord(field.props) && field.props["label"] === "Rejection reason");
    const noteProps = isRecord(updated?.props) ? updated.props : {};
    expect(noteProps["invalid"]).toBe(true);
    expect(String(noteProps["error"])).toContain("at least 10 characters");

    const reject = wrapper.findAll("Button").find((button) => button.text === "Reject");
    expect(isRecord(reject?.props) ? reject.props["disabled"] : undefined).toBe(true);
  });

  it("disables approval-only views instead of refusing the click afterwards", async () => {
    const { wrapper, update } = render(<RefundDrawer {...testContext()} />);
    await update();

    const approvalTabs = wrapper
      .findAll("Tab")
      .filter(
        (tab) =>
          isRecord(tab.props) &&
          (tab.props["id"] === "awaiting_my_approval" || tab.props["id"] === "all_activity"),
      );
    expect(approvalTabs).toHaveLength(2);
    for (const tab of approvalTabs) {
      expect(isRecord(tab.props) ? tab.props["disabled"] : undefined).toBe(true);
    }
  });

  it("never claims a user is not an approver when that status is unknown", async () => {
    apiMocks.syncContext.mockRejectedValue(new Error("unavailable"));
    const { wrapper, update } = render(<RefundDrawer {...testContext()} />);
    await update();

    expect(wrapper.text).not.toContain("you are not a configured RefundDesk approver");
    expect(wrapper.text).toContain("until your approver status can be confirmed");

    // Approval views stay closed: unknown status must fail closed, not open up.
    for (const tab of wrapper
      .findAll("Tab")
      .filter(
        (candidate) =>
          isRecord(candidate.props) &&
          (candidate.props["id"] === "awaiting_my_approval" ||
            candidate.props["id"] === "all_activity"),
      )) {
      expect(isRecord(tab.props) ? tab.props["disabled"] : undefined).toBe(true);
    }
  });

  it("keeps every pilot policy statement when rendering them as a list", async () => {
    const { wrapper, update } = render(<Onboarding {...testContext({ administrator: true })} />);
    await update();

    // ListItem carries its text in a prop, so wrapper.text cannot see it: assert on props
    // or this guarantee silently disappears.
    const titles = wrapper
      .findAll("ListItem")
      .map((item) => (isRecord(item.props) ? String(item.props["title"]) : ""));
    expect(titles).toHaveLength(4);
    expect(titles).toContain("One approver, always different from the requester");
    expect(titles).toContain("Requests expire after seven days");
    expect(titles).toContain("Audit and justifications retained for 365 days");
    expect(titles).toContain("No e-mail notifications, Billing, quota, or live execution");
  });

  it("warns in the download control itself that the audit link opens a new tab", async () => {
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: true,
      installation_active: true,
      onboarding_completed: true,
    });
    apiMocks.createAuditExport.mockResolvedValue({
      download_url: "https://api.refunddesk.example/api/v1/audit/exports/token",
      expires_at: "2026-07-26T17:05:00.000Z",
    });
    const { wrapper, update } = render(<RefundDrawer {...testContext({ administrator: true })} />);
    await update();

    wrapper
      .findAll("Button")
      .find((button) => button.text === "Prepare audit CSV")
      ?.triggerKeypath("onPress");
    await update();

    const download = wrapper
      .findAll("Button")
      .find((button) => button.text.startsWith("Download audit CSV"));
    expect(download).toBeDefined();
    expect(download?.text).toContain("opens in a new tab");
    expect(wrapper.text).toContain("26 Jul 2026, 17:05 UTC");
  });

  it("warns that an undecided request lapses, using the server's deadline", async () => {
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: true,
      installation_active: true,
      onboarding_completed: true,
    });
    apiMocks.listRefundRequests.mockResolvedValue({
      items: [pendingRequest],
      next_cursor: null,
    });
    const { wrapper, update } = render(<RefundDrawer {...testContext()} />);
    await update();

    expect(wrapper.text).toContain("Expires in 2 days");
    expect(wrapper.text).toContain("cannot be approved afterwards");
  });

  it("says plainly how many refunds await this approver, since nothing notifies them", async () => {
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: true,
      installation_active: true,
      onboarding_completed: true,
    });
    apiMocks.listRefundRequests.mockResolvedValue({
      items: [pendingRequest, { ...pendingRequest, id: "0f4a1b2c-3d4e-5f60-8192-a3b4c5d6e7f8" }],
      next_cursor: null,
    });
    const { wrapper, update } = render(<RefundDrawer {...testContext()} />);
    await update();

    expect(bannerTitles(wrapper)).toContain("2 refunds are waiting for your decision");
  });

  it("tells a freshly onboarded Administrator that a second person is still missing", async () => {
    apiMocks.syncContext.mockResolvedValue({
      approvals_required: 1,
      current_user_is_approver: true,
      installation_active: true,
      onboarding_completed: true,
    });
    const { wrapper, update } = render(<Onboarding {...testContext({ administrator: true })} />);
    await update();

    expect(bannerTitles(wrapper)).toContain("One more person is needed");
    expect(bannerDescriptions(wrapper).join(" ")).toContain("open RefundDesk once");
  });

  it("asks for money, not minor units, and prefills the full refundable amount", async () => {
    const { wrapper, update } = render(<PaymentDetail {...testContext()} />);
    await update();

    const amountField = amountFieldOf(wrapper);
    expect(amountField).toBeDefined();
    const props = isRecord(amountField?.props) ? amountField.props : {};
    expect(String(props["label"])).toBe("Refund amount (EUR)");
    expect(String(props["value"])).toBe("5.00");
    expect(String(props["description"])).toContain("5.00 EUR");
    expect(String(props["description"])).not.toContain("minor units");
  });

  it("converts the typed amount into exact minor units for Stripe", async () => {
    apiMocks.createRefundRequest.mockResolvedValue({
      request_id: "4c7080f7-4401-4c67-b96f-c9e80e8249d3",
      status: "pending_approval",
    });
    const { wrapper, update } = render(<PaymentDetail {...testContext()} />);
    await update();

    amountFieldOf(wrapper)?.triggerKeypath("onChange", { target: { value: "1,23" } });
    wrapper
      .findAll("TextArea")
      .find((node) => isRecord(node.props) && node.props["name"] === "justification")
      ?.triggerKeypath("onChange", { target: { value: "Customer requested a partial refund." } });
    wrapper
      .findAll("Button")
      .find((button) => button.text === "Request refund")
      ?.triggerKeypath("onPress");
    await update();

    expect(apiMocks.createRefundRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ amount_minor: "123" }),
      expect.anything(),
    );
  });

  it("refuses more precision than the currency has instead of rounding money", async () => {
    const { wrapper, update } = render(<PaymentDetail {...testContext()} />);
    await update();

    amountFieldOf(wrapper)?.triggerKeypath("onChange", { target: { value: "1.234" } });
    wrapper
      .findAll("TextArea")
      .find((node) => isRecord(node.props) && node.props["name"] === "justification")
      ?.triggerKeypath("onChange", { target: { value: "Customer requested a partial refund." } });
    wrapper
      .findAll("Button")
      .find((button) => button.text === "Request refund")
      ?.triggerKeypath("onPress");
    await update();

    expect(apiMocks.createRefundRequest).not.toHaveBeenCalled();
    const amountProps = amountFieldOf(wrapper)?.props;
    const fieldError = isRecord(amountProps) ? amountProps["error"] : undefined;
    expect(String(fieldError)).toContain("cannot have more than 2 decimals");
  });
});
