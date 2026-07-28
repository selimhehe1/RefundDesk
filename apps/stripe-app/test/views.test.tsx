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

  it("rejects malformed approver input instead of silently dropping it", async () => {
    const { wrapper, update } = render(<Settings {...testContext({ administrator: true })} />);
    await update();

    const settings = wrapper.find("SettingsView");
    expect(settings).not.toBeNull();
    settings?.triggerKeypath("onSave", {
      approver_user_ids: "usr_Admin\nperson@example.com",
    });
    await update();

    expect(apiMocks.updateSettings).not.toHaveBeenCalled();
    expect(
      wrapper
        .findAll("Banner")
        .some(
          (banner) =>
            isRecord(banner.props) &&
            typeof banner.props["description"] === "string" &&
            banner.props["description"].includes("Every approver must be a Stripe user ID"),
        ),
    ).toBe(true);
  });

  it("remounts account-scoped state instead of exposing prior settings", async () => {
    apiMocks.getSettings.mockImplementation((context: ExtensionContextValue) =>
      Promise.resolve({
        approver_user_ids: [
          context.userContext.account.id === "acct_A" ? "usr_ApproverA" : "usr_ApproverB",
        ],
        expiration_days: 7,
        onboarding_completed: true,
      }),
    );
    const { wrapper, update } = render(<SettingsContextSwitchHarness />);
    await update();

    const firstApprovers = wrapper
      .findAll("TextArea")
      .find((node) => isRecord(node.props) && node.props["name"] === "approver_user_ids");
    expect(isRecord(firstApprovers?.props) ? firstApprovers.props["defaultValue"] : null).toBe(
      "usr_ApproverA",
    );

    wrapper
      .findAll("Button")
      .find((button) => button.text === "Switch account")
      ?.triggerKeypath("onPress");
    await update();

    const secondApprovers = wrapper
      .findAll("TextArea")
      .find((node) => isRecord(node.props) && node.props["name"] === "approver_user_ids");
    expect(isRecord(secondApprovers?.props) ? secondApprovers.props["defaultValue"] : null).toBe(
      "usr_ApproverB",
    );
  });
});
