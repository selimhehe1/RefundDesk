import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface AppManifest {
  readonly constants: Record<string, unknown>;
  readonly distribution_type: string;
  readonly id: string;
  readonly icon: string;
  readonly permissions: readonly {
    readonly permission: string;
    readonly purpose: string;
  }[];
  readonly sandbox_install_compatible: boolean;
  readonly stripe_api_access_type: string;
  readonly version: string;
  readonly ui_extension: {
    readonly content_security_policy: {
      readonly "connect-src": readonly string[];
    };
    readonly views: readonly {
      readonly component: string;
      readonly viewport: string;
    }[];
  };
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

describe("Stripe App manifests", () => {
  it("uses platform auth, sandbox compatibility, four views, and minimal permissions", async () => {
    const manifest = await readJson<AppManifest>(new URL("../stripe-app.json", import.meta.url));
    const packageManifest = await readJson<{ readonly version: string }>(
      new URL("../package.json", import.meta.url),
    );
    expect(manifest).toMatchObject({
      id: "com.refunddesk.workflow",
      distribution_type: "public",
      stripe_api_access_type: "platform",
      sandbox_install_compatible: true,
      version: "0.1.2",
    });
    expect(manifest).not.toHaveProperty("extensions");
    expect(manifest.version).toBe(packageManifest.version);
    expect(manifest.permissions.map(({ permission }) => permission)).toEqual([
      "charge_read",
      "charge_write",
      "payment_intent_read",
      "event_read",
    ]);
    expect(manifest.permissions.every(({ purpose }) => purpose.length >= 40)).toBe(true);
    expect(manifest.permissions).not.toContainEqual(
      expect.objectContaining({ permission: "user_email_read" }),
    );
    expect(manifest.ui_extension.views).toEqual([
      {
        viewport: "stripe.dashboard.payment.detail",
        component: "PaymentDetail",
      },
      {
        viewport: "stripe.dashboard.drawer.default",
        component: "RefundDrawer",
      },
      { viewport: "onboarding", component: "Onboarding" },
      { viewport: "settings", component: "Settings" },
    ]);
  });

  it("keeps production CSP exact and all live controls disabled", async () => {
    const manifest = await readJson<AppManifest>(new URL("../stripe-app.json", import.meta.url));
    const sources = manifest.ui_extension.content_security_policy["connect-src"];
    expect(sources).toEqual(["https://api.refunddesk.example/api/"]);
    expect(sources.some((source) => source.includes("*"))).toBe(false);
    expect(manifest.constants).toEqual({
      API_BASE: "https://api.refunddesk.example/api",
      PILOT_LIVE_ENABLED: false,
    });
  });

  it("ships the required 300 by 300 PNG icon", async () => {
    const icon = await readFile(new URL("../assets/icon.png", import.meta.url));
    expect(icon.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(icon.readUInt32BE(16)).toBe(300);
    expect(icon.readUInt32BE(20)).toBe(300);
  });
});
