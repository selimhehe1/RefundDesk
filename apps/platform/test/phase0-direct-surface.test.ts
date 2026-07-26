import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("Phase-0 HTTP surface", () => {
  it("exposes no Phase-0 runtime route after the evidence gate", () => {
    const directory = fileURLToPath(new URL("../app/api/internal/phase0", import.meta.url));
    const routes = existsSync(directory)
      ? readdirSync(directory, { recursive: true })
          .map((entry) => entry.toString().replaceAll("\\", "/"))
          .filter((entry) => /(?:^|\/)route\.[cm]?[jt]sx?$/u.test(entry))
          .sort()
      : [];

    expect(routes).toEqual([]);
  });
});
