import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { refundDeskApi } from "../src/api/client";

describe("pilot runtime surface", () => {
  it("exposes no Phase-0 API operation or development switch", async () => {
    expect("runPhase0Probe" in refundDeskApi).toBe(false);
    expect("getPhase0Report" in refundDeskApi).toBe(false);

    const [manifest, client, signedFetch] = await Promise.all([
      readFile(new URL("../stripe-app.json", import.meta.url), "utf8"),
      readFile(new URL("../src/api/client.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/api/signed-fetch.ts", import.meta.url), "utf8"),
    ]);

    expect(`${manifest}\n${client}\n${signedFetch}`).not.toMatch(
      /PHASE0_PROBE_ENABLED|\/internal\/phase0|phase0\.report/u,
    );
  });
});
