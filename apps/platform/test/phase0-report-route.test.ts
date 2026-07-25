import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { serializeSignedEnvelope, type SignedEnvelope } from "@refunddesk/contracts";

const signingSecret = "absec_phase0_report_test";
const allowedPaymentIntent = "pi_phase0report";

vi.mock("@refunddesk/config", () => ({
  loadConfig: () => ({
    nodeEnv: "test",
    phase0ProbeEnabled: true,
    phase0AllowedPaymentIntents: new Set(["pi_phase0report"]),
    stripe: { appSigningSecret: "absec_phase0_report_test" },
  }),
}));

import { POST } from "../app/api/internal/phase0/report/route.js";

function requestFor(
  overrides: Partial<SignedEnvelope> = {},
  secret: string = signingSecret,
): Request {
  const envelope: SignedEnvelope = {
    operation: "phase0.report",
    request_nonce: "7be3b301-edfa-4f76-9e4d-e91c41f1b04f",
    mode: "test",
    is_sandbox: false,
    resource_type: "payment_intent",
    resource_id: allowedPaymentIntent,
    command_json: "{}",
    stripe_roles: [{ name: "Administrator", type: "builtIn" }],
    user_id: "usr_Phase0Report",
    account_id: "acct_Phase0Report",
    ...overrides,
  };
  const body = serializeSignedEnvelope(envelope);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
  });
  return new Request("http://localhost/api/internal/phase0/report", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body,
  });
}

describe("phase-0 signed report route", () => {
  it("returns only a redacted account-scoped report to a signed Administrator", async () => {
    const response = await POST(requestFor());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      environment: "test",
      probe_count: 0,
      evidence_count: 0,
      truncated: false,
      evidence: [],
    });
  });

  it("rejects a signed non-Administrator and a non-allowlisted target", async () => {
    const roleResponse = await POST(
      requestFor({ stripe_roles: [{ name: "View only", type: "builtIn" }] }),
    );
    const targetResponse = await POST(requestFor({ resource_id: "pi_notallowed" }));

    expect(roleResponse.status).toBe(403);
    expect(await roleResponse.json()).toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(targetResponse.status).toBe(403);
    expect(await targetResponse.json()).toMatchObject({ code: "PAYMENT_NOT_ALLOWLISTED" });
  });
});
