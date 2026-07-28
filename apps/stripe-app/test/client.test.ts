import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SignedRequestInput } from "../src/api/signed-fetch";
import type * as SignedFetchModule from "../src/api/signed-fetch";

const signedApiRequestMock = vi.hoisted(() =>
  vi.fn<
    (requestContext: ExtensionContextValue, requestInput: SignedRequestInput) => Promise<unknown>
  >(),
);

vi.mock("../src/api/signed-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof SignedFetchModule>()),
  signedApiRequest: signedApiRequestMock,
}));

import { refundDeskApi } from "../src/api/client";

const context = {} as ExtensionContextValue;
const resource = {
  resourceType: "payment_intent",
  resourceId: "pi_Test",
} as const;
const requestId = "4c7080f7-4401-4c67-b96f-c9e80e8249d3";
const requestNonce = "2db72dc2-4816-4f95-aa23-57357727e113";

describe("refund decision client", () => {
  beforeEach(() => {
    signedApiRequestMock.mockReset();
    signedApiRequestMock.mockResolvedValue({
      request_id: requestId,
      status: "approved",
    });
  });

  it("places the displayed financial snapshot and expected version in the signed command", async () => {
    await refundDeskApi.decideRefundRequest(
      context,
      resource,
      {
        request_id: requestId,
        decision: "approve",
        expected_request_version: 3,
        approval_snapshot: {
          amount_minor: "109",
          currency: "eur",
          reason: "requested_by_customer",
          requester_user_id: "usr_Requester",
        },
      },
      requestNonce,
    );

    expect(signedApiRequestMock).toHaveBeenCalledWith(context, {
      endpoint: "/v1/refund-requests/decide",
      operation: "refund_request.decide",
      resourceType: "payment_intent",
      resourceId: "pi_Test",
      requestNonce,
      command: {
        request_id: requestId,
        decision: "approve",
        expected_request_version: 3,
        approval_snapshot: {
          amount_minor: "109",
          currency: "eur",
          reason: "requested_by_customer",
          requester_user_id: "usr_Requester",
        },
      },
    });
  });

  it("keeps rejection commands separate from approval snapshots", async () => {
    signedApiRequestMock.mockResolvedValue({
      request_id: requestId,
      status: "rejected",
    });

    await refundDeskApi.decideRefundRequest(
      context,
      resource,
      {
        request_id: requestId,
        decision: "reject",
        justification: "The amount does not match the support ticket.",
      },
      requestNonce,
    );

    const [, input] = signedApiRequestMock.mock.calls[0] ?? [];
    if (input === undefined) {
      throw new TypeError("Expected a signed rejection request");
    }
    expect(input).toMatchObject({
      command: {
        request_id: requestId,
        decision: "reject",
        justification: "The amount does not match the support ticket.",
      },
    });
    expect(input.command).not.toHaveProperty("approval_snapshot");
    expect(input.command).not.toHaveProperty("expected_request_version");
  });
});
